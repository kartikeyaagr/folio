/**
 * Everything a newly followed name owes itself.
 *
 * Adding a company attaches the filings already stored for its symbol — whatever the fourteen-day
 * window happened to catch — and nothing else. This is the rest: its whole announcement history,
 * the documents those announcements point at, the text inside them, its results, its shareholding,
 * and its price series.
 *
 * **Not inside the request.** It is minutes of network calls against four endpoints, and a server
 * action that took four minutes would time out having done part of it with no record of which
 * part. `companies.backfilled_at IS NULL` is the queue, asked as "what has no backfill yet" rather
 * than "what changed since I last looked", so a crash halfway leaves the name unclaimed and the
 * next run takes it again.
 *
 *   pnpm exec tsx jobs/backfill-company.ts                  # everything owed
 *   pnpm exec tsx jobs/backfill-company.ts --symbol TCL     # one, even if already done
 *   pnpm exec tsx jobs/backfill-company.ts --price-days 400
 *
 * Every step is idempotent on its own, so a re-run costs the fetches and changes nothing else.
 * A step that fails does not stop the others: a company with no shareholding filing should still
 * get its prices, and the error is recorded against the name rather than thrown away.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, readTxn, rowId, serviceTxn } from '../lib/db.ts';
import {
  fetchAnnouncementsForSymbol,
  linkAllFollowed,
  storeFilings,
  type Board,
} from '../lib/ingest/filings.ts';
import { fetchAnnualReports, storeAnnualReport } from '../lib/ingest/annual-reports.ts';
import { fetchAttachments } from '../lib/ingest/attachments.ts';
import { fetchAnnouncements, storeAnnouncements, type Board as CaBoard } from '../lib/ingest/corporate-actions.ts';
import { extractPending } from '../lib/ingest/extract.ts';
import { fetchResultsForSymbol, ingestFundamentals } from '../lib/ingest/fundamentals.ts';
import { NseSession } from '../lib/ingest/nse.ts';
import { ingestShareholding } from '../lib/ingest/shareholding.ts';
import { readFlags } from './_args.ts';

const run = promisify(execFile);


interface Target {
  id: string;
  symbol: string;
  name: string;
  platform: string | null;
  addedBy: string | null;
}

/** What each step did, so the notice says what arrived rather than that something did. */
type Step = { label: string; detail: string; ok: boolean };

