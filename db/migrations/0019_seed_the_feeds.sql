-- The feeds. Every one of them fetched and parsed on 07-Sep-2026 before being written down.
--
-- A source list assembled from plausible URLs is a list of things that fail silently at 06:30, and
-- a silent failure here looks exactly like a quiet news day. 56 of the 57 carried forward from v2
-- returned a well-formed feed with real items. Three notes, all of them things a re-check found:
--
--   * `labels-labeling` now answers 403 and is absent rather than hopefully present.
--   * `pib` is seeded INACTIVE. Its RSS returns Hindi whatever the Lang parameter says, and carries
--     neither a date nor a guid — so it cannot be ordered by time and will match an English company
--     name roughly never. Kept as a row so the reason survives and someone can revisit it.
--   * `sebi` dates are written "07 Sep, 2026 +0530", which needed a parser fix rather than a seed
--     change. Without it thirty regulatory notices arrived undated.
--
-- `market` is the anchor fix. v2 asked a *headline* whether it mentioned India when the source
-- already knew — a domestic trade title's stories are about India whether or not they say so. That
-- cost two confirmed true positives, both PRAJIND, both ChiniMandi on sugar-mill directives.

INSERT INTO news_sources (key, label, url, tier, sector, market, active) VALUES
  ('australian-mining', 'Australian Mining', 'https://www.australianmining.com.au/feed/', 2, 'mining', 'global', true),
  ('automotive-world', 'Automotive World', 'https://www.automotiveworld.com/feed/', 2, 'auto', 'global', true),
  ('bioenergy-insight', 'Bioenergy Insight', 'https://www.bioenergy-news.com/feed/', 2, 'bioenergy', 'global', true),
  ('bl-companies', 'BusinessLine — companies', 'https://www.thehindubusinessline.com/companies/feeder/default.rss', 2, NULL, 'india', true),
  ('bl-news', 'BusinessLine — news', 'https://www.thehindubusinessline.com/news/feeder/default.rss', 2, NULL, 'india', true),
  ('bs-companies', 'Business Standard — companies', 'https://www.business-standard.com/rss/companies-101.rss', 2, NULL, 'india', true),
  ('bs-industry', 'Business Standard — industry', 'https://www.business-standard.com/rss/industry-217.rss', 2, NULL, 'india', true),
  ('bs-latest', 'Business Standard — latest', 'https://www.business-standard.com/rss/latest.rss', 2, NULL, 'india', true),
  ('bs-markets', 'Business Standard — markets', 'https://www.business-standard.com/rss/markets-106.rss', 2, NULL, 'india', true),
  ('business-today', 'Business Today', 'https://www.businesstoday.in/rssfeeds/?id=225346', 2, NULL, 'india', true),
  ('businessline', 'The Hindu BusinessLine — markets', 'https://www.thehindubusinessline.com/markets/feeder/default.rss', 2, NULL, 'india', true),
  ('chem-engineering', 'Chemical Engineering', 'https://www.chemengonline.com/feed/', 2, 'chemicals', 'global', true),
  ('chem-industry-digest', 'Chemical Industry Digest', 'https://chemindigest.com/feed/', 2, 'chemicals', 'india', true),
  ('chinimandi', 'ChiniMandi — sugar and ethanol', 'https://www.chinimandi.com/feed/', 2, 'bioenergy', 'india', true),
  ('cnbctv18-business', 'CNBC-TV18 — business', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/business.xml', 2, NULL, 'india', true),
  ('cnbctv18-market', 'CNBC-TV18 — markets', 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', 2, NULL, 'india', true),
  ('et-energy', 'Economic Times — energy', 'https://economictimes.indiatimes.com/industry/energy/rssfeeds/13358350.cms', 2, NULL, 'india', true),
  ('et-industry', 'Economic Times — industry', 'https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms', 2, NULL, 'india', true),
  ('et-markets', 'Economic Times — markets', 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', 2, NULL, 'india', true),
  ('et-smallbiz', 'Economic Times — small business', 'https://economictimes.indiatimes.com/small-biz/rssfeeds/5575607.cms', 2, NULL, 'india', true),
  ('express-pharma', 'Express Pharma', 'https://www.expresspharma.in/feed/', 2, 'pharma', 'india', true),
  ('food-dive', 'Food Dive', 'https://www.fooddive.com/feeds/news/', 2, 'food', 'global', true),
  ('fortune-india', 'Fortune India', 'https://www.fortuneindia.com/feed', 2, NULL, 'india', true),
  ('hindu-business', 'The Hindu — business', 'https://www.thehindu.com/business/feeder/default.rss', 2, NULL, 'india', true),
  ('im-mining', 'International Mining', 'https://im-mining.com/feed/', 2, 'mining', 'global', true),
  ('indian-printer', 'Indian Printer & Publisher', 'https://indianprinterpublisher.com/feed/', 2, 'packaging', 'india', true),
  ('jec-composites', 'JEC Composites', 'https://www.jeccomposites.com/feed/', 2, 'composites', 'global', true),
  ('machine-maker', 'The Machine Maker', 'https://themachinemaker.com/feed', 2, 'engineering', 'india', true),
  ('manufacturing-dive', 'Manufacturing Dive', 'https://www.manufacturingdive.com/feeds/news/', 2, 'engineering', 'global', true),
  ('mc-business', 'Moneycontrol — business', 'https://www.moneycontrol.com/rss/business.xml', 2, NULL, 'india', true),
  ('mc-marketreports', 'Moneycontrol — market reports', 'https://www.moneycontrol.com/rss/marketreports.xml', 2, NULL, 'india', true),
  ('mc-results', 'Moneycontrol — results', 'https://www.moneycontrol.com/rss/results.xml', 2, NULL, 'india', true),
  ('metal-miner', 'MetalMiner', 'https://agmetalminer.com/feed/', 2, 'metals', 'global', true),
  ('mining-com', 'Mining.com', 'https://www.mining.com/feed/', 2, 'mining', 'global', true),
  ('mint-companies', 'Mint — companies', 'https://www.livemint.com/rss/companies', 2, NULL, 'india', true),
  ('mint-industry', 'Mint — industry', 'https://www.livemint.com/rss/industry', 2, NULL, 'india', true),
  ('mint-markets', 'Mint — markets', 'https://www.livemint.com/rss/markets', 2, NULL, 'india', true),
  ('mint-news', 'Mint — news', 'https://www.livemint.com/rss/news', 2, NULL, 'india', true),
  ('moneycontrol', 'Moneycontrol — latest', 'https://www.moneycontrol.com/rss/latestnews.xml', 2, NULL, 'india', true),
  ('motor-india', 'Motor India', 'https://www.motorindiaonline.in/feed/', 2, NULL, 'india', true),
  ('packaging-dive', 'Packaging Dive', 'https://www.packagingdive.com/feeds/news/', 2, 'packaging', 'global', true),
  ('packaging-south-asia', 'Packaging South Asia', 'https://packagingsouthasia.com/feed/', 2, 'packaging', 'india', true),
  ('recycling-today', 'Recycling Today', 'https://www.recyclingtoday.com/rss/', 2, 'recycling', 'global', true),
  ('supply-chain-dive', 'Supply Chain Dive', 'https://www.supplychaindive.com/feeds/news/', 2, 'engineering', 'global', true),
  ('toi-business', 'Times of India — business', 'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms', 2, NULL, 'india', true),
  ('waste-dive', 'Waste Dive', 'https://www.wastedive.com/feeds/news/', 2, 'recycling', 'global', true),
  ('waste-today', 'Waste Today', 'https://www.wastetodaymagazine.com/rss/', 2, 'recycling', 'global', true),
  ('bl-agri', 'BusinessLine — agri-business', 'https://www.thehindubusinessline.com/economy/agri-business/feeder/default.rss', 3, NULL, 'india', true),
  ('bl-economy', 'BusinessLine — economy', 'https://www.thehindubusinessline.com/economy/feeder/default.rss', 3, NULL, 'india', true),
  ('bs-economy', 'Business Standard — economy', 'https://www.business-standard.com/rss/economy-102.rss', 3, NULL, 'india', true),
  ('et-economy', 'Economic Times — economy', 'https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms', 3, NULL, 'india', true),
  ('mc-economy', 'Moneycontrol — economy', 'https://www.moneycontrol.com/rss/economy.xml', 3, NULL, 'india', true),
  ('mint-economy', 'Mint — economy', 'https://www.livemint.com/rss/economy', 3, NULL, 'india', true),
  ('pib', 'Press Information Bureau', 'https://www.pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3', 3, NULL, 'india', false),
  ('rbi', 'Reserve Bank of India — press releases', 'https://www.rbi.org.in/pressreleases_rss.xml', 3, NULL, 'india', true),
  ('sebi', 'SEBI', 'https://www.sebi.gov.in/sebirss.xml', 3, NULL, 'india', true);
