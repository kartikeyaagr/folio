-- A backfill says how far it has got.
--
-- `0058` decided what a step's outcome means; this is the row that says a step is *happening at
-- all*. Before this, `jobs/backfill-company.ts` kept every step's outcome in `stepper()`'s own
-- in-memory array and wrote nothing until `record()` ran at the very end — so a company mid-backfill
-- and a company not yet claimed looked identical to anything reading the database, and the one step
-- that actually takes long enough to matter, prices, walks a bhavcopy for about twenty minutes as
-- its own subprocess with nothing durable behind it the whole time.
--
-- One row per step per attempt, written twice: once when the step starts (`outcome = 'running'`,
-- `finished_at` null) and once when it ends. A process killed mid-step — the price walk most of
-- all — leaves a `running` row rather than no row at all, the same argument `0058` already made for
-- `backfilled_at`: a claim with nothing written down under it is indistinguishable from a claim
-- that never happened.
--
-- `outcome` carries a fourth word beyond `0058`'s three (`ok`, `gap`, `error`) because a step has to
-- say it is in flight before it can say how it went. `sub_done`/`sub_total` are for the one step
-- with something worth reporting inside itself: the price walk already logs every 25 trading days
-- (`jobs/backfill-prices.ts`), and this is where that number is kept rather than only in stdout.
--
-- A new attempt starts a fresh set of rows rather than reusing the last one's — `attempt` is part of
-- the row, not a column updated in place, so a retry's steps do not overwrite what the failed
-- attempt recorded and a person can see both.

CREATE TABLE backfill_steps (
    id          bigserial   PRIMARY KEY,
    -- ON DELETE CASCADE, not the bare reference `0058` and `0059` used for the columns beside it:
    -- those are on `companies` itself, and this table's rows are derived from a company the same
    -- way `company_aliases`, `sources` and `chunks` are — cascaded rather than restricting. Without
    -- it this would have been a 19th table blocking `removeCompany`'s DELETE-first attempt (`0063`),
    -- and unlike the 18 that rightly do (a trade, a filing — something worth keeping), a backfill's
    -- own progress log has nothing left to say about a company that no longer exists.
    company_id  text        NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
    attempt     integer     NOT NULL,
    step        text        NOT NULL,
    outcome     text        NOT NULL DEFAULT 'running',
    detail      text,
    -- Only the prices step ever sets these — trading days done out of the window it is walking —
    -- and only while `outcome = 'running'`. Null together: a step with no sub-progress to report
    -- has neither, not a `done` sitting next to a `total` that was never set.
    sub_done    integer,
    sub_total   integer,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    CONSTRAINT backfill_steps_outcome_check CHECK (outcome IN ('running', 'ok', 'gap', 'error')),
    CONSTRAINT backfill_steps_finished_together CHECK ((outcome = 'running') = (finished_at IS NULL)),
    CONSTRAINT backfill_steps_sub_progress_together CHECK ((sub_done IS NULL) = (sub_total IS NULL))
);

-- The one read this table exists to serve: a company's rows for its current attempt, in the order
-- they were written — which is step order, since the job runs them one after another.
CREATE INDEX backfill_steps_company_idx ON backfill_steps (company_id, attempt, id);

COMMENT ON TABLE backfill_steps IS
  'One row per step per attempt of a company backfill, written at the step''s start and again at '
  'its end. lib/ingest/backfill-progress.ts reads it; lib/ingest/backfill.ts''s stepper() writes it.';

-- Not audited, for the reason `ingestion_runs` is not (`0003`, and db/schema.test.ts's own comment
-- on it): this table already *is* the fine-grained provenance for what the backfill job did, and a
-- second layer of audit rows recording that the first layer changed would document the job's own
-- bookkeeping rather than a decision a person made. Every write is still attributed through
-- `serviceTxn('system:ingest', …)`, exactly as `ingestion_runs`'s writes are; what is missing is
-- only the `audit_log` copy of it.
