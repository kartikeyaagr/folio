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
 * **An empty queue is not a failure.** This is one of the documented exemptions to the
 * zero-items-is-a-failure rule — CLAUDE.md carries the roster — and it covers both queues for the
 * same reason. It runs every ten minutes and
 * most runs find nothing, because indexing follows people saving documents, jobs ingesting filings
 * and analysts accepting drafts rather than a schedule of its own. A dead indexer is caught by the
 * lag figure on /admin, not by this exit code.
 *
 * The narrowing that keeps that exemption honest (see jobs/news-gate.ts's own header for the full
 * argument) applies here too: the exemption is for an EMPTY queue, and only that. A source that
 * was claimed and could not be indexed is not a quiet day — it is a failure, and fails the run.
 *
 *   pnpm exec tsx jobs/index-content.ts          one bounded batch (what the ten-minute timer runs)
 *   pnpm exec tsx jobs/index-content.ts --watch   stay up; index within seconds of a save
 *   pnpm exec tsx jobs/index-content.ts --all     loop until the queue is empty — for a human doing
 *                                                  a backfill, never for the timer. Prints progress
 *                                                  per batch: a run over the real corpus is many
 *                                                  minutes of silence otherwise, indistinguishable
 *                                                  from a hang.
 */
import { closePool, listen, readTxn, serviceTxn } from '../lib/db.ts';
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

/**
 * The channel migration `0052` nudges. A statement-level trigger on `documents`,
 * `document_versions` and `attachments` sends one notification per committed transaction.
 */
const CHANNEL = 'trisula_content';

/** Collapse a burst of saves into one pass, and never run two passes at once. */
const SETTLE_MS = 2000;

/**
 * The safety net, and the reason this mode is allowed to exist at all.
 *
 * `NOTIFY` is fire-and-forget: one sent while this process was restarting, or while its socket was
 * down, is gone and nothing replays it. So this is never the thing that guarantees the queue
 * drains — it only makes the common case fast. The durable queue is `indexed_at IS NULL`, and it is
 * swept on this interval regardless of whether anything was heard, which is the same
 * "what has no run yet, never what is new since I last looked" rule the agent sweeps follow.
 */
const SWEEP_MS = 10 * 60 * 1000;

/**
 * Stay up and index within seconds of a save.
 *
 * The ten-minute timer is still what the VM runs and still what guarantees correctness; this is
 * the difference between a spreadsheet being searchable when you switch tabs and being searchable
 * after a coffee. It matters most on a development box, which has no systemd at all and where the
 * indexer had therefore not run for five days.
 *
 * Deliberately not an `ingestion_runs` row per pass. A watcher that wakes on every save would
 * write hundreds of rows a day and bury the timer's runs, which are the ones `/admin`'s lag figure
 * reads. A pass that FAILS is still reported — on stderr, and by the exit code if it keeps failing.
 */
async function watch(): Promise<void> {
  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | undefined;

  const pass = async (why: string): Promise<void> => {
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const r = await untilQueueEmpty(drain, async () => {});
        const embedded = await embedPending();
        if (r.indexed > 0 || r.failed > 0 || embedded > 0) {
          console.log(
            `[${new Date().toISOString().slice(11, 19)}] ${why}: ` +
              `${r.registered} registered, ${r.indexed} indexed, ${r.failed} failed, ` +
              `${embedded} exemplars embedded`,
          );
        }
      } while (again);
    } catch (err) {
      // Logged and swallowed: one bad source must not take down a watcher that is the only thing
      // making the rest of the corpus searchable. The row keeps its `index_error`, and the timer's
      // own run is what turns that into a failed unit and an alert.
      console.error(`[watch] ${String(err instanceof Error ? err.message : err)}`);
    } finally {
      running = false;
    }
  };

  const bump = (why: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void pass(why), SETTLE_MS);
  };

  const stop = await listen(CHANNEL, () => bump('saved'), {
    // Anything committed while the socket was down was never announced. Sweep on reconnect rather
    // than waiting up to ten minutes to discover it.
    onReconnect: () => bump('reconnected'),
  });
  const sweep = setInterval(() => void pass('sweep'), SWEEP_MS);

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      clearInterval(sweep);
      if (timer) clearTimeout(timer);
      void stop().then(closePool).then(() => process.exit(0));
    });
  }

  console.log(
    `watching ${CHANNEL} · indexing ${SETTLE_MS / 1000}s after a save, sweeping every ${SWEEP_MS / 60000}m`,
  );
  await pass('start');
}

async function main(): Promise<void> {
  if (process.argv.includes('--watch')) return watch();
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
