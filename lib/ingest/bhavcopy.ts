/**
 * The NSE UDiFF bhavcopy: end-of-day prices, and the authoritative source when any two disagree.
 *
 * Three things measured in v2 on 01-Sep-2026 that shape this module:
 *
 *   * **One file covers both boards.** All instruments arrive together; SME rows carry
 *     `SctySrs = 'SM'`. There is no separate Emerge bhavcopy to fetch.
 *   * **The ISIN is on every row.** Prices therefore join to companies on the instrument rather
 *     than on the symbol, which is the one place a silent wrong-company match would be most
 *     expensive: it produces a plausible chart for the wrong business.
 *   * The legacy pipe-delimited bhavcopy was retired in July 2024. This is the UDiFF CSV in a zip.
 *
 * There is no fetch for a date the exchange did not trade. A weekend or a holiday returns 404, and
 * that is a normal answer rather than a failure — but a *trading* day returning nothing is not,
 * which is why the caller records the distinction.
 */

import { inflateRawSync } from 'node:zlib';
import { serviceTxn } from '../db.ts';
import { NseError, NseSession, parseCsv } from './nse.ts';

const URL_TEMPLATE =
  'https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{yyyymmdd}_F_0000.csv.zip';

export class NoBhavcopy extends Error {}

export interface PriceRow {
  symbol: string;
  isin: string | null;
  series: string | null;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string;
  volume: string | null;
}

const yyyymmdd = (d: Date): string =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

const num = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  if (!t) return null;
  return Number.isFinite(Number(t)) ? t : null;
};

/**
 * Extract the single CSV from a zip without a zip library.
 *
 * The bhavcopy zip holds one stored-or-deflated entry. Node ships `zlib`, so the only missing
 * piece is walking the local file header to find where the deflate stream starts — about twenty
 * lines against a dependency, and the reuse ladder says the standard library first.
 */
export class UnreadableBhavcopy extends Error {}

export function unzipSingle(buf: Buffer): string {
  // Not a NoBhavcopy: the archive answered 200 with something that is not a zip, which is a broken
  // feed rather than a day with no trading. A captive portal and an error page both land here.
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new UnreadableBhavcopy('not a zip file');
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;

  // Central directory marks the end of the entry's data; the local header's size fields are
  // sometimes zero when a data descriptor is used, so trust the directory offset instead.
  const cd = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
  const end = cd === -1 ? buf.length : cd;
  const body = buf.subarray(start, end);

  if (method === 0) return body.toString('utf8');
  // Zip stores a bare deflate stream with no zlib or gzip wrapper, which is exactly what
  // inflateRaw expects. Fabricating a gzip header instead fails: that format also needs a
  // trailing CRC and length, which the zip entry does not carry here.
  if (method === 8) return inflateRawSync(body).toString('utf8');
  throw new UnreadableBhavcopy(`unsupported zip compression method ${method}`);
}

export function parseBhavcopy(csv: string): PriceRow[] {
  const out: PriceRow[] = [];
  for (const r of parseCsv(csv)) {
    const symbol = (r['TckrSymb'] ?? '').trim().toUpperCase();
    const close = num(r['ClsPric']);
    if (!symbol || close === null) continue;
    out.push({
      symbol,
      isin: (r['ISIN'] ?? '').trim() || null,
      series: (r['SctySrs'] ?? '').trim() || null,
      open: num(r['OpnPric']),
      high: num(r['HghPric']),
      low: num(r['LwPric']),
      close,
      volume: num(r['TtlTradgVol']),
    });
  }
  return out;
}

export async function fetchBhavcopy(on: Date, session?: NseSession): Promise<PriceRow[]> {
  const s = session ?? (await NseSession.open());
  const url = URL_TEMPLATE.replace('{yyyymmdd}', yyyymmdd(on));
  let raw: Buffer;
  try {
    raw = await s.bytes(url);
  } catch (err) {
    // **Only a 404 means "not published".** Every failure of `s.bytes` used to be rethrown as
    // NoBhavcopy — 503, DNS, a TLS reset, a timeout — and the job records that as `ok` with the
    // detail "no bhavcopy published". So a dead archive and a public holiday were the same row,
    // which is the one thing this system says a feed must never do. Worse, `jobs/alerts.ts` reads
    // that `ok` and runs the price evaluator against yesterday's closes as though they were today's.
    if (err instanceof NseError && err.status === 404) {
      throw new NoBhavcopy(`no bhavcopy published for ${on.toISOString().slice(0, 10)}`);
    }
    throw err;
  }
  return parseBhavcopy(unzipSingle(raw));
}

/**
 * Store a day's prices.
 *
 * Only rows for instruments the fund follows are kept. The bhavcopy carries every listed symbol
 * and storing all of them would be three thousand rows a day of prices for companies nobody here
 * will ever look at.
 */
export async function storePrices(on: Date, rows: PriceRow[]): Promise<{ stored: number }> {
  const onDate = on.toISOString().slice(0, 10);
  return serviceTxn('system:ingest', async (c) => {
    const { rows: followed } = await c.query<{ isin: string | null; symbol: string }>(
      'SELECT isin, symbol FROM companies',
    );
    // ISIN first, because that is the instrument. Symbol is only a fallback for a followed company
    // whose ISIN we do not yet have.
    const byIsin = new Set(followed.map((f) => f.isin).filter((v): v is string => v !== null));
    const bySymbol = new Set(followed.filter((f) => f.isin === null).map((f) => f.symbol));

    let stored = 0;
    for (const r of rows) {
      const wanted = (r.isin !== null && byIsin.has(r.isin)) || bySymbol.has(r.symbol);
      if (!wanted) continue;
      await c.query(
        `INSERT INTO prices (symbol, on_date, isin, open, high, low, close, volume)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (symbol, on_date) DO UPDATE
            SET isin = EXCLUDED.isin, open = EXCLUDED.open, high = EXCLUDED.high,
                low = EXCLUDED.low, close = EXCLUDED.close, volume = EXCLUDED.volume`,
        [r.symbol, onDate, r.isin, r.open, r.high, r.low, r.close, r.volume],
      );
      stored++;
    }
    return { stored };
  });
}
