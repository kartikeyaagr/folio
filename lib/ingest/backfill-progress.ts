/**
 * How far the backfill queue has got, for `/companies` and a company's own page.
 *
 * `lib/ingest/backfill.ts` decides what a step means and writes `backfill_steps`; this is the one
 * read of it. Kept apart from `company-view.ts` rather than folded in, because this file's whole
 * subject is the backfill job — unlike that one, which the job must not be pulled into just to
 * render a word (see its own docstring).
 */

import { readTxn } from '../db.ts';
import { BACKFILL_STEPS, LEASE_MINUTES, type Outcome } from './backfill.ts';

export interface OverallProgress {
  /** Non-removed followed names whose whole history has arrived. */
  filled: number;
  /** Every non-removed followed name — what the fleet is owed a backfill for, done or not. */
  owed: number;
}

export interface CompanyProgress {
  symbol: string;
  name: string;
  /** The claim that is currently running. */
  attempt: number;
  /** 1-based, out of `BACKFILL_STEPS.length`; 0 if claimed but no step has started writing yet. */
  stepIndex: number;
  stepLabel: string;
  /** Trading days done out of the window being walked. Only the prices step ever sets these. */
  subDone: number | null;
  subTotal: number | null;
  /** This attempt's finished steps, in the order they ran. */
  outcomes: { step: string; outcome: Outcome }[];
}

export interface BackfillProgress {
  overall: OverallProgress;
  /** Every company currently inside a live lease, oldest step data first is not promised — order
   *  follows `claim()`'s own, which is company creation order. */
  running: CompanyProgress[];
}

export async function backfillProgress(): Promise<BackfillProgress> {
  return readTxn(async (c) => {
    const { rows: overallRows } = await c.query<{ filled: string; owed: string }>(
      `SELECT count(*) FILTER (WHERE backfilled_at IS NOT NULL)::text AS filled,
              count(*)::text AS owed
         FROM companies WHERE removed_at IS NULL`,
    );
    const overall: OverallProgress = {
      filled: Number(overallRows[0]!.filled),
      owed: Number(overallRows[0]!.owed),
    };

    // The same lease `claim()` reads, re-stated rather than imported — a read model does not pull
    // in a job's module for a number it can select itself. Agreement is asserted in this module's
    // own test, the way `company-view.ts` and the migration are already checked against `claim()`.
    const { rows: active } = await c.query<{
      id: string; symbol: string; name: string; attempt: number;
    }>(
      `SELECT id, symbol, name, backfill_attempts AS attempt
         FROM companies
        WHERE removed_at IS NULL AND backfilled_at IS NULL
          AND backfill_started_at > now() - ($1 || ' minutes')::interval
        ORDER BY created_at`,
      [String(LEASE_MINUTES)],
    );
    if (active.length === 0) return { overall, running: [] };

    const { rows: steps } = await c.query<{
      companyId: string; attempt: number; step: string; outcome: Outcome | 'running';
      subDone: number | null; subTotal: number | null;
    }>(
      `SELECT company_id AS "companyId", attempt, step, outcome,
              sub_done AS "subDone", sub_total AS "subTotal"
         FROM backfill_steps
        WHERE company_id = ANY($1::text[])
        ORDER BY id`,
      [active.map((a) => a.id)],
    );

    const running = active.map((co): CompanyProgress => {
      const taken = steps.filter((s) => s.companyId === co.id && s.attempt === co.attempt);
      const current = taken.find((s) => s.outcome === 'running') ?? taken[taken.length - 1];
      const index = current
        ? BACKFILL_STEPS.indexOf(current.step as (typeof BACKFILL_STEPS)[number])
        : -1;
      return {
        symbol: co.symbol,
        name: co.name,
        attempt: co.attempt,
        stepIndex: index + 1,
        stepLabel: current?.step ?? 'starting',
        subDone: current?.subDone ?? null,
        subTotal: current?.subTotal ?? null,
        outcomes: taken
          .filter((s): s is typeof s & { outcome: Outcome } => s.outcome !== 'running')
          .map((s) => ({ step: s.step, outcome: s.outcome })),
      };
    });

    return { overall, running };
  });
}
