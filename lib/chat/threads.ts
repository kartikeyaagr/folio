/**
 * Threads and the messages in them.
 *
 * A thread is where work starts, not where it is filed. An agent's message here is a message in a
 * conversation; it becomes part of the record only by being drafted and accepted, which is R4's
 * job. That distinction is why `role` admits 'agent' and still refuses 'assistant' —
 *
 *   0047 — *"a model's answer is a draft in the review queue, not a message in a conversation,
 *            and blurring that is how AI text ends up read as settled."*
 *
 * **Prior turns are sent to the model, and v2's were not.** v2 kept threads but treated the thread
 * id as "provenance rather than an input", so every question stood alone. That was defensible when
 * the model could not go and look anything up. Once it can, half of what makes a follow-up cheap is
 * that it already read something — so the budget here is a real one, stated and enforced, because
 * an unbounded history is the unbounded prompt that killed agent 3.
 */

import { readTxn, rowId, serviceTxn, type Client, writeTxn } from '../db.ts';

/** §6.1's budget: the last 10 turns or 40,000 characters, whichever is smaller, oldest dropped. */
export const MAX_TURNS = 10;
export const MAX_HISTORY_CHARS = 40_000;

/** Long enough to tell two threads apart in a list, short enough not to wrap a pane. */
const TITLE_CHARS = 80;

export class EmptyMessage extends Error {}
export class UnknownThread extends Error {}

export interface ThreadRow {
  id: string;
  title: string;
  createdAt: Date;
  archivedAt: Date | null;
  messages: number;
  lastAt: Date | null;
}

export interface ToolCallRow {
  tool: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  chunkIds: string[];
  durationMs: number;
  error: string | null;
}

export interface MessageRow {
  id: string;
  seq: number;
  role: 'person' | 'agent' | 'system';
  body: string;
  writtenAt: Date;
  writtenBy: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Null when unknown — an unpriced model, or a turn that never reached an answer. Never zero. */
  costUsd: number | null;
  toolCalls: ToolCallRow[];
}

/** What a turn spent. Every field nullable: a failed turn knows its tokens but not its price. */
export interface Spend {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
}


/** A thread's name, taken from its first message. One line, never empty. */
export function titleFrom(body: string): string {
  const flat = body.trim().replace(/\s+/g, ' ');
  return flat.length > TITLE_CHARS ? `${flat.slice(0, TITLE_CHARS - 1)}…` : flat;
}

export async function listThreads(includeArchived = false): Promise<ThreadRow[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<ThreadRow>(
      `SELECT t.id, t.title, t.created_at AS "createdAt", t.archived_at AS "archivedAt",
              count(m.id)::int AS messages, max(m.written_at) AS "lastAt"
         FROM chat_threads t
         LEFT JOIN chat_messages m ON m.thread_id = t.id
        WHERE $1 OR t.archived_at IS NULL
        GROUP BY t.id
        -- By when it was last worked, not when it was opened: a thread you came back to
        -- yesterday is more use at the top than one you opened a month ago and left.
        ORDER BY coalesce(max(m.written_at), t.created_at) DESC`,
      [includeArchived],
    );
    return rows;
  });
}

async function messagesOf(c: Client, threadId: string): Promise<MessageRow[]> {
  const { rows } = await c.query<MessageRow>(
    `SELECT m.id, m.seq, m.role, m.body, m.written_at AS "writtenAt", m.written_by AS "writtenBy",
            m.input_tokens AS "inputTokens", m.output_tokens AS "outputTokens",
            -- ::float8 because node-postgres returns numeric as a string, to keep the precision a
            -- dollar figure does not need. A caller that wants to add two of these should not have
            -- to remember to parse them first.
            m.cost_usd::float8 AS "costUsd",
            coalesce(
              (SELECT json_agg(json_build_object(
                        'tool', tc.tool, 'arguments', tc.arguments,
                        'resultSummary', tc.result_summary,
                        -- ::text[] is load-bearing. node-postgres returns a scalar bigint as a
                        -- string, to avoid losing precision past 2^53 — but parses a bigint[] into
                        -- JavaScript numbers, which does not. Measured 11-Sep-2026: the same column
                        -- came back as ['7','9'] written and [7,9] read. Casting keeps one
                        -- representation across retrieval, the tool, this table and the screen.
                        'chunkIds', tc.chunk_ids::text[],
                        'durationMs', tc.duration_ms, 'error', tc.error)
                        ORDER BY tc.ord)
                 FROM chat_tool_calls tc WHERE tc.message_id = m.id),
              '[]'::json) AS "toolCalls"
       FROM chat_messages m
      WHERE m.thread_id = $1
      ORDER BY m.seq`,
    [threadId],
  );
  return rows;
}

