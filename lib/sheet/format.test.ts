/**
 * Formatting.
 *
 * The property worth pinning hardest is the one that is not about appearance at all: a format can
 * change what a cell *shows* and can never change what it *holds*. Everything else here is about a
 * format being absent rather than false — a stored `{"bold": false}` and a stored `{}` meaning two
 * things would make the version history, the diffing and the "is this cell formatted" test all
 * disagree with each other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateSheet, NA } from './evaluate.ts';
import {
  classesFor, clampCol, clampRow, display, isEmpty, readFormats, readSizes, stepDp, toggleFlag,
  withPatch, FACES, MAX_COL, MAX_ROW, MIN_COL, MIN_ROW, SIZES, type Format,
} from './format.ts';

// ---- what a cell shows -----------------------------------------------------------------------

test('with no format a number reads as it always has', () => {
  assert.equal(display(185.84000000000015, undefined), '185.84');
  assert.equal(display(2585.94, {}), '2585.94');
  assert.equal(display(1.5e10, undefined), '1.500e+10', 'big enough and it goes exponential');
  assert.equal(display('', undefined), '');
  assert.equal(display(undefined, undefined), '');
});

test('the number styles, in Indian digit grouping', () => {
  // 12,34,567.89 and not 1,234,567.89 — the same rule components/ui.tsx applies to every figure.
  assert.equal(display(1234567.89, { style: 'number' }), '12,34,567.89');
  assert.equal(display(1234567.89, { style: 'inr' }), '₹12,34,567.89');
  assert.equal(display(0.1845, { style: 'percent' }), '18.5%');
  assert.equal(display(0.1845, { style: 'percent', dp: 2 }), '18.45%');
});

test('zero decimal places is a real answer, not a missing one', () => {
  assert.equal(display(2585.94, { style: 'number', dp: 0 }), '2,586');
  assert.equal(display(2585.94, { style: 'inr', dp: 0 }), '₹2,586');
});

test('a date is shown as a person says it, without moving a day', () => {
  // `new Date("2026-03-31")` is midnight UTC; rendering that anywhere behind UTC gives the 30th.
  assert.equal(display('2026-03-31', { style: 'date' }), '31 Mar 2026');
  assert.equal(display('2026-01-01', { style: 'date' }), '1 Jan 2026');
  assert.equal(display('not a date', { style: 'date' }), 'not a date', 'left alone rather than mangled');
});

test('an error shows its code whatever the format says', () => {
  // A formatted `#N/A` that rendered as `₹0.00` would be the single worst bug this file could have.
  assert.equal(display(NA('no figure held'), { style: 'inr', dp: 2 }), '#N/A');
  assert.equal(display(NA('no figure held'), { style: 'number' }), '#N/A');
});

test('a format changes what a cell shows and never what it holds', () => {
  // The whole separation, stated as a test. The evaluator never sees a format; these are the same
  // figures rendered two ways, and the arithmetic downstream of them is identical.
  const v = evaluateSheet({ cells: { A1: '1000', A2: '0.12', A3: '=A1*(1+A2)' } });
  assert.equal(v['A3'], 1120);
  assert.equal(display(v['A3'], { style: 'inr', dp: 0 }), '₹1,120');
  assert.equal(display(v['A3'], { style: 'percent' }), '1,12,000.0%');
  assert.equal(v['A3'], 1120, 'still the number it was');
});

// ---- the shape that gets stored ---------------------------------------------------------------

test('a flag is on or absent, never false', () => {
  const on = toggleFlag(undefined, 'bold');
  assert.deepEqual(on, { bold: true });
  assert.deepEqual(toggleFlag(on, 'bold'), {}, 'off is the key going away');
  assert.ok(isEmpty(toggleFlag(on, 'bold')));
});

test('setting a control back to its default removes it rather than storing it', () => {
  assert.deepEqual(withPatch({ align: 'center' }, { align: undefined }), {});
  assert.deepEqual(withPatch({ style: 'inr' }, { style: 'auto' }), {}, 'auto is the absence of a style');
  assert.deepEqual(withPatch({ bold: true }, { italic: true }), { bold: true, italic: true });
});

test('stepping decimals on an unformatted cell makes it a number', () => {
  // Pressing "more decimals" on a plain cell means you wanted a number, so it becomes one rather
  // than silently storing a decimal count that nothing reads.
  assert.deepEqual(stepDp(undefined, 1), { dp: 3, style: 'number' });
  assert.deepEqual(stepDp({ style: 'inr', dp: 2 }, -1), { style: 'inr', dp: 1 });
  assert.deepEqual(stepDp({ style: 'number', dp: 0 }, -1), { style: 'number', dp: 0 }, 'never below zero');
  assert.equal(stepDp({ style: 'number', dp: 6 }, 1).dp, 6, 'never past six');
});

test('classes, never inline styles — that is what the grid renders from', () => {
  const f: Format = { bold: true, align: 'right', ink: 'red', fill: 'amber', clip: true };
  const classes = classesFor(f).split(' ');
  for (const c of ['cf-bold', 'cf-right', 'cf-ink-red', 'cf-fill-amber', 'cf-clip']) {
    assert.ok(classes.includes(c), `expected ${c}`);
  }
  assert.equal(classesFor(undefined), '');
  assert.equal(classesFor({}), '');
});

// ---- reading a body back ----------------------------------------------------------------------

test('a stored format is validated field by field, not trusted', () => {
  // A body is JSON a previous version of this app wrote. An `ink` of "chartreuse" would render as
  // a class that does not exist — a cell quietly ignoring its own formatting, which is the kind of
  // wrong nobody reports because it looks like nobody set it.
  const read = readFormats({
    A1: { bold: true, ink: 'red', align: 'center' },
    A2: { ink: 'chartreuse', align: 'sideways', style: 'hexadecimal' },
    A3: { bold: 'yes', dp: 99 },
    A4: 'not an object',
    A5: { style: 'auto' },
  });
  assert.deepEqual(read['A1'], { bold: true, ink: 'red', align: 'center' });
  assert.equal(read['A2'], undefined, 'nothing in it survived, so the cell is unformatted');
  assert.deepEqual(read['A3'], { dp: 6 }, 'a string is not a flag; 99 places is clamped to six');
  assert.equal(read['A4'], undefined);
  assert.equal(read['A5'], undefined, 'auto is the default, so it is not a format');
});

test('a body with no formats at all reads as no formats', () => {
  assert.deepEqual(readFormats(undefined), {});
  assert.deepEqual(readFormats(null), {});
  assert.deepEqual(readFormats([]), {});
});

// ---- sizes set by hand -------------------------------------------------------------------------

test('a drag cannot make a column too narrow to click or a row taller than the screen', () => {
  assert.equal(clampCol(-40), MIN_COL);
  assert.equal(clampCol(9999), MAX_COL);
  assert.equal(clampCol(237.4), 237, 'whole pixels — a fractional column width renders blurry');
  assert.equal(clampRow(0), MIN_ROW);
  assert.equal(clampRow(9999), MAX_ROW);
});

test('stored sizes are validated the same way stored formats are', () => {
  // Same argument as readFormats: this is JSON a previous version wrote, and a width of "wide" or
  // NaN reaches the grid as a broken CSS value — a column silently ignoring the size somebody set.
  const read = readSizes({ '0': 240, '1': 'wide', '2': NaN, '3': 9999, A: 100, '4': 10 }, clampCol);
  assert.deepEqual(read, { '0': 240, '3': MAX_COL, '4': MIN_COL });
  assert.deepEqual(readSizes(undefined, clampCol), {});
  assert.deepEqual(readSizes([1, 2, 3], clampCol), {}, 'an array is not a map of index to width');
});

// ---- typeface and size --------------------------------------------------------------------------

test('a typeface and a size are classes, so one rule serves a cell and a memo', () => {
  const classes = classesFor({ face: 'mono', size: 14, valign: 'middle' }).split(' ');
  for (const c of ['cf-face-mono', 'cf-size-14', 'cf-v-middle']) {
    assert.ok(classes.includes(c), `expected ${c}`);
  }
});

test('a face or size from outside the ladder is refused, not rendered as a broken class', () => {
  // `cf-face-comic` and `cf-size-13` are classes that do not exist, so the cell would quietly
  // ignore its own formatting — which reads as nobody having set it.
  const read = readFormats({
    A1: { face: 'mono', size: 14, valign: 'bottom' },
    A2: { face: 'comic-sans', size: 13, valign: 'sideways' },
  });
  assert.deepEqual(read['A1'], { face: 'mono', size: 14, valign: 'bottom' });
  assert.equal(read['A2'], undefined);
});

test('every size has a rule behind it', () => {
  // The ladder and the stylesheet have to agree; a size with no `.cf-size-N` renders at the
  // grid default and looks like the control did nothing.
  for (const n of SIZES) assert.ok(classesFor({ size: n }).includes(`cf-size-${n}`));
});

test('each typeface names a font Word has', () => {
  // A memo exported in a family Word cannot find arrives in Calibri, and the reader never learns
  // it was meant to be anything else.
  for (const f of FACES) assert.match(f.word, /^[A-Za-z ]+$/);
});

test('a date-formatted cell holding an impossible number renders instead of throwing', () => {
  // `Number.isFinite` is not the same question as "a Date can hold this". Past ±8.64e15 ms the
  // Date is Invalid and `toISOString()` throws RangeError — and `display` is called straight from
  // the render in `SheetEditor.tsx`, so one such cell took the whole sheet down rather than
  // showing one bad value. A formula can reach that magnitude without anybody typing it.
  const fmt = { style: 'date' } as const;
  assert.doesNotThrow(() => display(1e20, fmt));
  assert.equal(display(1e20, fmt), String(1e20), 'falls back to the number itself');
  assert.doesNotThrow(() => display(-1e20, fmt));

  // A real date still renders as one, so the guard is not refusing everything. The string
  // branch and the number branch must agree, which is the property worth pinning.
  assert.equal(display(Date.parse('2026-03-31'), fmt), display('2026-03-31', fmt));
  assert.notEqual(display(Date.parse('2026-03-31'), fmt), String(Date.parse('2026-03-31')));
});
