'use client';

import { useState } from 'react';

/**
 * Prose.
 *
 * A textarea, deliberately. A rich-text editor is a dependency, a serialisation format and a class
 * of bug where what you see and what was stored disagree — and what this desk writes is sentences
 * about companies, not typography. The body is `{text}`, which is what `lib/ingest/extract.ts`
 * already stores for a transcript, so a note and an extracted document are the same shape.
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

  const words = text.trim() === '' ? 0 : text.trim().split(/\s+/).length;

  return (
    <div className="doc-edit">
      <div className="sheet-bar">
        <span className="sheet-detail">{words} {words === 1 ? 'word' : 'words'}</span>
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
      <textarea
        className="prose doc-body"
        value={text}
        onChange={(e) => { setText(e.target.value); setState('dirty'); }}
        placeholder="Write."
        spellCheck
      />
    </div>
  );
}
