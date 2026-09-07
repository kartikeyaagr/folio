/**
 * How a run reaches the record.
 *
 *   SWEEP ─────────────► agent_runs ──────► CLAIM ──────► HANDLER ─────► ai_drafts ─────► /review
 *   "what has no run yet"  queued          SKIP LOCKED   assemble NOW    pending          a person
 *    never a watermark                      + lease       call model                       accepts
 *                                                         verify
 *
 * Four properties, each load-bearing:
 *
 *   * **The prompt is assembled at claim time, not at enqueue time.** A run that waited an hour
 *     reads the data as it is now, not as it was when something noticed it. It also means a
 *     trigger cannot accidentally become a second prompt-assembly path.
 *   * **The sweep asks "what has no run yet", never "what is new since".** A high-water mark can
 *     be wrong in both directions silently — work skipped, or work redone at full price. A
 *     NOT EXISTS against agent_runs cannot.
 *   * **A claim holds a lease.** A run still 'running' past it is assumed dead and re-queued.
 *     Effort levels have to stay inside the lease or a long job is re-run and billed twice.
 *   * **Failure states are named** (see ./model.ts) and none of them writes a draft.
 */

import { randomBytes } from 'node:crypto';
import { readTxn, serviceTxn, type Client } from '../db.ts';
import { liveModel, type Answer, type FailureKind, type Model } from './model.ts';

/** Generous: a long annual report legitimately takes minutes, and re-running one costs money. */
export const LEASE_MINUTES = 30;
export const MAX_ATTEMPTS = 3;

export class ScopeViolation extends Error {}

export interface AgentRow {
  key: string;
  label: string;
  purpose: string;
  model: string;
  effort: string | null;
  data_scope: string[];
  notify_on_draft: boolean;
}

export interface RunContext {
  c: Client;
  agent: AgentRow;
  runId: string;
  companyId: string | null;
  subjectRef: string | null;
  request: Record<string, unknown>;
  ask: Model;
}

