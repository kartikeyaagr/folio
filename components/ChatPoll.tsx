'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Refresh the route while a turn is being worked.
 *
 * The one client component the design system grants a polling exception to, and it renders nothing:
 * the "still reading" line is server-rendered like the rest of the page, and this only asks for the
 * page again. `v4.md §6.4` refuses streaming — *"Token-by-token rendering would cost the entire
 * architecture for a cosmetic gain to three people who read"* — so what a person sees is either the
 * question with a note under it, or the finished answer. Never a half-written one.
 *
 * Stops as soon as `active` goes false, which happens on the refresh that brings the answer back.
 */
export function ChatPoll({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs, router]);
  return null;
}
