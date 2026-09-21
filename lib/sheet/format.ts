/**
 * How a cell is shown, as opposed to what it holds.
 *
 * A format never changes a value. `=B2-B3` is the same number whether it is bold, red, or written
 * as `₹1,85,840.00`, and everything that reads this system's figures — the evaluator, the data
 * functions, `lib/retrieval/`'s chunker — goes to `cells` and never here. That separation is what
 * makes formatting safe to add: there is no arrangement of it that can make a model say something
 * different from what it computes.
 *
 * **The palette is the app's, not an arbitrary colour picker.** Google Sheets offers every hex
 * value there is; this system has four meanings — navy, teal, red, amber — and a fifth for quiet.
 * A per-cell hex would be a second colour vocabulary growing alongside `app/globals.css`'s, and it
 * would also have to be an inline style, which the house rules ban for reasons that hold here too.
 * Five tones, as classes, is the version of this that stays consistent with every other screen.
 *
 * Flags are stored as `true` or not at all, never `false`. A body is read back and diffed often
 * enough that `{"bold": false}` and `{}` meaning the same thing is worth not having.
 */

import { isCellError, type Value } from './values.ts';

export type Align = 'left' | 'center' | 'right';
/** The four meanings this system has, plus quiet. Same names as the tokens in `app/globals.css`. */
export type Tone = 'navy' | 'teal' | 'red' | 'amber' | 'muted';
/** `auto` is what a cell does with no format: a number reads as a number, text as text. */
export type NumberStyle = 'auto' | 'text' | 'number' | 'inr' | 'percent' | 'date';
/** Where the text sits in a row taller than itself. Sheets' three, and the same default. */
export type VAlign = 'top' | 'middle' | 'bottom';

/**
 * The typefaces, and why there are three rather than twenty.
 *
 * Google Sheets offers every font the machine has, and a model built in fourteen of them is a model
 * nobody can read. This system already owns exactly two faces as design tokens — the sans the UI is
 * set in, the serif a document is set in — and a monospace, which is the one a grid genuinely needs
 * that neither covers: a column of figures in a proportional face does not line up, and lining up
 * is what a column of figures is for.
 *
 * Each carries a Word equivalent as well as a CSS stack, because `lib/export/docx.ts` has to name a
 * font the recipient's machine has. A memo exported in a face Word cannot find is a memo that
 * arrives in Calibri.
 */
export type Face = 'sans' | 'serif' | 'mono';

export interface Format {
  bold?: true;
  italic?: true;
  underline?: true;
  strike?: true;
  align?: Align;
  valign?: VAlign;
  face?: Face;
  /** Point size from `SIZES`. Absent is the grid's own 12.5px. */
  size?: number;
  style?: NumberStyle;
  /** Decimal places, 0–6. Only meaningful for the numeric styles. */
  dp?: number;
  ink?: Tone;
  fill?: Tone;
  /** Wrapping is the default; this turns it off and clips to one line, as Sheets' "Clip" does. */
  clip?: true;
}

export type Formats = Record<string, Format>;

export const FLAGS = ['bold', 'italic', 'underline', 'strike'] as const;
export type Flag = (typeof FLAGS)[number];

export const ALIGNS: Align[] = ['left', 'center', 'right'];
export const VALIGNS: VAlign[] = ['top', 'middle', 'bottom'];

export const FACES: { value: Face; label: string; word: string }[] = [
  { value: 'sans', label: 'Sans', word: 'Calibri' },
  { value: 'serif', label: 'Serif', word: 'Georgia' },
  { value: 'mono', label: 'Mono', word: 'Consolas' },
];

/**
 * The sizes offered, in points.
 *
 * A fixed ladder rather than a free number, for the same reason the widths in `SheetEditor` are
 * buckets: these are classes in `app/globals.css`, and a class is what can carry a hover, a dark
 * mode value and a print rule. It is also the set somebody actually reaches for — Sheets' own
 * dropdown is these plus sizes nobody uses in a model.
 */
export const SIZES = [8, 9, 10, 11, 12, 14, 18, 24] as const;
export const TONES: Tone[] = ['navy', 'teal', 'red', 'amber', 'muted'];
export const STYLES: { value: NumberStyle; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'number', label: 'Number — 12,34,567.89' },
  { value: 'inr', label: 'Rupees — ₹12,34,567.89' },
  { value: 'percent', label: 'Percent — 12.5%' },
  { value: 'date', label: 'Date — 31 Mar 2026' },
  { value: 'text', label: 'Plain text' },
];

