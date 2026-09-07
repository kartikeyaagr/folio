-- Which items have been through the matcher.
--
-- Without this the matcher asks "items with no match row", which is every headline that has ever
-- failed to match — 2,000 on day one and growing forever. With it the question is "items not yet
-- looked at", which is what was meant.
--
-- A separate table rather than a column on news_items, because it is a fact about our processing
-- rather than about the story, and news_items is a copy of somebody else's feed.

CREATE TABLE news_matched_items (
  item_id    text PRIMARY KEY REFERENCES news_items(id) ON DELETE CASCADE,
  matched_at timestamptz NOT NULL DEFAULT now()
);
