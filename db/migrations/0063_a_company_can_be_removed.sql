-- A company can be removed.
--
-- The companies page had no way to take a name off the list. **Removal is soft because a hard
-- delete is almost never possible, and where it is not, it should not be.** 18 tables reference
-- `companies` with no ON DELETE: the filings, attachments, documents and fundamentals it arrived
-- with, and the transactions, cash ledger, holdings, agent runs, drafts, checklists, alerts,
-- reminders and events the desk wrote against it. A DELETE on PRAJIND (846 filings and a trade in
-- dev) is refused by the first of them, and it should be: a trade that has lost its company is a
-- book nobody can reconcile against a broker note, and a passed name's reasons are the graveyard
-- A8 exists to keep. So a removed name is hidden, kept whole, and can be restored.
--
-- A name with nothing recorded is still deleted outright (`removeCompany` in lib/companies.ts
-- tries the DELETE first, behind a savepoint). GRAVITA, followed and never filled in, has nothing
-- a DELETE would lose but its aliases and news matches, which cascade.
--
-- `removed_by` references `users` for the reason `added_by` does (0035): removal is a person's
-- act, taken from a session, and no job removes a name.
--
-- No index. Every selector that excludes a removed name reads the whole table anyway — dev holds
-- 5 companies and the fund's book is a few dozen — so a partial index would never be chosen over
-- the sequential scan it would sit beside.

ALTER TABLE companies
    ADD COLUMN removed_at timestamptz,
    ADD COLUMN removed_by text REFERENCES users (id),
    -- Who and when arrive together or not at all. A removal nobody can be asked about is the one
    -- that gets restored by guesswork.
    ADD CONSTRAINT removed_together CHECK ((removed_at IS NULL) = (removed_by IS NULL));

COMMENT ON COLUMN companies.removed_at IS
  'Set when a person removes the name and its history keeps it from being deleted. Every ingest, '
  'sweep, evaluator and picker skips it; its own page still opens and offers Restore.';
