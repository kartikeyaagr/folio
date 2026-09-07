/**
 * Record that a unit failed.
 *
 * Named by `OnFailure=` on every job, so a failure is noticed by the machine rather than by
 * somebody happening to read the journal.
 *
 * The failure path must not depend on the thing most likely to be broken, which is why this does
 * as little as possible: one insert, no fetch, no model, no mail. When the notification outbox
 * exists (P6) this will queue there too; until then the row is the record, and the heartbeat is
 * the out-of-band signal for the case where Postgres itself is down.
 *
 *   pnpm exec tsx jobs/report-failure.ts trisula-job@ingest-eod.service
 */
import { closePool, serviceTxn } from '../lib/db.ts';

async function main(): Promise<void> {
  const unit = process.argv[2] ?? 'unknown';
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO ingestion_runs (source, finished_at, status, detail)
       VALUES ($1, now(), 'failed', $2)`,
      [`systemd:${unit}`, 'unit failed; see journalctl -u ' + unit],
    );
  });
  console.error(`recorded failure of ${unit}`);
}

main()
  .catch((err: unknown) => {
    // If even this fails, the journal is the last resort and the heartbeat is what notices.
    console.error('could not record unit failure:', String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
