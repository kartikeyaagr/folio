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
 * part. So it is a queue, drained on a ten-minute timer, asked as "what has no backfill yet" rather
 * than "what changed since I last looked" — a crash halfway leaves the name unclaimed and the next
 * run takes it again.
 *
 *   pnpm exec tsx jobs/backfill-company.ts                  # everything owed
 *   pnpm exec tsx jobs/backfill-company.ts --symbol TCL     # one, even if already done
 *   pnpm exec tsx jobs/backfill-company.ts --price-days 400
 *
 * Every step is idempotent on its own, so a re-run costs the fetches and changes nothing else. A
 * step that fails does not stop the others: a company with no shareholding filed yet should still
 * get its prices.
 *
 * **What a step returns is the whole design, and `lib/ingest/backfill.ts` holds it.** A step ends
 * `ok`, `nothingFiled` (the exchange has nothing for this name) or `broke` (we could not do it),
 * and only the last keeps the name in the queue. Until 17-Sep-2026 this file had two outcomes and
 * decided between them by whether the step threw — which three of the seven steps never do, because
 * they count their own failures and return a sentence. `5 offered, 0 stored, 5 failed` was a
 * success and the name was then marked done forever. Each step below says which of the three it is
 * returning and why.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import {
  broke,
  claim,
  did,
  nothingFiled,
  owed,
  record,
  stepper,
  type Step,
  type StepResult,
  type Target,
} from '../lib/ingest/backfill.ts';
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

const run = promisify(execFile);

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * How many rows this one name ended up with.
 *
 * Two steps have no per-name endpoint to assert on — shareholding runs a global ingest, prices walk
 * a bhavcopy carrying every symbol — so what each of them actually achieved *for this company* is a
 * question only the database can answer, and both used to skip asking it.
 */
const count = (sql: string, arg: string): Promise<number> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(sql, [arg]);
    return Number(rows[0]!.n);
  });

const SHP = 'SELECT count(*)::text AS n FROM shareholding_patterns WHERE company_id = $1';
const CLOSES = 'SELECT count(*)::text AS n FROM prices WHERE symbol = $1';

/**
 * Documents, drained for this name rather than sampled from everyone's.
 *
 * 200 per round because that is `fetchAttachments`' own default and one NSE archive request per
 * document; 25 rounds because the largest name on the book (PRAJIND) has 845 filings and the bound
 * exists to stop a runaway, not to cap real work.
 *
 * **The loop ends on no progress, never on an empty queue.** A scanned PDF raises `NoTextInPdf` and
 * deliberately keeps a null `extracted_text` — "visibly unread rather than invisibly empty" — so it
 * is pending forever by design, and a filing whose URL 404s keeps a null sha for the same reason.
 * Either would spin here against a queue that never drains. `scanned` is therefore not counted as
 * progress; `skipped` is, because the filing still gets its sha and leaves the fetch queue.
 */
const DOC_BATCH = 200;
const DOC_ROUNDS = 25;

async function documents(companyId: string): Promise<StepResult> {
  let fetched = 0, held = 0, read = 0, made = 0, scans = 0, failed = 0;
  for (let round = 0; round < DOC_ROUNDS; round++) {
    const got = await fetchAttachments(DOC_BATCH, companyId);
    const out = await extractPending(DOC_BATCH, companyId);
    fetched += got.fetched; held += got.skipped; failed += got.failed + out.failed;
    read += out.extracted; made += out.documents; scans += out.scanned;
    if (got.fetched + got.skipped + out.extracted === 0) break;
  }
  const line =
    `${fetched} fetched, ${held} already held, ${read} read, ` +
    `${made} transcripts, ${scans} scans, ${failed} failed`;
  // Every one of 93 attachments failing on an unwritable store used to read as a success here.
  if (failed > 0) return broke(line);
  // A name whose announcements point at no document at all. Not a break: an SME that files only
  // XBRL has nothing to fetch, and there is nothing to retry.
  if (fetched + held + read === 0) return nothingFiled('no attachment is pending for this name');
  return did(line);
}

