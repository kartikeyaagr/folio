-- A rule a person signed, and the corrections that asked for it.
--
-- R6, the last block of `v4.md §7`'s prompt order and the only one that was still empty:
--
--     agents.purpose            what this agent is for. Static, changed by migration.
--     approved prompt_rules     what we have learned to tell it. Human-approved, always.   <- here
--     retrieved exemplars       work of this kind an analyst accepted, up to 3.
--
-- Two things arrive in that block, and §7 asks for both. **Distilled**: three corrections to the
-- same field become a candidate somebody has to judge. **Authored**: a person writes a standing
-- rule without waiting for three corrections to imply it — *"the loop only improves when someone
-- remembers to correct it, and sometimes you already know the rule."* One table, one gate.
--
-- ### The shape, and why it is two text columns and not one
--
-- §7 forbids a model from doing the distilling: *"Purely mechanical — no model summarises the
-- edits. A candidate rule that a person has to evaluate must be traceable to the rows it came
-- from. A generated paragraph reads better and cannot be checked."*
--
-- So what a distiller produces is **evidence, not a rule**. `finding` holds the mechanical
-- sentence it can honestly write ("3 corrections to `guidance_delta`, mean distance 0.41");
-- `rule` holds the instruction, and only a person ever writes one. The system prompt is assembled
-- from `rule`, which is why a statistics line cannot be waved into an agent's head by clicking
-- approve — it is not in the column prompts are built from.
--
-- ### Three columns §4.3's sketch does not have
--
--   origin        §7 part 4 asks for it by name ("`origin` distinguishing `distilled` from
--                 `authored`") and the sketch in §4.3 omits it, so the sketch was already known to
--                 be short. It is load-bearing: the two origins have opposite NULL shapes.
--   finding       the decision above.
--   decided_note  `/review` and `access_requests` both already hold that a refusal without a
--                 reason teaches nobody anything. A refused candidate is the one row a future
--                 reader most needs explained: the hotspot that produced it is still on /agents,
--                 still counting up, and without a note the next person re-litigates it.

-- ------------------------------------------------------------------------------------------------
-- 1. The rules
-- ------------------------------------------------------------------------------------------------

CREATE TABLE prompt_rules (
    id           text        PRIMARY KEY,
    agent_id     text        NOT NULL REFERENCES agents (key),

    -- How this row came to exist. Not how much it is worth: a distilled rule and an authored one
    -- carry exactly the same weight once approved, because the same person approved both.
    origin       text        NOT NULL,

    -- Mechanical, written by `lib/agents/distil.ts`. Never a person's words and never a model's.
    -- Null on an authored rule, which needs no evidence because somebody is asserting it.
    finding      text,

    -- The sentence that enters the system prompt, written by a person. Null on a distilled
    -- candidate until somebody reads the evidence and decides what it means.
    rule         text,

    status       text        NOT NULL DEFAULT 'candidate',
    decided_by   text        REFERENCES actors (id),
    decided_at   timestamptz,
    decided_note text,
    created_at   timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT prompt_rules_origin_check CHECK (origin IN ('distilled', 'authored')),
    -- `retired` rather than a delete: a rule that shaped an agent's output for three months is
    -- part of the record of why that output looked the way it did. Nothing in this system deletes.
    CONSTRAINT prompt_rules_status_check CHECK (
        status IN ('candidate', 'approved', 'rejected', 'retired')),

    -- §4.3, verbatim in intent: this makes a human decider a **schema property**. A rule cannot
    -- enter a prompt without a name against it. Strengthened by one clause — a candidate must also
    -- have no `decided_at`, so a half-written decision cannot masquerade as an undecided row.
    CONSTRAINT prompt_rules_decided CHECK (
        (status =  'candidate' AND decided_by IS NULL AND decided_at IS NULL) OR
        (status <> 'candidate' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)),

    -- The two origins have opposite shapes, and saying so here is what stops a distilled candidate
    -- being quietly created with a pre-written rule — which is the one route by which something no
    -- person wrote could end up in a prompt.
    CONSTRAINT prompt_rules_origin_shape CHECK (
        (origin = 'distilled' AND finding IS NOT NULL) OR
        (origin = 'authored'  AND finding IS NULL AND rule IS NOT NULL)),

    -- The whole point, as a constraint: nothing reaches a system prompt without a human sentence
    -- in it. `prompt_rules_decided` puts a name against the decision; this puts words against it.
    CONSTRAINT prompt_rules_approved_has_text CHECK (status <> 'approved' OR rule IS NOT NULL),

    CONSTRAINT prompt_rules_refusal_says_why CHECK (status <> 'rejected' OR decided_note IS NOT NULL)
);

-- The prompt assembler's query, and the authoring screen's queue.
CREATE INDEX prompt_rules_approved_idx ON prompt_rules (agent_id, decided_at) WHERE status = 'approved';
CREATE INDEX prompt_rules_open_idx     ON prompt_rules (created_at)           WHERE status = 'candidate';

COMMENT ON COLUMN prompt_rules.finding IS
    'What the distiller measured, mechanically. Never a summary — §7 forbids a model from writing '
    'this, because a generated paragraph reads better and cannot be checked.';
COMMENT ON COLUMN prompt_rules.rule IS
    'The instruction that enters the system prompt. Written by a person, always.';

-- ------------------------------------------------------------------------------------------------
-- 2. The corrections that asked for it
-- ------------------------------------------------------------------------------------------------

-- §4.3: *"Which drafts a candidate rule was derived from. A rule a person must judge has to be
-- traceable to the rows that produced it."* A candidate shows the three drafts and the three
-- fields that produced it, or it does not get shown.
CREATE TABLE rule_observations (
    rule_id  text          NOT NULL REFERENCES prompt_rules (id),
    draft_id text          NOT NULL REFERENCES ai_drafts (id),
    field    text          NOT NULL,

    -- Per-field, which `ai_drafts.edit_distance` is not — that column is the mean over every field
    -- in the draft. Recomputed by the distiller with `fieldDistance()` and kept here, so the number
    -- a rule was raised on survives even if the scoring function is ever changed.
    distance numeric(4, 3) NOT NULL,

    -- **A correction is spent once, and that is a schema property rather than a convention.**
    -- This is what lets distillation ask house rule 3's question — "which corrections has no rule
    -- accounted for yet" — with no watermark and no rolling window, both of which can only lose
    -- things. Refuse a candidate and its observations stay attached to the refusal, so the same
    -- three cannot raise it again; three fresh corrections can.
    PRIMARY KEY (draft_id, field)
);

CREATE INDEX rule_observations_rule_idx ON rule_observations (rule_id);

-- ------------------------------------------------------------------------------------------------
-- 3. What is audited
-- ------------------------------------------------------------------------------------------------

-- A decision surface, and the only one whose output is read by a model. Who approved a rule, when,
-- and what the text was before somebody changed it are all things this system will be asked.
SELECT attach_audit('prompt_rules');

-- Deliberately NOT audited:
--   rule_observations  is append-only derived evidence, written by the distiller in the same
--                      transaction as the candidate it supports — and that candidate is audited.
--                      The same argument as chat_tool_calls: auditing the evidence for an audited
--                      decision records the decision twice.

-- ------------------------------------------------------------------------------------------------
-- 4. Proving the gate is shut
-- ------------------------------------------------------------------------------------------------

-- 0049 asserted its seeded state; this has none to assert, so it asserts its central claim instead.
-- The two constraints above are the whole security argument of this migration, and a constraint
-- nobody has seen fire is a constraint nobody knows is there. Both probes roll back with their
-- subtransaction; nothing survives this block.
DO $$
DECLARE
    an_agent text := (SELECT key FROM agents ORDER BY key LIMIT 1);
    an_actor text := (SELECT id  FROM actors ORDER BY id  LIMIT 1);
BEGIN
    BEGIN
        INSERT INTO prompt_rules (id, agent_id, origin, finding, status, decided_by, decided_at)
        VALUES ('probe-1', an_agent, 'distilled', '3 corrections', 'approved', an_actor, now());
        RAISE EXCEPTION 'a rule with no human sentence in it reached the approved state';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO prompt_rules (id, agent_id, origin, rule, status)
        VALUES ('probe-2', an_agent, 'authored', 'always state the window', 'approved');
        RAISE EXCEPTION 'a rule entered a prompt with no name against it';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
END $$;
