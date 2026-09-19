/**
 * The corpus the learning loop learns from.
 *
 * One row per accepted draft: the situation the agent saw, what a person actually signed off, and
 * how far apart those two were. `v4.md §7` stakes the loop on that last number — *"If mean edit
 * distance does not fall, the loop is not working and should be turned off."*
 *
 * R5b added the other half: embedding those situations, and retrieving the nearest few into the
 * prompt of an agent whose `learning` flag is on.
 *
 * **The situation is what gets embedded, never the output.** §4.3 is explicit that `exemplars` is
 * not chunked and must never be — it matches one line describing the *inputs* an agent saw against
 * past inputs. That is a different mechanism from the content store, which happens to share an
 * extension and nothing else.
 */

import { readTxn, rowId, serviceTxn, type Client } from '../db.ts';
import { embed, EMBED_MODEL, toVector } from '../retrieval/embed.ts';


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
      rowId(), draft.agent_key, draft.id, draft.situation, JSON.stringify(final),
      // A draft signed off untouched and one rewritten before signing are different evidence, and
      // the distance is the only thing that can tell them apart.
      distance > 0 ? 'edited' : 'accepted',
      vertical,
    ],
  );
}

// ------------------------------------------------------------------------------------------------
// The queue, and what reads it
// ------------------------------------------------------------------------------------------------

/** §7: "retrieved exemplars — work of this kind an analyst accepted, up to 3." */
export const MAX_EXEMPLARS = 3;

export interface Retrieved {
  situation: string;
  output: Record<string, unknown>;
  quality: string;
}

/**
 * Embed the situations of exemplars that have none yet.
 *
 * The queue is `embedding IS NULL`, which is house rule 3's shape — "what has no embedding yet",
 * never "what is new since I last looked". `SKIP LOCKED` so two runs cannot claim the same row.
 *
 * Called by `jobs/index-content.ts` in the same process as the source indexer, because §10 asks
 * for it: both are the same operation against the same loaded model, and `embed()` caches its
 * 130MB session at module scope, so one process doing both loads it once.
 */
export async function embedPending(limit = 50): Promise<number> {
  return serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ id: string; situation: string }>(
      `SELECT id, situation FROM exemplars
        WHERE embedding IS NULL
        ORDER BY created_at
        LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (rows.length === 0) return 0;

    // One call for the batch: the model is loaded either way, and the per-call overhead is the
    // part that scales with row count.
    const vectors = await embed(rows.map((r) => r.situation));
    for (const [i, row] of rows.entries()) {
      await c.query(
        'UPDATE exemplars SET embedding = $2::vector, embed_model = $3 WHERE id = $1',
        [row.id, toVector(vectors[i]!), EMBED_MODEL],
      );
    }
    return rows.length;
  });
}

/**
 * The nearest past situations this agent was accepted on.
 *
 * **`embed_model` is filtered, exactly as `search.ts` filters it.** An exemplar embedded under a
 * superseded model is not "slightly worse to compare against" — vectors from two models occupy
 * different spaces and comparing them returns plausible numbers with meaningless neighbours. It is
 * quarantined until it is re-embedded, not silently included.
 *
 * **No relevance floor, deliberately.** Task 10 measured that this corpus has no cosine value that
 * separates relevant from irrelevant, and shipping a threshold nobody has measured is the mistake
 * that finding exists to prevent. An agent with two exemplars gets both; the preamble in
 * `prompt.ts` — "match the depth and the judgement, not the wording" — is what stops a weak match
 * being read as authority.
 */
export async function retrieveExemplars(
  agentKey: string,
  situation: string,
  limit = MAX_EXEMPLARS,
): Promise<Retrieved[]> {
  const [vector] = await embed([situation]);
  return readTxn(async (c) => {
    const { rows } = await c.query<Retrieved>(
      `SELECT situation, output, quality
         FROM exemplars
        WHERE agent_id = $1 AND embedding IS NOT NULL AND embed_model = $2
        ORDER BY embedding <=> $3::vector
        LIMIT $4`,
      [agentKey, EMBED_MODEL, toVector(vector!), limit],
    );
    return rows;
  });
}
