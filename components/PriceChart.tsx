import { RANGES, type Series } from '@/lib/prices.ts';
import { Blank, inr, signedPct } from './ui.tsx';

/**
 * Closes over a window, as an SVG drawn on the server.
 *
 * No charting library. The whole of it is a polyline over a scaled set of points, and a dependency
 * for that would be forty kilobytes of client JavaScript to draw a line — the reuse ladder says the
 * standard library first, and here the standard library is SVG. Rendering on the server also means
 * the range lives in the URL like every other bit of state on this page.
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

export function PriceChart({ series, href }: { series: Series; href: (r: string) => string }) {
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
        <nav className="chart-ranges" aria-label="Range">
          {RANGES.map((r) => (
            <a
              key={r.key}
              href={href(r.key)}
              aria-current={r.key === series.range ? 'true' : undefined}
            >
              {r.label}
            </a>
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
