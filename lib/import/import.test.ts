/**
 * Importing what the desk already has.
 *
 * The fixtures are real files written by openpyxl and python-docx, plus one workbook shaped the way
 * Excel itself writes them — shared strings and cached formula values, which openpyxl does not
 * produce. Both shapes exist in the wild and only one of them was in front of me while writing
 * this, which is exactly the situation that produces a reader that works on the author's file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { evaluateSheet, evaluateWorkbook } from '../sheet/evaluate.ts';
import { readDocx } from './docx.ts';
import { csvToSheet, readUpload, UnsupportedFile } from './index.ts';
import { readWorkbook } from './xlsx.ts';
import { unzip, UnreadableZip } from './zip.ts';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));

// ---- the zip underneath ---------------------------------------------------------------------------

test('a multi-entry zip is read from its central directory', () => {
  const zip = unzip(fixture('model.xlsx'));
  assert.ok(zip.has('xl/workbook.xml'));
  assert.ok(zip.has('xl/worksheets/sheet1.xml'));
  assert.ok(zip.has('xl/worksheets/sheet2.xml'), 'both sheets, not just the first');
});

test('something that is not a zip is refused rather than half-read', () => {
  assert.throws(() => unzip(Buffer.from('not a zip at all, just text')), UnreadableZip);
});

// ---- Excel ------------------------------------------------------------------------------------------

test('a workbook comes in as one document with every tab on it', () => {
  // Importing tab one of four in silence is the loss this system exists to prevent — and so is
  // importing all four as four unrelated documents, which is what this did until tabs existed.
  const sheets = readWorkbook(fixture('model.xlsx'));
  assert.deepEqual(sheets.map((s) => s.name), ['Model', 'Notes']);
});

// ---- tabs that read each other ----------------------------------------------------------------

test('a formula that reaches another tab is kept live, not frozen to its last value', () => {
  // The whole point of the change. `Inputs!B2` could not even be tokenised before, so the importer
  // found every such formula unreadable and wrote the number Excel last showed in its place: a
  // model that had already stopped moving by the time it finished uploading.
  const sheets = readWorkbook(fixture('linked.xlsx'));
  const model = sheets.find((s) => s.name === 'Model')!;

  assert.equal(model.cells['B1'], '=Inputs!B2*(1+Inputs!B1)', 'a reference across tabs survives');
  assert.equal(model.cells['B2'], '=SUM(Inputs!B1:B2)', 'so does a range across tabs');
  assert.equal(model.formulasKept, 3);
  assert.equal(model.formulasFlattened, 0);
});

test('a tab whose name has a space is reachable, quoted', () => {
  const sheets = readWorkbook(fixture('linked.xlsx'));
  const model = sheets.find((s) => s.name === 'Model')!;
  assert.equal(model.cells['B3'], "='Q1 FY26'!A1*2");
  assert.ok(sheets.some((s) => s.name === 'Q1 FY26'));
});

test('an imported workbook computes what Excel was showing, across its tabs', () => {
  const sheets = readWorkbook(fixture('linked.xlsx'));
  const values = evaluateWorkbook({ sheets: sheets.map((s) => ({ name: s.name, cells: s.cells })) });
  const model = values[sheets.findIndex((s) => s.name === 'Model')]!;

  assert.equal(model['B1'], 1120, '1000 x 1.12, read off the Inputs tab');
  assert.equal(model['B2'], 1000.12, '0.12 + 1000, a range on another tab');
  assert.equal(model['B3'], 84, "42 x 2, through a quoted tab name");
});

test('tabs are matched to their grids by relationship id, not by file number', () => {
  // linked.xlsx lists Model first but stores it in sheet2.xml, which is what happens to any
  // workbook whose tabs have ever been dragged. Taking them positionally would put the Inputs
  // numbers under the name Model — and since a reference resolves BY name, every cross-sheet
  // formula in the workbook would then quietly read the wrong tab.
  const sheets = readWorkbook(fixture('linked.xlsx'));
  const inputs = sheets.find((s) => s.name === 'Inputs')!;
  assert.equal(inputs.cells['A1'], 'Growth');
  assert.equal(inputs.cells['B2'], '1000');
  assert.equal(sheets.find((s) => s.name === 'Model')!.cells['A1'], 'Revenue');
});

test('text, numbers and formulas each arrive as themselves', () => {
  const [model] = readWorkbook(fixture('model.xlsx'));
  assert.equal(model!.cells['A2'], 'Revenue');
  assert.equal(model!.cells['B2'], '2585.94');
  assert.equal(model!.cells['B4'], '=B2-B3', 'the arithmetic survives, which is the point');
  assert.equal(model!.cells['B6'], 'He said "buy"', 'quotes in text are not an escape');
});

test('an imported model still computes', () => {
  const [model] = readWorkbook(fixture('model.xlsx'));
  const v = evaluateSheet({ cells: model!.cells });
  assert.equal(v['B4'], 185.84000000000015, '2585.94 - 2400.10');
  assert.ok(typeof v['B5'] === 'number' && Math.abs(v['B5'] - 0.0718655) < 1e-6);
});

test('a date is a date, not the number Excel stores it as', () => {
  // 46112 is either the 31st of March 2026 or forty-six thousand; only the cell's style says which.
  const [model] = readWorkbook(fixture('model.xlsx'));
  assert.equal(model!.cells['B7'], '2026-03-31');
});

test('a sparse cell far past the used block still arrives', () => {
  const [model] = readWorkbook(fixture('model.xlsx'));
  assert.equal(model!.cells['A20'], 'far away');
});

test('shared strings and rich text, which is how Excel itself writes a file', () => {
  const [sheet] = readWorkbook(fixture('excel-style.xlsx'));
  assert.equal(sheet!.cells['A1'], 'Revenue', 'resolved through the shared string table');
  assert.equal(sheet!.cells['B1'], 'Rich text', 'runs joined with their spacing intact');
});

test('a formula this engine cannot read keeps the value Excel showed', () => {
  // VLOOKUP across another sheet. Kept as a formula it would be #NAME? across the model; kept as
  // its last value it is true as of the save, and inert rather than loudly broken.
  const [sheet] = readWorkbook(fixture('excel-style.xlsx'));
  assert.equal(sheet!.cells['B3'], '99.5');
  assert.ok(!sheet!.cells['B3']!.startsWith('='));
});

test('a formula whose answer disagrees with Excel’s is not kept', () => {
  // The check that matters. SUM(C1:C9) parses here and evaluates to 0, because column C came in
  // empty — while the workbook was showing 1234.5. Keeping the formula would silently replace a
  // number somebody has been looking at, so the number wins and the formula is dropped.
  const [sheet] = readWorkbook(fixture('excel-style.xlsx'));
  assert.equal(sheet!.cells['B2'], '1234.5');
  assert.equal(sheet!.formulasFlattened, 2);
  assert.equal(sheet!.formulasKept, 0);
});

// ---- Word --------------------------------------------------------------------------------------------

test('a Word document keeps the structure that carries meaning', () => {
  const text = readDocx(fixture('note.docx'));
  assert.match(text, /^# Praj — first look/, 'a heading is a heading');
  assert.match(text, /- Order book conversion/, 'a list item is a list item');
  assert.match(text, /FY26 revenue\t3167\.88/, 'a table keeps which number belonged to which row');
});

// ---- everything else ------------------------------------------------------------------------------------

test('a CSV becomes a grid, headings in row one', () => {
  const s = csvToSheet('Year,Revenue\n2025,2585.94\n2026,3167.88\n', 'export');
  assert.equal(s.cells['A1'], 'Year');
  assert.equal(s.cells['B2'], '2585.94');
  assert.equal(s.cells['A3'], '2026');
});

test('two columns sharing a heading both survive the import', () => {
  // The grid used to be built from a Record keyed by heading, so the second Total overwrote the
  // first and the sheet came back a column short — silently, under a real filename.
  const s = csvToSheet('Year,Total,Total\n2026,10,20\n', 'export');
  assert.equal(s.cells['B1'], 'Total');
  assert.equal(s.cells['C1'], 'Total');
  assert.equal(s.cells['B2'], '10');
  assert.equal(s.cells['C2'], '20');
});

test('a quoted line break inside a cell does not become another row', () => {
  const s = csvToSheet('Name,Note\nPRAJIND,"Pune,\nIndia"\n', 'export');
  assert.equal(s.cells['B2'], 'Pune,\nIndia');
  assert.equal(s.cells['A3'], undefined, 'the quoted newline is content, not a row break');
});

test('a CSV cell beginning with = is text, not a formula', () => {
  // The oldest spreadsheet attack there is, and this system would happily evaluate it. A CSV is
  // data that arrived from somewhere else; nothing in it gets to be code.
  const s = csvToSheet('a\n=1+1\n', 'x');
  assert.equal(s.cells['A2'], "'=1+1");
  assert.notEqual(evaluateSheet({ cells: s.cells })['A2'], 2);
});

test('the format is decided by the bytes, not by the name', async () => {
  // A workbook saved as .txt is still a workbook, and reading it as text would produce a page of
  // zip noise under a title that promised a document.
  const r = await readUpload('mislabelled.txt', fixture('model.xlsx'));
  assert.equal(r.kind, 'sheet');
});

test('a file this cannot read says so instead of importing noise', async () => {
  const binary = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
  await assert.rejects(() => readUpload('mystery.bin', binary), UnsupportedFile);
  await assert.rejects(() => readUpload('empty.txt', Buffer.alloc(0)), UnsupportedFile);
});

test('plain text comes in as a note', async () => {
  const r = await readUpload('thoughts.md', Buffer.from('# Praj\n\nSomething I thought.\n'));
  assert.equal(r.kind, 'note');
  assert.match(r.kind === 'note' ? r.text : '', /Something I thought/);
});
