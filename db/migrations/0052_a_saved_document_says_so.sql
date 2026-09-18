-- A saved document says so, instead of waiting to be noticed.
--
-- Indexing already reacts correctly to a change: `registerAll` recomputes `content_hash`, the
-- upsert clears `indexed_at` when and only when that hash moved, and `indexOne` deletes the old
-- chunks before writing the new ones. A memo saved six times in an afternoon costs one embed; a
-- memo actually edited costs one re-embed and the stale vectors are gone. None of that changes
-- here.
--
-- What was missing is *when*. The only thing that ran the indexer was a ten-minute timer, so a
-- spreadsheet uploaded at 13:04 was unsearchable until 13:10 — and on a laptop with no systemd, it
-- was unsearchable until somebody thought to run the job by hand. Measured 16-Sep-2026 on
-- `trisula_v3_dev`: the indexer had last run on 11-Sep, and five days of uploads — including an
-- eleven-tab competitive-landscape workbook saved that morning — had never been chunked. Nothing
-- was broken. Nothing was driving it.
--
-- **A trigger, not a call in the save path.** There are six write paths into the three tables below
-- — the document editor, the import action, two upload routes, the PDF text extractor, and the
-- agent accept gate — and a rule every one of them has to remember is a rule that will be forgotten
-- by the seventh. The database is the one place all of them already go.
--
-- **NOTIFY, not the indexing itself.** Saving a memo must not block on a 130MB model load, which
-- is the same reason `trisula-index-content.timer` exists and the same rule `exemplars` follows at
-- the accept gate: "an analyst clicking accept must not wait on a model load, and a failure there
-- must not cost them the acceptance." This sends a four-byte nudge and returns.
--
-- **The payload is constant on purpose.** Postgres collapses duplicate (channel, payload) pairs
-- within one transaction, so importing an eleven-tab workbook — eleven documents and eleven
-- versions in one transaction — delivers exactly one notification rather than twenty-two. The
-- listener re-reads the queue from `sources.indexed_at IS NULL` anyway, so which row moved is not
-- information it needs; that it should look again is.
--
-- **This is a nudge and never the record.** A NOTIFY with no listener connected is dropped on the
-- floor, and nothing anywhere replays it. The durable queue is still `indexed_at IS NULL`, and the
-- ten-minute timer is still what guarantees the queue drains — exactly the house rule about asking
-- "what has no run yet" rather than "what is new since I last looked". If this trigger were deleted
-- tomorrow the system would lose latency and nothing else.

CREATE FUNCTION notify_content_changed() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fires on COMMIT, not on the statement: an uncommitted save must not wake a worker that would
  -- then find nothing, and a rolled-back one must not wake it at all.
  PERFORM pg_notify('trisula_content', 'changed');
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION notify_content_changed() IS
  'Nudges jobs/index-content.ts --watch. Never the record: the queue is sources.indexed_at IS NULL.';

-- STATEMENT level, not ROW. A 900-row bulk insert should wake the listener once, and the payload
-- carries no row identity for it to lose by doing so. The audit trigger on these same tables is
-- FOR EACH ROW because it records what changed; this one only says that something did.
CREATE TRIGGER notify_content AFTER INSERT OR UPDATE OR DELETE ON documents
  FOR EACH STATEMENT EXECUTE FUNCTION notify_content_changed();

CREATE TRIGGER notify_content AFTER INSERT OR UPDATE OR DELETE ON document_versions
  FOR EACH STATEMENT EXECUTE FUNCTION notify_content_changed();

-- Attachments are here for the half people forget: an uploaded PDF is not indexable at the moment
-- it lands, because `sources` requires a text layer and extraction happens later. The UPDATE that
-- writes `extracted_text` is what makes it eligible, and it is an UPDATE to this table, so it is
-- covered by the same trigger rather than needing its own rule somewhere else.
CREATE TRIGGER notify_content AFTER INSERT OR UPDATE OR DELETE ON attachments
  FOR EACH STATEMENT EXECUTE FUNCTION notify_content_changed();
