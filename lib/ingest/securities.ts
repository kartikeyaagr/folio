/**
 * The security master: every symbol listed on NSE, mainboard and Emerge.
 *
 * Nothing else can start without this. `addCompany` reads it to answer "does this symbol exist and
 * what is its ISIN", so bootstrap runs this before anybody adds a name.
 *
 * Two CSVs rather than one because SME listings live on a separate archive path, and the book is
 * a small/mid-cap book — a master missing Emerge would be missing most of what it is for. The two
 * files also disagree about their own column names, which is why every read goes through `field()`.
 *
 * Writes only rows that actually changed. `securities` is audited, and an unconditional upsert
 * would put three thousand no-op rows in the audit log on every run.
 */

import { serviceTxn } from '../db.ts';
import { field, NseSession, parseCsv } from './nse.ts';
import { nseDate } from './dates.ts';

const MAINBOARD = 'https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv';
const SME = 'https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv';

export type Platform = 'mainboard' | 'nse_emerge';

export interface Security {
  symbol: string;
  isin: string | null;
  name: string;
  series: string | null;
  platform: Platform;
  listedOn: string | null;
  faceValue: string | null;
}

/** NSE writes listing dates as `DD-MMM-YYYY`. */
function asDate(value: string): string | null {
  return nseDate(value);
}

export function parseMaster(csv: string, platform: Platform): Security[] {
  const out: Security[] = [];
  for (const row of parseCsv(csv)) {
    const symbol = field(row, 'SYMBOL').toUpperCase();
    const name = field(row, 'NAME OF COMPANY', 'NAME_OF_COMPANY');
    if (!symbol || !name) continue;
    out.push({
      symbol,
      isin: field(row, 'ISIN NUMBER', 'ISIN_NUMBER') || null,
      name,
      series: field(row, 'SERIES') || null,
      platform,
      listedOn: asDate(field(row, 'DATE OF LISTING', 'DATE_OF_LISTING')),
      faceValue: field(row, 'FACE VALUE', 'FACE_VALUE') || null,
    });
  }
  return out;
}

export interface RefreshResult {
  fetched: number;
  changed: number;
  delisted: number;
}

/**
 * Replace the master with what NSE currently lists.
 *
 * A symbol that has stopped appearing is marked delisted, never deleted: it still appears in old
 * filings and old trades, and deleting the row would take those references with it.
 */
export async function refreshSecurities(
  fetcher?: () => Promise<{ mainboard: string; sme: string }>,
): Promise<RefreshResult> {
  const csv = fetcher
    ? await fetcher()
    : await (async () => {
        const s = await NseSession.open();
        return { mainboard: await s.text(MAINBOARD), sme: await s.text(SME) };
      })();

  const listed = [
    ...parseMaster(csv.mainboard, 'mainboard'),
    ...parseMaster(csv.sme, 'nse_emerge'),
  ];

  if (listed.length === 0) {
    // A master that parses to nothing is a failure, not an empty exchange. Raising here means the
    // caller records a failed ingestion_run rather than silently marking every symbol delisted.
    throw new Error('security master parsed to zero rows; refusing to treat that as an empty NSE');
  }

  return serviceTxn('system:ingest', async (c) => {
    let changed = 0;
    for (const s of listed) {
      // IS DISTINCT FROM, not <>, so a null becoming a value counts as a change rather than
      // evaluating to null and updating nothing.
      const { rowCount } = await c.query(
        `INSERT INTO securities (symbol, isin, name, series, platform, listed_on, face_value, delisted_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, now())
         ON CONFLICT (symbol) DO UPDATE
            SET isin = EXCLUDED.isin, name = EXCLUDED.name, series = EXCLUDED.series,
                platform = EXCLUDED.platform, listed_on = EXCLUDED.listed_on,
                face_value = EXCLUDED.face_value, delisted_at = NULL, updated_at = now()
          WHERE securities.isin        IS DISTINCT FROM EXCLUDED.isin
             OR securities.name        IS DISTINCT FROM EXCLUDED.name
             OR securities.series      IS DISTINCT FROM EXCLUDED.series
             OR securities.platform    IS DISTINCT FROM EXCLUDED.platform
             OR securities.listed_on   IS DISTINCT FROM EXCLUDED.listed_on
             OR securities.face_value  IS DISTINCT FROM EXCLUDED.face_value
             OR securities.delisted_at IS NOT NULL`,
        [s.symbol, s.isin, s.name, s.series, s.platform, s.listedOn, s.faceValue],
      );
      changed += rowCount ?? 0;
    }

    const symbols = listed.map((s) => s.symbol);
    const { rowCount: delisted } = await c.query(
      'UPDATE securities SET delisted_at = now() WHERE delisted_at IS NULL AND symbol <> ALL($1)',
      [symbols],
    );

    return { fetched: listed.length, changed, delisted: delisted ?? 0 };
  });
}
