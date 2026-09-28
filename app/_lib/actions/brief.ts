'use server';

import { revalidatePath } from 'next/cache';

import { enqueue } from '@/lib/agents/queue.ts';
import { ASKABLE_DAYS, briefInFlight } from '@/lib/briefs.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Ask for a brief beyond the one that arrives at 08:00 IST.
 *
 * Refused while a brief is already queued or being written, the morning's included. Agent 6 runs
 * at `xhigh` over every followed name, and two written from the same material in the same minute
 * are the same answer paid for twice and mailed to everybody twice.
 *
 * A brief asked for here is never the day's brief. It carries no `subject_ref`, so it cannot stop
 * the morning's from being queued or cause a second one (`sweep` in lib/agents/newsbrief.ts). Its
 * window is one of `ASKABLE_DAYS`, never the morning's 24 hours, so it is not a copy of it either.
 * Once written it is published and mailed like the morning's, because the fund's decision covers
 * the brief and not only the scheduled run.
 */
export async function askForBrief(form: FormData): Promise<void> {
  const user = await requireUser();

  if (await briefInFlight()) {
    await flash('A brief is already being written. It will be here, and in everybody’s inbox, shortly.');
    revalidatePath('/news/brief');
    return;
  }

  const days = Number(form.get('days') ?? 7);
  await enqueue({
    agentKey: 'news-brief',
    requestedBy: user.userId,
    request: { days: ASKABLE_DAYS.includes(days) ? days : 7 },
  });
  await flash(`Brief queued as ${user.email}. It runs on the next sweep and is mailed to everybody.`);
  revalidatePath('/news/brief');
}
