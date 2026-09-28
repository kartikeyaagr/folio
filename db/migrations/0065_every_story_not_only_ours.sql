-- Every story, not only ours.
--
-- Until 28-Sep-2026 /news rendered confirmed company matches and nothing else: 0018's rule was that
-- a candidate is never shown, only a stated mechanism is. Everything the net caught and the gate
-- did not confirm was stored and never read by anybody. The user reversed that on 28-Sep-2026: the
-- page shows every story from the major outlets, one row per story however many outlets carry it,
-- with no model scoring or ranking. The confirmed view stays, as a tab, unchanged.
--
-- Columns only. A story is not a table because it has no facts of its own: its headline, link,
-- time and outlets are all facts about the items that carry it.

-- ------------------------------------------------------------------------------------------------
-- Sources: what a feed covers, and whether it belongs in the stream
-- ------------------------------------------------------------------------------------------------

-- Nullable, because six test files insert a bare source with no section and cannot be told about
-- this column; every row seeded by a migration carries one, and the guard below holds that.
ALTER TABLE news_sources
  ADD COLUMN section text CHECK (section IN (
    'india', 'world', 'politics', 'business', 'companies', 'markets', 'economy', 'industry', 'tech',
    'official'
  )),
  -- Off unless a migration says otherwise. A source joins the stream by a decision, not by being
  -- added for the matcher's sake.
  ADD COLUMN in_stream boolean NOT NULL DEFAULT false;

-- The publisher, which is what "carried by three outlets" counts. A feed is not an outlet:
-- BusinessLine publishes one article to its agri-business and economy feeds under one URL (0027),
-- and counting feeds would call that two outlets.
--
-- Generated from the label for 0027's reason: a value computed from the row cannot drift from it.
-- Every seeded label is already "Outlet — section" or a bare outlet name. One was not.
UPDATE news_sources SET label = 'BusinessLine — markets' WHERE key = 'businessline';
ALTER TABLE news_sources
  ADD COLUMN outlet text GENERATED ALWAYS AS (split_part(label, ' — ', 1)) STORED;

-- The 56 rows 0019 seeded. Decisions, with the reason for each group:
--
--   * The Indian business press, all 31 general titles, join the stream. That includes the five
--     Moneycontrol feeds; 0066 records why they stop being polled, which is a separate fact.
--   * The 21 sector trade titles (0029, inactive) and Motor India stay out. A trade title is about
--     one industry and exists here for the company-match net, where 0018 showed it earns its keep
--     on an uncovered SME. In a general stream it is a flood from one sector; reactivating one for
--     the matcher must not change what the desk reads. Motor India is untagged but is a trade title
--     all the same.
--   * RBI, SEBI and PIB stay out, as 'official'. They are primary releases, not reporting, and on
--     28-Sep-2026 19 of SEBI's 30 items were recovery, release and remittance orders against
--     named individual defaulters, and 8 of RBI's 10 were routine liquidity and auction notices.
--     A regulator's decision that matters reaches the stream as the outlets' reporting of it. They
--     stay polled for the matcher, which is where a named company in an order is worth a call.
DO $$
DECLARE classified int;
BEGIN
  UPDATE news_sources s
     SET section = v.section, in_stream = v.in_stream
    FROM (VALUES
      ('australian-mining', 'industry', false),
      ('automotive-world', 'industry', false),
      ('bioenergy-insight', 'industry', false),
      ('bl-companies', 'companies', true),
      ('bl-news', 'india', true),
      ('bs-companies', 'companies', true),
      ('bs-industry', 'industry', true),
      ('bs-latest', 'business', true),
      ('bs-markets', 'markets', true),
      ('business-today', 'business', true),
      ('businessline', 'markets', true),
      ('chem-engineering', 'industry', false),
      ('chem-industry-digest', 'industry', false),
      ('chinimandi', 'industry', false),
      ('cnbctv18-business', 'business', true),
      ('cnbctv18-market', 'markets', true),
      ('et-energy', 'industry', true),
      ('et-industry', 'industry', true),
      ('et-markets', 'markets', true),
      ('et-smallbiz', 'business', true),
      ('express-pharma', 'industry', false),
      ('food-dive', 'industry', false),
      ('fortune-india', 'business', true),
      ('hindu-business', 'business', true),
      ('im-mining', 'industry', false),
      ('indian-printer', 'industry', false),
      ('jec-composites', 'industry', false),
      ('machine-maker', 'industry', false),
      ('manufacturing-dive', 'industry', false),
      ('mc-business', 'business', true),
      ('mc-marketreports', 'markets', true),
      ('mc-results', 'companies', true),
      ('metal-miner', 'industry', false),
      ('mining-com', 'industry', false),
      ('mint-companies', 'companies', true),
      ('mint-industry', 'industry', true),
      ('mint-markets', 'markets', true),
      ('mint-news', 'india', true),
      ('moneycontrol', 'business', true),
      ('motor-india', 'industry', false),
      ('packaging-dive', 'industry', false),
      ('packaging-south-asia', 'industry', false),
      ('recycling-today', 'industry', false),
      ('supply-chain-dive', 'industry', false),
      ('toi-business', 'business', true),
      ('waste-dive', 'industry', false),
      ('waste-today', 'industry', false),
      ('bl-agri', 'economy', true),
      ('bl-economy', 'economy', true),
      ('bs-economy', 'economy', true),
      ('et-economy', 'economy', true),
      ('mc-economy', 'economy', true),
      ('mint-economy', 'economy', true),
      ('pib', 'official', false),
      ('rbi', 'official', false),
      ('sebi', 'official', false)
    ) AS v(key, section, in_stream)
   WHERE s.key = v.key;

  -- 0029's guard, for 0029's reason: a source list that has drifted from the one this was written
  -- against should stop the migration rather than leave some rows unclassified.
  GET DIAGNOSTICS classified = ROW_COUNT;
  IF classified <> 56 OR EXISTS (SELECT 1 FROM news_sources WHERE section IS NULL) THEN
    RAISE EXCEPTION 'expected to classify all 56 seeded sources, classified %', classified;
  END IF;
END $$;

-- ------------------------------------------------------------------------------------------------
-- Items: which story each one carries
-- ------------------------------------------------------------------------------------------------

-- The first item stored of the same story; a story's first item points at itself. Assigned by
-- lib/news/stories.ts as each item is stored, on 0027's exact keys and SAME_STORY_DAYS — the same
-- url_key, or the same title_key, within seven days. Equality, never similarity: the clustering
-- C7 declined was measured at 100 items to 95 stories, and nothing here revisits that.
--
-- NULL means not yet assigned, not "a story of its own". Nothing is backfilled here: the rows
-- already stored are NULL, and the first poll's sweep assigns them through the same code as every
-- later item, so there is one definition of a story rather than a SQL copy that could drift.
ALTER TABLE news_items ADD COLUMN story_id text REFERENCES news_items(id);

-- One row per story is a GROUP BY on this expression, and a story's carriers are found through it.
-- COALESCE so an unassigned item is its own story rather than disappearing.
CREATE INDEX news_items_story ON news_items ((COALESCE(story_id, id)));

-- The stream reads a time window, newest first. The expression is the one match.ts and the stream
-- both order by: a feed with no dates falls back to when it was fetched.
CREATE INDEX news_items_stream ON news_items ((COALESCE(published_at, fetched_at)) DESC);

-- The sweep asks what has no story yet, and after the first poll the answer is almost always
-- nothing. A partial index keeps that question from reading the whole table on every feed.
CREATE INDEX news_items_unassigned ON news_items (id) WHERE story_id IS NULL;
