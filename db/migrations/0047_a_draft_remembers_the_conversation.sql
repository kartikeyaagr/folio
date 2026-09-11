-- A draft remembers the conversation it came out of, and the desk analyst gets the two tools that
-- make one.
--
-- R4, `v4.md §13`. §6.3 is the whole design in one sentence: *"Nothing, directly. Two paths out of
-- a thread, both landing in the existing gate."* Chat becomes how you ask. It does not become
-- where the answer is filed.
--
-- `thread_id` is nullable and that is not missing data: every draft agents 1, 2, 6 and 7 have ever
-- written came from a sweep, not a conversation. Null means "no thread", which is a fact.
--
-- **`chat_messages.run_id` and `chat_messages.draft_id` stay unwritten, deliberately.** §4.2 gave
-- them to `chat_messages` and R3 left them null; R4 leaves them null too. One turn may queue
-- several runs and propose several drafts, so neither single-valued column can hold what happened,
-- and filling them "when there was exactly one" would make null mean two different things —
-- nothing happened, or several did. The provenance §6.3 actually asks for is draft → thread, which
-- is the column added here, and `chat_tool_calls` already records every call with its arguments.
-- The columns are left in place rather than dropped: R5's per-message learning may want a pointer,
-- and removing a specified column mid-phase is a spec change.

ALTER TABLE ai_drafts ADD COLUMN thread_id text REFERENCES chat_threads (id);

COMMENT ON COLUMN ai_drafts.thread_id IS
    'The chat thread this draft was proposed in, or null when it came from a sweep rather than a '
    'conversation. /review links back to it so a reader can see what was being asked.';

CREATE INDEX ai_drafts_thread_idx ON ai_drafts (thread_id) WHERE thread_id IS NOT NULL;

-- The two write tools, and the two tables they reach.
--
-- `data_scope` is asserted against what a tool's SQL touches before the model is called, so it has
-- to name these or `bindTools` refuses to hand them over. Naming them is also the point: the
-- registry now says, in one row, that this agent can put something in the queue — and that those
-- are the only two tables it can write to. `run_agent` writes an `agent_runs` row; `draft_document`
-- writes an `ai_drafts` row with status 'pending'. Neither publishes.
UPDATE agents
   SET tools = tools || ARRAY['run_agent', 'draft_document'],
       data_scope = data_scope || ARRAY['agent_runs', 'ai_drafts']
 WHERE key = 'desk-analyst';

DO $$
DECLARE scope text[]; tools text[];
BEGIN
    SELECT a.data_scope, a.tools INTO scope, tools FROM agents a WHERE a.key = 'desk-analyst';

    IF tools IS NULL THEN
        RAISE EXCEPTION 'the desk analyst is not seeded; 0044 must come first';
    END IF;
    IF NOT (ARRAY['run_agent', 'draft_document'] <@ tools) THEN
        RAISE EXCEPTION 'the write tools did not attach to the desk analyst';
    END IF;
    -- The pairing nothing else compares: a tool the agent may pick up, over a table its row does
    -- not name, fails at runtime on a claimed run with a ScopeViolation that reads like a code bug
    -- rather than the seed data it is.
    IF NOT (ARRAY['agent_runs', 'ai_drafts'] <@ scope) THEN
        RAISE EXCEPTION 'the desk analyst cannot write a draft its data_scope does not name';
    END IF;
END $$;
