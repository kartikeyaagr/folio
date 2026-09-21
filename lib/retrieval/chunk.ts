/**
 * Cutting text into retrievable pieces.
 *
 * Pure by design: no database, no embedder, no I/O. The invariant that matters —
 * `source.slice(charFrom, charTo) === piece.text` — is what makes a citation open the document at
 * the right passage, and it is worth being able to test exhaustively without a Postgres instance.
 * "`source`" here means specifically what `register.ts`'s `textFor` returns — that used to be true
 * only by coincidence for prose and false for every spreadsheet, because `chunkCells` cut offsets
 * into a grid it built internally while `textFor` handed back the raw JSONB body, two different
 * strings (verified live: chunk 2069's `char_from=0, char_to=109` sliced the real source to
 * `{"cells": {"A1": "Revenue FY26 (cr)"…`, not to the chunk's own text). `sheetGridText`, below,
 * closes that gap by being the one function both sides call — see its own comment.
 *
 * **The numbers below are stated defaults, not findings.** `docs/specs/v4.md` §5.3 says so
 * explicitly: nothing in this tree has measured a chunk size, and v2 never chunked at all — it
 * embedded whole short situation strings and put transcripts into prompts whole. Treat these as
 * provisional until a real corpus says otherwise, and change them here rather than at a call site.
 */

import { columnIndex } from '../sheet/cells.ts';
import type { Grid } from '../sheet/evaluate.ts';

/**
 * One retrievable piece and the half-open span `[charFrom, charTo)` it was cut from.
 *
 * The span indexes **what `textFor` returns for this source, not what the database stores** — for
 * a workbook that is `sheetGridText(sheets)` rather than the JSONB body, which is the whole reason
 * `sheetGridText` exists as a shared function. `source.slice(charFrom, charTo) === text` is the
 * invariant a citation rests on, and the header above records what it cost the one time the two
 * sides computed it from different strings.
 *
 * **The pieces are neither a partition nor a cover of that source.** Consecutive prose pieces
 * overlap by up to `OVERLAP_CHARS`; consecutive sheet blocks instead leave a one-character gap,
 * the newline that joined the rows. Either way, concatenating them is not the document and their
 * lengths do not sum to its length — anything that needs the whole text goes back to `textFor`.
 */
export interface Piece {
  text: string;
  charFrom: number;
  charTo: number;
}

/**
 * A target, not a cap. Three paths exceed it on purpose: `chunkText` and `packRows` each fold a
 * short trailing fragment into its predecessor, which can leave a final piece close to twice this;
 * and `packRows` always emits the row at the head of a block even when that single row is longer
 * than this by itself, because a hard cut inside a row is worse than a chunk that runs long.
 *
 * So nothing downstream may size a buffer, a prompt budget or a column off this constant. Measure
 * the piece. The one place that has to bound total work — `drain`'s `CHUNK_BUDGET` — counts chunks
 * against a measured per-chunk rate rather than multiplying by this number.
 */
export const TARGET_CHARS = 1000;
export const OVERLAP_CHARS = 150;
/**
 * A chunk this short retrieves against everything and tells a reader nothing. It applies to
 * *fragments*, never to a whole short document: a 40-character note is a note, and dropping it
 * would make it permanently unfindable.
 */
export const MIN_CHARS = 100;

/**
 * Breaks prefer a paragraph gap, then a sentence end, then any whitespace — in that order, taking
 * the latest candidate in the window so the chunk stays close to `limit`. None of those is
 * guaranteed to exist: a `limit`-character run with no whitespace at all (a hard-wrapped table
 * dump, a URL, a base64 blob) has nothing to break on, so the last resort is a hard cut at `limit`
 * itself — which can land inside a word. That is deliberate, not an oversight: an unbroken run has
 * to be cut somewhere, and refusing to cut it would mean refusing to chunk the document at all.
 */
function breakBefore(text: string, limit: number): number {
  const window = text.slice(0, limit);
  for (const re of [/\n\s*\n(?![\s\S]*\n\s*\n)/, /[.?!]\s(?![\s\S]*[.?!]\s)/, /\s(?!\S*\s)/]) {
    const m = window.match(re);
    if (m?.index !== undefined && m.index > limit * 0.4) return m.index + m[0].length;
  }
  return limit;
}

/**
 * The overlap step in chunkText picks the next chunk's start by raw character count, which can
 * land inside a word — a 13-letter word against 150-character overlap does, reliably, on a wholly
 * ordinary corpus with plenty of whitespace to prefer instead. Nudge it forward to the next safe
 * boundary. Bounded by `limit` (the current chunk's own end, already safe via breakBefore or its
 * own hard-cut fallback): if nothing safe turns up before then, the whole overlap window is one
 * unbroken run and there is nothing better to land on, so the raw offset is kept as-is.
 */
