-- A filing is read as the PDF it is, and exists once.
--
-- (Numbered 0060 after 0059 in this branch; 0052–0057 are claimed by other worktrees. Check
-- `ls ~/conductor/workspaces/*/db/migrations` before picking a number, not just this directory.)
--
-- Two things had gone wrong at once, and they share a cause: **a transcript was modelled as two
-- objects.** `extractPending` writes the PDF's text into `attachments.extracted_text`, then copies
-- it into a `documents` row so agent 2 has a queue to sweep. Both are legitimate. What was not is
-- that the company page listed the second and could not reach the first, so the desk read a
-- machine's extraction of a filing while the filing itself — the thing with the letterhead, the
-- tables and the page numbers — was unreachable from any screen.
--
-- The extraction stays exactly where it is. It is what the agents read and what `/chat` searches,
-- and it is the only reason the corpus can answer a question about a call. It is simply not what a
-- person should be handed when they click the name of a document the company published.
--
-- ### What this migration does, and what the code does
--
-- The code half is in the same commit: `lib/files.ts` lists the PDFs, `components/FiledDocument.tsx`
-- renders one, `lib/retrieval/register.ts` stops indexing a document that came from an attachment,
-- and `promoteTranscript` stops naming a document after the exchange's upload key. This half is the
-- 35 rows that already exist, which no code change reaches.
--
-- Nothing is deleted. `documents.title` is a display name, and the attachment it came from still
-- carries the original filename — `SELECT filename FROM attachments WHERE sha256 = from_attachment`
-- is the upload key, in the one place where it is a fact about the file rather than a label.

-- ------------------------------------------------------------------------------------------------
-- 1. A name with one job
-- ------------------------------------------------------------------------------------------------

-- `TEGA_21022022190439_Earnings_call_transcript.pdf` repeats the symbol every screen already shows,
-- buries the date in fourteen undelimited digits, and differs between two filings of one document.
-- Every list that renders these carries the company and the date in their own columns.
UPDATE documents SET title = 'Transcript'
 WHERE kind = 'transcript' AND from_attachment IS NOT NULL AND title <> 'Transcript';

-- ------------------------------------------------------------------------------------------------
-- 2. One copy in the corpus
-- ------------------------------------------------------------------------------------------------

-- `register.ts` gains `AND d.from_attachment IS NULL`, and `reap.ts` builds its retraction from the
-- same SELECT — so the duplicates retire themselves on the next indexer run without anything here.
-- They are deleted now anyway, because "the next run" is up to ten minutes away and until then a
-- question about a call still matches the same passage twice.
--
-- Counted, not assumed: 35 sources and 2,063 chunks on 17-Sep-2026. `chunks.source_id` cascades
-- from `sources.id` (0041), so deleting the source takes its chunks with it.
DO $$
DECLARE gone int;
BEGIN
    DELETE FROM sources s
     WHERE s.kind = 'document_version'
       AND EXISTS (
         SELECT 1 FROM documents d
          WHERE d.id = s.ref_id AND d.from_attachment IS NOT NULL);
    GET DIAGNOSTICS gone = ROW_COUNT;
    RAISE NOTICE 'retracted % duplicated transcript source(s) from the corpus', gone;
END $$;

-- ------------------------------------------------------------------------------------------------
-- 3. Proving the shape this rests on
-- ------------------------------------------------------------------------------------------------

DO $$
DECLARE orphaned int;
BEGIN
    -- The whole design assumes a promoted document can always reach its PDF. If one could not, the
    -- company page would list a row whose link 404s, and the reader would have no way back to the
    -- filing at all — strictly worse than the extraction it replaced.
    SELECT count(*) INTO orphaned
      FROM documents d
     WHERE d.from_attachment IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.sha256 = d.from_attachment);
    IF orphaned > 0 THEN
        RAISE EXCEPTION '% promoted document(s) point at no attachment', orphaned;
    END IF;
END $$;
