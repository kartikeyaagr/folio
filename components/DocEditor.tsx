'use client';

import { useRef, useState } from 'react';

import { applyMark, type Mark } from '@/lib/prose/marks.ts';

import { DocToolbar } from './DocToolbar.tsx';
import { Markdown } from './Markdown.tsx';

/**
 * Prose.
 *
 * **Still a textarea.** The argument that kept it one has not changed: a rich-text editor is a
 * dependency, a serialisation format, and a class of bug where what you see and what was stored
 * disagree. What the toolbar writes is markdown, so the body stays `{text}` — the same shape
 * `lib/ingest/extract.ts` stores for a transcript — a diff of two versions stays readable, the
 * chunker keeps indexing the same characters, and a memo written here is still a memo somewhere
 * else. `lib/prose/parse.ts` has the longer version.
 *
 * The cost of that choice is that `**bold**` reads as asterisks while you type it, so Read renders
 * the document as it will be read. A toggle rather than a second pane: a split view needs a
 * scroll-sync and an answer to which half has the keyboard, and neither earns its place in a memo.
 *
 * Saving is explicit. An autosave that fires mid-sentence fills the version history with fragments,
 * and the version history is the reason every save is a new row.
 */
export function DocEditor({
  id,
  text: initial,
  onSave,
}: {
  id: string;
  text: string;
  /** The server action itself; an arrow closing over the id cannot cross into a client component. */
  onSave: (id: string, text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'error'>('clean');
  const [message, setMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const body = useRef<HTMLTextAreaElement>(null);

  const save = async (): Promise<void> => {
    setState('saving');
    try {
      await onSave(id, text);
      setState('clean');
      setMessage(null);
    } catch (err) {
      setState('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  /**
   * Apply a mark to whatever is selected.
   *
   * The selection has to be put back by hand. Setting a textarea's value collapses the caret to the
   * end, so pressing Bold on a word in the middle of a memo would leave you typing at the bottom of
   * it — and `setSelectionRange` has to happen after React has painted the new value, which is what
   * the frame wait is for rather than any timing luck.
   */
  const mark = (kind: Mark): void => {
    const el = body.current;
    if (!el) return;
    const next = applyMark(text, el.selectionStart, el.selectionEnd, kind);
    setText(next.text);
    setState('dirty');
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
  };

  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  return (
    <div className="doc-edit">
      <DocToolbar
        words={words}
        reading={reading}
        disabled={state === 'saving'}
        onMark={mark}
        onToggleRead={() => setReading((r) => !r)}
      />

      <div className="sheet-bar">
        <span className="sheet-detail">
          {reading
            ? 'Reading. The toolbar writes markdown — ** for bold, # for a heading, - for a list.'
            : 'Markdown: ** for bold, # for a heading, - for a list. The eye reads it back.'}
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={state === 'saving' || state === 'clean'}
        >
          {state === 'saving' ? 'Saving…' : state === 'clean' ? 'Saved' : 'Save'}
        </button>
      </div>
      {message && <p className="alert">{message}</p>}

      {reading ? (
        <div className="prose doc-body-read doc-rendered">
          <Markdown text={text} />
        </div>
      ) : (
        <textarea
          ref={body}
          className="prose doc-body"
          value={text}
          onChange={(e) => { setText(e.target.value); setState('dirty'); }}
          placeholder="Write."
          spellCheck
        />
      )}
    </div>
  );
}
