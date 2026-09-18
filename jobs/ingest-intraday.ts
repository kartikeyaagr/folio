/**
 * Exchange announcements, through the day.
 *
 * A 14-day window every run rather than a cursor. NSE's seq_id is stable so an overlapping window
 * is an upsert, which means there is no high-water mark to drift and nothing to reset after
 * downtime. A watermark can be wrong in both directions silently; this cannot.
 *
 *   pnpm exec tsx jobs/ingest-intraday.ts [days]
 */
import { fetchAnnouncements, storeFilings, linkAllFollowed } from '../lib/ingest/filings.ts';
import { runJob } from './_run.ts';

  const days = Number(process.argv[2] ?? 14);
await runJob('nse_announcements', async () => {
  const filings = await fetchAnnouncements(days);
  // A feed that parses but returns nothing is a failure, not a quiet day.
  if (filings.length === 0) throw new Error('announcement feed returned zero rows');
  const r = await storeFilings(filings);
  // Attach anything that arrived before its company was followed. storeFilings can only link a
  // row the feed re-serves, so without this an orphaned filing stays orphaned — which is how
  // 11,053 rows came to carry 7 company_ids. Idempotent, so it runs every time.
  const linked = await linkAllFollowed();
  return { items: r.stored, detail: `${r.stored} stored, ${r.ours} for followed names, ${linked} back-linked` };
});
