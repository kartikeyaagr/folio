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
import { readTxn } from '../lib/db.ts';
import { fetchBhavcopy, NoBhavcopy, storePrices } from '../lib/ingest/bhavcopy.ts';
import { ingestIndexDay } from '../lib/ingest/indices.ts';
import { NseSession } from '../lib/ingest/nse.ts';
import { readFlags } from './_args.ts';
import { runJob } from './_run.ts';


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const flags = readFlags(['days', 'symbol']);
  const days = Number(flags.str('days') ?? 90);
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive number');

  const only = flags.str('symbol')?.trim().toUpperCase();

  // Which days are already held. Asked once rather than per day: a set membership test beats 1,250
  // round trips to answer a question the database can answer in one.
  //
  // **Scoped to the symbol when one is named.** `storePrices` keeps only followed companies, so a
  // day fetched before a name was followed holds nothing for it — and a global "already held" set
  // would skip exactly the days a newly added company needs. Getting this wrong would make the
  // on-add backfill a no-op that reported success.
  const held = await readTxn(async (c) => {
    const { rows } = await c.query<{ day: string }>(
      `SELECT DISTINCT to_char(p.on_date, 'YYYY-MM-DD') AS day
         FROM prices p
        WHERE $1::text IS NULL OR p.symbol = $1`,
      [only ?? null],
    );
    return new Set(rows.map((r) => r.day));
  });

await runJob('nse_bhavcopy_backfill', async () => {
  // Re-primed rather than opened once. A first run died at "fetch failed" after about seventy
  // requests: NSE drops the cookie, or the connection, partway through a long walk backwards. A
  // Its own held set. Sharing the price one would skip the index file on every day a price already
  // exists for — which, on a book whose prices were backfilled before indices existed, is all of
  // them, and the chart would have a benchmark line starting the day this shipped.
  const heldIndex = await readTxn(async (c) => {
    const { rows } = await c.query<{ day: string }>(
      "SELECT DISTINCT to_char(on_date, 'YYYY-MM-DD') AS day FROM index_levels",
    );
    return new Set(rows.map((r) => r.day));
  });

  // twenty-minute job that has to be restarted by hand is a job nobody runs twice.
  let session = await NseSession.open();
  const today = new Date();
  let traded = 0;
  let quiet = 0;
  let skipped = 0;
  let stored = 0;
  let levels = 0;

  for (let back = 1; back <= days; back++) {
    const on = new Date(today.getTime() - back * 86_400_000);
    const day = on.toISOString().slice(0, 10);
    // Only when BOTH are held. A day whose prices are in and whose index close is not still
    // costs one request, and the alternative is a benchmark that begins the day this shipped.
    if (held.has(day) && heldIndex.has(day)) {
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
      if (!held.has(day)) {
        const rows = await fetchBhavcopy(on, session);
        const out = await storePrices(on, rows);
        stored += out.stored;
      }
      if (!heldIndex.has(day)) {
        levels += (await ingestIndexDay(on, session)).stored;
      }
      traded++;
      if (traded % 25 === 0) {
        console.log(`  ${day}  ${traded} trading days so far, ${stored} closes, ${levels} index closes`);
      }
    } catch (err) {
      // A 404 is a non-trading day and is not retried: the file will not appear on a second ask.
      if (err instanceof NoBhavcopy) {
        quiet++;
        continue;
      }
      // Anything else gets one retry behind a fresh session. Twice in a row on the same day is a
      // real failure and stops the run rather than being counted as a holiday.
      console.error(`  ${day}  ${err instanceof Error ? err.message : String(err)} — re-priming`);
      await sleep(3000);
      session = await NseSession.open();
      try {
        if (!held.has(day)) {
          const rows = await fetchBhavcopy(on, session);
          const out = await storePrices(on, rows);
          stored += out.stored;
        }
        if (!heldIndex.has(day)) {
          levels += (await ingestIndexDay(on, session)).stored;
        }
        traded++;
      } catch (again) {
        if (again instanceof NoBhavcopy) {
          quiet++;
          continue;
        }
        throw again;
      }
    }
    // NSE is being asked for a file a second for twenty minutes. Politeness is cheap and being
    // blocked is not.
    await sleep(400);
  }

  const detail = `${only ?? 'all names'}, ${days} days back: ${traded} trading days fetched, ${stored} closes stored, ${levels} index closes, ${skipped} already held, ${quiet} non-trading`;
  // Every day answering 404 over a long window means the archive moved, not that the exchange
  // shut for a quarter.
  if (traded === 0 && skipped === 0 && quiet > 20) {
    throw new Error(`no bhavcopy found on any of ${quiet} weekdays — the archive has moved`);
  }
  return { items: stored, detail: detail };
});
