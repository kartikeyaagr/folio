/**
 * Reading filings.
 *
 * C1: exchange filings for our names, readable in the app. v2 ingested announcements every two
 * hours for months and built no screen for them at all — the largest gap in that system between
 * what was collected and what could be seen. For the SME half of this book the filings *are* the
 * news, so this is not a secondary view of something else.
 *
 * The default is followed names only. The table also holds every other listed company's
 * announcements, which is deliberate — a company added tomorrow arrives with its history already
 * present — but that history is not what anybody opens this page to read.
 */

import { readTxn } from './db.ts';

export interface FilingRow {
  id: string;
  symbol: string;
  companyId: string | null;
  name: string | null;
  category: string | null;
  summary: string | null;
  announcedAt: Date;
  attachmentUrl: string | null;
  hasXbrl: boolean;
  linkedBy: string | null;
  alertSeverity: string | null;
}

export interface FilingQuery {
  companyId?: string | null;
  /** Everything, including companies nobody here follows. */
  all?: boolean;
  category?: string | null;
  days?: number;
  limit?: number;
}

export async function filings(q: FilingQuery = {}): Promise<FilingRow[]> {
  const { companyId = null, all = false, category = null, days = 90, limit = 200 } = q;
  return readTxn(async (c) => {
    const { rows } = await c.query<FilingRow>(
      `SELECT f.id, f.symbol, f.company_id AS "companyId", co.name,
              f.category, f.summary, f.announced_at AS "announcedAt",
              f.attachment_url AS "attachmentUrl", f.has_xbrl AS "hasXbrl",
              f.linked_by AS "linkedBy",
              -- The severity of any alert this filing raised, so the list shows which ones the
              -- system already thought were worth interrupting somebody over.
              (SELECT a.severity FROM alerts a WHERE a.subject_ref = f.id LIMIT 1) AS "alertSeverity"
         FROM filings f
         LEFT JOIN companies co ON co.id = f.company_id
        WHERE ($1 OR f.company_id IS NOT NULL)
          AND ($2::text IS NULL OR f.company_id = $2)
          AND ($3::text IS NULL OR f.category = $3)
          AND f.announced_at > now() - ($4 || ' days')::interval
        ORDER BY f.announced_at DESC
        LIMIT $5`,
      [all, companyId, category, String(days), limit],
    );
    return rows;
  });
}

/** The categories actually present, for the filter. Never a hard-coded list: NSE invents them. */
export async function filingCategories(days = 90): Promise<{ category: string; n: number }[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ category: string; n: number }>(
      `SELECT f.category, count(*)::int AS n
         FROM filings f
        WHERE f.company_id IS NOT NULL AND f.category IS NOT NULL
          AND f.announced_at > now() - ($1 || ' days')::interval
        GROUP BY f.category
        ORDER BY n DESC, f.category`,
      [String(days)],
    );
    return rows;
  });
}
