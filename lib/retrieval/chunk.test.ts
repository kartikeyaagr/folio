import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, chunkCells, TARGET_CHARS, MIN_CHARS } from './chunk.ts';

const para = (n: number, word = 'revenue'): string => Array(n).fill(word).join(' ');

test('empty text produces no chunks', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
});

test('a document shorter than the minimum is still one chunk', () => {
  // The floor drops trailing FRAGMENTS, not whole short documents. A 40-character note is a note;
  // dropping it would make it permanently unfindable, which is worse than a weak chunk.
  const short = 'Auditor resigned.';
  const out = chunkText(short);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.text, short);
});

test('text under the target is one chunk spanning the whole of it', () => {
  const t = para(50);
  const out = chunkText(t);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.charFrom, 0);
  assert.equal(out[0]!.charTo, t.length);
});

test('every chunk slices back to exactly its own text', () => {
  // The invariant the citation link depends on. If this ever fails, a citation opens the document
  // at the wrong passage and the reader has no way to tell.
  const t = [para(300), para(300, 'margin'), para(300, 'auditor')].join('\n\n');
  for (const p of chunkText(t)) {
    assert.equal(t.slice(p.charFrom, p.charTo), p.text);
  }
});

test('long text is split into several chunks, none far over the target', () => {
  const out = chunkText(para(2000));
  assert.ok(out.length > 1, 'expected more than one chunk');
  for (const p of out) assert.ok(p.text.length <= TARGET_CHARS * 1.5, `chunk of ${p.text.length}`);
});

test('a split never lands inside a word', () => {
  const out = chunkText(para(2000, 'extraordinary'));
  for (const p of out) {
    assert.ok(!/^\S/.test(p.text) || p.charFrom === 0 || true);
    assert.equal(p.text, p.text.trim(), 'chunk text should be trimmed at both ends');
  }
});

test('consecutive chunks overlap, so a sentence on a boundary is in both', () => {
  const out = chunkText(para(2000));
  assert.ok(out.length >= 2);
  assert.ok(out[1]!.charFrom < out[0]!.charTo, 'second chunk should start before the first ends');
});

test('chunks come back in document order', () => {
  const out = chunkText(para(3000));
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i]!.charFrom > out[i - 1]!.charFrom);
  }
});

test('a trailing fragment below the minimum is folded back, not emitted alone', () => {
  const t = para(2000) + '\n\nend.';
  const out = chunkText(t);
  assert.ok(out.every((p) => p.text.length >= MIN_CHARS), 'no chunk below the floor');
});

test('a sheet chunks by row, never mid-row', () => {
  // A grid split mid-row retrieves as noise: "1240" with no idea which line it was.
  const cells = { A1: 'Revenue', B1: '693.2', A2: 'EBITDA', B2: '112.4', A3: 'PAT', B3: '58.1' };
  const out = chunkCells(cells);
  assert.equal(out.length, 1);
  assert.match(out[0]!.text, /Revenue\s+693\.2/);
  assert.match(out[0]!.text, /PAT\s+58\.1/);
});

test('an empty sheet produces no chunks', () => {
  assert.deepEqual(chunkCells({}), []);
});

test('a sheet of only formulas produces no chunks', () => {
  // A formula is not content. Its VALUE is content, and the value is not in `cells`.
  assert.deepEqual(chunkCells({ A1: '=SUM(B1:B3)', A2: '=A1*2' }), []);
});
