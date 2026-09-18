/**
 * The agent substrate.
 *
 * Every model call here goes through `scriptedModel`, so these tests spend no money, need no key,
 * and are deterministic. What they assert is the thing that actually matters: that a model which
 * misbehaves in each of four distinct ways produces a named, readable state and **never a draft**.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from '../db.ts';
import { costUsd, scriptedModel, scriptedOk, type Answer } from './model.ts';
import { assertInScope, drain, HANDLERS, registerHandler, ScopeViolation, type AgentRow } from './runner.ts';
import { enqueue, failedRuns, MAX_ATTEMPTS, requeue, requeueErrored, RETRY_AFTER_HOURS } from './queue.ts';
import { acceptDraft, diffFields, pendingDrafts, ReasonRequired, rejectDraft } from './review.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_agents_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

const agentRow = (scope: string[]): AgentRow => ({
  key: 'test', label: 'Test', purpose: 'p', model: 'claude-opus-5',
  effort: 'high', data_scope: scope, tools: [], learning: false, notify_on_draft: false,
});

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega')", [CO]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    // Documents before drafts: a document records the draft it came from, and the foreign key
    // holding that link refuses to let the draft go while it does.
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM exemplars');
    await c.query('DELETE FROM ai_drafts');
    await c.query('DELETE FROM agent_runs');
  });
});

// ---- scope --------------------------------------------------------------------------------------

test('an agent may not read outside its declared scope', () => {
  assert.doesNotThrow(() => assertInScope(agentRow(['filings']), ['filings']));
  assert.throws(() => assertInScope(agentRow(['filings']), ['filings', 'transactions']), ScopeViolation);
});

// ---- cost ---------------------------------------------------------------------------------------

test('cost is computed, and an unknown model yields null rather than zero', () => {
  assert.equal(costUsd('claude-opus-5', 1_000_000, 100_000), 5 + 2.5);
  assert.equal(costUsd('something-else', 1000, 1000), null, 'null is an admission; zero is a claim');
});

// ---- the four failure states --------------------------------------------------------------------

const failures: [string, Answer][] = [
  ['refusal', { ok: false, kind: 'refusal', detail: 'declined (cyber)' }],
  ['truncated', { ok: false, kind: 'truncated', detail: 'ran out of output room twice' }],
  ['unparseable', { ok: false, kind: 'unparseable', detail: 'response was not JSON' }],
  ['schema_mismatch', { ok: false, kind: 'schema_mismatch', detail: 'missing required: figures' }],
];

for (const [kind, answer] of failures) {
  test(`a ${kind} is recorded by name and writes no draft`, async () => {
    registerHandler('test', async (ctx) => {
      const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
      if (!a.ok) {
        const { raise } = await import('./runner.ts');
        raise(a);
      }
      return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
    });
    await serviceTxn('system:agents', async (c) => {
      await c.query(
        `INSERT INTO agents (key,label,purpose,trigger,model,data_scope)
         VALUES ('test','T','p','event','claude-opus-5','{}') ON CONFLICT (key) DO NOTHING`,
      );
    });
    await enqueue({ agentKey: 'test', companyId: CO });
    const r = await drain(1, scriptedModel([answer]));

    assert.equal(r.failed, 1);
    assert.equal(r.drafted, 0, 'no draft may be written for a failure');
    const run = await readTxn(async (c) => {
      const { rows } = await c.query<{ failure_kind: string; status: string }>(
        'SELECT failure_kind, status FROM agent_runs ORDER BY created_at DESC LIMIT 1',
      );
      return rows[0]!;
    });
    assert.equal(run.failure_kind, kind);
    assert.equal(run.status, 'queued', 'first attempt backs off rather than giving up');
    const drafts = await readTxn(async (c) =>
      Number((await c.query<{ n: string }>('SELECT count(*)::text AS n FROM ai_drafts')).rows[0]!.n),
    );
    assert.equal(drafts, 0);
  });
}

test('a run gives up after MAX_ATTEMPTS and becomes visible as failed', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) {
      const { raise } = await import('./runner.ts');
      raise(a);
    }
    return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
  });
  const runId = await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([{ ok: false, kind: 'error', detail: 'boom' }]);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await serviceTxn('system:agents', async (c) => {
      await c.query("UPDATE agent_runs SET next_attempt_at = now() WHERE id = $1", [runId]);
    });
    await drain(1, model);
  }

  const failed = await failedRuns();
  assert.equal(failed.length, 1, 'a failed run must be findable; the sweep never re-offers it');
  assert.equal(failed[0]?.id, runId);

  assert.equal(await requeue(runId), true, 'and a person can put it back after looking');
  assert.equal((await failedRuns()).length, 0);
});

// ---- the happy path -----------------------------------------------------------------------------

/** Drive one run all the way to terminal `failed`, with a chosen kind, and hand back its id. */
async function failTerminally(kind: 'error' | 'refusal'): Promise<string> {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) {
      const { raise } = await import('./runner.ts');
      raise(a);
    }
    return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
  });
  const runId = await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([{ ok: false, kind, detail: `a ${kind} for the test` }]);

  // One at a time, because `drain` claims whatever is eligible rather than what we mean — and a
  // run that has reached `failed` is no longer eligible, which is what makes this sequencing safe.
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await serviceTxn('system:agents', async (c) => {
      await c.query('UPDATE agent_runs SET next_attempt_at = now() WHERE id = $1', [runId]);
    });
    await drain(1, model);
  }
  return runId;
}

