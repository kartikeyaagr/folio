'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keeps a page in step with a backfill running server-side.
 *
 * `router.refresh()` re-runs the page's server component against the same URL, so what this polls
 * for — a step index, a trading-day count — is never held client-side; it only asks Next to ask
 * again. Ticks only while `active`, so a page with nothing running never opens a timer.
 */
export function RefreshWhile({ active, seconds = 4 }: { active: boolean; seconds?: number }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [active, seconds, router]);

  return null;
}
