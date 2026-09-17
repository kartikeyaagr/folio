'use client';

import { useState } from 'react';

import { RANGES, windowOf, type History, type Range, type Series } from '@/lib/prices.ts';
import { Blank, inr, signedPct } from './ui.tsx';

/**
 * Closes over a window, as an SVG.
 *
 * No charting library. The whole of it is a polyline over a scaled set of points, and a dependency
 * for that would be forty kilobytes of client JavaScript to draw a line — the reuse ladder says the
 * standard library first, and here the standard library is SVG.
 *
 * **The range is component state, not a query parameter, and this is the page's one exception to
 * "state lives in the URL".** It was a parameter until 17-Sep-2026: every range button was a link,
 * so looking at five years and then at one month re-rendered the whole company page twice to redraw
 * a line over closes the browser could already have had. The page holds a lot besides the chart —
 * the documents panel, the shareholding, the coverage form — and none of it changes when you want
 * to see a different window.
 *
 * What the URL rule is there to protect is a refresh landing where you were, and what it protects
 * against is losing a filter you chose deliberately. A chart zoom is neither: it is a lens on data
 * already on the page, it costs one click to restore, and the default it falls back to is the whole
 * history rather than an arbitrary slice of it. The rest of this page's state — `?archived=` — still
 * lives in the URL and still should.
 *
 * Server-rendered on first paint like any client component, so there is no empty frame before the
 * line appears; `windowOf` is pure and runs identically on both sides.
 *
 * The y-axis is deliberately **not** zero-based. A stock at ₹700 that moved ₹40 is a 6% move, and a
 * chart anchored at zero flattens it into a straight line; the low and high are labelled so the
 * scale is stated rather than inferred.
 */

const W = 1000;
const H = 220;
const PAD_Y = 12;

function path(series: Series): string {
  const { points, low, high } = series;
  if (points.length < 2 || low === null || high === null) return '';
  // A flat series has no range to scale against; centre it rather than dividing by zero.
  const span = high - low || 1;
  const stepX = W / (points.length - 1);
  return points
    .map((p, i) => {
      const x = i * stepX;
      const y = PAD_Y + (1 - (p.close - low) / span) * (H - PAD_Y * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * Max, because the first question a chart answers is "what has this done", and a default of one
 * year answers it only for a name that has been listed longer than that. Everything is loaded
 * anyway — narrowing is free and widening used to cost a page load.
 */
const DEFAULT_RANGE: Range = 'max';

export function PriceChart({ history }: { history: History }) {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  const series = windowOf(history, range);
  const d = path(series);
  const rising = (series.change?.pct ?? 0) >= 0;

  return (
    <div className="chart">
      <div className="chart-head">
        {series.change ? (
          <>
            <b className="chart-last">{inr(series.change.to)}</b>
            <span className={rising ? 'chart-move is-up' : 'chart-move is-down'}>
              {signedPct(series.change.pct)}
            </span>
            <span className="chart-span">
              {series.points[0]?.on} → {series.points[series.points.length - 1]?.on}
            </span>
          </>
        ) : series.points.length === 1 ? (
          <b className="chart-last">{inr(series.points[0]!.close)}</b>
        ) : null}

        <span className="spacer" />

        {/* Every range is offered whether or not it has data behind it. A range that quietly
            disappeared would leave a reader unsure whether the company is young, the ingest is
            behind, or the button was never there — and the chart says which below. */}
        {/* Buttons, not links: nothing is being navigated to. `aria-pressed` rather than
            `aria-current` for the same reason — these are toggles over one view, not positions in a
            set of pages. `type="button"` because the chart sits inside a page that has forms on it,
            and a bare <button> submits the nearest one. */}
        <nav className="chart-ranges" aria-label="Range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              aria-pressed={r.key === range}
            >
              {r.label}
            </button>
          ))}
        </nav>
      </div>

      {d ? (
        <>
          <svg
            className="chart-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Closing price, ${series.points[0]?.on} to ${series.points[series.points.length - 1]?.on}`}
          >
            <path className={rising ? 'line is-up' : 'line is-down'} d={d} />
          </svg>
          <div className="chart-foot">
            <span>low {inr(series.low)}</span>
            <span>high {inr(series.high)}</span>
            <span className="spacer" />
            <span>
              {series.points.length} close{series.points.length === 1 ? '' : 's'}
            </span>
          </div>
        </>
      ) : (
        // Says which of the two it is, because they are different problems: a company listed last
        // month has no five-year history and never will, while a book whose price ingest has not
        // caught up does.
        <p className="picker-none">
          {series.heldCount === 0 ? (
            <Blank why="No close has been ingested for this name yet. Prices arrive from the end-of-day run." />
          ) : (
            <>
              Only {series.heldCount} close{series.heldCount === 1 ? '' : 's'} held
              {series.heldFrom ? `, from ${series.heldFrom} to ${series.heldTo}` : ''} — not enough
              to draw this range. Backfill with{' '}
              <code>pnpm exec tsx jobs/backfill-prices.ts --days 1825</code>.
            </>
          )}
        </p>
      )}
    </div>
  );
}
