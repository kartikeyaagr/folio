/**
 * The tools an agent may be given, and the check that runs before it is given any of them.
 *
 * **Scope is asserted before the client is constructed and before a token is spent.** The union of
 * every declared `reads` goes through the same `assertInScope` the one-shot agents call, so an
 * agent whose registry row does not name `chunks` cannot be handed `search_corpus` — and the run
 * fails with a `ScopeViolation` naming the table, not with a model quietly answering from less
 * than it was asked to use.
 *
 * `v4.md §9.4` additionally wants the check before *every* call. Declaring `reads` per tool is what
 * makes that cheap rather than a second mechanism: once a tool is bound, every call it serves is
 * inside the scope that was checked, because the tool's statement is fixed and a person wrote it.
 *
 * **An unknown name raises.** Never a silently smaller toolset: an agent that was supposed to be
 * able to read the corpus and simply cannot is the most expensive kind of quiet failure, because
 * its answers still look like answers.
 */

import type { BetaRunnableTool } from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';

import { assertInScope, type AgentRow } from '../runner.ts';
import { spec as position } from './book.ts';
import { spec as corpus } from './corpus.ts';
import { spec as filings } from './filings.ts';
import { spec as financials } from './financials.ts';
import type { ToolContext, ToolSpec } from './spec.ts';

export class UnknownTool extends Error {}

/** Every tool that exists. R3's four are read-only; `run_agent` and `draft_document` are R4's. */
export const TOOLS: ReadonlyMap<string, ToolSpec> = new Map(
  [corpus, financials, position, filings].map((s) => [s.name, s]),
);

function specsFor(names: string[]): ToolSpec[] {
  return names.map((n) => {
    const spec = TOOLS.get(n);
    if (!spec) {
      throw new UnknownTool(`${n} is not a tool; known tools are ${[...TOOLS.keys()].join(', ')}`);
    }
    return spec;
  });
}

/** Every table the named tools read, deduplicated. Exported so a migration's scope can be checked. */
export function toolReads(names: string[]): string[] {
  return [...new Set(specsFor(names).flatMap((s) => s.reads))].sort();
}

export function bindTools(agent: AgentRow, names: string[], ctx: ToolContext): BetaRunnableTool[] {
  const specs = specsFor(names);
  assertInScope(agent, toolReads(names));
  return specs.map((s) => s.build(ctx));
}

export type { ToolCall, ToolContext, ToolSpec } from './spec.ts';
