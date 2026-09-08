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
import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import { fetchBhavcopy, NoBhavcopy, storePrices } from '../lib/ingest/bhavcopy.ts';

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

async function main(): Promise<void> {
  const arg = process.argv[2];
  const days = arg ? [arg] : await missingDays();
  if (days.length === 0) {
    console.log('every trading day up to yesterday already has closes');
    return;
  }

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
    let stored = 0;
    let traded = 0;
    const quiet: string[] = [];

    for (const day of days) {
      const on = new Date(`${day}T00:00:00Z`);
      try {
        const rows = await fetchBhavcopy(on);
        const out = await storePrices(on, rows);
        stored += out.stored;
        traded++;
        console.log(`${day}  ${rows.length} rows  ${out.stored} stored`);
      } catch (err) {
        // The one exemption, and it is now narrow: only a 404 from the archive reaches here, so a
        // weekend and a dead host are no longer the same answer. Everything else falls through to
        // the outer catch and fails the run.
        if (!(err instanceof NoBhavcopy)) throw err;
        quiet.push(day);
        console.log(`${day}  no bhavcopy (weekend, holiday, or not yet published)`);
      }
    }

    // Every requested day being quiet is ordinary over a weekend and suspicious over a fortnight.
    // The count is recorded either way so the run says which it was rather than leaving a reader
    // to infer it from a zero.
    const detail =
      `${days[0]}..${days[days.length - 1]}: ${traded} trading day(s), ${stored} closes stored` +
      (quiet.length > 0 ? `, ${quiet.length} with no bhavcopy (${quiet.join(', ')})` : '');
    await finish('ok', stored, detail);
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
