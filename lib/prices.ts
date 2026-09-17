/**
 * What a price range is, and how to take one — **and nothing that touches a database.**
 *
 * `components/PriceChart.tsx` is a client component, so everything it imports is bundled for the
 * browser. While the read lived here too, that bundle pulled in `lib/db.ts` and therefore `pg`, and
 * the page 500'd inside `pg-connection-string`. The read moved to `lib/company-view.ts`, which is
 * where the company screens' reads already live; this file is the shape and the arithmetic, both of
 * which have to run on both sides.
 *
 * Keep it that way: an import of `./db.ts` here is a broken company page, not a lint warning.
 */

export type Range = '1w' | '1m' | '6m' | '1y' | '5y' | 'max';

export const RANGES: { key: Range; label: string; days: number | null }[] = [
  { key: '1w', label: '1W', days: 7 },
  { key: '1m', label: '1M', days: 31 },
  { key: '6m', label: '6M', days: 184 },
  { key: '1y', label: '1Y', days: 366 },
  { key: '5y', label: '5Y', days: 1827 },
  { key: 'max', label: 'Max', days: null },
];

export interface Point {
  on: string;
  close: number;
}

export interface Series {
  range: Range;
  points: Point[];
  /** The whole history held, so the page can say what a range is drawn from. */
  heldFrom: string | null;
  heldTo: string | null;
  heldCount: number;
  /** Over the window, not over the history. Null when there is nothing to compare against. */
  change: { from: number; to: number; pct: number } | null;
  low: number | null;
  high: number | null;
}

/**
 * Every close held for one name, fetched once so the chart can change range without a round trip.
 *
 * `asOf` is carried rather than computed where it is used, and that is the load-bearing part: the
 * window is "the last month" counted back from a day, `windowOf` runs in the browser, and a browser
 * with a skewed clock — or simply one in another timezone — would disagree with the server about
 * which day that is. The server says, once, and both sides slice against the same answer.
 */
export interface History {
  points: Point[];
  heldFrom: string | null;
  heldTo: string | null;
  heldCount: number;
  asOf: string;
}

export function isRange(v: string | undefined): v is Range {
  return RANGES.some((r) => r.key === v);
}

/**
 * The calendar day `days` before `asOf`, as `YYYY-MM-DD`.
 *
 * Arithmetic in UTC on purpose. These are calendar dates rather than instants — a close belongs to
 * a trading day, not to a moment — so parsing them in the viewer's zone is the one way to move one
 * across a boundary and lose or gain a day at the edge of a window.
 */
function cutoff(asOf: string, days: number): string {
  return new Date(Date.parse(`${asOf}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * One range's view of a history. **Pure, and that is what lets the chart change range without a
 * round trip.**
 *
 * The window is by calendar days rather than by row count: "the last month" means a month, and a
 * name that stopped trading for a fortnight should show the gap rather than quietly reaching
 * further back to fill the same number of points. `> cutoff`, strictly, which is what the SQL this
 * replaces did.
 *
 * Every derived number — the change, the low, the high — is over the WINDOW and not over the
 * history, so it has to be recomputed per range rather than sent down once. That is the whole
 * reason this is a function and not a field.
 */
export function windowOf(history: History, range: Range): Series {
  const days = RANGES.find((r) => r.key === range)?.days ?? null;
  const from = days === null ? null : cutoff(history.asOf, days);
  const points = from === null ? history.points : history.points.filter((p) => p.on > from);

  const first = points[0];
  const last = points[points.length - 1];

  return {
    range,
    points,
    heldFrom: history.heldFrom,
    heldTo: history.heldTo,
    heldCount: history.heldCount,
    // Two points are the minimum for a change to mean anything. One close is a price, not a move.
    change:
      first && last && points.length > 1 && first.close > 0
        ? {
            from: first.close,
            to: last.close,
            pct: ((last.close - first.close) / first.close) * 100,
          }
        : null,
    low: points.length > 0 ? Math.min(...points.map((p) => p.close)) : null,
    high: points.length > 0 ? Math.max(...points.map((p) => p.close)) : null,
  };
}
