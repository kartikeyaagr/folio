/**
 * The `agent_runs` queue: putting work on it, taking work off it, and recording how it ended.
 *
 * Split from `runner.ts` when the tool loop arrived. The two halves answer different questions —
 * this one owns *the row*, `runner.ts` owns *the work* — and keeping them together had pushed
 * that file to 354 lines against a 300-line cap.
 *
 * **Every function here owns its transaction, and that is the point of the split.** Until R3 the
 * claim, the handler and the result all ran inside one `serviceTxn`, so a pooled connection (of
 * ten) was held for the whole model call. A tool loop makes that untenable: it calls the model
 * several times and each tool it runs opens a transaction of its own, so the run would hold two
 * connections for minutes at a time.
 *
 * Committing the claim separately also fixes a bug the old shape had and nobody had hit yet: when
 * the claim and the handler shared a transaction, a process that died mid-handler rolled back the
 * claim *including its `attempts` increment*, so a run that crashed the worker was retried forever
 * and `MAX_ATTEMPTS` never bit. Now the increment is durable before the handler starts, and a
 * crashed run is caught by the lease instead.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, serviceTxn } from '../db.ts';

/** Generous: a long annual report legitimately takes minutes, and re-running one costs money. */
export const LEASE_MINUTES = 30;
export const MAX_ATTEMPTS = 3;

export const id = (): string => randomBytes(16).toString('hex');

export interface EnqueueInput {
  agentKey: string;
  subjectRef?: string | null;
  companyId?: string | null;
  request?: Record<string, unknown>;
  requestedBy?: string | null;
}

