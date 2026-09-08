/**
 * Exchange announcements, through the day.
 *
 * A 14-day window every run rather than a cursor. NSE's seq_id is stable so an overlapping window
 * is an upsert, which means there is no high-water mark to drift and nothing to reset after
 * downtime. A watermark can be wrong in both directions silently; this cannot.
 *
 *   pnpm exec tsx jobs/ingest-intraday.ts [days]
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { fetchAnnouncements, storeFilings, linkAllFollowed } from '../lib/ingest/filings.ts';

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? 14);
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_announcements') RETURNING id",
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
    const filings = await fetchAnnouncements(days);
    // A feed that parses but returns nothing is a failure, not a quiet day.
    if (filings.length === 0) throw new Error('announcement feed returned zero rows');
    const r = await storeFilings(filings);
    // Attach anything that arrived before its company was followed. storeFilings can only link a
    // row the feed re-serves, so without this an orphaned filing stays orphaned — which is how
    // 11,053 rows came to carry 7 company_ids. Idempotent, so it runs every time.
    const linked = await linkAllFollowed();
    await finish('ok', r.stored, `${r.stored} stored, ${r.ours} for followed names, ${linked} back-linked`);
    console.log(`${r.seen} announcements  ${r.stored} stored  ${r.ours} ours  ${linked} back-linked`);
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
