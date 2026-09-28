/**
 * Refresh the NSE security master. Bootstrap step 4, and nothing can add a company before it runs.
 *
 *   pnpm exec tsx jobs/refresh-securities.ts
 */
import './_env.ts';

import { closePool, serviceTxn } from '../lib/db.ts';
import { refreshSecurities } from '../lib/ingest/securities.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_security_master') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await refreshSecurities();
    await serviceTxn('system:ingest', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'ok', items = $1, detail = $2 WHERE id = $3",
        [r.fetched, `${r.changed} changed, ${r.delisted} delisted`, runId],
      );
    });
    console.log(`fetched ${r.fetched}  changed ${r.changed}  delisted ${r.delisted}`);
  } catch (err) {
    const detail = String(err instanceof Error ? err.message : err).slice(0, 500);
    await serviceTxn('system:ingest', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'failed', detail = $1 WHERE id = $2",
        [detail, runId],
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
