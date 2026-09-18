import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTxn, serviceTxn } from '../db.ts';
import { canonicalFigures } from './fundamentals.ts';
import { parse } from './xbrl.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_fun_${process.pid}`;
const fixture = () => readFileSync(new URL('./__fixtures__/vsttillers-q3fy25.xml', import.meta.url));
// AERON's FY24 annual, the real thing: the SME board files Non-Ind-AS, which renames most of the
// P&L and carries a full cash flow statement. Nothing in the corpus exercised either until
// 08-Sep-2026, because the fetch only ever asked equities/Quarterly.
const aeron = () => readFileSync(new URL('./__fixtures__/aeron-fy24-annual.xml', import.meta.url));

before(async () => {
  await createTestDatabase(DB);
});

after(async () => {
  await dropTestDatabase(DB);
});

test('maps taxonomy elements onto the columns ratios read', () => {
  const q = parse(fixture()).reports.find((r) => r.period.kind === 'quarter')!;
  const f = canonicalFigures(q);
  assert.equal(f['revenue'], '2191000000.00');
  assert.equal(f['profit_after_tax'], '12800000.00');
  assert.equal(f['total_expenses'], '2064100000.00');
  assert.equal(f['eps_basic'], '1.48');
});

test('a line the filing does not carry is absent, never zero', () => {
  const q = parse(fixture()).reports.find((r) => r.period.kind === 'quarter')!;
  const f = canonicalFigures(q);
  // A quarterly filing carries no balance sheet; the instant context is empty.
  assert.equal(f['total_assets'], undefined, 'absent, not 0 — zero is a real figure');
  assert.equal(f['inventories'], undefined);
});

test('an unmapped element is dropped rather than guessed at', () => {
  const q = parse(fixture()).reports.find((r) => r.period.kind === 'quarter')!;
  const f = canonicalFigures(q);
  // Symbol and NameOfTheCompany are facts in the instance and are not figures.
  assert.equal(f['Symbol'], undefined);
  assert.equal(f['symbol'], undefined);
});

test('the Non-Ind-AS profit element is read, not left null', () => {
  // Ind-AS calls it ProfitLossForPeriod; the SME taxonomy calls it ProfitLossForThePeriod, with
  // "The". Only the first was mapped, so every SME name stored a row with a null profit.
  const y = parse(aeron()).reports.find((r) => r.period.kind === 'year')!;
  const f = canonicalFigures(y);
  assert.equal(f['revenue'], '1997298000.00');
  assert.equal(f['profit_after_tax'], '101081000.00');
});

test('the cash flow statement survives into facts', () => {
  // Item 1 of the fund's checklist is CFO/EBITDA conversion. canonicalFigures keeps only what is
  // named, so before these were mapped the whole statement was fetched, parsed and discarded.
  const y = parse(aeron()).reports.find((r) => r.period.kind === 'year')!;
  const f = canonicalFigures(y);
  assert.equal(f['cash_from_operations'], '210527000.00');
  assert.equal(f['cash_from_investing'], '-142501000.00');
  assert.equal(f['cash_from_financing'], '-36239000.00');
});

test('a P&L that is entirely zero is absent, not measured', () => {
  // The same instance attaches the balance sheet to an Oct-2023..Mar-2024 duration and writes 0.00
  // into every P&L element. Stored verbatim that is "revenue Rs 0.0 crore" on a company page, and
  // a zero EBITDA for agent 7 to divide into.
  const h2 = parse(aeron()).reports.find(
    (r) => r.period.start === '2023-10-01' && r.period.end === '2024-03-31',
  )!;
  const f = canonicalFigures(h2);
  assert.equal(f['revenue'], undefined, 'absent, not 0.00');
  assert.equal(f['profit_after_tax'], undefined);
  assert.equal(f['total_expenses'], undefined);
  // The balance sheet beside it is real and is kept: it comes from the instant context.
  assert.equal(f['total_assets'], '1012794000.00');
  assert.equal(f['inventories'], '250904000.00');
});

test('a real P&L containing some zeros is untouched', () => {
  // The rule is "every mapped P&L line is zero", not "any of them is". A filing with a genuine
  // zero in one line must keep every other figure.
  const y = parse(aeron()).reports.find((r) => r.period.kind === 'year')!;
  const f = canonicalFigures(y);
  assert.equal(f['revenue'], '1997298000.00', 'a real year survives');
});

test('date columns come back as calendar dates, not as instants', async () => {
  // node-postgres parses a `date` into a local-midnight Date, so in IST toISOString() reports the
  // previous day. lib/db.ts pins the parser; this asserts it stayed pinned.
  await serviceTxn('system:ingest', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('c1','VSTTILLERS','V.S.T')");
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind)
       VALUES ('f1','c1','consolidated','2024-04-01','2024-12-31','year_to_date')`,
    );
  });
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{ period_start: unknown; period_end: unknown }>(
      'SELECT period_start, period_end FROM fundamentals',
    );
    return rows[0]!;
  });
  assert.equal(typeof row.period_start, 'string');
  assert.equal(row.period_start, '2024-04-01');
  assert.equal(row.period_end, '2024-12-31');
});

test('the unique index allows a restatement to supersede, not collide', async () => {
  await serviceTxn('system:ingest', async (c) => {
    // Same company, basis and period as f1. It is only insertable once f1 is superseded.
    await c.query("UPDATE fundamentals SET superseded_by = 'f2' WHERE id = 'f1'");
    await c.query(
      `INSERT INTO fundamentals (id, company_id, basis, period_start, period_end, period_kind, revenue)
       VALUES ('f2','c1','consolidated','2024-04-01','2024-12-31','year_to_date', 999)`,
    );
  });
  const live = await readTxn(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'SELECT id FROM fundamentals WHERE superseded_by IS NULL',
    );
    return rows.map((r) => r.id);
  });
  assert.deepEqual(live, ['f2'], 'one live row per period; the old figures stay readable');
});
