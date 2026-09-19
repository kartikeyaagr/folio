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
import { ingestShareholding } from '../lib/ingest/shareholding.ts';
import { runJob } from './_run.ts';

await runJob('nse_shareholding', async () => {
  const r = await ingestShareholding();
  if (r.submissions === 0) throw new Error('shareholding index returned zero submissions');
  const detail = `${r.submissions} submissions, ${r.ours} ours, ${r.stored} stored, ${r.failed} failed`;
  // Branched on the count, not on whether anything threw. A filing that could not be read is
  // survived so the rest of the index still lands, and then reported — an unreadable filing
  // must not leave a run marked ok.
  if (r.failed > 0) throw new Error(`${r.failed} of ${r.ours} filings could not be read`);
  return { items: r.stored, detail };
});
