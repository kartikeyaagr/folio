'use server';

import { revalidatePath } from 'next/cache';

import {
  acceptDraft, NotAChoice, PUBLISHED_WITHOUT_REVIEW, rejectDraft, UnwritablePath,
} from '@/lib/agents/review.ts';
import { missingSubject } from '@/lib/agents/invocable.ts';
import { isSubjectFor } from '@/lib/agents/subjects.ts';
import { positionOf } from '@/lib/agents/paths.ts';
import { enqueue, requeue } from '@/lib/agents/queue.ts';
import { pendingBrief } from '@/lib/briefs.ts';

import { flash } from '../flash.ts';
import { requireAdmin, requireUser } from '../session.ts';

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
    await flash('A rejection needs a reason.');
    revalidatePath('/review');
    return;
  }
  await rejectDraft(String(form.get('id') ?? ''), reason, user.userId);
  await flash(`Rejected as ${user.email}`);
  revalidatePath('/review');
}

/**
 * Put a failed run back on the queue, from the screen that shows it failed.
 *
 * **Admin, because both doors onto this operation are.** It asked for `requireUser()` until
 * 21-Sep-2026 while `app/(app)/agents/page.tsx:78` — the only page that renders the button —
 * calls `requireAdmin()` before it draws anything, and `requeueRunAction` in `actions/admin.ts`
 * is the same `requeue()` call behind `requireAdmin()` on `/admin`. A server action is a POST
 * endpoint nobody has to render a page to reach, so the effective permission for requeueing any
 * agent run was "signed in" while every surface offering it was admin-only.
 *
 * Raised rather than lowered because that is where the two agreed. The queue is operating
 * machinery and both screens that expose it are the admin's; §7 puts the *drafts* with the three
 * analysts, which is `/review` and is a different question from who may spend a model call.
 *
 * Nothing it can reach is destructive either way: a requeue re-runs an agent, which costs money
 * and produces a draft that still has to be accepted by a person before it enters the record.
 * That is the reason this was a gate worth getting right rather than an incident.
 */
export async function retryRun(form: FormData): Promise<void> {
  await requireAdmin();
  const ok = await requeue(String(form.get('id') ?? ''));
  await flash(ok ? 'Queued again' : 'That run could not be requeued');
  revalidatePath('/agents');
}

/**
 * Somebody asks, and the asking is the trigger.
 *
 * **Everything is checked against `lib/agents/`, never against the form that rendered it.** A
 * server action is a POST endpoint, and the only thing that had ever narrowed this one was which
 * `<select>` the page drew. `agent_runs.agent_key` has a foreign key to `agents`, so no request
 * could invent an agent — but any of the others could be named, and each has a handler that throws
 * on its first line for want of something a forged POST would not supply.
 *
 * Four checks, in the order a request fails them:
 *
 *   1. the agent is one that may be asked at all (`INVOCABLE`);
 *   2. the request carries the subject that agent's handler will look for (`missingSubject`);
 *   3. the subject named is one this agent could legitimately be pointed at (`isSubjectFor`) —
 *      because a `<select>` is a suggestion and the value posted back is whatever the browser sent.
 *      Without this, a `subject_ref` from another company, or a superseded period, would enqueue a
 *      run that fails after it has been claimed.
 *   4. for the brief specifically, that one is not already in flight (`pendingBrief`) — the same
 *      refusal `askForBrief` (app/_lib/actions/brief.ts) makes from the brief's own page. `/chat`
 *      is a second door onto every invocable agent, the brief included, and without this check it
 *      queued a second one for as long as the first took to write — and every brief is now mailed
 *      to everybody the moment it lands.
 */
export async function askAgent(form: FormData): Promise<void> {
  const user = await requireUser();
  const agentKey = String(form.get('agent') ?? '');
  const companyId = String(form.get('company') ?? '') || null;
  const subjectRef = String(form.get('subject') ?? '') || null;

  const why = missingSubject(agentKey, companyId, subjectRef);
  if (why !== null) {
    await flash(why);
    revalidatePath('/chat');
    return;
  }
  if (subjectRef !== null && !(await isSubjectFor(agentKey, companyId, subjectRef))) {
    await flash('This agent cannot be pointed at that.');
    revalidatePath('/chat');
    return;
  }
  if (agentKey === 'news-brief') {
    const why = await pendingBrief();
    if (why !== null) {
      await flash(why);
      revalidatePath('/chat');
      return;
    }
  }

  await enqueue({ agentKey, companyId, subjectRef, requestedBy: user.userId });
  // The brief never passes through Review (0067), and saying it will sends somebody to wait there.
  await flash(PUBLISHED_WITHOUT_REVIEW.has(agentKey)
    ? `Queued ${agentKey}. It is published as soon as it is written, without review, and mailed ` +
      'to everybody.'
    : `Queued ${agentKey}. Its draft will appear in Review.`);
  revalidatePath('/chat');
}
