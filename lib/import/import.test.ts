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

import { zip as writeZip } from '../export/zip.ts';
import { evaluateSheet, evaluateWorkbook } from '../sheet/evaluate.ts';
import { readDocx, UnreadableDocument } from './docx.ts';
import { csvToSheet, readUpload, UnsupportedFile } from './index.ts';
import { readWorkbook } from './xlsx.ts';
import { unzip, unzipListing, UnreadableZip } from './zip.ts';

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

/**
 * An archive that claims more than it carries, which is the shape of every zip bomb.
 *
 * The caps are read off the central directory, because that is the only place they can be read
 * *before* the allocation they exist to prevent. So a fixture that overstates its sizes is the
 * honest test of them, and it costs a few hundred bytes to build rather than the megabytes it
 * claims.
 */
function claiming(buf: Buffer, bytesPerEntry: number): Buffer {
  const out = Buffer.from(buf);
  const eocd = out.length - 22;
  let at = out.readUInt32LE(eocd + 16);
  for (let left = out.readUInt16LE(eocd + 10); left > 0; left--) {
    out.writeUInt32LE(bytesPerEntry, at + 24);
    at += 46 + out.readUInt16LE(at + 28) + out.readUInt16LE(at + 30) + out.readUInt16LE(at + 32);
  }
  return out;
}

test('an archive with more entries than any document has parts is refused', () => {
  // note.docx — a real Word file with an embedded image — holds 17 parts and model.xlsx holds 10,
  // so five thousand is not a document. Left uncapped this returned a Map of five thousand
  // Buffers, which is the cheap half of the same footgun the range bomb was: nobody attacks this
  // box, but a malformed archive should not be able to spend all of it.
  const many = writeZip(Array.from({ length: 5_000 }, (_, i) => ({
    name: `part${i}.txt`,
    body: Buffer.from('x'),
  })));
  assert.throws(() => unzip(many), (err: unknown) => {
    assert.ok(err instanceof UnreadableZip);
    // "More than", not the real count: the cap is checked per entry as fflate walks the
    // directory, so the refusal happens on the 4,097th and the total is never counted.
    assert.match(err.message, /more than 4,096 entries/, 'the refusal names the ceiling');
    return true;
  });
});

test('one entry claiming more than a document could hold is refused before it inflates', () => {
  const bomb = claiming(writeZip([{ name: 'report.pdf', body: Buffer.from('x') }]), 200 * 1024 * 1024);
  assert.throws(() => unzip(bomb), (err: unknown) => {
    assert.ok(err instanceof UnreadableZip);
    assert.match(err.message, /report\.pdf/, 'names the entry, because one of them is the problem');
    assert.match(err.message, /64 MB/);
    return true;
  });
  // The index still reads. The cap is on what gets inflated, not on what the archive says it
  // holds — which is what keeps `unzipListing` able to weigh an annual report against its cover
  // page without inflating either.
  assert.deepEqual(unzipListing(bomb), [{ name: 'report.pdf', bytes: 200 * 1024 * 1024 }]);
});

