/**
 * Cell addresses.
 *
 * `A1` style, because it is what everybody who has ever used a spreadsheet already knows and there
 * is nothing to gain by being different. Columns are base-26 in letters, which is not quite base-26
 * in digits: there is no zero, so `Z` is 26 and `AA` is 27 rather than 26. Getting that wrong shows
 * up only at the 27th column, which is exactly the sort of thing a model reaches on a Tuesday.
 */

/** `0 -> A`, `25 -> Z`, `26 -> AA`. */
export function columnName(index: number): string {
  let n = index;
  let out = '';
  while (n >= 0) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

/** `A -> 0`, `Z -> 25`, `AA -> 26`. Null for anything that is not column letters. */
export function columnIndex(name: string): number | null {
  if (!/^[A-Z]+$/.test(name)) return null;
  let n = 0;
  for (const ch of name) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export interface CellRef {
  col: number;
  row: number;
}

const REF = /^([A-Z]+)([1-9][0-9]*)$/;

/** `B7` -> `{col: 1, row: 6}`. Rows are 1-based to a person and 0-based here. */
export function parseRef(text: string): CellRef | null {
  const m = REF.exec(text.toUpperCase().replace(/\$/g, ''));
  if (!m) return null;
  const col = columnIndex(m[1]!);
  if (col === null) return null;
  return { col, row: Number(m[2]) - 1 };
}

export const refName = (ref: CellRef): string => `${columnName(ref.col)}${ref.row + 1}`;

/**
 * How many cells a rectangle covers, without building it.
 *
 * `REF` puts no ceiling on either part — `/^([A-Z]+)([1-9][0-9]*)$/` — so `A1:ZZZ9999999` parses
 * as happily as `A1:B3`. Formulas are evaluated on the server, so asking the size first is what
 * stops a typed range from being answered with an allocation instead of a value.
 */
export const rangeSize = (a: CellRef, b: CellRef): number =>
  (Math.abs(a.row - b.row) + 1) * (Math.abs(a.col - b.col) + 1);

/**
 * The ceiling on a range, in cells.
 *
 * Comfortably past any real model on this desk — a full 400-row sheet 60 columns wide is 24,000 —
 * and far below the point where materialising the rectangle costs anything worth noticing.
 */
export const MAX_RANGE_CELLS = 250_000;

/** The top-left of a rectangle, without building the rest of it. */
export const rangeHead = (a: CellRef, b: CellRef): CellRef =>
  ({ col: Math.min(a.col, b.col), row: Math.min(a.row, b.row) });

/**
 * Every address in a rectangle, in reading order.
 *
 * Normalised, so `B3:A1` means the same rectangle as `A1:B3`. A person dragging a selection
 * upwards produces the first and means the second.
 *
 * Empty past `MAX_RANGE_CELLS`, so a mistyped range cannot allocate its way through the heap.
 * Callers that can report an error should ask `rangeSize` first and say so — `evaluate.ts` does —
 * because an empty list is indistinguishable from a range that genuinely holds nothing.
 */
export function expandRange(a: CellRef, b: CellRef): CellRef[] {
  if (rangeSize(a, b) > MAX_RANGE_CELLS) return [];
  const out: CellRef[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) {
      out.push({ col, row });
    }
  }
  return out;
}
