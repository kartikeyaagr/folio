'use client';

import { useEffect, useState } from 'react';

import { FLASH_COOKIE } from '@/app/_lib/flash-cookie.ts';
import type { Flash } from '@/app/_lib/flash.ts';

/**
 * Shows a flash message once, then forgets it.
 *
 * The cookie is deleted the moment the message is shown, so a refresh does not repeat it and a
 * message set by one action cannot be mistaken for the outcome of the next.
 *
 * **The effect keys on the occurrence, not on the text.** Keyed on the text, two identical
 * confirmations in a row fired it once: "Queued again" twice in ten seconds showed one toast and
 * read as the second click having done nothing. Both fields are read out of `flash` rather than
 * the object being the dependency, because the object is rebuilt on every render of the layout
 * and an unchanged flash would then repeat itself.
 */
export function Toast({ flash }: { flash: Flash | null }) {
  const [shown, setShown] = useState<string | null>(null);
  const message = flash?.message ?? null;
  const occurrence = flash?.occurrence ?? null;

  useEffect(() => {
    if (!message) return;
    document.cookie = `${FLASH_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
    setShown(message);
    const t = setTimeout(() => setShown(null), 2800);
    return () => clearTimeout(t);
  }, [message, occurrence]);

  if (!shown) return null;
  return (
    <div role="status" className="toast">
      {shown}
    </div>
  );
}
