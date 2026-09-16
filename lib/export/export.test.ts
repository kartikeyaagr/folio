/**
 * Writing a `.docx`.
 *
 * The check that matters most is the round trip: every file this produces is read back by
 * `lib/import/zip.ts` and `lib/import/docx.ts` — the same two readers an uploaded Word file goes
 * through. So "does this open" is answered by the code that opens things, rather than by looking at
 * the bytes and hoping. Verified against macOS's own document engine too, which reports it as
 * `Office Open XML format`; that part cannot live in a test, so it lives in the commit message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDocx } from '../import/docx.ts';
import { unzip } from '../import/zip.ts';
import { docxFilename, toDocx } from './docx.ts';
import { zip } from './zip.ts';

// ---- the zip underneath ---------------------------------------------------------------------------

test('what this writes, the reader reads', () => {
  // `lib/import/zip.ts` reads the central directory rather than walking local headers, so this
  // exercises the half of the format that is easy to write inconsistently: a file whose two copies
  // of every size and offset disagree opens in some tools and not others.
  const entries = [
    { name: 'a.txt', body: Buffer.from('the first one', 'utf8') },
    { name: 'nested/b.xml', body: Buffer.from('<x>second</x>', 'utf8') },
    { name: 'c.bin', body: Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251)) },
  ];
  const back = unzip(zip(entries));
  assert.deepEqual([...back.keys()], ['a.txt', 'nested/b.xml', 'c.bin']);
  for (const e of entries) assert.deepEqual(back.get(e.name), e.body, e.name);
});

test('an empty entry survives, which is the case that usually does not', () => {
  const back = unzip(zip([{ name: 'empty.txt', body: Buffer.alloc(0) }]));
  assert.deepEqual(back.get('empty.txt'), Buffer.alloc(0));
});

test('the same document exports to the same bytes', () => {
  // The timestamp is fixed rather than `now`, so an export is testable and two exports of an
  // unedited document are identical — a reader diffing them sees the document change, not the clock.
  assert.deepEqual(toDocx('Memo', 'one\n\ntwo'), toDocx('Memo', 'one\n\ntwo'));
});

// ---- the document ---------------------------------------------------------------------------------

test('a .docx carries every part Word needs to honour its own styles', () => {
  // A `w:pStyle` naming a style `styles.xml` does not define is ignored in silence — the heading
  // exports as body text and nothing says so. Same for `w:numPr` with no `numbering.xml`.
  const parts = [...unzip(toDocx('Memo', '# Heading\n\n- item')).keys()];
  for (const needed of [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/styles.xml',
    'word/numbering.xml',
  ]) {
    assert.ok(parts.includes(needed), `missing ${needed}`);
  }
});

test('our own Word reader reads our own Word writer', () => {
  const text = '# Title\n\n**bold** and *italic*\n\n- one\n- two\n\n> quoted';
  const back = readDocx(toDocx('Aeron — first look', text));
  assert.match(back, /^# Aeron — first look/, 'the title leads, as a heading');
  assert.match(back, /^# Title$/m);
  assert.match(back, /bold and italic/);
  assert.match(back, /^- one$/m);
  assert.match(back, /^- two$/m);
});

test('a bulleted list and a numbered list are different lists to Word', () => {
  // Both are `ListParagraph`; what separates them is which numbering definition they point at, and
  // pointing both at the same one is a mistake that only shows up in Word rather than in a reader.
  const xml = unzip(toDocx('M', '- a\n\n1. b')).get('word/document.xml')!.toString('utf8');
  assert.match(xml, /<w:numId w:val="1"\/>/, 'bullets');
  assert.match(xml, /<w:numId w:val="2"\/>/, 'numbers');
});

test('text that would break the XML is escaped, not dropped', () => {
  const xml = unzip(toDocx('M & Co <Ltd>', 'a < b & c "d" \'e\''))
    .get('word/document.xml')!.toString('utf8');
  assert.match(xml, /M &amp; Co &lt;Ltd&gt;/);
  assert.match(xml, /a &lt; b &amp; c &quot;d&quot; &apos;e&apos;/);
  // And it comes back out as what it was.
  assert.match(readDocx(toDocx('M', 'a < b & c')), /a < b & c/);
});

test('every run says its spaces are meant, because Word drops them otherwise', () => {
  // `the **bold** word` is three runs, and the spaces are at the edges of the middle one. Word
  // collapses edge whitespace in a run unless `xml:space="preserve"` says not to, so without it
  // the sentence exports as `thebold word`.
  //
  // Asserted on the XML rather than through `readDocx`, which is the honest thing to do here: our
  // own reader preserves the spacing whether the attribute is there or not, so a round-trip test
  // passes with the attribute removed. Verified by removing it — this is the only assertion that
  // notices, and a test that cannot fail is worse than no test because it reads as cover.
  const xml = unzip(toDocx('M', 'the **bold** word')).get('word/document.xml')!.toString('utf8');
  const runs = xml.match(/<w:t\b[^>]*>/g) ?? [];
  assert.ok(runs.length >= 3, 'three runs: before the mark, the mark, after it');
  for (const t of runs) assert.match(t, /xml:space="preserve"/);
  assert.match(readDocx(toDocx('M', 'the **bold** word')), /the bold word/);
});

test('an unsafe link never reaches the exported file as a link', () => {
  // Same rule as the reader's: `safeHref` refuses it, so it stays the text somebody typed.
  const xml = unzip(toDocx('M', '[x](javascript:alert(1))')).get('word/document.xml')!.toString('utf8');
  assert.doesNotMatch(xml, /javascript:alert\(1\)<\/w:t>.*w:u/s);
  assert.match(xml, /\[x\]\(javascript:alert\(1\)\)/, 'kept as the text it was');
});

test('a filename a person can find again', () => {
  assert.equal(docxFilename('Aeron — first look'), 'Aeron — first look.docx');
  assert.equal(docxFilename('Q1/Q2: review?'), 'Q1 Q2 review.docx');
  assert.equal(docxFilename('   '), 'document.docx');
  assert.ok(docxFilename('x'.repeat(200)).length <= 85);
});
