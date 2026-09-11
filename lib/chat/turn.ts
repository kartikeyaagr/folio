/**
 * One turn: read the thread, let the agent go and look, write what it found.
 *
 * The system prompt is assembled in `v4.md §7`'s order, which is a decision and not a detail:
 *
 *     agents.purpose          what this agent is for. Static, changed by migration.
 *     approved prompt_rules   what we have learned to tell it.       — R6, not built
 *     retrieved exemplars     work of this kind an analyst accepted. — R5, not built
 *
 * Ordered by authority, so a retrieved example that contradicts an approved rule loses. R3 has
 * only the first block, and the order exists here already so that adding the other two is an
 * insertion rather than a rewrite.
 *
 * **Nothing here writes to the record.** The agent's message is a message in a thread. Turning one
 * into a document is `draft_document`, which is R4's, and it lands in `/review` like every other
 * draft. Chat becomes how you ask; it does not become where the answer is filed.
 */

import { readTxn } from '../db.ts';
import { liveToolModel, type ToolModel } from '../agents/loop.ts';
import { bindTools, type ToolCall } from '../agents/tools/index.ts';
import { systemFor } from '../agents/prompt.ts';
import type { AgentRow } from '../agents/runner.ts';
import { recordAnswer, threadWithMessages, withinBudget, UnknownThread, type MessageRow, type Spend } from './threads.ts';

export const AGENT_KEY = 'desk-analyst';

/**
 * A ceiling on one turn, enforced client-side.
 *
 * Chat is not queued in R3, so there is no claim lease to sit inside — the ceiling is here instead.
 * Eight round trips at `xhigh` over a long annual report is minutes, legitimately; twelve is a loop
 * that has stopped making progress and is still being billed.
 */
export const TURN_TIMEOUT_MS = 8 * 60_000;

export class NoSuchAgent extends Error {}

/**
 * What the model must return.
 *
 * `could_not_find` is required and is the point of the schema. §6.4: when retrieval returns nothing
 * that answers the question, the answer is that nothing held answers it — v2's desk analyst had
 * exactly this refusal and it is the reason the thing was trusted. A required field is harder to
 * skip than an instruction.
 */
export const ANSWER_SCHEMA = {
  type: 'object',
  required: ['answer', 'citations', 'could_not_find'],
  properties: {
    answer: {
      type: 'string',
      description:
        'The answer, in prose, for someone who knows the business. Mark each claim drawn from a ' +
        'passage with its chunk in square brackets, like [chunk 4812], placed at the end of the ' +
        'sentence it supports.',
    },
    citations: {
      type: 'array',
      description: 'One entry per chunk cited above. Empty only if the answer cites nothing.',
      items: {
        type: 'object',
        required: ['chunk_id', 'supports'],
        properties: {
          chunk_id: { type: 'string', description: 'The number from the [chunk N] marker.' },
          supports: { type: 'string', description: 'The claim it supports, in a few words.' },
        },
      },
    },
    could_not_find: {
      type: 'array',
      description:
        'Things you looked for and did not find, in plain words. An empty list means you found ' +
        'everything the question needed — say so only if it is true.',
      items: { type: 'string' },
    },
  },
} as const;

async function loadAgent(key: string): Promise<AgentRow> {
  const agent = await readTxn(async (c) => {
    const { rows } = await c.query<AgentRow>(
      `SELECT key, label, purpose, model, effort, data_scope, tools, learning, notify_on_draft
         FROM agents WHERE key = $1 AND enabled`,
      [key],
    );
    return rows[0] ?? null;
  });
  if (!agent) throw new NoSuchAgent(`${key} is not an enabled agent`);
  return agent;
}

/** The thread so far, as one prompt. Roles are labelled so the model can tell who said what. */
function transcript(messages: MessageRow[]): string {
  return messages
    .map((m) => `${m.role === 'person' ? 'THE DESK' : 'YOU'}: ${m.body}`)
    .join('\n\n');
}

