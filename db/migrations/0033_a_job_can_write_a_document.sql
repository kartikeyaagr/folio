-- A job can write a document.
--
-- `documents.created_by` and `document_versions.written_by` referenced `users`, and service
-- principals live in `actors` only. So no job could ever create a document — which is exactly what
-- a transcript fetcher must do, and it is why agent 2 has never had a trigger: the only production
-- `INSERT INTO documents` is inside `acceptDraft`, so a transcript could arrive only by accepting a
-- draft from the one agent that would need a transcript to produce it.
--
-- `attachments.added_by` already references `actors` and gets this right. `documents` was the
-- anomaly, not the rule.
--
-- Widening from `users` to `actors` is strictly permissive: every existing row references a user,
-- and every user is an actor (`users_id_fkey`). Nothing is orphaned and nothing that was allowed
-- becomes disallowed. Attribution is not weakened — `audit_fn()` still refuses an unattributed
-- write and still refuses an unknown actor. What changes is which *kind* of actor may be named,
-- and a document fetched by a job should say a job fetched it rather than borrow somebody's name.

ALTER TABLE documents DROP CONSTRAINT documents_created_by_fkey;
ALTER TABLE documents ADD CONSTRAINT documents_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES actors(id);

ALTER TABLE document_versions DROP CONSTRAINT document_versions_written_by_fkey;
ALTER TABLE document_versions ADD CONSTRAINT document_versions_written_by_fkey
  FOREIGN KEY (written_by) REFERENCES actors(id);

-- Where the bytes came from. A document made from an exchange attachment should be traceable to it
-- without joining through prose, and `attachments.sha256` is the content, so re-filing the same
-- document lands on the same row.
ALTER TABLE documents ADD COLUMN from_attachment text REFERENCES attachments(sha256);

CREATE INDEX documents_attachment_idx ON documents (from_attachment)
  WHERE from_attachment IS NOT NULL;

COMMENT ON COLUMN documents.from_attachment IS
  'The stored attachment this was extracted from, when it was not typed by a person.';
