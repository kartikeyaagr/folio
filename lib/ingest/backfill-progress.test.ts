/**
 * The one query `/companies` and a company's own page read to say how far a backfill has got.
 *
 * No network and no `stepper()`: these seed `companies` and `backfill_steps` directly, the same
 * split `backfill.test.ts` draws — that file exercises the decisions that write these rows, this
 * one exercises what is read back.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import { removeCompany } from '../companies.ts';
import { backfillProgress } from './backfill-progress.ts';

const DB = `folio_backfill_progress_${process.pid}`;
const ME = 'u1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM backfill_steps');
    await c.query('DELETE FROM companies');
  });
});

/** A followed name, with the queue columns a test wants pre-set. */
async function seedCompany(
  id: string,
  symbol: string,
  opts: {
    backfilledAt?: 'now';
    startedAt?: 'now' | 'expired';
    attempts?: number;
    removed?: boolean;
  } = {},
): Promise<void> {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO companies (id, symbol, name, added_by, backfilled_at, backfill_started_at,
                               backfill_attempts, removed_at, removed_by)
       VALUES ($1, $2, $3, $4,
               CASE WHEN $5 THEN now() END,
               CASE WHEN $6 = 'now' THEN now() WHEN $6 = 'expired' THEN now() - interval '200 minutes' END,
               $7,
               CASE WHEN $8 THEN now() END,
               CASE WHEN $8 THEN $4 END)`,
      [id, symbol, `${symbol} Limited`, ME, opts.backfilledAt === 'now', opts.startedAt ?? null,
        opts.attempts ?? 1, opts.removed ?? false],
    );
  });
}

async function seedStep(
  companyId: string,
  attempt: number,
  step: string,
  outcome: 'running' | 'ok' | 'gap' | 'error',
  extra: { subDone?: number; subTotal?: number } = {},
): Promise<void> {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO backfill_steps (company_id, attempt, step, outcome, detail, finished_at,
                                    sub_done, sub_total)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $4 <> 'running' THEN now() END, $6, $7)`,
      [companyId, attempt, step, outcome, `${step} detail`, extra.subDone ?? null, extra.subTotal ?? null],
    );
  });
}

test('the overall figure is filled out of owed, excluding removed names', async () => {
  await seedCompany('c1', 'TEGA', { backfilledAt: 'now' });
  await seedCompany('c2', 'AERON');
  await seedCompany('c3', 'GRAVITA', { removed: true });

  const { overall } = await backfillProgress();
  assert.deepEqual(overall, { filled: 1, owed: 2 });
});

test('a company outside the lease, and one already filled, are not running', async () => {
  await seedCompany('c1', 'TEGA', { backfilledAt: 'now' });
  await seedCompany('c2', 'AERON', { startedAt: 'expired' });

  const { running } = await backfillProgress();
  assert.deepEqual(running, []);
});

test('a running company reports its current step, the ones behind it, and its attempt', async () => {
  await seedCompany('c1', 'TEGA', { startedAt: 'now', attempts: 2 });
  await seedStep('c1', 2, 'filings', 'ok');
  await seedStep('c1', 2, 'annual reports', 'gap');
  await seedStep('c1', 2, 'documents', 'running');
  // A stale row from the attempt that failed must not be read as this one's.
  await seedStep('c1', 1, 'filings', 'error');

  const { running } = await backfillProgress();
  assert.equal(running.length, 1);
  const r = running[0]!;
  assert.equal(r.symbol, 'TEGA');
  assert.equal(r.attempt, 2);
  assert.equal(r.stepLabel, 'documents');
  assert.equal(r.stepIndex, 3, 'documents is the third of the eight steps');
  assert.deepEqual(r.outcomes, [
    { step: 'filings', outcome: 'ok' },
    { step: 'annual reports', outcome: 'gap' },
  ]);
});

test('a company claimed but not yet written to by any step reports step 0', async () => {
  await seedCompany('c1', 'TEGA', { startedAt: 'now' });
  const { running } = await backfillProgress();
  assert.equal(running.length, 1);
  assert.equal(running[0]!.stepIndex, 0);
  assert.equal(running[0]!.stepLabel, 'starting');
});

test("the prices step's sub-progress is read back: trading days done out of the window", async () => {
  await seedCompany('c1', 'TEGA', { startedAt: 'now' });
  await seedStep('c1', 1, 'filings', 'ok');
  await seedStep('c1', 1, 'prices', 'running', { subDone: 175, subTotal: 400 });

  const { running } = await backfillProgress();
  assert.equal(running.length, 1);
  assert.equal(running[0]!.stepLabel, 'prices');
  assert.deepEqual([running[0]!.subDone, running[0]!.subTotal], [175, 400]);
});

test('a company with only backfill_steps recorded is still deleted outright, taking them with it', async () => {
  // GRAVITA's own case (0063): nothing recorded against the name but what the backfill itself
  // wrote. `company_id` is `ON DELETE CASCADE` for exactly this — a progress row is derived data,
  // the same as company_aliases, sources and chunks, not something worth blocking a delete for.
  await seedCompany('c1', 'GRAVITA', { startedAt: 'now' });
  await seedStep('c1', 1, 'filings', 'ok');
  await seedStep('c1', 1, 'documents', 'running');

  const result = await removeCompany(ME, 'GRAVITA');
  assert.equal(result, 'deleted', 'a restricting FK would have forced the removed fallback instead');

  const left = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM backfill_steps WHERE company_id = $1',
      ['c1'],
    );
    return Number(rows[0]!.n);
  });
  assert.equal(left, 0, 'the cascade must take the progress rows with the company');
});
