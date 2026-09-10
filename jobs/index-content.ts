/**
 * Everything the fund holds, made retrievable.
 *
 * **An empty queue is not a failure.** This is the third documented exemption to the
 * zero-items-is-a-failure rule, alongside the bhavcopy on a non-trading day and the news gate's
 * empty queue. It runs every ten minutes and most runs find nothing, because indexing follows
 * people saving documents and jobs ingesting filings rather than a schedule of its own. A dead
 * indexer is caught by the lag figure on /admin, not by this exit code.
 *
 * The narrowing that keeps that exemption honest (see jobs/news-gate.ts's own header for the full
 * argument) applies here too: the exemption is for an EMPTY queue, and only that. A source that
 * was claimed and could not be indexed is not a quiet day — it is a failure, and fails the run.
 *
 *   pnpm exec tsx jobs/index-content.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { drain } from '../lib/retrieval/index.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('index_content') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await drain();
    const detail = `${r.registered} registered, ${r.indexed} indexed, ${r.failed} failed`;
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

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
