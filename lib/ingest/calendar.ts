/**
 * Board meetings and results dates.
 *
 * Worth ingesting for a reason beyond convenience: for a company nobody writes about, results that
 * were *scheduled and never arrived* say more than most news does. That signal only exists if the
 * expected date was recorded in advance, which is the whole job of this file.
 */

import { createHash } from 'node:crypto';
import { serviceTxn } from '../db.ts';
import { NseSession } from './nse.ts';
import { nseDate } from './dates.ts';

export interface CalendarEvent {
  symbol: string;
  onDate: string;
  purpose: string | null;
  description: string | null;
  companyName: string | null;
}

/** NSE writes these as DD-MMM-YYYY. */
export function asDate(value: string): string | null {
  return nseDate(value);
}

export function parseCalendar(rows: Record<string, unknown>[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const r of rows) {
    const symbol = String(r['symbol'] ?? '').trim().toUpperCase();
    const onDate = asDate(String(r['date'] ?? ''));
    if (!symbol || !onDate) continue;
    out.push({
      symbol,
      onDate,
      purpose: String(r['purpose'] ?? '').trim() || null,
      description: String(r['bm_desc'] ?? '').trim() || null,
      companyName: String(r['company'] ?? '').trim() || null,
    });
  }
  return out;
}

export async function fetchCalendar(session?: NseSession): Promise<CalendarEvent[]> {
  const s = session ?? (await NseSession.open());
  return parseCalendar(await s.rows<Record<string, unknown>>('event-calendar'));
}

/**
 * The exchange gives these rows no id of their own, so one is derived from what identifies the
 * event: the company, the date and the purpose. Deterministic, so re-fetching the same calendar
 * updates rather than duplicates, and hashed rather than truncated so two long purposes sharing a
 * prefix cannot become the same row.
 */
const eventId = (e: CalendarEvent): string =>
  createHash('sha256').update(`nse:${e.symbol}:${e.onDate}:${e.purpose ?? ''}`).digest('hex').slice(0, 32);

const kindOf = (e: CalendarEvent): string =>
  /result/i.test(`${e.purpose ?? ''} ${e.description ?? ''}`) ? 'results' : 'board_meeting';

export interface CalendarResult {
  seen: number;
  stored: number;
  withdrawn: number;
}

/**
 * Store the events belonging to followed names, and withdraw the ones the exchange has dropped.
 *
 * Only followed names: unlike filings, which are kept wholesale so a newly followed company arrives
 * with its history, the calendar is forward-looking and has no history to bring — following a name
 * today and running this gets its upcoming events immediately. Every listed company's board meeting
 * would be thousands of rows a week that nobody here will read.
 *
 * The withdrawal half matters more than it looks. A board meeting that was announced and then
 * cancelled disappears from the feed, and a date sitting on the desk for a meeting that will not
 * happen is worse than no date at all. The feed is treated as authoritative **only over the window
 * it actually covers** — between its own earliest and latest dates — so a shrinking window can
 * never delete events beyond its reach.
 */
export async function storeCalendar(events: CalendarEvent[]): Promise<CalendarResult> {
  return serviceTxn('system:ingest', async (c) => {
    const { rows: cos } = await c.query<{ id: string; symbol: string }>(
      'SELECT id, symbol FROM companies WHERE removed_at IS NULL',
    );
    const bySymbol = new Map(cos.map((x) => [x.symbol, x.id]));

    const keep: string[] = [];
    let stored = 0;
    for (const e of events) {
      const companyId = bySymbol.get(e.symbol);
      if (!companyId) continue;
      const id = eventId(e);
      keep.push(id);
      await c.query(
        `INSERT INTO calendar_events (id, company_id, kind, title, on_date, source)
         VALUES ($1,$2,$3,$4,$5,'nse')
         ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title`,
        [id, companyId, kindOf(e), e.description ?? e.purpose ?? 'Board meeting', e.onDate],
      );
      stored++;
    }

    const dates = events.map((e) => e.onDate).sort();
    if (dates.length === 0) return { seen: 0, stored, withdrawn: 0 };

    const { rowCount } = await c.query(
      `DELETE FROM calendar_events
        WHERE source = 'nse'
          AND on_date BETWEEN $1 AND $2
          AND on_date >= current_date
          AND NOT (id = ANY($3))
          -- A removed name's events were skipped above, not dropped by the feed, so they are not
          -- the feed's to withdraw; counting them would report cancellations nobody announced.
          AND NOT EXISTS (
            SELECT 1 FROM companies co
             WHERE co.id = calendar_events.company_id AND co.removed_at IS NOT NULL)`,
      [dates[0], dates[dates.length - 1], keep],
    );
    return { seen: events.length, stored, withdrawn: rowCount ?? 0 };
  });
}

