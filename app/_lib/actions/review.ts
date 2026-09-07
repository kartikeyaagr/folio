'use server';

import { revalidatePath } from 'next/cache';

import { acceptDraft, rejectDraft } from '@/lib/agents/review.ts';
import { requeue } from '@/lib/agents/runner.ts';
import { enqueue } from '@/lib/agents/runner.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * The review gate.
 *
 * Nothing an agent writes enters the record until a person accepts it. The acceptance is attributed
 * to that person and the diff between what the model wrote and what was accepted is recorded
 * field by field — so "who agreed to this" and "what did they change" are both answerable later.
 *
 * A rejection requires a reason. Not politeness: a queue of rejections with no reasons is a queue
 * that teaches nobody anything, and the reason is the only evidence that an agent is not working.
 */
export async function accept(form: FormData): Promise<void> {
  const user = await requireUser();
  await acceptDraft(String(form.get('id') ?? ''), null, user.userId);
  await flash(`Accepted as ${user.email}`);
  revalidatePath('/review');
}

export async function reject(form: FormData): Promise<void> {
  const user = await requireUser();
  const reason = String(form.get('reason') ?? '').trim();
  if (!reason) {
    await flash('A rejection needs a reason — that is the only record of what the agent got wrong.');
    revalidatePath('/review');
    return;
  }
  await rejectDraft(String(form.get('id') ?? ''), reason, user.userId);
  await flash(`Rejected as ${user.email}`);
  revalidatePath('/review');
}

export async function retryRun(form: FormData): Promise<void> {
  await requireUser();
  const ok = await requeue(String(form.get('id') ?? ''));
  await flash(ok ? 'Queued again' : 'That run could not be requeued');
  revalidatePath('/agents');
}

/** Agents 3 and 6 are prompted: somebody asks, and the asking is the trigger. */
export async function askAgent(form: FormData): Promise<void> {
  const user = await requireUser();
  const agentKey = String(form.get('agent') ?? '');
  const companyId = String(form.get('company') ?? '') || null;
  await enqueue({ agentKey, companyId, requestedBy: user.userId });
  await flash(`Queued ${agentKey}. It runs on the next sweep.`);
  revalidatePath('/agents');
}
