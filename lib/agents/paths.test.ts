/**
 * The path grammar, and everything a form field must not be able to do with it.
 *
 * `/review` is a POST endpoint with a stable id reachable by anybody signed in, and the values it
 * receives are always strings. Most of this file is about what `setPath` refuses.
 *
 * Pure — no database, no model.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getPath,
  label,
  leaves,
  positionOf,
  removeAt,
  segments,
  setPath,
  shape,
  UnwritablePath,
} from './paths.ts';

/** The real shape of a news brief, trimmed. */
const BRIEF = {
  period: 'The last 7 days',
  by_company: [
    { symbol: 'AERON', what_happened: ['An AGM notice.', 'A corrigendum.'], why_it_matters: 'Read in order.' },
    { symbol: 'PRAJIND', what_happened: ['Nothing filed.'], why_it_matters: 'Policy moved, not the name.' },
  ],
  nothing_to_report: [],
  coming_up: ['PRAJIND — results, 30 September'],
};

// ---- the grammar --------------------------------------------------------------------------------

test('a path is dotted for keys and bracketed for positions', () => {
  assert.deepEqual(segments('headline'), ['headline']);
  assert.deepEqual(segments('figures.revenue_cr'), ['figures', 'revenue_cr']);
  assert.deepEqual(segments('by_company[0].what_happened[1]'), ['by_company', 0, 'what_happened', 1]);
});

test('anything that is not a path is refused rather than reinterpreted', () => {
  // Each of these could be given a plausible meaning, and giving it one is how two spellings of one
  // path get into a system that keys its learning corpus on the string.
  for (const bad of ['', 'a.', '.a', 'a..b', 'a[0]b', 'a[]', 'a[01]', 'a[-1]', 'a[x]', 'a.b[']) {
    assert.equal(segments(bad), null, `"${bad}" should not parse`);
  }
});

test('a position and the key it sits under are different names', () => {
  // The whole reason for brackets: with dots, `figures.2024` and `moved.2` are the same shape.
  assert.equal(shape('by_company[0].what_happened[1]'), 'by_company[].what_happened[]');
  assert.equal(shape('figures.2024'), 'figures.2024', 'an object key that looks like a year is not a position');
  assert.equal(shape('headline'), 'headline', 'a flat field is its own shape');
});

// ---- reading ------------------------------------------------------------------------------------

test('every scalar in a draft has a path, and an empty list has none', () => {
  const found = leaves(BRIEF).map((l) => l.path);

  assert.ok(found.includes('by_company[1].what_happened[0]'));
  assert.ok(found.includes('by_company[0].why_it_matters'));
  assert.ok(
    !found.some((p) => p.startsWith('nothing_to_report')),
    'an empty list contributes no leaf — which is why draftDistance needs a fallback for one',
  );
  assert.equal(leaves(BRIEF).find((l) => l.path === 'by_company[0].symbol')?.value, 'AERON');
});

test('a path reads back the value it was built from', () => {
  for (const l of leaves(BRIEF)) assert.equal(getPath(BRIEF, l.path), l.value, l.path);
});

// ---- writing ------------------------------------------------------------------------------------

test('a correction lands where it was aimed and nothing else moves', () => {
  const after = setPath(BRIEF, 'by_company[0].why_it_matters', 'Read together, not in order.');
  const co = (after['by_company'] as Record<string, unknown>[])[0]!;

  assert.equal(co['why_it_matters'], 'Read together, not in order.');
  assert.equal(co['symbol'], 'AERON', 'its siblings are untouched');
  assert.deepEqual(after['coming_up'], BRIEF.coming_up);
  assert.equal(
    (BRIEF.by_company[0] as { why_it_matters: string }).why_it_matters,
    'Read in order.',
    'and the original is not mutated',
  );
});

test('a single-segment path is exactly the old shallow spread', () => {
  // acceptDraft merged with `{...content, ...edited}` before this existed, and two callers still
  // pass flat patches. The new fold has to be a superset, not a replacement.
  assert.deepEqual(setPath({ a: 'x', b: 'y' }, 'a', 'z'), { a: 'z', b: 'y' });
});

