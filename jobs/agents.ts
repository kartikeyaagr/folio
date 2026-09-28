/**
 * Sweep for work, put back what the box broke, then drain the queue.
 *
 * The sweep asks "what has no run yet" rather than "what is new since I last looked", so running
 * it twice queues nothing twice and running it after a week of downtime queues everything that
 * accumulated. There is no watermark to reset and none to drift.
 *
 * **"No run yet" counts a failed run, and that is why `requeueErrored` runs before the sweeps.**
 * The three event sweeps test `NOT EXISTS (… agent_key, subject_ref)` with no predicate on status,
 * so once a run reaches `failed` its subject is never offered again. That is correct for a subject
 * the model refused or could not parse — it will fail the same way every time — and wrong for a
 * box with no credential, where the work was fine and the machine was not. `requeueErrored` puts
 * back only the second kind, six hours later, and the requeued run is `queued`, which the sweeps
 * already read as "this subject has a run". Without it, one badly-configured hour would have
 * permanently retired the 129 subjects that were eligible when this was written.
 *
 * **Finding nothing is a quiet day; failing on the box is not.** This is one of the documented
 * exemptions to the zero-items rule and it is narrow: `queued 0 ran 0` is the ordinary state of a
 * desk where nothing new was filed, and says so. What is never a quiet day is a run that failed
 * with `failure_kind = 'error'` — a missing credential, a network that is gone, a database that is
 * not there. Every run in the batch fails the same way and the exit code is the only thing that
 * reaches a person, so those fail the run and `OnFailure=folio-alert@%n.service` fires.
 *
 * A `refusal`, `truncated`, `unparseable`, `schema_mismatch` or `too_large` deliberately does not.
 * Those are one agent having a bad day on one subject; the run records itself, `/agents` lists it
 * under failed runs, and waking somebody at 6am over a model declining a transcript would train
 * them to ignore the alert that matters.
 *
 * **The brief's mail goes from here, straight after the drain that wrote it.** It is the one mail
 * that does not wait for the morning digest (migration 0067), so a brief written on this pass is in
 * everybody's inbox by the end of it. A brief nobody could be sent is never a quiet day either:
 * with no relay, or a relay that refuses, the rows keep the reason and this run fails, the same
 * as a failure on the box. Each pass after that tries again, up to `MAX_SEND_ATTEMPTS`, and then
 * the rows are left for `undeliverable()` to show.
 *
 *   pnpm exec tsx jobs/agents.ts [limit]
 */
import './_env.ts';

import { closePool, serviceTxn } from '../lib/db.ts';
import { drainOutbox, noRelay, smtpFromEnv, smtpSender } from '../lib/notify.ts';
import { drain } from '../lib/agents/runner.ts';
import { requeueErrored, sweepScheduled, RETRY_AFTER_HOURS } from '../lib/agents/queue.ts';
import * as results from '../lib/agents/results.ts';
import * as forensics from '../lib/agents/forensics.ts';
import * as concall from '../lib/agents/concall.ts';
import * as newsbrief from '../lib/agents/newsbrief.ts';
// Imported for its side effect: registering handlers. Agents 4 and 5 have no sweep of their own
// (sweepScheduled covers them), but every handler must be registered before the queue is drained
// or a run finds no code to execute.
import '../lib/agents/notify.ts';

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? 10);

  // Opened before any work, so a process killed mid-drain leaves a `running` row rather than no
  // row at all — the same shape every other timed job uses, and what `/admin`'s recency reads.
  const runId = await serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO ingestion_runs (source) VALUES ('agents') RETURNING id",
    );
    return rows[0]!.id;
  });

  try {
    const back = await requeueErrored();
    const queued =
      (await results.sweep()) + (await forensics.sweep()) + (await concall.sweep()) +
      (await newsbrief.sweep()) + (await sweepScheduled());

    const r = await drain(limit);

    // The shared relay, never a person's own mailbox. The brief is one message from the desk to
    // everybody, and a linked mailbox was linked on the promise that it sends only its owner's
    // digest (lib/mailbox.ts). No relay is a failed send here, not the quiet skip the digest makes.
    const relay = smtpFromEnv();
    const mail = await drainOutbox(relay ? smtpSender(relay) : noRelay, 50, 'brief');

    const detail =
      `${queued} queued, ${back} put back after ${RETRY_AFTER_HOURS}h; ` +
      `ran ${r.ran}, drafted ${r.drafted}, reclaimed ${r.reclaimed}; ` +
      `${r.failed} failed (${r.errors} of them on the box, ${r.failed - r.errors} on the subject); ` +
      `brief mailed to ${mail.sent}, ${mail.failed} failed` +
      (mail.lastError ? ` (${mail.lastError})` : '');
    const broken = r.errors > 0 || mail.failed > 0;

    await serviceTxn('system:agents', async (c) => {
      await c.query(
        'UPDATE ingestion_runs SET finished_at = now(), status = $1, items = $2, detail = $3 WHERE id = $4',
        [broken ? 'failed' : 'ok', r.drafted, detail, runId],
      );
    });
    console.log(detail);

    if (r.errors > 0) {
      throw new Error(
        `${r.errors} of ${r.ran} runs failed on the box rather than on their subject — ` +
          'the agents cannot work here until that is fixed',
      );
    }
    if (mail.failed > 0) {
      throw new Error(
        `the brief could not be mailed to ${mail.failed} ${mail.failed === 1 ? 'person' : 'people'}: ` +
          `${mail.lastError ?? 'no reason recorded'}`,
      );
    }
  } catch (err) {
    // COALESCE so the tally written above survives: "10 ran, 10 failed on the box" is the useful
    // record, and the exception that carried it out of the try block says less.
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
