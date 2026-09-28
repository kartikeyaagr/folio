/**
 * Raise alerts from filings, insider disclosures and prices.
 *
 * Gated on a successful end-of-day ingest for today rather than on the clock: systemd timers are
 * wall clock, not a dependency graph, and a slow bhavcopy would otherwise have this evaluating
 * yesterday's prices while reporting success.
 */
import './_env.ts';

import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import { evaluateFilings, evaluateInsider, evaluatePrices } from '../lib/alerts.ts';

async function main(): Promise<void> {
  const eodRan = await readTxn(async (c) => {
    const { rows } = await c.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM ingestion_runs
          WHERE source = 'nse_bhavcopy' AND status = 'ok'
            AND started_at::date = current_date) AS ok`,
    );
    return rows[0]!.ok;
  });

  const filings = await evaluateFilings();
  const insider = await evaluateInsider();
  // Neither depends on prices, so both are always evaluated. Price moves are skipped rather than
  // computed against stale closes, and the skip is recorded rather than silent.
  const prices = eodRan ? await evaluatePrices() : null;

  await serviceTxn('system:alerts', async (c) => {
    await c.query(
      `INSERT INTO ingestion_runs (source, finished_at, status, items, detail)
       VALUES ('alerts', now(), 'ok', $1, $2)`,
      [
        filings.raised + insider.raised + (prices?.raised ?? 0),
        `filings ${filings.raised}/${filings.considered}, ` +
          `insider ${insider.raised}/${insider.considered}, ` +
          (prices
            ? `prices ${prices.raised}/${prices.considered}`
            : 'prices skipped, no successful eod run today'),
      ],
    );
  });

  console.log(
    `filings ${filings.raised}/${filings.considered}` +
      `  insider ${insider.raised}/${insider.considered}` +
      (prices ? `  prices ${prices.raised}/${prices.considered}` : '  prices skipped (no eod today)'),
  );
}

main()
  .catch((err: unknown) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1; })
  .finally(() => closePool());
