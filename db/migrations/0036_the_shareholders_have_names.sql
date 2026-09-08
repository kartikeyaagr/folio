-- The shareholders have names.
--
-- `shareholding_patterns` keeps four category totals — promoter, public, FII, DII — and the filing
-- it is parsed from names every holder above 1% individually, promoters always. Eleven names in
-- PRAJIND's June quarter, walked past by a parser that stopped at the totals.
--
-- No third party is involved and none is needed. LODR Reg 31 requires the names, so they are in
-- the exchange XBRL this system already downloads; a screener parses the same file.
--
-- Percentages in the filing are fractions — `0.0139` is 1.39% — which this module already knew:
-- `pct()` in `lib/ingest/shareholding.ts` has multiplied by 100 since it was written, and the
-- convention holds for the named holders exactly as it does for the category totals. Confirmed
-- rather than rediscovered: the promoter total reads `0.3281` for the 32.81% already stored, and
-- a holding of 2,559,656 against the filing's own 183,813,088 shares is 1.39%. Stored here as a
-- percentage, through that same helper, so there is one place that knows.

CREATE TABLE shareholders (
  id         text PRIMARY KEY,
  company_id text NOT NULL REFERENCES companies(id),
  as_of      date NOT NULL,
  name       text NOT NULL,
  -- Where in the pattern they sit. From the XBRL context, not inferred from the name: a fund
  -- called "… Individual …" is still a fund.
  category   text NOT NULL CHECK (category IN ('promoter', 'mutual_fund', 'fpi', 'insurance', 'other')),
  shares     bigint,
  pct        numeric(8,4),
  fetched_at timestamptz NOT NULL DEFAULT now(),

  -- One row per holder per quarter. A refiled pattern updates rather than duplicating.
  CONSTRAINT shareholders_identity UNIQUE (company_id, as_of, name)
);

CREATE INDEX shareholders_company_idx ON shareholders (company_id, as_of DESC, pct DESC NULLS LAST);

CREATE TRIGGER audit AFTER INSERT OR UPDATE OR DELETE ON shareholders
  FOR EACH ROW EXECUTE FUNCTION audit_fn();

COMMENT ON COLUMN shareholders.pct IS
  'A percentage. The filing states a fraction; the parser multiplies by 100. See migration 0036.';
