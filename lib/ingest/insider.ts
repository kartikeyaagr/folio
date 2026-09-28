/**
 * SEBI PIT disclosures: insider trades and pledge events.
 *
 * One feed, two kinds of signal. A promoter selling and a promoter pledging are both regulation 7
 * filings, distinguished by transaction type rather than by endpoint, and they are read together —
 * a pledge created in the same week as a market sale is a different story from either alone.
 *
 * **Fetched per company, not per window.** Two things were measured on the live endpoint on
 * 07-Sep-2026, and both contradict the obvious design:
 *
 *   1. A date window with no symbol returns *zero rows*, at 200, for every window tried. v2 fetched
 *      exactly that way and reported "0 disclosures in the window" — a broken feed that reads like
 *      a quiet month. This is the second time a silent-empty has cost this system real signal.
 *   2. A symbol with no window is capped at 20 rows. A symbol *with* a wide window returns the lot:
 *      PRAJIND gives 232 rows back to 2016. So the window is not a filter here, it is what unlocks
 *      history — and it only works alongside a symbol.
 *
 * `index` is ignored when a symbol is given: PRAJIND, a mainboard name, returns its full 232 rows
 * under `index=sme`. So there is no board to get right, and one call per followed name is the
 * whole strategy. That also means a newly followed company arrives with its complete history and
 * there is no backfill job to remember to run.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';
import { NseSession } from './nse.ts';
import { nseDate } from './dates.ts';

const REFERER = 'https://www.nseindia.com/companies-listing/corporate-filings-insider-trading';

/** How far back a first fetch reaches. Beyond this NSE has little, and nobody is reading it. */
const HISTORY_FROM = '01-01-2015';

export interface InsiderRow {
  sourceUid: string;
  symbol: string;
  person: string;
  category: string | null;
  kind: string | null;
  mode: string | null;
  quantity: number | null;
  value: number | null;
  pctBefore: number | null;
  pctAfter: number | null;
  disclosedAt: string;
  periodStart: string | null;
  periodEnd: string | null;
}

