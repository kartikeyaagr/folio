'use client';

import { useEffect, useState, useTransition } from 'react';

import type { Theme } from '@/app/_lib/theme.ts';

/**
 * Light or dark, remembered.
 *
 * The attribute flips immediately so the click is answered in the same frame; the server action
 * then stores the choice, so the next full render already knows. With no stored choice the icon
 * reflects whatever the operating system decided.
 */
export function ThemeToggle({
  theme,
  action,
}: {
  theme: Theme | null;
  action: (theme: Theme) => Promise<void>;
}) {
  const [current, setCurrent] = useState<Theme>(theme ?? 'light');
  const [, start] = useTransition();

  useEffect(() => {
    if (theme) return;
    setCurrent(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }, [theme]);

  const next: Theme = current === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className="rail-icon"
      title={`Switch to ${next} theme`}
      onClick={() => {
        setCurrent(next);
        document.documentElement.dataset.theme = next;
        start(() => action(next));
      }}
    >
      {current === 'dark' ? (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2m-7.07-15.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  );
}
