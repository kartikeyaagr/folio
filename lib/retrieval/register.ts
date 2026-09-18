/**
 * What is worth indexing, and what is deliberately not.
 *
 * One `INSERT … SELECT … ON CONFLICT` per kind, each carrying its exclusion where the query is,
 * because each exclusion is a decision:
 *
 *   document_version    the CURRENT version of an unarchived document only. An older version exists
 *                        to be read by a person, not retrieved five times over with slightly
 *                        different wording.
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
 * Every one of those five predicates can turn FALSE after a row is already registered — a document
 * gets archived, a period gets restated, a match gets rejected — and an `INSERT … SELECT` only ever
 * governs what gets (re-)proposed; it cannot retract a row it no longer selects. `./reap.ts` is the
 * other half: `registerAll` hands it these same five `*_SELECT` constants, and it deletes whatever
 * no longer appears in them, before anything new is proposed. See that file for the full argument
 * and the measured evidence that this is not theoretical.
 *
 * `registerAll` reaps, then runs all five registrations, and returns how many `sources` rows were
 * newly added or changed by the latter. See `UPSERT` for why a second, no-op run reports zero.
 */
import { createHash } from 'node:crypto';
import type { Client } from '../db.ts';
import { reapAll } from './reap.ts';
import { sheetGridText } from './chunk.ts';
import { croreText } from '../money.ts';

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
  // Non-null only for a document_version whose body is a sheet — see rawText's document_version
  // branch. Carried through explicitly so lib/retrieval/index.ts's piecesFor can pick chunkCells
  // without re-sniffing `text`'s shape: `text` is now sheetGridText(cells), the same string
  // chunkCells itself computes offsets into, and a re-sniff would only risk the two falling out of
  // step again.
  cells: Record<string, string> | null;
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Shared by all five inserts.
 *
 * `indexed_at`/`index_error` clear only when `content_hash` actually moved — the difference
 * between a memo costing one embed per afternoon and one per save. A vector is a function of the
 * text and of nothing else, so only the text can invalidate it; company and date moving is handled
 * by `syncChunkMetadata` below, which corrects the copies without paying to re-embed.
 *
 * `company_id` is in the SET list, and load-bearing there — not just carried along. Found while
 * writing the negative test for the news reap below: NEWS_SELECT's `DISTINCT ON (i.id)` can pick a
 * DIFFERENT winning company for the same item across two runs (a story confirmed for two followed
 * names, one of whose matches is later rejected, re-attributes to the other) with title,
 * occurred_at and content_hash all unchanged — a company_id-only change. An earlier draft of this
 * UPSERT omitted `company_id` from SET entirely, so that re-attribution silently never wrote; the
 * row stayed pointed at the rejected match's company forever. Caught by the test, not by
 * inspection.
 *
 * The trailing `WHERE` guards the `DO UPDATE` itself, and now includes `company_id` for the same
 * reason it is in SET: without it here too, Postgres still counts the UPDATE as an affected row on
 * every re-run even once the value is correctly written, which would make "registering twice
 * registers nothing" false the moment company_id ever legitimately changes. Verified 10-Sep-2026:
 * Postgres counts a `DO UPDATE` as an affected row even when it writes back values already there,
 * so an unconditional upsert over unchanged data reports the same count on every run — the
 * opposite of what a "rows registered" return value is for. With the guard, a row that is
 * genuinely new or genuinely changed (title, date, company or content) still counts; a run that
 * changes nothing reports nothing.
 */
const UPSERT = `
  ON CONFLICT (kind, ref_id) DO UPDATE
     SET title = EXCLUDED.title,
         occurred_at = EXCLUDED.occurred_at,
         company_id = EXCLUDED.company_id,
         content_hash = EXCLUDED.content_hash,
         indexed_at = CASE WHEN sources.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                           THEN NULL ELSE sources.indexed_at END,
         index_error = CASE WHEN sources.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                            THEN NULL ELSE sources.index_error END
   WHERE (sources.title, sources.occurred_at, sources.company_id, sources.content_hash)
         IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.occurred_at, EXCLUDED.company_id, EXCLUDED.content_hash)
  RETURNING id`;

