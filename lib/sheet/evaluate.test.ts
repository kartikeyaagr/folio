/**
 * The formula engine.
 *
 * Pure, so no database. What is pinned here is mostly about *not* producing a number: a model whose
 * missing input reads as zero yields a margin, a growth rate and a valuation, all wrong and none of
 * them marked — which is the same argument `<Blank>` makes on every screen in this system, applied
 * where it does the most damage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { columnName, columnIndex, parseRef, expandRange } from './cells.ts';
import { parseFormula, BadFormula } from './parse.ts';
import { evaluateSheet, isCellError, literal, NA, type CellError, type Lookups } from './evaluate.ts';

const at = (cells: Record<string, string>, lookups?: Lookups) => {
  const v = evaluateSheet({ cells, ...(lookups ? { lookups } : {}) });
  return (ref: string) => v[ref];
};
const code = (v: unknown): string => (isCellError(v) ? v.err : `not an error: ${String(v)}`);

// ---- addresses -----------------------------------------------------------------------------------

test('columns are letters, and letters are not quite base 26', () => {
  // No zero digit, so Z is 26 and AA is 27. Wrong past the 26th column, which a model reaches.
  assert.equal(columnName(0), 'A');
  assert.equal(columnName(25), 'Z');
  assert.equal(columnName(26), 'AA');
  assert.equal(columnName(51), 'AZ');
  assert.equal(columnName(52), 'BA');
  for (const i of [0, 25, 26, 51, 52, 700]) assert.equal(columnIndex(columnName(i)), i);
});

test('a reference is a column and a one-based row', () => {
  assert.deepEqual(parseRef('B7'), { col: 1, row: 6 });
  assert.deepEqual(parseRef('$B$7'), { col: 1, row: 6 }, 'the dollars are noise to us');
  assert.equal(parseRef('B0'), null, 'there is no row zero');
  assert.equal(parseRef('7B'), null);
});

test('a range is a rectangle, whichever corner it was dragged from', () => {
  const a = expandRange({ col: 0, row: 0 }, { col: 1, row: 1 });
  const b = expandRange({ col: 1, row: 1 }, { col: 0, row: 0 });
  assert.equal(a.length, 4);
  assert.deepEqual(a, b);
});

// ---- arithmetic ----------------------------------------------------------------------------------

test('the operators, and the order they bind in', () => {
  const v = at({ A1: '=2+3*4', A2: '=(2+3)*4', A3: '=2^3^2', A4: '=-3^2', A5: '=10/4' });
  assert.equal(v('A1'), 14);
  assert.equal(v('A2'), 20);
  assert.equal(v('A3'), 512, 'exponentiation is right-associative');
  assert.equal(v('A4'), 9, 'the minus is on the 3, as in every spreadsheet');
  assert.equal(v('A5'), 2.5);
});

test('a cell reads its references, however deep', () => {
  const v = at({ A1: '10', A2: '=A1*2', A3: '=A2+A1', A4: '=A3/A1' });
  assert.equal(v('A4'), 3);
});

test('a percentage typed as one is a number', () => {
  assert.equal(literal('12%'), 0.12);
  assert.equal(at({ A1: '50%', A2: '=A1*200' })('A2'), 100);
});

// ---- what must never be a number ------------------------------------------------------------------

test('dividing by zero says so rather than answering', () => {
  assert.equal(code(at({ A1: '=1/0' })('A1')), '#DIV/0!');
});

test('an error spreads to everything that used it', () => {
  // Visible where it happened and where it went. A model where only the first cell shows the
  // problem invites you to trust the total.
  const v = at({ A1: '=1/0', A2: '=A1+1', A3: '=SUM(A1:A2)' });
  assert.equal(code(v('A2')), '#DIV/0!');
  assert.equal(code(v('A3')), '#DIV/0!');
});

test('a cell that depends on itself says so instead of hanging', () => {
  assert.equal(code(at({ A1: '=A1+1' })('A1')), '#CYCLE!');
  const v = at({ A1: '=B1', B1: '=A1' });
  assert.equal(code(v('A1')), '#CYCLE!');
});

test('an unknown function is named, not guessed at', () => {
  const e = at({ A1: '=XLOOKUP(1,2,3)' })('A1');
  assert.equal(code(e), '#NAME?');
  assert.match((e as CellError).detail, /XLOOKUP/);
});

test('a formula that will not parse reports itself and does not take the sheet down', () => {
  const v = at({ A1: '=1+', A2: '=2+2' });
  assert.equal(code(v('A1')), '#ERROR!');
  assert.equal(v('A2'), 4, 'the rest of the grid still works');
});

test('a figure this system does not hold is #N/A and never zero', () => {
  // The whole reason the data functions exist and the single most important assertion here.
  const v = at(
    { A1: '=FIN("PRAJIND","revenue","FY26")', A2: '=A1*1.1', A3: '=IFERROR(A1,0)' },
    { 'FIN(PRAJIND|REVENUE|FY26)': NA('no revenue filed') },
  );
  assert.equal(code(v('A1')), '#N/A');
  assert.equal(code(v('A2')), '#N/A', 'and it does not become a growth rate on the way');
  assert.equal(v('A3'), 0, 'unless somebody says so explicitly');
});

// ---- the functions -------------------------------------------------------------------------------

test('SUM skips the heading it was dragged over', () => {
  // Everybody selects the whole column. Reading "Revenue" as zero would be quietly wrong; counting
  // it as a value would make AVERAGE wrong too.
  const v = at({ A1: 'Revenue', A2: '10', A3: '20', A4: '=SUM(A1:A3)', A5: '=AVERAGE(A1:A3)', A6: '=COUNT(A1:A3)' });
  assert.equal(v('A4'), 30);
  assert.equal(v('A5'), 15);
  assert.equal(v('A6'), 2);
});

test('AVERAGE of nothing is an error, not zero', () => {
  assert.equal(code(at({ A1: '=AVERAGE(B1:B3)' })('A1')), '#DIV/0!');
});

test('IF does not evaluate the branch it did not take', () => {
  // So a formula can guard its own division, which is the main thing IF is for.
  const v = at({ A1: '0', A2: '=IF(A1=0,"n/a",100/A1)' });
  assert.equal(v('A2'), 'n/a');
});

test('the rest of the arithmetic', () => {
  const v = at({
    A1: '=ROUND(2.345,2)', A2: '=ABS(-4)', A3: '=MIN(3,1,2)', A4: '=MAX(3,1,2)',
    A5: '="a"&"b"', A6: '=CONCAT("x",1)', A7: '=2>1', A8: '=SQRT(9)',
  });
  assert.equal(v('A1'), 2.35);
  assert.equal(v('A2'), 4);
  assert.equal(v('A3'), 1);
  assert.equal(v('A4'), 3);
  assert.equal(v('A5'), 'ab');
  assert.equal(v('A6'), 'x1');
  assert.equal(v('A7'), true);
  assert.equal(v('A8'), 3);
});

test('a string keeps its quotes’ contents, doubled quotes included', () => {
  assert.deepEqual(parseFormula('="he said ""no"""'), { t: 'str', v: 'he said "no"' });
});

test('a formula with something left over is refused rather than half-read', () => {
  assert.throws(() => parseFormula('=1 2'), BadFormula);
  assert.throws(() => parseFormula('=SUM(A1'), BadFormula);
});

// ---- a model that looks like a model ---------------------------------------------------------------

test('a small model computes the way its author would', () => {
  const v = at(
    {
      A1: 'Revenue', B1: '=FIN("PRAJIND","revenue","FY26")',
      A2: 'Expenses', B2: '=FIN("PRAJIND","total_expenses","FY26")',
      A3: 'Operating profit', B3: '=B1-B2',
      A4: 'Margin', B4: '=B3/B1',
      A5: 'Shares', B5: '=QTY("PRAJIND")',
      A6: 'Our share of profit', B6: '=B3*B5/1000000',
    },
    {
      'FIN(PRAJIND|REVENUE|FY26)': 1000,
      'FIN(PRAJIND|TOTAL_EXPENSES|FY26)': 800,
      'QTY(PRAJIND)': 5000,
    },
  );
  assert.equal(v('B3'), 200);
  assert.equal(v('B4'), 0.2);
  assert.equal(v('B6'), 1);
});
