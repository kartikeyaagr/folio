/**
 * The company screens' reads.
 *
 * Separate from `companies.ts`, which owns the *writes* — following a name, its status, its
 * coverage, its aliases. These are the wide, denormalised shapes the two screens want, and folding
 * them in would take that file past the line cap for no gain: nothing here is used by a job.
 */

import { readTxn } from './db.ts';
import type { Company } from './companies.ts';

export interface CompanyListRow extends Company {
  sector: string | null;
  quantity: string | null;
  avgCost: string | null;
  lastClose: string | null;
  filings30: number;
  news30: number;
}

/**
 * Ordered by how much attention the name has a claim on: the book first, then what is being worked
 * on, then the watchlist, then what is closed. A closed name is kept and shown last — what was
 * passed on and why is part of the record, not clutter to be hidden.
 */
export async function companyList(): Promise<CompanyListRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<CompanyListRow>(
      `SELECT co.id, co.symbol, co.isin, co.name, co.status,
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
                  AND m.created_at > now() - interval '30 days') AS "news30"
         FROM companies co
         LEFT JOIN users u ON u.id = co.covered_by
         LEFT JOIN holdings h ON h.company_id = co.id
        ORDER BY CASE co.status
                   WHEN 'holding' THEN 0 WHEN 'working' THEN 1 WHEN 'watching' THEN 2
                   WHEN 'exited' THEN 3 ELSE 4 END,
                 co.symbol`,
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
  insider: {
    id: string; disclosedAt: Date; person: string; category: string | null; kind: string | null;
    quantity: string | null; pctBefore: string | null; pctAfter: string | null;
  }[];
  events: { id: string; onDate: string; kind: string; title: string }[];
  aliases: { alias: string; kind: string }[];
}

export async function companyPage(symbol: string): Promise<CompanyPage | null> {
  const base = (await companyList()).find(
    (c) => c.symbol.toUpperCase() === symbol.trim().toUpperCase(),
  );
  if (!base) return null;

  return readTxn(async (c) => {
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
