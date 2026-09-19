'use client';

import { useEffect, useState, useTransition } from 'react';

import type { SecurityHit } from '@/app/_lib/actions/companies.ts';

/**
 * Pick a name out of the security master and follow it.
 *
 * Lives inside the add dialog, so the result list sits **in flow** rather than floating: a native
 * dialog clips anything that leaves it, and a list that grows scrolls where a popover would be cut
 * off. `styles/companies.css` says the same thing next to `.picker-pop`.
 *
 * Each result is itself the submit button, carrying its symbol as the form value. That keeps the
 * whole control one server action with no client-side state to get out of step with the list, and
 * it means the thing you clicked is the thing that was submitted.
 */
export function FollowPicker({
  search,
  follow,
}: {
  search: (query: string) => Promise<SecurityHit[]>;
  follow: (form: FormData) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SecurityHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearched(false);
      return;
    }
    // Debounced, because a keystroke is not a question.
    const t = setTimeout(() => {
      start(() => {
        search(q).then((rows) => {
          setHits(rows);
          setSearched(true);
        });
      });
    }, 150);
    return () => clearTimeout(t);
  }, [query, search]);

  return (
    <form action={follow}>
      <div className={pending ? 'picker is-pending' : 'picker'}>
        <label className="lbl">
          Symbol or company name
          <input
            className="field field-lg"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="PRAJIND, or Praj Industries…"
            aria-label="Search the security master"
            autoComplete="off"
            autoFocus
          />
        </label>

        {hits.length > 0 && (
          <div className="picker-pop" role="listbox">
            {hits.map((hit) => (
              <button
                key={hit.symbol}
                type="submit"
                name="symbol"
                value={hit.symbol}
                className="search-hit"
                disabled={hit.followed}
                title={
                  hit.followed
                    ? `${hit.symbol} is already followed`
                    : `Follow ${hit.symbol}`
                }
              >
                <b>{hit.symbol}</b>
                <span className="name">{hit.name}</span>
                <span className="stage">
                  {hit.followed
                    ? 'Followed'
                    : hit.platform === 'nse_emerge'
                      ? 'SME'
                      : 'Mainboard'}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Three states, said apart. Nothing typed is not the same as nothing found, and neither
            is the same as a search still running — a picker that shows "Nothing matches" while it
            is still asking teaches you to distrust it. */}
        {query.trim() === '' ? (
          <p className="picker-none">
            Every listed name, mainboard and SME. Following one brings its filings, and starts its
            results, prices and calendar from the next run.
          </p>
        ) : searched && hits.length === 0 && !pending ? (
          <p className="picker-none">
            Nothing matches “{query.trim()}”. If it listed recently, refresh the security master
            first.
          </p>
        ) : null}
      </div>
    </form>
  );
}
