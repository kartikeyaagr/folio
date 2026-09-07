/**
 * Quarterly shareholding for followed names that have filed.
 *
 * Runs daily against a quarterly fact, deliberately. The index is a feed of recent submissions, so
 * a company appears on the day it files and disappears again; polling daily is how a filing is
 * caught without knowing when it will arrive. Most runs store nothing, which is the normal outcome
 * and not a failure. An empty *index* is a failure: it is never empty on a working day.
 *
 *   pnpm exec tsx jobs/ingest-shareholding.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { ingestShareholding } from '../lib/ingest/shareholding.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_shareholding') RETURNING id",
    );
    return rows[0]!.id;
  });

  const finish = (status: 'ok' | 'failed', items: number, detail: string) =>
    serviceTxn('system:ingest', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [status, items, detail, runId],
      );
    });

  try {
    const r = await ingestShareholding();
    if (r.submissions === 0) throw new Error('shareholding index returned zero submissions');
    await finish('ok', r.stored, `${r.submissions} submissions, ${r.ours} ours, ${r.stored} stored`);
    console.log(`${r.submissions} submissions  ${r.ours} ours  ${r.stored} stored`);
  } catch (err) {
    await finish('failed', 0, String(err instanceof Error ? err.message : err).slice(0, 500));
    throw err;
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