async function backfill(t: Target, priceDays: number): Promise<Step[]> {
  const steps: Step[] = [];
  const attempt = async (label: string, work: () => Promise<string>): Promise<void> => {
    try {
      steps.push({ label, detail: await work(), ok: true });
    } catch (err) {
      // Recorded and carried on. A company with no shareholding filed yet should still get its
      // prices, and a step that failed is more useful named than swallowed.
      steps.push({ label, detail: err instanceof Error ? err.message : String(err), ok: false });
    }
    console.log(`  ${steps[steps.length - 1]!.ok ? '·' : '!'} ${label}: ${steps[steps.length - 1]!.detail}`);
  };

  await attempt('filings', async () => {
    if (!t.platform) throw new Error('no securities row; refresh the master first');
    const board: Board = t.platform === 'nse_emerge' ? 'nse_sme' : 'nse_equities';
    const { filings, served, skipped } = await fetchAnnouncementsForSymbol(t.symbol, board);
    if (served === 0) throw new Error('the feed returned nothing for this symbol');
    const stored = await storeFilings(filings);
    await linkAllFollowed();
    return `${served} served, ${stored.stored} stored, ${skipped} skipped for want of a seq_id`;
  });

  // A report arrives once a year per name — on a three-name book, one every seventeen weeks. That
  // is the hypothetical a weekly scheduled job would be built for, which the ground rules forbid;
  // this step is the whole reason a name's history is worth fetching once, here, rather than on a
  // timer. One session shared across the symbol's whole filed history (16 years for PRAJIND) and
  // every report in it, rather than a fresh cookie-priming round trip per year.
  //
  // Before 'documents', not after: that step's extractPending sweep reads every attachment with no
  // extracted_text yet, and running it first would leave these newly-stored PDFs unread until
  // whatever backfill happens to touch this company next.
  await attempt('annual reports', async () => {
    if (!t.platform) throw new Error('no securities row; refresh the master first');
    const board = t.platform === 'nse_emerge' ? 'sme' : 'equities';
    const session = await NseSession.open();
    const reports = await fetchAnnualReports(t.symbol, board, session);

    let stored = 0;
    let held = 0;
    let unavailable = 0;
    let failed = 0;
    for (const r of reports) {
      try {
        const state = await serviceTxn('system:ingest', (c) => storeAnnualReport(c, t.id, r, session));
        if (state === 'stored') stored++;
        else if (state === 'held') held++;
        else unavailable++;
      } catch (err) {
        // One bad year — a truncated download, say — should not cost the other fifteen. Recorded
        // and counted rather than aborting the loop; it is retried on the next run since nothing
        // was written to annual_report_attempts for it.
        failed++;
        console.error(`${t.symbol} FY${r.fromYr}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return `${reports.length} offered, ${stored} stored, ${held} already held, ${unavailable} unavailable, ${failed} failed`;
  });

  // After the filings and the annual reports, because it works from what they both point at.
  await attempt('documents', async () => {
    const got = await fetchAttachments(500);
    const read = await extractPending(500);
    return (
      `${got.fetched} fetched, ${got.skipped} already held, ${got.failed} failed; ` +
      `${read.extracted} read, ${read.documents} transcripts, ${read.scanned} scans`
    );
  });

  // Asked by symbol, which is the difference between one quarter and twenty years of them. The
  // feed without a symbol serves only the period just filed.
  await attempt('results', async () => {
    if (!t.platform) throw new Error('no securities row; refresh the master first');
    const board = t.platform === 'nse_emerge' ? 'sme' : 'equities';
    const index = await fetchResultsForSymbol(t.symbol, board);
    if (index.length === 0) throw new Error('the results feed returned nothing for this symbol');
    const r = await ingestFundamentals(index);
    return `${index.length} instances, ${r.parsed} parsed, ${r.stored} periods stored, ${r.failed} failed`;
  });

  // Asked for by symbol, which makes the endpoint serve the name's whole history rather than the
  // window's — PRAJIND answers back to 2015. A company followed today therefore arrives with its
  // bonuses and splits already known, which matters because a split nobody recorded silently
  // misprices every trade before it.
  await attempt('corporate actions', async () => {
    const board: CaBoard = t.platform === 'nse_emerge' ? 'sme' : 'equities';
    const items = await fetchAnnouncements(board, {
      from: '2010-01-01',
      to: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
      symbol: t.symbol,
    });
    if (items.length === 0) throw new Error('the corporate-actions feed returned nothing for this symbol');
    const r = await storeAnnouncements(items);
    const refused = Object.entries(r.declined).sort((a, b) => b[1] - a[1]);
    return (
      `${r.seen} announcements, ${r.stored} stored unconfirmed` +
      (refused.length > 0 ? `, ${refused.reduce((n, [, c]) => n + c, 0)} declined` : '')
    );
  });

  await attempt('shareholding', async () => {
    const r = await ingestShareholding();
    if (r.submissions === 0) throw new Error('the shareholding index returned nothing');
    return `${r.submissions} submissions, ${r.stored} stored`;
  });

  // A separate process on purpose: it is the long one, it re-primes its own NSE session when the
  // exchange drops it, and running it here would put a twenty-minute loop inside a job that has
  // already done four other things worth keeping.
  await attempt('prices', async () => {
    const { stdout } = await run(
      'pnpm',
      ['exec', 'tsx', 'jobs/backfill-prices.ts', '--symbol', t.symbol, '--days', String(priceDays)],
      { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout.trim().split('\n').pop() ?? 'done';
  });

  return steps;
}

async function main(): Promise<void> {
  const flags = readFlags(['symbol', 'price-days']);
  const only = flags.str('symbol')?.trim().toUpperCase();
  const priceDays = Number(flags.str('price-days') ?? 400);
  if (!Number.isFinite(priceDays) || priceDays < 1) throw new Error('--price-days must be positive');

  const targets = await readTxn(async (c) => {
    const { rows } = await c.query<Target>(
      `SELECT co.id, co.symbol, co.name, s.platform, co.added_by AS "addedBy"
         FROM companies co
         LEFT JOIN securities s ON s.symbol = co.symbol
        WHERE ($1::text IS NULL AND co.backfilled_at IS NULL)
           OR co.symbol = $1
        ORDER BY co.created_at`,
      [only ?? null],
    );
    return rows;
  });

  if (targets.length === 0) {
    console.log(only ? `${only} is not a followed company` : 'every followed name has been backfilled');
    return;
  }

  for (const t of targets) {
    console.log(`\n${t.symbol} — ${t.name}`);
    await serviceTxn('system:ingest', async (c) => {
      await c.query('UPDATE companies SET backfill_started_at = now() WHERE id = $1', [t.id]);
    });

    const steps = await backfill(t, priceDays);
    const failed = steps.filter((s) => !s.ok);
    const summary = steps.map((s) => `${s.label}: ${s.detail}`).join('\n');

    await serviceTxn('system:ingest', async (c) => {
      // Marked done even when a step failed. The name is not owed a *second* full sweep because
      // its shareholding has not been filed yet — the error says what is missing, and the ordinary
      // scheduled jobs pick that up when the exchange publishes it. Re-run by name to force one.
      await c.query(
        'UPDATE companies SET backfilled_at = now(), backfill_error = $2 WHERE id = $1',
        [t.id, failed.length > 0 ? failed.map((s) => `${s.label}: ${s.detail}`).join('; ').slice(0, 500) : null],
      );

      // Queued, not sent. `lib/notify.ts` returns null with no SMTP_HOST and `ops/SETUP.md` sets
      // none, so nothing leaves the box today — but the notice is a row rather than a lost
      // intention, and agent 4 drains it the day a relay exists.
      const to = t.addedBy
        ? [t.addedBy]
        : (await c.query<{ id: string }>('SELECT id FROM users WHERE disabled_at IS NULL')).rows.map((u) => u.id);
      for (const userId of to) {
        await c.query(
          `INSERT INTO notification_outbox (id, kind, recipient, subject, body)
           VALUES ($1, 'backfill', $2, $3, $4)`,
          [
            rowId(),
            userId,
            failed.length > 0
              ? `${t.symbol} is ready, with ${failed.length} gap${failed.length === 1 ? '' : 's'}`
              : `${t.symbol} is ready`,
            `${t.name} has been filled in.\n\n${summary}\n`,
          ],
        );
      }
    });
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