const MAX_DP = 6;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const isTone = (v: unknown): v is Tone => TONES.includes(v as Tone);
const isAlign = (v: unknown): v is Align => ALIGNS.includes(v as Align);
const isVAlign = (v: unknown): v is VAlign => VALIGNS.includes(v as VAlign);
const isFace = (v: unknown): v is Face => FACES.some((f) => f.value === v);
const isSize = (v: unknown): v is number => (SIZES as readonly number[]).includes(v as number);
const isStyle = (v: unknown): v is NumberStyle => STYLES.some((s) => s.value === v);

/** A format with nothing in it is not stored — `clear` and "never formatted" are the same state. */
export const isEmpty = (f: Format | undefined): boolean =>
  f === undefined || Object.keys(f).length === 0;

/**
 * Merge a patch in, dropping anything set back to its default.
 *
 * `undefined` in the patch means "remove this", which is how every control turns itself off: the
 * alignment buttons set `align: undefined` when you press the active one again.
 */
export function withPatch(f: Format | undefined, patch: Partial<Format>): Format {
  const next: Record<string, unknown> = { ...(f ?? {}) };
  for (const [k, v] of Object.entries(patch) as [string, unknown][]) {
    // `auto` is the absence of a number style, so storing it would be storing a default.
    if (v === undefined || v === false || v === 'auto') delete next[k];
    else next[k] = v;
  }
  return next as Format;
}

export const toggleFlag = (f: Format | undefined, flag: Flag): Format =>
  withPatch(f, { [flag]: f?.[flag] ? undefined : true });

/** Decimal places as the two stepper buttons move them: never below zero, never past six. */
export function stepDp(f: Format | undefined, by: number): Format {
  const from = f?.dp ?? defaultDp(f?.style);
  const dp = Math.max(0, Math.min(MAX_DP, from + by));
  // Stepping decimals on an unformatted cell means you wanted a number, so it becomes one.
  const style = f?.style === undefined || f.style === 'auto' ? 'number' : f.style;
  return withPatch(f, { dp, style });
}

const defaultDp = (style: NumberStyle | undefined): number =>
  style === 'percent' ? 1 : style === 'number' || style === 'inr' ? 2 : 2;

/**
 * The classes a cell carries. Never an inline style — a class is what `app/globals.css` can give a
 * hover, a selected state and a dark-mode value, and those are the three things a colour needs.
 */
export function classesFor(f: Format | undefined): string {
  if (isEmpty(f)) return '';
  const out: string[] = [];
  for (const flag of FLAGS) if (f![flag]) out.push(`cf-${flag}`);
  if (f!.align) out.push(`cf-${f!.align}`);
  if (f!.valign) out.push(`cf-v-${f!.valign}`);
  if (f!.face) out.push(`cf-face-${f!.face}`);
  if (f!.size) out.push(`cf-size-${f!.size}`);
  if (f!.ink) out.push(`cf-ink-${f!.ink}`);
  if (f!.fill) out.push(`cf-fill-${f!.fill}`);
  if (f!.clip) out.push('cf-clip');
  return out.join(' ');
}

/** Indian digit grouping — 12,34,567.89, not 1,234,567.89. The same rule `components/ui.tsx` uses. */
const grouped = (n: number, dp: number): string =>
  n.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** `2026-03-31` as a person says it. Parsed by hand: `new Date` on a bare ISO date is UTC, and
 *  rendering that in a zone behind UTC shows the day before. */
function readableDate(iso: string): string | null {
  const m = ISO_DATE.exec(iso);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : null;
}

/**
 * What the cell shows.
 *
 * `auto` is the behaviour a grid has with no formatting at all, and it stays the default: enough
 * precision to be useful, not so much that a column stops lining up. Everything else is something
 * a person asked for explicitly, so it is applied exactly — including `0` decimal places, which is
 * a real answer and not a missing one.
 */
