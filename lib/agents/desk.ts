/**
 * Agent 8 — the desk analyst, as a queue handler.
 *
 * A chat turn is a run in `agent_runs` like everything else, and that is the whole reason this file
 * exists rather than the server action calling `takeTurn` directly. Being a run buys four things
 * the web process cannot provide on its own: a lease, so a turn interrupted by a deploy is picked
 * up again rather than lost; `MAX_ATTEMPTS`, so one that keeps dying stops; a named `failure_kind`
 * on `/agents`; and one place that answers "what has this system spent money on".
 *
 * The run is claimed immediately by the action that enqueued it (`runNow`), because a person is
 * sitting there and the five-minute timer is not an answer. Losing that race is fine — whoever
 * claimed it finishes it.
 *
 * **`ctx.ask` is deliberately unused.** The runner hands every handler the one-shot `Model`;
 * `takeTurn` needs a `ToolModel`, which is a different shape and a different file. Rather than
 * widen `RunContext` for one agent, the tool loop is reached through `takeTurn`'s own injectable
 * parameter — which is also what lets `chat.test.ts` script tool turns.
 */

import { takeTurn } from '../chat/turn.ts';
import { registerHandler, type HandlerResult, type RunContext } from './runner.ts';

export const KEY = 'desk-analyst';

registerHandler(KEY, async (ctx: RunContext): Promise<HandlerResult> => {
  // The thread is the subject. Without one there is nothing to answer, and a run that invented an
  // empty thread would write an agent message into a conversation nobody started.
  if (!ctx.subjectRef) throw new Error('a desk-analyst run must name the thread it is answering');

  // Scope is asserted inside `takeTurn`, by `bindTools`, before a client is constructed — so an
  // agent row whose data_scope no longer covers its tools fails here without spending anything.
  //
  // The run id goes with the thread because `draft_document` hangs an `ai_drafts` row on it, and
  // `ai_drafts.run_id` is NOT NULL. This is the payoff for R3's decision to make a chat turn a
  // queued run rather than a bare function call: the write path needed a run and there already was
  // one.
  await takeTurn(ctx.subjectRef, ctx.runId);

  // No draft. A chat answer is a message in a thread, not a thing in the review queue; turning one
  // into a document is `draft_document`, which is R4's.
  return { done: true };
});
