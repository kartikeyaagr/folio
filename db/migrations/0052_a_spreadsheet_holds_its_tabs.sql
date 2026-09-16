-- A spreadsheet holds its tabs.
--
-- 0039 said a sheet's body is `{"cells": {"A1": ...}}` — one grid — and the import path followed
-- that literally: a workbook with four tabs became four separate documents. The cost was not
-- untidiness. A model keeps its assumptions on one tab and its output on another, so the formulas
-- that matter are the ones that cross between them; and once the tabs were four documents, nothing
-- could resolve `=Inputs!B4`. `lib/import/xlsx.ts` checks every imported formula against the value
-- Excel had cached for it and drops any that disagrees, so each of those became a constant. A model
-- was frozen on the way in, which is the one thing importing was for.
--
-- So a body now holds `{"sheets": [{"name": "Model", "cells": {...}}, ...]}`.
--
-- **No data migration, on purpose.** Rows written under 0039 keep their `{"cells": ...}` shape and
-- are read as a workbook of one tab (`lib/sheet/book.ts`). A `document_versions` row is the record
-- of what a person saved at a moment; rewriting one to suit a later shape would make the version
-- history say something that did not happen. Both shapes are read; only the new one is written.
--
-- This migration therefore changes nothing but the column's own description, which was the only
-- place in the schema that stated the contract.

COMMENT ON COLUMN document_versions.body IS
  'Prose documents hold {"text": "..."}. Spreadsheets hold {"sheets": [{"name": "Model", "cells": {"A1": "=Inputs!B4"}}]} — '
  'and, for rows written before 0052, the older single-grid {"cells": {...}}, which lib/sheet/book.ts reads as one tab. '
  'One row per save.';