const runRow = (id: string) =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; failure_kind: string | null; attempts: number }>(
      'SELECT status, failure_kind, attempts FROM agent_runs WHERE id = $1',
      [id],
    );
    return rows[0]!;
  });

/** Push a failed run past the backoff, so the next pass is allowed to look at it. */
const backdate = (id: string) =>
  serviceTxn('system:agents', (c) =>
    c.query(
      `UPDATE agent_runs SET finished_at = now() - ($2 || ' hours')::interval WHERE id = $1`,
      [id, String(RETRY_AFTER_HOURS + 1)],
    ));

test('a subject the box broke comes back; one the model declined does not', async () => {
  // The three event sweeps test `NOT EXISTS (… agent_key, subject_ref)` with no predicate on
  // status, so a terminal failure retires its subject for good. That is right for a refusal — it
  // will refuse the same transcript the same way every time — and catastrophic for a box with no
  // credential, where 129 subjects were eligible when this was written and an hour of running
  // would have retired every one of them.
  const broke = await failTerminally('error');
  const declined = await failTerminally('refusal');
  assert.equal((await runRow(broke)).status, 'failed');
  assert.equal((await runRow(declined)).status, 'failed');

  await backdate(broke);
  await backdate(declined);
  assert.equal(await requeueErrored(), 1, 'one of the two, not both and not neither');

  const back = await runRow(broke);
  assert.equal(back.status, 'queued');
  assert.equal(back.failure_kind, null);
  assert.equal(back.attempts, 0, 'and it gets its attempts back, or it fails again on the first try');

  assert.equal((await runRow(declined)).status, 'failed', 'a refusal stays refused');
});

test('a box that broke a minute ago is not retried a minute later', async () => {
  // The thing being waited for is a person — a credential, a token, a database somebody restarts.
  // Retrying inside five minutes just burns the same failure again, and it is the job's alert that
  // actually gets it fixed.
  const broke = await failTerminally('error');
  assert.equal(await requeueErrored(), 0);
  assert.equal((await runRow(broke)).status, 'failed');

  await backdate(broke);
  assert.equal(await requeueErrored(), 1, 'and it is offered once the wait is over');
});

test('drain counts a broken box apart from a model having a bad day', async () => {
  // `failed` alone cannot tell them apart, and the job stakes its exit code on the difference:
  // one wakes somebody, the other is a row on /agents.
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) {
      const { raise } = await import('./runner.ts');
      raise(a);
    }
    return { draft: { content: {}, situation: 'a test run', sources: [], model: 'm' } };
  });

  await enqueue({ agentKey: 'test', companyId: CO });
  const onTheBox = await drain(1, scriptedModel([{ ok: false, kind: 'error', detail: 'no credential' }]));
  assert.equal(onTheBox.failed, 1);
  assert.equal(onTheBox.errors, 1);

  await enqueue({ agentKey: 'test', companyId: CO });
  const onTheSubject = await drain(1, scriptedModel([{ ok: false, kind: 'refusal', detail: 'declined' }]));
  assert.equal(onTheSubject.failed, 1);
  assert.equal(onTheSubject.errors, 0, 'a refusal is the agent, not the box');
});

