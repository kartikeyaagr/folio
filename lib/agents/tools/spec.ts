/**
 * What a tool is, here.
 *
 * A tool is a **fixed, parameterised question** a person wrote, not SQL the model composes. The
 * model chooses which question and its scalar arguments; it never chooses the tables. That is what
 * makes `agents.data_scope` checkable: each tool declares the tables its statement touches, and
 * `tools.test.ts` asserts the declaration *equals* what the SQL actually names. Before R3,
 * `assertInScope` compared one hardcoded array against another and never saw a query.
 *
 * **Every tool runs on `ctx.reads`, a `readTxn`.** Postgres issues `BEGIN READ ONLY` and refuses a
 * write on it — containment by the database, not by convention or by a lint rule. `v4.md §9.3`
 * requires the ledger to be unreachable; this is how. `get_position` reads the book and there is
 * no tool that can write to it.
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
