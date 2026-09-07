-- A pledge is not the only way a promoter's shares can be tied up.
--
-- Vedanta's June 2026 filing reports no pledge at all and 99.99% of the promoter holding
-- encumbered — non-disposal undertakings and "other encumbrances". A system that reads only the
-- pledge element would report that promoter as unencumbered, which is the opposite of true.

ALTER TABLE shareholding_patterns
  ADD COLUMN promoter_encumbered_pct numeric(8,4);

COMMENT ON COLUMN shareholding_patterns.promoter_pledge_pct IS
  'Pledged shares as a percentage of the PROMOTER HOLDING, not of the company. The XBRL element is
   named ...AsPercentageOfTotalNumberOfShares and does not mean that: ZEEL''s promoter holds 3.99%
   of the company and the element reads 5.38%. This is also how the market quotes a pledge.';

COMMENT ON COLUMN shareholding_patterns.promoter_encumbered_pct IS
  'All encumbrance — pledge, non-disposal undertaking and other — on the same basis.';
