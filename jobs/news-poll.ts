/**
 * Poll the feeds and cast the net.
 *
 * Polling and matching run together because they are one thought: a headline nobody has looked at
 * yet is not news. Splitting them into two timers would only create a window in which the system
 * holds a story and has not considered it.
 *
 *   pnpm exec tsx jobs/news-poll.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { pollFeeds } from '../lib/news/poll.ts';
import { matchNewItems } from '../lib/news/match.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:news', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('news_poll') RETURNING id",
    );
    return rows[0]!.id;
  });

  const finish = (status: 'ok' | 'failed', items: number, detail: string) =>
    serviceTxn('system:news', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [status, items, detail, runId],
      );
    });

  try {
    const poll = await pollFeeds();
    // Every feed failing is a network or DNS problem. One feed failing is a fact about that feed,
    // and it is recorded on the feed's own row rather than drowned in a total.
    if (poll.feeds > 0 && poll.ok === 0) {
      throw new Error(`all ${poll.feeds} feeds failed: ${poll.failures[0]?.error ?? 'unknown'}`);
    }
    const match = await matchNewItems();
    const detail =
      `${poll.ok}/${poll.feeds} feeds, ${poll.stored} new items, ` +
      `${match.candidates} candidates from ${match.items} examined` +
      (poll.failures.length > 0 ? `; failing: ${poll.failures.map((f) => f.key).join(', ')}` : '');
    await finish('ok', poll.stored, detail.slice(0, 500));
    console.log(detail);
  } catch (err) {
    await finish('failed', 0, String(err instanceof Error ? err.message : err).slice(0, 500));
    throw err;
  }
}

main()
  .catch((err: unknown) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1; })
  .finally(() => closePool());
