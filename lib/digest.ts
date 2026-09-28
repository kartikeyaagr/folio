/**
 * One email a day, per person, and never more.
 *
 * **This replaces per-event mail rather than adding to it**, at the fund's instruction, 17-Sep-2026.
 * Producers are unchanged: `lib/alerts.ts`, `lib/reminders.ts` and `jobs/backfill-company.ts` still
 * write a `notification_outbox` row per person per event, and that table is still the record of
 * what the system decided to tell somebody. What changed is the *sending*: instead of one mail per
 * row, a person gets one mail a morning carrying every row that accumulated, and the rows are
 * marked sent together.
 *
 * Keeping the producers untouched is the point. `alert_id` and `reminder_id` are what make queueing
 * idempotent — `deliverDue` sets `reminders.delivered_at`, `raiseAlert` has its own conflict key —
 * and a digest that gathered from the source tables instead would have had to re-derive all of that
 * and would have drifted from it. The outbox row is the notification; this file only decides when
 * the envelope goes.
 *
 * **The cost is that an urgent alert waits until morning.** That was chosen deliberately over an
 * inbox that interrupts: three people who read this before the market opens and after it closes do
 * not need a mail at 14:20 about a filing they will see on `/desk` anyway. If that changes, the
 * honest fix is a second, narrow path for one severity — not a return to mailing everything.
 *
 * **The brief is the one exception, by the fund's decision of 28-Sep-2026 (migration 0067).** It is
 * mailed to everybody as soon as it is written, from jobs/agents.ts, and its outbox rows are kind
 * `brief`. This file leaves them alone twice over: an unsent one is never folded into a digest,
 * because it has its own sender and its own retries, and a sent one does not count as the day's
 * envelope. Otherwise an 08:03 brief would hold every alert raised later that day until tomorrow's.
 */

import { readTxn, serviceTxn } from './db.ts';
import { configFor, recordMailboxResult } from './mailbox.ts';
import { MAX_SEND_ATTEMPTS, smtpSender, type Sender } from './notify.ts';

/**
 * The IST hour at or after which the day's digest goes out.
 *
 * Seven, because the desk opens this before the market does and the point of a digest is that it is
 * already there. The agent's timer runs more often than this; the hour is what stops a digest going
 * out at 00:05 to somebody who will not read it until eight hours later, by which time the day's
 * real news would have had to wait for tomorrow's envelope.
 */
export const DIGEST_HOUR = 7;

/** IST, because every time in this system is IST and "today" is an Indian trading date. */
export const IST = 'Asia/Kolkata';

export interface DigestResult {
  sent: number;
  failed: number;
  /** People with something waiting whose digest was not sent, and why it was not. */
  skipped: number;
}

interface Waiting {
  userId: string;
  email: string;
  name: string;
  items: { kind: string; subject: string; body: string; id: string }[];
}

/**
 * Whether it is late enough in the day, in IST, wherever the box thinks it is.
 *
 * Derived from the instant rather than from the box's timezone: `ops/systemd/folio-job@.service`
 * sets `TZ=Asia/Kolkata` and a developer's laptop does not, and a digest that goes out at a
 * different hour depending on whose machine ran it is the kind of thing nobody notices until a
 * Monday.
 */
export function istHour(now: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', hour12: false }).format(now),
  );
}

/**
 * Everything a person has not been told yet, for the people it is worth telling.
 *
 * `NOT EXISTS (… sent today)` is what makes this once a day, and it is asked of the outbox rather
 * than tracked in a column of its own — the house rule about asking "what has no run yet" rather
 * than keeping a watermark. A row sent today IS the record that today's envelope went; there is
 * nothing to reset and nothing to drift.
 *
 * `attempts < MAX_SEND_ATTEMPTS` so a person whose address keeps bouncing does not hold up their
 * own digest forever — the failed rows are left behind with their `last_error` for somebody to
 * find, exactly as `drainOutbox` leaves them.
 *
 * **`now` is passed in rather than read as `now()`, and one instant governs the whole decision.**
 * The hour gate already worked from the caller's instant; leaving this half on the database clock
 * meant two clocks deciding one thing, which is fine until a run straddles midnight and then
 * answers "it is still today" and "it is already tomorrow" in the same pass.
 */
