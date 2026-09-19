'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The document's title, renamed where it is written.
 *
 * There has been a Rename button behind a dialog since the ribbon existed, and a dialog is the
 * wrong shape for this: renaming a memo is a two-second correction of a typo in a filename, not a
 * decision that wants a form and a confirmation. Every document editor worth using lets you click
 * the title. So this does.
 *
 * **A button until it is clicked**, rather than an always-live input. A permanently editable
 * heading invites a stray keystroke into the one field the document is found by, and it reads as a
 * form rather than as a title. Escape abandons, Enter and blur commit, and an empty title is
 * refused by `renameDocument` on the server — which is where it has always been refused.
 */
export function TitleEdit({
  id,
  title,
  onRename,
}: {
  id: string;
  title: string;
  /** The server action itself; an arrow closing over the id cannot cross the client boundary. */
  onRename: (id: string, title: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  // The server is the source of truth: after a rename the page revalidates and arrives with the new
  // title, and if the rename was refused it arrives with the old one. Either way the draft follows.
  useEffect(() => setDraft(title), [title]);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  const commit = async (): Promise<void> => {
    setEditing(false);
    const wanted = draft.trim();
    if (wanted === '' || wanted === title) {
      setDraft(title);
      return;
    }
    setSaving(true);
    try {
      await onRename(id, wanted);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        className="app-title app-title-edit"
        title="Click to rename"
        disabled={saving}
        onClick={() => setEditing(true)}
      >
        {saving ? draft : title}
      </button>
    );
  }

  return (
    <input
      ref={input}
      className="app-title app-title-input"
      value={draft}
      aria-label="Title"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(); }
        // Escape puts the old title back before the blur that follows can commit the draft.
        if (e.key === 'Escape') { e.preventDefault(); setDraft(title); setEditing(false); }
      }}
    />
  );
}
