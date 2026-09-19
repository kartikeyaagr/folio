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
  /** Null when none was asked for, or when the window holds too little of it to mean anything. */
  benchmark: Benchmark | null;
  /**
   * Why there is no benchmark line when one was asked for. Null when none was asked for, or when
   * one is drawn.
   *
   * The `<Blank why>` discipline applied to a chart: a line that quietly does not appear reads as
   * "this company has no benchmark", and the truth is usually "the walk has not reached that far
   * back yet", which is a thing somebody can fix.
   */
  benchmarkShort: string | null;
  /** The bounds both lines are drawn against — the stock's alone would clip a rebased benchmark. */
  floor: number | null;
  ceiling: number | null;
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
  /** The benchmarks this name can be drawn against, whole, sliced by the same `windowOf`. */
  indices: { name: string; label: string; points: Point[] }[];
}

/**
 * A benchmark drawn on the company's own axis.
 *
 * **Rebased, and it has to be.** The stock is ₹314 and Nifty Smallcap 250 is 17,863; plotted
 * literally on one axis the stock is a flat line along the floor. Each index close is scaled so the
 * benchmark starts the window at the same rupee value the stock did, which makes the two lines
 * directly comparable in shape and in slope — the only question a second line on this chart is
 * asked. The number a reader acts on is `changePct`, which is the benchmark's own move over the
 * same window and is computed before any rebasing.
 */
export interface Benchmark {
  name: string;
  label: string;
  /** Index closes scaled to the stock's opening price for this window. */
  points: Point[];
  changePct: number | null;
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
 * How far the benchmark may open after the stock's own first close and still be the same period.
 *
 * Seven calendar days: the two series come from the same exchange on the same trading calendar, so
 * they differ only by a weekend and a holiday or two at the window's edge. Anything wider is not a
 * late start, it is a shorter history.
 */
const COVERAGE_SLACK_DAYS = 7;

/**
 * The chosen index over the same window, scaled onto the stock's axis. A string is the reason there
 * is no line, for the chart to render rather than swallow.
 *
 * **The coverage check is the load-bearing part, and it was added after seeing the bug.** PRAJIND
 * over max is 2025-08-07 → 2026-09-16 and the index walk had only reached 2026-04-07, so the head
 * read `−30.7%` beside `Smallcap 250 +10.3%` — two true numbers over two different periods,
 * presented as a comparison. That is worse than no benchmark, because it invites exactly the
 * conclusion it cannot support.
 *
 * Two points are the floor, for the reason `change` has the same one: a single close is a level,
 * not a line, and rebasing against it draws a benchmark that is flat by construction.
 */
function rebase(
  history: History,
  name: string | null,
  from: string | null,
  anchor: number | null,
  opensOn: string | null,
): Benchmark | string | null {
  if (name === null || anchor === null) return null;
  const index = history.indices.find((i) => i.name === name);
  if (!index) return null;

  const within = from === null ? index.points : index.points.filter((p) => p.on > from);
  const base = within[0];
  const end = within[within.length - 1];
  if (!base || !end || within.length < 2 || base.close <= 0) {
    return `${index.label} has no levels held over this window`;
  }
  if (opensOn !== null && base.on > cutoff(opensOn, -COVERAGE_SLACK_DAYS)) {
    return `${index.label} is held only from ${base.on}, which is not this window`;
  }

  return {
    name: index.name,
    label: index.label,
    points: within.map((p) => ({ on: p.on, close: (p.close / base.close) * anchor })),
    changePct: ((end.close - base.close) / base.close) * 100,
  };
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
export function windowOf(history: History, range: Range, indexName?: string | null): Series {
  const days = RANGES.find((r) => r.key === range)?.days ?? null;
  const from = days === null ? null : cutoff(history.asOf, days);
  const points = from === null ? history.points : history.points.filter((p) => p.on > from);

  const first = points[0];
  const last = points[points.length - 1];

  const attempt = rebase(history, indexName ?? null, from, first?.close ?? null, first?.on ?? null);
  const benchmark = typeof attempt === 'string' ? null : attempt;
  const all = [...points.map((p) => p.close), ...(benchmark?.points.map((p) => p.close) ?? [])];

  return {
    range,
    points,
    benchmark,
    benchmarkShort: typeof attempt === 'string' ? attempt : null,
    floor: all.length > 0 ? Math.min(...all) : null,
    ceiling: all.length > 0 ? Math.max(...all) : null,
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
