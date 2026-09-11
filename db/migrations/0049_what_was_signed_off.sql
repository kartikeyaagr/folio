-- What was signed off, and how far it was from what the model said.
--
-- R5a. `v4.md §7` stakes the whole learning loop on one number — *"If mean edit distance does not
-- fall, the loop is not working and should be turned off"* — and that number could not move,
-- because nothing in this system could edit a draft. `app/_lib/actions/review.ts` called
-- `acceptDraft(id, null, …)` and the accept form carried a hidden id and a submit button, so
-- `edited ?? draft.content` was always `draft.content` and `ai_drafts.edits` was structurally always
-- `{}`. Mean edit distance would have rendered 0.000 for every agent forever, which reads as "the
-- agents are perfect" and means "nobody can correct them". D5's exact failure shape.
--
-- This migration adds the three places that number and its corpus live. The screen that lets a
-- person actually change a field ships with it.

-- ------------------------------------------------------------------------------------------------
-- 1. The distance, computed once
-- ------------------------------------------------------------------------------------------------

-- Written at accept time from `lib/agents/distance.ts`, the same discipline `cost_usd` follows: a
-- figure derived from code belongs in a column, not in a query that re-derives it. The alternative
-- is running word-level Levenshtein over jsonb on every render of /agents.
--
-- Null until accepted, and null is not zero — a draft nobody has decided on has no distance, and a
-- draft accepted unchanged has one, and it is 0.
ALTER TABLE ai_drafts ADD COLUMN edit_distance numeric(4, 3);

COMMENT ON COLUMN ai_drafts.edit_distance IS
    'How far the accepted content is from what the agent wrote, 0-1. Null until decided. '
    'Word-level Levenshtein for prose of eight words or more, character-level for shorter values.';

-- The agent's one-line description of the inputs it saw, carried from the draft to the exemplar
-- acceptance writes. It has to live here because the handler produces it at draft time and the
-- exemplar is written at accept time, possibly days later and certainly in another transaction.
--
-- Nullable, because every draft written before this migration has none. `recordExemplar` writes no
-- exemplar for those rather than inventing a situation for them — a fabricated one would match
-- nothing in particular and would be indistinguishable, later, from one an agent actually wrote.
ALTER TABLE ai_drafts ADD COLUMN situation text;

-- ------------------------------------------------------------------------------------------------
-- 2. Which agents learn
-- ------------------------------------------------------------------------------------------------

-- §7: agents 2, 6, 7 and 8 learn; 1, 4 and 5 do not. Agent 1 has a deterministic verifier, which is
-- a better teacher than an example, and 4 and 5 call no model at all.
--
-- **The flag gates retrieval, not capture.** Acceptance writes an exemplar for every model-calling
-- agent regardless, so that turning learning on for an agent later finds a corpus already waiting
-- rather than starting from zero. Nothing reads this column until R5b wires retrieval; it is here
-- now so /agents can report Held, Retrievable and Model as three separate numbers — otherwise a
-- non-zero exemplar count against a non-learning agent reads as a bug.
ALTER TABLE agents ADD COLUMN learning boolean NOT NULL DEFAULT false;

UPDATE agents SET learning = true
 WHERE key IN ('concall-insights', 'news-brief', 'forensics-review', 'desk-analyst');

-- ------------------------------------------------------------------------------------------------
-- 3. The corpus
-- ------------------------------------------------------------------------------------------------

-- Carried from v2's `0042_learning_loop.sql` with its honest framing intact: "self-learning" here
-- is in-context learning, not fine-tuning. No GPU, and three analysts' feedback would overfit any
-- model it was trained into.
CREATE TABLE exemplars (
    id          text        PRIMARY KEY,
    agent_id    text        NOT NULL REFERENCES agents (key),
    draft_id    text        NOT NULL REFERENCES ai_drafts (id),

    -- One line describing the INPUTS the agent saw, written by the agent that saw them — not the
    -- company's name and not a summary of the output. This is the thing that gets embedded and
    -- matched against past situations, so "Q2 concall for a specialty chemicals maker, 41-page
    -- transcript, prior quarter guided 18%" is the shape. A generic string here would make every
    -- exemplar for an agent look alike and retrieval would return an arbitrary one.
    situation   text        NOT NULL,
    -- What was signed off, after the analyst's edits. Not what the model wrote.
    output      jsonb       NOT NULL,
    quality     text        NOT NULL,
    -- The company's sector, when it has one, so R5b can prefer a like-for-like example.
    vertical    text,

    embedding   vector(384),
    embed_model text,
    created_at  timestamptz NOT NULL DEFAULT now(),

    -- Vectors from two models occupy different spaces, and comparing them returns plausible numbers
    -- with meaningless neighbours — the worst available failure, because it has no symptom. The
    -- same pairing `chunks` enforces, for the same reason.
    CONSTRAINT exemplars_embedding_has_a_model CHECK ((embedding IS NULL) = (embed_model IS NULL)),
    -- Rejections are deliberately absent: a rejection says what was wrong without ever saying what
    -- right would have looked like, so it steers distillation and stays out of here.
    CONSTRAINT exemplars_quality_check CHECK (quality IN ('accepted', 'edited')),
    -- One exemplar per accepted draft. Accepting is a one-way door (`lockDraft` refuses a second
    -- decision), so a duplicate here would mean two rows claiming to be the same signed-off work.
    CONSTRAINT exemplars_one_per_draft UNIQUE (draft_id)
);

-- The queue R5b's indexer drains, in the shape house rule 3 requires: "what has no embedding yet",
-- never "what is new since I last looked".
CREATE INDEX exemplars_unembedded_idx ON exemplars (created_at) WHERE embedding IS NULL;
CREATE INDEX exemplars_embedding_idx  ON exemplars USING hnsw (embedding vector_cosine_ops);
CREATE INDEX exemplars_agent_idx      ON exemplars (agent_id, created_at DESC);

-- Deliberately NOT audited:
--   exemplars  is derived from an accepted draft, and that acceptance is already an audited write
--              on `ai_drafts` carrying the person who made it. The only mutation after insert is
--              the indexer writing an embedding, which would put 384 floats into `before` and 384
--              into `after` on every row — the same argument that excludes `chunks`, with a worse
--              payload.

DO $$
DECLARE learners int;
BEGIN
    SELECT count(*) INTO learners FROM agents WHERE learning;
    IF learners <> 4 THEN
        RAISE EXCEPTION '§7 names four learning agents, found %', learners;
    END IF;
    -- Agent 1's exclusion is the one most likely to be undone by accident, because it is the only
    -- agent excluded for a reason other than "it calls no model".
    IF EXISTS (SELECT 1 FROM agents WHERE key = 'results-figures' AND learning) THEN
        RAISE EXCEPTION 'agent 1 has a deterministic verifier, which is a better teacher than an example';
    END IF;
END $$;
