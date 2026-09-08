/**
 * Price history, one trading day at a time.
 *
 * There is no per-symbol historical endpoint. Measured 08-Sep-2026: `historical/cm/equity`,
 * `historical/securityArchives` and `historicalOR/generateSecurityWiseHistoricalData` all answer
 * 503 or 500, with and without the Referer that unsticks the insider endpoint. So history is the
 * daily bhavcopy, walked backwards.
 *
 * That is less work than it sounds. **One file carries every symbol**, so a day fetched for one
 * company is fetched for all of them — roughly 250 files a year for the whole book rather than per
 * name. Five years is about 1,250 requests and twenty minutes.
 *
 *   pnpm exec tsx jobs/backfill-prices.ts --days 90     # a quarter
 *   pnpm exec tsx jobs/backfill-prices.ts --days 1825   # five years
 *
 * Skips days already held, so it resumes after an interruption and re-running costs only the
 * fetches it has not made. Weekends and holidays answer 404 and are recorded as the non-trading
 * days they are, not as failures.
 */
import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import { fetchBhavcopy, NoBhavcopy, storePrices } from '../lib/ingest/bhavcopy.ts';
import { NseSession } from '../lib/ingest/nse.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const days = Number(arg('--days') ?? 90);
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive number');

  // Which days are already held. Asked once rather than per day: a set membership test beats 1,250
  // round trips to answer a question the database can answer in one.
  const held = await readTxn(async (c) => {
    const { rows } = await c.query<{ day: string }>(
      "SELECT DISTINCT to_char(on_date, 'YYYY-MM-DD') AS day FROM prices",
    );
    return new Set(rows.map((r) => r.day));
  });

  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_bhavcopy_backfill') RETURNING id",
    );
    return rows[0]!.id;
  });

  const finish = (status: 'ok' | 'failed', items: number, detail: string) =>
    serviceTxn('system:ingest', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [status, items, detail.slice(0, 500), runId],
      );
    });

  try {
    const session = await NseSession.open();
    const today = new Date();
    let traded = 0;
    let quiet = 0;
    let skipped = 0;
    let stored = 0;

    for (let back = 1; back <= days; back++) {
      const on = new Date(today.getTime() - back * 86_400_000);
      const day = on.toISOString().slice(0, 10);
      if (held.has(day)) {
        skipped++;
        continue;
      }
      // Saturday and Sunday never have one. Checked before the request rather than after a 404,
      // because two in seven requests is a lot of politeness to spend on a known answer.
      const dow = on.getUTCDay();
      if (dow === 0 || dow === 6) {
        quiet++;
        continue;
      }

      try {
        const rows = await fetchBhavcopy(on, session);
        const out = await storePrices(on, rows);
        stored += out.stored;
        traded++;
        if (traded % 25 === 0) console.log(`  ${day}  ${traded} trading days so far, ${stored} closes`);
      } catch (err) {
        // Only a 404 reaches here as NoBhavcopy now; anything else is a real failure and stops the
        // run rather than being counted as a holiday.
        if (!(err instanceof NoBhavcopy)) throw err;
        quiet++;
      }
      // NSE is being asked for a file a second for twenty minutes. Politeness is cheap and being
      // blocked is not.
      await sleep(400);
    }

    const detail = `${days} days back: ${traded} trading days fetched, ${stored} closes stored, ${skipped} already held, ${quiet} non-trading`;
    // Every day answering 404 over a long window means the archive moved, not that the exchange
    // shut for a quarter.
    if (traded === 0 && skipped === 0 && quiet > 20) {
      throw new Error(`no bhavcopy found on any of ${quiet} weekdays — the archive has moved`);
    }
    await finish('ok', stored, detail);
    console.log(`\n${detail}`);
  } catch (err) {
    await finish('failed', 0, String(err instanceof Error ? err.message : err));
    throw err;
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
