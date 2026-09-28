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
import './_env.ts';

import { closePool, readTxn } from '../lib/db.ts';
import { fetchBhavcopy, NoBhavcopy, storePrices } from '../lib/ingest/bhavcopy.ts';
import { ingestIndexDay } from '../lib/ingest/indices.ts';
import { runJob } from './_run.ts';

/**
 * Every day from the last one we hold a close for, up to yesterday.
 *
 * The job used to ask for yesterday and nothing else, against a Mon..Fri timer — so Monday fetched
 * Sunday, Tuesday fetched Monday, and **Friday's close was fetched by no scheduled run on any
 * day**. `lib/alerts.ts` compares against the previous stored row rather than the calendar, so the
 * gap did not announce itself: it showed up as a Monday alert describing a three-session move.
 *
 * Asks "which day has no close yet" rather than "what is new since yesterday", so it heals a gap
 * left by an outage instead of stepping over it. Capped, because a fresh database has no prices at
 * all and this is a catch-up, not a backfill.
 */
const MAX_CATCH_UP = 10;

async function missingDays(): Promise<string[]> {
  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ day: string }>(
      `WITH last AS (SELECT max(on_date) AS d FROM prices)
       SELECT to_char(g, 'YYYY-MM-DD') AS day
         FROM last,
              generate_series(
                COALESCE(last.d + 1, (current_date - 1)),
                current_date - 1,
                interval '1 day'
              ) AS g
        ORDER BY g DESC
        LIMIT $1`,
      [MAX_CATCH_UP],
    );
    return rows;
  });
  return rows.map((r) => r.day).reverse();
}

const arg = process.argv[2];
const days = arg ? [arg] : await missingDays();

if (days.length === 0) {
  // No run row is opened at all. A caught-up job did no work, and an `ingestion_runs` row for a
  // day this job did not work is a run a downstream reader could gate on — `jobs/alerts.ts` waits
  // on a successful EOD ingest *for today*, so a vacuous success is worse than no row.
  console.log('every trading day up to yesterday already has closes');
  await closePool();
} else {
  await runJob('nse_bhavcopy', async () => {
    let stored = 0;
    let traded = 0;
    let levels = 0;
    const renamed = new Set<string>();
    const quiet: string[] = [];

    for (const day of days) {
      const on = new Date(`${day}T00:00:00Z`);
      try {
        const rows = await fetchBhavcopy(on);
        const out = await storePrices(on, rows);
        stored += out.stored;
        traded++;

        // The same trading day from the same archive host, so it belongs in the same loop rather
        // than in a job of its own with a timer of its own that can drift out of step. A day with
        // a bhavcopy and no index close is the archive being incomplete, not a holiday — it falls
        // through to the outer catch and fails the run, exactly as a missing bhavcopy would.
        const idx = await ingestIndexDay(on);
        levels += idx.stored;
        for (const m of idx.missing) renamed.add(m);

        console.log(`${day}  ${rows.length} rows  ${out.stored} stored  ${idx.stored} index closes`);
      } catch (err) {
        // The one exemption, and it is exactly one: a day with no bhavcopy. `NoIndexFile` was
        // caught here too until 21-Sep-2026, which contradicted the paragraph above — it marked
        // the day quiet and printed "no bhavcopy" for a day that had one.
        //
        // The ordering is what makes removing it safe. `fetchBhavcopy` runs first, so on a weekend
        // or a holiday it throws `NoBhavcopy` and `ingestIndexDay` is never reached. `NoIndexFile`
        // can therefore only fire on a day that genuinely traded and stored its prices — the
        // archive being incomplete, which is a failure and not a holiday, and which was being
        // counted into `quiet` and reported as one.
        if (!(err instanceof NoBhavcopy)) throw err;
        quiet.push(day);
        console.log(`${day}  no bhavcopy (weekend, holiday, or not yet published)`);
      }
    }

    // Every requested day being quiet is ordinary over a weekend and suspicious over a fortnight.
    // The count is recorded either way so the run says which it was rather than leaving a reader
    // to infer it from a zero.
    // An index in INDICES that the file stopped carrying is a rename, not an absence — NSE renamed
    // Nifty Smallcap to Nifty Smallcap 250 once already. Named here so it reads as a thing to fix
    // rather than as a chart that quietly flattens.
    const detail =
      `${days[0]}..${days[days.length - 1]}: ${traded} trading day(s), ${stored} closes stored, ` +
      `${levels} index closes` +
      (renamed.size > 0 ? `; NOT IN THE FILE: ${[...renamed].join(', ')}` : '') +
      (quiet.length > 0 ? `, ${quiet.length} with no bhavcopy (${quiet.join(', ')})` : '');
    return { items: stored, detail };
  });
}
