/**
 * The system prompt, assembled in `v4.md §7`'s order — *"which is a decision and not a detail"*.
 *
 *     agents.purpose            what this agent is for. Static, changed by migration.
 *     approved prompt_rules     what we have learned to tell it. Human-approved, always.  — R6
 *     retrieved exemplars       work of this kind an analyst accepted, up to 3.
 *
 * **Ordered by authority**, from v2's runner: a retrieved example that contradicts an approved rule
 * should lose. R6 fills the middle block; the order exists here now so that landing it is an
 * insertion rather than a rewrite, and so the argument is recorded before there is anything to
 * argue about.
 *
 * **A flagged-off agent gets `purpose` and nothing else, byte for byte.** §7 gates *retrieval* on
 * `agents.learning`, not capture: acceptance writes an exemplar for every model-calling agent
 * regardless, so turning the flag on later finds a corpus already waiting rather than starting from
 * zero. Agents 1, 4 and 5 are off — 1 because a deterministic verifier is a better teacher than an
 * example, 4 and 5 because they call no model.
 */

import { retrieveExemplars, type Retrieved } from './exemplars.ts';
import type { AgentRow } from './runner.ts';

/**
 * Carried verbatim from v2 because it is doing real work.
 *
 * The last clause is the one that earns its place: an example is there to show the depth and the
 * shape of an acceptable answer, and a model handed a past draft full of figures will reach for
 * them. Every figure in this system has to come from the row it was read out of.
 */
export const EXEMPLAR_PREAMBLE =
  'Work of this kind that an analyst accepted previously. Match the depth and the judgement, not ' +
  'the wording, and never carry a figure across from an example.';

/** How an exemplar reads in the prompt. The situation first, because that is what was matched. */
function render(e: Retrieved, n: number): string {
  return [
    `--- example ${n} (${e.quality === 'edited' ? 'corrected by an analyst before acceptance' : 'accepted as written'}) ---`,
    `The situation: ${e.situation}`,
    'What was signed off:',
    JSON.stringify(e.output, null, 2),
  ].join('\n');
}

/**
 * Assemble the system prompt for one run.
 *
 * `situation` is the same line the draft will store, which is what makes retrieval and capture
 * agree: a run matches against past *inputs* and is later remembered by the inputs it had. It has
 * to be computed before the model call for that reason, which is why every handler now builds it
 * above `ctx.ask` rather than at draft-return.
 */
export async function systemFor(agent: AgentRow, situation: string): Promise<string> {
  if (!agent.learning) return agent.purpose;

  const examples = await retrieveExemplars(agent.key, situation);
  // Nothing retrieved is not an empty block: a heading with nothing under it reads as a mistake,
  // and on a fresh corpus that is every run for the first few weeks.
  if (examples.length === 0) return agent.purpose;

  return [
    agent.purpose,
    // R6 inserts approved prompt_rules here, above the examples and below the purpose.
    EXEMPLAR_PREAMBLE,
    ...examples.map((e, i) => render(e, i + 1)),
  ].join('\n\n');
}

/**
 * What the exemplar block costs, in characters.
 *
 * Exported because `tasks/todo.md` makes it a shipping condition — *"measure prompt tokens per
 * agent run with and without it, on the same questions, and record the number in the file"* — and a
 * number that is only ever printed by a script is a number nobody checks. A test asserts it instead.
 *
 * Characters, not tokens: counting Claude's tokens needs Claude. `ops/measure-exemplar-cost.ts`
 * prints the real figure through `count_tokens` when a credential exists.
 */
export async function exemplarCost(agent: AgentRow, situation: string): Promise<number> {
  const withExamples = await systemFor(agent, situation);
  return withExamples.length - agent.purpose.length;
}
