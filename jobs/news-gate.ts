/**
 * Judge the waiting candidates.
 *
 * **The one job in this system permitted to do nothing and call it success.** Everywhere else a
 * zero is a failure, because a dead feed must never look like a quiet day. Here zero means the net
 * caught nothing worth asking about, which on a book this size is most runs. The exemption is
 * documented in the design and is the only one.
 *
 *   pnpm exec tsx jobs/news-gate.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { runGate } from '../lib/news/gate.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:news-gate', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('news_gate') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await runGate();
    const detail =
      `${r.considered} judged: ${r.confirmed} confirmed, ${r.rejected} rejected, ` +
      `${r.failed} failed (${r.ungated} terminal), $${r.costUsd.toFixed(4)}`;
    await serviceTxn('system:news-gate', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        ['ok', r.confirmed, detail, runId],
      );
    });
    console.log(detail);
  } catch (err) {
    await serviceTxn('system:news-gate', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'failed', detail = $2 WHERE id = $1",
        [runId, String(err instanceof Error ? err.message : err).slice(0, 500)],
      );
    });
    throw err;
  }
}

main()
  .catch((err: unknown) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1; })
  .finally(() => closePool());
