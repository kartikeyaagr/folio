'use server';

import { revalidatePath } from 'next/cache';

import { enqueue } from '@/lib/agents/queue.ts';
import { briefInFlight, pendingBrief } from '@/lib/briefs.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Ask for a brief.
 *
 * Refuses when one is already queued or already written and waiting. Agent 6 runs at `xhigh` over
 * every followed name; asking twice in a minute buys a second copy of the same answer and pays for
 * it. The refusal says which of the two it is, because "already queued" and "already written and
 * waiting on you" need different things from the person reading it.
 */
export async function askForBrief(form: FormData): Promise<void> {
  const user = await requireUser();

  if (await briefInFlight()) {
    await flash('A brief is already queued. It runs on the next sweep.');
    revalidatePath('/news/brief');
    return;
  }
  const waiting = await pendingBrief();
  if (waiting) {
    await flash('A brief is already waiting in Review.');
    revalidatePath('/news/brief');
    return;
  }

  const days = Number(form.get('days') ?? 7);
  await enqueue({
    agentKey: 'news-brief',
    requestedBy: user.userId,
    request: { days: Number.isFinite(days) && days > 0 ? days : 7 },
  });
  await flash(`Brief queued as ${user.email}. It runs on the next sweep.`);
  revalidatePath('/news/brief');
}
