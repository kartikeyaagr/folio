/**
 * What is worth indexing, and what is deliberately not.
 *
 * One `INSERT … SELECT … ON CONFLICT` per kind, each carrying its exclusion where the query is,
 * because each exclusion is a decision:
 *
 *   document_version    the CURRENT version only. An older version exists to be read by a person,
 *                        not retrieved five times over with slightly different wording.
 *   news_item            confirmed matches only — the rule agent 6 (lib/news/gate.ts) already
 *                        applies. A candidate has no stated mechanism and is not the fund's
 *                        knowledge.
 *   attachment           a text layer must exist. `extracted_text IS NULL` means the PDF could not
 *                        be read (extract.ts raises `NoTextInPdf` on a scan), not that it has not
 *                        been read yet.
 *   filing               linked to a followed company. `lib/ingest/filings.ts`'s
 *                        `fetchAnnouncements` stores the whole exchange feed, not just our names —
 *                        measured 10-Sep-2026, 11,044 of 12,067 filings carry no `company_id`.
 *                        Indexing all of them would put a stranger's AGM notice beside Praj's every
 *                        time this desk searched.
 *   fundamentals_period  the current, non-superseded figures only — the same predicate every other
 *                        reader of this table already uses (`lib/company-view.ts`,
 *                        `lib/agents/results.ts`). A restatement is a new row; the superseded
 *                        figures are what was believed at the time, not what is worth finding
 *                        today.
 *
 * `registerAll` runs all five and returns how many `sources` rows were newly registered or
 * actually changed. See `UPSERT` for why a second, no-op run reports zero.
 */
import { createHash } from 'node:crypto';
import type { Client } from '../db.ts';

export type SourceKind =
  | 'document_version'
  | 'attachment'
  | 'filing'
  | 'news_item'
  | 'fundamentals_period';

