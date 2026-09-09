/**
 * Record that a unit failed, and tell somebody.
 *
 * Named by `OnFailure=` on every job, so a failure is noticed by the machine rather than by
 * somebody happening to read the journal.
 *
 * Until now this wrote one `ingestion_runs` row and stopped there, which is a **pull**: the row is
 * visible on `/admin?tab=ops` and nowhere else, so a job that dies at 04:00 waits for an admin to
 * choose to look. `unit_failure` has been a reserved outbox kind since migration 0013 with nothing
 * writing it. It writes it now, so the notice is a queued row rather than a lost intention — and
 * the day a relay exists, `jobs/alerts.ts` drains it without further change.
 *
 * **The failure path must not depend on the thing most likely to be broken.** No fetch, no model,
 * no mail sent from here: two inserts in one transaction and nothing else. If Postgres itself is
 * down neither lands, which is what the heartbeat is for — it is the only signal that survives
 * the database being the thing that failed.
 *
 *   pnpm exec tsx jobs/report-failure.ts trisula-job@ingest-eod.service
 */
import { closePool } from '../lib/db.ts';
import { recordUnitFailure } from '../lib/notify.ts';

async function main(): Promise<void> {
  const unit = process.argv[2] ?? 'unknown';
  const told = await recordUnitFailure(unit);
  console.error(`recorded failure of ${unit}; queued ${told} notice${told === 1 ? '' : 's'}`);
  // Zero recipients is not a crash, but it is not success either: the record exists and nobody is
  // going to be told about it, which is worth a non-zero exit so systemd's own log says so.
  if (told === 0) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    // If even this fails, the journal is the last resort and the heartbeat is what notices.
    console.error('could not record unit failure:', String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
