-- What a turn cost.
--
-- Found by running the thing: on 11-Sep-2026 the first live chat turn this system ever took made
-- six tool calls at `xhigh` and the system could not say what it had spent, because there was
-- nowhere to put the figure. `takeTurn` computed `costUsd` and dropped it on the floor.
--
-- That is a breach of the rule and not a gap in a nice-to-have. D5, restated by `0030`:
--
--   "'Cost is visible and true' is about the number never being a lie — v2's dashboard reported
--    $0.00 because nothing seeded its price table."
--
-- A system that spends money and cannot report it is the same failure wearing different clothes:
-- v2's dashboard gave a confident wrong number, and this gave no number at all. Both leave a person
-- unable to answer "what did that cost".
--
-- Nullable, all three, and that is the honest shape rather than a default of zero:
--
--   * a person's message has no cost, because a person typing is not a model call;
--   * a turn that failed before the model answered has tokens spent but no usable total — and on
--     an unknown model `costUsd()` returns null rather than zero, which is the whole point of it;
--   * a turn from before this migration has none, and backfilling a zero would invent a fact.
--
-- So `<Blank why="…">` on the screen where it is null, never `$0.00`. Per `0030` the figure is
-- admin-only: a per-turn dollar amount in front of everybody invites the wrong argument about
-- which questions are worth asking, and the desk is meant to ask.

ALTER TABLE chat_messages
    ADD COLUMN input_tokens  integer,
    ADD COLUMN output_tokens integer,
    ADD COLUMN cost_usd      numeric(12, 6);

COMMENT ON COLUMN chat_messages.cost_usd IS
    'What this turn cost, in dollars. Null when unknown — an unpriced model, or a turn that did '
    'not reach an answer. Never zero for an unknown: a zero is a claim, a null is an admission.';

-- Only an agent message can carry a cost. A person's message with a price on it would mean the
-- figure came from somewhere other than a model call, and nobody reading it could tell where.
ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_only_agents_cost CHECK (
        role = 'agent' OR (input_tokens IS NULL AND output_tokens IS NULL AND cost_usd IS NULL)
    );