test('a path that names nothing is refused, and says so in words', () => {
  assert.throws(() => setPath(BRIEF, 'by_company[9].why_it_matters', 'x'), UnwritablePath);
  assert.throws(() => setPath(BRIEF, 'invented', 'x'), UnwritablePath);
  assert.throws(() => setPath(BRIEF, 'by_company[0].invented', 'x'), UnwritablePath);
  assert.throws(() => setPath(BRIEF, 'not a path at all!!', 'x'), UnwritablePath);
});

test('a form field cannot walk the prototype chain', () => {
  // `'constructor' in {}` is true, so a membership test is not a safe predicate on its own.
  for (const hostile of ['constructor.prototype.polluted', '__proto__.polluted', 'by_company[0].__proto__.x']) {
    assert.throws(() => setPath(BRIEF, hostile, 'yes'), UnwritablePath, hostile);
  }
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('a form field cannot resize an array by writing its length', () => {
  // `Object.hasOwn([1,2,3], 'length')` is true, which is why the array test is the index and not
  // the property. Assigning length here would silently truncate a brief.
  assert.throws(() => setPath(BRIEF, 'by_company[0].what_happened.length', '1'), UnwritablePath);
  assert.equal(BRIEF.by_company[0]!.what_happened.length, 2);
});

test('only text can be corrected, because every form value is text', () => {
  // Without this, a POST of `f.figures.revenue_cr=693.4` stores the string "693.4" in the draft,
  // in the document it becomes, and in the exemplar corpus — and /review's promise that a filed
  // figure is never overwritten becomes false with no symptom.
  const results = { headline: 'As filed', figures: { revenue_cr: 858.9 }, moved: ['x'] };
  assert.throws(() => setPath(results, 'figures.revenue_cr', '693.4'), UnwritablePath);
  assert.throws(() => setPath({ n: null }, 'n', 'something'), UnwritablePath);
  assert.throws(() => setPath(results, 'figures', 'wholesale'), UnwritablePath, 'nor a whole object');
});

// ---- removing -----------------------------------------------------------------------------------

test('a bullet the agent invented can be dropped, and the rest close up', () => {
  const after = removeAt(BRIEF, 'by_company[0].what_happened', [0]);
  const co = (after['by_company'] as Record<string, unknown>[])[0]!;

  assert.deepEqual(co['what_happened'], ['A corrigendum.']);
  assert.deepEqual(BRIEF.by_company[0]!.what_happened.length, 2, 'the original is not mutated');
  assert.deepEqual((after['by_company'] as unknown[])[1], BRIEF.by_company[1], 'nothing else moves');
});

test('dropping several at once drops the ones asked for, not the ones after them', () => {
  const held = { xs: ['a', 'b', 'c', 'd'] };
  assert.deepEqual(removeAt(held, 'xs', [1, 3])['xs'], ['a', 'c']);
});

test('a position belongs to the list above it', () => {
  assert.deepEqual(positionOf('by_company[0].what_happened[2]'), {
    array: 'by_company[0].what_happened',
    index: 2,
  });
  assert.equal(positionOf('by_company[0].why_it_matters'), null, 'a named field is not a position');
});

// ---- reading a path aloud -----------------------------------------------------------------------

test('a path reads as the thing it points at, not as the path', () => {
  // What somebody scanning a list of corrections needs. `by_company[0]` is precise and unreadable.
  assert.equal(label('by_company[0].why_it_matters', BRIEF), 'AERON · why it matters');
  assert.equal(label('by_company[1].what_happened[0]', BRIEF), 'PRAJIND · what happened 1');
  assert.equal(label('period', BRIEF), 'period');
});

test('an element that calls itself nothing is counted from one, because a reader counts from one', () => {
  assert.equal(label('coming_up[0]', BRIEF), 'coming up 1');
  assert.equal(label('by_company[0].why_it_matters'), 'by company 1 · why it matters');
});

test('a forensic answer is named by its checklist item, not by its position', () => {
  const review = { version: 3, answers: [{ item: 7, verdict: 'clear', note: 'n' }] };
  assert.equal(label('answers[0].note', review), 'item 7 · note');
});

test('a shape keeps its brackets, because that is what says it is a field and not a place', () => {
  assert.equal(label('by_company[].why_it_matters'), 'by company[] · why it matters');
  assert.equal(shape('by_company[3].why_it_matters'), 'by_company[].why_it_matters');
});
