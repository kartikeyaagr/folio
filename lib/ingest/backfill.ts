/**
 * The queue a newly followed name sits in, and what counts as having filled it in.
 *
 * `jobs/backfill-company.ts` owns the seven steps — they are network work against four NSE
 * endpoints and belong in a job. This file owns the three decisions around them, which are neither
 * network nor opinion and are the ones that were wrong: **who may claim a name, what a step ending
 * badly means, and whether the name is then done.**
 *
 * ### A step ends three ways, not two
 *
 * The job used to treat "did not throw" as success, and three of its seven steps never throw: the
 * annual-report loop catches each year and counts it, `fetchAttachments` and `extractPending` both
 * count their own failures and return, and the shareholding step asserted on the size of the
 * *exchange-wide* submissions index rather than on anything belonging to this company. So
 * `5 offered, 0 stored, 5 failed` was a success, `93 attachments, 93 failed` was a success, and a
 * name whose shareholding was never fetched was a success. Then `backfilled_at` was set and the
 * queue's own predicate stopped matching, so nothing ever offered the name again.
 *
 * `lib/agents/queue.ts` settled this question for agent runs and the line it drew is the line here:
 *
 *   - **`gap`** — the exchange has nothing for this name. A company that listed last year has no
 *     sixteen years of annual reports and never will; a name NSE has not published a shareholding
 *     pattern for is a fact about the name. Recorded, does not hold the queue.
 *   - **`error`** — the box or the feed broke. An unwritable attachment store, a session NSE
 *     refused, a 500. Nothing about this name caused it and the next attempt may well work.
 *   - **`ok`** — it did the thing.
 *
 * Only `error` keeps the name in the queue, and an exception is always `error`: by the time one
 * escapes a step, nobody knows enough to call it a fact about the company.
 *
 * ### The claim is a lease
 *
 * `backfill_started_at` has been written since `0035` and read by nothing, while the ten-minute
 * timer runs a job whose price walk alone is documented at twenty minutes. Reading it closes that:
 * a name claimed inside `LEASE_MINUTES` is somebody else's, so the next tick does not start a
 * second pass over it and does not spawn a second `backfill-prices` subprocess for the same symbol.
 *
 * The same column is the retry delay, because they want the same number for the same reason — long
 * enough that a broken box is not hammered, short enough that a person who clicked Follow this
 * morning has the name by lunch.
 */

import { randomBytes } from 'node:crypto';
import { serviceTxn } from '../db.ts';

/**
 * Longer than the longest backfill observed (PRAJIND: 845 filings, 16 annual reports, 117 periods
 * and a 400-day price walk), so the lease does not expire under a run that is still working. Also
 * the wait before a failed attempt is offered again — six hours is right for `requeueErrored`,
 * where the thing being waited for is a person fixing a credential, and wrong here, where it is
 * usually a feed having a bad ten minutes.
 */
export const LEASE_MINUTES = 90;

/** The bound `lib/agents/queue.ts` uses, for the reason it uses it: a fourth go has never helped. */
export const MAX_ATTEMPTS = 3;

export type Outcome = 'ok' | 'gap' | 'error';

/** What a step did, so the notice says what arrived rather than that something did. */
export interface Step {
  label: string;
  detail: string;
  outcome: Outcome;
}

export interface StepResult {
  detail: string;
  outcome: Outcome;
}

export const did = (detail: string): StepResult => ({ detail, outcome: 'ok' });
/** The exchange has nothing for this name. A fact about the company, not about us. */
export const nothingFiled = (detail: string): StepResult => ({ detail, outcome: 'gap' });
/** We could not do it. A fact about us, and the only kind that holds the name in the queue. */
export const broke = (detail: string): StepResult => ({ detail, outcome: 'error' });

export interface Target {
  id: string;
  symbol: string;
  name: string;
  platform: string | null;
  addedBy: string | null;
  /** Including this one. `record` needs it to know whether another go is owed. */
  attempts: number;
  /** When the name was followed. The queue's order, re-applied after RETURNING loses it. */
  askedAt: Date;
}

