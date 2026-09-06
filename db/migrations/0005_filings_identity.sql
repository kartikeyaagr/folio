-- Filings carry the instrument and say whether XBRL exists.
--
-- Three columns 0003 should have had, each earned from v2's ingest:
--
--   isin      Filings link to companies on ISIN like everything else. The announcement feed
--             carries `sm_isin`, so there is no reason to match on a symbol here either.
--   has_xbrl  NSE flags which announcements have a structured instance behind them. Without it,
--             finding results filings means guessing from the category text.
--   summary   The announcement's own text. Long, so it is stored rather than re-fetched.
ALTER TABLE filings ADD COLUMN isin     text;
ALTER TABLE filings ADD COLUMN has_xbrl boolean NOT NULL DEFAULT false;
ALTER TABLE filings ADD COLUMN summary  text;

CREATE INDEX filings_isin_idx  ON filings (isin, announced_at DESC) WHERE isin IS NOT NULL;
-- The XBRL that has not been parsed yet. This is the query the fundamentals ingest asks.
CREATE INDEX filings_xbrl_idx  ON filings (announced_at DESC) WHERE has_xbrl;

COMMENT ON COLUMN filings.id IS
    'source:seq_id, e.g. nse_equities:12345. NSE''s seq_id is stable, so re-ingesting a window is '
    'an upsert on the primary key and dedup needs no text matching.';
