'use server';

import { revalidatePath } from 'next/cache';

import { acceptDraft, NotAChoice, rejectDraft, UnwritablePath } from '@/lib/agents/review.ts';
import { positionOf } from '@/lib/agents/paths.ts';
import { requeue } from '@/lib/agents/queue.ts';
import { enqueue } from '@/lib/agents/queue.ts';

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
/**
 * Accept, with whatever the reviewer changed.
 *
 * Until R5a this passed `null` unconditionally and the form carried no fields, so
 * `ai_drafts.edits` was structurally always `{}` and mean edit distance — the number §7 stakes the
 * whole learning loop on — would have rendered 0.000 for every agent forever. That reads as "the
 * agents are perfect" and meant "nobody can correct them".
 *
 * Two grammars, both carrying a path from `lib/agents/paths.ts`: `f.<path>` is what a position was
 * corrected to, `d.<path>` is a position to drop. Everything after the two-character prefix is the
 * path, and `acceptDraft` refuses any that does not already name a piece of text in the draft — so
 * what comes back from here is a patch over what the agent wrote, never a replacement.
 *
 * **A refused path is flashed, not swallowed.** The alternative is a correction that silently did
 * not happen, on the one screen whose entire purpose is that corrections happen.
 */
export async function accept(form: FormData): Promise<void> {
  const user = await requireUser();

  const edits: Record<string, string> = {};
  const drops: Record<string, number[]> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== 'string') continue;
    if (key.startsWith('f.')) {
      edits[key.slice(2)] = value;
    } else if (key.startsWith('d.')) {
      // A checkbox only appears in the FormData when it is ticked, so its presence is the request.
      const at = positionOf(key.slice(2));
      if (at) drops[at.array] = [...(drops[at.array] ?? []), at.index];
    }
  }

  const touched = Object.keys(edits).length > 0 || Object.keys(drops).length > 0;
  try {
    // An empty patch and a patch that changes nothing are the same acceptance, and both are honest:
    // `draftDistance` scores an unchanged draft 0, and the exemplar records `quality = 'accepted'`.
    await acceptDraft(String(form.get('id') ?? ''), touched ? { edits, drops } : null, user.userId);
    await flash(`Accepted as ${user.email}`);
  } catch (err) {
    if (err instanceof UnwritablePath || err instanceof NotAChoice) await flash(err.message);
    else throw err;
  }
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