/** Enqueue an intent, never a prompt. The worker builds the prompt when it picks the run up. */
export async function enqueue(input: EnqueueInput): Promise<string> {
  const runId = id();
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      `INSERT INTO agent_runs (id, agent_key, subject_ref, company_id, request, requested_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        runId, input.agentKey, input.subjectRef ?? null, input.companyId ?? null,
        JSON.stringify(input.request ?? {}), input.requestedBy ?? null,
      ],
    );
  });
  return runId;
}

/**
 * Enqueue scheduled agents that are due.
 *
 * Due means: nothing queued or running for that agent already, and the last finished run was
 * longer ago than its minimum interval. Deliberately not a cron string — a cron string is a second
 * schedule that can disagree with the timer actually installed, which is exactly what v2 had, a
 * row saying 09:00 daily against a unit running hourly, with nothing reading the row.
 */
export async function sweepScheduled(): Promise<number> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ key: string }>(
      `SELECT a.key
         FROM agents a
        WHERE a.enabled AND a.trigger = 'schedule' AND a.min_interval_minutes IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r
             WHERE r.agent_key = a.key AND r.status IN ('queued', 'running'))
          AND NOT EXISTS (
            SELECT 1 FROM agent_runs r
             WHERE r.agent_key = a.key
               AND r.finished_at > now() - (a.min_interval_minutes || ' minutes')::interval)`,
    );
    for (const r of rows) {
      // Ids are generated here rather than in SQL, like every other id in this codebase.
      // gen_random_bytes lives in pgcrypto, which is one extension more than this needs.
      await c.query('INSERT INTO agent_runs (id, agent_key) VALUES ($1, $2)', [id(), r.key]);
    }
    return rows.length;
  });
}

/** Re-queue runs whose claim lease has expired. A dead worker must not hold work forever. */
export async function reclaim(): Promise<number> {
  return serviceTxn('system:agents', async (c) => {
    const { rowCount } = await c.query(
      `UPDATE agent_runs
          SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
              failure_kind = CASE WHEN attempts >= $1 THEN 'error' ELSE NULL END,
              error = CASE WHEN attempts >= $1
                           THEN 'abandoned after ' || attempts || ' attempts' ELSE NULL END,
              finished_at = CASE WHEN attempts >= $1 THEN now() ELSE NULL END,
              claimed_at = NULL
        WHERE status = 'running'
          AND claimed_at < now() - ($2 || ' minutes')::interval`,
      [MAX_ATTEMPTS, String(LEASE_MINUTES)],
    );
    return rowCount ?? 0;
  });
}

export interface ClaimedRun {
  id: string;
  agentKey: string;
  subjectRef: string | null;
  companyId: string | null;
  request: Record<string, unknown>;
}

/**
 * Take one queued run, and commit that fact.
 *
 * `SKIP LOCKED` so two workers never take the same one. The transaction ends here, which is what
 * lets the handler run without holding a connection — see this file's header.
 */
export async function claimRun(): Promise<ClaimedRun | null> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<ClaimedRun>(
      `UPDATE agent_runs SET status = 'running', claimed_at = now(),
                             started_at = coalesce(started_at, now()), attempts = attempts + 1
        WHERE id = (
          SELECT id FROM agent_runs
           WHERE status = 'queued' AND next_attempt_at <= now()
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING id, agent_key AS "agentKey", subject_ref AS "subjectRef",
                  company_id AS "companyId", request`,
    );
    return rows[0] ?? null;
  });
}

/**
 * Claim one named run, if it is still queued.
 *
 * For a surface that enqueues a run and then immediately works its own row rather than waiting for
 * the five-minute timer — chat, where a person is sitting there. Returns null when somebody else
 * already claimed it, which is the same race `claimRun`'s SKIP LOCKED handles and the same answer:
 * whoever got there first owns it.
 *
 * The row is enqueued either way, so a web process that dies mid-turn loses nothing the lease does
 * not recover: `reclaim()` re-queues it and the timer picks it up.
 */
export async function claimThisRun(runId: string): Promise<ClaimedRun | null> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<ClaimedRun>(
      `UPDATE agent_runs SET status = 'running', claimed_at = now(),
                             started_at = coalesce(started_at, now()), attempts = attempts + 1
        WHERE id = $1 AND status = 'queued' AND next_attempt_at <= now()
        RETURNING id, agent_key AS "agentKey", subject_ref AS "subjectRef",
                  company_id AS "companyId", request`,
      [runId],
    );
    return rows[0] ?? null;
  });
}

/** A run that produced what it was asked for. `draftId` is null for the agents that write none. */
export async function finishRun(runId: string, draftId: string | null): Promise<void> {
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      "UPDATE agent_runs SET status='done', finished_at=now(), draft_id=$2 WHERE id=$1",
      [runId, draftId],
    );
  });
}

/**
 * A run that did not.
 *
 * Its own transaction, deliberately: the path that reports a failure must not run on the
 * connection the failure happened on. That is lesson L6, and it is why the savepoint this
 * function used to need is gone.
 */
export async function failRun(runId: string, kind: string, error: string): Promise<void> {
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      `UPDATE agent_runs
          SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END,
              failure_kind = $2,
              error = $4,
              finished_at = CASE WHEN attempts >= $3 THEN now() ELSE NULL END,
              claimed_at = NULL,
              next_attempt_at = now() + (power(4, attempts) || ' minutes')::interval
        WHERE id = $1`,
      [runId, kind, MAX_ATTEMPTS, error.slice(0, 2000)],
    );
  });
}

// ------------------------------------------------------------------------------------------------
// Visibility
// ------------------------------------------------------------------------------------------------

/**
 * Failed runs are never re-offered by the sweep, so they have to be visible somewhere or they are
 * simply lost. A remedy that requires already knowing what silently did not happen is no remedy.
 */
export async function failedRuns(limit = 50): Promise<
  { id: string; agentKey: string; failureKind: string | null; error: string | null; finishedAt: Date | null }[]
> {
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      id: string; agentKey: string; failureKind: string | null; error: string | null; finishedAt: Date | null;
    }>(
      `SELECT id, agent_key AS "agentKey", failure_kind AS "failureKind",
              error, finished_at AS "finishedAt"
         FROM agent_runs WHERE status = 'failed'
        ORDER BY finished_at DESC NULLS LAST LIMIT $1`,
      [limit],
    );
    return rows;
  });
}

/** Put a failed run back on the queue, by hand, after somebody has looked at why. */
export async function requeue(runId: string): Promise<boolean> {
  return serviceTxn('system:agents', async (c) => {
    const { rowCount } = await c.query(
      `UPDATE agent_runs
          SET status='queued', attempts=0, failure_kind=NULL, error=NULL,
              finished_at=NULL, claimed_at=NULL, next_attempt_at=now()
        WHERE id=$1 AND status='failed'`,
      [runId],
    );
    return (rowCount ?? 0) > 0;
  });
}