export interface Draft {
  content: Record<string, unknown>;
  sources: unknown[];
  verification?: unknown;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export type HandlerResult = { draft: Draft } | { done: true };
export type AgentHandler = (ctx: RunContext) => Promise<HandlerResult>;

/** One map from key to handler. No parallel registries of builders and verifiers to fall out of step. */
export const HANDLERS = new Map<string, AgentHandler>();
export const registerHandler = (key: string, h: AgentHandler): void => void HANDLERS.set(key, h);

const id = (): string => randomBytes(16).toString('hex');

/**
 * An agent may only read what its registry row declares.
 *
 * Checked before the model is called, so an agent cannot quietly widen its own reach — and so that
 * "what runs unattended, over what data" stays answerable from the table rather than from a grep.
 */
export function assertInScope(agent: AgentRow, reads: string[]): void {
  const outside = reads.filter((t) => !agent.data_scope.includes(t));
  if (outside.length > 0) {
    throw new ScopeViolation(
      `${agent.key} tried to read ${outside.join(', ')}, which is outside its declared data_scope`,
    );
  }
}

// ------------------------------------------------------------------------------------------------
// Queue
// ------------------------------------------------------------------------------------------------

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

/** Take one queued run. SKIP LOCKED so two workers never take the same one. */
async function claim(c: Client): Promise<{ id: string; agent_key: string; subject_ref: string | null; company_id: string | null; request: Record<string, unknown> } | null> {
  const { rows } = await c.query(
    `UPDATE agent_runs SET status = 'running', claimed_at = now(),
                           started_at = coalesce(started_at, now()), attempts = attempts + 1
      WHERE id = (
        SELECT id FROM agent_runs
         WHERE status = 'queued' AND next_attempt_at <= now()
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1)
      RETURNING id, agent_key, subject_ref, company_id, request`,
  );
  return rows[0] ?? null;
}

async function loadAgent(c: Client, key: string): Promise<AgentRow | null> {
  const { rows } = await c.query<AgentRow>(
    'SELECT key, label, purpose, model, effort, data_scope, notify_on_draft FROM agents WHERE key = $1 AND enabled',
    [key],
  );
  return rows[0] ?? null;
}

export interface DrainResult {
  ran: number;
  drafted: number;
  failed: number;
  reclaimed: number;
}

/**
 * Work the queue.
 *
 * Each run gets its own transaction: a failure records itself and the next run still gets its
 * chance, rather than one bad filing stopping the batch.
 */
export async function drain(limit = 10, model: Model = liveModel): Promise<DrainResult> {
  const reclaimed = await reclaim();
  const out: DrainResult = { ran: 0, drafted: 0, failed: 0, reclaimed };

  for (let i = 0; i < limit; i++) {
    const done = await serviceTxn('system:agents', async (c) => {
      const run = await claim(c);
      if (!run) return true;
      out.ran++;

      const agent = await loadAgent(c, run.agent_key);
      if (!agent) {
        await fail(c, run.id, 'error', `no enabled agent named ${run.agent_key}`);
        out.failed++;
        return false;
      }

      const handler = HANDLERS.get(run.agent_key);
      if (!handler) {
        await fail(c, run.id, 'error', `no handler registered for ${run.agent_key}`);
        out.failed++;
        return false;
      }

      // A savepoint, because a handler that runs bad SQL poisons the whole transaction — and the
      // next statement to run in it is the one recording *why the handler failed*. Without this,
      // that write fails too, the run's real error is replaced by "current transaction is aborted",
      // and the row sits in `running` until the lease expires half an hour later. Found when a
      // dossier query named a column that did not exist and said nothing about which one.
      await c.query('SAVEPOINT handler');
      try {
        const result = await handler({
          c, agent, runId: run.id,
          companyId: run.company_id, subjectRef: run.subject_ref,
          request: run.request, ask: model,
        });
        await c.query('RELEASE SAVEPOINT handler');
        if ('done' in result) {
          await c.query(
            "UPDATE agent_runs SET status='done', finished_at=now() WHERE id=$1", [run.id],
          );
        } else {
          const draftId = await recordDraft(c, run.id, agent, run.company_id, result.draft);
          await c.query(
            "UPDATE agent_runs SET status='done', finished_at=now(), draft_id=$2 WHERE id=$1",
            [run.id, draftId],
          );
          out.drafted++;
        }
      } catch (err) {
        // Back to a usable transaction before writing anything, whatever the handler did to it.
        await c.query('ROLLBACK TO SAVEPOINT handler');
        const kind = err instanceof ModelFailure ? err.kind : 'error';
        await fail(c, run.id, kind, String(err instanceof Error ? err.message : err));
        out.failed++;
      }
      return false;
    });
    if (done) break;
  }
  return out;
}

/** Thrown by an agent when the model gave nothing usable, so the run records the reason. */
export class ModelFailure extends Error {
  // Declared and assigned, not a parameter property: Node runs TypeScript in strip-only mode,
  // which removes types but generates no code, so `constructor(readonly kind: ...)` is a syntax
  // error at runtime. Same reason this codebase has no enums and no namespaces.
  readonly kind: FailureKind;

  constructor(kind: FailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Turn a failed Answer into a throw the runner records with its named kind. */
export function raise(answer: Extract<Answer, { ok: false }>): never {
  throw new ModelFailure(answer.kind, `${answer.kind}: ${answer.detail}`);
}

async function fail(c: Client, runId: string, kind: string, error: string): Promise<void> {
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
}

async function recordDraft(
  c: Client, runId: string, agent: AgentRow, companyId: string | null, d: Draft,
): Promise<string> {
  const draftId = id();
  await c.query(
    `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, sources, verification,
                            model, input_tokens, output_tokens, cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      draftId, runId, agent.key, companyId,
      JSON.stringify(d.content), JSON.stringify(d.sources),
      d.verification === undefined ? null : JSON.stringify(d.verification),
      d.model, d.inputTokens ?? null, d.outputTokens ?? null, d.costUsd ?? null,
    ],
  );
  return draftId;
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
