'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * A search box over a list the server already rendered.
 *
 * Filters the DOM rather than refetching: the list is already here, bounded, and complete for the
 * window it covers, so a round trip per keystroke would be slower and would tell the reader
 * nothing new. This is why the filter is *not* in the URL, unlike the range and the basis — those
 * choose what the page is about, and this only chooses what you can see of it. Reload and you are
 * looking at the same page, which is the test for whether something belongs in the URL.
 *
 * Matches against a `data-text` attribute the server puts on each row, so the haystack is chosen
 * deliberately — a headline and its source, not the mechanism paragraph underneath it — rather
 * than being whatever text happened to land in the element.
 */
export function FilterList({
  placeholder,
  label,
  /**
   * Cap the list at this many rows, measured rather than guessed.
   *
   * A fixed height in rem only approximates "three stories": a two-line headline makes a taller
   * row, and the same cap then shows two and a half. This measures the rows actually rendered and
   * cuts at the bottom edge of the nth, so three stories is three stories whatever their headlines
   * do — which is what makes it dynamic rather than merely capped.
   */
  show,
  children,
}: {
  placeholder: string;
  label: string;
  show?: number;
  children: React.ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState<number | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const rows = box.current?.querySelectorAll<HTMLElement>('[data-text]');
    if (!rows) return;
    const needle = query.trim().toLowerCase();
    let hits = 0;
    for (const row of rows) {
      const hit = needle === '' || (row.dataset['text'] ?? '').includes(needle);
      row.hidden = !hit;
      if (hit) hits++;
    }
    setTotal(rows.length);
    setShown(needle === '' ? null : hits);
  }, [query, children]);

  // Re-measured when the filter changes, because hiding rows changes which one is nth, and on
  // resize, because a narrower card wraps headlines onto more lines.
  useEffect(() => {
    if (!show) return;
    const list = box.current?.querySelector<HTMLElement>('.scroll-box');
    if (!list) return;

    const measure = (): void => {
      const rows = [...list.querySelectorAll<HTMLElement>('[data-text]')].filter((r) => !r.hidden);
      if (rows.length <= show) {
        // Fewer rows than the cap: no scroll, and no height forced on a short list either.
        list.style.removeProperty('--rows-cap');
        return;
      }
      const top = list.getBoundingClientRect().top;
      const nth = rows[show - 1]!.getBoundingClientRect().bottom;
      // A custom property, not an inline `style.maxHeight`. Styling stays in the stylesheet where
      // it can express a hover or a media query; only the measured number crosses over, and
      // `.scroll-box` falls back to its rem cap when nothing has measured yet.
      list.style.setProperty('--rows-cap', `${Math.round(nth - top + list.scrollTop)}px`);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    return () => ro.disconnect();
  }, [show, query, children]);

  return (
    <div className="filterable" ref={box}>
      <div className="filter-bar">
        <input
          className="field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          type="search"
          autoComplete="off"
        />
        {/* Says how many of how many, not just how many. "3 shown" leaves a reader wondering
            whether the other twenty are filtered out or were never there. */}
        {shown !== null && (
          <span className="filter-count">
            {shown} of {total}
            {shown === 0 && ' — nothing matches'}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
