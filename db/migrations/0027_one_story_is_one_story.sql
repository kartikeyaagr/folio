-- The same story, arriving twice.
--
-- Measured over 2,089 real items on 07-Sep-2026:
--
--   * 329 items share a URL with another item — 162 distinct articles, 167 redundant rows. The
--     Hindu BusinessLine publishes one article to both its agri-business and economy feeds, with
--     the same URL in each. That is not a similar story, it is the same article.
--   * 50 more share a headline while sitting at different URLs — 23 stories. These are one
--     publisher's two titles carrying one piece (Recycling Today and Waste Today; Manufacturing
--     Dive and Supply Chain Dive), or a wire story picked up by three outlets at once.
--
-- **This is not the clustering that was declined.** Clustering groups stories that are *about* the
-- same thing and was measured in v2 as doing nothing: 100 items became 95 stories, 90 of them
-- singletons. This collapses rows that are the same article by its own identity, and the two keys
-- below are exact equality, never similarity. Nothing here decides that two pieces of writing are
-- related; it decides they are identical.
--
-- Generated columns rather than a value the poller writes: a key computed from the row can never
-- drift from the row, there is nothing to backfill, and a normalisation bug is fixed in one place.

ALTER TABLE news_items
  -- The article's own address, minus the parts that do not identify it: query strings carry feed
  -- and campaign tags, and a fragment is a position within the same document.
  ADD COLUMN url_key text
    GENERATED ALWAYS AS (
      lower(regexp_replace(regexp_replace(url, '[?#].*$', ''), '/+$', ''))
    ) STORED,

  -- The headline, folded. `[:alnum:]` is Unicode-aware, which matters more than it looks: an
  -- ASCII-only class silently normalises every Gujarati and Hindi headline to the empty string,
  -- and ChiniMandi — which now publishes mostly in those scripts — would collapse into one
  -- "story". Found by writing the measuring query that way first.
  ADD COLUMN title_key text
    GENERATED ALWAYS AS (
      NULLIF(btrim(lower(regexp_replace(title, '[^[:alnum:]]+', ' ', 'g'))), '')
    ) STORED;

CREATE INDEX news_items_url_key ON news_items (url_key, published_at DESC);
CREATE INDEX news_items_title_key ON news_items (title_key, published_at DESC) WHERE title_key IS NOT NULL;
