/**
 * How far what was signed off is from what the model said.
 *
 *   `v4.md §7` — *"The distance between what the model said and what was signed off is the only
 *   honest measure of whether an agent is any good."*
 *
 * `diffFields` in `review.ts` answers *which* fields changed, and has since R0. This answers *how
 * much*, which is the number §7 stakes the whole learning loop on: **if mean edit distance does not
 * fall, the loop is not working and should be turned off.**
 *
 * Two granularities, because one does not fit both kinds of field this system produces:
 *
 *   * **Prose gets word-level Levenshtein.** In a forty-word paragraph, fixing a typo and rewriting
 *     the argument are different events, and character distance calls them nearly the same — a
 *     one-word substitution in forty words is ~2.5% of the words and can be 15% of the characters.
 *   * **Short values get character-level.** `"219.1"` to `"693.4"` is one word replaced by another,
 *     which word-level scores as a total rewrite. At character level it is what it looks like.
 *
 * The boundary is eight words, from §7. Measured against nothing — it is a stated default like the
 * chunk size, and if it ever matters it should be measured rather than argued about.
 *
 * Pure and database-free, so the boundary cases below are cheap to assert.
 */

/** §7's boundary between "prose" and "a short value". A stated default, not a finding. */
export const PROSE_WORDS = 8;

/**
 * Levenshtein over any two sequences, two rows at a time.
 *
 * Generic over the element so the same routine serves words and characters; the alternative is two
 * copies that drift. O(n·m) time, O(min) space — drafts are paragraphs, not documents, and the
 * largest field in this tree is a news brief's `why_it_matters`.
 */
export function levenshtein<T>(a: readonly T[], b: readonly T[]): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, substitution);
    }
    [prev, row] = [row, prev];
  }
  return prev[b.length]!;
}

const words = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean);

/** Normalised by the longer side, so the result is 0 for identical and 1 for wholly replaced. */
const normalised = (distance: number, longest: number): number =>
  longest === 0 ? 0 : Math.min(1, distance / longest);

/**
 * One field's distance, 0–1.
 *
 * A value that is not a string is compared on its JSON at character level. Nothing can edit a
 * nested field today — `/review` offers a textarea per string field and renders the rest read-only —
 * but a function that silently returned 0 for a changed array would be wrong on the day that
 * stops being true, and it would be wrong quietly.
 */
export function fieldDistance(from: unknown, to: unknown): number {
  if (typeof from === 'string' && typeof to === 'string') {
    const before = words(from);
    if (before.length >= PROSE_WORDS) {
      const after = words(to);
      return normalised(levenshtein(before, after), Math.max(before.length, after.length));
    }
    return normalised(levenshtein([...from], [...to]), Math.max(from.length, to.length));
  }

  const a = JSON.stringify(from ?? null);
  const b = JSON.stringify(to ?? null);
  return normalised(levenshtein([...a], [...b]), Math.max(a.length, b.length));
}

/**
 * A whole draft's distance: the mean across every field, not only the changed ones.
 *
 * Averaging over the changed fields alone would score a draft where one of seven fields was
 * rewritten identically to one where the only field was — and §7's example is precisely the
 * difference between those two: *"they rewrote `guidance_delta` and left the other six fields
 * alone, every quarter, for four quarters."* The six left alone are the evidence.
 */
export function draftDistance(
  original: Record<string, unknown>,
  final: Record<string, unknown>,
): number {
  const fields = [...new Set([...Object.keys(original), ...Object.keys(final)])];
  if (fields.length === 0) return 0;
  const total = fields.reduce((sum, key) => sum + fieldDistance(original[key], final[key]), 0);
  return total / fields.length;
}
