/**
 * The corpus the learning loop learns from.
 *
 * One row per accepted draft: the situation the agent saw, what a person actually signed off, and
 * how far apart those two were. `v4.md §7` stakes the loop on that last number — *"If mean edit
 * distance does not fall, the loop is not working and should be turned off."*
 *
 * R5b adds the other half of this file: embedding the situations, and retrieving the nearest few
 * into the prompt of an agent whose `learning` flag is on.
 */

import { randomBytes } from 'node:crypto';
import type { Client } from '../db.ts';

const id = (): string => randomBytes(16).toString('hex');

/** Just enough of the draft to write its exemplar. Shaped by `lockDraft` in `review.ts`. */
export interface AcceptedDraft {
  id: string;
  agent_key: string;
  company_id: string | null;
  situation: string | null;
}

/**
 * What was signed off becomes an exemplar, inside the acceptance transaction.
 *
 * The **embedding does not** — `exemplars_unembedded_idx` is the queue and the indexer drains it.
 * Carried from v2's reasoning about acceptance, which applies unchanged: *"an analyst clicking
 * accept must not wait on a model load, and a failure there must not cost them the acceptance."*
 *
 * Written for **every** model-calling agent, whether or not it learns. §7 keeps that quirk on
 * purpose: the `learning` flag gates retrieval, so turning it on for an agent later finds a corpus
 * already waiting rather than starting from zero. Agents 4 and 5 never reach here — they return
 * `{ done: true }` and write no draft at all, so every row in `ai_drafts` came from a model.
 *
 * Rejections are not exemplars: *"a rejection says what was wrong without ever saying what right
 * would have looked like, so it steers distillation and stays out of here."*
 */
export async function recordExemplar(
  c: Client,
  draft: AcceptedDraft,
  final: Record<string, unknown>,
  distance: number,
): Promise<void> {
  // Every draft written before R5a has no situation, because no handler produced one. Writing an
  // exemplar with a fabricated situation would be worse than writing none: it would match nothing
  // in particular, and later be indistinguishable from one an agent actually wrote.
  if (draft.situation === null) return;

  let vertical: string | null = null;
  if (draft.company_id !== null) {
    const { rows } = await c.query<{ sector: string | null }>(
      'SELECT sector FROM companies WHERE id = $1',
      [draft.company_id],
    );
    vertical = rows[0]?.sector ?? null;
  }

  await c.query(
    `INSERT INTO exemplars (id, agent_id, draft_id, situation, output, quality, vertical)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id(), draft.agent_key, draft.id, draft.situation, JSON.stringify(final),
      // A draft signed off untouched and one rewritten before signing are different evidence, and
      // the distance is the only thing that can tell them apart.
      distance > 0 ? 'edited' : 'accepted',
      vertical,
    ],
  );
}
