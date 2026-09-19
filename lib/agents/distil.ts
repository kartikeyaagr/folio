/**
 * Recurring corrections become candidate rules.
 *
 * `v4.md §7` part 3, and the constraint it puts on this file is the whole design:
 *
 * > *"Purely mechanical — **no model summarises the edits**. A candidate rule that a person has to
 * > evaluate must be traceable to the rows it came from. A generated paragraph reads better and
 * > cannot be checked."*
 *
 * So nothing here writes a rule. It counts corrections, measures them, and raises a **finding** —
 * one sentence of arithmetic — against the field that keeps moving. The rule itself is typed by a
 * person reading the three corrections, and `prompt_rules_approved_has_text` makes that a schema
 * property rather than a habit.
 *
 * **The queue is "which corrections has no rule accounted for yet".** House rule 3, and here it is
 * enforced by `rule_observations`' primary key rather than by this query remembering to be careful:
 * a `(draft, field)` pair belongs to at most one rule, ever. That is what makes refusing a
 * candidate meaningful — its observations stay spent, so the same three cannot raise it again, and
 * three fresh corrections can. A watermark or a rolling window would do neither.
 */

import { fieldDistance } from './distance.ts';
import { rowId, serviceTxn, type Client } from '../db.ts';

/**
 * v2's measured defaults, carried unchanged.
 *
 * `MIN_DISTANCE` is what a correction has to be worth to count as one: below it, somebody fixed a
 * comma. `MIN_OBSERVATIONS` is how many unaccounted ones on the same field raise a candidate —
 * §7's own example is *"they rewrote `guidance_delta` and left the other six fields alone, every
 * quarter, for four quarters"*, and three is the point at which that stops being a coincidence.
 */
export const MIN_OBSERVATIONS = 3;
export const MIN_DISTANCE = 0.25;


/**
 * The grouping key for one `(agent, field)` pair.
 *
 * `JSON.stringify` rather than `${agent} ${field}`, because `field` is a jsonb object key taken
 * from `ai_drafts.edits` and jsonb keys may contain anything at all, spaces included. A separator
 * a key can contain is a separator that can collide two different fields into one candidate.
 */
const key = (agent: string, field: string): string => JSON.stringify([agent, field]);

interface Correction {
  draft_id: string;
  agent_key: string;
  /** Where this correction happened: `by_company[2].why_it_matters`. Stored on the observation. */
  field: string;
  /** What it was a correction *to*: `by_company[].why_it_matters`. What a rule is written about. */
  shape: string;
  from: unknown;
  to: unknown;
}

/** A correction, scored. */
interface Observation extends Correction {
  distance: number;
}

/**
 * Corrections no rule has accounted for.
 *
 * `edits` is `{ field: { from, to } }` — see `diffFields` in `review.ts`. `jsonb_each` gives one
 * row per changed field, the same unpacking `fieldHotspots()` does with `jsonb_object_keys`, and
 * the `NOT EXISTS` is the whole watermark.
 */
async function unaccounted(c: Client): Promise<Correction[]> {
  const { rows } = await c.query<Correction>(
    `SELECT d.id AS draft_id, d.agent_key, e.key AS field, edit_field(e.key) AS shape,
            e.value -> 'from' AS "from", e.value -> 'to' AS "to"
       FROM ai_drafts d, jsonb_each(d.edits) AS e
      WHERE d.status = 'accepted'
        AND d.edits IS NOT NULL AND d.edits <> '{}'::jsonb
        AND NOT EXISTS (
              SELECT 1 FROM rule_observations o
               WHERE o.draft_id = d.id AND o.field = e.key)
      ORDER BY d.decided_at`,
  );
  return rows;
}

/**
 * The finding, and nothing more than this.
 *
 * Every number in it was measured by the line above it. It says what happened and declines to say
 * what it means, which is the reader's job and the reason this is not a sentence a model wrote.
 */
