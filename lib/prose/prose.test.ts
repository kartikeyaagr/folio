/**
 * Markdown, and what the toolbar does to it.
 *
 * Two things are pinned harder than the rest. A `javascript:` URL must never become an `href` — the
 * text of a document is untrusted, because an imported `.docx` carries whatever a third party put
 * in it. And a spaced asterisk must stay arithmetic: this desk writes `EBITDA * 8` constantly, and
 * an editor that silently italicises ` 8 ` is one people stop pasting calculations into.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blocks, inlines, safeHref } from './parse.ts';
import { applyMark } from './marks.ts';
import { DEFAULT_FACE, DEFAULT_SIZE, typographyBody, typographyOf } from './typography.ts';

/** The text of an inline tree, so a test can say what it reads as without walking the shape. */
const flat = (src: string): string =>
  inlines(src).map(function text(n): string {
    if (n.t === 'text' || n.t === 'code') return n.v;
    return n.kids.map(text).join('');
  }).join('');

const kinds = (src: string): string[] => inlines(src).map((n) => n.t);

// ---- links are the dangerous part --------------------------------------------------------------

test('only a link that could not run anything becomes a link', () => {
  assert.equal(safeHref('https://nseindia.com'), 'https://nseindia.com');
  assert.equal(safeHref('mailto:ir@aeron.com'), 'mailto:ir@aeron.com');
  assert.equal(safeHref('/company/AERON'), '/company/AERON');
  for (const bad of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<script>', 'vbscript:x', '']) {
    assert.equal(safeHref(bad), null, `${bad} must not become an href`);
  }
});

test('an unsafe link is left as the text it was, not dropped', () => {
  // Dropping it would hide that somebody put it there. The reader sees the URL and can judge it.
  const nodes = inlines('see [here](javascript:alert(1)) for more');
  assert.deepEqual(nodes.map((n) => n.t), ['text']);
  assert.match(flat('see [here](javascript:alert(1)) for more'), /javascript:alert/);
});

// ---- emphasis, and what is not emphasis ---------------------------------------------------------

test('the marks a memo uses', () => {
  assert.deepEqual(kinds('**bold**'), ['strong']);
  assert.deepEqual(kinds('*italic*'), ['em']);
  assert.deepEqual(kinds('~~gone~~'), ['del']);
  assert.deepEqual(kinds('`code`'), ['code']);
  assert.equal(flat('**bold**'), 'bold');
});

test('a spaced asterisk is arithmetic, not emphasis', () => {
  // CommonMark's flanking rule, and the reason this parser has one: a delimiter opens only when a
  // non-space follows it and closes only when a non-space precedes it. This desk writes multiples
  // with spaces around the asterisk constantly, and a memo that silently italicises its own
  // arithmetic is one nobody pastes a calculation into.
  assert.deepEqual(kinds('EBITDA * 8 * 2'), ['text']);
  assert.equal(flat('EBITDA * 8 * 2'), 'EBITDA * 8 * 2');
  assert.deepEqual(kinds('2 * 3 * 4'), ['text']);
  assert.deepEqual(kinds('margin * 2'), ['text'], 'one asterisk on its own is not emphasis either');
  assert.deepEqual(kinds('****'), ['text'], 'four asterisks are four asterisks, not empty bold');

  // Still emphasis when it is written as emphasis.
  assert.deepEqual(kinds('*italic*'), ['em']);
  assert.deepEqual(kinds('2*3*4'), ['text', 'em', 'text'], 'no spaces, so it reads as written');
});

test('an underscore inside a word is part of the word', () => {
  assert.deepEqual(kinds('snake_case_name'), ['text']);
  assert.equal(flat('snake_case_name'), 'snake_case_name');
  assert.deepEqual(kinds('_italic_'), ['em'], 'but on its own it still emphasises');
});

test('nothing inside a span of code is a mark', () => {
  // `a*b*c` is three literal characters and an asterisk either side, not an italic b.
  const nodes = inlines('`a*b*c`');
  assert.deepEqual(nodes.map((n) => n.t), ['code']);
  assert.equal(flat('`a*b*c`'), 'a*b*c');
});

test('emphasis inside a link, but never inside its URL', () => {
  const [link] = inlines('[**Aeron** filing](https://nseindia.com/a*b)');
  assert.equal(link!.t, 'link');
  if (link!.t !== 'link') return;
  assert.equal(link!.href, 'https://nseindia.com/a*b', 'the URL is taken whole');
  assert.equal(link!.kids[0]!.t, 'strong');
});

// ---- blocks -------------------------------------------------------------------------------------

test('the block shapes, and consecutive items gathering into one list', () => {
  const out = blocks('# Title\n\n- one\n- two\n- three\n\n1. first\n2. second\n\n> quoted\n\n---\n\nplain');
  assert.deepEqual(out.map((b) => b.t), ['h', 'ul', 'ol', 'quote', 'hr', 'p']);
  const ul = out[1]!;
  assert.equal(ul.t === 'ul' && ul.items.length, 3, 'one list of three, not three lists of one');
  const ol = out[2]!;
  assert.equal(ol.t === 'ol' && ol.start, 1);
});

