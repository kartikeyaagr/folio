/**
 * Markdown, as far as a memo needs it.
 *
 * **Why markdown and not a rich-text editor.** `components/DocEditor.tsx` has always argued that a
 * rich-text editor is a dependency, a serialisation format, and a class of bug where what you see
 * and what was stored disagree. All three still hold. What markdown gives instead is formatting
 * whose stored form *is* what you typed: the body stays `{text}`, a diff of two versions stays
 * readable, the chunker keeps indexing the same characters, and a document written here is still a
 * document if this app disappears.
 *
 * It is also already half-present. `lib/import/docx.ts` writes `# heading` and `- item` when it
 * reads a Word file, and has since it was written — so the convention arrived before the renderer.
 *
 * **This produces a tree, never HTML.** `components/Markdown.tsx` turns the tree into React
 * elements, so there is no point at which a string from a document becomes markup. That is not
 * caution for its own sake: an imported document can carry anything a third party put in a `.docx`,
 * and `components/DocumentText.tsx` already refuses to build HTML from extracted text for exactly
 * this reason. A parser that cannot emit HTML cannot be talked into emitting the wrong HTML.
 *
 * Deliberately small: headings, emphasis, code, links, lists, quotes and rules. No tables, no
 * footnotes, no embedded HTML. A model belongs in a spreadsheet and software belongs in `lib/`.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; kids: Inline[] }
  | { t: 'em'; kids: Inline[] }
  | { t: 'del'; kids: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; kids: Inline[] };

export type Block =
  | { t: 'p'; kids: Inline[] }
  | { t: 'h'; level: number; kids: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'quote'; lines: Inline[][] }
  | { t: 'hr' };

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Which links are allowed to be links.
 *
 * `javascript:` is the reason this function exists. A document's text is untrusted — an imported
 * `.docx` carries whatever was in it — and while the renderer emits React rather than HTML, an
 * `href` still reaches the DOM as an attribute and a `javascript:` URL in one still runs. Anything
 * not on this list is kept as the text it was, which is both safe and honest: the reader sees the
 * URL rather than a link that silently does nothing.
 */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === '') return null;
  if (href.startsWith('/') || href.startsWith('#')) return href;
  try {
    const { protocol } = new URL(href);
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? href : null;
  } catch {
    return null;
  }
}

/** The three wrapping marks, longest delimiter first so `**` is never read as two `*`. */
const WRAPS: { open: string; node: 'strong' | 'em' | 'del' }[] = [
  { open: '**', node: 'strong' },
  { open: '~~', node: 'del' },
  { open: '*', node: 'em' },
  { open: '_', node: 'em' },
];

/**
 * One line of text into inline nodes.
 *
 * A left-to-right walk rather than a set of regular expressions run over the whole string, because
 * the order matters and regexes do not compose: code has to win over emphasis (`` `a*b*c` `` is
 * three literal characters, not an italic `b`), and a link's text can be emphasised while its URL
 * cannot be. Walking once, deciding at each opening delimiter, gets both without backtracking.
 *
 * A delimiter that does not flank text is text — see `closerFor`, which is what keeps
 * `EBITDA * 8 * 2` arithmetic rather than turning ` 8 ` italic.
 */
export function inlines(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = (): void => {
    if (text !== '') out.push({ t: 'text', v: text });
    text = '';
  };

  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);

    // Code first: nothing inside a span of code is a mark.
    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        flush();
        out.push({ t: 'code', v: rest.slice(1, end) });
        i += end + 1;
        continue;
      }
    }

    if (rest.startsWith('[')) {
      const close = rest.indexOf('](');
      const end = close === -1 ? -1 : rest.indexOf(')', close);
      if (close > 0 && end > close) {
        const href = safeHref(rest.slice(close + 2, end));
        if (href !== null) {
          flush();
          out.push({ t: 'link', href, kids: inlines(rest.slice(1, close)) });
          i += end + 1;
          continue;
        }
      }
    }

    const wrap = WRAPS.find((w) => rest.startsWith(w.open));
    if (wrap) {
      const end = closerFor(rest, wrap.open, src[i - 1]);
      if (end !== -1) {
        flush();
        out.push({ t: wrap.node, kids: inlines(rest.slice(wrap.open.length, end)) });
        i += end + wrap.open.length;
        continue;
      }
    }

    text += src[i];
    i += 1;
  }
  flush();
  return out;
}