function safeOverlapStart(text: string, at: number, limit: number): number {
  let i = at;
  while (i < limit && !(/\s/.test(text[i - 1]!) || /\s/.test(text[i]!))) i++;
  return i < limit ? i : at;
}

export function chunkText(text: string): Piece[] {
  if (text.trim().length === 0) return [];

  const pieces: Piece[] = [];
  let at = 0;
  while (at < text.length) {
    const remaining = text.length - at;
    const take = remaining <= TARGET_CHARS ? remaining : breakBefore(text.slice(at), TARGET_CHARS);
    const rawFrom = at;
    const rawTo = at + take;

    // Trim, then move the offsets to match — the slice invariant is the whole point.
    const raw = text.slice(rawFrom, rawTo);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const from = rawFrom + lead;
    const to = rawTo - trail;

    if (to > from) pieces.push({ text: text.slice(from, to), charFrom: from, charTo: to });

    if (rawTo >= text.length) break;
    at = safeOverlapStart(text, Math.max(rawTo - OVERLAP_CHARS, rawFrom + 1), rawTo);
  }

  // A trailing fragment is folded into its predecessor rather than emitted alone. The floor is
  // about fragments; a document that is itself short keeps its single chunk.
  if (pieces.length > 1) {
    const last = pieces[pieces.length - 1]!;
    if (last.text.length < MIN_CHARS) {
      const prev = pieces[pieces.length - 2]!;
      pieces.splice(pieces.length - 2, 2, {
        text: text.slice(prev.charFrom, last.charTo),
        charFrom: prev.charFrom,
        charTo: last.charTo,
      });
    }
  }
  return pieces;
}

/**
 * A1 -> { col: 0, row: 1 }. Anything that is not an address is skipped.
 *
 * The row pattern is `[1-9][0-9]*`, matching `lib/sheet/cells.ts`'s own `REF` rather than a
 * looser `[0-9]+`. Accepting `A01` would land it on the same (col, row) as `A1`, and their
 * order within the row would then fall to `Array.prototype.sort` over `Object.entries` order
 * rather than to anything meaningful.
 *
 * The column is resolved to its **index** here rather than kept as letters, because the only thing
 * this is used for is ordering and letters do not order: `'AA'.localeCompare('B')` is negative, so
 * a lexicographic sort files column 27 between columns 1 and 2. `lib/sheet/cells.ts` says so in its
 * own header — *"getting that wrong shows up only at the 27th column"* — and `columnIndex` is the
 * function it exports to get it right.
 */
function address(key: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)([1-9][0-9]*)$/.exec(key);
  if (!m) return null;
  const col = columnIndex(m[1]!);
  return col === null ? null : { col, row: Number(m[2]) };
}

/**
 * Cells, sorted into rows then columns and rendered one line per row (tab between cells) —
 * skipping formulas and empties. The shared core of `sheetGridText` and `chunkCells` below: both
 * need exactly this same set of lines, in the same order, or their two ideas of "the sheet as
 * text" would silently diverge.
 */
function sheetLines(cells: Record<string, string>): string[] {
  const rows = new Map<number, { col: number; value: string }[]>();
  for (const [key, value] of Object.entries(cells)) {
    const a = address(key);
    if (!a) continue;
    const v = String(value ?? '').trim();
    if (v === '' || v.startsWith('=')) continue;
    if (!rows.has(a.row)) rows.set(a.row, []);
    rows.get(a.row)!.push({ col: a.col, value: v });
  }
  return [...rows.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, cs]) => cs.sort((x, y) => x.col - y.col).map((c) => c.value).join('\t'));
}

/** One tab's rows, and where its first row starts in the workbook's rendered text. */
interface Block {
  lines: string[];
  base: number;
}

/**
 * A workbook's tabs, rendered to lines, with each tab's offset into the joined text.
 *
 * **A tab's name is a line of its own, and only when there is more than one tab.** It is content:
 * a retrieved block of numbers headed `Segment revenue` is answerable and the same block headed
 * nothing is not. The condition is what keeps this change from re-chunking the whole corpus — a
 * body saved before tabs existed reads back as exactly one tab (`lib/sheet/book.ts`), takes no
 * header, and renders to the byte-identical string it rendered to before, so its `content_hash`
 * does not move and `GRID_RENDERER` does not need to. That is the one exemption to the rule stated
 * beside `GRID_RENDERER` in register.ts, and it holds only because the new output differs solely
 * for inputs — multi-tab bodies — that no version row in the table can yet have.
 *
 * A tab with nothing in it contributes nothing, header included: there is no passage to retrieve.
 */
