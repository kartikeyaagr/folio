-- A year we asked for and did not get.
--
-- The annual-report feed answers per symbol with a company's whole filed history, so the obvious
-- queue is "every year we have not fetched". That queue never empties. NSE's payload for PRAJIND
-- carries 16 rows for 17 fiscal years — FY2021-22 is simply not there — and its FY2019-20 archive
-- is truncated at source, with a valid content-length, one local file header and no central
-- directory. Neither is a transport fault and neither improves on a retry.
--
-- So the queue records the ASK, not just the success. `unavailable` is a terminal state with a
-- reason, and it is distinguishable from "not yet fetched" without a watermark: the predicate
-- stays "what has no row here", and a row exists as soon as we have asked once.

CREATE TABLE annual_report_attempts (
  company_id  text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_yr     text NOT NULL,
  state       text NOT NULL,
  sha256      text REFERENCES attachments(sha256),
  reason      text,
  asked_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (company_id, from_yr),
  CONSTRAINT annual_report_attempts_state CHECK (state = ANY (ARRAY['stored','unavailable'])),
  -- A stored year names its bytes; an unavailable one names why. Neither may be silent.
  CONSTRAINT annual_report_attempts_evidence CHECK (
    (state = 'stored'      AND sha256 IS NOT NULL) OR
    (state = 'unavailable' AND reason IS NOT NULL)
  )
);

COMMENT ON TABLE annual_report_attempts IS
  'One row per (company, fiscal year) we have asked NSE for. Its absence is the queue.';

-- Every other table in this tree is audited (db/schema.test.ts asserts total coverage), and this
-- one is not exchange telemetry like ingestion_runs — it is the fund's own record of which fiscal
-- years exist and which are permanently missing, which is exactly what "every write is attributed"
-- is for.
SELECT attach_audit('annual_report_attempts');
