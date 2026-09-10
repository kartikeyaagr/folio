-- A chunk remembers where it came from.
--
-- char_from/char_to are not decoration. A citation that says "this came from the FY24 annual
-- report" is unfalsifiable by the reader; one that opens the document at the sentence is not.
-- v2's chat cited sources and the citations were checkable, which is the reason the thing was
-- trusted. Everything here exists to keep that true.
--
-- fts is a GENERATED column rather than a trigger-maintained one. v2 had to extract plain_text
-- from ProseMirror JSON at write time because "Postgres cannot read words out of ProseMirror
-- JSON" (0024). v4's bodies are plain text and cell strings, extracted once in the indexer, so
-- the tsvector is derived by Postgres from the chunk it already stores. One less thing to keep
-- in sync, and it cannot drift.
--
-- Both indexes are built, always, and both are queried on every search. "PRAJIND Q3 revenue" is a
-- keyword question and "what has management said about the auditor" is a semantic one; the desk
-- asks both, often in one sentence. A router that guesses which is which is one more thing that
-- can be confidently wrong — v2 kept its chat router rule-based for exactly this reason.

CREATE TABLE chunks (
  id          bigserial PRIMARY KEY,
  -- sources.id is this plan's own bigserial, so this one really is bigint. company_id is text,
  -- like every other id in this schema.
  source_id   bigint NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  company_id  text REFERENCES companies(id) ON DELETE CASCADE,
  ord         int    NOT NULL,
  text        text   NOT NULL,
  char_from   int    NOT NULL,
  char_to     int    NOT NULL,
  occurred_at timestamptz,
  embedding   vector(384),
  embed_model text,
  fts         tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,

  -- Vectors from two models occupy different spaces, and comparing them returns plausible numbers
  -- with meaningless neighbours — the worst available failure, because it has no symptom. Carried
  -- verbatim from v2's exemplars table, which enforced the same pairing for the same reason.
  CONSTRAINT chunks_embedding_has_a_model CHECK ((embedding IS NULL) = (embed_model IS NULL)),
  CONSTRAINT chunks_span_is_forward CHECK (char_to > char_from),
  CONSTRAINT chunks_ordered UNIQUE (source_id, ord)
);

CREATE INDEX chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX chunks_fts_idx       ON chunks USING gin (fts);
-- Every filter this system applies is company plus recency, so they are one index.
CREATE INDEX chunks_company_idx   ON chunks (company_id, occurred_at DESC);

COMMENT ON COLUMN chunks.char_from IS
  'Offset into the source text this chunk was cut from. slice(char_from, char_to) is exactly '
  'this chunk''s text — the invariant the citation link depends on.';

-- No audit trigger here, and the exemption belongs beside news_items and news_matched_items for
-- the same reason: this is derived rows, written only by the indexer, whose provenance is the
-- sources row beside it, not a decision anyone made.
--
-- Measured 10-Sep-2026: the corpus is 8,088,878 characters today (7,070,128 extracted from
-- attachments, 1,018,750 in document bodies) and Task 13 adds roughly 11M more. At ~850 effective
-- characters per chunk that is ~22,000 rows on a three-name book — ten times news_items, which was
-- exempted at 2,089 — and every re-index of an edited document deletes and rewrites its chunks.
-- One audit row per chunk would make the audit log mostly a record of a machine cutting up text it
-- was told to cut up.
--
-- sources keeps its trigger (added in 0040). One row per document, and it records a decision —
-- what the fund chose to index, and when — which is exactly what the audit log is for.
