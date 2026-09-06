-- Prices join to companies on ISIN, never on symbol.
--
-- 0003 keyed prices by symbol alone. That is wrong for the same reason v2 found on 01-Sep-2026: a
-- symbol can be reassigned to a different company, and the price path is the one place a silent
-- wrong-company match is most expensive — it produces a plausible chart for the wrong business.
--
-- The UDiFF bhavcopy carries the ISIN on every row, so there is no reason to match on anything
-- weaker. Symbol stays as the readable label and as part of the key, because the exchange
-- publishes one row per (symbol, date) and that is what makes a re-run idempotent.
ALTER TABLE prices ADD COLUMN isin text;
CREATE INDEX prices_isin_idx ON prices (isin, on_date DESC) WHERE isin IS NOT NULL;

COMMENT ON COLUMN prices.isin IS
    'The identity to join on. Symbol is a label; ISIN is the instrument.';
