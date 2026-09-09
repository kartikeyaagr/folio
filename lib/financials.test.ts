/**
 * The three statements.
 *
 * The rules worth pinning are all about what is *not* shown: a basis the company does not file, a
 * period kind it has no rows for, a line no period reported, and the same balance sheet twice
 * under two headings. Each of those, drawn anyway, reads as a fact about the company rather than
 * as a gap in the filing.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, serviceTxn } from './db.ts';
import { financials } from './financials.ts';

const DB = `trisula_fin_${process.pid}`;
const CO = 'c1';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO companies (id, symbol, isin, name, status) VALUES ($1,'TEST','INE000A01001','Test Ltd','watching')",
      [CO],
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query('DELETE FROM fundamentals WHERE company_id = $1', [CO]);
  });
});

let seq = 0;
async function period(
  kind: string,
  basis: string,
  start: string,
  end: string,
  facts: Record<string, string>,
): Promise<void> {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, facts)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [`f${++seq}`, CO, basis, start, end, kind, JSON.stringify(facts)],
    );
  });
}

test('consolidated is preferred where both are filed', async () => {
  // It is the group, which is what a reader means by "the company".
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { revenue: '100' });
  await period('year', 'consolidated', '2023-04-01', '2024-03-31', { revenue: '200' });
  const f = await financials(CO);
  assert.equal(f.basis, 'consolidated');
  assert.deepEqual(f.bases, ['consolidated', 'standalone']);
  assert.equal(f.pnl[0]?.statement.rows[0]?.values[0], '200');
});

test('a basis the company does not file is offered disabled, and never shown empty', async () => {
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { revenue: '100' });
  const f = await financials(CO, 'consolidated');
  // Both positions exist so the switch is always drawn. Hiding it when a company files one basis
  // left a reader unable to tell whether the control was missing or the data was.
  assert.deepEqual(f.bases, ['consolidated', 'standalone'], 'the switch shows both');
  assert.deepEqual(f.filed, ['standalone'], 'and says which one is real');
  assert.equal(f.basis, 'standalone', 'asking for one it does not file falls back rather than emptying');
  assert.equal(f.pnl[0]?.statement.rows[0]?.values[0], '100');
});

test('only the period kinds the company actually files are offered', async () => {
  // An SME half-yearly filer has no quarters, and an empty Quarterly tab invites a reader to
  // wonder what went wrong.
  await period('half_year', 'standalone', '2024-04-01', '2024-09-30', { revenue: '50' });
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { revenue: '100' });
  const f = await financials(CO);
  assert.deepEqual(f.pnl.map((p) => p.kind), ['year', 'half_year']);
});

test('a line no period reported is left out, not drawn as a row of blanks', async () => {
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { revenue: '100' });
  const rows = (await financials(CO)).pnl[0]!.statement.rows.map((r) => r.key);
  assert.ok(rows.includes('revenue'));
  assert.ok(!rows.includes('employee_cost'), 'ten empty rows say nothing ten times');
});

test('operating profit is computed, marked as such, and adds interest and depreciation back', async () => {
  await period('year', 'standalone', '2023-04-01', '2024-03-31', {
    revenue: '1000', total_expenses: '900', finance_costs: '50', depreciation: '30',
  });
  const op = (await financials(CO)).pnl[0]!.statement.rows.find((r) => r.key === 'operating_profit');
  assert.ok(op, 'present when its inputs are');
  assert.equal(op.derived, true, 'said to be computed rather than filed');
  assert.equal(Number(op.values[0]), 180, '1000 - 900 + 50 + 30');
});

test('operating profit is absent when revenue is, not computed as a smaller number', async () => {
  // A subtraction with a missing term is an unknown, not a zero. This would otherwise be the most
  // confident wrong figure on the page.
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { total_expenses: '900' });
  const rows = (await financials(CO)).pnl[0]!.statement.rows;
  assert.ok(!rows.some((r) => r.key === 'operating_profit'));
});

test('the same balance sheet is one column, however many filings report it', async () => {
  // A balance sheet is a position at an instant. The half-year ending 31-Mar and the year ending
  // 31-Mar report the same sheet; two columns under two headings reads as a company that did not
  // move rather than as one figure shown twice.
  const sheet = { total_assets: '500', current_assets: '300' };
  await period('half_year', 'standalone', '2023-10-01', '2024-03-31', sheet);
  await period('year', 'standalone', '2023-04-01', '2024-03-31', sheet);
  await period('half_year', 'standalone', '2024-04-01', '2024-09-30', { total_assets: '600', current_assets: '350' });

  const bs = (await financials(CO)).balanceSheet;
  assert.deepEqual(bs.periods.map((p) => p.end), ['2024-03-31', '2024-09-30']);
  assert.deepEqual(bs.rows.find((r) => r.key === 'total_assets')?.values, ['500', '600']);
});

test('periods read oldest to newest, because a trend reads forwards', async () => {
  await period('year', 'standalone', '2022-04-01', '2023-03-31', { revenue: '80' });
  await period('year', 'standalone', '2023-04-01', '2024-03-31', { revenue: '100' });
  const st = (await financials(CO)).pnl[0]!.statement;
  assert.deepEqual(st.periods.map((p) => p.end), ['2023-03-31', '2024-03-31']);
  assert.deepEqual(st.rows[0]?.values, ['80', '100']);
});

test('a company with nothing filed offers no tabs rather than an empty table', async () => {
  const f = await financials(CO);
  assert.deepEqual(f.pnl, []);
  assert.deepEqual(f.balanceSheet.periods, []);
  assert.deepEqual(f.cashFlow.periods, []);
});