/** Prose, then what it was built from, then what it could not find. */
export function render(content: Record<string, unknown>): string {
  const answer = String(content['answer'] ?? '').trim();
  const citations = Array.isArray(content['citations']) ? content['citations'] : [];
  const missing = Array.isArray(content['could_not_find']) ? content['could_not_find'] : [];

  const parts = [answer];
  if (citations.length > 0) {
    const lines = citations.map((raw) => {
      const c = raw as { chunk_id?: unknown; supports?: unknown };
      return `- [chunk ${String(c.chunk_id)}] ${String(c.supports)}`;
    });
    parts.push(`Built from\n${lines.join('\n')}`);
  }
  // Rendered even when empty is wrong, and rendered only when non-empty is right: "I found
  // everything" and "I did not look" must not produce the same screen.
  if (missing.length > 0) {
    parts.push(`Could not find\n${missing.map((m) => `- ${String(m)}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

export interface TurnResult extends Spend {
  messageId: string;
  calls: number;
}

/**
 * Answer the thread's latest question.
 *
 * `ask` is injectable for the same reason `Model` is in the one-shot path: every model-calling
 * agent in this tree has only ever been tested against a scripted one, and this is the first that
 * can also be tested against scripted *tool* turns.
 */
export async function takeTurn(
  threadId: string,
  runId: string,
  ask: ToolModel = liveToolModel,
): Promise<TurnResult> {
  const found = await threadWithMessages(threadId);
  if (!found) throw new UnknownThread(`no thread ${threadId}`);

  const agent = await loadAgent(AGENT_KEY);
  const history = withinBudget(found.messages);

  // What this agent saw, and the one line a future question is matched against. The question as the
  // desk put it — the thread's title is its opening message.
  //
  // It used to also carry how many passages the turn read, which was wrong twice over: that number
  // is not known until the turn has finished, so retrieval could never use it, and it is an outcome
  // rather than an input, which is not what §4.3 asks a situation to describe.
  const situation = `Desk question: "${found.thread.title}"`;

  // Collected as the loop runs, written with the message it belongs to. A call that happened and
  // was not recorded would leave an answer whose provenance cannot be checked.
  const calls: ToolCall[] = [];
  const tools = bindTools(agent, agent.tools, {
    reads: readTxn,
    companyId: null, // §4.2 puts no company on a thread: the model names one, and only followed names resolve.
    record: (call) => calls.push(call),
    turn: {
      // The run this turn is already claimed under. `ai_drafts.run_id` is NOT NULL, so a draft
      // proposed mid-turn hangs on it — which only works because R3 made a turn a queued run.
      runId,
      threadId,
      model: agent.model,
      // The thread is already loaded here, so a tool that needs the question does not have to go
      // and read `chat_threads` for itself — which would also widen agent 8's data_scope to a
      // table it has no other business in.
      situation,
      // Read at call time, not captured: a draft proposed after four searches should cite four
      // searches' worth of passages, not the none that had been read when the tools were bound.
      cited: () => [...new Set(calls.flatMap((c) => c.chunkIds))],
    },
  });

  const timeout = AbortSignal.timeout(TURN_TIMEOUT_MS);
  const answer = await ask({
    model: agent.model,
    ...(agent.effort ? { effort: agent.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' } : {}),
    system: await systemFor(agent, situation),
    task: transcript(history),
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    tools,
    signal: timeout,
  });

  // A failure still becomes a message, and says which failure it was. A turn that silently left no
  // reply would be indistinguishable from one nobody had asked yet — and the tool calls it already
  // paid for would be orphaned, so they are written either way.
  const body = answer.ok
    ? render(answer.content)
    : `I could not finish this one — ${answer.kind}: ${answer.detail}`;

  // Nulls, not zeros, when the turn did not reach an answer. A failed turn really did spend
  // tokens — `askWithTools` counts them and then drops them, because `Answer`'s failure branch has
  // nowhere to carry them. Recording a zero would turn "we do not know" into "it was free", which
  // is the exact lie D5 exists to prevent. Worth widening `Answer` next time it is touched.
  const spend: Spend = answer.ok
    ? { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, costUsd: answer.costUsd }
    : { inputTokens: null, outputTokens: null, costUsd: null };

  const messageId = await recordAnswer(threadId, body, calls, spend);
  return { messageId, calls: calls.length, ...spend };
}

