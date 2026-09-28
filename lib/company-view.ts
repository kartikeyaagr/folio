/**
 * The company screens' reads.
 *
 * Separate from `companies.ts`, which owns the *writes* — following a name, its status, its
 * coverage, its aliases. These are the wide, denormalised shapes the two screens want, and folding
 * them in would take that file past the line cap for no gain: nothing here is used by a job.
 */

import { readTxn } from './db.ts';
import type { Company } from './companies.ts';
import { INDICES } from './ingest/indices.ts';
import type { History } from './prices.ts';

export interface CompanyListRow extends Company {
  sector: string | null;
  quantity: string | null;
  avgCost: string | null;
  lastClose: string | null;
  filings30: number;
  news30: number;
  /**
   * Where the name is in the backfill queue — `filling in`, `waiting`, `not filled in`, or null
   * once its history has arrived.
   *
   * Rendered because without it the two states are indistinguishable on this screen. A name added
   * an hour ago whose history has not been fetched yet shows an empty last close, no filings and no
   * news; so does a name whose backfill gave up three attempts ago. TEGA sat in exactly the first
   * state from 16-Sep-2026 and the table said nothing about it. `<Blank why="No price row joins
   * this name yet" />` is true and answers the wrong question.
   */
  backfill: string | null;
  /** What the last attempt could not do. The `why` behind the word above. */
  backfillNote: string | null;
  removedByName: string | null;
}

/**
 * A row of the list, shared with the company's own page. That page reads it whether or not the
 * name is removed, because a removed name's page still opens: it is where the removal is said and
 * where Restore is.
 */
const LIST_SELECT = `
      SELECT co.id, co.symbol, co.isin, co.name, co.status,
              co.closed_reason AS "closedReason", co.covered_by AS "coveredBy",
              u.name AS "coveredByName", co.sector,
              h.quantity::text, h.avg_cost::text AS "avgCost",
              (SELECT p.close::text FROM prices p
                WHERE (p.isin IS NOT NULL AND p.isin = co.isin) OR p.symbol = co.symbol
                ORDER BY p.on_date DESC LIMIT 1) AS "lastClose",
              (SELECT count(*)::int FROM filings f
                WHERE f.company_id = co.id AND f.announced_at > now() - interval '30 days') AS "filings30",
              (SELECT count(*)::int FROM news_matches m
                WHERE m.company_id = co.id AND m.state = 'confirmed'
                  AND m.created_at > now() - interval '30 days') AS "news30",
              -- The lease and the bound are lib/ingest/backfill.ts's, repeated here rather than
              -- imported because a read model must not import a job's module to render a word.
              -- They are asserted equal in lib/ingest/backfill.test.ts, so a change to one fails.
              CASE
                WHEN co.backfilled_at IS NOT NULL AND co.backfill_error IS NOT NULL
                  THEN 'filled in, with gaps'
                WHEN co.backfilled_at IS NOT NULL THEN NULL
                WHEN co.backfill_attempts >= 3 THEN 'not filled in'
                WHEN co.backfill_started_at > now() - interval '90 minutes' THEN 'filling in'
                ELSE 'waiting'
              END AS backfill,
              co.backfill_error AS "backfillNote",
              co.removed_at AS "removedAt", r.name AS "removedByName"
         FROM companies co
         LEFT JOIN users u ON u.id = co.covered_by
         LEFT JOIN users r ON r.id = co.removed_by
         LEFT JOIN holdings h ON h.company_id = co.id`;

/**
 * Ordered by how much attention the name has a claim on: the book first, then what is being worked
 * on, then the watchlist, then what is closed. A closed name is kept and shown last — what was
 * passed on and why is part of the record, not clutter to be hidden.
 *
 * A removed name is the exception, and the difference is that a person asked for it to go. It is
 * listed only when asked for with `removed`, which is the only way to reach Restore from the list.
 */
export async function companyList(opts: { removed?: boolean } = {}): Promise<CompanyListRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<CompanyListRow>(
      `${LIST_SELECT}
        WHERE (co.removed_at IS NOT NULL) = $1
        ORDER BY CASE co.status
                   WHEN 'holding' THEN 0 WHEN 'working' THEN 1 WHEN 'watching' THEN 2
                   WHEN 'exited' THEN 3 ELSE 4 END,
                 co.symbol`,
      [opts.removed ?? false],
    );
    return rows;
  });
}

export interface CompanyPage extends CompanyListRow {
  quarters: {
    id: string; periodStart: string; periodEnd: string; periodKind: string; basis: string;
    revenue: string | null; profitAfterTax: string | null; contextDatesDisagreed: boolean;
  }[];
  shareholding: {
    asOf: string; promoterPct: string | null; pledgePct: string | null;
    encumberedPct: string | null; fiiPct: string | null; diiPct: string | null;
  }[];
  /** Named holders from the latest pattern. LODR names everyone above 1%; promoters always. */
  holders: {
    name: string; category: string; shares: string | null; pct: string | null;
  }[];
  insider: {
    id: string; disclosedAt: Date; person: string; category: string | null; kind: string | null;
    quantity: string | null; pctBefore: string | null; pctAfter: string | null;
  }[];
  events: { id: string; onDate: string; kind: string; title: string }[];
  aliases: { alias: string; kind: string }[];
}

