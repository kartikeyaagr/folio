/**
 * What a tool is, here.
 *
 * A tool is a **fixed, parameterised question** a person wrote, not SQL the model composes. The
 * model chooses which question and its scalar arguments; it never chooses the tables. That is what
 * makes `agents.data_scope` checkable: each tool declares the tables its statement touches, and
 * `tools.test.ts` asserts the declaration *equals* what the SQL actually names. Before R3,
 * `assertInScope` compared one hardcoded array against another and never saw a query.
 *
 * **Reads run on `ctx.reads`, a `readTxn`.** Postgres issues `BEGIN READ ONLY` and refuses a write
 * on it — containment by the database, not by convention or by a lint rule.
 *
 * **Two tools write, and only into the gate.** R4 added `run_agent` and `draft_document`. Until
 * then this header said *every* tool ran read-only, and leaving that sentence here would be the
 * worst outcome available: a header reassuring a reader about a property the file no longer has.
 * What is true now is `v4.md §9.2`, and it is a narrower claim carried by three things rather than
 * one:
 *
 *   * a writing tool touches exactly `agent_runs` (a queued run) or `ai_drafts` (a row with
 *     `status = 'pending'`). **Neither publishes.** Injected text can at worst cause a draft a
 *     person then rejects, or a run whose own output lands in the same queue;
 *   * each tool declares the tables it writes, and `tools.test.ts` asserts the whole set is those
 *     two — so a third write tool cannot be added without this argument being revisited;
 *   * `agents.data_scope` must name them, checked before the model is called.
 *
 * **The ledger is still unreachable**, and for a better reason than the transaction being
 * read-only: no tool's SQL names `transactions`, `cash_ledger`, `holdings` or `tax_lots` for
 * writing, and a review gate on `ai_drafts` would not have protected a `transactions` row anyway,
 * because a trade is not a draft. `get_position` reads the book; nothing can write to it.
 *
 * **Every call is recorded before its result reaches the model.** `chat_tool_calls` is the
 * transparency surface `v4.md §4.2` calls "not optional" — *"You can always see what it read."*
 * Recording lives in `served()` rather than in each tool, so a tool cannot be written that forgets.
 */

import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

import type { Client } from '../../db.ts';
import type { Reads } from '../runner.ts';

/** One row of `chat_tool_calls`, handed up as the call finishes. */
export interface ToolCall {
  tool: string;
  arguments: Record<string, unknown>;
  resultSummary: string;
  chunkIds: string[];
  durationMs: number;
  error: string | null;
}

export interface ToolContext {
  reads: Reads;
  /**
   * Pins the subject when the run is about one company, overriding anything the model names.
   *
   * Null for chat, whose threads are not company-scoped (`v4.md §4.2` puts no company on
   * `chat_threads`), so there the model names a company and `resolveSubject` resolves it against
   * `companies` — which is itself the containment: only names the fund follows exist to be named.
   */
  companyId: string | null;
  /**
   * What a writing tool needs to attribute what it writes. Absent means no tool here writes.
   *
   * One optional field rather than four, so that "this context can write" is a single readable
   * condition instead of a handful of undefined checks that can disagree with each other.
   *
   * `ai_drafts.run_id` is `NOT NULL REFERENCES agent_runs`, so a draft cannot exist without a run —
   * and a chat turn already has one, because R3 made every turn a queued run rather than a bare
   * function call. That decision is what lets `draft_document` write a draft at all.
   *
   * `cited()` returns the chunks read so far in this turn, so a draft arrives at `/review` with its
   * "Built from" list populated like every other draft rather than empty, which the review screen
   * correctly calls out as *"worth asking about"*.
   */
  turn?: {
    runId: string;
    threadId: string;
    model: string;
    /** The turn's situation line, assembled upstream so retrieval and capture agree on it. */
    situation: string;
    cited: () => string[];
  };
  /** Where a finished call goes. Supplied by the chat layer; absent in a test that does not care. */
  record?: (call: ToolCall) => void;
}

/** What a tool's own body returns. `served` turns it into the string the model sees. */
export interface ToolOutput {
  text: string;
  /** The chunks this call returned, for `chat_tool_calls.chunk_ids`. Retrieval only. */
  chunkIds?: string[];
}

export interface ToolSpec {
  name: string;
  /** Tables the SQL behind this tool names. Asserted against the SQL itself in `tools.test.ts`. */
  reads: string[];
  /**
   * Tables this tool writes, if any. Empty for a reading tool, and empty is the normal case.
   *
   * Declared rather than inferred so that the set across all tools is a checkable fact: the whole
   * containment argument in this file's header rests on it being exactly `agent_runs` and
   * `ai_drafts`, and a test asserts that. A tool that writes anywhere else has to change the test,
   * which is the point — it forces the argument to be made again rather than quietly weakened.
   */
  writes?: string[];
  build(ctx: ToolContext): BetaRunnableTool;
}

/**
 * Run a tool body, record what it did, and hand the model the text.
 *
 * A thrown error is recorded and rethrown: the runner turns it into an `is_error` tool result, and
 * the row keeps the reason. A call that failed must not look like a call that found nothing —
 * house rule 2, in the one place a model would otherwise be told they were the same thing.
 */
export async function served(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  run: () => Promise<ToolOutput>,
): Promise<string> {
  const started = Date.now();
  try {
    const out = await run();
    ctx.record?.({
      tool, arguments: args,
      resultSummary: out.text.slice(0, 500),
      chunkIds: out.chunkIds ?? [],
      durationMs: Date.now() - started,
      error: null,
    });
    return out.text;
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    ctx.record?.({
      tool, arguments: args, resultSummary: '', chunkIds: [],
      durationMs: Date.now() - started, error: message,
    });
    throw err;
  }
}

export interface Subject {
  id: string;
  symbol: string;
  name: string;
}

/** Refused, with the reason the model is told. Not an exception: this is an ordinary answer. */
export type Resolved = { ok: true; company: Subject } | { ok: false; why: string };

/**
 * Which company a call is about.
 *
 * Only rows in `companies` resolve, which is the boundary: an instruction smuggled into a filing
 * can name any symbol it likes, and a symbol the fund does not follow does not exist to be read.
 */
export async function resolveSubject(ctx: ToolContext, symbol?: string): Promise<Resolved> {
  return ctx.reads(async (c: Client) => {
    if (ctx.companyId !== null) {
      const { rows } = await c.query<Subject>(
        'SELECT id, symbol, name FROM companies WHERE id = $1', [ctx.companyId],
      );
      const company = rows[0];
      if (!company) return { ok: false, why: `this run names a company that no longer exists` };
      // A pinned run is about one company. Saying so is better than silently reading a different
      // one than the model asked for, which would make a wrong answer look like a right one.
      if (symbol && symbol.toUpperCase() !== company.symbol.toUpperCase()) {
        return {
          ok: false,
          why: `this run is about ${company.symbol}, not ${symbol}; ${symbol} cannot be read here`,
        };
      }
      return { ok: true, company };
    }
    if (!symbol) return { ok: false, why: 'name a company by its symbol' };
    const { rows } = await c.query<Subject>(
      'SELECT id, symbol, name FROM companies WHERE upper(symbol) = upper($1)', [symbol],
    );
    const company = rows[0];
    return company
      ? { ok: true, company }
      : { ok: false, why: `no company with symbol ${symbol} is followed here` };
  });
}

/** `betaTool`, re-exported so a tool file has one import for everything it needs. */
export { betaTool };
