/**
 * What a step ending badly means, and how a step's own outcome gets written down as it happens
 * rather than only at the end.
 *
 * Every test here fails against the code as it stood on 17-Sep-2026. The job marked a name
 * `backfilled_at = now()` whichever way its steps went, and the queue's predicate is that column,
 * so a run that failed on the box retired the company permanently — the same mistake
 * `lib/agents/queue.ts` had already fixed for agent runs with `requeueErrored`.
 *
 * No network: these exercise the decisions, not the eight steps, which are NSE calls and live in
 * the job. `backfill-queue.test.ts` holds who may claim a name, the lease, the bound on attempts,
 * and the `NOTIFY` that wakes the watcher — split off when this file passed the 300-line cap. The
 * seam is real rather than arithmetic: this file is about what one step's outcome *means* and how
 * it is recorded; that one is about who may claim the row an outcome lives on, and when.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import {
  broke,
  claim,
  did,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  nothingFiled,
  record,
  stepper,
  verdictOf,
  type Step,
  type Target,
} from './backfill.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DB = `folio_backfill_${process.pid}`;
const ME = 'u1';

before(async () => {
  // Its own store. The default is the VM's /var/lib/folio/attachments, which is not writable
  // here — and a test that passes or fails on the ambient environment is not a test.
  process.env['ATTACHMENT_DIR'] = mkdtempSync(join(tmpdir(), 'folio-attach-'));
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
  rmSync(process.env['ATTACHMENT_DIR'] ?? '', { recursive: true, force: true });
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM notification_outbox');
    // In dependency order: a filing points at an attachment, and both point at a company, as do
    // this attempt's backfill_steps rows.
    await c.query('DELETE FROM filings');
    await c.query('DELETE FROM attachments');
    await c.query('DELETE FROM backfill_steps');
    await c.query('DELETE FROM companies');
    await c.query(
      `INSERT INTO companies (id, symbol, name, added_by, created_at)
       VALUES ('c1','TEGA','Tega Industries Limited',$1, now() - interval '1 day')`,
      [ME],
    );
  });
});

const state = (): Promise<{
  backfilledAt: Date | null; startedAt: Date | null; error: string | null; attempts: number;
}> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{
      backfilledAt: Date | null; startedAt: Date | null; error: string | null; attempts: number;
    }>(
      `SELECT backfilled_at AS "backfilledAt", backfill_started_at AS "startedAt",
              backfill_error AS error, backfill_attempts AS attempts
         FROM companies WHERE id = 'c1'`,
    );
    return rows[0]!;
  });

const notices = (): Promise<{ subject: string }[]> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ subject: string }>(
      'SELECT subject FROM notification_outbox ORDER BY subject',
    );
    return rows;
  });

/** Move the lease into the past, which is what ninety minutes of wall clock would do. */
const expireLease = (): Promise<void> =>
  serviceTxn('system:ingest', async (c) => {
    await c.query(
      `UPDATE companies SET backfill_started_at = now() - ($1 || ' minutes')::interval
        WHERE id = 'c1'`,
      [String(LEASE_MINUTES + 1)],
    );
  });

const one = async (): Promise<Target> => {
  const [t] = await claim();
  assert.ok(t, 'expected the queue to offer TEGA');
  return t;
};

// ------------------------------------------------------------------------------------------------
// What a step ending badly means
// ------------------------------------------------------------------------------------------------

test('a step that broke keeps the name in the queue; the old code marked it done forever', async () => {
  const t = await one();
  const verdict = await record(t, [
    { label: 'filings', detail: '486 served', outcome: 'ok' },
    // The literal shape of the 17-Sep reproduction: an unwritable ATTACHMENT_DIR, every one of 93
    // attachments EACCES, and a step that returned a sentence rather than throwing.
    { label: 'documents', detail: '0 fetched, 0 read, 93 failed', outcome: 'error' },
  ]);

  assert.equal(verdict, 'queued again');
  const s = await state();
  assert.equal(s.backfilledAt, null, 'a backfill the box broke is not a finished backfill');
  assert.equal(s.error, 'documents: 0 fetched, 0 read, 93 failed');

  await expireLease();
  assert.equal((await claim()).length, 1, 'the queue must offer it again');
});

test('a step that found nothing filed finishes the name and records the gap', async () => {
  const t = await one();
  const verdict = await record(t, [
    { label: 'filings', detail: '486 served', outcome: 'ok' },
    // AERON and TCL's real state: NSE's submissions index carries recent quarters only and neither
    // name is in it. That is a fact about the name, and re-fetching it changes nothing.
    { label: 'shareholding', detail: 'none of the 1842 recent submissions is this name', outcome: 'gap' },
  ]);

  assert.equal(verdict, 'filled with gaps');
  const s = await state();
  assert.ok(s.backfilledAt, 'a gap must not hold the queue');
  assert.match(s.error ?? '', /^shareholding: /, 'the gap is still on the record');
  assert.equal((await claim()).length, 0);
  assert.deepEqual(await notices(), [{ subject: 'TEGA is ready, with 1 gap' }]);
});

