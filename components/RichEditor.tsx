'use client';

import { useEffect, useRef } from 'react';

import { blocks, safeHref, type Block, type Inline } from '@/lib/prose/parse.ts';
import type { Mark } from '@/lib/prose/marks.ts';

/**
 * Writing, with the formatting visible instead of spelled out.
 *
 * **Stored as text, shown as a document.** The body is still `{text}` and still markdown, because
 * everything downstream depends on that — `lib/retrieval/` chunks it and counts character offsets
 * into it for citations, the version history diffs it, `lib/export/docx.ts` parses it, and a memo
 * that is text is a memo that outlives this app. What changed is that nobody has to look at the
 * asterisks: the markdown is parsed into a document on the way in and serialised back on the way
 * out, and in between you are editing the document.
 *
 * **Built with `createElement` and `textContent`, never `innerHTML`.** A document's text is
 * untrusted — an imported `.docx` carries whatever a third party put in it — and the rule that
 * `components/DocumentText.tsx` and `components/Markdown.tsx` both keep is that no string out of a
 * document is ever handed to the DOM as markup. Constructing elements and setting their text is not
 * that: there is no parser to confuse, so there is nothing to smuggle past it.
 *
 * **The commands are `execCommand`, and the serialiser is what makes that safe.** It is deprecated
 * and its output is inconsistent — a `<b>` here, a nested `<span style="font-weight:700">` there,
 * a `<div>` where a `<p>` belonged. Nothing browsers offer replaces what it does well, which is
 * selection, composition and undo across every edge case a text editor has. So it is used for the
 * editing and trusted for none of the markup: `toMarkdown` below reads only the shapes it knows and
 * drops the rest, so whatever `execCommand` leaves behind is normalised out before it is stored.
 * That inverts the usual problem with contenteditable — the mess cannot accumulate, because the
 * document is rewritten from the stored text every time it is opened.
 */

/** The marks this editor can express, and the command that produces each. */
const COMMANDS: Record<Mark, { cmd: string; value?: string } | null> = {
  bold: { cmd: 'bold' },
  italic: { cmd: 'italic' },
  strike: { cmd: 'strikeThrough' },
  code: null, // wrapped by hand below: there is no execCommand for inline code
  h1: { cmd: 'formatBlock', value: 'h1' },
  h2: { cmd: 'formatBlock', value: 'h2' },
  h3: { cmd: 'formatBlock', value: 'h3' },
  bullet: { cmd: 'insertUnorderedList' },
  number: { cmd: 'insertOrderedList' },
  quote: { cmd: 'formatBlock', value: 'blockquote' },
  link: null, // needs a URL, so it is prompted for below
  rule: { cmd: 'insertHorizontalRule' },
  undo: { cmd: 'undo' },
  redo: { cmd: 'redo' },
  // Strips the marks and leaves the words. `execCommand` handles the selection arithmetic; the
  // serialiser then drops whatever it left behind, which is the whole arrangement in one line.
  clear: { cmd: 'removeFormat' },
};

// ---- markdown into a document -----------------------------------------------------------------

function inlineNodes(nodes: Inline[], into: Node): void {
  for (const n of nodes) {
    switch (n.t) {
      case 'text': into.appendChild(document.createTextNode(n.v)); break;
      case 'code': {
        const el = document.createElement('code');
        el.textContent = n.v;
        into.appendChild(el);
        break;
      }
      case 'strong': case 'em': case 'del': {
        const el = document.createElement(n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 's');
        inlineNodes(n.kids, el);
        into.appendChild(el);
        break;
      }
      case 'link': {
        const el = document.createElement('a');
        // Already through `safeHref` in the parser; set as an attribute on an element we made,
        // never as part of a markup string.
        el.setAttribute('href', n.href);
        inlineNodes(n.kids, el);
        into.appendChild(el);
        break;
      }
    }
  }
}

function blockNode(b: Block): HTMLElement {
  switch (b.t) {
    case 'hr': return document.createElement('hr');
    case 'h': {
      const el = document.createElement(`h${Math.min(b.level, 3)}`);
      inlineNodes(b.kids, el);
      return el;
    }
    case 'p': {
      const el = document.createElement('p');
      // A paragraph's own line breaks become `<br>`, because a contenteditable does not honour
      // `pre-wrap` the way a static reader does and Enter has to mean something predictable.
      const parts = b.kids;
      inlineNodes(parts, el);
      return el;
    }
    case 'ul': case 'ol': {
      const el = document.createElement(b.t);
      for (const item of b.items) {
        const li = document.createElement('li');
        inlineNodes(item, li);
        el.appendChild(li);
      }
      return el;
    }
    case 'quote': {
      const el = document.createElement('blockquote');
      for (const line of b.lines) {
        const p = document.createElement('p');
        inlineNodes(line, p);
        el.appendChild(p);
      }
      return el;
    }
  }
}

