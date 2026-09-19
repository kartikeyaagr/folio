-- Agent 8 is cut, and chat with it.
--
-- "The desk analyst" — Anveshak, `desk-analyst` — is dropped at the fund's request, 17-Sep-2026.
-- It was the whole of `/chat`: the thread list, the eight-round-trip tool loop, and the six tools.
-- All of it goes. **Its number is not reused**, following `0034` and the investor-letter cut before
-- it: agent 8 stays the desk analyst in every older note, and nothing new takes the number.
--
-- **Unlike `0034`, this one was not free.** The dossier agent had produced no runs and no drafts,
-- so its deletion orphaned nothing and that migration could say so. This one had, on the database
-- it was written against, 7 runs, 2 accepted drafts, 6 threads, 16 messages, 20 tool calls and an
-- exemplar. What that costs is written out below rather than left to be discovered.
--
-- **What nothing else now does.** This was the only agent that read the content store. `sources`
-- and `chunks` — 1,921 rows and 24,342 chunks with a local 384-dimension embedding each — are now
-- reachable only by `retrieveExemplars`, which searches past accepted drafts and never the corpus.
-- The indexer, the embedder and hybrid search all still run and still cost what they cost; nothing
-- asks them a question. That is a consequence of this cut and not an argument against it, but a
-- later session finding an expensively-maintained corpus with no reader should find this paragraph
-- rather than conclude something is broken.
--
-- Also gone: `run_agent` and `draft_document`, the two write paths R4 built. Both landed in the
-- same accept gate `/review` still serves, so nothing about the gate changes — there is one fewer
-- way to reach it. `/agents`' "Ask an agent" form is now the only way a person queues a prompted
-- run by hand, and `lib/agents/invocable.ts` is still the list of who may be asked.

-- ------------------------------------------------------------------------------------------------
-- 1. Accepted documents survive. Their provenance does not.
-- ------------------------------------------------------------------------------------------------
--
-- `documents_from_draft_id_fkey` carries no ON DELETE clause, so Postgres REFUSES to drop a draft a
-- document still points at. That refusal is the review gate's design working — "every draft shows
-- where it came from, before and after that decision" — and severing it by hand is the one
-- genuinely destructive act in this file. Done deliberately, and recorded here because this comment
-- will outlive the rows. On the database this was written against it was exactly two, both PRAJIND
-- memos accepted on 11-Sep-2026:
--
--     document cc662176e324bd69f387983641852f05  "What the filings say about contingent liabilities"
--       ← draft 37adc39a60a74d51945d8bd7ae029083
--     document baf57165af212f5184396c1257949d87  "Praj — contingent liabilities as disclosed"
--       ← draft 50ca9407b81542b102c944487900d7f9
--
-- The memos are untouched. What is lost is the answer to "what drafted this", for those two.
UPDATE documents d
   SET from_draft_id = NULL
  FROM ai_drafts x
 WHERE x.id = d.from_draft_id AND x.agent_key = 'desk-analyst';

-- ------------------------------------------------------------------------------------------------
-- 2. The column that reached into chat, then the tables.
-- ------------------------------------------------------------------------------------------------
--
-- `ai_drafts.thread_id` was `0047` — "a draft remembers the conversation", the link `/review`
-- rendered as "Read the conversation →". With no conversations it can only ever be NULL, and a
-- nullable column nothing writes is the kind of thing a later reader builds on top of. Dropped
-- before the table it references, or the DROP TABLE below fails on the foreign key.
ALTER TABLE ai_drafts DROP COLUMN thread_id;

-- Dropped rather than emptied first: DROP TABLE takes the rows with it, and these are the only
-- things referencing the drafts and runs deleted below. Innermost first.
DROP TABLE chat_tool_calls;
DROP TABLE chat_messages;
DROP TABLE chat_threads;

-- ------------------------------------------------------------------------------------------------
-- 3. The agent's own rows.
-- ------------------------------------------------------------------------------------------------
DELETE FROM exemplars  WHERE agent_id  = 'desk-analyst';
DELETE FROM ai_drafts  WHERE agent_key = 'desk-analyst';
DELETE FROM agent_runs WHERE agent_key = 'desk-analyst';
DELETE FROM agents     WHERE key       = 'desk-analyst';

-- `agents.tools` stays. It is the registry's statement of what any agent may be handed, checked by
-- `bindTools` before a client is constructed, and it reads `'{}'` for all six survivors. Dropping
-- it would mean the next agent with a tool needs a migration to get the column back, and the
-- argument for declaring scope in the table rather than in code would have to be made again.

-- ------------------------------------------------------------------------------------------------
-- 4. Say it held.
-- ------------------------------------------------------------------------------------------------
--
-- Deliberately not asserting the two document ids above. They exist only where this was written;
-- a test database applies these same files against nothing, and an assertion that passes on one
-- machine and fails on every other is worse than none. What IS asserted holds on any database:
-- this file only ever UPDATEs `documents`, so no document can have been lost, and every draft the
-- agent wrote is gone along with the agent itself.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents WHERE key = 'desk-analyst') THEN
    RAISE EXCEPTION 'desk-analyst survived its own deletion';
  END IF;
  IF (SELECT count(*) FROM agents) <> 6 THEN
    RAISE EXCEPTION 'expected six agents after the cut, found %', (SELECT count(*) FROM agents);
  END IF;
  IF EXISTS (SELECT 1 FROM ai_drafts WHERE agent_key = 'desk-analyst') THEN
    RAISE EXCEPTION 'drafts outlived the agent that wrote them';
  END IF;
END $$;
