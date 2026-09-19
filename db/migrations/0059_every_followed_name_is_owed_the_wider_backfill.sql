-- Every followed name is owed the wider backfill.
--
-- (Numbered 0059 after 0058 in this branch; 0052–0057 are claimed by other worktrees. Check
-- `ls ~/conductor/workspaces/*/db/migrations` before picking a number, not just this directory.)
--
-- `0058` fixed what "finished" means. This is the consequence nobody can get from the code: four
-- names carry `backfilled_at` from a job that had fewer steps and could not tell a gap from a
-- break, so the column is true about a backfill that no longer exists. Specifically, what those
-- four were never offered:
--
--   * **Insider and pledge disclosures.** `lib/ingest/insider.ts` fetches per symbol back to 2015
--     — 232 rows for PRAJIND — and was not a backfill step at all. Its docstring says "a newly
--     followed company arrives with its complete history and there is no backfill job to remember
--     to run", which was true of the scheduled sweep over every name and false for the name added
--     five minutes ago, who waits for the next tick.
--   * **Their own documents.** The pre-`0058` step took one capped global pass ordered newest
--     first, so a name whose history had just been attached sorted below everyone else's backlog.
--     TEGA's re-run fetched 439 attachments and read 436; before, it got what fitted.
--   * **An honest shareholding answer.** AERON and TCL were marked done with zero rows in
--     `shareholding_patterns` and no error, because the step asserted on the exchange-wide index.
--
-- So the queue state is cleared rather than the data: nothing here deletes a filing, a price or a
-- document. Every step is idempotent, which is the property that makes this safe — a re-run costs
-- the fetches and changes nothing that was already right.
--
-- **`status <> 'passed'` is the one exclusion.** A name the fund looked at and declined is kept on
-- purpose (`0002`: "what was passed on and why is part of the record"), and paying for its
-- sixteen-year history again is the one case where the answer is no. None of the four is passed
-- today; the predicate is here so it stays true when one is.

UPDATE companies
   SET backfilled_at = NULL,
       backfill_started_at = NULL,
       backfill_attempts = 0,
       backfill_error = NULL
 WHERE status <> 'passed';

DO $$
DECLARE queued int;
BEGIN
    SELECT count(*) INTO queued FROM companies WHERE backfilled_at IS NULL AND status <> 'passed';
    -- A migration that queued nothing has either run against an empty universe or silently matched
    -- no rows, and those want different responses. RAISE NOTICE rather than EXCEPTION: a fresh
    -- database legitimately has no companies, and failing the migration there would block every
    -- test that creates one.
    RAISE NOTICE 'backfill queue: % name(s) owed the wider backfill', queued;
END $$;