// The "current version" tie-break: newest written_at, ties broken by id. Shared between DOCUMENTS
// (which decides what gets hashed) and rawText's document_version branch (which must re-derive
// exactly that same row for the chunker) so the two definitions of "current" can never drift apart
// — FILING_TEXT_SQL makes the identical argument for filings below, and the failure mode is the
// same one it names: hash one version, chunk another, and nothing anywhere would report it.
//
// The `id` tie-break is load-bearing, not decoration: `now()` is stable for the whole transaction
// it runs in, so two saves issued back to back (a paste followed immediately by a second save, or
// this file's own tests) land the identical `written_at` — verified 10-Sep-2026. `written_at DESC`
// alone is then a tie a plan can break either way. `id` is a bigserial and strictly increasing
// regardless of clock resolution, so it is the only safe secondary key. Assumes the table in scope
// is aliased `v`, as both call sites below do.
const CURRENT_VERSION_ORDER_SQL = 'ORDER BY v.written_at DESC, v.id DESC LIMIT 1';

// Documents: the CURRENT version only, and `ref_id` is the DOCUMENT's id, not the version row's.
//
// A version row is immutable and bigserial-keyed, so if `ref_id` were `v.id` (as a first draft of
// this had it), every save would mint a ref_id nothing has ever seen before — always a fresh
// INSERT, never a conflict — and content_hash could never suppress a re-embed, which contradicts
// the entire reason 0040 gives that column ("a <textarea> saved six times in an afternoon is six
// document_versions rows but one hash, so it costs one embed"). Keying on the document instead
// means a re-save always targets the SAME sources row: ON CONFLICT fires, content_hash is compared,
// and indexed_at clears only when the text actually moved.
//
// JOIN LATERAL … LIMIT 1 caps the SELECT at one row per document, so — unlike NEWS and ATTACHMENTS
// below — there is no fan-out to guard against.
//
// `d.archived_at IS NULL`: `documents.archived_at` is a soft delete — the row always stays, because
// in this system deletion is never destruction (lib/workspace.ts). But an archived document is one
// somebody decided is no longer part of the record, and continuing to retrieve it would put a
// withdrawn memo in front of a reader as though it still stood. On its own this WHERE only stops
// that from happening going forward, for a document archived before it was ever registered — it
// cannot undo a registration already done. `./reap.ts` is the half that actually retracts one: a
// document archived AFTER registration no longer appears in this SELECT at all, so its NOT EXISTS
// finds nothing and the row (and its chunks, cascading from sources.id per 0041) is deleted.
// A sheet's hash carries GRID_RENDERER, and it has to. What gets chunked for a sheet is
// `sheetGridText(cells)`, not the body — so a change to that renderer changes the text the offsets
// index into while `body::text` stays byte-identical, leaving `content_hash` still, `indexed_at`
// still set, and every stored `char_from`/`char_to` pointing into a string `textFor` no longer
// returns. That is exactly the divergence `chunk.ts`'s header records as already having happened
// once (chunk 2069, verified live). SQL cannot run the renderer, so the tag stands in for it: bump
// it in the same commit as any change to `sheetGridText`, and every sheet re-chunks once.
//
// v2: column ordering moved from `localeCompare` to `columnIndex`, so a sheet wider than 26 columns
// renders in a different order than it did under v1.
const GRID_RENDERER = 'grid-v2';

// This constant is interpolated into SQL rather than bound, because DOCUMENTS_SELECT is a static
// string. No request data reaches it — but a future value carrying an apostrophe would be a syntax
// error raised inside `drain()`'s single transaction, taking a whole batch down for a typo. The
// charset is asserted here so that mistake is a module-load failure instead.
if (!/^[a-z0-9-]+$/.test(GRID_RENDERER)) {
  throw new Error(`GRID_RENDERER must be [a-z0-9-]; got ${GRID_RENDERER}`);
}

const DOCUMENTS_SELECT = `
  SELECT 'document_version' AS kind, d.id AS ref_id, d.company_id, d.title, cur.written_at AS occurred_at,
         encode(sha256(convert_to(
           CASE WHEN jsonb_exists(cur.body, 'cells') THEN '${GRID_RENDERER}:' || cur.body::text
                ELSE coalesce(cur.body->>'text', cur.body::text) END, 'UTF8')), 'hex') AS content_hash
    FROM documents d
    JOIN LATERAL (
      SELECT * FROM document_versions v WHERE v.document_id = d.id ${CURRENT_VERSION_ORDER_SQL}
    ) cur ON true
   WHERE d.archived_at IS NULL`;

