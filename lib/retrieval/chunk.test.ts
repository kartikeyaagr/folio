import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, chunkCells, sheetGridText, TARGET_CHARS, MIN_CHARS } from './chunk.ts';

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
  // Checks the cut point in the SOURCE text, not just the trimmed piece: a piece that starts with
  // a whole word could still have been cut from a source position that fell mid-word one character
  // earlier, before trimming moved the boundary. If charFrom/charTo don't land on whitespace (or
  // an end of the document), the character immediately outside the piece is still part of a word.
  const t = para(2000, 'extraordinary');
  const out = chunkText(t);
  assert.ok(out.length > 1, 'expected more than one chunk');
  for (const p of out) {
    if (p.charFrom > 0) assert.match(t[p.charFrom - 1]!, /\s/, `split before "${p.text.slice(0, 24)}" lands mid-word`);
    if (p.charTo < t.length) assert.match(t[p.charTo]!, /\s/, `split after "${p.text.slice(-24)}" lands mid-word`);
    assert.equal(p.text, p.text.trim(), 'chunk text should be trimmed at both ends');
  }
});

test('with no whitespace anywhere, breakBefore has nothing to prefer and hard-cuts at the limit', () => {
  // Pins the one branch where a split CAN land inside a word — see the comment on breakBefore for
  // why that's the deliberate last resort rather than an accident. A run with no whitespace at all
  // has no paragraph, sentence, or word boundary to offer, so the cut lands at exactly TARGET_CHARS.
  const t = 'x'.repeat(1500);
  const out = chunkText(t);
  assert.equal(out.length, 2);
  assert.equal(out[0]!.charFrom, 0);
  assert.equal(out[0]!.charTo, TARGET_CHARS);
  assert.equal(out[0]!.text.length, TARGET_CHARS);
  assert.equal(t.slice(out[0]!.charFrom, out[0]!.charTo), out[0]!.text);
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

test('a sheet wider than 26 columns orders cells by column, not by letter', () => {
  // `AA` is the 27th column, but 'AA'.localeCompare('B') puts it second — so a wide sheet renders
  // with the far right of the grid interleaved into the far left, and char_from/char_to then index
  // that scrambled row. `lib/sheet/cells.ts` warns about exactly this case in its own header
  // ("shows up only at the 27th column") and exports `columnIndex`, which is the ordering to use.
  const cells = { A1: 'first', B1: 'second', Z1: 'twenty-sixth', AA1: 'twenty-seventh' };
  assert.equal(sheetGridText(cells), 'first\tsecond\ttwenty-sixth\ttwenty-seventh');
});

test('an empty sheet produces no chunks', () => {
  assert.deepEqual(chunkCells({}), []);
});

test('a sheet of only formulas produces no chunks', () => {
  // A formula is not content. Its VALUE is content, and the value is not in `cells`.
  assert.deepEqual(chunkCells({ A1: '=SUM(B1:B3)', A2: '=A1*2' }), []);
});

test('a wide sheet packs multiple chunks, and every chunk starts and ends at a row boundary', () => {
  // The bug this pins: joining rows with '\n' and delegating to chunkText let breakBefore's
  // whitespace fallback pick a tab (more common per row than the row's own newline) over the row
  // boundary, so a chunk could open mid-row — e.g. "117.29\tFY2012" with the line-item name gone.
  // The 3-row fixture above fits in one chunk and cannot catch that; this one forces several.
  const cells: Record<string, string> = {};
  const rows: string[] = [];
  for (let r = 1; r <= 80; r++) {
    const value = (r * 3.17).toFixed(2);
    cells[`A${r}`] = `LineItem${r}`;
    cells[`B${r}`] = value;
    cells[`C${r}`] = `FY20${r % 25}`;
    rows.push(`LineItem${r}\t${value}\tFY20${r % 25}`);
  }
  const joined = rows.join('\n');
  const out = chunkCells(cells);

  assert.ok(out.length > 1, 'expected more than one chunk from 80 rows');
  const rowPattern = /^LineItem\d+\t[\d.]+\tFY20\d+$/;
  for (const p of out) {
    // charFrom/charTo must still slice back to exactly p.text, against the row-joined source this
    // test controls independently of chunkCells' own internals.
    assert.equal(joined.slice(p.charFrom, p.charTo), p.text, 'charFrom/charTo do not match the row-joined text');
    for (const row of p.text.split('\n')) {
      assert.match(row, rowPattern, `row split mid-cell: "${row}"`);
    }
  }
});