function bookBlocks(sheets: readonly Grid[]): { blocks: Block[]; text: string } {
  const named = sheets.length > 1;
  const blocks: Block[] = [];
  const all: string[] = [];
  let base = 0;
  for (const sheet of sheets) {
    const rows = sheetLines(sheet.cells);
    if (rows.length === 0) continue;
    const lines = named ? [sheet.name, ...rows] : rows;
    blocks.push({ lines, base });
    all.push(...lines);
    // Every line plus the '\n' that follows it, which is where the next block's first line begins.
    base += lines.reduce((n, l) => n + l.length + 1, 0);
  }
  return { blocks, text: all.join('\n') };
}

/**
 * The row-packed text a workbook renders to — tab between cells, newline between rows, formulas and
 * empty cells dropped. `register.ts`'s `rawText` returns exactly this for a `document_version`
 * whose body is a sheet, so it is what `textFor` hands back too: the "invariant the citation link
 * depends on" (0041's own words on `chunks.char_from`) held only for prose until this function
 * existed, because `chunkCells` computed its offsets into this derived grid while `textFor`
 * returned the raw JSONB body — two different strings. Sharing this function between the two sides
 * is the same fix `FILING_TEXT_SQL` and `CURRENT_VERSION_ORDER_SQL` already apply in register.ts:
 * one definition, not two that can drift.
 */
export function sheetGridText(sheets: readonly Grid[]): string {
  return bookBlocks(sheets).text;
}

/**
 * A sheet chunks by row-block, never by character — the one invariant that matters here. A grid
 * cut mid-row retrieves as noise: a number with no idea which line it belonged to.
 *
 * This does not delegate to `chunkText` on the joined rows. That was the first cut and it measured
 * broken: `breakBefore`'s whitespace fallback treats a cell-separating `\t` the same as the row's
 * own `\n`, and a multi-column row has more tabs than newlines, so on an 80-row fixture the break
 * landed inside a row far more often than at one — a chunk opening with `"117.29\tFY2012"` and no
 * line-item name. Rows are packed by hand instead, so a chunk boundary is a row boundary by
 * construction, not by how the text happens to look.
 *
 * A single row longer than TARGET_CHARS is pathological — nothing in this tree has one — and is
 * kept whole as its own oversized chunk rather than split: a hard cut inside a row is worse than a
 * chunk that runs long.
 *
 * Formula cells are skipped. A formula is not content — its *value* is, and the value lives in
 * the evaluated lookups rather than in `cells`.
 */
export function chunkCells(sheets: readonly Grid[]): Piece[] {
  // Packed tab by tab, so a chunk never straddles two of them. A block ending in three rows of
  // Inputs and opening with two of Model retrieves as a passage that was never written.
  return bookBlocks(sheets).blocks.flatMap((b) => packRows(b.lines, b.base));
}

/** One tab's rows into chunks, offset by where that tab starts in the workbook's text. */
function packRows(lines: string[], base: number): Piece[] {
  if (lines.length === 0) return [];

  const text = lines.join('\n');

  // Row boundaries in `text`, computed once so every chunk below is a slice of whole rows only.
  const starts: number[] = [];
  const ends: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length;
    ends.push(pos);
    pos += 1; // the '\n' joiner
  }

  const pieces: Piece[] = [];
  let fromRow = 0;
  while (fromRow < lines.length) {
    // Always take the row at fromRow, even alone over TARGET_CHARS (the pathological case above),
    // then keep adding whole rows while the block stays within budget.
    let toRow = fromRow;
    while (toRow + 1 < lines.length && ends[toRow + 1]! - starts[fromRow]! <= TARGET_CHARS) toRow += 1;

    pieces.push({
      text: text.slice(starts[fromRow]!, ends[toRow]!),
      charFrom: base + starts[fromRow]!,
      charTo: base + ends[toRow]!,
    });
    if (toRow === lines.length - 1) break;

    // Re-include trailing rows from this block for overlap, by whole rows, never back past
    // fromRow — that floor is what guarantees the window always advances.
    let nextRow = toRow + 1;
    while (nextRow - 1 > fromRow && ends[toRow]! - starts[nextRow - 1]! < OVERLAP_CHARS) nextRow -= 1;
    fromRow = nextRow;
  }

  // Same trailing-fragment fold as chunkText: a short last block reads as noise, so it joins its
  // predecessor rather than standing alone. Both are whole-row chunks already, so the merge is too.
  if (pieces.length > 1) {
    const lastPiece = pieces[pieces.length - 1]!;
    if (lastPiece.text.length < MIN_CHARS) {
      const prevPiece = pieces[pieces.length - 2]!;
      pieces.splice(pieces.length - 2, 2, {
        // Sliced with local offsets; `base` is only ever added on the way out.
        text: text.slice(prevPiece.charFrom - base, lastPiece.charTo - base),
        charFrom: prevPiece.charFrom,
        charTo: lastPiece.charTo,
      });
    }
  }

  return pieces;
}