async function waiting(now: Date): Promise<Waiting[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Waiting>(
      `SELECT u.id AS "userId", u.email, u.name,
              jsonb_agg(jsonb_build_object(
                'id', o.id, 'kind', o.kind, 'subject', o.subject, 'body', o.body
              ) ORDER BY o.queued_at) AS items
         FROM notification_outbox o
         JOIN users u ON u.id = o.recipient
        WHERE o.sent_at IS NULL
          AND o.attempts < $1
          AND o.kind <> 'brief'
          AND u.disabled_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM notification_outbox s
             WHERE s.recipient = u.id
               AND s.kind <> 'brief'
               AND s.sent_at IS NOT NULL
               AND (s.sent_at AT TIME ZONE $2)::date = ($3::timestamptz AT TIME ZONE $2)::date)
        GROUP BY u.id, u.email, u.name
        ORDER BY u.email`,
      [MAX_SEND_ATTEMPTS, IST, now.toISOString()],
    );
    return rows;
  });
}

/** What is sitting on a screen waiting for this person, as opposed to what happened to them. */
interface Standing {
  draftsWaiting: number;
  runsNeedingSomebody: number;
}

async function standing(): Promise<Standing> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Standing>(
      `SELECT (SELECT count(*)::int FROM ai_drafts WHERE status = 'pending') AS "draftsWaiting",
              (SELECT count(*)::int FROM agent_runs WHERE status = 'failed') AS "runsNeedingSomebody"`,
    );
    return rows[0]!;
  });
}

/** The order things are read in: what needs a decision, then what happened, then housekeeping. */
const KIND_ORDER = ['reminder', 'alert', 'agent_draft', 'unit_failure', 'backfill'];
const KIND_LABEL: Record<string, string> = {
  reminder: 'Due today',
  alert: 'Alerts',
  agent_draft: 'Drafts to review',
  unit_failure: 'A job failed',
  backfill: 'Housekeeping',
};

/**
 * The envelope, as plain text.
 *
 * Exported and pure so a test can read it without a relay or a database. Plain text and not HTML:
 * everything in here is a sentence somebody already wrote for a screen, an HTML mail is a second
 * rendering of the same thing to keep in step, and this is read on a phone before seven.
 */
export function composeDigest(
  person: { name: string },
  items: { kind: string; subject: string; body: string }[],
  now: Date,
  also: Standing,
): { subject: string; body: string } {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);

  const kinds = KIND_ORDER.filter((k) => counts.has(k));
  const day = new Intl.DateTimeFormat('en-IN', {
    timeZone: IST, day: 'numeric', month: 'short',
  }).format(now);

  // The subject says what is inside, because a subject line that says "Daily digest" makes the
  // decision to open it every single morning rather than once.
  const summary = kinds
    .map((k) => `${counts.get(k)} ${k === 'unit_failure' ? 'job failure' : k}${counts.get(k) === 1 ? '' : 's'}`)
    .join(', ');
  const subject = `Folio — ${day}${summary ? `: ${summary}` : ''}`;

  const lines: string[] = [`${person.name},`, ''];
  for (const kind of kinds) {
    lines.push(`── ${KIND_LABEL[kind] ?? kind} ──`, '');
    for (const i of items.filter((x) => x.kind === kind)) {
      lines.push(i.subject, ...i.body.split('\n').map((l) => (l ? `  ${l}` : '')), '');
    }
  }

  // Said even when it is zero: "nothing is waiting" is a thing worth knowing at 07:00, and it is
  // the one line that distinguishes a quiet morning from a digest that failed to gather anything.
  lines.push('── Waiting on the desk ──', '');
  lines.push(
    also.draftsWaiting === 0
      ? '  Nothing in the review queue.'
      : `  ${also.draftsWaiting} draft${also.draftsWaiting === 1 ? '' : 's'} waiting to be accepted or rejected.`,
  );
  if (also.runsNeedingSomebody > 0) {
    lines.push(
      `  ${also.runsNeedingSomebody} agent run${also.runsNeedingSomebody === 1 ? '' : 's'} out of attempts.`,
    );
  }
  lines.push('', 'Folio');
  return { subject, body: lines.join('\n') };
}

