/**
 * The system prompt, assembled in `v4.md §7`'s order — *"which is a decision and not a detail"*.
 *
 *     agents.purpose            what this agent is for. Static, changed by migration.
 *     approved prompt_rules     what we have learned to tell it. Human-approved, always.
 *     retrieved exemplars       work of this kind an analyst accepted, up to 3.
 *
 * **Ordered by authority**, from v2's runner: a retrieved example that contradicts an approved rule
 * should lose, and the rule preamble says so in words as well as in position.
 *
 * **`agents.learning` gates the examples and not the rules**, which is the one place this file
 * departs from a literal reading of §7. The flag exists because retrieval is a *guess* — the
 * nearest three situations, with no relevance floor under them (§5.4) — and some agents should not
 * be guessed at. An approved rule is not a guess; it is a sentence a person wrote and a second
 * person signed. Gating it on the flag would make §7 part 4 useless for exactly the agent most
 * likely to need a standing rule: agent 1, whose flag is off because a deterministic verifier is a
 * better teacher than an example, not because nobody should be able to tell it anything.
 *
 * Capture is likewise ungated: acceptance writes an exemplar for every model-calling agent, so
 * turning the flag on later finds a corpus already waiting rather than starting from zero.
 */

import { retrieveExemplars, type Retrieved } from './exemplars.ts';
import { approvedRules } from './rules.ts';
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

/**
 * The rules block's heading.
 *
 * The second sentence is the prompt order stated out loud. Position alone carries the precedence
 * argument only if the model reads it that way, and a contradiction between a signed rule and a
 * retrieved example is exactly the case where being explicit is cheap.
 */
export const RULE_PREAMBLE =
  'Standing rules, approved by the desk. Where one of these and an example below disagree, the ' +
  'rule wins.';

/** How an exemplar reads in the prompt. The situation first, because that is what was matched. */
function render(e: Retrieved, n: number): string {
  return [
    `--- example ${n} (${e.quality === 'edited' ? 'corrected by an analyst before acceptance' : 'accepted as written'}) ---`,
    `The situation: ${e.situation}`,
    'What was signed off:',
    JSON.stringify(e.output, null, 2),
  ].join('\n');
}

/** The three blocks, each either its text or empty. Empty blocks are dropped, never rendered. */
export interface PromptParts {
  purpose: string;
  rules: string;
  examples: string;
}

/**
 * Build the blocks for one run.
 *
 * `situation` is the same line the draft will store, which is what makes retrieval and capture
 * agree: a run matches against past *inputs* and is later remembered by the inputs it had. It has
 * to be computed before the model call for that reason, which is why every handler builds it above
 * `ctx.ask` rather than at draft-return.
 */
export async function promptParts(agent: AgentRow, situation: string): Promise<PromptParts> {
  const [rules, examples] = await Promise.all([
    approvedRules(agent.key),
    agent.learning ? retrieveExemplars(agent.key, situation) : Promise.resolve([]),
  ]);

  return {
    purpose: agent.purpose,
    // Numbered, because a rule is referred to in conversation as "the third one" and because an
    // unnumbered list of imperatives reads as one paragraph to skim.
    rules: rules.length === 0 ? '' : [RULE_PREAMBLE, ...rules.map((r, i) => `${i + 1}. ${r}`)].join('\n'),
    // Nothing retrieved is not an empty block: a heading with nothing under it reads as a mistake,
    // and on a fresh corpus that is every run for the first few weeks.
    examples:
      examples.length === 0 ? '' : [EXEMPLAR_PREAMBLE, ...examples.map((e, i) => render(e, i + 1))].join('\n\n'),
  };
}

/** The blocks that have something in them, in §7's order, separated by a blank line. */
function assemble(parts: PromptParts): string {
  return [parts.purpose, parts.rules, parts.examples].filter((b) => b !== '').join('\n\n');
}

/** Assemble the system prompt for one run. */
export async function systemFor(agent: AgentRow, situation: string): Promise<string> {
  return assemble(await promptParts(agent, situation));
}

/**
 * What each block costs, in characters.
 *
 * Exported because `tasks/todo.md` makes it a shipping condition — *"measure prompt tokens per
 * agent run with and without it, on the same questions, and record the number in the file"* — and a
 * number that is only ever printed by a script is a number nobody checks. A test asserts it instead.
 *
 * Measured as assembled-with minus assembled-without, so it includes the blank line the block
 * brings with it and so the figures stay comparable across this refactor. Characters, not tokens:
 * counting Claude's tokens needs Claude, and `ops/measure-prompt-cost.ts` prints the real figure
 * through `count_tokens` when a credential exists.
 */
async function costOf(agent: AgentRow, situation: string, block: keyof PromptParts): Promise<number> {
  const parts = await promptParts(agent, situation);
  return assemble(parts).length - assemble({ ...parts, [block]: '' }).length;
}

export const exemplarCost = (agent: AgentRow, situation: string): Promise<number> =>
  costOf(agent, situation, 'examples');

export const ruleCost = (agent: AgentRow, situation: string): Promise<number> =>
  costOf(agent, situation, 'rules');
