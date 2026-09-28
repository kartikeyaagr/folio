-- The major outlets, every section a fund reads.
--
-- The user's decisions of 28-Sep-2026: every story from the major outlets rather than their top
-- stories, publisher RSS only (a paid vendor stays refused, C8), duplicates merged across outlets,
-- nothing scored or ranked by a model. 0065 made the stream; this fills it.
--
-- "Every story" is read as every story in the sections an investor reads: India, world, politics,
-- business, companies, markets, economy, industry and technology. The outlets' everything feeds
-- were fetched and left out — TOI's most recent, HT's latest, The Hindu's all, the Express's all,
-- NDTV's latest — because each repeats its section feeds and adds sport, entertainment and city
-- news; The Hindu's all feed turned over 60 items in 1.7 hours. Top-stories feeds (TOI, NDTV, BS,
-- ET, BBC, FT home) are subsets of the sections and are left out for the same reason.
--
-- `market` keeps 0018's meaning — whether a source's stories are about India, which is what admits
-- sector vocabulary to the matcher. So every world section and foreign outlet is 'global', and
-- the Financial Times' and the BBC's India pages are 'india'. `tier` is unused (0018's tiers never
-- reached the code); 2 is what 0019 gave the general press.
--
-- Every row was fetched with poll.ts's own request headers and parsed with parseFeed, twice, on
-- 28-Sep-2026, at 15:32 and again at 15:55 IST; the figures are the second check. "span" is how far
-- apart the oldest and newest items served are, which is what the poll timer has to beat: a feed
-- whose span is shorter than the gap between polls loses the stories that scrolled off it. "24h"
-- is how many of them were published in the 24 hours before the check.
--
--   key                 items  summaries     span    24h   checked
--   toi-india               20  3/20          5.3h     20   28-Sep-2026
--   toi-world               20  9/20         64.4h     18   28-Sep-2026
--   ie-india               200  none          168h     32   28-Sep-2026
--   ie-business            200  none        898.5h      6   28-Sep-2026
--   ie-politics            200  none        899.1h      1   28-Sep-2026
--   ie-world               200  none        479.7h      6   28-Sep-2026
--   ie-tech                200  none        816.2h      5   28-Sep-2026
--   ht-india               100  all          21.8h    100   28-Sep-2026
--   ht-business              6  all          29.7h      4   28-Sep-2026
--   ht-world               100  all          41.6h     60   28-Sep-2026
--   ht-tech                  8  all          25.3h      6   28-Sep-2026
--   hindu-national          60  53/60         3.6h     60   28-Sep-2026
--   hindu-economy           60  all         290.4h      1   28-Sep-2026
--   hindu-markets           60  58/60       456.1h      2   28-Sep-2026
--   hindu-industry          60  52/60       231.4h      5   28-Sep-2026
--   hindu-international     60  all          52.2h     25   28-Sep-2026
--   hindu-tech              60  all         163.4h      7   28-Sep-2026
--   ndtv-india              20  all           1.6h     20   28-Sep-2026
--   ndtv-world              20  all          15.1h     20   28-Sep-2026
--   ndtv-profit             20  all           1.4h     20   28-Sep-2026
--   et-news                 50  43/50         1.9h     50   28-Sep-2026
--   et-politics             50  all          45.1h     30   28-Sep-2026
--   et-company              50  49/50       231.1h      4   28-Sep-2026
--   et-stocks               50  24/50           7h     50   28-Sep-2026
--   et-world                50  43/50        16.8h     50   28-Sep-2026
--   et-tech                 50  49/50        87.1h     19   28-Sep-2026
--   mint-politics           35  all         349.8h      4   28-Sep-2026
--   mint-tech               35  all         127.4h      5   28-Sep-2026
--   bs-india                35  all          49.6h     16   28-Sep-2026
--   bs-politics             35  all         839.9h      2   28-Sep-2026
--   bs-finance              35  all            71h     11   28-Sep-2026
--   bs-tech                 35  all         111.1h      6   28-Sep-2026
--   cnbctv18-economy       200  198/200       626h      6   28-Sep-2026
--   cnbctv18-politics      200  all        2775.2h      2   28-Sep-2026
--   cnbctv18-world         200  all         150.2h     12   28-Sep-2026
--   cnbctv18-tech          200  all         306.5h      9   28-Sep-2026
--   bl-world                60  59/60         145h      8   28-Sep-2026
--   bl-tech                 60  all           138h      5   28-Sep-2026
--   indiatoday-india        20  all           2.5h     20   28-Sep-2026
--   indiatoday-world        20  all           6.8h     20   28-Sep-2026
--   news18-india           200  all            65h     74   28-Sep-2026
--   news18-business        200  199/200       338h      5   28-Sep-2026
--   news18-world           200  all         107.4h     33   28-Sep-2026
--   firstpost-india        200  all         606.8h      4   28-Sep-2026
--   firstpost-business     200  all         417.3h     10   28-Sep-2026
--   firstpost-world        200  all         140.9h     34   28-Sep-2026
--   scroll                 100  all          98.2h     20   28-Sep-2026
--   ft-world                25  all           6.3h     25   28-Sep-2026
--   ft-markets              25  all          61.9h     11   28-Sep-2026
--   ft-companies            25  all          30.3h     22   28-Sep-2026
--   ft-global-economy       25  all          77.3h     12   28-Sep-2026
--   ft-tech                 25  all          67.3h      8   28-Sep-2026
--   ft-india                25  all         633.5h      1   28-Sep-2026
--   bbc-business            44  all          2146h     14   28-Sep-2026
--   bbc-world               23  all          57.7h     16   28-Sep-2026
--   bbc-india               31  all          1616h      1   28-Sep-2026
--   bloomberg-markets       20  all            15h     20   28-Sep-2026
--   bloomberg-economics     11  all          37.9h      9   28-Sep-2026
--   bloomberg-tech          20  all          19.7h     20   28-Sep-2026
--   bloomberg-politics      20  all          27.3h     18   28-Sep-2026
--   nyt-business            49  all          94.1h     13   28-Sep-2026
--   nyt-world               57  56/57          85h     18   28-Sep-2026
--   guardian-business       40  all          78.3h     14   28-Sep-2026
--   guardian-world          45  all         163.3h     30   28-Sep-2026
--   aljazeera               25  all           9.3h     25   28-Sep-2026
--   cnbc-world              30  all         146.9h     18   28-Sep-2026
--   scmp-business           50  all           127h     11   28-Sep-2026
--
-- Fetched and not seeded, 28-Sep-2026:
--
--   * Moneycontrol, every feed tried. latestnews, MCtopnews, business, marketreports, results,
--     economy, buzzingstocks, internationalmarkets, marketedge, technology, worldnews, iponews,
--     currency and commodities all parse, and all are frozen: eleven end on 23-Apr-2024, MCtopnews
--     on 5-Oct-2016, commodities on 11-Sep-2020. politics, news and stocksnews answer 503, and
--     /news/feed/ answers HTML. No live Moneycontrol feed exists at any address tried.
--   * Financial Express: /feed/ answers 410 Gone; every section feed redirects to an HTML page.
--   * Reuters: no public feed. reutersagency.com/feed and the arc outbound feed answer 404.
--   * Wall Street Journal: world, markets, business and tech parse, and are frozen at 24-27 Jan
--     2025.
--   * The Economist: finance-and-economics and business served 300 items each at the first check
--     and 403 at the second. A feed that refuses intermittently would live on the failing list.
--   * Nikkei Asia: 50 items with no dates and no summaries. An undated item cannot be placed on a
--     page ordered by time, which is PIB's problem (0019).
--   * AP 403. Deccan Herald business and Zee Business 404. The Print, The Wire, and Scroll's own
--     address answer HTML; Scroll is seeded through its feedburner address, which works.
--   * Hindustan Times top news, india-news/politics and business/markets: zero items.
--   * Mint world, ai and latest 404; news/world zero items.
--   * Business Standard world-news redirects to an HTML listing; international and current-affairs
--     are frozen in March 2023.
--   * Times of India technology, both addresses: frozen, newest 28-Aug-2024 and 11-May-2024.
--   * Indian Express economy and market: newest 22-Sep and 21-Sep, six and seven days old on a
--     working Monday while the business feed carried the same desk's stories that morning.
--   * India Today home mixes in items back to 2015; its business feed is frozen at 17-Mar-2025.
--   * ET top stories and ET default carry items back to 2019 and 2008. Bloomberg wealth: zero
--     items. MarketWatch market pulse: frozen at 3-Jul-2025.

