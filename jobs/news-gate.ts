/**
 * Judge the waiting candidates.
 *
 * **The one job in this system permitted to do nothing and call it success.** Everywhere else a
 * zero is a failure, because a dead feed must never look like a quiet day. Here zero means the net
 * caught nothing worth asking about, which on a book this size is most runs. This is one of the
 * documented exemptions to that rule; CLAUDE.md carries the roster.
 *
 *   pnpm exec tsx jobs/news-gate.ts
 */
import './_env.ts';

import { closePool, serviceTxn } from '../lib/db.ts';
import { runGate } from '../lib/news/gate.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:news-gate', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('news_gate') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await runGate();
    const detail =
      `${r.considered} judged: ${r.confirmed} confirmed, ${r.rejected} rejected, ` +
      `${r.failed} failed (${r.ungated} terminal), ` +
      // A total that silently omits the calls it could not price is worse than one that says so.
      (r.unpriced > 0
        ? `at least $${r.costUsd.toFixed(4)} (${r.unpriced} call${r.unpriced === 1 ? '' : 's'} on an unpriced model)`
        : `$${r.costUsd.toFixed(4)}`);

    // The exemption is for an EMPTY queue, and only that. A run that looked at candidates and
    // decided none of them is a failure — an expired key answers every call identically, and
    // recording that as `ok` is the same "a dead thing looks like a quiet day" mistake this system
    // keeps having. Caught by running the job with no credential: it read 0/0/3-failed and `ok`.
    const judgedNothing = r.considered > 0 && r.confirmed + r.rejected === 0;
    await serviceTxn('system:news-gate', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [judgedNothing ? 'failed' : 'ok', r.confirmed, detail, runId],
      );
    });
    console.log(detail);
    if (judgedNothing) {
      throw new Error(`the gate judged none of ${r.considered} candidates it looked at`);
    }
  } catch (err) {
    // COALESCE, so the tally written above survives: "judged none of 3" is the useful record, and
    // the exception that carried it out of the try block says less.
    await serviceTxn('system:news-gate', async (c) => {
      await c.query(
        `UPDATE ingestion_runs
            SET finished_at = now(), status = 'failed', detail = COALESCE(detail, $2)
          WHERE id = $1`,
        [runId, String(err instanceof Error ? err.message : err).slice(0, 500)],
      );
    });
    throw err;
  }
}

main()
  .catch((err: unknown) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1; })
  .finally(() => closePool());
