-- `filings.subject` held the company's name.
--
-- NSE's announcement feed carries three text fields: `desc` (what kind of announcement this is),
-- `attchmntText` (what it says), and `sm_name` (who filed it). The first two are `category` and
-- `summary`. There is no fourth, and `subject` was quietly filled with the third — so every alert
-- raised from a filing carried "Aeron Composite Limited" as its detail, and the desk showed the
-- company's name where the announcement should have been.
--
-- Found by building the filings screen and reading the Subject column.
--
-- The alert evaluator also matched its patterns against `category || subject`, which meant a third
-- of its haystack was a company name. It now matches against the announcement text, which is both
-- correct and considerably more of it.

ALTER TABLE filings DROP COLUMN subject;