const DOCUMENTS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  ${DOCUMENTS_SELECT}
` + UPSERT;

// News: confirmed matches only. `news_matches` is one row per (item, company) — a story can
// confirm for more than one followed name. `DISTINCT ON` picks one deterministically: without it,
// two confirmed rows for the same item produce two INSERT rows with the same (kind, ref_id), and
// Postgres refuses with "ON CONFLICT DO UPDATE command cannot affect row a second time".
//
// A confirmed match can also move OFF `confirmed` — to `rejected`, if the gate reconsiders — and
// this SELECT stops proposing that item the moment it does. Measured live 10-Sep-2026: 5 matches
// already sit at `rejected` after once being `confirmed`; `./reap.ts` retracts the ones that were
// registered while confirmed and have since moved off it. Because ref_id is the news ITEM, not the
// (item, company) pair, a story confirmed for two companies stays indexed — correctly — as long as
// at least one of those matches is still confirmed; only when
// every confirming match for that item has moved off `confirmed` does the item disappear, and the
// DISTINCT ON re-attributes company_id to whichever confirmed match remains.
const NEWS_SELECT = `
  SELECT DISTINCT ON (i.id)
         'news_item' AS kind, i.id AS ref_id, m.company_id, i.title,
         coalesce(i.published_at, i.fetched_at) AS occurred_at,
         encode(sha256(convert_to(i.title || coalesce(i.summary,''), 'UTF8')), 'hex') AS content_hash
    FROM news_matches m JOIN news_items i ON i.id = m.item_id
   WHERE m.state = 'confirmed'
   ORDER BY i.id, m.company_id`;

const NEWS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  ${NEWS_SELECT}
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
// more than one announcement. Verified 10-Sep-2026 against the live corpus: 23 distinct attachments
// are each referenced by more than one filing. A bare LEFT JOIN fans out to one row per referencing
// filing and hits the same ON CONFLICT cardinality error as the news case above — not theoretical,
// already true of today's data. DISTINCT ON picks the most recently announced filing that
// references it, if any.
//
// **`f.id` breaks the tie, for the reason CURRENT_VERSION_ORDER_SQL breaks its own.** Two filings
// referencing one PDF at the identical `announced_at` — the exchange republishing the same document
// under two ids — leaves the winner to the plan, so `company_id`, `title` and `occurred_at` all flip
// between runs. That used to cost one audit row per drain. Since the sweep is bounded by the ids the
// upserts return, a flipping row is in `moved` on every run instead, and its chunks are rewritten
// every ten minutes — 1,082 of them for one annual report, each re-inserting a 384-dim vector into
// the HNSW index. Zero such ties in the corpus today; the cost of preventing one is four characters.
//
// The same fan-out shape makes `./reap.ts`'s retraction correct without special handling: a row is
// retracted only once `extracted_text` is cleared or the `attachments` row itself is gone, exactly
// mirroring the SELECT's own admission test.
const ATTACHMENTS_SELECT = `
  SELECT DISTINCT ON (a.sha256)
         'attachment' AS kind, a.sha256 AS ref_id,
         coalesce(f.company_id, a.company_id) AS company_id,
         coalesce(f.summary, a.filename) AS title,
         coalesce(f.announced_at, a.added_at) AS occurred_at,
         encode(sha256(convert_to(a.extracted_text, 'UTF8')), 'hex') AS content_hash
    FROM attachments a
    LEFT JOIN filings f ON f.attachment_sha256 = a.sha256
   WHERE a.extracted_text IS NOT NULL AND length(a.extracted_text) > 0
   ORDER BY a.sha256, f.announced_at DESC NULLS LAST, f.id`;

const ATTACHMENTS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  ${ATTACHMENTS_SELECT}
` + UPSERT;

// A filing's own searchable text: the exchange's announcement category and, since 0025, the
// `attchmntText` NSE actually sends (`summary` — `subject` was dropped for quietly holding the
// filer's name instead). Shared between FILINGS_SELECT and textFor so a chunk always matches what
// was hashed.
const FILING_TEXT_SQL = `
  CASE WHEN f.category IS NOT NULL AND f.summary IS NOT NULL THEN f.category || ': ' || f.summary
       WHEN f.category IS NOT NULL THEN f.category
       ELSE coalesce(f.summary, '') END`;

