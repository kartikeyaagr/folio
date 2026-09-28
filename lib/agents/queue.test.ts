/**
 * What the queue says has gone wrong — the question `/agents` puts at the top of the screen.
 *
 * Separate from `runner.test.ts`, which is about a run *executing*. This is about a run being
 * *findable afterwards*, and the two failed differently: the runner's failure states were all
 * correct and named, and the list that was supposed to show them matched only the last one.
 *
 * `failRun` retires a run on its final attempt and otherwise puts it back as `queued` with the
 * failure_kind and the error still on it. `failedRuns` matched `status = 'failed'` alone, so a box
 * with no API key produced runs that were failing, were visible nowhere, and left the page saying
 * **0 failed runs · Nothing has failed**. Measured on the dev database when this was written:
 * three such runs, all holding `401 … API key is invalid`.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import { scriptedModel, scriptedOk } from './model.ts';
import { drain, raise, registerHandler } from './runner.ts';
import { enqueue, failedRuns, MAX_ATTEMPTS, requeue } from './queue.ts';

const DB = `folio_queue_${process.pid}`;
const CO = 'c1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega')", [CO]);
  });
  // A registry row, because an agent absent from that table cannot be invoked — `executeRun`
  // fails the run with `no enabled agent named test` before it reaches a handler.
  await serviceTxn('system:agents', (c) =>
    c.query(
      `INSERT INTO agents (key,label,purpose,trigger,model,data_scope)
       VALUES ('test','T','p','event','claude-opus-5','{}') ON CONFLICT (key) DO NOTHING`));
  // Registered once: every test here wants the same handler, one that fails exactly as the model
  // told it to.
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) raise(a);
    return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', (c) => c.query('DELETE FROM agent_runs'));
});

const status = (id: string): Promise<string> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ status: string }>(
      'SELECT status FROM agent_runs WHERE id = $1', [id]);
    return rows[0]!.status;
  });

/** Fail a run `times` times. Each pass pushes past the backoff so the next claim is allowed. */
async function failTimes(times: number, detail = 'no API key on this box'): Promise<string> {
  const runId = await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([{ ok: false, kind: 'error', detail }]);
  for (let i = 0; i < times; i++) {
    await serviceTxn('system:agents', (c) =>
      c.query('UPDATE agent_runs SET next_attempt_at = now() WHERE id = $1', [runId]));
    await drain(1, model);
  }
  return runId;
}

test('a run still inside its attempts is listed, as retrying rather than as retired', async () => {
  const runId = await failTimes(1);
  assert.equal(await status(runId), 'queued', 'one attempt in, it is queued — not failed');

  const seen = await failedRuns();
  assert.equal(seen.length, 1, 'and it is still something that failed');
  assert.equal(seen[0]?.retired, false);
  assert.equal(seen[0]?.attempts, 1);
  assert.ok(seen[0]?.nextAttemptAt, 'with a time it will be tried again at');
  assert.match(String(seen[0]?.error), /no API key/, 'carrying why, which is the actionable half');
});

test('a run out of attempts is retired, and has no next attempt to name', async () => {
  const runId = await failTimes(MAX_ATTEMPTS);
  assert.equal(await status(runId), 'failed');

  const seen = await failedRuns();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.retired, true, 'nothing will offer this again without a person');
  assert.equal(seen[0]?.nextAttemptAt, null);
});

test('retired runs sort above retrying ones, because only one of them needs somebody', async () => {
  const retrying = await failTimes(1);
  const retired = await failTimes(MAX_ATTEMPTS);
  assert.deepEqual((await failedRuns()).map((r) => r.id), [retired, retrying]);
});

test('a run being worked on right now is not reported as a failure', async () => {
  // `claimRun` does not clear `failure_kind`, so a row on its second attempt carries the first
  // attempt's kind for as long as it is in flight. Matching on the kind alone would call that
  // broken, and a page that cries failure over work in progress gets ignored.
  const runId = await failTimes(1);
  await serviceTxn('system:agents', (c) =>
    c.query("UPDATE agent_runs SET status='running', claimed_at=now() WHERE id=$1", [runId]));
  assert.deepEqual(await failedRuns(), [], 'in flight is not failed');
});

test('a run put back by hand leaves the list rather than lingering in it', async () => {
  const runId = await failTimes(MAX_ATTEMPTS);
  assert.equal((await failedRuns()).length, 1);
  assert.equal(await requeue(runId), true);
  assert.deepEqual(await failedRuns(), [], 'requeue nulls the failure_kind, which is what clears it');
});

test('a run that has never failed is not in the list at all', async () => {
  await enqueue({ agentKey: 'test', companyId: CO });
  assert.deepEqual(await failedRuns(), [], 'queued is not failed');
});

test('a run that succeeds on a retry stops claiming to have failed', async () => {
  // `failRun` writes the kind and the error on every attempt, and the retry that works has to
  // clear them. Observed on the real queue: two runs `done` with a draft, still carrying
  // `failure_kind = 'error'` and a stale `401 … API key is invalid` from the attempt before the
  // key was fixed. `failedRuns` filters on status so nothing rendered it wrong — but the row
  // asserted two contradictory things, and the obvious query counts it as a failure forever.
  const runId = await failTimes(1, 'the box was broken');
  assert.equal((await failedRuns()).length, 1, 'after the first attempt it is a failure');

  // Now let it succeed.
  await serviceTxn('system:agents', (c) =>
    c.query('UPDATE agent_runs SET next_attempt_at = now() WHERE id = $1', [runId]));
  await drain(1, scriptedModel([scriptedOk({ headline: 'it worked this time' })]));

  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; failure_kind: string | null; error: string | null; attempts: number }>(
      'SELECT status, failure_kind, error, attempts FROM agent_runs WHERE id = $1', [runId]);
    return rows[0]!;
  });
  assert.equal(row.status, 'done');
  assert.equal(row.failure_kind, null, 'the kind from the attempt before is gone');
  assert.equal(row.error, null, 'and so is its message');
  assert.equal(row.attempts, 2, 'but how many goes it took is true, and stays');
  assert.deepEqual(await failedRuns(), [], 'and it is no longer something that failed');
});
