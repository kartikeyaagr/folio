/**
 * Results filed under SEBI's Integrated Filing regime.
 *
 * `corporates-financial-results` stopped receiving rows in January 2025 — PRAJIND's last one there
 * is 30-Jan-2025, for the December 2024 quarter, and the whole-market query agrees: 3,816 rows on
 * 09-Sep-2026 and every one of them dated 31-Dec-2024. Nothing was broken. SEBI replaced separate
 * results filings with Integrated Filing (Financial), and NSE serves those from this endpoint under
 * a different taxonomy namespace, whose element names are unchanged — so `./xbrl.ts` reads them
 * once it admits `in-capmkt`, and only the finding of them is different.
 *
 * Its own file because it is a whole second way in, with a paging problem of its own, and
 * `fundamentals.ts` is the module that decides what to do with an instance once it has one.
 */

import { NseSession } from './nse.ts';
import type { ResultsFiling } from './fundamentals.ts';

export type Board = 'equities' | 'sme';

const INTEGRATED_PAGE = 20;

const ddmm = (iso: string): string => iso.split('-').reverse().join('-');

const mid = (from: string, to: string): string => {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  return new Date(fromMs + Math.floor((toMs - fromMs) / 2)).toISOString().slice(0, 10);
};

const dayAfter = (iso: string): string =>
  new Date(Date.parse(iso) + 86_400_000).toISOString().slice(0, 10);

async function integratedPage(
  s: NseSession,
  board: Board,
  from: string,
  to: string,
  symbol: string | undefined,
): Promise<{ rows: Record<string, unknown>[]; clipped: boolean }> {
  const params: Record<string, string> = { index: board, from_date: ddmm(from), to_date: ddmm(to) };
  if (symbol) params['symbol'] = symbol.trim().toUpperCase();
  const rows = await s.rows<Record<string, unknown>>('integrated-filing-results', params);
  return { rows, clipped: rows.length >= INTEGRATED_PAGE };
}

/**
 * Every row in a window, splitting it when the answer comes back full.
 *
 * Halving rather than walking year by year. The window offered is decades wide on purpose — this
 * file does not know when the regime began and should not claim to — and a year-at-a-time walk of
 * it is twenty-odd requests to discover that twenty of them are empty. Halving finds the populated
 * span in a handful, and an empty half costs exactly one request and stops.
 *
 * Bounded at a month. A month that still comes back full means the feed's shape has changed from
 * what was measured, and saying so is worth more than halving into single days on a guess.
 */
async function integratedWindow(
  s: NseSession,
  board: Board,
  from: string,
  to: string,
  symbol: string | undefined,
  into: Record<string, unknown>[],
): Promise<void> {
  const page = await integratedPage(s, board, from, to, symbol);
  if (!page.clipped) {
    into.push(...page.rows);
    return;
  }
  const half = mid(from, to);
  if (half <= from || Date.parse(to) - Date.parse(from) < 31 * 86_400_000) {
    into.push(...page.rows);
    console.warn(
      `integrated-filing-results stayed full for ${symbol ?? board} over ${from}..${to}; ` +
        'some filings in that window may not have been seen',
    );
    return;
  }
  await integratedWindow(s, board, from, half, symbol, into);
  await integratedWindow(s, board, dayAfter(half), to, symbol, into);
}

/**
 * Every financial instance in a window.
 *
 * **Nothing here knows when the regime changed.** An earlier version asked this endpoint from
 * 2025-01-01, which is where the evidence pointed — and a boundary inferred from two feeds on one
 * afternoon is a guess that goes wrong quietly, whichever side of it loses a filing. Callers hand
 * it the whole range and it takes what comes back, so where the regimes divide stays the
 * exchange's fact rather than this file's assumption.
 *
 * The rows carry governance filings too; only `Integrated Filing- Financials` is a results
 * instance. `qe_Date` is the quarter end and `xbrl` is a plain instance.
 */
export async function fetchIntegratedFilings(
  board: Board,
  range: { from: string; to: string; symbol?: string },
  session?: NseSession,
): Promise<ResultsFiling[]> {
  const s = session ?? (await NseSession.open());
  const collected: Record<string, unknown>[] = [];
  await integratedWindow(s, board, range.from, range.to, range.symbol, collected);

  const out: ResultsFiling[] = [];
  const seen = new Set<string>();
  for (const r of collected) {
    if (!String(r['type'] ?? '').includes('Financial')) continue;
    const url = String(r['xbrl'] ?? '').trim();
    if (!url.startsWith('http') || seen.has(url)) continue;
    seen.add(url);
    out.push({
      symbol: String(r['symbol'] ?? '').trim().toUpperCase(),
      isin: null,
      xbrlUrl: url,
      periodEnd: String(r['qe_Date'] ?? '').trim() || null,
    });
  }
  return out;
}

