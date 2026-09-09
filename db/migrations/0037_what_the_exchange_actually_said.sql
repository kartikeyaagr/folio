-- What the exchange actually said.
--
-- Corporate actions arrive as one line of free text — "Annual General Meeting/ Final Dividend -
-- Rs 20 Per Share / Special Dividend - Rs 10 Per Share" — and the ingest turns that into typed
-- columns. B5 then asks a person to confirm the result before it touches a position.
--
-- They cannot confirm what they cannot see. A row reading "dividend of 30.00 a share" is our
-- reading of that line, and the two dividends it summed are invisible once parsed. So the line is
-- kept beside the parse, and the confirm screen shows both: the exchange's words, and what we made
-- of them. Measured on 19,036 rows fetched 09-Sep-2026 — 189 of them carry two dividend amounts,
-- and 3,381 hide a real dividend behind an AGM prefix.

ALTER TABLE corporate_actions ADD COLUMN subject text;

COMMENT ON COLUMN corporate_actions.subject IS
  'The exchange''s own line, verbatim. Shown next to the parse so a person confirming can check it.';

-- Two actions can come off one line — "Bonus 3:1/Dividend - Rs 30 Per Share" is a bonus AND a
-- dividend, on the same record date — so the kind is part of what identifies a row, and one subject
-- legitimately produces two. The id the ingest derives already includes it; this says so.
COMMENT ON TABLE corporate_actions IS
  'One row per action. A single exchange announcement may yield more than one, and each is confirmed separately.';
