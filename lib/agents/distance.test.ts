/**
 * The number §7 stakes the learning loop on, checked at its boundaries.
 *
 * Worth testing carefully rather than by eye: a distance that is quietly always small makes every
 * agent look good, and a distance that is quietly always large makes the loop look like it is
 * working when nothing has changed. Both failures are invisible on the screen that reports it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { draftDistance, fieldDistance, levenshtein, positions, PROSE_WORDS } from './distance.ts';
import { CONTENT } from './shapes.ts';

test('levenshtein counts the edits, over words as readily as characters', () => {
  assert.equal(levenshtein([...'kitten'], [...'sitting']), 3);
  assert.equal(levenshtein(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
  assert.equal(levenshtein([], [...'abc']), 3, 'an empty side costs the whole other side');
  assert.equal(levenshtein([...'same'], [...'same']), 0);
});

test('an untouched field is zero', () => {
  assert.equal(fieldDistance('Revenue rose on a larger order book.', 'Revenue rose on a larger order book.'), 0);
  assert.equal(fieldDistance(null, null), 0);
  assert.equal(fieldDistance(['a', 'b'], ['a', 'b']), 0);
});

test('prose is measured in words, so fixing one word in a paragraph scores small', () => {
  // Twelve words, one replaced. At character level this is ~8% and reads as a real change; at word
  // level it is 1/12, which is what it actually is.
  const before = 'Management guided to eighteen percent margins for the second half of the year';
  const after = 'Management guided to sixteen percent margins for the second half of the year';
  const d = fieldDistance(before, after);
  assert.ok(d > 0, 'it did change');
  assert.ok(d < 0.12, `one word in thirteen should be small, got ${d}`);
});

test('a short value is measured in characters, so a corrected digit is a corrected digit', () => {
  // Eight characters, two words, one digit changed. Word level would call this 1 of 2 words and
  // score 0.5 — half the field rewritten, for a typo. Character level says 1/8.
  const d = fieldDistance('219.1 cr', '219.4 cr');
  assert.ok(Math.abs(d - 1 / 8) < 1e-9, `expected the character path, got ${d}`);
  assert.notEqual(d, 0.5, 'and specifically not the word path');
});

test('the eight-word boundary holds from both sides', () => {
  // A one-character edit, applied either side of the boundary. The two paths score it about five
  // times apart, so this distinguishes them rather than landing near the same number by luck —
  // which is what an earlier version of this test did, with "219.1 cr" -> "693.4 cr" scoring 0.5
  // under both. The boundary itself is a stated default from §7, measured against nothing; if it
  // ever moves, this is where it is recorded as having moved.
  const eight = 'one two three four five six seven eight';
  const seven = 'one two three four five six seven';
  assert.equal(eight.split(' ').length, PROSE_WORDS);
  assert.equal(seven.split(' ').length, PROSE_WORDS - 1);

  // Eight words: one word of eight substituted, whatever it cost in characters.
  assert.ok(
    Math.abs(fieldDistance(eight, 'one two three four five six seven eighx') - 1 / 8) < 1e-9,
    'at the boundary, words',
  );
  // Seven words: one character of thirty-three, not one word of seven.
  const below = fieldDistance(seven, 'one two three four five six sevex');
  assert.ok(Math.abs(below - 1 / seven.length) < 1e-9, `below the boundary, characters, got ${below}`);
  assert.ok(below < 1 / 7 / 4, 'and the two paths are nowhere near each other');
});

test('a wholly replaced field is one', () => {
  assert.equal(fieldDistance('abc', 'xyz'), 1);
  assert.equal(fieldDistance('', 'anything'), 1);
  assert.equal(fieldDistance('anything', ''), 1);
});

test('a value that is not a string still moves, because one day it will be editable', () => {
  // Nothing can edit a nested field today. A function that returned 0 here would be wrong quietly
  // on the day that changes.
  assert.ok(fieldDistance({ verdict: 'clear' }, { verdict: 'concern' }) > 0);
  assert.ok(fieldDistance([1, 2, 3], [1, 2, 4]) > 0);
});

test('a draft averages over every field, not only the ones that moved', () => {
  // §7's example is the difference between these two: one field rewritten out of seven is not the
  // same event as one field rewritten out of one, and averaging over changed fields alone would
  // score them identically at 1.0.
  const original = { a: 'abc', b: 'kept', c: 'kept', d: 'kept' };
  const oneOfFour = draftDistance(original, { a: 'xyz', b: 'kept', c: 'kept', d: 'kept' });
  const oneOfOne = draftDistance({ a: 'abc' }, { a: 'xyz' });

  assert.equal(oneOfOne, 1);
  assert.ok(Math.abs(oneOfFour - 0.25) < 1e-9, `one of four fields rewritten is 0.25, got ${oneOfFour}`);
});

test('an unchanged draft is zero, and an empty one does not divide by nothing', () => {
  assert.equal(draftDistance({ a: 'x', b: 'y' }, { a: 'x', b: 'y' }), 0);
  assert.equal(draftDistance({}, {}), 0);
});

test('a field only one side has counts as fully changed', () => {
  // An agent that stopped emitting a field, or a reviewer who added one, is a real edit.
  assert.equal(draftDistance({ a: 'x' }, { a: 'x', b: 'added' }) > 0, true);
});

// ---- nested content ------------------------------------------------------------------------------

/** The real shape of a news brief, from the draft in the dev database. */
const co = (symbol: string, why: string, what: string[] = ['A filing.']) => ({
  symbol,
  what_happened: what,
  why_it_matters: why,
});
const brief = (cos: unknown[]) => ({
  period: 'The last 7 days',
  by_company: cos,
  nothing_to_report: [],
  coming_up: ['PRAJIND — results, 30 September'],
});
const WAS = 'An AGM notice corrected on the day it was filed is worth reading in order.';
const NOW = 'The corrigendum is routine and changes nothing about the meeting itself.';