/** NSE uses '-' for absent, and 0 is a real quantity. */
function num(v: unknown): number | null {
  const s = String(v ?? '').replace(/,/g, '').trim();
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function text(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' || s === '-' ? null : s;
}

/** Dates arrive as DD-MMM-YYYY, sometimes with a time after them. */
export function pitDate(value: unknown): string | null {
  return nseDate(value);
}

/**
 * The same, keeping the time when there is one, because two disclosures can share a day.
 *
 * **The offset is not decoration.** `insider_transactions.disclosed_at` is `timestamptz`, so a
 * string with no zone is resolved against the session's TimeZone — which L19 measured as
 * `Etc/UTC` on the VM. NSE publishes IST, so a disclosure filed at 15:23 was stored as 15:23 UTC
 * and read back as 20:53 IST: every timed disclosure 5h30m late, and anything after 18:30 IST on
 * the following day. It passed unnoticed because a developer's laptop runs in IST, where the
 * session zone happens to be the right one and the round trip looks clean.
 *
 * `dates.ts`'s `nseTimestamp` has appended `+05:30` for this reason since it was written; this
 * was a second, private copy of the same job that did not. Kept separate rather than folded into
 * `nseTimestamp` because that one returns a `Date` and this one hands Postgres a string.
 *
 * The date-only form is anchored too. Midnight UTC is 05:30 IST, so the day survived either way,
 * but a value that names its zone cannot be re-interpreted by whatever box reads it next.
 */
function pitTimestamp(value: unknown): string | null {
  const day = pitDate(value);
  if (!day) return null;
  const t = /(\d{2}:\d{2})(?::(\d{2}))?\s*$/.exec(String(value));
  return t ? `${day}T${t[1]}:${t[2] ?? '00'}+05:30` : `${day}T00:00:00+05:30`;
}

export function parseInsider(rows: Record<string, unknown>[]): InsiderRow[] {
  const out: InsiderRow[] = [];
  for (const r of rows) {
    const sourceUid = text(r['did']);
    const symbol = text(r['symbol'])?.toUpperCase();
    const disclosedAt = pitTimestamp(r['date']) ?? pitDate(r['intimDt']);
    if (!sourceUid || !symbol || !disclosedAt) continue;
    out.push({
      sourceUid,
      symbol,
      // A disclosure always names someone; an unnamed one is still a disclosure worth keeping.
      person: text(r['acqName']) ?? 'unknown',
      category: text(r['personCategory']),
      kind: text(r['tdpTransactionType']),
      mode: text(r['acqMode']),
      // secAcq carries the quantity for a buy and for a sell alike. buyQuantity and sellquantity
      // read 0 even on rows that plainly moved shares, so they are not used.
      quantity: num(r['secAcq']),
      value: num(r['secVal']),
      pctBefore: num(r['befAcqSharesPer']),
      pctAfter: num(r['afterAcqSharesPer']),
      disclosedAt,
      periodStart: pitDate(r['acqfromDt']),
      periodEnd: pitDate(r['acqtoDt']),
    });
  }
  return out;
}

export async function fetchInsider(
  symbol: string,
  session?: NseSession,
  from = HISTORY_FROM,
): Promise<InsiderRow[]> {
  const s = session ?? (await NseSession.open());
  const now = new Date();
  const to = `${String(now.getDate()).padStart(2, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${now.getFullYear()}`;
  return parseInsider(
    await s.rows<Record<string, unknown>>(
      'corporates-pit',
      { index: 'equities', symbol, from_date: from, to_date: to },
      REFERER,
    ),
  );
}

const rowId = (r: InsiderRow): string =>
  createHash('sha256').update(`nse:pit:${r.sourceUid}`).digest('hex').slice(0, 32);

export interface InsiderResult {
  seen: number;
  stored: number;
}

/**
 * Store disclosures for one company.
 *
 * A disclosure is immutable once filed, so a re-fetch of the same `did` updates nothing but the
 * columns NSE can revise. Revisions arrive as their own rows with their own ids.
 *
 * **`disclosed_at` is in the set list even though NSE never revises it**, and the distinction is
 * worth keeping straight: the other four columns are there because the *source* can change, this
 * one is there because our *reading* of the source can. It did — `pitTimestamp` sent a zone-less
 * string into a `timestamptz` column until 21-Sep-2026, so every timed disclosure already stored
 * is 5h30m late on a box whose session zone is UTC. Without this line a re-fetch would leave that
 * history exactly as it is, because the row already exists and nothing in the old set list
 * touched the time.
 *
 * So the repair is a re-run rather than a migration, which is the safer of the two: a migration
 * shifting every row back 5h30m is only correct for rows written while the session zone was UTC,
 * and would move any row written from a laptop in IST *wrong*. Re-fetching cannot double-shift
 * and needs nobody to work out which rows are which. Date-only rows are unaffected either way —
 * midnight UTC and midnight IST fall on the same day.
 */
export async function storeInsider(companyId: string, rows: InsiderRow[]): Promise<InsiderResult> {
  return serviceTxn('system:ingest', async (c) => {
    let stored = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO insider_transactions
           (id, company_id, symbol, person, category, kind, quantity, value, mode,
            disclosed_at, period_start, period_end, pct_before, pct_after)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET
           quantity = EXCLUDED.quantity, value = EXCLUDED.value,
           pct_before = EXCLUDED.pct_before, pct_after = EXCLUDED.pct_after,
           disclosed_at = EXCLUDED.disclosed_at`,
        [
          rowId(r), companyId, r.symbol, r.person, r.category, r.kind, r.quantity, r.value,
          r.mode, r.disclosedAt, r.periodStart, r.periodEnd, r.pctBefore, r.pctAfter,
        ],
      );
      stored++;
    }
    return { seen: rows.length, stored };
  });
}

/** Every followed name, one call each. */
export async function ingestInsider(): Promise<{ companies: number; stored: number }> {
  const companies = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string; symbol: string }>(
      'SELECT id, symbol FROM companies WHERE removed_at IS NULL ORDER BY symbol',
    );
    return rows;
  });

  const session = await NseSession.open();
  let stored = 0;
  for (const co of companies) {
    const rows = await fetchInsider(co.symbol, session);
    stored += (await storeInsider(co.id, rows)).stored;
  }
  return { companies: companies.length, stored };
}
