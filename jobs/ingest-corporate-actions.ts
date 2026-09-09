/**
 * Bonuses, splits and dividends for the names in the book.
 *
 * Runs daily. The window looks back a month and forward a quarter, because an action is announced
 * before its ex-date and the point of holding one is to confirm it *before* it happens.
 *
 * Nothing here touches a position. Every row lands unconfirmed and waits for a person on
 * /portfolio, which is B5 and the whole reason this feed is safe to run unattended.
 *
 *   pnpm exec tsx jobs/ingest-corporate-actions.ts
 *   pnpm exec tsx jobs/ingest-corporate-actions.ts --days 400
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { ingestCorporateActions } from '../lib/ingest/corporate-actions.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg('--days') ?? 30);
  if (!Number.isFinite(days) || days < 1) throw new Error('--days must be a positive number');

  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_corporate_actions') RETURNING id",
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
    const r = await ingestCorporateActions(days);

    // Zero announcements across both boards over four months is a dead endpoint, not a quiet
    // quarter — the exchange publishes hundreds a month. Zero *for this book* is ordinary and is
    // reported below rather than raised.
    if (r.seen === 0) throw new Error('the corporate-actions feed returned zero rows for either board');

    const refused = Object.entries(r.declined).sort((a, b) => b[1] - a[1]);
    const detail =
      `${r.seen} announcements, ${r.ours} for followed names, ${r.stored} stored` +
      (refused.length > 0 ? `; declined ${refused.map(([why, n]) => `${n} ${why}`).join(', ')}` : '');

    await finish('ok', r.stored, detail);
    console.log(`${r.seen} announcements  ${r.ours} ours  ${r.stored} stored`);
    // Printed line by line, because a form this parser has not been taught shows up here first and
    // a count buried in one long string is a count nobody reads.
    for (const [why, n] of refused) console.log(`  declined ${String(n).padStart(4)}  ${why}`);
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
