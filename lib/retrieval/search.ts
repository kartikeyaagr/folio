/**
 * Hybrid retrieval: vector kNN and full-text search, run over the same rows and fused.
 *
 * **Both paths, always — never one chosen by a heuristic.** "PRAJIND Q3 revenue" is a keyword
 * question; "what has management said about the auditor" is a semantic one; the desk asks both,
 * often in one sentence. A router that guesses which is which is one more thing that can be
 * confidently wrong — the same argument v2 used for keeping its chat router rule-based.
 *
 * **Reciprocal rank fusion, not score blending.** Cosine distance and `ts_rank` are not on the
 * same scale, and any weighting between them is a number nobody can defend. Rank is comparable;
 * score is not.
 *
 * **Filtered identically.** Every predicate but the ranking expression itself — embed_model,
 * company_id, kind, since — applies to both CTEs the same way, including `embed_model`: a chunk
 * written by a superseded embedding pass is not "vector-unsearchable, text-searchable", it is
 * quarantined from retrieval altogether until it is re-indexed under the live model.
 *
 * **`ORDER BY score DESC, c.id` — the tie-break is not decoration.** RRF guarantees ties: a
 * vector-only hit at rank r and a full-text-only hit at rank r both score exactly `1/(RRF_K + r)`,
 * and real queries produce plenty of rank-r pairs like that. Without a deterministic second key,
 * Postgres is free to return same-score rows in a different order on every call, and `collapse`'s
 * per-source cap then keeps whichever arbitrary ordering it was handed — so the same question asked
 * twice could cite different passages. `c.id` costs nothing to add and makes the whole pipeline,
 * fusion through collapse, reproducible for a given corpus and query.
 */
import type { Client } from '../db.ts';
import { readTxn } from '../db.ts';
import { embed, toVector, EMBED_MODEL } from './embed.ts';
import type { SourceKind } from './register.ts';

export interface Hit {
  chunkId: string;
  sourceId: string;
  kind: SourceKind;
  title: string;
  text: string;
  charFrom: number;
  charTo: number;
  companyId: string | null;
  occurredAt: string | null;
  score: number;
}

export interface SearchOpts {
  companyId?: string | null;
  kind?: SourceKind;
  since?: string;
  limit?: number;
}

export const RRF_K = 60;
export const PER_PATH = 30;
export const MAX_PER_SOURCE = 3;
export const RESULT_LIMIT = 12;

interface Row {
  chunk_id: string;
  source_id: string;
  kind: SourceKind;
  title: string;
  text: string;
  char_from: number;
  char_to: number;
  company_id: string | null;
  occurred_at: Date | null;
  score: number;
}

// Repeated verbatim in both CTEs below — see the file header on why "filtered identically" is not
// negotiable per-path. $2 embed_model, $3 companyId, $7 kind, $8 since.
const SHARED_FILTER = `
       AND c.embed_model = $2
       AND ($3::text IS NULL OR c.company_id = $3)
       AND ($7::text IS NULL OR s.kind = $7)
       AND ($8::timestamptz IS NULL OR c.occurred_at >= $8)`;

const SQL = `
  WITH v AS (
    SELECT c.id, row_number() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM chunks c JOIN sources s ON s.id = c.source_id
     WHERE c.embedding IS NOT NULL
       ${SHARED_FILTER}
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4
  ),
  q AS (
    -- websearch_to_tsquery ANDs its terms by default; OR them instead, exactly as v2 did
    -- (trisula_intel/agents/desk_analyst.py) — "what has management said about the auditor"
    -- must surface a page that mentions the auditor and never the word "management". NULL when
    -- the query is entirely stop-words, so '@@' below matches nothing rather than raising on an
    -- empty tsquery.
    SELECT CASE WHEN websearch_to_tsquery('english', $5)::text = '' THEN NULL
                ELSE replace(websearch_to_tsquery('english', $5)::text, ' & ', ' | ')::tsquery
           END AS query
  ),
  f AS (
    SELECT c.id, row_number() OVER (ORDER BY ts_rank(c.fts, q.query) DESC) AS rank
      FROM chunks c JOIN sources s ON s.id = c.source_id CROSS JOIN q
     WHERE q.query IS NOT NULL AND c.fts @@ q.query
       ${SHARED_FILTER}
     ORDER BY ts_rank(c.fts, q.query) DESC
     LIMIT $4
  )
  SELECT c.id::text AS chunk_id, c.source_id::text AS source_id, s.kind, s.title, c.text,
         c.char_from, c.char_to, c.company_id, c.occurred_at,
         (coalesce(1.0 / ($6 + v.rank), 0) + coalesce(1.0 / ($6 + f.rank), 0))::float8 AS score
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
    LEFT JOIN v ON v.id = c.id
    LEFT JOIN f ON f.id = c.id
   WHERE v.id IS NOT NULL OR f.id IS NOT NULL
   ORDER BY score DESC, c.id`;

/**
 * Collapse to at most `MAX_PER_SOURCE` chunks per source, then to `limit` overall. Done here
 * rather than with a window function in SQL: a window function ranking within `source_id` would
 * need a second pass over the already-fused set anyway (the fusion itself is not per-source), so
 * doing it in TypeScript keeps the SQL readable without costing an extra pass. `rows` arrives
 * already ordered by score DESC, so taking each source's first `MAX_PER_SOURCE` appearances in
 * that order is exactly "keep its best-scored chunks".
 */
function collapse(rows: Row[], limit: number): Hit[] {
  const perSource = new Map<string, number>();
  const hits: Hit[] = [];
  for (const r of rows) {
    const seen = perSource.get(r.source_id) ?? 0;
    if (seen >= MAX_PER_SOURCE) continue;
    perSource.set(r.source_id, seen + 1);
    hits.push({
      chunkId: r.chunk_id,
      sourceId: r.source_id,
      kind: r.kind,
      title: r.title,
      text: r.text,
      charFrom: r.char_from,
      charTo: r.char_to,
      companyId: r.company_id,
      occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
      score: r.score,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

/**
 * Search the corpus. An empty `chunks` table returns `[]`, not a weak best guess: the fused SQL
 * only ever admits a row that at least one of the two CTEs actually ranked, so "neither path
 * ranked anything" already falls out of the `WHERE v.id IS NOT NULL OR f.id IS NOT NULL` above —
 * nothing here manufactures a result. That is a structural guarantee, not a relevance one: once
 * any chunks exist, this function returns whatever ranked "nearest", however weak the match — an
 * unrelated chunk is still nearest to something in cosine space. There is deliberately no
 * relevance floor on top of that: Task 10 measured the live corpus against twenty real questions
 * and found no cosine value separates an answerable question from gibberish (`search.test.ts`'s
 * own semantic-match fixture scores 0.5317, below literal noise at 0.5736), so callers — the
 * `search_corpus` tool, in particular — are told the ranking is not relevance and must judge each
 * passage themselves rather than trust a threshold this function does not and cannot apply.
 */
export async function search(query: string, opts: SearchOpts = {}): Promise<Hit[]> {
  if (query.trim().length === 0) return [];

  const vectors = await embed([query]);
  const queryVector = toVector(vectors[0]!);

  const { rows } = await readTxn((c: Client) =>
    c.query<Row>(SQL, [
      queryVector,
      EMBED_MODEL,
      opts.companyId ?? null,
      PER_PATH,
      query,
      RRF_K,
      opts.kind ?? null,
      opts.since ?? null,
    ]),
  );

  return collapse(rows, opts.limit ?? RESULT_LIMIT);
}
