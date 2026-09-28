'use client';

import { useState, type PointerEvent } from 'react';

import { RANGES, windowOf, type History, type Point, type Range } from '@/lib/prices.ts';
import { Blank, dayMonthYear, inr, signedPct } from './ui.tsx';

/**
 * Closes over a window, against the market, as an SVG.
 *
 * No charting library. The whole of it is two polylines over a scaled set of points and a crosshair
 * that reads them; a dependency for that would be forty kilobytes of client JavaScript, and the
 * reuse ladder says the standard library first — here the standard library is SVG.
 *
 * **The range is component state, not a query parameter, and this is the page's one exception to
 * "state lives in the URL".** It was a parameter until 17-Sep-2026: every range button was a link,
 * so looking at five years and then at one month re-rendered the whole company page twice to redraw
 * a line over closes the browser could already have had. What the URL rule protects is a
 * deliberately-chosen filter surviving a refresh; a chart zoom is a lens on data already on the
 * page, costs one click to restore, and falls back to the whole history rather than an arbitrary
 * slice. `?archived=` on the same page still lives in the URL and still should.
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

/** Where a point sits in the viewBox. Shared by both lines and by the crosshair, so they agree. */
const xAt = (i: number, n: number): number => (n < 2 ? W / 2 : (i * W) / (n - 1));

const yAt = (close: number, floor: number, span: number): number =>
  PAD_Y + (1 - (close - floor) / span) * (H - PAD_Y * 2);

/**
 * Both lines are scaled against the same floor and ceiling, which is the whole point of drawing
 * them together: two independently-scaled lines would show the stock and the index crossing where
 * they did not, which is worse than no benchmark at all.
 */
function path(points: Point[], floor: number | null, ceiling: number | null, n: number): string {
  if (points.length < 2 || floor === null || ceiling === null) return '';
  // A flat series has no range to scale against; centre it rather than dividing by zero.
  const span = ceiling - floor || 1;
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xAt(i, n).toFixed(1)},${yAt(p.close, floor, span).toFixed(1)}`)
    .join(' ');
}

/**
 * Max, because the first question a chart answers is "what has this done", and a default of one
 * year answers it only for a name that has been listed longer than that. Everything is loaded
 * anyway — narrowing is free and widening used to cost a page load.
 */
const DEFAULT_RANGE: Range = 'max';

const day = (iso: string): string => dayMonthYear(new Date(`${iso}T00:00:00+05:30`));

export function PriceChart({ history }: { history: History }) {
  const [range, setRange] = useState<Range>(DEFAULT_RANGE);
  // The book's own benchmark by default, and `''` for none — a reader comparing two companies wants
  // the same benchmark on both, so the choice is sticky within the page rather than per chart.
  const [index, setIndex] = useState<string>(history.indices[0]?.name ?? '');
  // The point the pointer is over. Null is the resting state and is what every label falls back to.
  const [at, setAt] = useState<number | null>(null);

  const series = windowOf(history, range, index || null);
  const n = series.points.length;
  const stock = path(series.points, series.floor, series.ceiling, n);
  const bench = path(series.benchmark?.points ?? [], series.floor, series.ceiling, n);
  const rising = (series.change?.pct ?? 0) >= 0;

  const hovered = at === null ? null : series.points[at];
  const span = (series.ceiling ?? 0) - (series.floor ?? 0) || 1;

  /**
   * The nearest close to the pointer, by x.
   *
   * `preserveAspectRatio="none"` stretches the 1000-wide viewBox to whatever the card is, so the
   * mapping is a fraction of the rendered width rather than a viewBox coordinate — reading
   * `event.nativeEvent.offsetX` against W would be wrong at every width but one.
   */
  const track = (e: PointerEvent<SVGSVGElement>): void => {
    if (n < 2) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const f = (e.clientX - box.left) / box.width;
    setAt(Math.max(0, Math.min(n - 1, Math.round(f * (n - 1)))));
  };

  return (
    <div className="chart">
      <div className="chart-head">
        {/* What the head says follows the pointer: over a point it reads that day, and at rest it
            reads the window. A chart whose header keeps reading the last close while the crosshair
            is somewhere else is two different answers to one question. */}
        {hovered ? (
          <>
            <b className="chart-last">{inr(hovered.close)}</b>
            {series.benchmark?.points[at!] && (
              <span className="chart-bench-read">
                {series.benchmark.label} {inr(series.benchmark.points[at!]!.close)}
              </span>
            )}
            <span className="chart-span">{day(hovered.on)}</span>
          </>
        ) : series.change ? (
          <>
            <b className="chart-last">{inr(series.change.to)}</b>
            <span className={rising ? 'chart-move is-up' : 'chart-move is-down'}>
              {signedPct(series.change.pct)}
            </span>
            {/* The benchmark's own move over the same window, before any rebasing. This is the
                number the second line exists to produce: −30% against an index down 28% is a
                different company from −30% against one that is up. */}
            {series.benchmark?.changePct !== null && series.benchmark !== null && (
              <span className="chart-bench-read">
                {series.benchmark.label} {signedPct(series.benchmark.changePct!)}
              </span>
            )}
            <span className="chart-span">
              {series.points[0]?.on} → {series.points[series.points.length - 1]?.on}
            </span>
          </>
        ) : series.points.length === 1 ? (
          <b className="chart-last">{inr(series.points[0]!.close)}</b>
        ) : null}

        <span className="spacer" />

        {history.indices.length > 0 && (
          <label className="chart-bench">
            <span className="sr-only">Benchmark</span>
            <select value={index} onChange={(e) => setIndex(e.target.value)}>
              {history.indices.map((i) => (
                <option key={i.name} value={i.name}>vs {i.label}</option>
              ))}
              <option value="">no benchmark</option>
            </select>
          </label>
        )}

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

      {stock ? (
        <>
          <svg
            className="chart-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Closing price, ${series.points[0]?.on} to ${series.points[series.points.length - 1]?.on}`}
            onPointerMove={track}
            onPointerLeave={() => setAt(null)}
          >
            {/* The benchmark first, so the company's own line is never hidden behind it. */}
            {bench && <path className="line is-bench" d={bench} />}
            <path className={rising ? 'line is-up' : 'line is-down'} d={stock} />
            {hovered && (
              <g className="chart-cross" aria-hidden="true">
                <line x1={xAt(at!, n)} y1={0} x2={xAt(at!, n)} y2={H} />
                {series.benchmark?.points[at!] && (
                  <circle
                    className="is-bench"
                    cx={xAt(at!, n)}
                    cy={yAt(series.benchmark.points[at!]!.close, series.floor!, span)}
                    r={3}
                  />
                )}
                <circle
                  className={rising ? 'is-up' : 'is-down'}
                  cx={xAt(at!, n)}
                  cy={yAt(hovered.close, series.floor!, span)}
                  r={3.5}
                />
              </g>
            )}
          </svg>
          <div className="chart-foot">
            <span>low {inr(series.low)}</span>
            <span>high {inr(series.high)}</span>
            <span className="spacer" />
            {/* Why the line is absent, not just its absence. A benchmark that quietly fails to
                appear reads as "this company has no benchmark"; the truth is usually that the index
                walk has not reached that far back, which somebody can fix. */}
            {series.benchmark ? (
              <span className="chart-bench-note">
                {series.benchmark.label} rebased to this window&rsquo;s opening price
              </span>
            ) : series.benchmarkShort ? (
              <span className="chart-bench-note">
                <Blank why={`${series.benchmarkShort}. Backfill with pnpm exec tsx jobs/backfill-prices.ts --days 1825`} />
              </span>
            ) : null}
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
