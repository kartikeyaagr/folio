/**
 * The forward calendar: board meetings and results dates for followed names.
 *
 * Runs daily. Zero events for the whole exchange is a failure, not a quiet day — the feed is never
 * empty on a working day, so an empty parse means the fetch broke rather than that nothing is
 * scheduled. Zero events *for this book* is entirely normal and says so.
 *
 *   pnpm exec tsx jobs/ingest-calendar.ts
 */
import { fetchCalendar, storeCalendar } from '../lib/ingest/calendar.ts';
import { runJob } from './_run.ts';

await runJob('nse_calendar', async () => {
  const events = await fetchCalendar();
  if (events.length === 0) throw new Error('event calendar returned zero rows');
  const r = await storeCalendar(events);
  return { items: r.stored, detail: `${r.seen} events, ${r.stored} ours, ${r.withdrawn} withdrawn` };
});
