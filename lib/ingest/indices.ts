/**
 * What the market did, so a company's line has something to be read against.
 *
 * A small-cap down 30% over a year in which Nifty Smallcap 250 is down 28% has done nothing. The
 * same line against an index up 10% is a different company entirely, and the chart could not say
 * which until this existed.
 *
 * **One file a day carries every index.** NSE's per-index history endpoint
 * (`api/historical/indicesHistory`) answers 503 — measured 17-Sep-2026 against NIFTY 50 and NIFTY
 * SMALLCAP 250, with and without the Referer that unsticks the insider endpoint, which is the same
 * answer `jobs/backfill-prices.ts` already records for every per-symbol historical endpoint. What
 * does serve is `ind_close_all_DDMMYYYY.csv`: 166 indices, open/high/low/close, one file per
 * trading day, on the same archive host and in the same shape as the bhavcopy. So this is walked
 * exactly as prices are — a day at a time, backwards, by the same loop — and costs one extra
 * request per day for all four indices at once.
 */

import { serviceTxn } from '../db.ts';
import { NseError, NseSession } from './nse.ts';

const URL_TEMPLATE = 'https://nsearchives.nseindia.com/content/indices/ind_close_all_{ddmmyyyy}.csv';

/**
 * The four this book is actually measured against, and no more.
 *
 * The file carries 166. Keeping all of them would be 207,000 rows over a five-year walk to serve a
 * chart that draws one line, and the 162 dropped are sector and thematic indices a long-only
 * small/mid-cap book does not benchmark to. Smallcap 250 first because it is the benchmark; the
 * other three are the context a reader asks for next — is this the size band, the broad market, or
 * the whole tape.
 *
 * `name` is the exchange's own spelling and is the join key. `label` is ours and is display only.
 */
export const INDICES: { name: string; label: string }[] = [
  { name: 'Nifty Smallcap 250', label: 'Smallcap 250' },
  { name: 'Nifty Midcap 150', label: 'Midcap 150' },
  { name: 'Nifty 500', label: 'Nifty 500' },
  { name: 'Nifty 50', label: 'Nifty 50' },
];

const WANTED = new Set(INDICES.map((i) => i.name));

/** The benchmark the chart opens on, because it is the one the book is run against. */
export const DEFAULT_INDEX = 'Nifty Smallcap 250';

export interface IndexRow {
  name: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
}

/** Mirrors `NoBhavcopy`: a day the exchange did not trade is a fact, not a fault. */
export class NoIndexFile extends Error {}

const ddmmyyyy = (on: Date): string => {
  const d = on.toISOString().slice(0, 10).split('-');
  return `${d[2]}${d[1]}${d[0]}`;
};

/** A number the file may write as blank, as `-`, or with thousands separators. */
function num(v: string | undefined): number | null {
  const t = (v ?? '').trim().replace(/,/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pure, so the shape of the file can be tested without the network.
 *
 * Columns by position, not by header: the header is
 * `Index Name,Index Date,Open…,High…,Low…,Closing Index Value,…` and the file ends every line with a
 * trailing comma, so a naive header-index map is off by one on the last column. An index whose
 * close will not parse is dropped rather than stored as zero — a zero index level would render as a
 * line to the floor and read as a crash rather than as missing data.
 */
export function parseIndexCsv(csv: string): IndexRow[] {
  const out: IndexRow[] = [];
  for (const line of csv.trim().split(/\r?\n/).slice(1)) {
    const f = line.split(',');
    const name = (f[0] ?? '').trim();
    if (!WANTED.has(name)) continue;
    const close = num(f[5]);
    if (close === null) continue;
    out.push({ name, open: num(f[2]), high: num(f[3]), low: num(f[4]), close });
  }
  return out;
}

export async function fetchIndexCloses(on: Date, session?: NseSession): Promise<IndexRow[]> {
  const s = session ?? (await NseSession.open());
  try {
    return parseIndexCsv(await s.text(URL_TEMPLATE.replace('{ddmmyyyy}', ddmmyyyy(on))));
  } catch (err) {
    // Only a 404 means "not published", for the reason `fetchBhavcopy` spells out at length: every
    // other failure recorded as a holiday is a dead archive that looks like a quiet market.
    if (err instanceof NseError && err.status === 404) {
      throw new NoIndexFile(`no index close published for ${on.toISOString().slice(0, 10)}`);
    }
    throw err;
  }
}

export async function storeIndexCloses(on: Date, rows: IndexRow[]): Promise<{ stored: number }> {
  const onDate = on.toISOString().slice(0, 10);
  return serviceTxn('system:ingest', async (c) => {
    let stored = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO index_levels (name, on_date, open, high, low, close)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name, on_date) DO UPDATE
            SET open = EXCLUDED.open, high = EXCLUDED.high,
                low = EXCLUDED.low, close = EXCLUDED.close`,
        [r.name, onDate, r.open, r.high, r.low, r.close],
      );
      stored++;
    }
    return { stored };
  });
}

/**
 * Fetch and store one day, reporting what happened rather than whether it threw.
 *
 * `missing` is the count of wanted indices the file did not carry, and it is returned rather than
 * swallowed: NSE renames an index occasionally (Nifty Smallcap 250 was Nifty Smallcap in 2017), and
 * a rename under a name in `INDICES` shows up here as a day that stored three of four instead of as
 * a chart that quietly stops.
 */
export async function ingestIndexDay(
  on: Date,
  session?: NseSession,
): Promise<{ stored: number; missing: string[] }> {
  const rows = await fetchIndexCloses(on, session);
  const { stored } = await storeIndexCloses(on, rows);
  const got = new Set(rows.map((r) => r.name));
  return { stored, missing: INDICES.map((i) => i.name).filter((n) => !got.has(n)) };
}
