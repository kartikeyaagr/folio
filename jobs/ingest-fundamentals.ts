/**
 * Financial results for followed companies.
 *
 * Results come from corporates-financial-results, which returns the XBRL instance URL directly.
 * They are deliberately not found by filtering announcements on hasXbrl: NSE sets that flag on
 * everything, a Copy of Newspaper Publication included.
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { ingestFundamentals } from '../lib/ingest/fundamentals.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:ingest', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('nse_results_xbrl') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await ingestFundamentals();
    // A dead feed must never look like a quiet day. Five board/period combinations are swept and
    // the smallest of them served 29 rows on 08-Sep-2026, so zero across all of them is a failure,
    // not a slow week. Deliberately checked on indexRows and not on candidates: candidates is
    // post-filter, and "neither of the names we follow reported today" is an ordinary Tuesday.
    if (r.indexRows === 0) throw new Error('results feed returned zero rows across every board and period');
    await serviceTxn('system:ingest', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'ok', items = $1, detail = $2 WHERE id = $3",
        [
          r.stored,
          `${r.indexRows} index rows, ${r.candidates} candidates, ${r.parsed} parsed, ${r.failed} failed, ${r.disagreed} periods whose context lied`,
          runId,
        ],
      );
    });
    console.log(
      `index ${r.indexRows}  candidates ${r.candidates}  parsed ${r.parsed}  stored ${r.stored}  failed ${r.failed}  context-disagreed ${r.disagreed}`,
    );
  } catch (err) {
    await serviceTxn('system:ingest', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'failed', detail = $1 WHERE id = $2",
        [String(err instanceof Error ? err.message : err).slice(0, 500), runId],
      );
    });
    throw err;
  }
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
