/**
 * What a cell can hold, and how one kind of value becomes another.
 *
 * Split out of `./evaluate.ts`, which now walks a whole workbook rather than one grid and needed
 * the room. The division is by job rather than by size: this file knows what a value *is*,
 * `./functions.ts` knows what the built-in functions do with one, and `./evaluate.ts` knows how to
 * get from an address to a value. `./evaluate.ts` re-exports everything here, so nothing outside
 * `lib/sheet/` has to know the split happened.
 *
 * Errors are values, as they are in every spreadsheet: a cell that cannot be worked out holds
 * `#DIV/0!` and the cells referring to it hold the same, so a mistake is visible where it happened
 * and where it spread. **`#N/A` is the important one** — it is what a data function returns when
 * this system has no figure, and it is deliberately not zero. A model whose missing revenue reads
 * as zero produces a margin, a growth rate and a valuation, all of them wrong and none of them
 * marked. That is the same argument `<Blank>` makes on every screen here.
 */

export type Value = number | string | boolean | CellError;

/**
 * A cell that could not be worked out.
 *
 * A plain object, not a class. A class instance cannot cross from a server component into a client
 * one — React refuses it with "Classes or null prototypes are not supported" — and the grid is a
 * client component handed its resolved figures by the server. Errors are values here in every
 * sense, this one included.
 */
export interface CellError {
  readonly err: string;
  readonly detail: string;
}

export const isCellError = (v: unknown): v is CellError =>
  typeof v === 'object' && v !== null && 'err' in v && 'detail' in v;

const cellError = (err: string, detail: string): CellError => ({ err, detail });

export const NA = (detail: string) => cellError('#N/A', detail);
export const DIV0 = () => cellError('#DIV/0!', 'divided by zero');
export const CYCLE = (at: string) => cellError('#CYCLE!', `${at} depends on itself`);
export const NAME = (fn: string) => cellError('#NAME?', `no function called ${fn}`);
export const VALUE = (detail: string) => cellError('#VALUE!', detail);
/** A reference to a tab that is not in this workbook — the one error a sheet rename creates. */
export const REF = (detail: string) => cellError('#REF!', detail);
/** A formula that would not parse. The cell reports it; the rest of the workbook carries on. */
export const ERROR = (detail: string) => cellError('#ERROR!', detail);

export type Cells = Record<string, string>;
/** Answers for the data calls in this grid, keyed by `./data.ts`'s canonical call string. */
export type Lookups = Record<string, Value>;

/**
 * The functions answered from this system's own figures rather than computed here.
 *
 * The names live here so that a typo can be told from a lookup: without them every unrecognised
 * call would resolve to a missing data figure and report `#N/A`, so `=XLOOKUP(...)` would read as
 * "we hold no such figure" rather than "there is no such function". `./data.ts` imports this and
 * attaches what each one takes and answers.
 */
export const DATA_FUNCTION_NAMES: ReadonlySet<string> = new Set([
  'FIN', 'CLOSE', 'QTY', 'AVGCOST', 'PROMOTER',
]);

/** A number, or the reason it is not one. Blank counts as zero only inside arithmetic. */
export function num(v: Value): number | CellError {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isCellError(v)) return v;
  const t = v.trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : VALUE(`${v} is not a number`);
}

export const text = (v: Value): string =>
  isCellError(v) ? v.err : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);

/** The literal in a cell: a number if it reads as one, otherwise the text as typed. */
export function literal(raw: string): Value {
  const t = raw.trim();
  if (t === '') return '';
  if (/^-?(\d+\.?\d*|\.\d+)%$/.test(t)) return Number(t.slice(0, -1)) / 100;
  const n = Number(t);
  return t !== '' && Number.isFinite(n) ? n : raw;
}

/**
 * The canonical form of a data call, used as the key on both sides of the two phases.
 *
 * Arguments are stringified and upper-cased, so `REVENUE("prajind","FY26")` and
 * `Revenue("PRAJIND","fy26")` are one lookup rather than two. Returns null when an argument is not
 * a literal, because a data function whose arguments are themselves computed cannot be resolved
 * before evaluation — and pretending otherwise would silently return the wrong company's figure.
 */
export function callKey(name: string, args: Value[]): string | null {
  const parts: string[] = [];
  for (const a of args) {
    if (isCellError(a)) return null;
    parts.push(String(a).trim().toUpperCase());
  }
  return `${name}(${parts.join('|')})`;
}
