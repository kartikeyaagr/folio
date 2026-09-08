/**
 * Closes over a window, for the chart.
 *
 * Joined on the instrument where there is one and the symbol otherwise — the same rule the rest of
 * the system uses, because the SME board carries no ISIN and a book of small caps that joined only
 * on ISIN would chart half of itself.
 */

import { readTxn } from './db.ts';

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

export function isRange(v: string | undefined): v is Range {
  return RANGES.some((r) => r.key === v);
}

/**
 * A window of closes, and what is held either side of it.
 *
 * The window is by calendar days rather than by row count: "the last month" means a month, and a
 * name that stopped trading for a fortnight should show the gap rather than quietly reaching
 * further back to fill the same number of points.
 */
export async function priceSeries(companyId: string, range: Range = '1y'): Promise<Series> {
  const days = RANGES.find((r) => r.key === range)?.days ?? null;

  return readTxn(async (c) => {
    const { rows: span } = await c.query<{ from: string | null; to: string | null; n: string }>(
      `SELECT min(p.on_date)::text AS from, max(p.on_date)::text AS to, count(*)::text AS n
         FROM prices p
         JOIN companies co ON (p.isin IS NOT NULL AND p.isin = co.isin) OR p.symbol = co.symbol
        WHERE co.id = $1`,
      [companyId],
    );

    const { rows } = await c.query<{ on: string; close: string }>(
      `SELECT p.on_date::text AS on, p.close::text AS close
         FROM prices p
         JOIN companies co ON (p.isin IS NOT NULL AND p.isin = co.isin) OR p.symbol = co.symbol
        WHERE co.id = $1
          AND ($2::int IS NULL OR p.on_date > current_date - $2::int)
        ORDER BY p.on_date`,
      [companyId, days],
    );

    const points: Point[] = rows.map((r) => ({ on: r.on, close: Number(r.close) }));
    const first = points[0];
    const last = points[points.length - 1];

    return {
      range,
      points,
      heldFrom: span[0]?.from ?? null,
      heldTo: span[0]?.to ?? null,
      heldCount: Number(span[0]?.n ?? 0),
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
  });
}