/**
 * Take every name the queue owes, and say so durably before any work starts.
 *
 * One statement, so the read and the claim cannot be separated by another process arriving between
 * them. `SKIP LOCKED` handles the instant overlap; `backfill_started_at` handles the ninety-minute
 * one, and it is the durable half — the row lock dies with this transaction, which ends here.
 *
 * A name given with `--symbol` bypasses all of it: no attempt bound, no lease, and the counter
 * resets to 1, because a person typing a symbol has already decided the name deserves another go.
 */
export async function claim(only?: string | null): Promise<Target[]> {
  const symbol = only?.trim().toUpperCase() || null;
  return serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<Target>(
      `UPDATE companies co
          SET backfill_started_at = now(),
              backfill_attempts = CASE WHEN $1::text IS NULL THEN co.backfill_attempts + 1 ELSE 1 END
        WHERE co.id IN (
          SELECT q.id FROM companies q
           WHERE ($1::text IS NULL
                    AND q.backfilled_at IS NULL
                    AND q.backfill_attempts < $2
                    AND (q.backfill_started_at IS NULL
                         OR q.backfill_started_at < now() - ($3 || ' minutes')::interval))
              OR q.symbol = $1
           ORDER BY q.created_at
             FOR UPDATE SKIP LOCKED)
       RETURNING co.id, co.symbol, co.name, co.added_by AS "addedBy",
                 co.backfill_attempts AS attempts, co.created_at AS "askedAt",
                 (SELECT s.platform FROM securities s WHERE s.symbol = co.symbol) AS platform`,
      [symbol, MAX_ATTEMPTS, String(LEASE_MINUTES)],
    );
    // The subquery's ORDER BY decides which rows are *locked*; RETURNING follows no order at all.
    // The queue is oldest ask first — a person who followed a name this morning should not wait
    // behind one followed at lunch — so the order is re-applied here on the column that means it.
    return rows.sort((a, b) => a.askedAt.getTime() - b.askedAt.getTime());
  });
}

/**
 * Whether a symbol is followed at all.
 *
 * Asked only when a forced `--symbol` claim came back empty, because that has two causes and they
 * want opposite responses. `SKIP LOCKED` is why: it is right for a job never to block on somebody
 * else's transaction, but it means an empty claim can mean *this name is not followed* or *this
 * name is followed and busy*. Hit live on 17-Sep-2026 — three `index-content --watch` processes
 * from other worktrees against the same dev database held TEGA's row through a foreign key, and
 * the job said "TEGA is not a followed company" about a company it had filled in ten minutes
 * earlier.
 */
export async function followed(symbol: string): Promise<boolean> {
  return serviceTxn('system:ingest', async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM companies WHERE symbol = $1', [
      symbol.trim().toUpperCase(),
    ]);
    return (rowCount ?? 0) > 0;
  });
}

/**
 * What the queue still owes, split by why it was not offered.
 *
 * `claim` returning nothing has three causes and the job used to print one sentence for all of
 * them — *"every followed name has been backfilled"* — which is a zero standing in for a fact
 * nobody measured. A name being worked right now and a name three attempts into failing are both
 * "nothing to do" to the claim and neither is done.
 */
export async function owed(): Promise<{ leased: number; exhausted: number }> {
  return serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ leased: string; exhausted: string }>(
      `SELECT count(*) FILTER (WHERE backfill_attempts < $1)::text  AS leased,
              count(*) FILTER (WHERE backfill_attempts >= $1)::text AS exhausted
         FROM companies WHERE backfilled_at IS NULL`,
      [MAX_ATTEMPTS],
    );
    return { leased: Number(rows[0]!.leased), exhausted: Number(rows[0]!.exhausted) };
  });
}

/** What became of the name. Four outcomes because three of them are not "it worked". */
export type Verdict = 'filled' | 'filled with gaps' | 'queued again' | 'out of attempts';

export function verdictOf(taken: Step[], attempts: number): Verdict {
  const broken = taken.some((s) => s.outcome === 'error');
  if (!broken) return taken.some((s) => s.outcome === 'gap') ? 'filled with gaps' : 'filled';
  return attempts >= MAX_ATTEMPTS ? 'out of attempts' : 'queued again';
}

