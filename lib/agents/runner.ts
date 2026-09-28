/**
 * How a run reaches the record.
 *
 *   SWEEP ─────────────► agent_runs ──────► CLAIM ──────► HANDLER ─────► ai_drafts ─────► /review
 *   "what has no run yet"  queued          SKIP LOCKED   assemble NOW    pending          a person
 *    never a watermark                      + lease       call model                       accepts
 *                                          COMMITS        read-only                        │
 *                                             │           connections                      │
 *                                             └───────────────────────────────────────► agent_runs
 *                                                                                        done/failed
 *
 * The news brief alone goes straight from ai_drafts to the record, published and mailed, with no
 * person between (`publishDraft` in ./review.ts).
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
 *
 * **A handler holds no write connection.** It is handed `reads`, a bound `readTxn`, and Postgres
 * refuses a write on it — `BEGIN READ ONLY` is a guarantee, not a convention. The claim, the draft
 * and the failure each own their own transaction in ./queue.ts. Before R3 all of it ran inside the
 * claim's transaction, which held one pooled connection of ten for the length of the model call;
 * the tool loop, which calls the model repeatedly and opens a transaction per tool, made that
 * indefensible. It also retires the `SAVEPOINT handler` this file used to need: the row recording
 * why a handler failed is no longer written on the connection the handler poisoned.
 */

import { readTxn, rowId, serviceTxn, type Client } from '../db.ts';
import { liveModel, type Answer, type FailureKind, type Model } from './model.ts';
import { claimRun, claimThisRun, failRun, finishRun, markDone, reclaim, type ClaimedRun } from './queue.ts';
import { PUBLISHED_WITHOUT_REVIEW, publishDraft } from './review.ts';

export class ScopeViolation extends Error {}

export interface AgentRow {
  key: string;
  label: string;
  purpose: string;
  model: string;
  effort: string | null;
  data_scope: string[];
  /** Tool names this agent may be handed. Empty for the six agents that call no tool. */
  tools: string[];
  /** Whether past exemplars are retrieved into this agent's prompt. Gates retrieval, not capture. */
  learning: boolean;
  notify_on_draft: boolean;
}

/**
 * A read-only transaction, handed to the handler so it never holds a write connection.
 *
 * A type rather than `typeof readTxn` so a test can supply one against its own pool, and so the
 * shape a handler depends on is stated where handlers can see it.
 */
export type Reads = <T>(fn: (c: Client) => Promise<T>) => Promise<T>;

export interface RunContext {
  reads: Reads;
  agent: AgentRow;
  runId: string;
  companyId: string | null;
  subjectRef: string | null;
  request: Record<string, unknown>;
  ask: Model;
}

export interface Draft {
  content: Record<string, unknown>;
  /**
   * One line describing the INPUTS this run saw, for the exemplar acceptance writes.
   *
   * Written by the handler because only the handler knows them — §4.3's shape is "Q2 concall for a
   * specialty chemicals maker, 41-page transcript, prior quarter guided 18%", not the company's
   * name. Required rather than optional: a generic fallback would make every exemplar for an agent
   * look alike, and retrieval would then return an arbitrary one, which is worse than none.
   */
  situation: string;
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

async function loadAgent(key: string): Promise<AgentRow | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<AgentRow>(
      `SELECT key, label, purpose, model, effort, data_scope, tools, learning, notify_on_draft
         FROM agents WHERE key = $1 AND enabled`,
      [key],
    );
    return rows[0] ?? null;
  });
}

export interface DrainResult {
  ran: number;
  drafted: number;
  failed: number;
  /**
   * Of those failures, the ones whose kind is `error` — the catch-all.
   *
   * The distinction is the whole difference between an agent having a bad day and a box that
   * cannot work at all. A `refusal`, a `truncated`, an `unparseable`, a `schema_mismatch` or a
   * `too_large` is *this subject*: the run recorded it, `/agents` shows it, and waking somebody at
   * 6am would be wrong. An `error` is a missing credential, a network that is gone, a database
   * that is not there — every run in the batch will fail the same way, and nobody will find out
   * unless the job says so.
   */
  errors: number;
  reclaimed: number;
}

/**
 * Work the queue.
 *
 * Each run records itself independently: a failure records itself and the next run still gets its
 * chance, rather than one bad filing stopping the batch.
 */
