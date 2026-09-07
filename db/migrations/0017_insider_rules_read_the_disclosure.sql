-- Insider selling and promoter pledges move off the announcement text and onto the disclosure.
--
-- Both rules matched words in a filing's category: "pledge", "disposal of shares". That fires on an
-- announcement that a disclosure exists and can say nothing about it. The PIT feed carries the
-- disclosure itself — who, how many shares, and the holding before and after — so an alert can say
-- "the promoter went from 21.05% to 18.20%" instead of "there is a filing about shares".
--
-- The rule keys are kept rather than replaced. Two rules over two sources would raise two alerts
-- for one promoter sale: the filing and the disclosure are different subjects, so deduplication on
-- (rule_key, subject_ref) would not catch it.

ALTER TABLE alert_rules DROP CONSTRAINT alert_rules_kind_check;
ALTER TABLE alert_rules ADD CONSTRAINT alert_rules_kind_check
  CHECK (kind IN ('filing_category', 'price_move', 'missing_filing', 'insider_transaction'));

UPDATE alert_rules SET
  kind = 'insider_transaction',
  patterns = '{}',
  -- Employees and directors trade small parcels constantly; a designated employee selling 3,000
  -- shares is not news. The people whose selling means something are the ones who control the
  -- company.
  config = '{"types": ["Sell"], "categories": ["Promoters", "Promoter Group"]}'
WHERE key = 'insider_selling';

UPDATE alert_rules SET
  kind = 'insider_transaction',
  patterns = '{}',
  -- A revocation is a pledge being released. It is good news, it is in the table, and it does not
  -- need to interrupt anybody.
  config = '{"types": ["Pledge", "Pledge Invoke"]}'
WHERE key = 'promoter_pledge';
