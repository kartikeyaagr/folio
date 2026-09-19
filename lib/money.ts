/**
 * Money as an agent reads it.
 *
 * `CRORE` and this formatter were copied into `lib/agents/results.ts`, `lib/agents/tools/financials.ts`
 * and `lib/retrieval/register.ts`, and only one of the three carried the reasoning. All three feed a
 * model — two build a prompt, the third builds a corpus chunk — so a drift between them is a drift
 * in what the agents are told, which is the worst place in this tree for three copies of a rule.
 */

/** A crore is 10^7. The unit this fund thinks in. */
export const CRORE = 10_000_000;

/**
 * A figure in crore, or the words for its absence.
 *
 * **Never `0`.** House rule 4: an empty cell reads as broken, a dash reads as not-applicable, and a
 * zero reads as a measured fact — the most dangerous of the three. It matters here more than on a
 * screen, because AERON really does file `0.00` into every P&L element it does not report (lesson
 * L9), so a model that cannot tell "filed zero" from "did not file" will report the first as the
 * second.
 */
export const croreText = (v: string | null): string =>
  v === null ? 'not reported' : `${(Number(v) / CRORE).toFixed(1)} cr`;
