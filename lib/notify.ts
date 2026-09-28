/**
 * Draining the notification outbox.
 *
 * The outbox is transactional: a notification is queued in the same commit as the thing it is
 * about, so there is no state where an alert exists and nobody was ever going to be told, nor one
 * where a mail is queued for an alert that was rolled back. This module is only the sending half.
 *
 * **A send that fails is retried, not lost.** Attempts and the last error stay on the row, and a
 * row that has exhausted its attempts stays in the table rather than disappearing — an
 * undeliverable notification is something a person should be able to find.
 *
 * SMTP was spoken directly until 18-Sep-2026 — "a dependency, a supply chain and a configuration
 * surface for about eighty lines of protocol that has not changed since 1982". The argument was
 * sound and the eighty lines did not hold up their end of it: nothing could settle a pending
 * `expect()` once the socket was connected, because the reply waiters resolved only from `data`
 * and no `error` or `close` handler was ever attached. A relay that accepted the connection and
 * then went quiet left the send pending for the life of the process — inside the claim
 * transaction, holding one of the pool's ten connections and a row lock, indefinitely. It was
 * also the only outbound call in the tree with no timeout; the other seven all carry one.
 *
 * `nodemailer` has no runtime dependencies of its own and no native build step, and it owns the
 * three timeouts, STARTTLS negotiation from the EHLO capability list, and RFC 2047 header
 * encoding — the subject was being interpolated into a header raw, so a newline in one injected
 * headers.
 */

import { createTransport } from 'nodemailer';
import { rowId, serviceTxn } from './db.ts';

/**
 * After five tries a queued mail stops being offered, and that one number means three things.
 *
 * `drainOutbox` stops claiming the row; `waiting` in `lib/digest.ts` excludes it, so one address
 * that keeps bouncing does not hold up the rest of that person's envelope forever; and
 * `undeliverable` below is defined as everything past it. Raising it makes all three more patient
 * at once. The row is never deleted at any count — an undeliverable notification is something a
 * person should be able to find, with its `last_error` still on it.
 */
export const MAX_SEND_ATTEMPTS = 5;

export interface Mail {
  to: string;
  subject: string;
  body: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user?: string;
  password?: string;
  from: string;
  /**
   * How long a send may take before it is abandoned. Defaults to `SEND_TIMEOUT_MS`.
   *
   * Overridable because a bound that cannot be exercised is a bound nobody knows works — the
   * regression test for the hang this module was rewritten to fix points a sender at a relay that
   * accepts and then says nothing, and has to do it in less than twenty seconds.
   */
  timeoutMs?: number;
}

export function smtpFromEnv(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  // No relay configured is a valid state, not a failure: the journal is still a record, and a box
  // without mail should not fail its jobs over it.
  if (!host || !from) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from,
  };
}

/** A sender. Swappable so the drain can be tested without a relay. */
export type Sender = (mail: Mail) => Promise<void>;

/**
 * The sender for a box with no relay, where a mail must not wait quietly for one.
 *
 * For the brief. Everything else treats no relay as a valid state and queues. The brief is sent
 * the moment it lands, so a send that cannot happen is a failed send: this throws, the drain
 * credits an attempt and keeps the reason on the row, and the job fails where somebody sees it.
 */
export const noRelay: Sender = async () => {
  throw new Error('no SMTP relay is configured: SMTP_HOST and SMTP_FROM are both needed');
};

// ------------------------------------------------------------------------------------------------
// SMTP
// ------------------------------------------------------------------------------------------------

/**
 * A send is bounded, and the bound is what this module exists to guarantee.
 *
 * Generous, because a relay under load is slow rather than broken, and this is a bound on a hang
 * rather than a latency budget — the same reasoning `lib/ingest/nse.ts` records for its own.
 */
const SEND_TIMEOUT_MS = 20_000;

export function smtpSender(cfg: SmtpConfig): Sender {
  // Built once per sender rather than per message, so the drain does not reconstruct it fifty
  // times. Not pooled: these jobs are one-shot, and a pool holds sockets open past the last send
  // and delays the process exiting.
  const transport = createTransport({
    host: cfg.host,
    port: cfg.port,
    // Implicit TLS on 465, STARTTLS everywhere else. `requireTLS` is what keeps the original
    // promise that credentials never cross an unencrypted socket: without it a relay that does
    // not advertise STARTTLS would be talked to in the clear.
    secure: cfg.port === 465,
    requireTLS: cfg.port !== 465,
    auth: cfg.user && cfg.password ? { user: cfg.user, pass: cfg.password } : undefined,
    connectionTimeout: cfg.timeoutMs ?? SEND_TIMEOUT_MS,
    greetingTimeout: cfg.timeoutMs ?? SEND_TIMEOUT_MS,
    socketTimeout: cfg.timeoutMs ?? SEND_TIMEOUT_MS,
  });

  return async (mail) => {
    await transport.sendMail({
      from: cfg.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.body,
    });
  };
}

// ------------------------------------------------------------------------------------------------
// The drain
// ------------------------------------------------------------------------------------------------

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
  /** What the last failed send said, so a caller that fails its run can say why. */
  lastError: string | null;
}

