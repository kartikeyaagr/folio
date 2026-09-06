/**
 * End of day: prices for every followed name.
 *
 * Runs after the exchange publishes. A weekend or a holiday has no bhavcopy and that is a normal
 * answer, recorded as `ok` with zero items — but a trading day that yields nothing is a failure,
 * because a dead feed must never look like a quiet day.
 *
 *   pnpm exec tsx jobs/ingest-eod.ts            yesterday
 *   pnpm exec tsx jobs/ingest-eod.ts 2026-09-04
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { fetchBhavcopy, NoBhavcopy, storePrices } from '../lib/ingest/bhavcopy.ts';

async function main(): Promise<void> {
  const arg = process.argv[2];
  const on = arg ? new Date(`${arg}T00:00:00Z`) : new Date(Date.now() - 86_400_000);
  const day = on.toISOString().slice(0, 10);

  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_bhavcopy') RETURNING id",
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
    const rows = await fetchBhavcopy(on);
    const { stored } = await storePrices(on, rows);
    await finish('ok', stored, `${day}: ${rows.length} rows, ${stored} followed`);
    console.log(`${day}  ${rows.length} rows  ${stored} stored`);
  } catch (err) {
    if (err instanceof NoBhavcopy) {
      // Not a failure: the exchange did not trade.
      await finish('ok', 0, `${day}: no bhavcopy published`);
      console.log(`${day}  no bhavcopy (weekend, holiday, or not yet published)`);
      return;
    }
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
