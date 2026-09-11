-- A chunk carries the source's date too.
--
-- Migration 0042 fixed the transcript date bug in document_versions.written_at and
-- sources.occurred_at, but chunks.occurred_at was never touched — lib/retrieval/index.ts's chunk
-- insert already copies occurred_at from the source at write time (so every chunk written since
-- 0042 shipped is correct), but the chunks written before it still carry whatever
-- document_versions.written_at was when they were embedded: the ingestion moment, not the date of
-- the call. Measured on trisula_v3_dev 11-Sep-2026: 1292 transcript chunks, 0 agreeing with their
-- source's occurred_at, all 1292 still stamped 2026-09-08.
--
-- This matters because chunks_company_idx is (company_id, occurred_at DESC) — anything that orders
-- retrieval by recency today reads the stale column, not the repaired one sources and
-- document_versions already carry.
--
-- Text and embeddings are untouched. Only the date column was wrong, so this is a plain UPDATE
-- from the source that already has the right value, not a re-embed — 0042 already established that
-- sources.occurred_at is correct; this is that migration's missing half.

UPDATE chunks c
   SET occurred_at = s.occurred_at
  FROM sources s
 WHERE s.id = c.source_id
   AND c.occurred_at IS DISTINCT FROM s.occurred_at;

-- Assert the reported symptom is actually gone, not just that some UPDATE ran. Vacuous (and passes
-- trivially) against an empty test database, which is fine: there is nothing to have gotten wrong
-- there.
DO $$
DECLARE
  mismatched int;
BEGIN
  SELECT count(*) INTO mismatched
    FROM chunks c
    JOIN sources s ON s.id = c.source_id
   WHERE c.occurred_at IS DISTINCT FROM s.occurred_at;

  IF mismatched > 0 THEN
    RAISE EXCEPTION 'chunks.occurred_at still disagrees with sources.occurred_at for % chunk(s)', mismatched;
  END IF;
END $$;