test('a successful run writes one draft carrying cost and provenance', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: ctx.agent.model, system: 'sys', task: 'task', schema: {} });
    if (!a.ok) throw new Error('unexpected');
    return {
      draft: {
        content: a.content, situation: 'a test run with one prior period',
        sources: [{ kind: 'fundamentals', ref: 'f1' }],
        verification: { agreed: true }, model: a.model,
        inputTokens: a.inputTokens, outputTokens: a.outputTokens, costUsd: a.costUsd,
      },
    };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  const model = scriptedModel([scriptedOk({ headline: 'Revenue up 12%' })]);
  const r = await drain(1, model);

  assert.equal(r.drafted, 1);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0]?.task, 'task', 'the assembled prompt is assertable');

  const [d] = await pendingDrafts();
  assert.equal(d?.content['headline'], 'Revenue up 12%');
  assert.deepEqual(d?.sources, [{ kind: 'fundamentals', ref: 'f1' }]);
  assert.ok(Number(d?.costUsd) > 0, 'cost is a real number, not 0.00');
});

// ---- the review gate ----------------------------------------------------------------------------

test('accepting records what the person changed, field by field', async () => {
  assert.deepEqual(
    diffFields({ a: 1, b: 'x' }, { a: 1, b: 'y' }),
    { b: { from: 'x', to: 'y' } },
  );
});

test('accepting lands a document and closes the draft', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return {
      draft: {
        content: a.content, situation: 'a test run', sources: [],
        model: a.model, costUsd: a.costUsd,
      },
    };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'As filed' })]));

  const [d] = await pendingDrafts();
  await acceptDraft(d!.id, { edits: { headline: 'Corrected headline' } }, ME);

  const doc = await readTxn(async (c) => {
    const { rows } = await c.query<{ title: string; created_by: string }>(
      'SELECT title, created_by FROM documents',
    );
    return rows[0];
  });
  assert.equal(doc?.title, 'Corrected headline');
  assert.equal(doc?.created_by, ME, 'what lands in the record is the analyst\'s');

  const draft = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; edits: Record<string, unknown> }>(
      'SELECT status, edits FROM ai_drafts',
    );
    return rows[0]!;
  });
  assert.equal(draft.status, 'accepted');
  assert.deepEqual(draft.edits, { headline: { from: 'As filed', to: 'Corrected headline' } });
  assert.equal((await pendingDrafts()).length, 0);
});

test('rejecting requires a reason', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return { draft: { content: a.content, situation: 'a test run', sources: [], model: a.model } };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'h' })]));
  const [d] = await pendingDrafts();

  await assert.rejects(() => rejectDraft(d!.id, '   ', ME), ReasonRequired);
  await rejectDraft(d!.id, 'figures do not match the filing', ME);
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ status: string; reject_reason: string }>(
      'SELECT status, reject_reason FROM ai_drafts',
    );
    return rows[0]!;
  });
  assert.equal(row.status, 'rejected');
  assert.equal(row.reject_reason, 'figures do not match the filing');
});

test('a draft cannot be decided twice', async () => {
  registerHandler('test', async (ctx) => {
    const a = await ctx.ask({ model: 'm', system: 's', task: 't', schema: {} });
    if (!a.ok) throw new Error('x');
    return { draft: { content: a.content, situation: 'a test run', sources: [], model: a.model } };
  });
  await enqueue({ agentKey: 'test', companyId: CO });
  await drain(1, scriptedModel([scriptedOk({ headline: 'h' })]));
  const [d] = await pendingDrafts();
  await acceptDraft(d!.id, null, ME);
  await assert.rejects(() => acceptDraft(d!.id, null, ME), /already accepted/);
});

test('the handler map is the only registry', () => {
  assert.ok(HANDLERS.has('test'));
});
