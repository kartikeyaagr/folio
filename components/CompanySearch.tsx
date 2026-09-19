'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { CompanyHit } from '@/app/_lib/actions/search.ts';

/**
 * Jump to a company. ⌘K focuses it from anywhere.
 *
 * Debounced, because a keystroke is not a question. Enter opens the highlighted hit; Escape
 * clears. The list shows the stage so a killed name is not opened by mistake.
 */
/** Stable ids, so the input can point at the option the arrow keys have landed on. */
const LIST_ID = 'company-search-list';
const optionId = (i: number): string => `${LIST_ID}-${i}`;

export function CompanySearch({ search }: { search: (query: string) => Promise<CompanyHit[]> }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<CompanyHit[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setOpen(false);
      return;
    }
    const t = setTimeout(() => {
      search(q).then((rows) => {
        setHits(rows);
        setSel(0);
        setOpen(true);
      });
    }, 150);
    return () => clearTimeout(t);
  }, [query, search]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const go = (hit: CompanyHit) => {
    setQuery('');
    setOpen(false);
    router.push(`/company/${encodeURIComponent(hit.symbol)}`);
  };

  return (
    <div ref={box} className="search">
      <label className="search-box">
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setOpen(false);
              input.current?.blur();
              return;
            }
            if (!open || hits.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, hits.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              const hit = hits[sel];
              if (hit) go(hit);
            }
          }}
          placeholder="Jump to a company…"
          aria-label="Jump to a company"
          autoComplete="off"
          // The arrow keys move a highlight through the list below. Without these the highlight is
          // visible and announced to nobody: the option carried `aria-selected` and the input said
          // nothing about owning a list, so a screen reader read the typing and not the result.
          role="combobox"
          aria-expanded={open}
          aria-controls={LIST_ID}
          aria-autocomplete="list"
          aria-activedescendant={open && hits[sel] ? optionId(sel) : undefined}
        />
        <kbd aria-hidden="true">⌘K</kbd>
      </label>
      {open && (
        <div className="search-pop" role="listbox" id={LIST_ID}>
          {hits.map((hit, i) => (
            <button
              key={hit.symbol}
              id={optionId(i)}
              type="button"
              role="option"
              aria-selected={i === sel}
              // Not a tab stop: the input keeps the keyboard and points at the active option with
              // `aria-activedescendant`, which is the pattern that makes the highlight audible.
              tabIndex={-1}
              className="search-hit"
              onMouseEnter={() => setSel(i)}
              onClick={() => go(hit)}
            >
              <b>{hit.symbol}</b>
              <span className="name">{hit.name}</span>
              <span className="stage">{hit.stage}</span>
            </button>
          ))}
          {hits.length === 0 && <p className="search-none">Nothing matches.</p>}
        </div>
      )}
    </div>
  );
}
