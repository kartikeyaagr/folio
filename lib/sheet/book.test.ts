/**
 * The workbook body codec.
 *
 * What is pinned here is mostly backwards compatibility. There are `{cells}` bodies in
 * `document_versions` written before a document could hold tabs, and nothing rewrites them — a
 * version row is the record of what somebody saved. So every one of them has to keep reading, and
 * has to keep rendering to the same text, or `lib/retrieval/` re-chunks the corpus for no reason
 * and every stored citation offset moves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bodyOf, cleanName, isSheetBody, sheetsOf, uniqueName, DEFAULT_SHEET_NAME } from './book.ts';
import { MAX_COL } from './format.ts';

test('a body saved before tabs existed reads back as one tab', () => {
  const sheets = sheetsOf({ cells: { A1: 'Revenue', B1: '693.2' } });
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0]!.name, DEFAULT_SHEET_NAME);
  assert.deepEqual(sheets[0]!.cells, { A1: 'Revenue', B1: '693.2' });
});

test('a workbook body round-trips through the writer and the reader', () => {
  const book = bodyOf([
    { name: 'Inputs', cells: { B1: '0.12' } },
    { name: 'Model', cells: { B1: '=Inputs!B1' } },
  ]);
  assert.deepEqual(sheetsOf(book).map((s) => s.name), ['Inputs', 'Model']);
  assert.equal(sheetsOf(book)[1]!.cells['B1'], '=Inputs!B1');
});

test('there is always at least one tab', () => {
  // A workbook with no grid is not a state the editor can render or a person can act on.
  for (const body of [{}, { sheets: [] }, { text: 'a note' }, null, 'nonsense']) {
    assert.equal(sheetsOf(body).length, 1, `${JSON.stringify(body)} should read as one empty tab`);
  }
  assert.deepEqual(bodyOf([]).sheets, [{ name: DEFAULT_SHEET_NAME, cells: {} }]);
});

test('whether a body is a spreadsheet is a question about its shape, not its kind', () => {
  // The same question `SHEET_BODY_SQL` asks in SQL. The two must agree: a body the SQL fails to
  // recognise is hashed as prose and indexed as raw JSON, which looks exactly like a working index.
  assert.equal(isSheetBody({ cells: {} }), true, 'the shape written before tabs existed');
  assert.equal(isSheetBody({ sheets: [] }), true);
  assert.equal(isSheetBody({ text: 'a note' }), false);
  assert.equal(isSheetBody({}), false);
  assert.equal(isSheetBody(null), false);
});

test('a name that a reference could not address is corrected rather than refused', () => {
  // The characters are Excel's own rule. Refusing an import over a colon in a tab title would be
  // this system declining to do its job over a detail its own grammar invented.
  assert.equal(cleanName('Q1:FY26'), 'Q1 FY26');
  assert.equal(cleanName('  spaced   out  '), 'spaced out');
  assert.equal(cleanName(''), DEFAULT_SHEET_NAME);
  assert.equal(cleanName('x'.repeat(50)).length, 31);
});

test('two tabs never share a name, however they were capitalised', () => {
  // `evaluateWorkbook` resolves a tab by lower-cased name, so a duplicate would make `=model!B4`
  // mean whichever came first — which is not a thing anybody intends.
  assert.equal(uniqueName('Model', ['Model']), 'Model (2)');
  assert.equal(uniqueName('model', ['Model']), 'model (2)');
  assert.equal(uniqueName('Model', ['Model', 'Model (2)']), 'Model (3)');
  assert.equal(uniqueName('Model', ['Inputs']), 'Model');
  assert.deepEqual(
    bodyOf([{ name: 'Model', cells: {} }, { name: 'MODEL', cells: {} }]).sheets.map((s) => s.name),
    ['Model', 'MODEL (2)'],
  );
});

test('a cell that is not text is read as text, and one that is neither is dropped', () => {
  // A body is JSON somebody else may have written. The grid holds strings.
  const cells = sheetsOf({ sheets: [{ name: 'S', cells: { A1: 5, A2: true, A3: null, A4: 'x' } }] })[0]!.cells;
  assert.deepEqual(cells, { A1: '5', A2: 'true', A4: 'x' });
});

test('sizes set by hand round-trip, and are clamped on the way back in', () => {
  const body = bodyOf([{ name: 'Model', cells: {}, formats: {}, cols: { '0': 240 }, rows: { '2': 68 } }]);
  const back = sheetsOf(body);
  assert.deepEqual(back[0]!.cols, { '0': 240 });
  assert.deepEqual(back[0]!.rows, { '2': 68 });

  // A body carrying a width from somewhere else is brought inside the bounds rather than trusted.
  assert.deepEqual(sheetsOf({ sheets: [{ name: 'M', cells: {}, cols: { '0': 5000 } }] })[0]!.cols, {
    '0': MAX_COL,
  });
});

test('a workbook nobody has resized stores no sizes at all', () => {
  // Same rule as formats: the keys appear only when there is something in them, so a sheet nobody
  // has touched stores the bytes it stored before any of this existed.
  const body = bodyOf([{ name: 'Model', cells: { A1: '1' }, formats: {}, cols: {}, rows: {} }]);
  assert.deepEqual(body.sheets[0], { name: 'Model', cells: { A1: '1' } });
});
