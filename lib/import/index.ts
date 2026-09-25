/**
 * Bringing in what the desk already has.
 *
 * Five formats, chosen because they are what a fund's shared drive actually holds: Excel workbooks,
 * Word documents, PDFs, CSVs and plain text. Each becomes the same thing it would have been if it
 * had been written here — a grid or a note — versioned and attributed from its first save.
 *
 * **Decided by content, not by name.** A `.xlsx` renamed `.txt` is still a workbook, and a file
 * whose extension lies would otherwise be imported as a page of binary. The extension is the
 * tie-breaker where the bytes do not say.
 */

import { extractText, getDocumentProxy } from 'unpdf';

import { parseCsvRows } from '../ingest/nse.ts';
import { columnName } from '../sheet/cells.ts';
import { readDocx, UnreadableDocument } from './docx.ts';
import { readWorkbook, UnreadableWorkbook, type ImportedSheet } from './xlsx.ts';

export class UnsupportedFile extends Error {}
export { UnreadableDocument, UnreadableWorkbook };
export type { ImportedSheet };

/** What one uploaded file became. A workbook is several documents; everything else is one. */
export type Imported =
  | { kind: 'sheet'; sheets: ImportedSheet[] }
  | { kind: 'note'; text: string };

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const PDF = Buffer.from('%PDF-');

const extensionOf = (name: string): string => {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
};

/**
 * A CSV becomes a grid, because that is what it is: rows of cells somebody exported from one.
 *
 * Positionally, via `parseCsvRows`. Routing through the keyed form was the first cut and it lost
 * columns: a workbook exported with two columns called `Total` collapsed to one, because the keyed
 * form is a `Record` and the second write wins. In a grid a column's position is its identity.
 */
export function csvToSheet(text: string, name: string): ImportedSheet {
  const cells: Record<string, string> = {};
  parseCsvRows(text).forEach((row, r) => {
    row.forEach((v, c) => {
      if (v !== '') cells[`${columnName(c)}${r + 1}`] = v;
    });
  });
  // Never a formula. A CSV cell beginning with "=" is the oldest spreadsheet attack there is, and
  // this system would happily evaluate it — so an imported CSV holds text, exactly as it arrived.
  for (const [ref, v] of Object.entries(cells)) {
    if (v.startsWith('=')) cells[ref] = `'${v}`;
  }
  return { name, cells, formulasKept: 0, formulasFlattened: 0 };
}

async function pdfToText(bytes: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  const merged = (Array.isArray(text) ? text.join('\n') : text).trim();
  if (merged.length === 0) {
    // The same rule `lib/ingest/extract.ts` applies to filings: a scan is not an empty document,
    // and importing it as one would put a blank note on the record under a real title.
    throw new UnsupportedFile(
      'This PDF has no text layer — it is probably a scan, and would import as a blank note.',
    );
  }
  return merged;
}

/**
 * Read one uploaded file.
 *
 * Throws with a sentence a person can act on rather than returning an empty document: an import
 * that silently produces nothing is worse than one that refuses, because the refusal can be
 * answered and the blank page cannot.
 */
export async function readUpload(filename: string, bytes: Buffer): Promise<Imported> {
  const ext = extensionOf(filename);
  const base = filename.replace(/\.[^.]+$/, '') || filename;

  if (bytes.length === 0) throw new UnsupportedFile('That file is empty.');

  // Both Office formats are zips; which one is decided by what is inside, not by the extension.
  //
  // It was decided by the extension until 21-Sep-2026: `.docx` went straight to `readDocx` and
  // `.xlsx` straight to `readWorkbook`, and only an unrecognised name reached the try-the-other
  // fallback sitting directly below them. So the sentence above was true of `mislabelled.txt`
  // and false of the two names anybody actually uses. The extension is a hint about which reader
  // to try first — it usually is right, and trying the right one first is cheaper — and the
  // bytes decide. Same rule `lib/workspace.ts` states when it sniffs an upload's magic number
  // rather than trusting its name: a renamed file should not lie.
  if (bytes.subarray(0, 4).equals(ZIP)) {
    const asNote = (): Imported => ({ kind: 'note', text: readDocx(bytes) });
    const asSheet = (): Imported => ({ kind: 'sheet', sheets: readWorkbook(bytes) });
    const [first, second] = ext === 'docx' ? [asNote, asSheet] : [asSheet, asNote];
    try {
      return first();
    } catch (err) {
      // When neither reader can read it, the *first* refusal is the one to raise. The extension
      // said which format the file claims to be, so that reader's sentence is the one naming the
      // real problem: an image-only `.docx` has no text layer, and reporting it as
      // "No xl/workbook.xml — this is not a spreadsheet" is true of it and useless to anybody.
      try {
        return second();
      } catch {
        throw err;
      }
    }
  }

  if (bytes.subarray(0, 5).equals(PDF)) return { kind: 'note', text: await pdfToText(bytes) };

  const text = bytes.toString('utf8');
  // A NUL means binary, and nothing else does it as reliably.
  //
  // The replacement-ratio test below catches a file of high bytes, because those are invalid
  // UTF-8. It catches nothing at all in a file of zeros: `Buffer.alloc(64).toString('utf8')` is
  // sixty-four perfectly valid characters and not one replacement, so a binary file imported as
  // a note — measured, sixty-four NULs straight into a document body.
  //
  // Which then broke the way out: that body is what `/api/export/[id]` renders into a `.docx`,
  // and XML 1.0 cannot carry a NUL at any depth, so the export came back as a file Word refuses
  // with "unreadable content" and no explanation. The writer strips them now; this stops them
  // arriving. It is the same signal `grep` uses to call a file binary, for the same reason.
  if (text.includes('\u0000')) {
    throw new UnsupportedFile(
      `${filename} looks like a binary file rather than a document.`,
    );
  }

  // A binary file read as UTF-8 is mostly replacement characters; importing it would produce a
  // page of noise under a title that promised a document.
  const replacementRatio = (text.match(/�/g)?.length ?? 0) / Math.max(1, text.length);
  if (replacementRatio > 0.02) {
    throw new UnsupportedFile(
      `${filename} is not a format this reads. Excel, Word, PDF, CSV and plain text come in.`,
    );
  }

  if (ext === 'csv' || ext === 'tsv') return { kind: 'sheet', sheets: [csvToSheet(text, base)] };
  return { kind: 'note', text };
}

/** What a person is told they can bring, in the file picker and in the prose beside it. */
export const ACCEPTED = '.xlsx,.xlsm,.csv,.tsv,.docx,.pdf,.txt,.md';

/**
 * The largest file an import takes, in bytes.
 *
 * 32MB, not 12. A DRHP runs 300-500 pages with embedded images — the two this desk actually needs
 * are 7 and 11MB — and the largest annual report in the corpus is 21.4MB. Of 969 real attachments
 * only 6 exceed 12MB, so this is not a licence for junk; it is the difference between the import
 * path working for the documents it exists to accept and silently refusing them.
 *
 * Here rather than beside `importFileAction` because a `'use server'` file may export only async
 * functions, and `next.config.ts`'s `bodySizeLimit` has to stay above it — `limits.test.ts`
 * holds the two in order.
 */
export const MAX_UPLOAD = 32 * 1024 * 1024;
