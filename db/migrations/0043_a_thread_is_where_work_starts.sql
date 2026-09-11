-- A thread is where work starts, not where it is filed.
--
-- v2 persisted chat threads and then never sent the prior turns: each question was independent and
-- the thread id was "provenance rather than an input". That was defensible when the model could
-- not go and look anything up. It is not defensible once it can, because half of what makes a
-- follow-up cheap is that the model already knows what it read.
--
-- `chat_tool_calls` is the transparency surface and is not optional. Every retrieval the model
-- performed is a row here, with the chunk ids it got back, so what an answer was built from is a
-- query rather than an inference. A cited answer whose citations cannot be checked is worse than
-- an uncited one — and the corpus these tools read is assembled from documents written by other
-- people, which is the main new risk in v4 (§9).
--
-- The `role` CHECK keeps v2's constraint and relaxes it by exactly one value, deliberately:
--
--   0047 — "Never 'assistant': a model's answer is a draft in the review queue, not a message in
--           a conversation, and blurring that is how AI text ends up read as settled."
--
-- v4 allows 'agent'. An agent message is still not the record: it is a message in a thread, and it
-- becomes the record only by being drafted and accepted. Hence no 'assistant' here either — the
-- word that was refused is still refused, and the one admitted carries the distinction in its name.
--
-- `run_id` and `draft_id` are nullable and nothing writes them yet. They belong to R4's write paths
-- (`run_agent`, `draft_document`); the columns are here because §4.2 defines this table once, and
-- splitting a specified shape across two migrations to save two unused columns is churn.

CREATE TABLE chat_threads (
    id          text        PRIMARY KEY,
    -- Named from its first message, so a thread always has one by the time it is committed.
    title       text        NOT NULL,
    created_by  text        NOT NULL REFERENCES actors (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Archived, never deleted. A question somebody asked is a record of what was being thought
    -- about, and the answer to "why did we look at this in August" is often only in here.
    archived_at timestamptz
);

CREATE INDEX chat_threads_open_idx ON chat_threads (created_at DESC) WHERE archived_at IS NULL;

CREATE TABLE chat_messages (
    id         text        PRIMARY KEY,
    thread_id  text        NOT NULL REFERENCES chat_threads (id) ON DELETE CASCADE,
    -- Ordering within the thread. Explicit rather than derived from written_at: two writes inside
    -- one transaction share a now(), and a turn is a person's message and an agent's together.
    seq        int         NOT NULL,
    role       text        NOT NULL,
    body       text        NOT NULL,

    -- R4. A message that asked for an agent run, and a message that proposed a draft.
    run_id     text        REFERENCES agent_runs (id),
    draft_id   text        REFERENCES ai_drafts (id),

    written_by text        NOT NULL REFERENCES actors (id),
    written_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chat_messages_role CHECK (role = ANY (ARRAY['person', 'agent', 'system'])),
    CONSTRAINT chat_messages_ordered UNIQUE (thread_id, seq)
);

CREATE INDEX chat_messages_thread_idx ON chat_messages (thread_id, seq);

CREATE TABLE chat_tool_calls (
    id             text        PRIMARY KEY,
    message_id     text        NOT NULL REFERENCES chat_messages (id) ON DELETE CASCADE,
    -- Order within the turn, so a reader can follow what it did in the order it did it.
    ord            int         NOT NULL,
    tool           text        NOT NULL,
    arguments      jsonb       NOT NULL,
    result_summary text        NOT NULL,
    -- The chunks this call returned. bigint because chunks.id is a bigserial, unlike every other
    -- id in this schema. Empty for a tool that reads no corpus, never null: "returned nothing" and
    -- "does not return chunks" are both true statements and neither is missing data.
    chunk_ids      bigint[]    NOT NULL DEFAULT '{}',
    ran_at         timestamptz NOT NULL DEFAULT now(),
    duration_ms    int         NOT NULL,
    -- A call that failed. Kept because a failed read and a read that found nothing must never look
    -- the same — the house rule this system has paid for five times.
    error          text,

    CONSTRAINT chat_tool_calls_ordered UNIQUE (message_id, ord)
);

CREATE INDEX chat_tool_calls_message_idx ON chat_tool_calls (message_id, ord);

SELECT attach_audit('chat_threads');
SELECT attach_audit('chat_messages');

-- Deliberately NOT audited:
--   chat_tool_calls  is itself the audit trail of what the model read, append-only and never
--                    updated. Auditing it is the same recursion audit_log is excluded for, and at
--                    up to eight rows per turn it would double the write volume of the surface
--                    this system's three people use most.