test('every step clean finishes with no error text and a plain notice', async () => {
  await record(await one(), [{ label: 'filings', detail: '486 served', outcome: 'ok' }]);
  const s = await state();
  assert.ok(s.backfilledAt);
  assert.equal(s.error, null);
  assert.deepEqual(await notices(), [{ subject: 'TEGA is ready' }]);
});

test('a throw is error, never a gap — a step that threw does not know what the exchange holds', async () => {
  const { taken, attempt } = stepper({ id: 'c1', attempts: 1 });
  await attempt('prices', async () => {
    throw new Error('fetch failed');
  });
  await attempt('results', async () => nothingFiled('nothing filed'));
  await attempt('filings', async () => did('486 served'));
  assert.deepEqual(
    taken.map((s: Step) => [s.label, s.outcome]),
    [['prices', 'error'], ['results', 'gap'], ['filings', 'ok']],
  );
  assert.equal(taken[0]!.detail, 'fetch failed');
});

const label = (r: { detail: string; outcome: 'ok' | 'gap' | 'error' }, i: number): Step => ({
  label: `s${i}`,
  ...r,
});

test('verdictOf ranks a break above a gap however many clean steps surround it', () => {
  assert.equal(verdictOf([did('a'), nothingFiled('b'), broke('c')].map(label), 1), 'queued again');
  assert.equal(verdictOf([did('a'), nothingFiled('b')].map(label), 1), 'filled with gaps');
  assert.equal(verdictOf([did('a')].map(label), 1), 'filled');
  assert.equal(verdictOf([broke('c')].map(label), MAX_ATTEMPTS), 'out of attempts');
});

// ------------------------------------------------------------------------------------------------
// backfill_steps: a row per step, written as it happens rather than at the end
// ------------------------------------------------------------------------------------------------

const stepRows = (companyId: string, attempt: number) =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ step: string; outcome: string; finished: boolean }>(
      `SELECT step, outcome, (finished_at IS NOT NULL) AS finished
         FROM backfill_steps WHERE company_id = $1 AND attempt = $2 ORDER BY id`,
      [companyId, attempt],
    );
    return rows;
  });

test('a step is recorded running, under its own row, before it resolves', async () => {
  const t = await one();
  const { attempt, taken } = stepper(t);
  let sawWhileRunning: { step: string; outcome: string; finished: boolean } | undefined;

  await attempt('prices', async (rowId) => {
    // Read from inside the step: by the time `work` runs, `attempt` has already awaited the
    // INSERT, so this is not a race — it is the one moment the row is guaranteed to say `running`.
    const { rows } = await readTxn((c) =>
      c.query<{ step: string; outcome: string; finished: boolean }>(
        'SELECT step, outcome, (finished_at IS NOT NULL) AS finished FROM backfill_steps WHERE id = $1',
        [rowId],
      ),
    );
    sawWhileRunning = rows[0];
    return did('375 closes');
  });

  assert.deepEqual(sawWhileRunning, { step: 'prices', outcome: 'running', finished: false });
  assert.equal(taken[0]?.outcome, 'ok');
  assert.deepEqual(await stepRows(t.id, t.attempts), [
    { step: 'prices', outcome: 'ok', finished: true },
  ]);
});

test('step rows are written in order, each with the outcome it actually ended on', async () => {
  const t = await one();
  const { attempt } = stepper(t);
  await attempt('filings', async () => did('486 served'));
  await attempt('documents', async () => nothingFiled('this name holds no document'));
  await attempt('prices', async () => broke('fetch failed'));

  assert.deepEqual(await stepRows(t.id, t.attempts), [
    { step: 'filings', outcome: 'ok', finished: true },
    { step: 'documents', outcome: 'gap', finished: true },
    { step: 'prices', outcome: 'error', finished: true },
  ]);
});

test('a retry starts a fresh set of rows; the failed attempt keeps its own', async () => {
  const first = await one();
  await stepper(first).attempt('filings', async () => broke('feed down'));
  await record(first, [{ label: 'filings', detail: 'feed down', outcome: 'error' }]);
  await expireLease();

  const second = await one();
  assert.equal(second.attempts, 2, 'the claim is what counts the attempt');
  await stepper(second).attempt('filings', async () => did('486 served'));

  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ attempt: number; outcome: string }>(
      'SELECT attempt, outcome FROM backfill_steps WHERE company_id = $1 ORDER BY attempt, id',
      [first.id],
    );
    return rows;
  });
  assert.deepEqual(rows, [
    { attempt: 1, outcome: 'error' },
    { attempt: 2, outcome: 'ok' },
  ]);
});
