/**
 * Insider and pledge disclosures, one call per followed name.
 *
 * Zero rows across every followed company is not a failure — a two-name book can genuinely have no
 * disclosures. Zero *companies* is, because it means the loop had nothing to iterate and the run
 * would otherwise report success having done nothing.
 *
 *   pnpm exec tsx jobs/ingest-insider.ts
 */
import { ingestInsider } from '../lib/ingest/insider.ts';
import { runJob } from './_run.ts';

await runJob('nse_insider', async () => {
  const r = await ingestInsider();
  if (r.companies === 0) throw new Error('no companies to fetch disclosures for');
  return { items: r.stored, detail: `${r.companies} companies, ${r.stored} disclosures` };
});
