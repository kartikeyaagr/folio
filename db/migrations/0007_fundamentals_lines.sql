-- The rest of the P&L, and everywhere else to put what was parsed.
--
-- 0003 carried seven lines, which is enough to say whether a quarter was good and not enough to
-- say why. These are the ones ratios need.
ALTER TABLE fundamentals
    ADD COLUMN total_income            numeric(20, 2),
    ADD COLUMN cost_of_materials       numeric(20, 2),
    ADD COLUMN purchases_stock_in_trade numeric(20, 2),
    ADD COLUMN changes_in_inventories  numeric(20, 2),
    ADD COLUMN employee_cost           numeric(20, 2),
    ADD COLUMN finance_costs           numeric(20, 2),
    ADD COLUMN depreciation            numeric(20, 2),
    ADD COLUMN other_expenses          numeric(20, 2),
    ADD COLUMN tax_expense             numeric(20, 2),
    ADD COLUMN comprehensive_income    numeric(20, 2);

-- Everything the parser understood, whether or not it has a column. Named columns are for the
-- figures ratios read on every page load; this is so that a line we did not anticipate is still
-- there when somebody asks, without a migration to go and re-fetch it.
--
-- Balance-sheet figures land here too. A quarterly filing carries none — a balance sheet arrives
-- with the annual — and that asymmetry is real rather than a gap to fill with zeroes.
ALTER TABLE fundamentals ADD COLUMN facts jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN fundamentals.facts IS
    'Every element the parser mapped, including balance-sheet lines from the instant context. '
    'A figure absent here was absent from the filing; nothing is defaulted to zero, because zero '
    'is a real figure in a financial statement and inventing one is worse than admitting the gap.';