export interface Indexable {
  kind: SourceKind;
  refId: string;
  companyId: string | null;
  title: string;
  occurredAt: string | null;
  text: string;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Shared by all five inserts.
 *
 * `indexed_at`/`index_error` clear only when `content_hash` actually moved — the difference
 * between a memo costing one embed per afternoon and one per save.
 *
 * The trailing `WHERE` guards the `DO UPDATE` itself. Verified 10-Sep-2026: Postgres counts a
 * `DO UPDATE` as an affected row even when it writes back values already there, so an unconditional
 * upsert over unchanged data reports the same count on every run — the opposite of what a "rows
 * registered" return value is for. With the guard, a row that is genuinely new or genuinely changed
 * (title, date or content) still counts; a run that changes nothing reports nothing.
 */
const UPSERT = `
  ON CONFLICT (kind, ref_id) DO UPDATE
     SET title = EXCLUDED.title,
         occurred_at = EXCLUDED.occurred_at,
         content_hash = EXCLUDED.content_hash,
         indexed_at = CASE WHEN sources.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                           THEN NULL ELSE sources.indexed_at END,
         index_error = CASE WHEN sources.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                            THEN NULL ELSE sources.index_error END
   WHERE (sources.title, sources.occurred_at, sources.content_hash)
         IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.occurred_at, EXCLUDED.content_hash)`;

// Documents: the CURRENT version only, and `ref_id` is the DOCUMENT's id, not the version row's.
//
// A version row is immutable and bigserial-keyed, so if `ref_id` were `v.id` (as a first draft of
// this had it), every save would mint a ref_id nothing has ever seen before — always a fresh
// INSERT, never a conflict — and content_hash could never suppress a re-embed, which contradicts
// the entire reason 0040 gives that column ("a <textarea> saved six times in an afternoon is six
// document_versions rows but one hash, so it costs one embed"). Keying on the document instead
// means a re-save always targets the SAME sources row: ON CONFLICT fires, content_hash is compared,
// and indexed_at clears only when the text actually moved. It is also the only reading under which
// "superseding cascades the old chunks away" is literal rather than aspirational — the old chunks
// hang off the source row that the new version's INSERT just conflicted into, not off a row that
// nothing ever revisits.
//
// JOIN LATERAL … LIMIT 1 caps the SELECT at one row per document, so — unlike the two joins below —
// there is no fan-out to guard against.
//
// The tie-break on `vv.id DESC` is load-bearing, not decoration: `now()` is stable for the whole
// transaction it runs in, so two saves issued back to back (a paste followed immediately by a
// second save, or this file's own tests) land the identical `written_at` — verified 10-Sep-2026.
// `ORDER BY written_at DESC` alone is then a tie a plan can break either way, and the LATERAL
// picks whichever row the scan happens to visit first. `id` is a bigserial and strictly increasing
// regardless of clock resolution, so it is the only safe secondary key.
const DOCUMENTS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  SELECT 'document_version', d.id, d.company_id, d.title, v.written_at,
         encode(sha256(convert_to(coalesce(v.body->>'text', v.body::text), 'UTF8')), 'hex')
    FROM documents d
    JOIN LATERAL (SELECT * FROM document_versions vv
                   WHERE vv.document_id = d.id
                   ORDER BY vv.written_at DESC, vv.id DESC LIMIT 1) v ON true
   WHERE d.archived_at IS NULL
` + UPSERT;

// News: confirmed matches only. `news_matches` is one row per (item, company) — a story can
// confirm for more than one followed name. `DISTINCT ON` picks one deterministically: without it,
// two confirmed rows for the same item produce two INSERT rows with the same (kind, ref_id), and
// Postgres refuses with "ON CONFLICT DO UPDATE command cannot affect row a second time" — a crash
// waiting on the day two portfolio names share one story, not a hypothetical.
const NEWS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  SELECT DISTINCT ON (i.id)
         'news_item', i.id, m.company_id, i.title,
         coalesce(i.published_at, i.fetched_at),
         encode(sha256(convert_to(i.title || coalesce(i.summary,''), 'UTF8')), 'hex')
    FROM news_matches m JOIN news_items i ON i.id = m.item_id
   WHERE m.state = 'confirmed'
   ORDER BY i.id, m.company_id
` + UPSERT;

// Attachments: a text layer must have been extracted. `extracted_text IS NULL` means the PDF could
// not be read, not that it has not been read yet — extract.ts raises NoTextInPdf on a scan rather
// than storing an empty string.
//
// **LEFT JOIN, and this is load-bearing.** An attachment does not have to be an exchange
// announcement: an annual report fetched from /api/annual-reports (Task 12) carries no filings
// row at all, and neither does a PDF dragged into the import dialog. An inner join here would
// silently index neither — the bytes land, the text extracts, and retrieval never sees it.
// `attachments` carries its own company_id and added_at for exactly this case.
//
// `filings.attachment_sha256` is not unique — the same content-addressed PDF can be attached to
// more than one announcement. Verified 10-Sep-2026 against the live corpus: at least five distinct
// attachments are each referenced by 2–5 filings, and every one of them has extracted_text. A bare
// LEFT JOIN fans out to one row per referencing filing and hits the same ON CONFLICT cardinality
// error as the news case above — not theoretical, already true of today's data. DISTINCT ON picks
// the most recently announced filing that references it, if any.
const ATTACHMENTS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  SELECT DISTINCT ON (a.sha256)
         'attachment', a.sha256,
         coalesce(f.company_id, a.company_id),
         coalesce(f.summary, a.filename),
         coalesce(f.announced_at, a.added_at),
         encode(sha256(convert_to(a.extracted_text, 'UTF8')), 'hex')
    FROM attachments a
    LEFT JOIN filings f ON f.attachment_sha256 = a.sha256
   WHERE a.extracted_text IS NOT NULL AND length(a.extracted_text) > 0
   ORDER BY a.sha256, f.announced_at DESC NULLS LAST
` + UPSERT;

// A filing's own searchable text: the exchange's announcement category and, since 0025, the
// `attchmntText` NSE actually sends (`summary` — `subject` was dropped for quietly holding the
// filer's name instead). Shared between the INSERT below and textFor so a chunk always matches
// what was hashed.
const FILING_TEXT_SQL = `
  CASE WHEN f.category IS NOT NULL AND f.summary IS NOT NULL THEN f.category || ': ' || f.summary
       WHEN f.category IS NOT NULL THEN f.category
       ELSE coalesce(f.summary, '') END`;

// Filings: linked to a followed company only. fetchAnnouncements (lib/ingest/filings.ts) stores
// the exchange's entire corporate-announcements feed so a newly followed name arrives with its
// history already attached (companies.test.ts) — most of those rows are never linked to any of
// our three names. Indexing the unlinked 92% would make every filing search mostly noise about
// companies this desk does not follow.
const FILINGS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  SELECT 'filing', f.id, f.company_id, coalesce(f.category, 'Filing'), f.announced_at,
         encode(sha256(convert_to(${FILING_TEXT_SQL}, 'UTF8')), 'hex')
    FROM filings f
   WHERE f.company_id IS NOT NULL
` + UPSERT;

const CRORE = 10_000_000;
const PERIOD_LABEL: Record<string, string> = {
  quarter: 'quarter',
  half_year: 'half year',
  year_to_date: 'year to date',
  year: 'year',
};

const cr = (v: string | null): string => (v === null ? 'not reported' : `${(Number(v) / CRORE).toFixed(1)} cr`);

interface FundamentalsRow {
  companyName: string;
  periodKind: string;
  periodEnd: string;
  revenue: string | null;
  profitAfterTax: string | null;
}

/**
 * The one kind rendered in TypeScript rather than SQL: "what a person would actually search for"
 * is prose, and building prose in SQL string concatenation is how you get "Praj Industries
 * Limitedquarter to2025-03-31" the first time a coalesce is missing. Shared between registration
 * (to hash) and textFor (to re-derive exactly the same text for chunking).
 */
function renderFundamentals(row: FundamentalsRow): { title: string; text: string } {
  const period = `${PERIOD_LABEL[row.periodKind] ?? row.periodKind} to ${row.periodEnd}`;
  const title = `${row.companyName}, ${period}`;
  const text = `${title}: revenue ${cr(row.revenue)}, PAT ${cr(row.profitAfterTax)}`;
  return { title, text };
}

async function registerFundamentals(c: Client): Promise<number> {
  const { rows } = await c.query<{
    id: string;
    company_id: string;
    name: string;
    period_kind: string;
    period_end: string;
    revenue: string | null;
    profit_after_tax: string | null;
  }>(
    `SELECT f.id, f.company_id, c.name, f.period_kind, f.period_end::text,
            f.revenue::text AS revenue, f.profit_after_tax::text AS profit_after_tax
       FROM fundamentals f JOIN companies c ON c.id = f.company_id
      WHERE f.superseded_by IS NULL`,
  );
  if (rows.length === 0) return 0;

  const refId: string[] = [];
  const companyId: string[] = [];
  const title: string[] = [];
  const occurredAt: string[] = [];
  const hash: string[] = [];
  for (const r of rows) {
    const rendered = renderFundamentals({
      companyName: r.name,
      periodKind: r.period_kind,
      periodEnd: r.period_end,
      revenue: r.revenue,
      profitAfterTax: r.profit_after_tax,
    });
    refId.push(r.id);
    companyId.push(r.company_id);
    title.push(rendered.title);
    occurredAt.push(r.period_end);
    hash.push(contentHash(rendered.text));
  }

  const { rowCount } = await c.query(
    `INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
     SELECT 'fundamentals_period', x.ref_id, x.company_id, x.title, x.occurred_at, x.content_hash
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::text[])
         AS x(ref_id, company_id, title, occurred_at, content_hash)
     ${UPSERT}`,
    [refId, companyId, title, occurredAt, hash],
  );
  return rowCount ?? 0;
}

/** Runs all five registrations and returns how many `sources` rows were newly added or changed. */
export async function registerAll(c: Client): Promise<number> {
  let total = 0;
  for (const sql of [DOCUMENTS, NEWS, ATTACHMENTS, FILINGS]) {
    const { rowCount } = await c.query(sql);
    total += rowCount ?? 0;
  }
  return total + (await registerFundamentals(c));
}

/**
 * The text a source hashed, reconstructed for chunking. Each branch mirrors exactly the expression
 * its kind's INSERT used to compute `content_hash` — same input, so the chunker always cuts up
 * what was actually indexed.
 */
async function rawText(c: Client, kind: SourceKind, refId: string): Promise<string | null> {
  switch (kind) {
    case 'document_version': {
      // refId is the document's id (see DOCUMENTS above), so re-derive the same "current version"
      // this document would register today, not a specific version row.
      const { rows } = await c.query<{ text: string }>(
        `SELECT coalesce(v.body->>'text', v.body::text) AS text
           FROM document_versions v
          WHERE v.document_id = $1
          ORDER BY v.written_at DESC, v.id DESC LIMIT 1`,
        [refId],
      );
      return rows[0]?.text ?? null;
    }
    case 'attachment': {
      const { rows } = await c.query<{ text: string | null }>(
        `SELECT extracted_text AS text FROM attachments WHERE sha256 = $1`,
        [refId],
      );
      return rows[0]?.text ?? null;
    }
    case 'filing': {
      const { rows } = await c.query<{ text: string }>(
        `SELECT ${FILING_TEXT_SQL} AS text FROM filings f WHERE f.id = $1`,
        [refId],
      );
      return rows[0]?.text ?? null;
    }
    case 'news_item': {
      const { rows } = await c.query<{ text: string }>(
        `SELECT i.title || coalesce(i.summary,'') AS text FROM news_items i WHERE i.id = $1`,
        [refId],
      );
      return rows[0]?.text ?? null;
    }
    case 'fundamentals_period': {
      const { rows } = await c.query<{
        name: string;
        period_kind: string;
        period_end: string;
        revenue: string | null;
        profit_after_tax: string | null;
      }>(
        `SELECT c.name, f.period_kind, f.period_end::text,
                f.revenue::text AS revenue, f.profit_after_tax::text AS profit_after_tax
           FROM fundamentals f JOIN companies c ON c.id = f.company_id
          WHERE f.id = $1`,
        [refId],
      );
      const r = rows[0];
      if (!r) return null;
      return renderFundamentals({
        companyName: r.name,
        periodKind: r.period_kind,
        periodEnd: r.period_end,
        revenue: r.revenue,
        profitAfterTax: r.profit_after_tax,
      }).text;
    }
  }
}

/** A source's full indexable payload, for the chunker. Null when the source id no longer exists. */
export async function textFor(c: Client, sourceId: string): Promise<Indexable | null> {
  const { rows } = await c.query<{
    kind: SourceKind;
    ref_id: string;
    company_id: string | null;
    title: string;
    occurred_at: Date | null;
  }>(`SELECT kind, ref_id, company_id, title, occurred_at FROM sources WHERE id = $1::bigint`, [sourceId]);
  const s = rows[0];
  if (!s) return null;

  const text = await rawText(c, s.kind, s.ref_id);
  if (text === null) return null;

  return {
    kind: s.kind,
    refId: s.ref_id,
    companyId: s.company_id,
    title: s.title,
    occurredAt: s.occurred_at ? s.occurred_at.toISOString() : null,
    text,
  };
}
