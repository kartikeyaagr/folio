-- A backfill the box broke is not a finished backfill.
--
-- (Numbered 0058 rather than 0052: five parallel worktrees were open on 17-Sep-2026 and 0052–0057
-- were already taken, two of them by the same number on different branches. Check
-- `ls ~/conductor/workspaces/*/db/migrations` and not just this directory before picking one.)
--
-- `0035` built the queue and got its predicate right: `backfilled_at IS NULL` is "has no backfill
-- yet", asked rather than watermarked, so a crash halfway leaves the name for the next run. What it
-- did not do is decide what *finished* means, and `jobs/backfill-company.ts` answered with "the
-- loop returned" — it set `backfilled_at = now()` unconditionally and argued the case:
--
--   > *"Marked done even when a step failed. The name is not owed a second full sweep because its
--   > shareholding has not been filed yet."*
--
-- That argument is right about the exchange and wrong about the box, and the job had no way to tell
-- the two apart. Measured on the dev database, 17-Sep-2026: AERON and TCL both carry
-- `backfilled_at` with no `backfill_error`, and both have **zero rows** in `shareholding_patterns`.
-- Re-running TEGA's backfill with an unwritable `ATTACHMENT_DIR` produced `annual reports: 5
-- offered, 0 stored, 5 failed` and 93 consecutive EACCES on its documents — every one of them a
-- step the job would have recorded as a success, before marking the name done forever. Nothing
-- re-offers it: `ingest-attachments` has no timer, and the queue's own predicate no longer matches.
--
-- `lib/agents/queue.ts` already settled this exact question for agent runs, and the wording there
-- is the wording here: `failure_kind = 'error'` is the machine and comes back, `refusal` and
-- `unparseable` are the subject and stay retired. A backfill step now ends `ok`, `gap` (the
-- exchange has nothing for this name, which is a fact about the name) or `error` (the box or the
-- feed broke, which is a fact about us), and only the last keeps the name in the queue.
--
-- ### Two columns, both of which already half-existed
--
-- `backfill_started_at` has been written since `0035` and read by nothing. It becomes the lease:
-- the claim writes it, and the queue skips a name claimed inside `LEASE_MINUTES`. That closes a
-- second hole the ten-minute timer opened — a backfill takes longer than ten minutes (the price
-- walk alone is documented at twenty), so without a lease the next tick starts a second pass over
-- the same name and spawns a second `backfill-prices` subprocess for it.
--
-- `backfill_attempts` is new and is the only thing that stops a permanently broken name from being
-- retried every ninety minutes forever. Three, the same bound `MAX_ATTEMPTS` uses for agent runs,
-- and for the same reason: the fourth attempt has never once been the one that worked.
--
-- A name that exhausts its attempts does **not** get `backfilled_at` — the column means "the whole
-- history was fetched" and writing it on a give-up is the lie this migration exists to stop. It
-- leaves the queue by the attempt bound instead, with `backfill_error` saying what broke, and
-- `/companies` renders that rather than an empty cell.

ALTER TABLE companies ADD COLUMN backfill_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN companies.backfill_attempts IS
  'How many times the backfill job has claimed this name. Bounded, so a name the exchange or the '
  'box will never serve stops being asked for. Reset to 1 by a run forced with --symbol.';

COMMENT ON COLUMN companies.backfill_started_at IS
  'The lease. Set when the job claims the name; a claim newer than LEASE_MINUTES means somebody '
  'else is working it and the queue skips it. Read by lib/ingest/backfill.ts and nothing else.';

COMMENT ON COLUMN companies.backfill_error IS
  'What the last attempt could not do, steps joined. Present with backfilled_at set means the '
  'history arrived with gaps the exchange has not filed; present with it NULL means the attempt '
  'broke and the name is either queued for another go or out of attempts.';

-- The queue's index gains the attempt bound, because the predicate did. Dropped and rebuilt rather
-- than added alongside: two partial indexes over the same rows is one more than the planner needs.
DROP INDEX companies_backfill_queue;
CREATE INDEX companies_backfill_queue ON companies (created_at)
  WHERE backfilled_at IS NULL AND backfill_attempts < 3;

-- AERON and TCL were marked done on 11-Sep by a job that could not tell a gap from a break, and
-- both are missing their shareholding. They are not re-queued here — `backfilled_at` is a fact
-- about what was fetched and rewriting it in a migration would be the same lie from the other
-- direction. The error text says what is known, and `--symbol` re-runs either on demand.
UPDATE companies
   SET backfill_error = 'shareholding: no pattern held for this name; the 11-Sep backfill could '
                        'not tell a gap from a failure and recorded neither'
 WHERE backfilled_at IS NOT NULL
   AND backfill_error IS NULL
   AND NOT EXISTS (SELECT 1 FROM shareholding_patterns s WHERE s.company_id = companies.id);

DO $$
BEGIN
    -- The bound is in the index predicate and in TypeScript, and a disagreement between them is a
    -- queue that reads one thing and is indexed for another. Proven here so it fails at migration
    -- time rather than as a sequential scan nobody notices.
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE indexname = 'companies_backfill_queue'
           AND indexdef LIKE '%backfill_attempts < 3%'
    ) THEN
        RAISE EXCEPTION 'the backfill queue index does not carry the attempt bound';
    END IF;
END $$;
