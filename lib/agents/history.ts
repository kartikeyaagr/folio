/**
 * What each person has asked an agent for, and what came back.
 *
 * **Who may see a request is decided here, not on the page.** A person sees their own; an admin
 * sees everybody's. That rule is one `WHERE` clause and it belongs in the query rather than in a
 * filter after it — a page that fetched everything and hid some of it would still have sent it to
 * the browser, and the next page to read this function would have to remember to filter too.
 *
 * **Sweep runs are not history.** `requested_by IS NOT NULL` excludes everything the three event
 * sweeps enqueued unattended, which is the overwhelming majority of `agent_runs` — 79 of 88 rows
 * when this was written. Those are the registry's subject, and the registry is `/agents`. What
 * belongs here is the record of somebody asking, which is a different question with a different
 * reader.
 *
 * There is no conversation to show. Agent 8 and its tool loop were cut on 17-Sep-2026 (`0053`), so
 * an exchange with an agent is a request and an outcome, and that is what this returns.
 */

import { readTxn } from '../db.ts';

export interface Viewer {
  userId: string;
  isAdmin: boolean;
}

export interface AskedRun {
  id: string;
  /** The address of whoever asked. Always present: sweep runs are excluded. */
  askedBy: string;
  askedByMe: boolean;
  companySymbol: string | null;
  /** What it was pointed at, in the words the picker used. Null for agents that take no subject. */
  subjectLabel: string | null;
  status: string;
  failureKind: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  draftId: string | null;
  /** `pending`, `accepted` or `rejected`. Null while the run has produced nothing. */
  draftStatus: string | null;
  /** The document an accepted draft became, if it became one. */
  documentId: string | null;
}

/**
 * One agent's asked-for runs, newest first.
 *
 * The subject is resolved back to the label the picker showed rather than left as an opaque id: a
 * history row reading `subject_ref 66b4f457…` tells the person who asked for it nothing about what
 * they asked for. Both joins are LEFT — a subject can be deleted or superseded after the fact, and
 * the request still happened.
 */
export async function askedRuns(
  viewer: Viewer,
  agentKey: string,
  limit = 25,
): Promise<AskedRun[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<AskedRun>(
      `SELECT r.id,
              u.email AS "askedBy",
              (r.requested_by = $2) AS "askedByMe",
              co.symbol AS "companySymbol",
              coalesce(
                f.period_kind || ' to ' || f.period_end::text,
                d.title
              ) AS "subjectLabel",
              r.status, r.failure_kind AS "failureKind", r.error,
              r.created_at AS "createdAt", r.finished_at AS "finishedAt",
              dr.id AS "draftId", dr.status AS "draftStatus",
              doc.id AS "documentId"
         FROM agent_runs r
         JOIN users u ON u.id = r.requested_by
         LEFT JOIN companies co ON co.id = r.company_id
         LEFT JOIN fundamentals f ON f.id = r.subject_ref
         LEFT JOIN documents d ON d.id = r.subject_ref
         LEFT JOIN ai_drafts dr ON dr.run_id = r.id
         LEFT JOIN documents doc ON doc.from_draft_id = dr.id
        WHERE r.agent_key = $1
          AND r.requested_by IS NOT NULL
          -- Yours, or everything if you are an admin. One clause, in the query.
          AND ($3 OR r.requested_by = $2)
        ORDER BY r.created_at DESC
        LIMIT $4`,
      [agentKey, viewer.userId, viewer.isAdmin, limit],
    );
    return rows;
  });
}

/**
 * How many each agent has been asked for, by whoever is looking.
 *
 * One query for the whole index rather than one per card: six cards meant six round trips, and the
 * pool is ten connections.
 */
export async function askedCounts(viewer: Viewer): Promise<Record<string, number>> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{ agentKey: string; n: number }>(
      `SELECT agent_key AS "agentKey", count(*)::int AS n
         FROM agent_runs
        WHERE requested_by IS NOT NULL AND ($2 OR requested_by = $1)
        GROUP BY agent_key`,
      [viewer.userId, viewer.isAdmin],
    );
    return Object.fromEntries(rows.map((r) => [r.agentKey, r.n]));
  });
}
