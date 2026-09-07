-- News: a wide net, then a mechanism gate.
--
-- The shape is settled by v2's own measurement (03-Sep-2026, 2,867 items, 111 links): symbol and
-- name produced 7 links, all correct; the 35 general press feeds produced 16, all correct; the 23
-- sector trade titles produced 95 of which 20 were right. Every false positive in the system came
-- from that one tier, admitted on vocabulary alone.
--
-- The answer is not to drop the tier — those 20 were real, and for an SME nobody covers, the trade
-- press is where the information lives. The answer is that a match by vocabulary is a **candidate**
-- until something can state the mechanism connecting the story to the company. A candidate is never
-- shown. Only a stated mechanism is.

-- ------------------------------------------------------------------------------------------------
-- Sources
-- ------------------------------------------------------------------------------------------------

CREATE TABLE news_sources (
  key             text PRIMARY KEY,
  label           text NOT NULL,
  url             text NOT NULL,
  tier            int  NOT NULL CHECK (tier BETWEEN 1 AND 3),
  sector          text,
  -- The anchor fix. v2 had `sector` and no market, so its India check asked a *headline* whether it
  -- mentioned India when the source already knew the answer. That cost two confirmed true positives
  -- (both PRAJIND, both ChiniMandi on sugar-mill directives) — a domestic trade title's stories are
  -- about India whether or not they say so.
  market          text NOT NULL DEFAULT 'india' CHECK (market IN ('india', 'global')),
  active          boolean NOT NULL DEFAULT true,
  last_polled_at  timestamptz,
  last_status     text,
  last_error      text
);

-- ------------------------------------------------------------------------------------------------
-- Items
-- ------------------------------------------------------------------------------------------------

CREATE TABLE news_items (
  id           text PRIMARY KEY,
  source_key   text NOT NULL REFERENCES news_sources(key),
  guid         text NOT NULL,
  url          text NOT NULL,
  title        text NOT NULL,
  summary      text,
  published_at timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now()
);

-- A feed's own guid is the identity. Re-polling an overlapping window is then an upsert, and there
-- is no watermark to drift.
CREATE UNIQUE INDEX news_items_identity ON news_items (source_key, guid);
CREATE INDEX news_items_recent ON news_items (published_at DESC NULLS LAST);

-- ------------------------------------------------------------------------------------------------
-- Matches
-- ------------------------------------------------------------------------------------------------

CREATE TABLE news_matches (
  id          text PRIMARY KEY,
  item_id     text NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
  company_id  text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- How the net caught it. The first five are identifiers and are trusted on sight; `sector_term`
  -- is vocabulary and never is.
  tier        text NOT NULL CHECK (tier IN
                ('symbol', 'isin', 'name', 'alias', 'subsidiary', 'brand', 'sector_term')),
  evidence    text NOT NULL,

  --   candidate — caught, not yet judged
  --   confirmed — the gate stated a mechanism; this is the only state the UI renders
  --   rejected  — the gate found no mechanism
  --   ungated   — terminal failure. The gate could not be reached after several attempts, and this
  --               row stops being retried. Without it a broken key means the queue grows forever
  --               and every run looks busy while nothing is decided.
  state       text NOT NULL DEFAULT 'candidate'
                CHECK (state IN ('candidate', 'confirmed', 'rejected', 'ungated')),

  -- Why this story is about this company, in the gate's words. C4's whole point: an unexplained
  -- match trains you to distrust the next one.
  mechanism   text,
  attempts    int NOT NULL DEFAULT 0,
  gated_at    timestamptz,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One story matches one company once, however many terms caught it.
CREATE UNIQUE INDEX news_matches_identity ON news_matches (item_id, company_id);
CREATE INDEX news_matches_queue ON news_matches (created_at) WHERE state = 'candidate';
CREATE INDEX news_matches_shown ON news_matches (company_id, created_at DESC) WHERE state = 'confirmed';

-- ------------------------------------------------------------------------------------------------
-- Engagement
-- ------------------------------------------------------------------------------------------------

-- Read and dismissed, per person. Deliberately not a column on the thing itself: three people share
-- this desk and one of them having read a story says nothing about the other two.
CREATE TABLE engagement (
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('news', 'alert', 'filing')),
  subject_ref  text NOT NULL,
  state        text NOT NULL CHECK (state IN ('read', 'dismissed')),
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, subject_kind, subject_ref)
);

SELECT attach_audit('news_sources');
SELECT attach_audit('news_matches');
SELECT attach_audit('engagement');

-- news_items is deliberately not audited: it is a copy of somebody else's feed, written only by
-- the poller, and an audit row per headline would be the largest table in the database inside a
-- month while recording nothing anyone would ever ask about.