export async function companyPage(symbol: string): Promise<CompanyPage | null> {
  return readTxn(async (c) => {
    const { rows: found } = await c.query<CompanyListRow>(`${LIST_SELECT} WHERE co.symbol = $1`, [
      symbol.trim().toUpperCase(),
    ]);
    const base = found[0];
    if (!base) return null;

    const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
      (await c.query<T>(sql, [base.id])).rows;

    return {
      ...base,
      quarters: await rows(
        `SELECT id, period_start::text AS "periodStart", period_end::text AS "periodEnd",
                period_kind AS "periodKind", basis, revenue::text,
                profit_after_tax::text AS "profitAfterTax",
                context_dates_disagreed AS "contextDatesDisagreed"
           FROM fundamentals WHERE company_id = $1 AND superseded_by IS NULL
          ORDER BY period_end DESC LIMIT 12`,
      ),
      shareholding: await rows(
        `SELECT as_of::text AS "asOf", promoter_pct::text AS "promoterPct",
                promoter_pledge_pct::text AS "pledgePct",
                promoter_encumbered_pct::text AS "encumberedPct",
                fii_pct::text AS "fiiPct", dii_pct::text AS "diiPct"
           FROM shareholding_patterns WHERE company_id = $1 ORDER BY as_of DESC LIMIT 8`,
      ),
      holders: await rows(
        // Ordered on the *table* column, not the output one. `SELECT pct::text` names its output
        // column `pct`, and ORDER BY prefers an output name over a table column — so a bare
        // `ORDER BY pct DESC` sorts the text, and 7.83 comes above 24.97. It renders as a list
        // that looks almost sorted, which is the kind of wrong that survives a glance.
        `SELECT name, category, shares::text, pct::text
           FROM shareholders
          WHERE company_id = $1
            AND as_of = (SELECT max(as_of) FROM shareholders WHERE company_id = $1)
          ORDER BY shareholders.pct DESC NULLS LAST`,
      ),
      insider: await rows(
        `SELECT id, disclosed_at AS "disclosedAt", person, category, kind, quantity::text,
                pct_before::text AS "pctBefore", pct_after::text AS "pctAfter"
           FROM insider_transactions WHERE company_id = $1
          ORDER BY disclosed_at DESC LIMIT 15`,
      ),
      events: await rows(
        `SELECT id, on_date::text AS "onDate", kind, title FROM calendar_events
          WHERE company_id = $1 AND on_date >= current_date - 30 ORDER BY on_date DESC LIMIT 10`,
      ),
      aliases: await rows('SELECT alias, kind FROM company_aliases WHERE company_id = $1 ORDER BY kind, alias'),
    };
  });
}

/**
 * The whole price history for one name, in one read.
 *
 * **All of it, not a window of it.** Changing the chart's range used to be a navigation: the range
 * was a query parameter, the page re-rendered on the server, and looking at five years and then at
 * one month cost two round trips to redraw a line over data the browser could already have had.
 * A five-year history for one name is about 1,250 closes — roughly 30KB of JSON, once — and
 * `windowOf` slices it in the browser from there.
 *
 * That is a deliberate exception to `CLAUDE.md`'s "state lives in the URL", argued in `windowOf`.
 */
export async function priceHistory(companyId: string): Promise<History> {
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
        ORDER BY p.on_date`,
      [companyId],
    );

    const { rows: today } = await c.query<{ d: string }>(
      "SELECT (current_date AT TIME ZONE 'Asia/Kolkata')::date::text AS d",
    );

    // Every benchmark, whole, in one read — for the same reason the prices are: the chart switches
    // between them, and a round trip per switch is what this page just stopped doing. Four indices
    // over a five-year walk is ~5,000 rows, which is the same order as the prices beside them.
    const { rows: levels } = await c.query<{ name: string; on: string; close: string }>(
      `SELECT name, on_date::text AS on, close::text AS close
         FROM index_levels WHERE name = ANY($1::text[]) ORDER BY name, on_date`,
      [INDICES.map((i) => i.name)],
    );

    return {
      points: rows.map((r) => ({ on: r.on, close: Number(r.close) })),
      heldFrom: span[0]?.from ?? null,
      heldTo: span[0]?.to ?? null,
      heldCount: Number(span[0]?.n ?? 0),
      asOf: today[0]!.d,
      // INDICES' order is the order the picker offers, benchmark first.
      indices: INDICES.map((i) => ({
        name: i.name,
        label: i.label,
        points: levels
          .filter((l) => l.name === i.name)
          .map((l) => ({ on: l.on, close: Number(l.close) })),
      })).filter((i) => i.points.length > 0),
    };
  });
}
