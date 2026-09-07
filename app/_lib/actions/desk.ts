'use server';

import { revalidatePath } from 'next/cache';

import { acknowledge } from '@/lib/alerts.ts';
import { completeReminder } from '@/lib/reminders.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Clearing something off the desk.
 *
 * Every write is attributed to the person who made it — Postgres refuses an unattributed one — so
 * the acting user is resolved here and passed down rather than defaulted to a service principal.
 * The toast says what was recorded and as whom, because a confirmation that says "Saved" tells the
 * reader nothing they can check.
 */
export async function acknowledgeAlert(form: FormData): Promise<void> {
  const user = await requireUser();
  await acknowledge(String(form.get('id') ?? ''), user.userId);
  await flash(`Acknowledged as ${user.email}`);
  revalidatePath('/');
}

export async function completeReminderAction(form: FormData): Promise<void> {
  const user = await requireUser();
  await completeReminder(String(form.get('id') ?? ''), user.userId);
  // A repeating reminder is not closed here; it moves forward. The message says which happened
  // rather than claiming a completion the row may not show.
  await flash(`Reminder cleared as ${user.email}`);
  revalidatePath('/');
}