test('entries each small enough but together past the ceiling are refused', () => {
  // Eight members of 20MB: every one of them under the per-entry cap, and 160MB of Buffers on a
  // 2GB box if they all come out.
  const parts = writeZip(Array.from({ length: 8 }, (_, i) => ({
    name: `part${i}.bin`,
    body: Buffer.from('x'),
  })));
  assert.throws(() => unzip(claiming(parts, 20 * 1024 * 1024)), (err: unknown) => {
    assert.ok(err instanceof UnreadableZip);
    assert.match(err.message, /128 MB/, 'the total, not the entry, is what this one trips');
    return true;
  });
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

test('a formula that only disagrees because its input did is kept, not frozen', () => {
  // stale-chain.xlsx, shaped the way Excel writes one. `Inputs!B1` is `=SUM(C1:C9)` showing 1000
  // with column C empty, so this engine gets 0 and Excel's number wins — that one is a genuine
  // disagreement. `Model!B1` is `=Inputs!B1*2` showing 2000, and this engine got that wrong too,
  // but only because it read B1 while B1 was still the formula about to be replaced. Judged once,
  // against the grid as it stood before any substitution, it was frozen to 2000 as well: a model
  // stopped moving one cell further down than it had to, on the tab that was not the problem.
  const sheets = readWorkbook(fixture('stale-chain.xlsx'));
  const inputs = sheets.find((s) => s.name === 'Inputs')!;
  const model = sheets.find((s) => s.name === 'Model')!;

  assert.equal(inputs.cells['B1'], '1000', "the disagreement at the root takes Excel's number");
  assert.equal(model.cells['B1'], '=Inputs!B1*2', 'the cell reading it agrees once it settles, so it lives');
  assert.equal(model.formulasKept, 1);
  assert.equal(model.formulasFlattened, 0);
  assert.equal(inputs.formulasFlattened, 2, 'both of the tab that was wrong, and neither of the tab that was not');
});

test('a formula that agreed only against a stale input is not kept', () => {
  // The same bug the other way round, and the dangerous direction. `Inputs!B2` is `=B1*0.5`
  // showing 0, and against the unresolved B1 — which was evaluating to 0 — it agreed exactly, so
  // it was kept. Once B1 became 1000 the imported tab computed 500 where the author had been
  // looking at 0: a figure changed by the import, in silence, which is the one thing the
  // agreement check exists to prevent.
  const sheets = readWorkbook(fixture('stale-chain.xlsx'));
  const inputs = sheets.findIndex((s) => s.name === 'Inputs');
  assert.equal(sheets[inputs]!.cells['B2'], '0');

  const values = evaluateWorkbook({ sheets: sheets.map((s) => ({ name: s.name, cells: s.cells })) });
  const model = sheets.findIndex((s) => s.name === 'Model');
  assert.deepEqual(
    [values[inputs]!['B1'], values[inputs]!['B2'], values[model]!['B1']],
    [1000, 0, 2000],
    'the imported workbook computes what Excel was showing, in every cell of the chain',
  );
});

// ---- Word --------------------------------------------------------------------------------------------

test('a Word document keeps the structure that carries meaning', () => {
  const text = readDocx(fixture('note.docx'));
  assert.match(text, /^# Praj — first look/, 'a heading is a heading');
  assert.match(text, /- Order book conversion/, 'a list item is a list item');
  assert.match(text, /FY26 revenue\t3167\.88/, 'a table keeps which number belonged to which row');
});

test('a document with no text layer is refused, not imported as a blank note', async () => {
  // image-only.docx is one scanned page in a `w:drawing` and not a `w:t` anywhere — which is how
  // a physical document reaches this desk. `readDocx` returned '' for it, so the import wrote a
  // note with a real title and nothing under it, and the emptiness read as the author's rather
  // than as the reader's. It is the rule `pdfToText` already applies one file over, and the rule
  // every job here applies to a feed: producing nothing is a failure, not a quiet day.
  assert.throws(() => readDocx(fixture('image-only.docx')), UnreadableDocument);
  // And it survives `readUpload`'s try-the-other-format fallback, which used to answer for an
  // image-only Word file with "No xl/workbook.xml — this is not a spreadsheet."
  await assert.rejects(() => readUpload('scan.docx', fixture('image-only.docx')), UnreadableDocument);
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

test('a file with a NUL in it is binary, whatever it decodes to', async () => {
  // The only check was the ratio of U+FFFD replacement characters, and a run of NUL bytes
  // produces none of those — `Buffer.alloc(64).toString('utf8')` is 64 valid characters. So a
  // binary file imported as a note: measured before the fix, 64 NULs straight into a document
  // body.
  //
  // That body is what `/api/export/[id]` renders into a `.docx`, and XML 1.0 cannot carry a NUL
  // at all, so the export came back as a file Word refuses to open with "unreadable content".
  // The writer now strips them; this stops them arriving. A NUL is the same signal `grep` uses
  // to call a file binary, and for the same reason: text does not contain one.
  const NUL = String.fromCharCode(0);
  await assert.rejects(
    () => readUpload('x.bin', Buffer.alloc(64)),
    UnsupportedFile,
    'a file of NUL bytes is not a document',
  );
  await assert.rejects(
    () => readUpload('notes.txt', Buffer.concat([Buffer.from('Report '), Buffer.alloc(40)])),
    UnsupportedFile,
    'nor is one that starts out looking like text',
  );

  // Text still imports, including the three control characters that legitimately appear in it.
  const ok = await readUpload('notes.txt', Buffer.from('Line one\tcolumn\r\nLine two\n'));
  assert.equal(ok.kind, 'note');
  assert.ok(ok.kind === 'note' && ok.text.includes('Line two'));
  assert.ok(!(ok.kind === 'note' && ok.text.includes(NUL)));
});

test('a workbook named .docx is read as a workbook, which is what the comment promises', async () => {
  // "Both Office formats are zips; which one is decided by what is inside, not by the extension."
  // It was decided by the extension: `ext === 'docx'` went straight to `readDocx`, and only an
  // unrecognised extension got the try-the-other-one fallback that was sitting right below it.
  // A renamed file should not lie — the same rule `lib/workspace.ts` states when it sniffs an
  // upload's magic number rather than trusting its name.
  const out = await readUpload('model.docx', fixture('model.xlsx'));
  assert.equal(out.kind, 'sheet', 'read as what it is, not as what it is called');
});
