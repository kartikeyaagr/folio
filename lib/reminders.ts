/**
 * Reminders.
 *
 * Set to a date, not a minute. Nobody here wants a notification at 14:32; they want to be told
 * today about the thing they said they would do today. That is why the delivering agent runs
 * hourly rather than daily — hourly is about not making somebody wait until tomorrow morning for
 * something they asked to see this afternoon.
 *
 * A repeating reminder is **rescheduled on completion, never duplicated**, so there is only ever
 * one live instance of it. The alternative — generating the next occurrence when the current one
 * comes due — produces a growing pile of untouched reminders for anything nobody gets round to.
 */

import { readTxn, rowId, serviceTxn, writeTxn } from './db.ts';

export type Repeat = 'weekly' | 'monthly' | 'quarterly';


export interface Reminder {
  id: string;
  body: string;
  dueOn: string;
  companyId: string | null;
  symbol: string | null;
  repeats: Repeat | null;
  assignedTo: string | null;
}

export interface CreateInput {
  body: string;
  dueOn: string;
  companyId?: string | null;
  repeats?: Repeat | null;
  assignedTo?: string | null;
}

export class EmptyReminder extends Error {}

/**
 * Create one. Leaving out the assignee means *you*, which is not the same as *everybody*.
 *
 * `assignedTo ?? actorId` catches an explicit null as well as an omission, so no reminder made
 * here can ever be unassigned. `deliverDue` below does handle an unassigned row — it queues a
 * notification for every live user, for the same reason an uncovered company's alerts go to
 * everyone — but only a row written by something other than this function can reach that branch.
 * If a shared reminder is ever wanted, this default is the line to change, not `deliverDue`.
 */
export async function createReminder(input: CreateInput, actorId: string): Promise<string> {
  if (!input.body.trim()) throw new EmptyReminder('A reminder needs something to say.');
  const reminderId = rowId();
  await writeTxn(actorId, async (c) => {
    await c.query(
      `INSERT INTO reminders (id, body, due_on, company_id, repeats, created_by, assigned_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        reminderId, input.body.trim(), input.dueOn, input.companyId ?? null,
        input.repeats ?? null, actorId, input.assignedTo ?? actorId,
      ],
    );
  });
  return reminderId;
}

/** Advance a date by one period. Month arithmetic is Postgres's, so month-ends behave. */
const NEXT: Record<Repeat, string> = {
  weekly: '7 days',
  monthly: '1 month',
  quarterly: '3 months',
};

/**
 * Complete a reminder.
 *
 * A repeating one is not marked complete: its due date moves forward. Marking it complete and
 * inserting a successor would leave a trail of finished rows that nobody reads and that make the
 * list look busier than it is.
 */
export async function completeReminder(reminderId: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    const { rows } = await c.query<{ repeats: Repeat | null }>(
      'SELECT repeats FROM reminders WHERE id = $1 AND completed_at IS NULL',
      [reminderId],
    );
    const r = rows[0];
    if (!r) return;

    if (r.repeats) {
      await c.query(
        `UPDATE reminders
            SET due_on = due_on + $2::interval, delivered_at = NULL
          WHERE id = $1`,
        [reminderId, NEXT[r.repeats]],
      );
    } else {
      await c.query('UPDATE reminders SET completed_at = now() WHERE id = $1', [reminderId]);
    }
  });
}

export async function snoozeReminder(
  reminderId: string,
  toDate: string,
  actorId: string,
): Promise<void> {
  await writeTxn(actorId, async (c) => {
    // delivered_at is cleared so the moved reminder is delivered again on its new date.
    await c.query(
      'UPDATE reminders SET due_on = $2, delivered_at = NULL WHERE id = $1 AND completed_at IS NULL',
      [reminderId, toDate],
    );
  });
}

/**
 * Everything due today or overdue, for everybody, whether or not it has been delivered.
 *
 * Deliberately not `deliverDue`'s predicate. That one also requires `delivered_at IS NULL`, which
 * is the whole of what makes running it hourly idempotent; this is a list of what is outstanding,
 * and a reminder you were mailed at seven is still outstanding at eleven. It is not filtered by
 * assignee either — a caller wanting one person's reminders has to say so itself.
 */
export async function dueReminders(): Promise<Reminder[]> {
  return readTxn(async (c) => {
    const { rows } = await c.query<Reminder>(
      `SELECT r.id, r.body, r.due_on AS "dueOn", r.company_id AS "companyId", co.symbol,
              r.repeats, r.assigned_to AS "assignedTo"
         FROM reminders r LEFT JOIN companies co ON co.id = r.company_id
        WHERE r.completed_at IS NULL AND r.due_on <= current_date
        ORDER BY r.due_on`,
    );
    return rows;
  });
}

/**
 * Queue a notification for every reminder that has come due and not yet been delivered.
 *
 * `delivered_at` is what makes this idempotent: running hourly does not send the same reminder
 * every hour. Clearing it on snooze or reschedule is what makes the *next* occurrence deliverable.
 */
export async function deliverDue(): Promise<number> {
  return serviceTxn('system:agents', async (c) => {
    const { rows } = await c.query<{
      id: string; body: string; due_on: string; assigned_to: string | null; symbol: string | null;
    }>(
      `SELECT r.id, r.body, r.due_on, r.assigned_to, co.symbol
         FROM reminders r LEFT JOIN companies co ON co.id = r.company_id
        WHERE r.completed_at IS NULL
          AND r.delivered_at IS NULL
          AND r.due_on <= current_date
        FOR UPDATE OF r`,
    );

    let queued = 0;
    for (const r of rows) {
      // An unassigned reminder goes to everyone rather than to nobody, for the same reason an
      // uncovered company's alerts do.
      const { rows: to } = r.assigned_to
        ? { rows: [{ id: r.assigned_to }] }
        : await c.query<{ id: string }>('SELECT id FROM users WHERE disabled_at IS NULL');

      for (const u of to) {
        await c.query(
          `INSERT INTO notification_outbox (id, kind, recipient, subject, body, reminder_id)
           VALUES ($1,'reminder',$2,$3,$4,$5)`,
          [
            rowId(), u.id,
            r.symbol ? `Reminder: ${r.symbol}` : 'Reminder',
            `${r.body}\n\nDue ${r.due_on}.`,
            r.id,
          ],
        );
        queued++;
      }
      await c.query('UPDATE reminders SET delivered_at = now() WHERE id = $1', [r.id]);
    }
    return queued;
  });
}
