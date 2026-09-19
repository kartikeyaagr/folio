import type { ReactNode } from 'react';

import { blocks, type Block, type Inline } from '@/lib/prose/parse.ts';

/**
 * A parsed document, rendered.
 *
 * **React elements, never HTML.** There is no `dangerouslySetInnerHTML` here and there cannot be
 * one: `lib/prose/parse.ts` produces a tree and this maps the tree to elements, so no string out of
 * a document is ever handed to the DOM as markup. `components/DocumentText.tsx` made the same
 * argument for the transcript reader before this existed — a document's text is untrusted, because
 * an imported `.docx` carries whatever a third party put in it.
 *
 * The one place a document's own string still reaches an attribute is a link's `href`, and
 * `safeHref` in the parser is what stands there: anything that is not http, https, mailto or a
 * relative path never becomes a link at all, so the reader sees the URL as text rather than a link
 * that silently does nothing.
 */

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text': return <span key={i}>{n.v}</span>;
      case 'strong': return <strong key={i}>{renderInline(n.kids)}</strong>;
      case 'em': return <em key={i}>{renderInline(n.kids)}</em>;
      case 'del': return <del key={i}>{renderInline(n.kids)}</del>;
      case 'code': return <code key={i}>{n.v}</code>;
      case 'link':
        return (
          // `noreferrer` with `_blank` for the usual reason, and because a document can link
          // anywhere a third party wrote into it.
          <a key={i} href={n.href} target="_blank" rel="noreferrer">
            {renderInline(n.kids)}
          </a>
        );
    }
  });
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p': return <p key={key}>{renderInline(b.kids)}</p>;
    case 'hr': return <hr key={key} />;
    case 'h': {
      // Levels beyond three render as the third. A memo with a fifth-level heading has a structure
      // problem that a smaller font will not fix.
      const kids = renderInline(b.kids);
      if (b.level === 1) return <h1 key={key}>{kids}</h1>;
      if (b.level === 2) return <h2 key={key}>{kids}</h2>;
      return <h3 key={key}>{kids}</h3>;
    }
    case 'ul':
      return (
        <ul key={key}>
          {b.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      );
    case 'ol':
      return (
        <ol key={key} start={b.start}>
          {b.items.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ol>
      );
    case 'quote':
      return (
        <blockquote key={key}>
          {b.lines.map((line, i) => <p key={i}>{renderInline(line)}</p>)}
        </blockquote>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  return <>{blocks(text).map(renderBlock)}</>;
}
