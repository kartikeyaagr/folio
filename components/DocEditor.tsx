'use client';

import { useCallback, useRef, useState } from 'react';

import type { Mark } from '@/lib/prose/marks.ts';
import { typographyClasses, type Typography } from '@/lib/prose/typography.ts';

import { DocToolbar } from './DocToolbar.tsx';
import { RichEditor } from './RichEditor.tsx';
import { SaveSlot } from './SaveSlot.tsx';

/**
 * Prose.
 *
 * **What you edit is the document; what is stored is text.** The toolbar no longer writes markdown
 * into a textarea for you to look at — `components/RichEditor.tsx` renders the stored markdown as a
 * document and serialises it back on every keystroke, so the asterisks exist in the row and nowhere
 * on the screen.
 *
 * The body stays `{text}` for the reasons it always has, and they are not aesthetic:
 * `lib/retrieval/` chunks that text and counts character offsets into it for citations,
 * `lib/export/docx.ts` parses it to build the Word file, the version history diffs it, and a memo
 * that is text is a memo that outlives this app. Storing a document format instead would trade all
 * of that for a file the database cannot read.
 *
 * Saving is explicit. An autosave that fires mid-sentence fills the version history with fragments,
 * and the version history is the reason every save is a new row.
 */
export function DocEditor({
  id,
  text: initial,
  type: initialType,
  onSave,
}: {
  id: string;
  text: string;
  type: Typography;
  /** The server action itself; an arrow closing over the id cannot cross into a client component. */
  onSave: (id: string, text: string, type: Typography) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  const [type, setType] = useState<Typography>(initialType);
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'error'>('clean');
  const [message, setMessage] = useState<string | null>(null);
  // The editor hands its apply function up rather than the toolbar reaching into the DOM: the
  // selection belongs to the element that owns it.
  const apply = useRef<((mark: Mark) => void) | null>(null);

  const onChange = useCallback((markdown: string) => {
    setText(markdown);
    setState((s) => (s === 'saving' ? s : 'dirty'));
  }, []);

  const onReady = useCallback((fn: (mark: Mark) => void) => {
    apply.current = fn;
  }, []);

  const save = async (): Promise<void> => {
    setState('saving');
    try {
      await onSave(id, text, type);
      setState('clean');
      setMessage(null);
    } catch (err) {
      setState('error');
      setMessage(String(err instanceof Error ? err.message : err));
    }
  };

  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  return (
    <div className="doc-edit">
      <DocToolbar
        words={words}
        disabled={state === 'saving'}
        type={type}
        onMark={(mark) => apply.current?.(mark)}
        onType={(next) => { setType((t) => ({ ...t, ...next })); setState('dirty'); }}
      />

      {/* Up in the ribbon with the other things you do to a document, rather than in a bar of its
          own between the toolbar and the page. The bar held a line of advice and this button; the
          advice is in the toolbar's tooltips and the word count is in its first slot, so removing
          it costs nothing and gives the document back thirty pixels of the screen. */}
      <SaveSlot>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void save()}
          disabled={state === 'saving' || state === 'clean'}
        >
          {state === 'saving' ? 'Saving…' : state === 'clean' ? 'Saved' : 'Save'}
        </button>
      </SaveSlot>

      {message && <p className="alert">{message}</p>}

      {/* The typography is a class on the writing surface, so what you type into is set the way the
          document is set — and the same `cf-face-*` / `cf-size-*` rules a spreadsheet cell uses. */}
      <RichEditor
        text={initial}
        className={typographyClasses(type)}
        onChange={onChange}
        onReady={onReady}
      />
    </div>
  );
}
