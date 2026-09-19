'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A client editor's Save button, rendered up in the page's ribbon.
 *
 * The two halves belong to different worlds. Whether a document is dirty is client state and lives
 * in the editor that owns the text; the ribbon is server-rendered, and this page has to stay a
 * server component — `CLAUDE.md` puts it plainly: state lives in the URL, pages stay server
 * components, a refresh lands where you were. Hoisting the ribbon into a client component to get
 * one button into it would drag the history table and the provenance dialog across the boundary
 * with it.
 *
 * So the page renders an empty slot and the editor fills it from where it already is. A portal is
 * the React-shaped answer to exactly this: the button stays inside the editor's tree — its state,
 * its handlers, its disabled logic — and appears somewhere else in the document.
 *
 * Renders nothing until the slot is found, which is after mount by definition. The server pass and
 * the first client pass therefore agree on nothing being there, so there is no hydration mismatch
 * to explain away.
 */

/** The id the page puts on the empty span. One definition, imported by both sides. */
export const SAVE_SLOT = 'doc-save';

export function SaveSlot({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<Element | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(SAVE_SLOT));
  }, []);

  return slot ? createPortal(children, slot) : null;
}
