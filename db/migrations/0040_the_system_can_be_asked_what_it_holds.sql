-- The system can be asked what it holds.
--
-- Everything this fund knows is in Postgres and none of it is searchable. `attachments.
-- extracted_text` has been written since 0002 and read by nothing but the queue that fills it;
-- company search is two ILIKEs over names. So "what has management said about the auditor" has no
-- answer, and agent 3 was cut (0034) because assembling everything held on a name into one prompt
-- does not fit without retrieval to bound it.
--
-- `sources` is one row per indexable thing, whatever it is. It is separate from `chunks` because
-- the two have different lifetimes: a document is re-saved constantly and its chunks are
-- disposable, but the fact that we have indexed it, and what we indexed, is not.
--
-- `indexed_at IS NULL` is the queue, in the shape 0035 established: the indexer asks what has no
-- index yet, never what changed since it last looked. A crash halfway leaves the row unclaimed.
--
-- `content_hash` is why re-saving is cheap. A <textarea> saved six times in an afternoon is six
-- `document_versions` rows but one hash, so it costs one embed. Without it, editing a memo would
-- re-embed the whole thing on every keystroke-batch that reached the server.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE sources (
  id           bigserial PRIMARY KEY,
  kind         text   NOT NULL,
  -- text, not bigint. Every id this can point at is text — filings.id, documents.id,
  -- news_items.id, fundamentals.id — and an attachment is keyed by its sha256, which is text by
  -- nature. Verified against the live schema 10-Sep-2026; an earlier draft of this migration said
  -- bigint and would not have applied at all, because company_id cannot reference a text primary
  -- key from a bigint column.
  ref_id       text   NOT NULL,
  company_id   text REFERENCES companies(id) ON DELETE CASCADE,
  title        text   NOT NULL,
  -- The date the CONTENT is about, not when we indexed it. A Q1 FY24 transcript indexed today is
  -- a 2023 document; ranking by indexed_at would put a newly followed name's entire backfill at
  -- the top of every result, which is precisely the wrong order.
  occurred_at  timestamptz,
  content_hash text   NOT NULL,
  indexed_at   timestamptz,
  index_error  text,

  CONSTRAINT sources_kind_check CHECK (kind = ANY (ARRAY[
    'document_version', 'attachment', 'filing', 'news_item', 'fundamentals_period'
  ])),
  CONSTRAINT sources_identity UNIQUE (kind, ref_id)
);

-- The queue: what has no index yet, oldest ask first.
CREATE INDEX sources_index_queue ON sources (id) WHERE indexed_at IS NULL;

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON sources
  FOR EACH ROW EXECUTE FUNCTION audit_fn();

COMMENT ON COLUMN sources.content_hash IS
  'sha256 of the exact text that was chunked. Unchanged hash means no re-embed.';
COMMENT ON COLUMN sources.index_error IS
  'Last failure. A source that failed still has no index, so it stays in the queue by the same '
  'predicate, and the text says why the last attempt did not finish.';

-- The indexer writes as itself, so "who chunked this" is answerable. Postgres raises on an actor
-- it has never been seeded, so this row and the ServicePrincipal union in lib/db.ts are one
-- decision in two files; adding either alone fails at the first write.
INSERT INTO actors (id, kind, label) VALUES ('system:index', 'service', 'Content indexer');
