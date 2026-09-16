/**
 * Turn recurring corrections into candidate rules.
 *
 * `v4.md §7` part 3. All the reasoning is in `lib/agents/distil.ts`; this is the schedule and the
 * `ingestion_runs` row.
 *
 * **Raising nothing is the correct outcome, and this exemption to the zero-items-is-a-failure rule
 * is not shaped like the others.** The bhavcopy on a non-trading day, the news gate's empty queue,
 * the indexer's — those are all "the queue was empty".
 * Here the queue is rarely empty and the answer is still usually nothing, because a field corrected
 * twice must not raise a rule and a correction worth less than `MIN_DISTANCE` must not count as
 * one. A run that looked at eleven corrections and raised no candidate did its job exactly right.
 *
 * So what would a dead distiller look like? Not a zero — a missing run. This job's liveness is the
 * `ingestion_runs` recency on `/admin`, the same as every other job, and the failures it *can* have
 * (it could not read, a constraint refused an insert) throw and are recorded as failures. The
 * detail line prints all three numbers so "considered 11, observed 4, raised 0" is legible as work
 * done rather than as silence.
 *
 *   pnpm exec tsx jobs/distil-rules.ts
 */
import { closePool, serviceTxn } from '../lib/db.ts';
import { distil, MIN_DISTANCE, MIN_OBSERVATIONS } from '../lib/agents/distil.ts';

async function main(): Promise<void> {
  const runId = await serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('rule_distillation') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const r = await distil();
    const detail =
      `${r.considered} correction${r.considered === 1 ? '' : 's'} no rule had accounted for; ` +
      `${r.observed} worth ${MIN_DISTANCE} or more; ` +
      `${r.raised} candidate${r.raised === 1 ? '' : 's'} raised ` +
      `(a field needs ${MIN_OBSERVATIONS})`;

    await serviceTxn('system:agents', async (c) => {
      await c.query(
        "UPDATE ingestion_runs SET finished_at = now(), status = 'ok', items = $1, detail = $2 WHERE id = $3",
        [r.raised, detail, runId],
      );
    });
    console.log(detail);
  } catch (err) {
    await serviceTxn('system:agents', async (c) => {
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
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