// Filings: linked to a followed company only. fetchAnnouncements (lib/ingest/filings.ts) stores
// the exchange's entire corporate-announcements feed so a newly followed name arrives with its
// history already attached (companies.test.ts) — most of those rows are never linked to any of
// our three names. Indexing the unlinked 92% would make every filing search mostly noise about
// companies this desk does not follow.
//
// No live evidence yet of a filing losing its company_id or being removed after registration — but
// `./reap.ts` covers it for free, the same way it does for every other kind: the retraction is the
// SELECT's own WHERE re-applied, not a bespoke rule someone has to remember to add the day it does
// happen.
const FILINGS_SELECT = `
  SELECT 'filing' AS kind, f.id AS ref_id, f.company_id, coalesce(f.category, 'Filing') AS title, f.announced_at AS occurred_at,
         encode(sha256(convert_to(${FILING_TEXT_SQL}, 'UTF8')), 'hex') AS content_hash
    FROM filings f
   WHERE f.company_id IS NOT NULL`;

const FILINGS = `
  INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
  ${FILINGS_SELECT}
` + UPSERT;

// Fundamentals: the current, non-superseded figures for a followed company. Shared between
// registerFundamentals (which renders these rows to prose in TypeScript, see renderFundamentals)
// and the reap below, so "current" means the same thing in both places. `f.company_id` is joined
// against `companies` only to get the name for rendering — the eligibility test itself is just
// `superseded_by IS NULL`, the same predicate `lib/company-view.ts` and `lib/agents/results.ts`
// already use for "what is true today".
//
// A restatement doesn't delete the old row; it sets `superseded_by` on it and inserts a new one
// (0008). The old row therefore silently stops qualifying the moment it is superseded, exactly the
// shape `./reap.ts` exists for. Measured live 10-Sep-2026: 4 periods are already superseded after
// being registered — a stale revenue figure that stayed retrievable as current is the whole reason
// the generalised reap matters more than the archived-document case it started from.
const FUNDAMENTALS_SELECT = `
  SELECT f.id AS ref_id, f.company_id, c.name, f.period_kind, f.period_end::text AS period_end,
         f.revenue::text AS revenue, f.profit_after_tax::text AS profit_after_tax
    FROM fundamentals f JOIN companies c ON c.id = f.company_id
   WHERE f.superseded_by IS NULL`;

const PERIOD_LABEL: Record<string, string> = {
  quarter: 'quarter',
  half_year: 'half year',
  year_to_date: 'year to date',
  year: 'year',
};

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
  const text = `${title}: revenue ${croreText(row.revenue)}, PAT ${croreText(row.profitAfterTax)}`;
  return { title, text };
}

async function registerFundamentals(c: Client): Promise<string[]> {
  const { rows } = await c.query<{
    ref_id: string;
    company_id: string;
    name: string;
    period_kind: string;
    period_end: string;
    revenue: string | null;
    profit_after_tax: string | null;
  }>(FUNDAMENTALS_SELECT);
  if (rows.length === 0) return [];

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
    refId.push(r.ref_id);
    companyId.push(r.company_id);
    title.push(rendered.title);
    occurredAt.push(r.period_end);
    hash.push(contentHash(rendered.text));
  }

  const { rows: changed } = await c.query<{ id: string }>(
    `INSERT INTO sources (kind, ref_id, company_id, title, occurred_at, content_hash)
     SELECT 'fundamentals_period', x.ref_id, x.company_id, x.title, x.occurred_at, x.content_hash
       FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[], $5::text[])
         AS x(ref_id, company_id, title, occurred_at, content_hash)
     ${UPSERT}`,
    [refId, companyId, title, occurredAt, hash],
  );
  return changed.map((r) => r.id);
}

