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
import { spec as draftDocument } from './draft.ts';
import { spec as filings } from './filings.ts';
import { spec as financials } from './financials.ts';
import { spec as runAgent } from './queue-run.ts';
import type { ToolContext, ToolSpec } from './spec.ts';

export class UnknownTool extends Error {}

/** Every tool that exists. Four read; two write, and only into the review queue. */
export const TOOLS: ReadonlyMap<string, ToolSpec> = new Map(
  [corpus, financials, position, filings, runAgent, draftDocument].map((s) => [s.name, s]),
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

/**
 * Every table the named tools **touch**, read or written, deduplicated.
 *
 * Writes are included because `data_scope` is the answer to "what runs unattended, over what data",
 * and a table an agent writes is emphatically part of that answer. The name is kept from R3 — it
 * pairs with `assertInScope`, which has always compared against `data_scope` as a whole.
 * Exported so a migration's seed can be checked against it.
 */
export function toolReads(names: string[]): string[] {
  return [...new Set(specsFor(names).flatMap((s) => [...s.reads, ...(s.writes ?? [])]))].sort();
}

/**
 * Every table the named tools write, deduplicated.
 *
 * The whole containment argument in `spec.ts` rests on this set being exactly `agent_runs` and
 * `ai_drafts`, so it is a function rather than a comment and `tools.test.ts` asserts it.
 */
export function toolWrites(names: string[]): string[] {
  return [...new Set(specsFor(names).flatMap((s) => s.writes ?? []))].sort();
}

export function bindTools(agent: AgentRow, names: string[], ctx: ToolContext): BetaRunnableTool[] {
  const specs = specsFor(names);
  assertInScope(agent, toolReads(names));
  return specs.map((s) => s.build(ctx));
}

export type { ToolCall, ToolContext, ToolSpec } from './spec.ts';
