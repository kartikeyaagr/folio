-- The order an agent wrote its fields in.
--
-- `content` is jsonb, and jsonb does not preserve key order — it stores keys sorted by length and
-- then alphabetically. So a results draft rendered as "moved, figures, headline, one_offs,
-- watch_items": the headline, which is the one line a reader wants first, landed third because
-- eight characters is longer than five.
--
-- The agent's schema already declares a deliberate order. This records it at the moment the draft
-- is written, when it is still known.

ALTER TABLE ai_drafts ADD COLUMN field_order text[];
