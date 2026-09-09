/**
 * Corporate actions: bonuses, splits and dividends, from the exchange.
 *
 * B5 says nothing an ingest writes touches a position until a person confirms it, and until now
 * there was nothing to confirm — `corporate_actions` had no writer at all, so `confirmAction` and
 * the card above the book were reachable code with an empty table behind them.
 *
 * The feed answers one announcement per row with the whole meaning in a free-text `subject`;
 * `ca-subject.ts` reads that line and this file fetches, matches and stores what it returns.
 *
 * Measured on 19,036 rows fetched 09-Sep-2026, 2019-2026, both boards.
 */

import { createHash } from 'node:crypto';

import { serviceTxn } from '../db.ts';
import { readSubject, normalise, type Kind } from './ca-subject.ts';
import { NseSession } from './nse.ts';

export type Board = 'equities' | 'sme';

export interface Announcement {
  symbol: string;
  /** The first day a buyer does not get the entitlement. Present on every row in the corpus. */
  exDate: string;
  /** What the exchange stated, when it stated one. Absent on 9,100 of 19,036 rows. */
  recordDate: string | null;
  subject: string;
  series: string | null;
}

/** NSE writes these as DD-MMM-YYYY, and writes "-" where it has nothing. */
export function asDate(value: string): string | null {
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const i = 'janfebmaraprmayjunjulaugsepoctnovdec'.indexOf(m[2]!.toLowerCase());
  if (i < 0 || i % 3 !== 0) return null;
  return `${m[3]}-${String(i / 3 + 1).padStart(2, '0')}-${m[1]}`;
}

export function parseAnnouncements(rows: Record<string, unknown>[]): Announcement[] {
  const out: Announcement[] = [];
  for (const r of rows) {
    const symbol = String(r['symbol'] ?? '').trim().toUpperCase();
    const exDate = asDate(String(r['exDate'] ?? ''));
    const subject = String(r['subject'] ?? '').trim();
    // No ex-date is no action: it is the one date the exchange always states, and without it
    // there is nothing to replay against.
    if (!symbol || !exDate || !subject) continue;
    out.push({
      symbol,
      exDate,
      recordDate: asDate(String(r['recDate'] ?? '')),
      subject,
      series: String(r['series'] ?? '').trim() || null,
    });
  }
  return out;
}

const ddmmyyyy = (iso: string): string => iso.split('-').reverse().join('-');

/**
 * Ask the exchange for a window.
 *
 * `symbol` narrows it to one name and then serves that name's whole history rather than the
 * window's — PRAJIND answers with 14 rows back to 2015 — which is what lets a newly followed
 * company arrive with its actions already known.
 */
export async function fetchAnnouncements(
  board: Board,
  range: { from: string; to: string; symbol?: string },
  session?: NseSession,
): Promise<Announcement[]> {
  const s = session ?? (await NseSession.open());
  const params: Record<string, string> = {
    index: board,
    from_date: ddmmyyyy(range.from),
    to_date: ddmmyyyy(range.to),
  };
  if (range.symbol) params['symbol'] = range.symbol;
  return parseAnnouncements(await s.rows<Record<string, unknown>>('corporates-corporateActions', params));
}

/**
 * The id, derived from what identifies the announcement.
 *
 * **Keyed on the ex-date, not the record date.** The record date is missing on 9,100 rows and gets
 * filled in later, so an id built from it would mint a second row for the same action the day the
 * exchange completes its own record. The ex-date is on every row and does not change.
 *
 * The kind is in the key because one line can be two actions — "Bonus 3:1/Dividend - Rs 30 Per
 * Share" is both — and each is confirmed separately.
 */
const actionId = (a: Announcement, kind: Kind): string =>
  createHash('sha256')
    .update(`nse:${a.symbol}:${a.exDate}:${kind}:${normalise(a.subject)}`)
    .digest('hex')
    .slice(0, 32);

