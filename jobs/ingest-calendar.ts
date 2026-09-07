/**
 * The forward calendar: board meetings and results dates for followed names.
 *
 * Runs daily. Zero events for the whole exchange is a failure, not a quiet day — the feed is never
 * empty on a working day, so an empty parse means the fetch broke rather than that nothing is
 * scheduled. Zero events *for this book* is entirely normal and says so.
 *
 *   pnpm exec tsx jobs/ingest-calendar.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { fetchCalendar, storeCalendar } from '../lib/ingest/calendar.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_calendar') RETURNING id",
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
    const events = await fetchCalendar();
    if (events.length === 0) throw new Error('event calendar returned zero rows');
    const r = await storeCalendar(events);
    await finish('ok', r.stored, `${r.seen} events, ${r.stored} ours, ${r.withdrawn} withdrawn`);
    console.log(`${r.seen} events  ${r.stored} stored  ${r.withdrawn} withdrawn`);
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
