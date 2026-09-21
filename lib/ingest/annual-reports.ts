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

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Client } from '../db.ts';
import { UnreadableZip, unzipListing, unzipOne } from '../import/zip.ts';
import { pathFor } from './attachments.ts';
import { NseError, NseSession } from './nse.ts';
import { nseTimestamp } from './dates.ts';

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
  return nseTimestamp(v)?.toISOString() ?? null;
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
 * `board` is `'sme' | 'equities'`, mapped by the caller from `securities.platform` — `nse_emerge`
 * is `sme`, everything else `equities` — and never guessed. This named `securities.series` until
 * 21-Sep-2026: `backfill-company.ts` has always branched on `platform`, and no caller anywhere
 * reads `series`.
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

/**
 * Which entry in a multi-entry archive is the report.
 *
 * 3 of 12 readable PRAJIND zips hold a `FormA_*.pdf` beside the `AR_*.pdf` — a 2-page compliance
 * cover that is a scan and extracts nothing. Picked by size, not name: the report is a whole
 * annual report and the cover is a couple of scanned pages, an order of magnitude smaller in every
 * case checked, and NSE's own naming is not consistent enough across companies to match by
 * convention.
 *
 * Weighed from the archive's index rather than from its contents: `unzipListing` reads each
 * member's uncompressed size off the central directory, so choosing between a report and its
 * cover no longer inflates both to throw one away. `null` only for an archive with no entries.
 */
export function pickReport(entries: { name: string; bytes: number }[]): string | null {
  let best: string | null = null;
  let bestBytes = -1;
  for (const e of entries) {
    if (e.bytes > bestBytes) {
      best = e.name;
      bestBytes = e.bytes;
    }
  }
  return best;
}

/**
 * Record the ask, whatever the outcome. `annual_report_attempts` (migration 0046) is the queue:
 * its absence is "not yet asked", and any row — `stored` or `unavailable` — means it need not be
 * asked again.
 */
async function recordAttempt(
  c: Client,
  companyId: string,
  fromYr: string,
  state: 'stored' | 'unavailable',
  sha256: string | null,
  reason: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO annual_report_attempts (company_id, from_yr, state, sha256, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [companyId, fromYr, state, sha256, reason],
  );
}

/**
 * Fetch one annual report and store it as a content-addressed attachment.
 *
 * Stays an `attachment`, never a `documents` row: a 795,000-character annual report as a
 * `document_version` body would be a JSONB blob nobody opens, and `documents` is the *authored*
 * record. `extractPending` (`lib/ingest/extract.ts`) picks up `kind = 'annual_report'` through its
 * existing `LEFT JOIN filings` and fills in `extracted_text` the same way it does for every other
 * PDF — nothing here does that work twice.
 *
 * Short-circuits on an existing `annual_report_attempts` row before any network call: `stored` or
 * `unavailable`, either way the ask has already been answered and NSE will not answer differently
 * on a retry. Terminal outcomes — `UnreadableZip` (the FY2019-20 archive's missing central
 * directory) and a genuine 404 — are caught and recorded as `unavailable` with the reason. A
 * truncated body is deliberately *not* caught here: `NseSession.bytes` already throws a plain
 * `Error` for it, which propagates so the caller's `attempt()` harness logs it as a failure worth
 * retrying next run, rather than writing a terminal row for what might just be a bad connection.
 */
export async function storeAnnualReport(
  c: Client,
  companyId: string,
  r: AnnualReport,
  session?: NseSession,
): Promise<'stored' | 'held' | 'unavailable'> {
  const { rows: asked } = await c.query(
    'SELECT 1 FROM annual_report_attempts WHERE company_id = $1 AND from_yr = $2',
    [companyId, r.fromYr],
  );
  if (asked.length > 0) return 'held';

  const s = session ?? (await NseSession.open());

  let raw: Buffer;
  try {
    raw = await s.bytes(r.url);
  } catch (err) {
    // Only a definite 404 is treated as permanent — verified live against NSE. Any other status,
    // or a network fault, is left to throw: it might be NSE having a bad minute, not a dead link.
    if (err instanceof NseError && err.status === 404) {
      await recordAttempt(c, companyId, r.fromYr, 'unavailable', null, err.message);
      return 'unavailable';
    }
    throw err;
  }

  let pdf: Buffer;
  let filename: string;
  if (r.isZip) {
    let name: string | null;
    let body: Buffer | null;
    try {
      name = pickReport(unzipListing(raw));
      body = name === null ? null : unzipOne(raw, name);
    } catch (err) {
      if (err instanceof UnreadableZip) {
        await recordAttempt(c, companyId, r.fromYr, 'unavailable', null, `unreadable zip: ${err.message}`);
        return 'unavailable';
      }
      throw err;
    }
    if (name === null || body === null) {
      await recordAttempt(c, companyId, r.fromYr, 'unavailable', null, 'zip held no entries');
      return 'unavailable';
    }
    pdf = body;
    filename = name;
  } else {
    pdf = raw;
    filename = decodeURIComponent(r.url.split('/').pop() || `${r.symbol}_${r.fromYr}_${r.toYr}.pdf`);
  }

  // Content-addressed, same store `lib/ingest/attachments.ts` uses for everything else: the sha
  // decides identity, so a report re-served under a different URL is recognised as the same bytes.
  const sha256 = createHash('sha256').update(pdf).digest('hex');
  const file = pathFor(sha256);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, pdf);

  await c.query(
    `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, source_note, added_by)
     VALUES ($1, $2, $3, 'application/pdf', $4, 'annual_report', $5, 'system:ingest')
     ON CONFLICT (sha256) DO NOTHING`,
    [sha256, companyId, filename, pdf.length, `NSE annual report FY${r.fromYr}-${r.toYr}`],
  );

  await recordAttempt(c, companyId, r.fromYr, 'stored', sha256, null);
  return 'stored';
}
