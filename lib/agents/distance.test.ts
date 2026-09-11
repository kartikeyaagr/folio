/**
 * The number §7 stakes the learning loop on, checked at its boundaries.
 *
 * Worth testing carefully rather than by eye: a distance that is quietly always small makes every
 * agent look good, and a distance that is quietly always large makes the loop look like it is
 * working when nothing has changed. Both failures are invisible on the screen that reports it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { draftDistance, fieldDistance, levenshtein, PROSE_WORDS } from './distance.ts';

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