/**
 * Push a source's company down onto the chunks that copied it.
 *
 * `index.ts` writes `company_id` onto every `chunks` row and `search.ts`'s SHARED_FILTER matches
 * the chunk's copy, not the source's. So when a story is re-attributed to the other followed name —
 * NEWS_SELECT's `DISTINCT ON` does this on its own, see the UPSERT comment — the source moves and
 * its chunks do not: unreachable under the new name, still answering under the old.
 *
 * An UPDATE rather than a re-index because **a vector is a function of the text and of nothing
 * else**, and the text did not change. Re-embedding to correct a label would cost a model pass.
 *
 * **`occurred_at` is swept for every kind except `document_version`**, and both halves of that are
 * load-bearing. It is "the date the content is about" (`0042`, `v4.md` §4.1).
 *
 * `document_version` is excluded because its date is the current version's `written_at` and every
 * save mints a version — so an ordinary save of byte-identical text moves `sources.occurred_at` to
 * now() while `content_hash` correctly suppresses the re-embed. Sweeping it would re-date every
 * chunk to today and hand `search_corpus`'s `since` a 2022 concall as this week's news, which is
 * the trap `0042` was written to undo.
 *
 * The other four are swept, because excluding them opens that same trap from the other side. An
 * `attachment` is dated `coalesce(f.announced_at, a.added_at)`, so an annual report pulled from the
 * exchange's own endpoint is dated *today* until the announcement feed supplies a filings row —
 * then the source moves to the real date, the text never changed, `content_hash` keeps it out of
 * the re-index queue, and an excluded chunk would go on claiming to be this week's material
 * forever. Measured 15-Sep-2026 on `trisula_v3_dev`: 21 attachments hold no filings row yet, and
 * 1,003 attachment↔filing pairs already disagree on the date. The remaining three cannot move at
 * all — `ingest/filings.ts`'s upsert omits `announced_at`, `news_items` is `DO NOTHING`, and a
 * restated `fundamentals_period` is a new row — so sweeping them costs nothing and keeps the rule
 * one sentence instead of four.
 *
 * The comparison truncates to milliseconds because node-postgres returns a millisecond-resolution
 * `Date` where Postgres stores microseconds. Measured the same day: 11,992 of 24,304 chunks differ
 * from their source's `occurred_at` and **all 11,992** are explained by that truncation alone — not
 * one is a real move. Comparing untruncated would call half the corpus drifted on every run.
 *
 * **Bounded twice**, both load-bearing:
 *
 *   * To the ids the upserts just changed. Unbounded it is a full sequential scan of `chunks` on
 *     every call, and `drain()` calls `registerAll` once per BATCH — so `index-content --all` would
 *     re-scan everything written so far on every batch of a backfill, against a table growing as it
 *     goes. Measured on a synthetic 200,000-chunk / 20,000-source corpus: 210 ms and 17,645 buffer
 *     reads per call in the steady state, to find nothing.
 *   * To sources that are not about to be re-indexed anyway. A source whose `content_hash` moved is
 *     in `moved` AND has `indexed_at IS NULL`, so `drain()` deletes and rewrites its chunks a few
 *     lines later; sweeping first writes all of them twice. Measured on one 1,082-chunk annual
 *     report: 1,727 ms, of which the join is 38 ms and the rest is index maintenance —
 *     `company_id` is in `chunks_company_idx`, so the update can never be HOT and every row
 *     re-inserts its 384-dim vector into the HNSW index.
 *
 * The cost of the first bound is that a chunk whose company drifted without its source moving is
 * not self-healed. `index.test.ts` pins that so it stays a decision.
 */
async function syncChunkMetadata(c: Client, sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0) return;
  await c.query(
    `UPDATE chunks ch
        SET company_id = s.company_id,
            occurred_at = CASE WHEN s.kind = 'document_version' THEN ch.occurred_at
                               ELSE s.occurred_at END
       FROM sources s
      WHERE ch.source_id = s.id
        AND s.id = ANY($1::bigint[])
        AND s.indexed_at IS NOT NULL
        AND (ch.company_id IS DISTINCT FROM s.company_id
             OR (s.kind <> 'document_version'
                 AND ch.occurred_at IS DISTINCT FROM date_trunc('milliseconds', s.occurred_at)))`,
    [sourceIds],
  );
}

/**
 * Runs all five registrations and returns how many `sources` rows were newly added or changed.
 *
 * Reaps all five kinds first, via reap.ts's reapAll — each kind's `sources` rows pruned down to
 * what its own `*_SELECT` still admits, before anything new is proposed — for the same reason
 * PRUNE_ARCHIVED_DOCUMENTS originally ran first: registerAll is the one place that decides what
 * `sources` holds, in both directions. Not counted in the return value: the interface's own
 * contract is "rows registered," and retracting a row is not registering one.
 */
