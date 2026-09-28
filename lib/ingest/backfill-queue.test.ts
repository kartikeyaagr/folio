/**
 * The backfill queue itself: who may claim a name, the lease that stops two passes overlapping it,
 * the bound on attempts, the `NOTIFY` that wakes the watcher, and what a removed name means to all
 * of it.
 *
 * Split from `backfill.test.ts` when that file passed the 300-line cap. The seam is real rather
 * than arithmetic: that file is about what one step's outcome *means* and how it gets written down
 * (`record`, `stepper`, `backfill_steps`); this one is about who may claim the row an outcome lives
 * on, and when — `claim`, `followed`, `owed`, `announce`. No network: these exercise the queue's own
 * decisions, not the eight steps, which are NSE calls and live in the job.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import {
  announce,
  CHANNEL,
  claim,
  followed,
  LEASE_MINUTES,
  MAX_ATTEMPTS,
  owed,
  record,
  type Target,
} from './backfill.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pg from 'pg';

/** One round trip after the COMMIT: pg delivers notifications on the next exchange with the server. */
const settle = async (c: pg.Client): Promise<void> => {
  await c.query('SELECT 1');
};

const DB = `folio_backfill_queue_${process.pid}`;
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

test('an empty forced claim tells a name that is not followed from one that is busy', async () => {
  assert.equal(await followed('TEGA'), true);
  assert.equal(await followed('tega'), true, 'the symbol is normalised before it is asked');
  assert.equal(await followed('NOTREAL'), false);

  // The live shape: another transaction holds the row through a foreign key, SKIP LOCKED does the
  // right thing and steps over it, and the claim is empty for a company that plainly exists.
  const held = await serviceTxn('system:ingest', async (c) => {
    await c.query('SELECT 1 FROM companies WHERE id = $1 FOR UPDATE', ['c1']);
    return claim('TEGA');
  });
  assert.deepEqual(held, [], 'a job never blocks on somebody else s transaction');
  assert.equal(await followed('TEGA'), true, 'and must not report the name as unknown');
});

test('a company already filled in is offered only by name', async () => {
  await record(await one(), [{ label: 'filings', detail: 'ok', outcome: 'ok' }]);
  assert.equal((await claim()).length, 0);
  assert.equal((await claim('TEGA')).length, 1);
});

// ------------------------------------------------------------------------------------------------
// Following a name starts the work, rather than scheduling it
// ------------------------------------------------------------------------------------------------

test('a removed name is not claimed, not even by name, and is not counted as owed', async () => {
  // `--symbol` bypasses the lease and the bound because a person typed it. A removal is also a
  // person's decision, and the later one; restoring the name is what puts it back in this queue.
  await serviceTxn('system:ingest', async (c) => {
    await c.query("UPDATE companies SET removed_at = now(), removed_by = $1 WHERE id = 'c1'", [ME]);
  });
  assert.deepEqual(await claim(), []);
  assert.deepEqual(await claim('TEGA'), []);
  assert.equal(await followed('TEGA'), false, 'so the job says it is not followed, not that it is busy');
  assert.deepEqual(await owed(), { leased: 0, exhausted: 0 });
  assert.equal((await state()).attempts, 0, 'and no attempt was spent on it');
});

test('a follow announces on the channel the watcher listens to, and only when it commits', async () => {
  const heard: string[] = [];
  const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
  await client.connect();
  try {
    client.on('notification', (n) => heard.push(n.payload ?? ''));
    await client.query(`LISTEN "${CHANNEL}"`);

    await serviceTxn('system:ingest', (c) => announce(c, 'TEGA'));
    await settle(client);
    assert.deepEqual(heard, ['TEGA'], 'the watcher must learn the symbol that was followed');

    // pg_notify is transactional. A follow that raised — an unknown symbol, a duplicate — must not
    // wake a watcher for a company that does not exist, and this is the only thing that makes the
    // doorbell safe to ring from inside addCompany's own transaction.
    heard.length = 0;
    await serviceTxn('system:ingest', async (c) => {
      await announce(c, 'ROLLEDBACK');
      throw new Error('the follow failed after announcing');
    }).catch(() => undefined);
    await settle(client);
    assert.deepEqual(heard, [], 'a rolled-back follow announces nothing');
  } finally {
    await client.end();
  }
});

test('the watcher drains the whole queue, never the symbol it was handed', async () => {
  // The payload is a hint about which name is newest, never the authority on what is owed. A name
  // followed while the watcher was restarting has no notification coming, and the queue is what
  // makes that survivable — so waking on TEGA must still offer the name nobody rang about.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO companies (id, symbol, name, created_at)
       VALUES ('c9','MISSED','Followed while the watcher was down', now() - interval '2 days')`,
    );
  });
  assert.deepEqual((await claim()).map((t) => t.symbol), ['MISSED', 'TEGA']);
});

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
