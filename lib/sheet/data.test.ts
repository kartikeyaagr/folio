/**
 * `=FIN(...)` against a real database.
 *
 * `evaluate.test.ts` covers the grid with its lookups stubbed, and `format.test.ts` covers the
 * rendering. Nothing covered the SQL in between — the one place a figure in somebody's model is
 * actually chosen — which is how a basis argument that only sorted the candidates rather than
 * filtering them survived. These tests exist at that seam.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { serviceTxn } from '../db.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { collectCalls, resolveCalls } from './data.ts';

const DB = `trisula_sheetdata_${process.pid}`;
const CO = 'c_praj';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:ingest', (c) =>
    c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'PRAJIND','Praj Industries')", [CO]));
});
after(() => dropTestDatabase(DB));

beforeEach(() => serviceTxn('system:ingest', (c) => c.query('DELETE FROM fundamentals')));

/** One filed year, on whichever basis is asked for. Figures differ so the answer names its source. */
function filedYear(basis: 'standalone' | 'consolidated', revenue: number): Promise<unknown> {
  return serviceTxn('system:ingest', (c) =>
    c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, facts)
       VALUES ($1,$2,$3,'2025-04-01','2026-03-31','year',$4::jsonb)`,
      [`f_${basis}`, CO, basis, JSON.stringify({ revenue: String(revenue) })],
    ));
}

const ask = async (formula: string): Promise<unknown> => {
  const calls = collectCalls([{ name: 'S', cells: { A1: formula } }]);
  const out = await resolveCalls(calls);
  return Object.values(out)[0];
};

test('the basis asked for is the basis answered', async () => {
  await filedYear('consolidated', 1000);
  await filedYear('standalone', 400);
  assert.equal(await ask('=FIN("PRAJIND","revenue","FY26","consolidated")'), 1000);
  assert.equal(await ask('=FIN("PRAJIND","revenue","FY26","standalone")'), 400);
});

test('consolidated is the default, because that is the figure a reader means', async () => {
  await filedYear('consolidated', 1000);
  await filedYear('standalone', 400);
  assert.equal(await ask('=FIN("PRAJIND","revenue","FY26")'), 1000);
});

test('a basis that was never filed answers #N/A, not the other basis', async () => {
  // The bug this file was written for. `basis` appeared only in `ORDER BY (f.basis = $5) DESC`,
  // so it preferred the right row when one existed and silently returned the wrong one when it
  // did not. A model asking for consolidated revenue got the standalone figure — 400 where it
  // wanted 1000 — with nothing marking it.
  //
  // That is worse than the blank this module's header refuses to let a missing figure become:
  // "a blank cell in a model propagates into a margin, a growth rate and a valuation, and none of
  // them will be marked as resting on nothing." A plausible wrong number propagates just as far
  // and does not even look wrong.
  await filedYear('standalone', 400);
  const consolidated = await ask('=FIN("PRAJIND","revenue","FY26","consolidated")');
  assert.notEqual(consolidated, 400, 'must not substitute the standalone figure');
  assert.equal(typeof consolidated, 'object', 'an #N/A value, not a number');
  assert.match(JSON.stringify(consolidated), /consolidated/, 'and it names the basis it wanted');

  // The other direction, so the guard is not simply "consolidated always fails".
  assert.equal(await ask('=FIN("PRAJIND","revenue","FY26","standalone")'), 400);
});

test('a restated period answers with the restatement, not the original', async () => {
  // A restatement is a new row, not an edit (migration 0003): "the old figures are what was
  // believed at the time." `fundamentals_period_idx` is unique on
  // (company, basis, period) WHERE superseded_by IS NULL, so exactly one row per period is live
  // — which is why the superseded row has to be written already pointing at its successor rather
  // than being updated afterwards.
  await filedYear('consolidated', 1100);
  await serviceTxn('system:ingest', (c) =>
    c.query(
      `INSERT INTO fundamentals
         (id, company_id, basis, period_start, period_end, period_kind, facts, superseded_by)
       VALUES ('f_old',$1,'consolidated','2025-04-01','2026-03-31','year',$2::jsonb,'f_consolidated')`,
      [CO, JSON.stringify({ revenue: '900' })],
    ));
  assert.equal(await ask('=FIN("PRAJIND","revenue","FY26","consolidated")'), 1100);
});

test('a fact that is not a figure answers #N/A, not NaN', async () => {
  // `Number(v)` was returned unguarded. NaN is a number to the grid: it propagates into a margin
  // and a valuation exactly as a wrong figure would, and renders as a value rather than as a
  // refusal — the failure this module's header exists to forbid, one step past the blank.
  //
  // `facts` is written by `lib/ingest/xbrl.ts` and holds numeric strings today, so this guards a
  // source that does not exist yet. `Number('1,000')` is also NaN, which is the shape a future
  // writer is most likely to arrive in.
  await serviceTxn('system:ingest', (c) =>
    c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, facts)
       VALUES ('f_text',$1,'consolidated','2025-04-01','2026-03-31','year',$2::jsonb)`,
      [CO, JSON.stringify({ revenue: 'not a number' })],
    ));
  const out = await ask('=FIN("PRAJIND","revenue","FY26","consolidated")');
  assert.equal(typeof out, 'object', 'an #N/A value, not a number');
  assert.ok(!Number.isNaN(out as unknown as number), 'and certainly not NaN');
  assert.match(JSON.stringify(out), /not a figure/);
});