export async function threadWithMessages(
  threadId: string,
): Promise<{ thread: ThreadRow; messages: MessageRow[] } | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<ThreadRow>(
      `SELECT id, title, created_at AS "createdAt", archived_at AS "archivedAt",
              0 AS messages, NULL::timestamptz AS "lastAt"
         FROM chat_threads WHERE id = $1`,
      [threadId],
    );
    const thread = rows[0];
    if (!thread) return null;
    return { thread, messages: await messagesOf(c, threadId) };
  });
}

/** A thread and its first message, together. A thread with no message has no name. */
export async function startThread(body: string, actorId: string): Promise<string> {
  const text = body.trim();
  if (!text) throw new EmptyMessage('A thread starts with a question.');
  const threadId = rowId();
  await writeTxn(actorId, async (c) => {
    await c.query(
      'INSERT INTO chat_threads (id, title, created_by) VALUES ($1,$2,$3)',
      [threadId, titleFrom(text), actorId],
    );
    await c.query(
      'INSERT INTO chat_messages (id, thread_id, seq, role, body, written_by) VALUES ($1,$2,1,$3,$4,$5)',
      [rowId(), threadId, 'person', text, actorId],
    );
  });
  return threadId;
}

export async function ask(threadId: string, body: string, actorId: string): Promise<void> {
  const text = body.trim();
  if (!text) throw new EmptyMessage('A question needs words.');
  await writeTxn(actorId, async (c) => {
    // `seq` is taken inside the transaction against a row the UNIQUE constraint will police, so two
    // people typing at once get an error rather than one message silently overwriting the other.
    const { rows } = await c.query<{ next: number }>(
      'SELECT coalesce(max(seq), 0) + 1 AS next FROM chat_messages WHERE thread_id = $1',
      [threadId],
    );
    const { rowCount } = await c.query('SELECT 1 FROM chat_threads WHERE id = $1', [threadId]);
    if (rowCount === 0) throw new UnknownThread(`no thread ${threadId}`);
    await c.query(
      'INSERT INTO chat_messages (id, thread_id, seq, role, body, written_by) VALUES ($1,$2,$3,$4,$5,$6)',
      [rowId(), threadId, rows[0]!.next, 'person', text, actorId],
    );
  });
}

export async function archiveThread(threadId: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE chat_threads SET archived_at = now() WHERE id = $1 AND archived_at IS NULL', [threadId]);
  });
}

/**
 * The transcript the model is sent, oldest dropped first until it fits both budgets.
 *
 * Tool calls are deliberately not replayed. What a past turn read is in `chat_tool_calls` for a
 * person to check; re-sending it would spend most of the budget on passages the model has already
 * drawn its conclusion from, and the conclusion is in the message.
 */
export function withinBudget(messages: MessageRow[]): MessageRow[] {
  const recent = messages.slice(-(MAX_TURNS * 2));
  let chars = 0;
  const kept: MessageRow[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i]!;
    if (chars + m.body.length > MAX_HISTORY_CHARS && kept.length > 0) break;
    chars += m.body.length;
    kept.unshift(m);
  }
  return kept;
}

/**
 * Whether a turn is being worked on this thread right now.
 *
 * Read from `agent_runs` rather than inferred from "the last message is a person's": a turn that
 * failed leaves a person's message last too, and the screen must not sit spinning on one forever.
 * A failed run is not pending — it is over, and `/agents` is where its reason lives.
 */
export async function turnInFlight(threadId: string): Promise<boolean> {
  return readTxn(async (c) => {
    const { rowCount } = await c.query(
      `SELECT 1 FROM agent_runs
        WHERE agent_key = 'desk-analyst' AND subject_ref = $1 AND status IN ('queued', 'running')`,
      [threadId],
    );
    return (rowCount ?? 0) > 0;
  });
}

/** Write the agent's message and the record of what it read, in one transaction. */
export async function recordAnswer(
  threadId: string, body: string, calls: ToolCallRow[], spend: Spend,
): Promise<string> {
  const messageId = rowId();
  await serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ next: number }>(
      'SELECT coalesce(max(seq), 0) + 1 AS next FROM chat_messages WHERE thread_id = $1',
      [threadId],
    );
    await c.query(
      `INSERT INTO chat_messages
         (id, thread_id, seq, role, body, written_by, input_tokens, output_tokens, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        messageId, threadId, rows[0]!.next, 'agent', body, 'system:agents',
        spend.inputTokens, spend.outputTokens, spend.costUsd,
      ],
    );
    // Written in the same transaction as the message they belong to. A message whose tool calls
    // failed to land would be an answer with no checkable account of what it was built from, which
    // §4.2 calls worse than an uncited one.
    for (const [ord, call] of calls.entries()) {
      await c.query(
        `INSERT INTO chat_tool_calls
           (id, message_id, ord, tool, arguments, result_summary, chunk_ids, duration_ms, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          rowId(), messageId, ord, call.tool, JSON.stringify(call.arguments),
          call.resultSummary, call.chunkIds, call.durationMs, call.error,
        ],
      );
    }
  });
  return messageId;
}
