/**
 * Insider and pledge disclosures, one call per followed name.
 *
 * Zero rows across every followed company is not a failure — a two-name book can genuinely have no
 * disclosures. Zero *companies* is, because it means the loop had nothing to iterate and the run
 * would otherwise report success having done nothing.
 *
 *   pnpm exec tsx jobs/ingest-insider.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { ingestInsider } from '../lib/ingest/insider.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_insider') RETURNING id",
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
    const r = await ingestInsider();
    if (r.companies === 0) throw new Error('no companies to fetch disclosures for');
    await finish('ok', r.stored, `${r.companies} companies, ${r.stored} disclosures`);
    console.log(`${r.companies} companies  ${r.stored} disclosures`);
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
