'use client';

import { useEffect, useState } from 'react';

import { FLASH_COOKIE } from '@/app/_lib/flash-cookie.ts';

/**
 * Shows a flash message once, then forgets it.
 *
 * The cookie is deleted the moment the message is shown, so a refresh does not repeat it and a
 * message set by one action cannot be mistaken for the outcome of the next.
 */
export function Toast({ message }: { message: string | null }) {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    document.cookie = `${FLASH_COOKIE}=; Max-Age=0; path=/; SameSite=Lax`;
    setShown(message);
    const t = setTimeout(() => setShown(null), 2800);
    return () => clearTimeout(t);
  }, [message]);

  if (!shown) return null;
  return (
    <div role="status" className="toast">
      {shown}
    </div>
  );
}
