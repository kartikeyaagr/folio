/**
 * The queue a newly followed name sits in, and the three questions `0058` exists to answer:
 * who may claim it, what a step ending badly means, and whether the name is then done.
 *
 * Every test here fails against the code as it stood on 17-Sep-2026. The job marked a name
 * `backfilled_at = now()` whichever way its steps went, and the queue's predicate is that column,
 * so a run that failed on the box retired the company permanently — the same mistake
 * `lib/agents/queue.ts` had already fixed for agent runs with `requeueErrored`.
 *
 * No network: these exercise the decisions, not the seven steps, which are NSE calls and live in
 * the job.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
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
import { fetchAttachments } from './attachments.ts';

const DB = `trisula_backfill_${process.pid}`;
const ME = 'u1';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM notification_outbox');
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
  const { taken, attempt } = stepper();
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
// The claim is a lease, and the attempts are bounded
// ------------------------------------------------------------------------------------------------

test('a claimed name is not offered again inside the lease', async () => {
  assert.equal((await claim()).length, 1);
  assert.equal(
    (await claim()).length,
    0,
    'the ten-minute timer would otherwise start a second pass and a second backfill-prices',
  );
  await expireLease();
  assert.equal((await claim()).length, 1);
});

test('a name runs out of attempts, leaves the queue without being called filled in, and says so', async () => {
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const t = await one();
    assert.equal(t.attempts, i, 'the claim is what counts the attempt');
    const verdict = await record(t, [{ label: 'filings', detail: 'the feed returned nothing', outcome: 'error' }]);
    assert.equal(verdict, i < MAX_ATTEMPTS ? 'queued again' : 'out of attempts');
    await expireLease();
  }

  const s = await state();
  assert.equal(s.attempts, MAX_ATTEMPTS);
  assert.equal(s.backfilledAt, null, 'giving up is not the same statement as having the history');
  assert.equal((await claim()).length, 0, 'the bound is what takes it off the queue');

  // One notice, on the last attempt only. Three would train a reader to ignore them, and none at
  // all would leave a name nothing ever mentions again — the shape open item 11 already cost once.
  assert.deepEqual(await notices(), [
    { subject: `TEGA could not be filled in after ${MAX_ATTEMPTS} attempts` },
  ]);
});

test('--symbol overrides the lease and the bound, and resets the counter', async () => {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await record(await one(), [{ label: 'filings', detail: 'broke', outcome: 'error' }]);
    await expireLease();
  }
  assert.equal((await claim()).length, 0, 'out of attempts');

  const [forced] = await claim('tega');
  assert.ok(forced, 'a person naming the symbol must always get it');
  assert.equal(forced.attempts, 1, 'a forced run starts the count again');
  assert.equal(forced.symbol, 'TEGA');

  // Still forced while the lease is warm: --symbol is a person standing there, not the timer.
  assert.equal((await claim('TEGA')).length, 1);
});

test('the queue is oldest ask first, which RETURNING does not preserve on its own', async () => {
  await serviceTxn('system:ingest', async (c) => {
    // Deliberately reverse-alphabetical to the ask order, so a sort on the symbol would pass this
    // by accident and a sort on nothing at all would pass it by luck.
    await c.query(
      `INSERT INTO companies (id, symbol, name, created_at) VALUES
         ('c2','ZZZ','Asked second', now() - interval '12 hours'),
         ('c3','AAA','Asked third',  now() - interval '1 hour')`,
    );
  });
  // A person who followed a name this morning should not wait behind one followed at lunch.
  assert.deepEqual((await claim()).map((t) => t.symbol), ['TEGA', 'ZZZ', 'AAA']);
});

test('a company already filled in is offered only by name', async () => {
  await record(await one(), [{ label: 'filings', detail: 'ok', outcome: 'ok' }]);
  assert.equal((await claim()).length, 0);
  assert.equal((await claim('TEGA')).length, 1);
});

// ------------------------------------------------------------------------------------------------
// The two numbers that are written down in three places
// ------------------------------------------------------------------------------------------------

test('the queue index, the read model and this module agree on the bound and the lease', () => {
  // The index predicate decides whether the queue is a seek or a scan; `company-view.ts` decides
  // what a person is told. Neither can import this module — one is SQL in a migration, the other a
  // read model that must not pull in a job's code to render a word — so the agreement is asserted.
  const migration = readFileSync(
    new URL('../../db/migrations/0058_a_backfill_the_box_broke_is_not_a_finished_backfill.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, new RegExp(`backfill_attempts < ${MAX_ATTEMPTS}\\b`));

  const view = readFileSync(new URL('../company-view.ts', import.meta.url), 'utf8');
  assert.match(view, new RegExp(`backfill_attempts >= ${MAX_ATTEMPTS}\\b`));
  assert.match(view, new RegExp(`interval '${LEASE_MINUTES} minutes'`));
});

/**
 * The document step's half, asserted here rather than in `attachments.test.ts` because it is a
 * guarantee about the backfill: the step that fills in TEGA must not spend its one capped pass on
 * PRAJIND's backlog.
 *
 * The URL is a closed port on loopback, so the one row the scoped call does select refuses in
 * microseconds without DNS or internet — the counts stay the subject of the test rather than the
 * network being one.
 */
test('fetchAttachments narrows to one company when the backfill asks it to', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('c2','PRAJIND','Praj Industries Limited')");
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, attachment_url)
       VALUES ('f1','c2','PRAJIND','Outcome', now(), 'http://127.0.0.1:1/x.pdf')`,
    );
  });

  const mine = await fetchAttachments(100, 'c1');
  assert.deepEqual(
    { pending: mine.pending, failed: mine.failed },
    { pending: 0, failed: 0 },
    'TEGA owns none of PRAJIND\'s filings, so its step must not even try them',
  );
  assert.equal((await fetchAttachments(100, 'c2')).pending, 1);
  assert.equal((await fetchAttachments(100)).pending, 1, 'unscoped still sees the whole desk');
});