async function backfill(t: Target, priceDays: number): Promise<Step[]> {
  const { taken, attempt } = stepper();
  const mark = { ok: '·', gap: '~', error: '!' } as const;
  const say = (s: Step): void => console.log(`  ${mark[s.outcome]} ${s.label}: ${s.detail}`);

  // A missing securities row is a fact about us, not about the company: the master is stale and
  // refreshing it fixes every name at once. Thrown, so it is `error` and the name stays queued.
  const board = <T extends string>(sme: T, main: T): T => {
    if (!t.platform) throw new Error('no securities row; refresh the master first');
    return t.platform === 'nse_emerge' ? sme : main;
  };

  say(await attempt('filings', async () => {
    const { filings, served, skipped } = await fetchAnnouncementsForSymbol(
      t.symbol, board<Board>('nse_sme', 'nse_equities'),
    );
    // A listed name always has announcements. Zero is the feed, so it is `error` and comes back.
    if (served === 0) return broke('the announcements feed returned nothing for this symbol');
    const stored = await storeFilings(filings);
    await linkAllFollowed();
    return did(`${served} served, ${stored.stored} stored, ${skipped} skipped for want of a seq_id`);
  }));

  // A report arrives once a year per name — on a three-name book, one every seventeen weeks. That
  // is the hypothetical a weekly scheduled job would be built for, which the ground rules forbid;
  // this step is the whole reason a name's history is worth fetching once, here, rather than on a
  // timer. One session shared across the symbol's whole filed history (16 years for PRAJIND) and
  // every report in it, rather than a fresh cookie-priming round trip per year.
  //
  // Before 'documents', not after: that step's extractPending sweep reads every attachment with no
  // extracted_text yet, and running it first would leave these newly-stored PDFs unread until
  // whatever backfill happens to touch this company next.
  say(await attempt('annual reports', async () => {
    const session = await NseSession.open();
    const reports = await fetchAnnualReports(t.symbol, board('sme', 'equities'), session);
    if (reports.length === 0) {
      return nothingFiled('NSE lists no annual report for this name');
    }

    let stored = 0, held = 0, unavailable = 0, failed = 0;
    for (const r of reports) {
      try {
        const state = await serviceTxn('system:ingest', (c) => storeAnnualReport(c, t.id, r, session));
        if (state === 'stored') stored++;
        else if (state === 'held') held++;
        else unavailable++;
      } catch (err) {
        // One bad year — a truncated download, say — should not cost the other fifteen. Counted
        // rather than aborting the loop, and the count is what makes the step `error` below: it is
        // retried on the next attempt since nothing was written to annual_report_attempts for it.
        failed++;
        console.error(`${t.symbol} FY${r.fromYr}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const line = `${reports.length} offered, ${stored} stored, ${held} already held, ${unavailable} unavailable, ${failed} failed`;
    if (failed > 0) return broke(line);
    // `unavailable` is NSE offering a year it cannot serve; the attempt is recorded so it is not
    // asked for again, which makes it a gap rather than something to retry.
    return stored + held === 0 ? nothingFiled(line) : did(line);
  }));

  // After the filings and the annual reports, because it works from what they both point at.
  say(await attempt('documents', () => documents(t.id)));

  // Asked by symbol, which is the difference between one quarter and twenty years of them. The
  // feed without a symbol serves only the period just filed.
  say(await attempt('results', async () => {
    const index = await fetchResultsForSymbol(t.symbol, board('sme', 'equities'));
    // A name on the exchange has filed results. Zero is the feed, not the company.
    if (index.length === 0) return broke('the results feed returned nothing for this symbol');
    const r = await ingestFundamentals(index);
    return did(`${index.length} instances, ${r.parsed} parsed, ${r.stored} periods stored, ${r.failed} failed`);
  }));

  // Asked for by symbol, which makes the endpoint serve the name's whole history rather than the
  // window's — PRAJIND answers back to 2015. A company followed today therefore arrives with its
  // bonuses and splits already known, which matters because a split nobody recorded silently
  // misprices every trade before it.
  say(await attempt('corporate actions', async () => {
    const items = await fetchAnnouncements(board<CaBoard>('sme', 'equities'), {
      from: '2010-01-01',
      to: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
      symbol: t.symbol,
    });
    // A gap, not a break, and the one step where that is a real answer: a company that has never
    // paid a dividend, split or issued a bonus has no corporate actions to serve. TCL has answered
    // empty since 11-Sep-2026. Calling it `error` would hold the name in the queue for three
    // attempts and then retire it, over a feed telling the truth.
    if (items.length === 0) return nothingFiled('the corporate-actions feed has nothing for this symbol');
    const r = await storeAnnouncements(items);
    const refused = Object.entries(r.declined).sort((a, b) => b[1] - a[1]);
    return did(
      `${r.seen} announcements, ${r.stored} stored unconfirmed` +
        (refused.length > 0 ? `, ${refused.reduce((n, [, c]) => n + c, 0)} declined` : ''),
    );
  }));

  // **The only step with no per-symbol endpoint.** `corporate-share-holdings-master` is an index of
  // *recent submissions* across both boards, so this runs the ordinary global ingest and then asks
  // what this name ended up holding. It used to assert on `r.submissions` — the size of the whole
  // exchange index — which cannot be zero while NSE is up, so the step could not fail for the
  // company it names. Measured 17-Sep-2026: AERON and TCL were both marked backfilled with no
  // error and neither has a single row in `shareholding_patterns`.
  say(await attempt('shareholding', async () => {
    const before = await count(SHP, t.id);
    const r = await ingestShareholding();
    const after = await count(SHP, t.id);
    if (r.submissions === 0) return broke('the shareholding index returned nothing at all');
    if (after === 0) {
      return nothingFiled(
        `none of the ${r.submissions} recent submissions is this name; the index carries recent ` +
          'quarters only, so a pattern arrives when the company next files',
      );
    }
    return did(`${after - before} new, ${after} quarters held, ${r.submissions} in the index`);
  }));

  // A separate process on purpose: it is the long one, it re-primes its own NSE session when the
  // exchange drops it, and running it here would put a twenty-minute loop inside a job that has
  // already done five other things worth keeping.
  say(await attempt('prices', async () => {
    const { stdout } = await run(
      'pnpm',
      ['exec', 'tsx', 'jobs/backfill-prices.ts', '--symbol', t.symbol, '--days', String(priceDays)],
      { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 },
    );
    const line = stdout.trim().split('\n').pop() ?? 'done';
    // The subprocess walks the bhavcopy, which carries every symbol, so it can exit 0 having stored
    // nothing for *this* one — the no-op that reports success `backfill-prices.ts` warns about in
    // its own `held` comment. A followed name with no close in the whole window is us or a
    // suspension, either of which is worth another attempt and then a notice.
    const closes = await count(CLOSES, t.symbol);
    if (closes === 0) return broke(`${line} — and no close is held for ${t.symbol}`);
    return did(`${line}; ${closes} closes held`);
  }));

  return taken;
}

async function main(): Promise<void> {
  const only = arg('--symbol')?.trim().toUpperCase();
  const priceDays = Number(arg('--price-days') ?? 400);
  if (!Number.isFinite(priceDays) || priceDays < 1) throw new Error('--price-days must be positive');

  const targets = await claim(only);
  if (targets.length === 0) {
    if (only) return console.log(`${only} is not a followed company`);
    // An empty claim is this job's documented quiet day — but only one of its three causes is. A
    // name being filled in right now by the previous tick, and a name out of attempts, are both
    // invisible to the claim and neither is finished. Counted rather than assumed.
    const { leased, exhausted } = await owed();
    return console.log(
      leased + exhausted === 0
        ? 'every followed name has been filled in'
        : `nothing due: ${leased} being filled in now, ${exhausted} out of attempts`,
    );
  }

  // Opened before any work, so a process killed mid-backfill leaves a `running` row rather than no
  // row at all. This job wrote none until 17-Sep-2026, alone among the 17 that do — so `/admin`'s
  // run list, the only screen that answers "is anything broken", has never shown a company
  // backfill, including the ones that silently did nothing.
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_company_backfill') RETURNING id",
    );
    return rows[0]!.id;
  });

  const done: string[] = [];
  try {
    for (const t of targets) {
      console.log(`\n${t.symbol} — ${t.name} (attempt ${t.attempts})`);
      const verdict = await record(t, await backfill(t, priceDays));
      console.log(`  → ${verdict}`);
      done.push(`${t.symbol}: ${verdict}`);
    }
  } finally {
    const stuck = done.filter((d) => d.endsWith('out of attempts'));
    const retrying = done.filter((d) => d.endsWith('queued again'));
    await serviceTxn('system:ingest', async (c) => {
      await c.query(
        `UPDATE ingestion_runs SET finished_at = now(), status = $2, items = $3, detail = $4
          WHERE id = $1`,
        [
          runId,
          stuck.length + retrying.length > 0 ? 'failed' : 'ok',
          done.length - stuck.length - retrying.length,
          done.join('; ').slice(0, 500),
        ],
      );
    });

    // Only a name out of attempts fails the process, on `jobs/agents.ts`' judgement and for its
    // reason: `queued again` is NSE having a bad ten minutes and the ninety-minute retry is the
    // answer to it, while `out of attempts` is the terminal state nothing will ever revisit. Waking
    // somebody over the first would train them to ignore the alert that matters.
    if (stuck.length > 0) {
      throw new Error(`${stuck.join('; ')} — nothing will retry these without a person`);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
