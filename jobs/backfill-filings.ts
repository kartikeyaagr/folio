/**
 * Bring a followed name's whole filing history in, rather than whatever the rolling window caught.
 *
 * `design.md` §9 step 7 lists "backfill per company" as part of bootstrap and nothing did it, so a
 * name arrived holding only the last two weeks of announcements. On 08-Sep-2026 that was seven
 * filings across the two companies in the book — against 1,031 for PRAJIND and 135 for AERON that
 * the exchange will serve when asked by symbol.
 *
 * This matters beyond the filings screen: concall transcripts and quarterly investor presentations
 * are filed *as* announcements, so the document corpus available to the agents is bounded by this.
 *
 *   pnpm exec tsx jobs/backfill-filings.ts                 # every followed name
 *   pnpm exec tsx jobs/backfill-filings.ts --symbol AERON  # one of them
 *
 * Idempotent: storing is an upsert on NSE's own `seq_id`, so re-running costs a fetch and changes
 * nothing. Run it after adding a name, or whenever the history looks thin.
 */
import { closePool, readTxn, serviceTxn } from '../lib/db.ts';
import { NseSession } from '../lib/ingest/nse.ts';
import {
  fetchAnnouncementsForSymbol,
  storeFilings,
  linkAllFollowed,
  type Board,
} from '../lib/ingest/filings.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg('--symbol')?.trim().toUpperCase();

  // The board decides which index the feed is asked for. `securities.platform` is the master's
  // own answer; a company with no master row cannot be backfilled and says so rather than being
  // fetched from the wrong board and coming back empty.
  const targets = await readTxn(async (c) => {
    const { rows } = await c.query<{ symbol: string; platform: string | null }>(
      `SELECT co.symbol, s.platform
         FROM companies co
         LEFT JOIN securities s ON s.symbol = co.symbol
        WHERE ($1::text IS NULL OR co.symbol = $1)
        ORDER BY co.symbol`,
      [only ?? null],
    );
    return rows;
  });

  if (targets.length === 0) {
    throw new Error(only ? `${only} is not a followed company` : 'no companies are followed');
  }

  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_announcements_backfill') RETURNING id",
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
    let fetched = 0;
    let stored = 0;
    let totalSkipped = 0;
    const empty: string[] = [];

    for (const t of targets) {
      if (!t.platform) {
        throw new Error(`${t.symbol} has no securities row; refresh the master before backfilling`);
      }
      const board: Board = t.platform === 'nse_emerge' ? 'nse_sme' : 'nse_equities';
      const { filings, served, skipped } = await fetchAnnouncementsForSymbol(t.symbol, board, session);
      // A listed company with no announcements at all is not a quiet company, it is a failed
      // fetch — the wrong board, a renamed symbol, or a feed that answered 200 with nothing.
      if (served === 0) empty.push(t.symbol);
      fetched += filings.length;
      totalSkipped += skipped;
      const r = await storeFilings(filings);
      stored += r.stored;
      console.log(
        `${t.symbol.padEnd(10)} ${String(served).padStart(5)} served  ${String(filings.length).padStart(5)} parsed  ` +
          `${String(r.stored).padStart(5)} stored  ${String(skipped).padStart(4)} skipped (pre-2013, no seq_id)`,
      );
    }

    if (empty.length > 0) {
      throw new Error(`no announcements returned for ${empty.join(', ')} — wrong board or dead feed`);
    }

    const linked = await linkAllFollowed();
    await finish('ok', stored, `${targets.length} companies, ${fetched} parsed, ${stored} stored, ${linked} linked, ${totalSkipped} skipped for want of a seq_id`);
    console.log(`\n${targets.length} companies  ${fetched} parsed  ${stored} stored  ${linked} linked  ${totalSkipped} skipped`);
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
