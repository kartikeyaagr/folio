/**
 * Cutting text into retrievable pieces.
 *
 * Pure by design: no database, no embedder, no I/O. The invariant that matters —
 * `source.slice(charFrom, charTo) === piece.text` — is what makes a citation open the document at
 * the right passage, and it is worth being able to test exhaustively without a Postgres instance.
 *
 * **The numbers below are stated defaults, not findings.** `docs/specs/v4.md` §5.3 says so
 * explicitly: nothing in this tree has measured a chunk size, and v2 never chunked at all — it
 * embedded whole short situation strings and put transcripts into prompts whole. Treat these as
 * provisional until a real corpus says otherwise, and change them here rather than at a call site.
 */

export interface Piece {
  text: string;
  charFrom: number;
  charTo: number;
}

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

/** A1 -> { col: 'A', row: 1 }. Anything that is not an address is skipped. */
function address(key: string): { col: string; row: number } | null {
  const m = /^([A-Z]+)([0-9]+)$/.exec(key);
  return m ? { col: m[1]!, row: Number(m[2]) } : null;
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
export function chunkCells(cells: Record<string, string>): Piece[] {
  const rows = new Map<number, { col: string; value: string }[]>();
  for (const [key, value] of Object.entries(cells)) {
    const a = address(key);
    if (!a) continue;
    const v = String(value ?? '').trim();
    if (v === '' || v.startsWith('=')) continue;
    if (!rows.has(a.row)) rows.set(a.row, []);
    rows.get(a.row)!.push({ col: a.col, value: v });
  }
  if (rows.size === 0) return [];

  const lines = [...rows.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([, cs]) => cs.sort((x, y) => x.col.localeCompare(y.col)).map((c) => c.value).join('\t'));

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
      charFrom: starts[fromRow]!,
      charTo: ends[toRow]!,
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
        text: text.slice(prevPiece.charFrom, lastPiece.charTo),
        charFrom: prevPiece.charFrom,
        charTo: lastPiece.charTo,
      });
    }
  }

  return pieces;
}