export async function drain(limit = 10, model: Model = liveModel): Promise<DrainResult> {
  const reclaimed = await reclaim();
  const out: DrainResult = { ran: 0, drafted: 0, failed: 0, errors: 0, reclaimed };

  for (let i = 0; i < limit; i++) {
    const run = await claimRun();
    if (!run) break;
    out.ran++;
    const { outcome, kind } = await executeRun(run, model);
    if (outcome === 'drafted') out.drafted++;
    if (outcome === 'failed') out.failed++;
    if (kind === 'error') out.errors++;
  }
  return out;
}

export type RunOutcome = 'drafted' | 'done' | 'failed';

/**
 * Work one already-claimed run to its end.
 *
 * Split out of `drain` so a claimed run has exactly one execution path, whichever surface claimed
 * it. A second copy of this for chat is how the two would drift — and the thing that would drift
 * first is which failures get a named `failure_kind`.
 */
async function executeRun(
  run: ClaimedRun,
  model: Model,
  // The kind comes back beside the outcome so `drain` can tell a box that cannot work from an
  // agent having a bad day. `runNow` drops it — chat has a person watching, and the person is the
  // alert — which is why this is the inner shape and `RunOutcome` is still what callers see.
): Promise<{ outcome: RunOutcome; kind?: FailureKind }> {
  const agent = await loadAgent(run.agentKey);
  if (!agent) {
    await failRun(run.id, 'error', `no enabled agent named ${run.agentKey}`);
    return { outcome: 'failed', kind: 'error' };
  }

  const handler = HANDLERS.get(run.agentKey);
  if (!handler) {
    await failRun(run.id, 'error', `no handler registered for ${run.agentKey}`);
    return { outcome: 'failed', kind: 'error' };
  }

  try {
    const result = await handler({
      reads: readTxn, agent, runId: run.id,
      companyId: run.companyId, subjectRef: run.subjectRef,
      request: run.request, ask: model,
    });
    if ('done' in result) {
      await finishRun(run.id, null);
      return { outcome: 'done' };
    }
    await recordDraft(run.id, agent, run.companyId, result.draft);
    return { outcome: 'drafted' };
  } catch (err) {
    const kind: FailureKind = err instanceof ModelFailure ? err.kind : 'error';
    await failRun(run.id, kind, String(err instanceof Error ? err.message : err));
    return { outcome: 'failed', kind };
  }
}

/**
 * Claim and work one named run, now.
 *
 * For chat, where a person is waiting and the five-minute timer is not an answer. Returns null if
 * the run was already claimed — by the timer, or by a second tab — because the right response to
 * losing that race is to let the winner finish, not to run it twice.
 */
export async function runNow(runId: string, model: Model = liveModel): Promise<RunOutcome | null> {
  const run = await claimThisRun(runId);
  return run ? (await executeRun(run, model)).outcome : null;
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

/**
 * Write the draft and close the run, in one transaction.
 *
 * The pair is atomic on purpose: a draft whose run still reads 'running' would be re-offered by
 * `reclaim()` half an hour later and drafted a second time, at full price.
 *
 * For the news brief, publishing it and queueing its mail belong to the same transaction too.
 * Otherwise a crash between the two would leave a brief written, marked done, and waiting in
 * /review for an acceptance nobody is going to give it.
 */
async function recordDraft(
  runId: string, agent: AgentRow, companyId: string | null, d: Draft,
): Promise<string> {
  const draftId = rowId();
  await serviceTxn('system:agents', async (c) => {
    await c.query(
      `INSERT INTO ai_drafts (id, run_id, agent_key, company_id, content, sources, verification,
                              model, input_tokens, output_tokens, cost_usd, field_order, situation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        draftId, runId, agent.key, companyId,
        JSON.stringify(d.content), JSON.stringify(d.sources),
        d.verification === undefined ? null : JSON.stringify(d.verification),
        d.model, d.inputTokens ?? null, d.outputTokens ?? null, d.costUsd ?? null,
        // Captured here because this is the last place it exists. jsonb stores keys sorted by length
        // and then alphabetically, so the order the agent's schema declared is gone after the insert.
        Object.keys(d.content),
        // Carried to the exemplar the acceptance writes, which happens in another transaction and
        // possibly days later. The handler is the only thing that knows what it was looking at.
        d.situation,
      ],
    );
    // The statement itself lives in ./queue.ts, with every other thing that writes this row.
    await markDone(c, runId, draftId);
    // The one agent whose work skips the review gate, by the fund's decision of 28-Sep-2026. The
    // exception, and what it keeps, is argued at `publishDraft`.
    if (PUBLISHED_WITHOUT_REVIEW.has(agent.key)) await publishDraft(c, draftId);
  });
  return draftId;
}