export interface ActionResult {
  seen: number;
  /** Announcements for names in the book. Everything else is not this fund's business. */
  ours: number;
  stored: number;
  /** Kept and reported rather than dropped: a form nobody has taught this parser is news. */
  declined: Record<string, number>;
}

/**
 * Store what belongs to followed names.
 *
 * Only followed names, for the reason `calendar.ts` gives: every listed company's dividend is
 * thousands of rows nobody here will read. Unlike the calendar, though, this has history worth
 * having, so `backfill-company.ts` asks for a newly followed name by symbol and gets all of it.
 *
 * **Matched on symbol, never on ISIN.** The feed's ISIN can be the pre-action one: VERTOZ's
 * consolidation row carries INE188Y01015 while the bhavcopy already carried INE188Y01023 the day
 * before the ex-date. This is the opposite of `bhavcopy.ts`, which joins on ISIN precisely because
 * the symbol is the less stable key there. Each is right about its own feed.
 */
export async function storeAnnouncements(items: Announcement[]): Promise<ActionResult> {
  return serviceTxn('system:ingest', async (c) => {
    const { rows: cos } = await c.query<{ id: string; symbol: string }>(
      'SELECT id, symbol FROM companies',
    );
    const bySymbol = new Map(cos.map((x) => [x.symbol, x.id]));

    const declined: Record<string, number> = {};
    let ours = 0;
    let stored = 0;

    for (const a of items) {
      const companyId = bySymbol.get(a.symbol);
      if (!companyId) continue;
      ours++;

      const reading = readSubject(a.subject);
      if (reading.declined) {
        declined[reading.declined] = (declined[reading.declined] ?? 0) + 1;
        continue;
      }

      for (const action of reading.actions) {
        const { rowCount } = await c.query(
          `INSERT INTO corporate_actions
             (id, company_id, kind, record_date, ex_date, ratio_from, ratio_to, amount_per_share,
              subject, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'nse')
           ON CONFLICT (id) DO UPDATE
              SET record_date = EXCLUDED.record_date,
                  ex_date = EXCLUDED.ex_date,
                  ratio_from = EXCLUDED.ratio_from,
                  ratio_to = EXCLUDED.ratio_to,
                  amount_per_share = EXCLUDED.amount_per_share,
                  subject = EXCLUDED.subject
            -- An action a person has already confirmed is history, and history does not get
            -- rewritten by a re-fetch. Without this a revised announcement would silently change
            -- the numbers a position was already replayed against.
            WHERE corporate_actions.applied_at IS NULL`,
          [
            actionId(a, action.kind),
            companyId,
            action.kind,
            // The exchange's own record date where it states one. Where it does not, the ex-date:
            // it is never later than the record date (measured across all 9,936 rows carrying
            // both), so it can only be conservative about which trades were on the register.
            a.recordDate ?? a.exDate,
            a.exDate,
            action.ratioFrom,
            action.ratioTo,
            action.amountPerShare,
            a.subject,
          ],
        );
        if (rowCount && rowCount > 0) stored++;
      }
    }

    return { seen: items.length, ours, stored, declined };
  });
}

/**
 * A window of the exchange's announcements, both boards.
 *
 * Zero rows for the whole exchange over a window this wide is a broken feed, not a quiet fortnight
 * — the same distinction `calendar.ts` draws, and the caller raises on it. Zero rows *for this
 * book* is entirely normal and says so separately.
 */
export async function ingestCorporateActions(days = 30): Promise<ActionResult> {
  const session = await NseSession.open();
  const to = new Date();
  // Forward as well as back. An action is announced before its ex-date, and the point of holding it
  // is to confirm it before it happens rather than to discover it afterwards.
  const from = new Date(to.getTime() - days * 86_400_000);
  const ahead = new Date(to.getTime() + 90 * 86_400_000);
  const range = { from: from.toISOString().slice(0, 10), to: ahead.toISOString().slice(0, 10) };

  const items: Announcement[] = [];
  for (const board of ['equities', 'sme'] as Board[]) {
    items.push(...(await fetchAnnouncements(board, range, session)));
  }
  return storeAnnouncements(items);
}
