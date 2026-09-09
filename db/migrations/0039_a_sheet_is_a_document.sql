-- A sheet is a document.
--
-- A3 asks for free-form notes and documents against a company, and `documents` +
-- `document_versions` have carried them since 0011 with nothing able to create one. The desk keeps
-- its models in Excel and its notes in Google Docs, which is the thing this system was built to
-- replace — `docs/specs/v2-system-map.md` says so in its first paragraph.
--
-- A spreadsheet is not a new kind of object here. It is a document whose body happens to be a grid:
-- same table, same versioning, same attribution, same archive. `document_versions.body` is already
-- `jsonb` and already holds `{"text": ...}` for prose, so a sheet holds `{"cells": {"A1": ...}}`
-- and every version of a model is kept for the same reason every version of a memo is — a number in
-- an investment case is worth nothing without the ability to see what it was last quarter.
--
-- Nothing else changes. The version history, the `archived_at` soft delete and the `created_by`
-- attribution all already do the right thing for a grid.

ALTER TABLE documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (
  kind = ANY (ARRAY['note', 'memo', 'meeting', 'checklist', 'transcript', 'brief', 'sheet'])
);

COMMENT ON COLUMN document_versions.body IS
  'Prose documents hold {"text": "..."}; sheets hold {"cells": {"A1": "=SUM(B1:B3)", ...}}. One row per save.';
