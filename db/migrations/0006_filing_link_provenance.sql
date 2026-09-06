-- How a filing found its company, recorded rather than assumed.
--
-- Measured against the live feed 06-Sep-2026: mainboard announcements carry `sm_isin`, SME
-- announcements carry null. So the identity-spine rule that prices follow — join on the
-- instrument, never the symbol — is not available on the SME board, which is the board this book
-- mostly lives on. Symbol is the only key there.
--
-- Rather than silently downgrade, the link says which key it used. A symbol match is a weaker
-- claim than an ISIN match and the UI can say so, the same way a news match states why it matched.
ALTER TABLE filings ADD COLUMN linked_by text;
ALTER TABLE filings ADD CONSTRAINT filings_linked_by_check
    CHECK (linked_by IS NULL OR linked_by IN ('isin', 'symbol'));

COMMENT ON COLUMN filings.linked_by IS
    'isin where the feed gave one, symbol on the SME board where it does not. Null means unlinked.';

-- NSE sets hasXbrl = true on announcements that plainly have no XBRL instance behind them — a
-- "Copy of Newspaper Publication" carries the flag. It is recorded because it is what the feed
-- said, and it is not trusted: results filings come from the corporates-financial-results
-- endpoint, which returns the instance URL directly.
COMMENT ON COLUMN filings.has_xbrl IS
    'As reported by NSE, which sets it on everything. Not a reliable way to find results filings.';