test('a numbered list keeps the number it started at', () => {
  const out = blocks('4. four\n5. five');
  assert.equal(out[0]!.t === 'ol' && out[0]!.start, 4);
});

test('line breaks inside a paragraph survive; a blank line ends it', () => {
  const out = blocks('one\ntwo\n\nthree');
  assert.equal(out.length, 2);
  assert.equal(out[0]!.t === 'p' && out[0]!.kids[0]!.t === 'text' && out[0]!.kids[0]!.v, 'one\ntwo');
});

test('what docx import already writes reads back as what it meant', () => {
  // `lib/import/docx.ts` has written `# heading` and `- item` since before there was a renderer.
  const out = blocks('# Praj — first look\n\n- Order book conversion\n- Margin guidance');
  assert.deepEqual(out.map((b) => b.t), ['h', 'ul']);
});

// ---- the toolbar --------------------------------------------------------------------------------

test('a mark wraps the selection, and pressing it again takes it off', () => {
  const on = applyMark('make this bold', 5, 14, 'bold');
  assert.equal(on.text, 'make **this bold**');
  assert.deepEqual([on.start, on.end], [7, 16], 'the same words stay selected');

  const off = applyMark(on.text, on.start, on.end, 'bold');
  assert.equal(off.text, 'make this bold', 'back to where it started');
});

test('a mark also comes off when the delimiters sit outside the selection', () => {
  // Select the word between the asterisks rather than the asterisks too — which is what happens
  // when you double-click a bold word.
  const off = applyMark('make **this** bold', 7, 11, 'bold');
  assert.equal(off.text, 'make this bold');
});

test('with nothing selected the caret lands between the delimiters', () => {
  const out = applyMark('', 0, 0, 'bold');
  assert.equal(out.text, '****');
  assert.deepEqual([out.start, out.end], [2, 2], 'ready to type into');
});

test('a line prefix applies to every line the selection touches', () => {
  const out = applyMark('one\ntwo\nthree', 1, 9, 'bullet');
  assert.equal(out.text, '- one\n- two\n- three');
});

test('a numbered list counts, and two identical lines get different numbers', () => {
  const out = applyMark('same\nsame\nsame', 0, 14, 'number');
  assert.equal(out.text, '1. same\n2. same\n3. same');
  assert.equal(applyMark(out.text, 0, out.text.length, 'number').text, 'same\nsame\nsame');
});

test('switching from one block mark to another replaces rather than stacks', () => {
  const bulleted = applyMark('one\ntwo', 0, 7, 'bullet');
  const headed = applyMark(bulleted.text, 0, bulleted.text.length, 'h2');
  assert.equal(headed.text, '## one\n## two', 'not `## - one`');
});

test('a mixed selection turns every line on rather than off', () => {
  const out = applyMark('- one\ntwo', 0, 9, 'bullet');
  assert.equal(out.text, '- one\n- two');
});

test('a link selects the part you have to fill in', () => {
  const out = applyMark('see Aeron here', 4, 9, 'link');
  assert.equal(out.text, 'see [Aeron](url) here');
  assert.equal(out.text.slice(out.start, out.end), 'url');
});

test('a rule gets its own line, whatever it was pressed next to', () => {
  assert.equal(applyMark('above', 5, 5, 'rule').text, 'above\n\n---\n\n');
  assert.equal(applyMark('above\n', 6, 6, 'rule').text, 'above\n\n---\n\n');
  assert.equal(applyMark('above\n\n', 7, 7, 'rule').text, 'above\n\n---\n\n');
  assert.equal(applyMark('', 0, 0, 'rule').text, '---\n\n');
});

// ---- a document's typeface ----------------------------------------------------------------------

test("a document's typeface is stored beside its text, never inside it", () => {
  // Markdown has nowhere to put a typeface, and `lib/retrieval/`'s chunker reads `.text` — so the
  // text has to come back exactly as it went in whatever the face is.
  const body = typographyBody('# Title\n\nwords', { face: 'mono', size: 14 });
  assert.equal(body['text'], '# Title\n\nwords');
  assert.deepEqual(typographyOf(body), { face: 'mono', size: 14 });
});

test('a document nobody has restyled stores exactly what it stored before any of this', () => {
  assert.deepEqual(
    typographyBody('words', { face: DEFAULT_FACE, size: DEFAULT_SIZE }),
    { text: 'words' },
  );
});

test('a body from before typography existed reads as the default', () => {
  assert.deepEqual(typographyOf({ text: 'words' }), { face: DEFAULT_FACE, size: DEFAULT_SIZE });
  assert.deepEqual(typographyOf({ text: 'w', face: 'wingdings', size: 99 }), {
    face: DEFAULT_FACE,
    size: DEFAULT_SIZE,
  });
});
