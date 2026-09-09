'use client';

import { useMemo, useState } from 'react';

/**
 * Reading a document this system extracted, rather than editing it.
 *
 * The transcripts run to fifty thousand characters — an hour of a management call — and nobody
 * reads one of those top to bottom. They arrive at it wanting the bit where somebody asked about
 * margins. So the control that matters is find, not scroll: every match is counted and highlighted,
 * and moving between them moves the page.
 *
 * **No editor.** This is what the company said, and the version history would otherwise end up
 * recording a colleague as the author of a paragraph the exchange published.
 */

const CONTEXT = 'stmt-mark';

export function DocumentText({ text }: { text: string }) {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);

  const q = query.trim();

  // Split rather than replace, so the text is never interpreted as markup. A transcript is
  // untrusted input — it came out of a PDF a third party filed — and building HTML from it would
  // be the one place in this system where that mattered.
  const { pieces, count } = useMemo(() => {
    if (q.length < 2) return { pieces: [text], count: 0 };
    const parts: string[] = [];
    const needle = q.toLowerCase();
    const hay = text.toLowerCase();
    let from = 0;
    for (;;) {
      const found = hay.indexOf(needle, from);
      if (found === -1) {
        parts.push(text.slice(from));
        break;
      }
      parts.push(text.slice(from, found), text.slice(found, found + q.length));
      from = found + q.length;
    }
    // Odd indexes are the matches.
    return { pieces: parts, count: (parts.length - 1) / 2 };
  }, [text, q]);

  const jump = (delta: number): void => {
    if (count === 0) return;
    const next = (at + delta + count) % count;
    setAt(next);
    document.getElementById(`m${next}`)?.scrollIntoView({ block: 'center' });
  };

  return (
    <div className="doc-read">
      <div className="sheet-bar">
        <input
          className="field"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setAt(0); }}
          placeholder="Find in this document…"
          aria-label="Find in this document"
        />
        <span className="sheet-detail">
          {q.length < 2
            ? `${text.length.toLocaleString('en-IN')} characters`
            : count === 0
              ? 'nothing found'
              : `${at + 1} of ${count}`}
        </span>
        <button type="button" className="btn btn-sm" onClick={() => jump(-1)} disabled={count === 0}>
          Previous
        </button>
        <button type="button" className="btn btn-sm" onClick={() => jump(1)} disabled={count === 0}>
          Next
        </button>
      </div>

      <div className="doc-body-read">
        {pieces.map((piece, i) =>
          i % 2 === 1 ? (
            <mark
              key={i}
              id={`m${(i - 1) / 2}`}
              className={(i - 1) / 2 === at ? `${CONTEXT} is-at` : CONTEXT}
            >
              {piece}
            </mark>
          ) : (
            <span key={i}>{piece}</span>
          ),
        )}
      </div>
    </div>
  );
}
