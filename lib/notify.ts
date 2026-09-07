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
 * SMTP is spoken directly. The alternative is a mail library, and for one plain-text message to
 * three colleagues on one relay that is a dependency, a supply chain and a configuration surface
 * for about eighty lines of protocol that has not changed since 1982.
 */

import { createConnection, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { serviceTxn } from './db.ts';

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

// ------------------------------------------------------------------------------------------------
// SMTP
// ------------------------------------------------------------------------------------------------

class SmtpError extends Error {}

function dialogue(socket: Socket | TLSSocket) {
  let buffer = '';
  const waiters: { want: number; resolve: (line: string) => void; reject: (e: Error) => void }[] = [];

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      // A multi-line reply has a hyphen after the code; only the last line counts.
      if (/^\d{3}-/.test(line)) continue;
      const w = waiters.shift();
      if (!w) continue;
      const code = Number(line.slice(0, 3));
      if (code === w.want) w.resolve(line);
      else w.reject(new SmtpError(`expected ${w.want}, got: ${line}`));
    }
  });

  return {
    expect: (want: number): Promise<string> =>
      new Promise((resolve, reject) => waiters.push({ want, resolve, reject })),
    send: (line: string): void => void socket.write(`${line}\r\n`),
  };
}

/** Dot-stuffing: a line that is just "." would otherwise end the message early. */
const stuff = (body: string): string =>
  body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');

export function smtpSender(cfg: SmtpConfig): Sender {
  return async (mail) => {
    const plain = createConnection({ host: cfg.host, port: cfg.port });
    await new Promise<void>((res, rej) => {
      plain.once('connect', res);
      plain.once('error', rej);
    });

    let d = dialogue(plain);
    await d.expect(220);
    d.send('EHLO trisula');
    await d.expect(250);

    // STARTTLS on 587. Credentials must never cross an unencrypted socket.
    d.send('STARTTLS');
    await d.expect(220);
    const secure = tlsConnect({ socket: plain, servername: cfg.host });
    await new Promise<void>((res, rej) => {
      secure.once('secureConnect', res);
      secure.once('error', rej);
    });
    d = dialogue(secure);
    d.send('EHLO trisula');
    await d.expect(250);

    if (cfg.user && cfg.password) {
      d.send('AUTH LOGIN');
      await d.expect(334);
      d.send(Buffer.from(cfg.user).toString('base64'));
      await d.expect(334);
      d.send(Buffer.from(cfg.password).toString('base64'));
      await d.expect(235);
    }

    d.send(`MAIL FROM:<${cfg.from}>`);
    await d.expect(250);
    d.send(`RCPT TO:<${mail.to}>`);
    await d.expect(250);
    d.send('DATA');
    await d.expect(354);
    secure.write(
      [
        `From: ${cfg.from}`,
        `To: ${mail.to}`,
        `Subject: ${mail.subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        stuff(mail.body),
        '.',
        '',
      ].join('\r\n'),
    );
    await d.expect(250);
    d.send('QUIT');
    secure.end();
  };
}

// ------------------------------------------------------------------------------------------------
// The drain
// ------------------------------------------------------------------------------------------------

export interface DrainResult {
  sent: number;
  failed: number;
  skipped: number;
}

/**
 * Send what is queued.
 *
 * Claimed one at a time with SKIP LOCKED so two drains never send the same mail twice, which is
 * the one failure a person actually notices.
 */
export async function drainOutbox(sender: Sender | null, limit = 50): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, failed: 0, skipped: 0 };

  if (!sender) {
    // Nothing configured. Count what is waiting so the run says something true rather than "ok".
    return serviceTxn('system:agents', async (c) => {
      const { rows } = await c.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM notification_outbox WHERE sent_at IS NULL',
      );
      out.skipped = Number(rows[0]!.n);
      return out;
    });
  }

  for (let i = 0; i < limit; i++) {
    const more = await serviceTxn('system:agents', async (c) => {
      const { rows } = await c.query<{
        id: string; subject: string; body: string; email: string;
      }>(
        `SELECT o.id, o.subject, o.body, u.email
           FROM notification_outbox o JOIN users u ON u.id = o.recipient
          WHERE o.sent_at IS NULL AND o.attempts < $1
          ORDER BY o.queued_at
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1`,
        [MAX_SEND_ATTEMPTS],
      );
      const m = rows[0];
      if (!m) return false;

      try {
        await sender({ to: m.email, subject: m.subject, body: m.body });
        await c.query('UPDATE notification_outbox SET sent_at = now() WHERE id = $1', [m.id]);
        out.sent++;
      } catch (err) {
        await c.query(
          'UPDATE notification_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
          [m.id, String(err instanceof Error ? err.message : err).slice(0, 500)],
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
