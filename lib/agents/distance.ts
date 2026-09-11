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

import { shape } from './paths.ts';
import { fieldAt, type Field } from './shapes.ts';

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
 * Every position in a draft where the two sides can be compared, changed or not.
 *
 * One walk, two consumers: `diffFields` keeps the ones that moved, `draftDistance` scores them
 * against the ones that did not. They were separate before, which was survivable while a position
 * was always a top-level key; once a correction can land three levels down, two walks that agree
 * today is a bug waiting for the first draft that disagrees.
 *
 * **An array whose length changed is one position, not N.** A reviewer dropping the second of four
 * bullets shifts the third and fourth down, and comparing positionally would read that as three
 * rewrites and a removal. It is one act — *"the agent invented this"* — and the record should say
 * so, or three deletions would clear `MIN_DISTANCE` and raise a rule about prose nobody was making
 * a point about.
 */
export interface Position {
  path: string;
  from: unknown;
  to: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function positions(from: unknown, to: unknown, path = ''): Position[] {
  if (Array.isArray(from) && Array.isArray(to)) {
    if (from.length !== to.length) return [{ path, from, to }];
    return from.flatMap((v, i) => positions(v, to[i], `${path}[${i}]`));
  }
  if (isObject(from) && isObject(to)) {
    const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])];
    return keys.flatMap((k) => positions(from[k], to[k], path === '' ? k : `${path}.${k}`));
  }
  // Everything else — two scalars, or a value whose very type changed — is one position. A
  // top-level key on one side only lands here too, as `undefined` against its value.
  return [{ path, from, to }];
}

/**
 * A whole draft's distance: the mean across every position somebody *could* have corrected, not
 * only the ones that moved.
 *
 * Averaging over the changed positions alone would score a draft where one of seven fields was
 * rewritten identically to one where the only field was — and §7's example is precisely the
 * difference between those two: *"they rewrote `guidance_delta` and left the other six fields
 * alone, every quarter, for four quarters."* The six left alone are the evidence.
 *
 * **Weighted by shape, not by position.** Scoring every leaf equally lets the widest field decide
 * the whole number: a news brief has one `period` and ten positions under `by_company`, so a
 * rewritten period would count for a thirteenth of the draft and a rewritten judgement for a
 * tenth of a third. Averaging each shape's instances first, then each key's shapes, makes every
 * top-level key weigh the same however wide it is — which is the agent's schema deciding, not the
 * week's news.
 *
 * Instances still average, and that is deliberate rather than a leftover: a brief covering twenty
 * names where one judgement was rewritten *is* a better brief than one covering two where one was,
 * and §7 says so — *"the six left alone are the evidence."* What shape-weighting fixes is the
 * denominator being unbounded, not the average being an average.
 *
 *     draft  = mean over top-level keys
 *     key    = mean over the distinct shapes beneath it
 *     shape  = mean over its own instances
 *
 * **And positions nobody may correct are out of the denominator.** A figure, a flag and an identity
 * are guaranteed zeros; 15 of forensics' 43 positions are read-only, and leaving them in would cap
 * a total repudiation of that agent below the 0.25 that counts as one correction at all. "The six
 * left alone" means six somebody could have changed.
 *
 * `declared` is optional: without it every position counts, which is what a draft from an agent
 * this system has no declaration for should do, and what every caller did before this existed.
 */
export function draftDistance(
  original: Record<string, unknown>,
  final: Record<string, unknown>,
  declared?: Field,
): number {
  const keys = [...new Set([...Object.keys(original), ...Object.keys(final)])];
  if (keys.length === 0) return 0;

  let total = 0;
  let counted = 0;

  for (const key of keys) {
    const here = positions(original[key], final[key], key).filter(
      (p) => !declared || correctable(fieldAt(declared, p.path), p),
    );

    // Nothing here anybody could have corrected, so it is not evidence either way and stays out of
    // the denominator. **This is also what keeps a NaN out of the column.** `nothing_to_report: []`
    // is in the one real brief in this tree and `guidance_changes` is empty whenever there was no
    // prior call, so an empty field is the ordinary case; dividing by its zero positions would
    // write a NaN that is greater than zero in SQL and not greater than zero in JavaScript — the
    // column calling a draft edited while the exemplar beside it calls the same draft accepted.
    if (here.length === 0) continue;

    const byShape = new Map<string, number[]>();
    for (const p of here) {
      const s = shape(p.path);
      byShape.set(s, [...(byShape.get(s) ?? []), fieldDistance(p.from, p.to)]);
    }

    const shapes = [...byShape.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
    total += shapes.reduce((a, b) => a + b, 0) / shapes.length;
    counted++;
  }

  return counted === 0 ? 0 : total / counted;
}

/**
 * A position a reviewer can act on: prose they can rewrite, a choice they can pick, or a list they
 * can drop an element from. Everything else is shown and never touched.
 *
 * **A position the declaration does not describe is inferred, not excluded.** `shapes.ts` fails
 * closed for *writing* — a path it does not know is not editable — but failing closed here would
 * silently zero the one number §7 stakes the loop on the day an agent's schema changed and nobody
 * updated the registry. `/review` renders an undeclared field rather than dropping it, for the same
 * reason, so the two agree: what is shown as correctable is what is counted.
 */
function correctable(field: Field | null, at: Position): boolean {
  if (field === null) return typeof at.from === 'string' || typeof at.to === 'string';
  return field.kind === 'text' || field.kind === 'choice' || (field.kind === 'list' && field.removable);
}
