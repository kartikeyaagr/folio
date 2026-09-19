/**
 * The frame every scheduled job runs inside.
 *
 * Seventeen jobs opened an `ingestion_runs` row, defined the same `finish()` closure over it, wrapped
 * their work in the same try/catch, and ended with the same `main().catch().finally(closePool)`.
 * Ten of them spelled `finish()` character for character.
 *
 * That is worth collapsing for a reason beyond the line count. `ingestion_runs` is the structured
 * log — `ARCHITECTURE.md` §8: *"downstream readers gate on that row rather than on the clock"*, and
 * `jobs/alerts.ts` runs only after a successful EOD ingest for **today**. A job that throws before
 * reaching its own `finish('failed', …)` leaves the row `running` forever, and a reader gating on it
 * waits for a run that already died. Here the row is closed in a `finally`, so there is no path out
 * of `runJob` that leaves one open.
 *
 * What a job still owns: what counts as failure. Throwing fails the run. Returning normally passes
 * it — which is how the six documented exemptions to *"zero items is a failure"* express themselves,
 * each one arguing its case in its own file.
 */

import { closePool, serviceTxn } from '../lib/db.ts';

export interface RunOutcome {
  /** `ingestion_runs.items`. The count a downstream reader gates on. */
  items: number;
  /** One line for `/admin?tab=ops` and for the journal. Truncated to the column's 500. */
  detail: string;
}

/**
 * Open a run, do the work, close the run, close the pool.
 *
 * `source` is the `ingestion_runs.source` key the readers look for, so it is the job's identity
 * rather than its filename.
 */
export async function runJob(source: string, work: () => Promise<RunOutcome>): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO ingestion_runs (source) VALUES ($1) RETURNING id',
      [source],
    );
    return rows[0]!.id;
  });

  const finish = (status: 'ok' | 'failed', items: number, detail: string) =>
    serviceTxn('system:ingest', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [status, items, detail.slice(0, 500), runId],
      );
    });

  try {
    const out = await work();
    await finish('ok', out.items, out.detail);
    console.log(out.detail);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err);
    // Recorded before it is reported, so the row is closed even if the console write is the thing
    // that fails. `OnFailure=` on the unit turns the non-zero exit into somebody being told.
    await finish('failed', 0, message);
    console.error(message);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