/**
 * Send what is queued, one mail per row.
 *
 * Claimed one at a time with SKIP LOCKED so two drains never send the same mail twice, which is
 * the one failure a person actually notices.
 *
 * `kind` narrows it to one kind of row. The brief is the caller that needs it (jobs/agents.ts):
 * every other kind rides the morning digest and must not be sent one by one from here.
 *
 * **The send stays inside the claim transaction, deliberately.** `lib/agents/queue.ts` moved the
 * other direction — claim, commit, then work — because a model call is minutes long and there is
 * a `claimed_at` lease to hold the row in the meantime. There is no lease column here, so
 * committing before the send would leave the row visible to a concurrent drain for exactly as
 * long as the send takes, and duplicate mail is the outcome this function is shaped to prevent.
 * What made holding the transaction dangerous was never its length but its *unboundedness*; the
 * timeouts on the sender are that fix, and they cap the hold at `SEND_TIMEOUT_MS`.
 */
export async function drainOutbox(
  sender: Sender | null,
  limit = 50,
  kind: string | null = null,
): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, failed: 0, skipped: 0, lastError: null };

  if (!sender) {
    // Nothing configured. Count what is waiting so the run says something true rather than "ok".
    return serviceTxn('system:agents', async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notification_outbox
          WHERE sent_at IS NULL AND ($1::text IS NULL OR kind = $1)`,
        [kind],
      );
      out.skipped = Number(rows[0]!.n);
      return out;
    });
  }

  // Once a pass per row. A row that failed is still unsent and under its limit, so without this the
  // next claim took it straight back: one pass against a refusing relay spent all five attempts in
  // a second, and a relay that hiccupped at 08:03 left the brief undeliverable for good. Measured
  // when the brief began using this: two queued mails, ten sends.
  const tried: string[] = [];
  for (let i = 0; i < limit; i++) {
    const more = await serviceTxn('system:agents', async (c) => {
      const { rows } = await c.query<{
        id: string; subject: string; body: string; email: string;
      }>(
        `SELECT o.id, o.subject, o.body, u.email
           FROM notification_outbox o JOIN users u ON u.id = o.recipient
          WHERE o.sent_at IS NULL AND o.attempts < $1 AND ($2::text IS NULL OR o.kind = $2)
            AND NOT (o.id = ANY($3::text[]))
          ORDER BY o.queued_at
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1`,
        [MAX_SEND_ATTEMPTS, kind, tried],
      );
      const m = rows[0];
      if (!m) return false;
      tried.push(m.id);

      try {
        await sender({ to: m.email, subject: m.subject, body: m.body });
        await c.query('UPDATE notification_outbox SET sent_at = now() WHERE id = $1', [m.id]);
        out.sent++;
      } catch (err) {
        out.lastError = String(err instanceof Error ? err.message : err).slice(0, 500);
        await c.query(
          'UPDATE notification_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [m.id, out.lastError],
        );
        out.failed++;
      }
      return true;
    });
    if (!more) break;
  }
  return out;
}

/** Queued, undeliverable, and therefore worth a person's attention. */
export async function undeliverable(): Promise<
  { id: string; subject: string; attempts: number; lastError: string | null }[]
> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{
      id: string; subject: string; attempts: number; lastError: string | null;
    }>(
      `SELECT id, subject, attempts, last_error AS "lastError"
         FROM notification_outbox
        WHERE sent_at IS NULL AND attempts >= $1
        ORDER BY queued_at`,
      [MAX_SEND_ATTEMPTS],
    );
    return rows;
  });
}

// ------------------------------------------------------------------------------------------------
// A failed unit
// ------------------------------------------------------------------------------------------------

/**
 * Record that a systemd unit failed, and address the notice to somebody.
 *
 * Here rather than in `jobs/report-failure.ts` so the one thing that matters about it is testable:
 * that the notice has a recipient. A failure written to a table nobody is told about is the pull
 * this replaced — the row shows on `/admin?tab=ops` and waits for an admin to choose to look, and
 * a job that dies at 04:00 waits until morning.
 *
 * The run row and the notices are one transaction. There is no state where the failure is recorded
 * and nobody was ever going to be told, which is the same rule the outbox follows everywhere else.
 */
export async function recordUnitFailure(unit: string): Promise<number> {
  return serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO ingestion_runs (source, finished_at, status, detail)
       VALUES ($1, now(), 'failed', $2)`,
      [`systemd:${unit}`, `unit failed; see journalctl -u ${unit}`],
    );

    // Admins, because a failed unit is an operations matter and `/admin?tab=ops` is where the runs
    // are read. Everyone active when there is no admin yet: a notice addressed to nobody is the
    // exact failure this exists to fix, and a fresh box has none until somebody is made one.
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM users
        WHERE disabled_at IS NULL
          AND (is_admin OR NOT EXISTS (SELECT 1 FROM users WHERE is_admin AND disabled_at IS NULL))`,
    );

    for (const u of rows) {
      await c.query(
        `INSERT INTO notification_outbox (id, kind, recipient, subject, body)
         VALUES ($1, 'unit_failure', $2, $3, $4)`,
        [
          rowId(),
          u.id,
          `${unit} failed`,
          `${unit} exited non-zero.\n\n` +
            `On the VM:\n  journalctl -u ${unit} -n 200 --no-pager\n\n` +
            `The run is recorded against source "systemd:${unit}" and shows on /admin?tab=ops.\n`,
        ],
      );
    }
    return rows.length;
  });
}
