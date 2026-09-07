-- Where a document came from, and what kind of thing it is.
--
-- Accepting a draft created a document and lost the draft. Every one landed as kind `note`, with no
-- link back, so a brief written by agent 6 was indistinguishable from a note somebody typed — and
-- the provenance the review gate insists on showing *before* you accept vanished the moment you
-- did. In a system whose whole claim is that every figure is traceable to the filing it came from,
-- that is the wrong direction to lose a link in.
--
-- `brief` joins the kinds because a news brief is a distinct thing a person goes looking for, and
-- "the last brief" is a question with no answer while everything is a note.

ALTER TABLE documents ADD COLUMN from_draft_id text REFERENCES ai_drafts(id);

ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check
  CHECK (kind IN ('note', 'memo', 'meeting', 'checklist', 'transcript', 'brief'));

CREATE INDEX documents_from_draft_idx ON documents (from_draft_id) WHERE from_draft_id IS NOT NULL;
CREATE INDEX documents_kind_idx ON documents (kind, updated_at DESC) WHERE archived_at IS NULL;
