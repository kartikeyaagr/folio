-- A transcript carries the date of the call, not the date it was ingested.
--
-- lib/ingest/extract.ts's document_versions insert never carried a written_at, so every promoted
-- transcript fell through to the column's now() default — the moment the job happened to run it,
-- not the date of the call. Measured on trisula_v3_dev 10-Sep-2026: 18 transcripts, 1 distinct
-- written_at date (2026-09-08). The filename embeds the true date and it was thrown away —
-- `PRAJIND_21102022153139_Transcripts...` is an Oct-2022 call, stamped as if it happened yesterday.
--
-- The true date is not a guess. `filings.announced_at`, joined on `filings.attachment_sha256 =
-- attachments.sha256`, matched the filename-embedded date on every row checked. The application fix
-- (extract.ts, this same change going forward) is separate from this migration: that stops new rows
-- from being wrong; this repairs the 18 that already are.
--
-- sources.occurred_at inherits the same wrong date for a document_version source
-- (lib/retrieval/register.ts's DOCUMENTS_SELECT reads it straight off document_versions.written_at)
-- and is repaired alongside — docs/specs/v4.md §4.1 names exactly this trap: occurred_at is the
-- date the content is about, and ranking a backfilled transcript by indexed_at instead would put it
-- at the top of every search the day it happens to be ingested.
--
-- Scoped to `written_by = 'system:ingest'`: that is the only actor extract.ts ever writes as, so
-- the predicate reaches exactly the machine-written rows the bug produced and none a person later
-- added by hand. The attachment-to-filing tie-break (most recently announced wins) reuses the exact
-- shape register.ts's ATTACHMENTS_SELECT already established for "one attachment, several
-- referencing filings" — 23 such attachments, verified 10-Sep-2026 against the live corpus.

WITH transcript_call_dates AS (
  SELECT DISTINCT ON (a.sha256)
         a.sha256, f.announced_at
    FROM attachments a
    JOIN filings f ON f.attachment_sha256 = a.sha256
   ORDER BY a.sha256, f.announced_at DESC
)
UPDATE document_versions v
   SET written_at = td.announced_at
  FROM documents d
  JOIN transcript_call_dates td ON td.sha256 = d.from_attachment
 WHERE v.document_id = d.id
   AND d.kind = 'transcript'
   AND v.written_by = 'system:ingest';

UPDATE sources s
   SET occurred_at = v.written_at
  FROM documents d
  JOIN document_versions v ON v.document_id = d.id
 WHERE s.kind = 'document_version'
   AND s.ref_id = d.id
   AND d.kind = 'transcript'
   AND v.written_by = 'system:ingest'
   AND s.occurred_at IS DISTINCT FROM v.written_at;

-- Assert the reported symptom is actually gone, not just that some UPDATE ran. Not a hardcoded row
-- count — 18 is what this corpus held the day this was written, not an invariant of the schema —
-- but the exact shape the bug report opened with: every ingested transcript sharing one date. Both
-- checks are vacuous (and pass trivially) against an empty test database, which is fine: there is
-- nothing to have gotten wrong there.
DO $$
DECLARE
  transcripts    int;
  distinct_dates int;
  mismatched     int;
BEGIN
  SELECT count(*), count(DISTINCT v.written_at::date)
    INTO transcripts, distinct_dates
    FROM documents d
    JOIN document_versions v ON v.document_id = d.id
   WHERE d.kind = 'transcript' AND v.written_by = 'system:ingest';

  IF transcripts > 1 AND distinct_dates <= 1 THEN
    RAISE EXCEPTION
      '% ingested transcripts still share % distinct written_at date(s) after the repair',
      transcripts, distinct_dates;
  END IF;

  SELECT count(*) INTO mismatched
    FROM sources s
    JOIN documents d ON d.id = s.ref_id AND s.kind = 'document_version'
    JOIN document_versions v ON v.document_id = d.id
   WHERE d.kind = 'transcript' AND v.written_by = 'system:ingest'
     AND s.occurred_at IS DISTINCT FROM v.written_at;

  IF mismatched > 0 THEN
    RAISE EXCEPTION
      'sources.occurred_at still disagrees with document_versions.written_at for % transcript(s)',
      mismatched;
  END IF;
END $$;