export function display(v: Value | undefined, f: Format | undefined): string {
  if (v === undefined || v === '') return '';
  if (isCellError(v)) return v.err;

  const style = f?.style ?? 'auto';
  if (style === 'text') return typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);

  if (typeof v === 'string') {
    // A date format only has something to say about a date. Anything else is left as it was typed.
    return style === 'date' ? (readableDate(v) ?? v) : v;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (!Number.isFinite(v)) return '#NUM!';

  const dp = Math.max(0, Math.min(MAX_DP, f?.dp ?? defaultDp(style)));
  switch (style) {
    case 'number': return grouped(v, dp);
    case 'inr': return `₹${grouped(v, dp)}`;
    case 'percent': return `${grouped(v * 100, dp)}%`;
    // `Number.isFinite` above is not enough: a finite number past ±8.64e15 ms is outside the
    // range a Date can hold, so `new Date(v)` is an Invalid Date and `.toISOString()` throws
    // RangeError rather than returning anything. `display` is called straight from the render in
    // `SheetEditor.tsx`, so that throw took the whole sheet down — one cell formatted as a date
    // and holding a large number, which a formula can produce without anybody typing it.
    // Falls back to the number, the same way the string branch above falls back to the text.
    case 'date': {
      const at = new Date(v);
      return Number.isNaN(at.getTime())
        ? String(v)
        : readableDate(at.toISOString().slice(0, 10)) ?? String(v);
    }
    default:
      // Enough precision to be useful, not so much that a column of them stops lining up.
      return Math.abs(v) >= 1e9 || (Math.abs(v) < 1e-4 && v !== 0)
        ? v.toExponential(3)
        : String(Number(v.toFixed(4)));
  }
}

/**
 * Read formats off a stored body.
 *
 * Validated field by field rather than cast. A body is JSON that a previous version of this app
 * wrote, and an `ink` of `"chartreuse"` would render as a class that does not exist — which shows
 * up as a cell that quietly ignores its own formatting rather than as an error anybody can see.
 */
export function readFormats(raw: unknown): Formats {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Formats = {};
  for (const [ref, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const f: Format = {};
    for (const flag of FLAGS) if (v[flag] === true) f[flag] = true;
    if (isAlign(v['align'])) f.align = v['align'];
    if (isVAlign(v['valign'])) f.valign = v['valign'];
    if (isFace(v['face'])) f.face = v['face'];
    if (isSize(v['size'])) f.size = v['size'];
    if (isStyle(v['style']) && v['style'] !== 'auto') f.style = v['style'];
    if (typeof v['dp'] === 'number' && Number.isInteger(v['dp'])) {
      f.dp = Math.max(0, Math.min(MAX_DP, v['dp']));
    }
    if (isTone(v['ink'])) f.ink = v['ink'];
    if (isTone(v['fill'])) f.fill = v['fill'];
    if (v['clip'] === true) f.clip = true;
    if (!isEmpty(f)) out[ref] = f;
  }
  return out;
}

/**
 * Sizes a person set by hand, which override the automatic ones.
 *
 * Kept per tab and keyed by index — `{"1": 240}` is the second column at 240px. Only the ones
 * somebody actually dragged are stored, so a workbook nobody has resized carries nothing and keeps
 * the automatic widths as the model grows into them. That is the whole relationship between the
 * two: `columnKind` is the default, this is the exception, and clearing the exception (a
 * double-click on the handle) puts the column back under the default rather than freezing it at
 * whatever the default happened to be that day.
 */
export type Sizes = Record<string, number>;

/** Bounds, so a drag cannot produce a column too narrow to click or a row taller than the screen. */
export const MIN_COL = 48;
export const MAX_COL = 640;
export const MIN_ROW = 20;
export const MAX_ROW = 400;

export const clampCol = (px: number): number => Math.round(Math.max(MIN_COL, Math.min(MAX_COL, px)));
export const clampRow = (px: number): number => Math.round(Math.max(MIN_ROW, Math.min(MAX_ROW, px)));

/**
 * Read stored sizes, dropping anything that is not a usable number at a usable index.
 *
 * Same argument as `readFormats`: this is JSON a previous version wrote, and a width of `"wide"` or
 * `NaN` would reach the grid as a broken CSS value — which renders as a column that silently
 * ignores the size somebody set rather than as anything anybody can see.
 */
export function readSizes(raw: unknown, clamp: (px: number) => number): Sizes {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Sizes = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = clamp(value);
  }
  return out;
}
