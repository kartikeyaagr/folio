/**
 * A spreadsheet document's body, which holds tabs.
 *
 * **One workbook is one document.** It was not always: an imported `.xlsx` used to become one
 * document per tab, so a model whose assumptions sat on `Inputs` and whose output sat on `Model`
 * arrived as two unrelated documents with no way to reference each other — and the importer, being
 * honest about that, replaced every `=Inputs!B4` with the number Excel last showed. The model
 * stopped moving on the way in, which is the one thing importing was for.
 *
 * **Two body shapes, one reader.** Bodies written before this are `{cells}`, a single unnamed grid,
 * and there are real ones in the table. They are read here as a one-tab workbook rather than
 * migrated: a `document_versions` row is a historical record of what somebody saved, and rewriting
 * one to suit a later shape would make the version history say something that did not happen.
 * Everything *written* from now on is `{sheets}`.
 */

import type { Grid } from './evaluate.ts';
import {
  clampCol, clampRow, isEmpty, readFormats, readSizes, type Formats, type Sizes,
} from './format.ts';

export type { Grid };

/**
 * A tab as a document holds one: the grid the evaluator reads, plus how it is shown.
 *
 * `Tab extends Grid`, so anything that only wants values — `evaluateWorkbook`, `lookupsFor`,
 * `lib/retrieval/`'s chunker — takes one without knowing formats exist. That is the point: a format
 * has no way to reach the figures, because the code that reads the figures cannot see it.
 */
export interface Tab extends Grid {
  formats: Formats;
  /** Column widths a person dragged, by column index. Absent means the automatic width applies. */
  cols: Sizes;
  /** Row heights a person dragged, by row index. Absent means the row sizes itself to its content. */
  rows: Sizes;
}

/**
 * A tab as it is **stored**, where `formats` is absent rather than empty.
 *
 * The distinction is small and load-bearing: `sheetsOf` always hands back a `Tab` with a `formats`
 * object so no caller has to guard, while `bodyOf` writes the key only when there is something in
 * it. A workbook nobody has formatted therefore stores exactly the bytes it stored before
 * formatting existed, and the version history stays a record of the numbers changing.
 */
export type StoredTab = Grid & { formats?: Formats; cols?: Sizes; rows?: Sizes };

/** What Excel calls the first tab of a new workbook, and what a body with no name gets. */
export const DEFAULT_SHEET_NAME = 'Sheet1';

/** Excel's own rule, and ours for the same reason: these break a reference that names the tab. */
const FORBIDDEN = /[[\]:\\/?*]/g;
const MAX_NAME = 31;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Cells, keeping only the string values a grid can actually hold. */
function cellsOf(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [ref, raw] of Object.entries(v)) {
    if (typeof raw === 'string') out[ref] = raw;
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[ref] = String(raw);
  }
  return out;
}

/**
 * A tab name that can be stored, shown, and written into a formula.
 *
 * Silently corrected rather than refused. A name arrives from a workbook somebody else built, and
 * refusing the import over a colon in a tab title would be the system declining to do its job over
 * a detail its own reference grammar invented.
 */
export function cleanName(desired: string): string {
  const clean = desired.replace(FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return clean === '' ? DEFAULT_SHEET_NAME : clean;
}

/**
 * A name no other tab is using.
 *
 * Case-insensitively, because that is how `evaluateWorkbook` resolves one: two tabs differing only
 * in case would make `=model!B4` mean whichever came first, which is not a thing anybody intends.
 */
export function uniqueName(desired: string, taken: readonly string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  const base = cleanName(desired);
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const tried = `${base.slice(0, MAX_NAME - suffix.length)}${suffix}`;
    if (!used.has(tried.toLowerCase())) return tried;
  }
}

/**
 * Read a document body as tabs.
 *
 * Always at least one tab: a spreadsheet with no grid at all is not a state the editor can render
 * or a person can act on, and inventing the empty first tab here is cheaper than every caller
 * checking. A body that is neither shape — a note's `{text}`, an agent draft — reads as one empty
 * tab too, and `isSheetBody` is how a caller asks whether it was a spreadsheet in the first place.
 */
export function sheetsOf(body: unknown): Tab[] {
  const one = (cells: Record<string, string>): Tab[] =>
    [{ name: DEFAULT_SHEET_NAME, cells, formats: {}, cols: {}, rows: {} }];
  if (!isRecord(body)) return one({});

  const raw = body['sheets'];
  if (Array.isArray(raw)) {
    const out: Tab[] = [];
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      const name = typeof entry['name'] === 'string' ? entry['name'] : '';
      out.push({
        name: uniqueName(name, out.map((s) => s.name)),
        cells: cellsOf(entry['cells']),
        formats: readFormats(entry['formats']),
        cols: readSizes(entry['cols'], clampCol),
        rows: readSizes(entry['rows'], clampRow),
      });
    }
    return out.length > 0 ? out : one({});
  }

  // The shape every sheet saved before tabs existed still has. Read, never rewritten.
  if ('cells' in body) return one(cellsOf(body['cells']));
  return one({});
}

/** Whether a body is a spreadsheet's, in either shape. Mirrors `SHEET_BODY_SQL`. */
export function isSheetBody(body: unknown): boolean {
  return isRecord(body) && (Array.isArray(body['sheets']) || isRecord(body['cells']));
}

/**
 * The same question, in SQL.
 *
 * `lib/retrieval/register.ts` decides how to hash a version without deserialising its body, so the
 * test for "is this a spreadsheet" exists twice and the two must agree. It lives here, beside the
 * reader it mirrors, so that a third body shape cannot be added to one and forgotten in the other —
 * a body that fails the SQL test is hashed and indexed as raw JSON, which looks like a working
 * index right up until somebody searches for a figure that is in it.
 */
export const SHEET_BODY_SQL = (body: string): string =>
  `(jsonb_exists(${body}, 'cells') OR jsonb_exists(${body}, 'sheets'))`;

/**
 * The body to store. The only writer of the shape, so the shape has one definition.
 *
 * `formats` is written only when a tab has any, so a workbook nobody has formatted stores exactly
 * what it stored before formatting existed — which keeps the diff in the version history about the
 * numbers rather than about an empty object appearing on every save.
 */
export function bodyOf(sheets: readonly Partial<Tab>[]): { sheets: StoredTab[] } {
  const out: StoredTab[] = [];
  for (const s of sheets) {
    const formats = Object.fromEntries(
      Object.entries(s.formats ?? {}).filter(([, f]) => !isEmpty(f)),
    );
    out.push({
      name: uniqueName(s.name ?? '', out.map((o) => o.name)),
      cells: s.cells ?? {},
      ...(Object.keys(formats).length > 0 ? { formats } : {}),
      ...(Object.keys(s.cols ?? {}).length > 0 ? { cols: s.cols } : {}),
      ...(Object.keys(s.rows ?? {}).length > 0 ? { rows: s.rows } : {}),
    });
  }
  // The same shape as an unformatted tab above — one representation of "nothing is formatted",
  // not two that a diff of the version history would report as a change.
  return { sheets: out.length > 0 ? out : [{ name: DEFAULT_SHEET_NAME, cells: {} }] };
}