/**
 * Send each person their one mail, and mark what went in it.
 *
 * One transaction per person, and the rows are re-checked inside it with `FOR UPDATE SKIP LOCKED`:
 * two drains must never both send today's envelope, which is the one failure a reader actually
 * notices. A person whose send throws has every row in their digest credited an attempt and keeps
 * `last_error`, so the next run tries again and `MAX_SEND_ATTEMPTS` eventually stops it.
 *
 * `sender` is the shared relay, and is null when none is configured. A person who has linked their
 * own mailbox is sent through that instead; `sender` is then only the fallback, and somebody with a
 * working mailbox of their own gets their digest even with no shared relay at all.
 *
 * A null shared relay and no linked mailbox is a valid state and not a failure — the outbox is
 * still the record — so this reports what it could not send rather than throwing, the same call
 * `drainOutbox` makes and for the same reason.
 */
export async function sendDigests(sender: Sender | null, now = new Date()): Promise<DigestResult> {
  const out: DigestResult = { sent: 0, failed: 0, skipped: 0 };
  const people = await waiting(now);
  if (people.length === 0) return out;

  // Only the hour returns early. A null shared relay used to skip everybody here, before anyone's
  // own mailbox had been looked up — and this module's header states the intended rule in as many
  // words: "A null shared relay **and** no linked mailbox is a valid state." And, not or. A person
  // who has linked their own company address needs no shared relay at all, and was having their
  // digest withheld because somebody else's route was unconfigured.
  if (istHour(now) < DIGEST_HOUR) {
    out.skipped = people.length;
    return out;
  }

  const also = await standing();
  for (const person of people) {
    // **Their own mailbox first, the shared relay second.** A person who has linked one gets their
    // digest from their own company address — it passes their domain's SPF and DKIM and threads
    // with the rest of their mail. Falling back rather than failing is deliberate: a mailbox whose
    // password was rotated at the provider should cost that person a differently-addressed mail,
    // not a missing one. `last_error` is what makes the fallback visible instead of silent.
    let via: Sender | null = sender;
    let ownMailbox = false;
    try {
      const cfg = await configFor(person.userId);
      if (cfg) { via = smtpSender(cfg); ownMailbox = true; }
    } catch (err) {
      // Opening the secret failed — MAILBOX_KEY missing or rotated, or the row was tampered with.
      // Recorded against the mailbox and then ignored, because the digest may still have a way to
      // go: the shared relay, if there is one.
      await recordMailboxResult(person.userId, String(err instanceof Error ? err.message : err));
    }

    // Now it is answerable per person, which is the only level at which it is a real question:
    // no mailbox of their own and no shared relay means there is no route to them today. Their
    // rows stay in the outbox unstamped, which is the record, and they are counted as skipped
    // rather than failed — nothing was attempted and nothing went wrong.
    if (via === null) {
      out.skipped++;
      continue;
    }

    await serviceTxn('system:agents', async (c) => {
      // Re-read inside the transaction. `waiting()` ran outside it, and between the two another
      // drain may have taken this person — or a producer may have added a row, which should go in
      // today's envelope rather than waiting a day for the next one.
      const { rows: mine } = await c.query<{ id: string; kind: string; subject: string; body: string }>(
        `SELECT id, kind, subject, body FROM notification_outbox
          WHERE recipient = $1 AND sent_at IS NULL AND attempts < $2 AND kind <> 'brief'
          ORDER BY queued_at
          FOR UPDATE SKIP LOCKED`,
        [person.userId, MAX_SEND_ATTEMPTS],
      );
      if (mine.length === 0) return;

      const { subject, body } = composeDigest(person, mine, now, also);
      const ids = mine.map((m) => m.id);
      try {
        await via({ to: person.email, subject, body });
        // Stamped with the pass's instant, not `now()`. Same one-clock argument as `waiting()`:
        // this column is what the next run reads to decide "a digest went today", so the write and
        // the read have to agree about when today is. It also means one pass's envelopes share a
        // timestamp, which is true — they are one batch.
        await c.query(
          'UPDATE notification_outbox SET sent_at = $2::timestamptz WHERE id = ANY($1)',
          [ids, now.toISOString()],
        );
        out.sent++;
        if (ownMailbox) await recordMailboxResult(person.userId, null);
      } catch (err) {
        await c.query(
          `UPDATE notification_outbox
              SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1)`,
          [ids, String(err instanceof Error ? err.message : err).slice(0, 500)],
        );
        out.failed++;
        if (ownMailbox) {
          await recordMailboxResult(person.userId, String(err instanceof Error ? err.message : err));
        }
      }
    });
  }
  return out;
}