/**
 * Write what happened, and decide whether the name is still owed a backfill.
 *
 * `backfilled_at` is set only when nothing broke. The column's own comment says it means "the whole
 * history was fetched", so setting it after ninety-three consecutive EACCES was the database being
 * told something untrue — and because the queue reads that column, the lie was also what made the
 * failure permanent.
 *
 * A name out of attempts does not get it either. It leaves the queue by the attempt bound, which is
 * a different statement and an honest one: *we stopped asking*, not *we have it*.
 */
export async function record(t: Target, taken: Step[]): Promise<Verdict> {
  const verdict = verdictOf(taken, t.attempts);
  const filled = verdict === 'filled' || verdict === 'filled with gaps';
  const notable = taken.filter((s) => s.outcome !== 'ok');
  const summary = taken.map((s) => `${s.label}: ${s.detail}`).join('\n');

  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `UPDATE companies
          SET backfilled_at = CASE WHEN $2 THEN now() ELSE backfilled_at END,
              backfill_error = $3
        WHERE id = $1`,
      [
        t.id,
        filled,
        notable.length > 0
          ? notable.map((s) => `${s.label}: ${s.detail}`).join('; ').slice(0, 500)
          : null,
      ],
    );

    // Not sent on `queued again`: the name is coming back in ninety minutes and a person does not
    // need three notices about one company. Sent on `out of attempts` precisely because nothing
    // else will ever mention it — that is the whole point of a bound.
    if (verdict === 'queued again') return;

    // Queued, not sent. `lib/notify.ts` returns null with no SMTP_HOST and `ops/SETUP.md` sets
    // none, so nothing leaves the box today — but the notice is a row rather than a lost intention,
    // and agent 4 drains it the day a relay exists.
    const to = t.addedBy
      ? [t.addedBy]
      : (await c.query<{ id: string }>('SELECT id FROM users WHERE disabled_at IS NULL')).rows.map(
          (u) => u.id,
        );
    const gaps = taken.filter((s) => s.outcome === 'gap').length;
    const subject =
      verdict === 'out of attempts'
        ? `${t.symbol} could not be filled in after ${MAX_ATTEMPTS} attempts`
        : gaps > 0
          ? `${t.symbol} is ready, with ${gaps} gap${gaps === 1 ? '' : 's'}`
          : `${t.symbol} is ready`;
    const opening =
      verdict === 'out of attempts'
        ? `${t.name} has NOT been filled in. What broke is below; re-run it by hand with ` +
          `\`pnpm exec tsx jobs/backfill-company.ts --symbol ${t.symbol}\` once it is fixed.`
        : `${t.name} has been filled in.`;

    for (const userId of to) {
      await c.query(
        `INSERT INTO notification_outbox (id, kind, recipient, subject, body)
         VALUES ($1, 'backfill', $2, $3, $4)`,
        [randomBytes(16).toString('hex'), userId, subject, `${opening}\n\n${summary}\n`],
      );
    }
  });

  return verdict;
}

/**
 * Run a step and put it on the record whichever way it goes.
 *
 * Returned rather than logged from here: `lib/` is imported by the web app as well as by `tsx`
 * jobs, and a library that writes to stdout is a library that writes to stdout in a request.
 */
export function stepper(): {
  taken: Step[];
  attempt: (label: string, work: () => Promise<StepResult>) => Promise<Step>;
} {
  const taken: Step[] = [];
  const attempt = async (label: string, work: () => Promise<StepResult>): Promise<Step> => {
    let step: Step;
    try {
      step = { label, ...(await work()) };
    } catch (err) {
      // An exception is always `error`. A step that threw did not get far enough to know whether
      // the exchange has anything for this name, and guessing `gap` here would retire the name on
      // the strength of a network blip.
      step = { label, detail: err instanceof Error ? err.message : String(err), outcome: 'error' };
    }
    taken.push(step);
    return step;
  };
  return { taken, attempt };
}