export function finding(field: string, os: Observation[]): string {
  const mean = os.reduce((sum, o) => sum + o.distance, 0) / os.length;
  const n = os.length;
  const drafts = new Set(os.map((o) => o.draft_id)).size;
  // Both numbers, because they are no longer the same number. A brief has many positions of one
  // field, so nine corrections across three drafts and nine across one are different evidence —
  // the second is one analyst working one document, which is not a pattern.
  //
  // No backticks around the field name: this string is stored, and it is read both in a terminal
  // and inside a <p> on /rules, where markdown it cannot render shows up as two stray marks.
  return (
    `${n} correction${n === 1 ? '' : 's'} across ${drafts} draft${drafts === 1 ? '' : 's'} ` +
    `to ${field}, mean distance ${mean.toFixed(2)}. ` +
    'Nothing here is a rule yet — read the corrections and write one, or refuse it and say why.'
  );
}

/** `(agent, field)` pairs already waiting on somebody. */
async function alreadyOpen(c: Client): Promise<Set<string>> {
  // `edit_field` on this side too. `rule_observations.field` stores the concrete position — /rules
  // needs it to look the correction up in `edits` — while the guard below is about the field, so
  // comparing the two raw would never match for anything nested and every pass would raise the
  // same candidate again. Exactly what this file forbids two functions down.
  const { rows } = await c.query<{ agent_id: string; field: string }>(
    `SELECT DISTINCT r.agent_id, edit_field(o.field) AS field
       FROM prompt_rules r JOIN rule_observations o ON o.rule_id = r.id
      WHERE r.status = 'candidate'`,
  );
  return new Set(rows.map((r) => key(r.agent_id, r.field)));
}

export interface Distillation {
  /** Unaccounted corrections looked at, whatever they scored. */
  considered: number;
  /** Of those, the ones worth `MIN_DISTANCE` or more. */
  observed: number;
  /** Candidates created. Zero is the ordinary outcome — see the job's header. */
  raised: number;
}

/**
 * One pass. Safe to run as often as you like: a correction it attaches to a rule is a correction
 * it will never look at again.
 */
export async function distil(): Promise<Distillation> {
  return serviceTxn('system:agents', async (c) => {
    const corrections = await unaccounted(c);

    // A comma somebody fixed is not evidence of anything. Scoring happens here rather than in SQL
    // because word-level Levenshtein lives in TypeScript, and `ai_drafts.edit_distance` cannot
    // help: that column is the mean over every field in the draft, including the untouched ones.
    const observations = corrections
      .map((r) => ({ ...r, distance: fieldDistance(r.from, r.to) }))
      .filter((o) => o.distance >= MIN_DISTANCE);

    const groups = new Map<string, Observation[]>();
    for (const o of observations) {
      const k = key(o.agent_key, o.shape);
      groups.set(k, [...(groups.get(k) ?? []), o]);
    }

    const open = await alreadyOpen(c);
    let raised = 0;

    for (const [k, os] of groups) {
      // Distinct DRAFTS, not distinct corrections. §7's pattern is "every quarter, for four
      // quarters" — something that recurs across the agent's work. Before a correction could reach
      // inside a draft, one draft could only ever contribute one correction per field and the two
      // counts were the same number; now a single brief can carry twenty, and three of those is
      // one analyst having a careful morning.
      if (new Set(os.map((o) => o.draft_id)).size < MIN_OBSERVATIONS) continue;
      // One candidate per field at a time. Two open candidates for `guidance_delta` would ask the
      // same person the same question twice, and the second would be answered by the first.
      if (open.has(k)) continue;

      const ruleId = rowId();
      await c.query(
        `INSERT INTO prompt_rules (id, agent_id, origin, finding, status)
         VALUES ($1, $2, 'distilled', $3, 'candidate')`,
        // The shape, not one position: a candidate is a question about `by_company[].why_it_matters`
        // and never about the third company in one particular week's brief.
        [ruleId, os[0]!.agent_key, finding(os[0]!.shape, os)],
      );
      // Every unaccounted observation in the group, not just the first three: they are all evidence
      // for the same finding, and leaving the extras loose would raise a duplicate next run.
      for (const o of os) {
        await c.query(
          'INSERT INTO rule_observations (rule_id, draft_id, field, distance) VALUES ($1,$2,$3,$4)',
          [ruleId, o.draft_id, o.field, o.distance.toFixed(3)],
        );
      }
      raised++;
    }

    return { considered: corrections.length, observed: observations.length, raised };
  });
}
