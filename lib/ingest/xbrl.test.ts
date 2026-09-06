/**
 * The fixture is a real NSE instance: VSTTILLERS Q3 FY25, fetched 06-Sep-2026.
 *
 * It is here because the bug this parser exists to prevent is only visible on real input. The
 * year-to-date context in this document declares the quarter's dates (2024-10-01..2024-12-31)
 * while carrying nine months of revenue. Believing the context reports ₹693.12 crore as a
 * ₹219.1 crore quarter — a threefold error, silently, on every company.
 *
 * Verified against v2's Python parser across 24 randomly sampled live filings: identical on every
 * field, and all 24 carried the same disagreement.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, UnparseableXbrl } from './xbrl.ts';

const fixture = () => readFileSync(new URL('./__fixtures__/vsttillers-q3fy25.xml', import.meta.url));

test('reads identity from the facts', () => {
  const inst = parse(fixture());
  assert.equal(inst.symbol, 'VSTTILLERS');
  assert.equal(inst.companyName, 'V.S.T Tillers Tractors Limited');
  assert.equal(inst.reports.length, 2);
});

test('takes the period from the reported facts, not the context', () => {
  const ytd = parse(fixture()).reports.find((r) => r.period.kind === 'year_to_date');
  assert.ok(ytd, 'expected a year-to-date report');
  // The context claims Oct-Dec. The facts say Apr-Dec, and the facts are right.
  assert.equal(ytd.period.start, '2024-04-01');
  assert.equal(ytd.period.end, '2024-12-31');
  assert.equal(ytd.period.months, 9);
  assert.equal(ytd.contextDatesDisagree, true, 'the disagreement must be recorded, not swallowed');
  assert.equal(ytd.periodInferred, false);
  assert.equal(ytd.facts['RevenueFromOperations'], '6931200000.00');
});

test('the quarter is the quarter, and its context does not lie', () => {
  const q = parse(fixture()).reports.find((r) => r.period.kind === 'quarter');
  assert.ok(q, 'expected a quarter report');
  assert.equal(q.period.start, '2024-10-01');
  assert.equal(q.period.months, 3);
  assert.equal(q.contextDatesDisagree, false);
  // Threefold apart. This is the number the trap would have destroyed.
  assert.equal(q.facts['RevenueFromOperations'], '2191000000.00');
});

test('refuses input that is not a results instance', () => {
  assert.throws(() => parse('<hello/>'), UnparseableXbrl);
  assert.throws(() => parse('not xml at all <<<'), UnparseableXbrl);
});