/**
 * Where a run of emphasis closes, or -1 if it does not open at all.
 *
 * This is CommonMark's flanking rule, and it is the difference between a parser this desk can type
 * into and one it cannot. **A delimiter only opens when a non-space follows it, and only closes
 * when a non-space precedes it** — so `EBITDA * 8 * 2` stays arithmetic, where a naive `indexOf`
 * makes ` 8 ` italic. People here write multiples with spaces around the asterisk constantly, and a
 * memo that silently re-renders its own arithmetic is one nobody will paste a calculation into.
 *
 * `_` carries the extra intra-word rule, which is what keeps `snake_case_name` one word rather than
 * a word with an italic in the middle of it.
 */
function closerFor(rest: string, open: string, before: string | undefined): number {
  const width = open.length;
  const afterOpen = rest[width];
  if (afterOpen === undefined || /\s/.test(afterOpen)) return -1;
  if (open === '_' && before !== undefined && /[A-Za-z0-9]/.test(before)) return -1;

  for (let at = rest.indexOf(open, width); at !== -1; at = rest.indexOf(open, at + width)) {
    // `at > width` rather than `!== -1`: `****` is four asterisks, not empty emphasis.
    if (at <= width) continue;
    const beforeClose = rest[at - 1];
    if (beforeClose === undefined || /\s/.test(beforeClose)) continue;
    if (open === '_') {
      const afterClose = rest[at + width];
      if (afterClose !== undefined && /[A-Za-z0-9]/.test(afterClose)) continue;
    }
    return at;
  }
  return -1;
}

/**
 * Text into blocks.
 *
 * Consecutive list items and quote lines gather into one block, because a list is one thing to a
 * reader and eight `<ul>`s of one item each is not a list. Everything else between blank lines is a
 * paragraph, and the line breaks inside it are kept — a memo written with one line per thought
 * should read back that way, which is what the reader's `pre-wrap` has always done.
 */
export function blocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];

  const endParagraph = (): void => {
    if (para.length > 0) out.push({ t: 'p', kids: inlines(para.join('\n')) });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim() === '') { endParagraph(); continue; }

    if (RULE.test(line)) { endParagraph(); out.push({ t: 'hr' }); continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      endParagraph();
      out.push({ t: 'h', level: heading[1]!.length, kids: inlines(heading[2]!) });
      continue;
    }

    if (BULLET.test(line)) {
      endParagraph();
      const items: Inline[][] = [];
      while (i < lines.length) {
        const m = BULLET.exec(lines[i]!);
        if (!m) break;
        items.push(inlines(m[1]!));
        i += 1;
      }
      i -= 1;
      out.push({ t: 'ul', items });
      continue;
    }

    if (ORDERED.test(line)) {
      endParagraph();
      const items: Inline[][] = [];
      const start = Number(ORDERED.exec(line)![1]);
      while (i < lines.length) {
        const m = ORDERED.exec(lines[i]!);
        if (!m) break;
        items.push(inlines(m[2]!));
        i += 1;
      }
      i -= 1;
      out.push({ t: 'ol', start, items });
      continue;
    }

    if (QUOTE.test(line)) {
      endParagraph();
      const quoted: Inline[][] = [];
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i]!);
        if (!m) break;
        quoted.push(inlines(m[1]!));
        i += 1;
      }
      i -= 1;
      out.push({ t: 'quote', lines: quoted });
      continue;
    }

    para.push(line);
  }
  endParagraph();
  return out;
}
