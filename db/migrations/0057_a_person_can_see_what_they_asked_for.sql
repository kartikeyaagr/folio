-- An index for "what have I asked this agent for".
--
-- `/chat` now shows each person their own history with each agent, and an admin everybody's
-- (`lib/agents/history.ts`). The query is `WHERE agent_key = … AND requested_by IS NOT NULL AND
-- (… OR requested_by = …) ORDER BY created_at DESC`, and none of the five existing indexes helps
-- it: they are keyed on `next_attempt_at`, `claimed_at`, `finished_at` and `(agent_key,
-- subject_ref)`, all for the queue's own work rather than for a person's.
--
-- Partial on `requested_by IS NOT NULL`, which is the point of the thing. Asked-for runs are the
-- small minority — 9 of 88 rows on the database this was written against, the other 79 being what
-- the three event sweeps enqueued unattended. Indexing only the rows a person actually asked for
-- keeps this a fraction of the size of the table it sits on, and it will stay that way: sweeps
-- scale with the corpus and asking scales with three people.
CREATE INDEX agent_runs_asked_idx ON agent_runs (requested_by, agent_key, created_at DESC)
  WHERE requested_by IS NOT NULL;

COMMENT ON INDEX agent_runs_asked_idx IS
  'For /chat''s per-person history. Partial: a sweep run is not something anybody asked for.';
