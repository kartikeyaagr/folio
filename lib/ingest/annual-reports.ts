/**
 * Annual reports from NSE — the only route to a document worth more than everything else fetched.
 *
 * One Praj annual report runs 794,891 characters. The whole corpus, across every other feed, has
 * extracted 7,070,128 in its life; the ~21 retrievable reports on this book roughly triple it. It
 * is also the only source for the fund's own forensic checklist item 13, which reads
 * off-balance-sheet items "from the annual report rather than computed" because the quarterly
 * XBRL has no element for them.
 *
 * The endpoint answers per symbol with the company's whole filed history, not a window — measured
 * 10-Sep-2026: 16 rows for PRAJIND, FY2009-10 through FY2025-26, 3 pdf and 13 zip. Two things in
 * that history do not improve on a retry: FY2021-22 is simply absent from the payload, and the
 * FY2019-20 archive is truncated at source (full content-length, one local file header, zero
 * central-directory entries — `lib/import/zip.ts` raises `UnreadableZip` on it). Both are why the
 * migration beside this file records the ask, not just the success.
 */

import { NseSession } from './nse.ts';

export interface AnnualReport {
  symbol: string;
  fromYr: string;
  toYr: string;
  url: string;
  isZip: boolean;
  disseminatedAt: string | null;
  declaredBytes: number | null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * NSE writes dissemination timestamps as `DD-MMM-YYYY HH:MM:SS`, IST, and a literal "-" on 8 of
 * PRAJIND's 16 rows where nothing was ever disseminated. The same idiom `filings.ts` handles for
 * attachment URLs: a placeholder is read as absent, not stored as the string it happens to be.
 */
function asDissemination(value: string): string | null {
  const v = value.trim();
  if (!v || v === '-') return null;
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const months = 'janfebmaraprmayjunjulaugsepoctnovdec';
  const mon = months.indexOf(m[2]!.toLowerCase()) / 3;
  if (!Number.isInteger(mon) || mon < 0) return null;
  return new Date(
    `${m[3]}-${String(mon + 1).padStart(2, '0')}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+05:30`,
  ).toISOString();
}

/** `attFileSize` is null on 15 of PRAJIND's 16 rows; NSE mostly does not declare it up front. */
function asBytes(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v === '-') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure. The symbol is a parameter rather than read off the row because SME rows carry a `symbol`
 * field and mainboard rows do not — reading it from the row gives every mainboard company
 * `undefined`. A row with no `fileName` (or no fiscal-year bounds) is dropped rather than stored
 * half-formed; there is nothing here for `storeAnnualReport` to key a queue row on.
 */
export function parseAnnualReports(symbol: string, rows: Record<string, unknown>[]): AnnualReport[] {
  const out: AnnualReport[] = [];
  for (const r of rows) {
    const url = clean(r['fileName']);
    const fromYr = clean(r['fromYr']);
    const toYr = clean(r['toYr']);
    if (!url || !fromYr || !toYr) continue;
    out.push({
      symbol,
      fromYr,
      toYr,
      url,
      isZip: /\.zip$/i.test(url),
      disseminatedAt: asDissemination(clean(r['broadcast_dttm'])),
      declaredBytes: asBytes(r['attFileSize']),
    });
  }
  return out;
}

/**
 * Every annual report a company has ever filed with NSE.
 *
 * `board` is `'sme' | 'equities'`, read from `securities.series` by the caller — never guessed.
 * Wrong board, an unknown symbol and a genuinely report-less company are indistinguishable at
 * HTTP 200 with `{"data":[]}`, so the distinguishing check has to live here: this is only ever
 * called for a followed symbol, and a followed symbol with zero rows is a dead feed wearing a
 * quiet day's clothes, not an actually report-less company.
 */
export async function fetchAnnualReports(
  symbol: string,
  board: string,
  session?: NseSession,
): Promise<AnnualReport[]> {
  const s = session ?? (await NseSession.open());
  const rows = await s.rows('annual-reports', { index: board, symbol: symbol.toUpperCase() });
  if (rows.length === 0) {
    throw new Error(
      `no annual reports for ${symbol} on board '${board}' — wrong board, an unknown symbol and ` +
        'a genuinely report-less company all look identical here, so a followed name getting ' +
        'nothing back is treated as a failure rather than a quiet feed',
    );
  }
  return parseAnnualReports(symbol, rows);
}
