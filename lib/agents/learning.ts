/**
 * The evidence that the learning loop is working, or that it is not.
 *
 *   `v4.md §7` — **"If mean edit distance does not fall, the loop is not working and should be
 *   turned off."** Ground rule 3, applied to the stage that document is mostly about. v2 ran a
 *   clustering stage on a timer that its own measurement showed did nothing; this gets the same
 *   test and no exemption.
 *
 * Three questions, three queries, and the first is the one that decides whether the rest matter.
 *
 * **Every count here can legitimately be zero, and a zero is not the same as nothing to say.** An
 * agent with no accepted drafts has no mean distance — not a mean of 0 — so these return null and
 * `/agents` renders `<Blank why>`. The distinction is the whole reason this file exists rather
 * than three `coalesce(..., 0)` in the page.
 */

import { readTxn } from '../db.ts';

/** §7: three numbers, not one. A non-zero exemplar count on a non-learning agent reads as a bug. */
export interface Coverage {
  agentKey: string;
  label: string;
  /** Exemplars written. Acceptance writes one for every model-calling agent, learning or not. */
  held: number;
  /** Of those, how many an agent could actually retrieve: embedded, and its `learning` flag on. */
  retrievable: number;
  learning: boolean;
  model: string;
}

export async function coverage(): Promise<Coverage[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Coverage>(
      `SELECT a.key AS "agentKey", a.label, a.learning, a.model,
              count(e.id)::int AS held,
              -- Embedded AND retrievable by this agent. Until R5b nothing embeds, so this is 0 for
              -- everyone — which is the honest reading, not a placeholder.
              count(e.id) FILTER (WHERE e.embedding IS NOT NULL AND a.learning)::int AS retrievable
         FROM agents a
         LEFT JOIN exemplars e ON e.agent_id = a.key
        WHERE a.model <> 'none'
        GROUP BY a.key, a.label, a.learning, a.model
        ORDER BY a.key`,
    );
    return rows;
  });
}

export interface WeeklyDistance {
  agentKey: string;
  week: string;
  accepted: number;
  edited: number;
  rejected: number;
  /** Null when nothing was accepted that week. A mean over nothing is not zero. */
  meanDistance: number | null;
}

/**
 * Accept, edit and reject counts with the mean distance, by agent and week.
 *
 * The trend is the point, not the level: one week's number says nothing, and §7 asks whether it
 * **falls**. Weeks with no decisions do not appear — an absent row and a row of zeroes say
 * different things, and only one of them is true.
 */
export async function weeklyDistance(weeks = 12): Promise<WeeklyDistance[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<WeeklyDistance>(
      `SELECT agent_key AS "agentKey",
              to_char(date_trunc('week', decided_at), 'YYYY-MM-DD') AS week,
              count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
              -- "Edited" is a distance above zero, not a non-empty edits blob: a field replaced by
              -- an identical string is an edit that changed nothing, and should not count as one.
              count(*) FILTER (WHERE status = 'accepted' AND edit_distance > 0)::int AS edited,
              count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
              avg(edit_distance) FILTER (WHERE status = 'accepted')::float8 AS "meanDistance"
         FROM ai_drafts
        WHERE decided_at IS NOT NULL
          AND decided_at > now() - ($1 || ' weeks')::interval
        GROUP BY agent_key, date_trunc('week', decided_at)
        ORDER BY date_trunc('week', decided_at) DESC, agent_key`,
      [String(weeks)],
    );
    return rows;
  });
}

export interface FieldHotspot {
  agentKey: string;
  field: string;
  corrections: number;
}

/**
 * Which fields an agent keeps getting wrong.
 *
 *   §7 — *"'The analyst edited it' teaches nothing; 'they rewrote `guidance_delta` and left the
 *   other six fields alone, every quarter, for four quarters' is a prompt rule waiting to be
 *   written."*
 *
 * This is that sentence as a query, and it is the input R6's distillation reads. `jsonb_object_keys`
 * over `edits` gives one row per field a person actually changed, so a field nobody has ever
 * touched does not appear at all rather than appearing with a zero.
 */
export async function fieldHotspots(limit = 20): Promise<FieldHotspot[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<FieldHotspot>(
      `SELECT agent_key AS "agentKey", field, count(*)::int AS corrections
         FROM ai_drafts, jsonb_object_keys(edits) AS field
        WHERE status = 'accepted' AND edits IS NOT NULL AND edits <> '{}'::jsonb
        GROUP BY agent_key, field
        ORDER BY count(*) DESC, agent_key, field
        LIMIT $1`,
      [limit],
    );
    return rows;
  });
}
