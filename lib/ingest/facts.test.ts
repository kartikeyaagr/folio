import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFacts, UnreadableInstance } from './facts.ts';

const doc = (body: string) => `<?xml version="1.0"?><xbrli:xbrl xmlns:x="urn:t">${body}</xbrli:xbrl>`;

/**
 * The three cases this module exists for. Each is written against the regex it replaced, and each
 * was checked to produce the wrong answer there before being written here — the file header
 * records what those answers were.
 */

test('an element name matches whole, not as a prefix', () => {
  // The regex read NumberOfSharesHeld when asked for NumberOfShares, because `[^>]*` absorbed the
  // rest of the name. It returned 999. A holding is a number nobody can eyeball for correctness.
  const f = readFacts(doc(
    '<x:NumberOfSharesHeld contextRef="C1">999</x:NumberOfSharesHeld>' +
    '<x:NumberOfShares contextRef="C1">500</x:NumberOfShares>',
  ));
  assert.equal(f.get('NumberOfShares', 'C1'), '500');
  assert.equal(f.get('NumberOfSharesHeld', 'C1'), '999');
});

test('a self-closing element is empty, not whatever follows it', () => {
  const f = readFacts(doc(
    '<x:WhetherEncumbered contextRef="MainI"/><x:Other contextRef="MainI">LEAKED</x:Other>',
  ));
  assert.equal(f.get('WhetherEncumbered', 'MainI'), '');
  assert.ok(f.has('WhetherEncumbered', 'MainI'), 'present and empty is not the same as absent');
});

test('a context id carrying a regex metacharacter is read, not thrown on', () => {
  // Context ids come out of the document. The old reader interpolated them into `new RegExp`,
  // where a "(" is a SyntaxError rather than a failure to match.
  const f = readFacts(doc('<x:NumberOfShares contextRef="C(1">500</x:NumberOfShares>'));
  assert.equal(f.get('NumberOfShares', 'C(1'), '500');
});

test('a fact the document does not carry is null, and absent is not empty', () => {
  const f = readFacts(doc('<x:NumberOfShares contextRef="C1">500</x:NumberOfShares>'));
  assert.equal(f.get('NumberOfShares', 'C2'), null);
  assert.equal(f.has('NumberOfShares', 'C2'), false);
});

test('attribute order does not matter, as it did not before either', () => {
  const f = readFacts(doc('<x:NumberOfShares decimals="0" contextRef="C1">500</x:NumberOfShares>'));
  assert.equal(f.get('NumberOfShares', 'C1'), '500');
});

test('contexts come back in document order', () => {
  const f = readFacts(doc(
    '<x:NameOfTheShareholder contextRef="D_A">First</x:NameOfTheShareholder>' +
    '<x:NameOfTheShareholder contextRef="D_B">Second</x:NameOfTheShareholder>',
  ));
  assert.deepEqual(f.contexts('NameOfTheShareholder'), ['D_A', 'D_B']);
  assert.deepEqual(f.contexts('NotPresent'), []);
});

test('an element with no contextRef is not a fact', () => {
  const f = readFacts(doc('<x:Filler>text</x:Filler>'));
  assert.deepEqual(f.contexts('Filler'), []);
});

test('something that is not XML says so rather than reading as empty', () => {
  assert.throws(() => readFacts('<x:Unclosed contextRef="C1">'), UnreadableInstance);
});
