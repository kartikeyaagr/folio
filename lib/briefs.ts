/**
 * Briefs: the ones a person accepted, and the one waiting to be.
 *
 * A brief is a document, and a document is the thing that survives — the draft it came from is kept
 * beside it so "who agreed to this, and what did the agent originally write" stays answerable after
 * the fact rather than only in the queue.
 */

import { readTxn } from './db.ts';

export interface BriefSummary {
  id: string;
  title: string;
  writtenAt: Date;
  acceptedBy: string | null;
  /** How many names the brief actually said something about. */
  covered: number;
  quiet: number;
  fromDraftId: string | null;
}

export interface BriefDocument extends BriefSummary {
  content: Record<string, unknown>;
  /**
   * What a reviewer changed before accepting, keyed by path — `by_company[0].why_it_matters`.
   *
   * **An object, not an array**, which it always was: `diffFields` builds it as
   * `{path: {from, to}}`. Typed as an array here since R5a, so `edits.length` was `undefined`,
   * `undefined > 0` was false, and the "Changed before it was accepted" card on
   * `/news/brief/[id]` never rendered for any brief however heavily corrected — and would have
   * thrown on `.map` if it ever had. Nothing failed, because nothing ran.
   */
  edits: Record<string, { from: unknown; to: unknown }> | null;
  model: string | null;
  costUsd: string | null;
}

const SUMMARY = `
  SELECT d.id, d.title, v.written_at AS "writtenAt", u.name AS "acceptedBy",
         d.from_draft_id AS "fromDraftId",
         COALESCE(jsonb_array_length(v.body->'by_company'), 0) AS covered,
         COALESCE(jsonb_array_length(v.body->'nothing_to_report'), 0) AS quiet
    FROM documents d
    JOIN LATERAL (
      SELECT body, written_at, written_by FROM document_versions
       WHERE document_id = d.id ORDER BY written_at DESC LIMIT 1
    ) v ON true
    LEFT JOIN users u ON u.id = v.written_by
   WHERE d.kind = 'brief' AND d.archived_at IS NULL`;

export async function briefs(limit = 30): Promise<BriefSummary[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<BriefSummary>(
      `${SUMMARY} ORDER BY v.written_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  });
}

export async function brief(id: string): Promise<BriefDocument | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<BriefDocument>(
      `SELECT s.*, v.body AS content, dr.edits, dr.model, dr.cost_usd::text AS "costUsd"
         FROM (${SUMMARY} AND d.id = $1) s
         JOIN LATERAL (
           SELECT body FROM document_versions
            WHERE document_id = s.id ORDER BY written_at DESC LIMIT 1
         ) v ON true
         LEFT JOIN ai_drafts dr ON dr.id = s."fromDraftId"`,
      [id],
    );
    return rows[0] ?? null;
  });
}

/**
 * A brief that has been written and not yet accepted.
 *
 * Surfaced on the brief page rather than only in the review queue: somebody who came here to read
 * this morning's brief should be told it exists and is waiting on a person, not shown yesterday's
 * and left to wonder.
 */
export async function pendingBrief(): Promise<{ id: string; createdAt: Date } | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ id: string; createdAt: Date }>(
      `SELECT id, created_at AS "createdAt" FROM ai_drafts
        WHERE agent_key = 'news-brief' AND decided_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  });
}

/** A run queued and not yet finished, so the page can say the brief is on its way. */
export async function briefInFlight(): Promise<boolean> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM agent_runs
          WHERE agent_key = 'news-brief' AND status IN ('queued', 'running')) AS ok`,
    );
    return rows[0]!.ok;
  });
}