INSERT INTO news_sources (key, label, url, section, market, tier, in_stream)
SELECT key, label, url, section, market, 2, true FROM (VALUES
  ('toi-india', 'Times of India — India', 'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', 'india', 'india'),
  ('toi-world', 'Times of India — world', 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms', 'world', 'global'),
  ('ie-india', 'Indian Express — India', 'https://indianexpress.com/section/india/feed/', 'india', 'india'),
  ('ie-business', 'Indian Express — business', 'https://indianexpress.com/section/business/feed/', 'business', 'india'),
  ('ie-politics', 'Indian Express — politics', 'https://indianexpress.com/section/political-pulse/feed/', 'politics', 'india'),
  ('ie-world', 'Indian Express — world', 'https://indianexpress.com/section/world/feed/', 'world', 'global'),
  ('ie-tech', 'Indian Express — technology', 'https://indianexpress.com/section/technology/feed/', 'tech', 'india'),
  ('ht-india', 'Hindustan Times — India', 'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml', 'india', 'india'),
  ('ht-business', 'Hindustan Times — business', 'https://www.hindustantimes.com/feeds/rss/business/rssfeed.xml', 'business', 'india'),
  ('ht-world', 'Hindustan Times — world', 'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml', 'world', 'global'),
  ('ht-tech', 'Hindustan Times — technology', 'https://www.hindustantimes.com/feeds/rss/technology/rssfeed.xml', 'tech', 'india'),
  ('hindu-national', 'The Hindu — national', 'https://www.thehindu.com/news/national/feeder/default.rss', 'india', 'india'),
  ('hindu-economy', 'The Hindu — economy', 'https://www.thehindu.com/business/Economy/feeder/default.rss', 'economy', 'india'),
  ('hindu-markets', 'The Hindu — markets', 'https://www.thehindu.com/business/markets/feeder/default.rss', 'markets', 'india'),
  ('hindu-industry', 'The Hindu — industry', 'https://www.thehindu.com/business/Industry/feeder/default.rss', 'industry', 'india'),
  ('hindu-international', 'The Hindu — international', 'https://www.thehindu.com/news/international/feeder/default.rss', 'world', 'global'),
  ('hindu-tech', 'The Hindu — technology', 'https://www.thehindu.com/sci-tech/technology/feeder/default.rss', 'tech', 'india'),
  ('ndtv-india', 'NDTV — India', 'https://feeds.feedburner.com/ndtvnews-india-news', 'india', 'india'),
  ('ndtv-world', 'NDTV — world', 'https://feeds.feedburner.com/ndtvnews-world-news', 'world', 'global'),
  ('ndtv-profit', 'NDTV Profit — latest', 'https://www.ndtvprofit.com/rss', 'business', 'india'),
  ('et-news', 'Economic Times — news', 'https://economictimes.indiatimes.com/news/rssfeeds/1715249553.cms', 'india', 'india'),
  ('et-politics', 'Economic Times — politics', 'https://economictimes.indiatimes.com/news/politics-and-nation/rssfeeds/1052732854.cms', 'politics', 'india'),
  ('et-company', 'Economic Times — companies', 'https://economictimes.indiatimes.com/news/company/rssfeeds/2143429.cms', 'companies', 'india'),
  ('et-stocks', 'Economic Times — stocks', 'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', 'markets', 'india'),
  ('et-world', 'Economic Times — world', 'https://economictimes.indiatimes.com/news/international/rssfeeds/858478126.cms', 'world', 'global'),
  ('et-tech', 'Economic Times — technology', 'https://economictimes.indiatimes.com/tech/rssfeeds/13357270.cms', 'tech', 'india'),
  ('mint-politics', 'Mint — politics', 'https://www.livemint.com/rss/politics', 'politics', 'india'),
  ('mint-tech', 'Mint — technology', 'https://www.livemint.com/rss/technology', 'tech', 'india'),
  ('bs-india', 'Business Standard — India', 'https://www.business-standard.com/rss/india-news-216.rss', 'india', 'india'),
  ('bs-politics', 'Business Standard — politics', 'https://www.business-standard.com/rss/politics-155.rss', 'politics', 'india'),
  ('bs-finance', 'Business Standard — finance', 'https://www.business-standard.com/rss/finance-103.rss', 'business', 'india'),
  ('bs-tech', 'Business Standard — technology', 'https://www.business-standard.com/rss/technology-108.rss', 'tech', 'india'),
  ('cnbctv18-economy', 'CNBC-TV18 — economy', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/economy.xml', 'economy', 'india'),
  ('cnbctv18-politics', 'CNBC-TV18 — politics', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/politics.xml', 'politics', 'india'),
  ('cnbctv18-world', 'CNBC-TV18 — world', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/world.xml', 'world', 'global'),
  ('cnbctv18-tech', 'CNBC-TV18 — technology', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/technology.xml', 'tech', 'india'),
  ('bl-world', 'BusinessLine — world', 'https://www.thehindubusinessline.com/news/world/feeder/default.rss', 'world', 'global'),
  ('bl-tech', 'BusinessLine — info-tech', 'https://www.thehindubusinessline.com/info-tech/feeder/default.rss', 'tech', 'india'),
  ('indiatoday-india', 'India Today — India', 'https://www.indiatoday.in/rss/1206578', 'india', 'india'),
  ('indiatoday-world', 'India Today — world', 'https://www.indiatoday.in/rss/1206577', 'world', 'global'),
  ('news18-india', 'News18 — India', 'https://www.news18.com/commonfeeds/v1/eng/rss/india.xml', 'india', 'india'),
  ('news18-business', 'News18 — business', 'https://www.news18.com/commonfeeds/v1/eng/rss/business.xml', 'business', 'india'),
  ('news18-world', 'News18 — world', 'https://www.news18.com/commonfeeds/v1/eng/rss/world.xml', 'world', 'global'),
  ('firstpost-india', 'Firstpost — India', 'https://www.firstpost.com/commonfeeds/v1/mfp/rss/india.xml', 'india', 'india'),
  ('firstpost-business', 'Firstpost — business', 'https://www.firstpost.com/commonfeeds/v1/mfp/rss/business.xml', 'business', 'india'),
  ('firstpost-world', 'Firstpost — world', 'https://www.firstpost.com/commonfeeds/v1/mfp/rss/world.xml', 'world', 'global'),
  ('scroll', 'Scroll', 'https://feeds.feedburner.com/ScrollinArticles.rss', 'india', 'india'),
  ('ft-world', 'Financial Times — world', 'https://www.ft.com/world?format=rss', 'world', 'global'),
  ('ft-markets', 'Financial Times — markets', 'https://www.ft.com/markets?format=rss', 'markets', 'global'),
  ('ft-companies', 'Financial Times — companies', 'https://www.ft.com/companies?format=rss', 'companies', 'global'),
  ('ft-global-economy', 'Financial Times — global economy', 'https://www.ft.com/global-economy?format=rss', 'economy', 'global'),
  ('ft-tech', 'Financial Times — technology', 'https://www.ft.com/technology?format=rss', 'tech', 'global'),
  ('ft-india', 'Financial Times — India', 'https://www.ft.com/india?format=rss', 'india', 'india'),
  ('bbc-business', 'BBC — business', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'business', 'global'),
  ('bbc-world', 'BBC — world', 'https://feeds.bbci.co.uk/news/world/rss.xml', 'world', 'global'),
  ('bbc-india', 'BBC — India', 'https://feeds.bbci.co.uk/news/world/asia/india/rss.xml', 'india', 'india'),
  ('bloomberg-markets', 'Bloomberg — markets', 'https://www.bloomberg.com/feeds/markets/news.rss', 'markets', 'global'),
  ('bloomberg-economics', 'Bloomberg — economics', 'https://www.bloomberg.com/feeds/economics/news.rss', 'economy', 'global'),
  ('bloomberg-tech', 'Bloomberg — technology', 'https://www.bloomberg.com/feeds/technology/news.rss', 'tech', 'global'),
  ('bloomberg-politics', 'Bloomberg — politics', 'https://www.bloomberg.com/feeds/politics/news.rss', 'politics', 'global'),
  ('nyt-business', 'New York Times — business', 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', 'business', 'global'),
  ('nyt-world', 'New York Times — world', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'world', 'global'),
  ('guardian-business', 'The Guardian — business', 'https://www.theguardian.com/uk/business/rss', 'business', 'global'),
  ('guardian-world', 'The Guardian — world', 'https://www.theguardian.com/world/rss', 'world', 'global'),
  ('aljazeera', 'Al Jazeera', 'https://www.aljazeera.com/xml/rss/all.xml', 'world', 'global'),
  ('cnbc-world', 'CNBC — world', 'https://www.cnbc.com/id/100727362/device/rss/rss.html', 'world', 'global'),
  ('scmp-business', 'South China Morning Post — business', 'https://www.scmp.com/rss/92/feed/', 'business', 'global')
) AS v(key, label, url, section, market);

-- The five Moneycontrol feeds 0019 seeded come off, for the finding above: all five parse, answer
-- 200 and serve items dated 23-Apr-2024, so every poll has recorded them 'ok' for as long as they
-- have been frozen while they contributed nothing. That is lesson L23's failure — a full, stale
-- history — which is why poll.ts now fails a feed whose newest item is too old. Deactivated rather
-- than deleted, for 0029's reason: the rows keep their fetched items and their reason.
DO $$
DECLARE deactivated int;
BEGIN
  UPDATE news_sources SET active = false
   WHERE key IN ('moneycontrol', 'mc-business', 'mc-marketreports', 'mc-results', 'mc-economy');
  GET DIAGNOSTICS deactivated = ROW_COUNT;
  IF deactivated <> 5 THEN
    RAISE EXCEPTION 'expected the 5 Moneycontrol feeds 0019 seeded, deactivated %', deactivated;
  END IF;
END $$;
