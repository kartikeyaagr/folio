/**
 * Put a failed run back on the queue, by hand, after somebody has looked at why it failed.
 *
 * With no argument, lists what failed. A remedy that requires already knowing what silently did
 * not happen is no remedy, so listing is the default.
 *
 *   pnpm exec tsx jobs/requeue.ts            what failed
 *   pnpm exec tsx jobs/requeue.ts <run-id>   put it back
 */
import './_env.ts';

import { closePool } from '../lib/db.ts';
import { failedRuns, requeue } from '../lib/agents/queue.ts';

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (!runId) {
    const failed = await failedRuns();
    if (failed.length === 0) { console.log('nothing failed'); return; }
    for (const f of failed) {
      console.log(`${f.id}  ${f.agentKey}  ${f.failureKind ?? '-'}  ${(f.error ?? '').slice(0, 70)}`);
    }
    return;
  }
  console.log(await requeue(runId) ? `requeued ${runId}` : `${runId} is not a failed run`);
}

main()
  .catch((err: unknown) => { console.error(String(err instanceof Error ? err.message : err)); process.exitCode = 1; })
  .finally(() => closePool());
