/**
 * Everything the fund holds, made retrievable.
 *
 * **Two queues, one loaded model.** Sources waiting to be chunked, and exemplars waiting to have
 * their situation embedded. `v4.md §10` asks for both here rather than in two jobs "because both
 * are the same operation against the same loaded model, and loading a 130MB model twice on a
 * schedule is the kind of waste that is invisible until it is not". `embed()` caches its session at
 * module scope, so one process doing both work items loads the model once — being one process is
 * the whole mechanism.
 *
 * **An empty queue is not a failure.** This is the third documented exemption to the
 * zero-items-is-a-failure rule, alongside the bhavcopy on a non-trading day and the news gate's
 * empty queue, and it now covers both queues for the same reason. It runs every ten minutes and
 * most runs find nothing, because indexing follows people saving documents, jobs ingesting filings
 * and analysts accepting drafts rather than a schedule of its own. A dead indexer is caught by the
 * lag figure on /admin, not by this exit code.
 *
 * The narrowing that keeps that exemption honest (see jobs/news-gate.ts's own header for the full
 * argument) applies here too: the exemption is for an EMPTY queue, and only that. A source that
 * was claimed and could not be indexed is not a quiet day — it is a failure, and fails the run.
 *
 *   pnpm exec tsx jobs/index-content.ts          one bounded batch (what the ten-minute timer runs)
 *   pnpm exec tsx jobs/index-content.ts --all     loop until the queue is empty — for a human doing
 *                                                  a backfill, never for the timer. Prints progress
 *                                                  per batch: a run over the real corpus is many
 *                                                  minutes of silence otherwise, indistinguishable
 *                                                  from a hang.
 */
import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import { drain, type DrainResult } from '../lib/retrieval/index.ts';
import { embedPending } from '../lib/agents/exemplars.ts';

/** Sources still waiting to be claimed — queried only to print `--all`'s progress line. */
async function remaining(): Promise<number> {
  const { rows } = await readTxn((c) =>
    c.query<{ n: number }>('SELECT count(*)::int AS n FROM sources WHERE indexed_at IS NULL'),
  );
  return rows[0]!.n;
}

/**
 * Call `step` (`drain`, in production) until a batch indexes nothing new, accumulating totals and
 * reporting the running total through `onBatch` after every call.
 *
 * **Why `r.indexed === 0` and not `r.indexed === 0 && r.failed === 0`.** A row that fails keeps
 * `indexed_at IS NULL` — `drain` records `index_error` but never sets `indexed_at` on failure — so
 * it is reclaimed by the very next `ORDER BY id LIMIT` claim. Stopping only on a literally empty
 * claim would spin forever the moment a single source is permanently unindexable, because the
 * claim would then never again return zero rows. Stopping as soon as a batch makes no forward
 * progress is both sufficient (the same doomed rows would just come back and fail again) and safe
 * (healthy rows behind a stuck one are still claimed alongside it, because the claim always pulls
 * the lowest available ids — a stuck row never blocks the ones behind it, it only rides along).
 */
export async function untilQueueEmpty(
  step: () => Promise<DrainResult>,
  onBatch: (totals: DrainResult) => void | Promise<void>,
): Promise<DrainResult> {
  const totals: DrainResult = { registered: 0, indexed: 0, failed: 0 };
  for (;;) {
    const r = await step();
    totals.registered += r.registered;
    totals.indexed += r.indexed;
    totals.failed += r.failed;
    await onBatch(totals);
    if (r.indexed === 0) break;
  }
  return totals;
}

async function drainAll(): Promise<DrainResult> {
  return untilQueueEmpty(drain, async (totals) => {
    const left = await remaining();
    console.log(
      `indexed ${totals.indexed} of ${totals.indexed + left}` +
        (totals.failed > 0 ? `, ${totals.failed} failed` : ''),
    );
  });
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');

  const runId = await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('index_content') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = all ? await drainAll() : await drain();

    // The second queue, in the same process and therefore against the same loaded model. Run after
    // the sources rather than before: a source batch is the larger job and the one a backfill is
    // waiting on, and an exemplar accepted while it ran is caught by the next run either way.
    //
    // `--all` loops it too, for the same reason it loops sources: a backfill over a corpus that has
    // been accumulating should finish, not stop at one batch.
    let embedded = 0;
    for (;;) {
      const n = await embedPending();
      embedded += n;
      if (n === 0 || !all) break;
    }

    const detail =
      `${r.registered} registered, ${r.indexed} indexed, ${r.failed} failed, ` +
      `${embedded} exemplars embedded`;
    // Written before the possible throw below, so a claimed-and-failed run still records the real
    // tally rather than just the error that follows it — the catch block's COALESCE keeps this.
    await serviceTxn('system:index', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [r.failed > 0 ? 'failed' : 'ok', r.indexed, detail, runId],
      );
    });
    console.log(detail);
    if (r.failed > 0) {
      throw new Error(`${r.failed} source(s) failed to index`);
    }
  } catch (err) {
    await serviceTxn('system:index', async (c) => {
      await c.query(
        `UPDATE ingestion_runs
            SET finished_at = now(), status = 'failed', detail = COALESCE(detail, $2)
          WHERE id = $1`,
        [runId, String(err instanceof Error ? err.message : err).slice(0, 500)],
      );
    });
    throw err;
  }
}

// Guarded so a test can import `untilQueueEmpty` above without also running the job — same
// pattern as db/migrate.ts's own `invokedDirectly` check, for the same reason.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  main()
    .catch((err: unknown) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
