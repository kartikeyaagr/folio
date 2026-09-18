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

import { readTxn, rowId, serviceTxn } from '../db.ts';

/** Generous: a long annual report legitimately takes minutes, and re-running one costs money. */
export const LEASE_MINUTES = 30;
export const MAX_ATTEMPTS = 3;

/**
 * How long a run that failed on the *box* waits before it is offered again.
 *
 * Long, because the thing it is waiting for is a person: a missing credential, an expired token, a
 * database that was down. Retrying that in five minutes just burns the same failure again, and the
 * job's own alert is what actually gets it fixed. Six hours means a box repaired in the morning has
 * its backlog moving by lunch without anybody typing anything.
 */
export const RETRY_AFTER_HOURS = 6;

/** Per pass. A broken box should not enqueue its whole backlog on every tick of a five-minute timer. */
export const RETRY_BATCH = 25;


export interface EnqueueInput {
  agentKey: string;
  subjectRef?: string | null;
  companyId?: string | null;
  request?: Record<string, unknown>;
  requestedBy?: string | null;
}

/** Enqueue an intent, never a prompt. The worker builds the prompt when it picks the run up. */
export async function enqueue(input: EnqueueInput): Promise<string> {
  const runId = rowId();
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
      await c.query('INSERT INTO agent_runs (id, agent_key) VALUES ($1, $2)', [rowId(), r.key]);
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

/**
 * Put back the runs the *box* broke, as opposed to the ones the model declined.
 *
 * **This is what stops an outage silently retiring work forever.** The three event sweeps ask
 * `NOT EXISTS (… WHERE agent_key = $1 AND subject_ref = …)` with no predicate on status, so a run
 * that reaches `failed` retires its subject permanently — `failedRuns`' own docstring above says
 * as much. That is right for a subject the model refused, could not parse, or could not fit: those
 * fail the same way every time, and re-offering them forever is a bill with no answer at the end
 * of it. It is wrong for a box with no credential, where the work is fine and the machine was not.
 * Measured on the dev database at the time this was written: 129 subjects were eligible across the
 * three sweeps, and an hour of running without a credential would have retired every one of them.
 *
 * `failure_kind` already draws that line. `refusal`, `truncated`, `unparseable`, `schema_mismatch`
 * and `too_large` are all *this content*; `error` is the catch-all for everything else. So only
 * `error` comes back, and the sweeps keep their simple predicate — a requeued run is `queued`
 * again, which the sweep already reads as "this subject has a run".
 *
 * Returns how many it put back, so the job can say so out loud.
 */
export async function requeueErrored(limit = RETRY_BATCH): Promise<number> {
  return serviceTxn('system:agents', async (c) => {
    const { rowCount } = await c.query(
      `UPDATE agent_runs
          SET status='queued', attempts=0, failure_kind=NULL, error=NULL,
              finished_at=NULL, claimed_at=NULL, next_attempt_at=now()
        WHERE id IN (
          SELECT id FROM agent_runs
           WHERE status = 'failed' AND failure_kind = 'error'
             AND finished_at < now() - ($1 || ' hours')::interval
           ORDER BY finished_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED)`,
      [String(RETRY_AFTER_HOURS), limit],
    );
    return rowCount ?? 0;
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