const BRIEF = CONTENT['news-brief']!;
const FORENSIC = CONTENT['forensics-review']!;

test('an empty list divides by nothing, and nothing is not NaN', () => {
  // `nothing_to_report: []` is in the one real brief in this tree, and `guidance_changes` is empty
  // whenever there was no prior call — so an empty field is the ordinary case. A NaN here would be
  // the worst available failure because it has no symptom: `'NaN'::numeric(4,3)` is accepted by the
  // column, `NaN > 0` is TRUE in SQL and false in JavaScript, so `/agents` would call the draft
  // edited and count NaN into the agent's weekly mean while the exemplar called it accepted.
  const b = brief([co('A', WAS)]);
  const d = draftDistance(b, b, BRIEF);
  assert.equal(Number.isNaN(d), false);
  assert.equal(d, 0);
});

test('a position nobody may correct is not evidence, so it is out of the denominator', () => {
  // `symbol` is a join key, not prose — `Brief` links `/company/{symbol}` from it. A draft where
  // only that moved has had nothing corrected, and must not read as though it had.
  const before = brief([co('AERON', WAS), co('PRAJIND', 'kept')]);
  const after = brief([{ ...co('AERON', WAS), symbol: 'ZZZZ' }, co('PRAJIND', 'kept')]);
  assert.equal(draftDistance(before, after, BRIEF), 0);
});

test('what is measured is the fraction of judgements rewritten, not the length of the brief', () => {
  // The correction is identical in each; what differs is how much the agent got right around it.
  // §7's own reading — "the six left alone are the evidence" — so a brief where nineteen of twenty
  // judgements stood is a better brief, and scores as one.
  const many = (n: number, why: string) =>
    brief([co('A', why), ...Array.from({ length: n - 1 }, (_, i) => co(`C${i}`, 'kept'))]);

  const oneOfTwo = draftDistance(many(2, WAS), many(2, NOW), BRIEF);
  const oneOfTwenty = draftDistance(many(20, WAS), many(20, NOW), BRIEF);
  assert.ok(oneOfTwo > oneOfTwenty, 'one of two is a worse brief than one of twenty');

  // And the fraction is what carries, so the same *share* of judgements scores the same at any
  // width — which is what makes the weekly mean comparable across a quiet week and a busy one.
  const share = (n: number, bad: number) =>
    draftDistance(
      brief(Array.from({ length: n }, (_, i) => co(`C${i}`, i < bad ? WAS : 'kept'))),
      brief(Array.from({ length: n }, (_, i) => co(`C${i}`, i < bad ? NOW : 'kept'))),
      BRIEF,
    );
  assert.ok(Math.abs(share(4, 1) - share(20, 5)) < 1e-9, 'a quarter rewritten is a quarter rewritten');
});

test('a dropped element is one correction, not the rewriting of everything after it', () => {
  // Removing the second of three bullets shifts the third down. Positionally that reads as two
  // rewrites and a deletion; it is one act, and three of them must not clear MIN_DISTANCE and
  // raise a rule about prose nobody was making a point about.
  const before = brief([co('A', WAS, ['one', 'two', 'three'])]);
  const after = brief([co('A', WAS, ['one', 'three'])]);

  const moved = positions(before, after).filter((p) => JSON.stringify(p.from) !== JSON.stringify(p.to));
  assert.deepEqual(moved.map((p) => p.path), ['by_company[0].what_happened']);
  assert.ok(draftDistance(before, after, BRIEF) > 0, 'and it still counts as a correction');
});

test('a forensic draft repudiated outright scores as a repudiation', () => {
  // Under per-position averaging this was 0.226 — below the 0.25 that `distil` calls one real
  // correction at all — because 15 of forensics' 43 positions are read-only zeros that sat in the
  // denominator. Fourteen notes rewritten and five verdicts flipped is the most emphatic
  // disagreement this agent can be given and the number has to be able to say so.
  const answer = (item: number, verdict: string, note: string) => ({ item, verdict, note });
  const before = {
    version: 3,
    answers: Array.from({ length: 14 }, (_, i) =>
      answer(i + 1, 'clear', 'Nothing in the filing suggests otherwise at all.')),
  };
  const after = {
    version: 3,
    answers: Array.from({ length: 14 }, (_, i) =>
      answer(i + 1, i < 5 ? 'concern' : 'clear', 'The auditor note contradicts this reading entirely.')),
  };

  const d = draftDistance(before, after, FORENSIC);
  assert.ok(d > 0.25, `a total repudiation must clear MIN_DISTANCE, got ${d.toFixed(3)}`);
  assert.ok(d <= 1);
});

test('without a declaration every position counts, which is what an undeclared agent gets', () => {
  // `shapeFor` falls back to reading the draft, and this is the path a caller took before any of
  // this existed — the flat-content answer must not have moved.
  assert.equal(draftDistance({ a: 'abc', b: 'k', c: 'k', d: 'k' }, { a: 'xyz', b: 'k', c: 'k', d: 'k' }), 0.25);
});
