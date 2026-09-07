/**
 * Sweep for work, then drain the queue.
 *
 * The sweep asks "what has no run yet" rather than "what is new since I last looked", so running
 * it twice queues nothing twice and running it after a week of downtime queues everything that
 * accumulated. There is no watermark to reset and none to drift.
 *
 *   pnpm exec tsx jobs/agents.ts [limit]
 */
import { closePool } from '../lib/db.ts';
import { drain, sweepScheduled } from '../lib/agents/runner.ts';
import * as results from '../lib/agents/results.ts';
import * as forensics from '../lib/agents/forensics.ts';
import * as concall from '../lib/agents/concall.ts';
// Imported for their side effect: registering handlers. Agents 4 and 5 have no sweep of their own
// (sweepScheduled covers them); agents 3 and 6 are prompted and are enqueued by a person, but every
// handler must be registered before the queue is drained or a run finds no code to execute.
import '../lib/agents/notify.ts';
import '../lib/agents/dossier.ts';
import '../lib/agents/newsbrief.ts';

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 10);

  const queued =
    (await results.sweep()) + (await forensics.sweep()) + (await concall.sweep()) +
    (await sweepScheduled());

  const r = await drain(limit);
  console.log(
    `queued ${queued}  ran ${r.ran}  drafted ${r.drafted}  failed ${r.failed}  reclaimed ${r.reclaimed}`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
