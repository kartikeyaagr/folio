/**
 * What the company filed, as the file rather than as this system's reading of it.
 *
 * `lib/workspace.ts` owns `documents` — the things a person writes here, versioned and attributed.
 * This owns `attachments` — the PDFs the exchange published, which nobody wrote and nobody edits.
 * They were one list on the company page and should not have been: **a transcript existed twice**,
 * once as the PDF and once as a `documents` row holding its extracted text, and the page showed the
 * second. So the desk read a machine's reading of a filing while the filing itself was unreachable,
 * and the two copies gunked up retrieval as well — every transcript's text was in `sources` under
 * both `attachment` and `document_version`.
 *
 * The extracted text stays. It is what the agents and `/chat` search, and it is the only reason the
 * corpus can answer a question about a call. It is simply not what a person should be handed when
 * they click the name of a document the company published.
 *
 * ### Deduplication
 *
 * Three layers, and only the last is new.
 *
 *   1. **The store is content-addressed**, so two filings pointing at identical bytes are one file
 *      on disk and one row here. Measured 17-Sep-2026: 23 attachments are each referenced by more
 *      than one announcement.
 *   2. `DISTINCT ON (a.sha256)` in `lib/retrieval/register.ts` stops that fan-out reaching `sources`.
 *   3. **Identical text under different bytes is the same document.** A company re-files a
 *      corrected PDF — a new signature, a new timestamp, the same words — and content-addressing
 *      cannot see it, because the bytes genuinely differ. The extracted text can: TCL filed its
 *      1-Oct voting result again on 2-Oct and its 12-Nov board outcome twice in nine minutes.
 *      Grouped on the text, so one row is offered and the count says how many arrived.
 */

import { readTxn } from './db.ts';

/** What the panel calls it. One word where one word will do — the company is already on the page. */
export const FILE_LABEL: Record<string, string> = {
  transcript: 'Transcript',
  presentation: 'PPT',
  annual_report: 'Annual report',
  excel: 'Spreadsheet',
  filing: 'Filing',
  other: 'Archive',
};

/**
 * What a person opens a company to read.
 *
 * `filing` and `other` are held and searchable and are not here: 1,098 routine intimations —
 * trading-window closures, newspaper publications, depository certificates — and 245 zips would
 * bury the seventy documents anybody wants. The count of what is held but not listed is rendered
 * beside the panel rather than left to be discovered.
 */
export const READABLE_KINDS = ['transcript', 'presentation', 'annual_report', 'excel'] as const;

export interface FiledDocument {
  sha: string;
  kind: string;
  /** ISO date the exchange published it. Null for an annual report, which is filed for a year. */
  releasedOn: string | null;
  /** The year an annual report opens on: '2025' is FY2025-26. Null for everything else. */
  financialYear: string | null;
  /**
   * When this system received it. The only date an imported PDF has, and never presented as the
   * exchange's — a file somebody dragged in on Tuesday was not published on Tuesday.
   */
  addedOn: string;
  bytes: number;
  /** Re-filings of the same words collapsed into this one. 1 is the ordinary case. */
  copies: number;
  /** Whether its text reached the corpus — which is what the agents read, and all they read. */
  readable: boolean;
}

/**
 * Every filed document this company has, newest first, one row per document.
 *
 * The date is the exchange's, never ours. A filing carries `announced_at`; an annual report comes
 * from `/api/annual-reports` with no announcement behind it at all and carries a financial year;
 * an imported PDF has only the moment somebody dragged it in, which is the one case where "when we
 * got it" is the honest answer and is labelled as such by having no `releasedOn` of its own.
 */
export async function filedFor(companyId: string): Promise<FiledDocument[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<FiledDocument>(
      `WITH held AS (
         SELECT a.sha256, a.kind, a.bytes::int AS bytes,
                a.extracted_text IS NOT NULL AS readable,
                (SELECT min(f.announced_at)::date FROM filings f
                  WHERE f.attachment_sha256 = a.sha256) AS announced,
                (SELECT r.from_yr FROM annual_report_attempts r
                  WHERE r.sha256 = a.sha256 LIMIT 1) AS from_yr,
                a.added_at::date AS added,
                -- What makes two rows the same document. The text where there is text, and the
                -- hash otherwise — a scan has no text, and grouping every scan together under one
                -- NULL would collapse a company's unread filings into a single row.
                md5(coalesce(a.extracted_text, a.sha256)) AS same_document
           FROM attachments a
          WHERE a.company_id = $1 AND a.kind = ANY($2::text[])
       ), one_each AS (
         SELECT DISTINCT ON (same_document)
                sha256, kind, bytes, readable, announced, from_yr, added,
                count(*) OVER (PARTITION BY same_document)::int AS copies
           FROM held
          -- The earliest copy wins: the first time a document was filed is when it was released,
          -- and a correction filed the next day does not move that.
          ORDER BY same_document, coalesce(announced, added)
       )
       SELECT sha256 AS sha, kind, bytes, readable, copies,
              announced::text AS "releasedOn", from_yr AS "financialYear",
              added::text AS "addedOn"
         FROM one_each
        ORDER BY coalesce(announced, (from_yr || '-04-01')::date, added) DESC, sha256`,
      [companyId, READABLE_KINDS],
    );
    return rows;
  });
}

/** What is held for this company and deliberately not listed, so the absence is a stated number. */
export async function heldNotListed(companyId: string): Promise<number> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM attachments
        WHERE company_id = $1 AND NOT (kind = ANY($2::text[]))`,
      [companyId, READABLE_KINDS],
    );
    return Number(rows[0]!.n);
  });
}