export async function registerAll(c: Client): Promise<number> {
  await reapAll(c, {
    document_version: DOCUMENTS_SELECT,
    news_item: NEWS_SELECT,
    attachment: ATTACHMENTS_SELECT,
    filing: FILINGS_SELECT,
    fundamentals_period: FUNDAMENTALS_SELECT,
  });
  // `RETURNING id` on each upsert: Postgres returns only the rows it actually inserted or updated,
  // and the UPSERT's trailing WHERE already restricts DO UPDATE to genuinely-changed rows — so this
  // is exactly the set whose chunks can have drifted, and in the steady state it is empty.
  const moved: string[] = [];
  for (const sql of [DOCUMENTS, NEWS, ATTACHMENTS, FILINGS]) {
    const { rows } = await c.query<{ id: string }>(sql);
    for (const r of rows) moved.push(r.id);
  }
  moved.push(...(await registerFundamentals(c)));
  // After the upserts, so it sees this run's corrections. Not counted in the return value, for the
  // same reason reaping is not: correcting a chunk's label is not registering a source.
  await syncChunkMetadata(c, moved);
  return moved.length;
}

/** A document_version's body is `{"cells": {...}}` for a sheet, detected by shape (see 0039). */
function cellsIn(body: unknown): Record<string, string> | null {
  if (body === null || typeof body !== 'object' || !('cells' in body)) return null;
  const cells = (body as { cells: unknown }).cells;
  return cells !== null && typeof cells === 'object' ? (cells as Record<string, string>) : null;
}

interface RawText {
  text: string;
  cells: Record<string, string> | null;
}

const asRawText = (text: string | null | undefined): RawText | null =>
  text == null ? null : { text, cells: null };

/**
 * The text a source's content_hash was computed FROM, reconstructed for the chunker. Every branch
 * but `document_version`'s sheet case mirrors exactly the expression its kind's INSERT used to
 * compute `content_hash` — same input, so the chunker cuts up what was actually indexed.
 *
 * `document_version`'s sheet case is the one deliberate exception. `content_hash` still hashes the
 * raw JSONB body (DOCUMENTS_SELECT, above) — that only has to change WHEN the content changes, and
 * it does: any edit to a qualifying cell changes the raw JSON too. But what this function returns
 * for a sheet is `sheetGridText(cells)`, not the raw body, because `chunkCells` computes its offsets
 * into that same grid — see chunk.ts's file header for the citation-offset bug this replaced (a
 * chunk's char_from/char_to used to index into a string `textFor` never returned).
 */
async function rawText(c: Client, kind: SourceKind, refId: string): Promise<RawText | null> {
  switch (kind) {
    case 'document_version': {
      // refId is the document's id (see DOCUMENTS_SELECT above), so re-derive the same "current
      // version" this document would register today, not a specific version row — same ordering,
      // shared via CURRENT_VERSION_ORDER_SQL so it cannot silently diverge from what DOCUMENTS
      // hashed.
      const { rows } = await c.query<{ body: unknown }>(
        `SELECT v.body
           FROM document_versions v
          WHERE v.document_id = $1
          ${CURRENT_VERSION_ORDER_SQL}`,
        [refId],
      );
      if (rows.length === 0) return null;
      const body = rows[0]!.body;
      const cells = cellsIn(body);
      if (cells) return { text: sheetGridText(cells), cells };

      const asObj = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const text = asObj && typeof asObj['text'] === 'string' ? asObj['text'] : JSON.stringify(body);
      return { text, cells: null };
    }
    case 'attachment': {
      const { rows } = await c.query<{ text: string | null }>(
        `SELECT extracted_text AS text FROM attachments WHERE sha256 = $1`,
        [refId],
      );
      return asRawText(rows[0]?.text);
    }
    case 'filing': {
      const { rows } = await c.query<{ text: string }>(
        `SELECT ${FILING_TEXT_SQL} AS text FROM filings f WHERE f.id = $1`,
        [refId],
      );
      return asRawText(rows[0]?.text);
    }
    case 'news_item': {
      const { rows } = await c.query<{ text: string }>(
        `SELECT i.title || coalesce(i.summary,'') AS text FROM news_items i WHERE i.id = $1`,
        [refId],
      );
      return asRawText(rows[0]?.text);
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
      return asRawText(
        renderFundamentals({
          companyName: r.name,
          periodKind: r.period_kind,
          periodEnd: r.period_end,
          revenue: r.revenue,
          profitAfterTax: r.profit_after_tax,
        }).text,
      );
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

  const raw = await rawText(c, s.kind, s.ref_id);
  if (raw === null) return null;

  return {
    kind: s.kind,
    refId: s.ref_id,
    companyId: s.company_id,
    title: s.title,
    occurredAt: s.occurred_at ? s.occurred_at.toISOString() : null,
    text: raw.text,
    cells: raw.cells,
  };
}
