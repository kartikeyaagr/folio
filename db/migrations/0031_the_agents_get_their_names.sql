-- The agents get their names.
--
-- They were labelled with their job descriptions — "Quarterly results figures", "Analyse a company
-- from scratch" — which reads as a list of tasks rather than a bench of specialists you send work
-- to. Each name below means what the agent does, so the label is not decoration standing in front
-- of the function.
--
-- **Keys are deliberately unchanged.** `agents.key` is a primary key with foreign keys from
-- `agent_runs` and `ai_drafts`, it names the systemd invocation, and it is what a log line has to
-- be greppable by. Renaming it would rewrite run history for a cosmetic gain. The agents page
-- already renders the key beneath the label, so the functional identifier never leaves the screen.
--
-- Shruti and Smriti are the two categories of scripture — that which is heard, and that which is
-- remembered. One reads the call; the other holds what is due.

UPDATE agents SET label = 'Ganak'  WHERE key = 'results-figures';   -- गणक, reckoner
UPDATE agents SET label = 'Shruti' WHERE key = 'concall-insights';  -- श्रुति, that which is heard
UPDATE agents SET label = 'Darpan' WHERE key = 'company-dossier';   -- दर्पण, mirror
UPDATE agents SET label = 'Parakh' WHERE key = 'forensics-review';  -- परख, assay
UPDATE agents SET label = 'Vaani'  WHERE key = 'news-brief';        -- वाणी, voice
UPDATE agents SET label = 'Doot'   WHERE key = 'email-workflow';    -- दूत, messenger
UPDATE agents SET label = 'Smriti' WHERE key = 'reminders';         -- स्मृति, memory

-- Every agent named, or the rename was partial and the page reads as a mix of the two schemes.
DO $$
DECLARE unnamed int;
BEGIN
  SELECT count(*) INTO unnamed FROM agents
   WHERE label NOT IN ('Ganak', 'Shruti', 'Darpan', 'Parakh', 'Vaani', 'Doot', 'Smriti');
  IF unnamed > 0 THEN
    RAISE EXCEPTION '% agent(s) kept an old label; the registry has drifted from this migration', unnamed;
  END IF;
END $$;