// ---- a document back into markdown --------------------------------------------------------------

/** Characters that would be read back as a mark if they were left bare at the start of a line. */
const escapeLine = (s: string): string => s.replace(/^(\s*)([#>-]|\d+[.)])(\s)/, '$1\\$2$3');

/**
 * The inline text of a node, with its marks.
 *
 * Only the shapes this editor produces are recognised. Anything else — a `<span style>` that
 * `execCommand` left behind, a `<font>`, a pasted `<table>` — contributes its text and nothing
 * more, which is what keeps a paste from a website out of the stored document.
 */
function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const inner = [...el.childNodes].map(inlineText).join('');

  switch (el.tagName) {
    case 'BR': return '\n';
    case 'B': case 'STRONG': return inner.trim() === '' ? inner : `**${inner}**`;
    case 'I': case 'EM': return inner.trim() === '' ? inner : `*${inner}*`;
    case 'S': case 'STRIKE': case 'DEL': return inner.trim() === '' ? inner : `~~${inner}~~`;
    case 'CODE': return inner.trim() === '' ? inner : `\`${inner}\``;
    case 'A': {
      const href = safeHref(el.getAttribute('href') ?? '');
      return href === null ? inner : `[${inner}](${href})`;
    }
    default: return inner;
  }
}

/** One block element to its markdown lines. Unknown blocks contribute their text as a paragraph. */
function blockText(el: HTMLElement): string {
  const inner = inlineText(el);
  switch (el.tagName) {
    case 'H1': return `# ${inner}`;
    case 'H2': return `## ${inner}`;
    case 'H3': case 'H4': case 'H5': case 'H6': return `### ${inner}`;
    case 'HR': return '---';
    case 'BLOCKQUOTE':
      return [...el.children].length > 0
        ? [...el.children].map((c) => `> ${inlineText(c)}`).join('\n')
        : `> ${inner}`;
    case 'UL': return [...el.children].map((li) => `- ${inlineText(li)}`).join('\n');
    case 'OL': return [...el.children].map((li, i) => `${i + 1}. ${inlineText(li)}`).join('\n');
    default: return escapeLine(inner);
  }
}

export function toMarkdown(root: HTMLElement): string {
  const out: string[] = [];
  for (const child of [...root.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent ?? '';
      if (t.trim() !== '') out.push(escapeLine(t));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    out.push(blockText(child as HTMLElement));
  }
  // A blank line between blocks, which is what the parser reads back as a block boundary.
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- the editor -----------------------------------------------------------------------------------

export function RichEditor({
  text,
  className = '',
  onChange,
  onReady,
}: {
  text: string;
  /** The document's typography, as classes. See `lib/prose/typography.ts`. */
  className?: string;
  /** The markdown the document currently serialises to. */
  onChange: (markdown: string) => void;
  /** Handed the apply function, so the toolbar above can drive this without owning the DOM. */
  onReady: (apply: (mark: Mark) => void) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  // The text as it was last loaded in. Compared against on every render so a save round-trip does
  // not rebuild the DOM under the caret — which would collapse the selection mid-sentence.
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || loaded.current === text) return;
    loaded.current = text;
    el.replaceChildren(...blocks(text).map(blockNode));
    // A document that parsed to nothing still needs somewhere to put the caret.
    if (el.childNodes.length === 0) el.appendChild(document.createElement('p'));
  }, [text]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;

    const apply = (mark: Mark): void => {
      el.focus();
      const command = COMMANDS[mark];
      if (command) {
        document.execCommand(command.cmd, false, command.value);
      } else if (mark === 'link') {
        const href = window.prompt('Link to');
        const safe = href === null ? null : safeHref(href);
        // Refused rather than inserted dead: a link that goes nowhere is worse than none.
        if (safe !== null) document.execCommand('createLink', false, safe);
      } else if (mark === 'code') {
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        if (range && !range.collapsed) {
          const code = document.createElement('code');
          code.textContent = range.toString();
          range.deleteContents();
          range.insertNode(code);
        }
      }
      loaded.current = toMarkdown(el);
      onChange(loaded.current);
    };

    onReady(apply);
  }, [onChange, onReady]);

  return (
    <div
      ref={root}
      className={`prose doc-body doc-rendered doc-write ${className}`.trim()}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      role="textbox"
      aria-multiline="true"
      aria-label="Document"
      onInput={() => {
        const el = root.current;
        if (!el) return;
        loaded.current = toMarkdown(el);
        onChange(loaded.current);
      }}
      onPaste={(e) => {
        // Plain text only. A paste from a website carries its stylesheet, its tracking attributes
        // and its `<script>`; letting the browser insert that markup is the one way markup could
        // reach a document without going through the builder above.
        e.preventDefault();
        const plain = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, plain);
      }}
    />
  );
}
