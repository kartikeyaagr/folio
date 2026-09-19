-- A price means more beside its index.
--
-- (Numbered 0061 after 0060 in this branch; 0052–0057 are claimed by other worktrees. Check
-- `ls ~/conductor/workspaces/*/db/migrations` before picking a number, not just this directory.)
--
-- The company chart drew one line and asked the reader to remember the market. A small-cap down 30%
-- in a year when Nifty Smallcap 250 is down 28% has done nothing; the same line against an index up
-- 10% is a different company. This is the second line.
--
-- ### Its own table, not `prices`
--
-- `prices` is keyed on a security symbol, carries an ISIN, and `storePrices` filters every row
-- against `companies` — an index is none of those things, and pushing one through that path would
-- mean a fake symbol, a null ISIN and a followed-company check that has to make an exception. The
-- two are stored separately and joined only in the chart, which is where the comparison is made.
--
-- ### Where the numbers come from
--
-- NSE's per-index history endpoint (`api/historical/indicesHistory`) answers **503**, with and
-- without the Referer that unsticks the insider endpoint — measured 17-Sep-2026 against NIFTY 50
-- and NIFTY SMALLCAP 250, which is the same answer `backfill-prices.ts` already records for every
-- per-symbol historical endpoint. What does serve is
-- `nsearchives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv`: **one file per trading day
-- carrying all 166 indices**, open/high/low/close, in exactly the shape the bhavcopy comes in.
--
-- So history is walked backwards a day at a time, by the same job, from the same archive host, in
-- the same loop — one extra request per day for all four indices at once, on a walk already making
-- one for the bhavcopy.
--
-- ### `name` is the exchange's own spelling
--
-- `Nifty Smallcap 250`, not `NIFTY_SMALLCAP_250` or a slug of our own. The CSV's first column is
-- the join key and inventing a second vocabulary for it means a mapping table that can drift; the
-- display label is the UI's business and lives in `lib/ingest/indices.ts`.

CREATE TABLE index_levels (
    name    text NOT NULL,
    on_date date NOT NULL,
    open    numeric(18,4),
    high    numeric(18,4),
    low     numeric(18,4),
    close   numeric(18,4) NOT NULL,
    source  text NOT NULL DEFAULT 'nse_ind_close_all',

    PRIMARY KEY (name, on_date)
);

-- **No audit trigger, on `prices`' argument exactly.** These are unchanging exchange facts written
-- only by the ingest jobs and never corrected by a person; their provenance is the `ingestion_runs`
-- row of the walk that fetched them. Four closes a trading day would otherwise be four audit rows a
-- day recording that NSE published what NSE published. The exclusion is listed in
-- `db/schema.test.ts`, which fails if a new table is silently left without one.

COMMENT ON TABLE index_levels IS
    'Daily closes for the handful of indices this book is measured against. Separate from prices '
    'because an index is not a security: no ISIN, no symbol, and not filtered against companies.';

COMMENT ON COLUMN index_levels.name IS
    'The exchange''s own spelling, straight from the first column of ind_close_all_DDMMYYYY.csv. '
    'The display label lives in lib/ingest/indices.ts; a second vocabulary here would be a mapping '
    'that can drift from the file it is meant to match.';

-- The chart asks for one index over a window, which the primary key already serves. This is for the
-- other direction — "what did the market do on this day", which the EOD job asks when it checks
-- whether a day it just walked actually landed.
CREATE INDEX index_levels_date_idx ON index_levels (on_date DESC);
