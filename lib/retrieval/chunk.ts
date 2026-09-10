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

/** Paragraph first, then sentence, then whitespace. Never inside a word. */
function breakBefore(text: string, limit: number): number {
  const window = text.slice(0, limit);
  for (const re of [/\n\s*\n(?![\s\S]*\n\s*\n)/, /[.?!]\s(?![\s\S]*[.?!]\s)/, /\s(?!\S*\s)/]) {
    const m = window.match(re);
    if (m?.index !== undefined && m.index > limit * 0.4) return m.index + m[0].length;
  }
  return limit;
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
    at = Math.max(rawTo - OVERLAP_CHARS, rawFrom + 1);
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
 * A sheet chunks by row-block, never by character. A grid cut mid-row retrieves as noise: a
 * number with no idea which line it belonged to.
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

  return chunkText(lines.join('\n'));
}
