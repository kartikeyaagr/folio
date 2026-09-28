/**
 * A dead man's switch.
 *
 * Every other signal in this system travels **out** from the box: a failed unit writes an
 * `ingestion_runs` row and queues an outbox notice, and both need Postgres to be answering and the
 * box to be running. Neither survives the two failures that matter most — the machine being off,
 * and the database being the thing that broke.
 *
 * So this one is inverted. It reports health by *arriving*, and its absence is the alarm: an
 * external monitor expects a ping on a schedule and raises when one does not come. Nothing on this
 * box has to be working for that to fire, which is the whole point.
 *
 * **It pings only when Postgres answers.** A ping that means "systemd is alive" would keep the
 * monitor quiet through a database outage, which is exactly the outage the outbox cannot report.
 * A failed *job* is deliberately not part of this: that has its own path, and one signal that means
 * two things is a signal nobody can act on at four in the morning.
 *
 *   pnpm exec tsx jobs/heartbeat.ts
 *
 * `HEARTBEAT_URL` is any endpoint that treats silence as a failure — healthchecks.io, Better
 * Stack, a cron monitor of your own. Unset is a valid state and says so rather than failing: a box
 * with no monitor should not raise an alarm it has nowhere to send.
 */
import './_env.ts';

import { closePool, readTxn } from '../lib/db.ts';

const TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const url = process.env['HEARTBEAT_URL'];

  // Asked of the database, not of the process. `SELECT 1` would prove a connection; this proves the
  // schema is there and readable, which is the state everything else depends on.
  const { runs, pending } = await readTxn(async (c) => {
    const { rows } = await c.query<{ runs: string; pending: string }>(
      `SELECT (SELECT count(*)::text FROM ingestion_runs
                WHERE started_at > now() - interval '24 hours') AS runs,
              (SELECT count(*)::text FROM notification_outbox WHERE sent_at IS NULL) AS pending`,
    );
    return { runs: rows[0]!.runs, pending: rows[0]!.pending };
  });

  const body = `ok; ${runs} ingestion runs in 24h; ${pending} notices unsent`;

  if (!url) {
    // Deliberately exit 0. There is nothing wrong with the box; there is nowhere to say so.
    console.log(`${body}\nHEARTBEAT_URL is not set, so nothing was pinged.`);
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`heartbeat endpoint answered ${res.status}`);
  console.log(body);
}

main()
  .catch((err: unknown) => {
    // Failing loudly here is right: either the database did not answer or the monitor did not
    // accept the ping. The first is the outage this exists to surface, and in that case the ping is
    // correctly never sent, so the monitor raises on the silence.
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
