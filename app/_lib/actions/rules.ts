'use server';

import { revalidatePath } from 'next/cache';

import {
  approveRule,
  rejectRule,
  retireRule,
  RuleAlreadyDecided,
  RuleReasonRequired,
  RuleTextRequired,
  UnknownRule,
  writeRule,
} from '@/lib/agents/rules.ts';

import { flash } from '../flash.ts';
import { requireUser } from '../session.ts';

/**
 * Everything `/rules` writes.
 *
 * Each of these calls `requireUser()` itself rather than trusting the page that rendered the form —
 * a server action is a POST endpoint with a stable id, and gating only the page would gate nothing.
 * Not `requireAdmin()`: §7 puts these decisions with the three analysts who review the drafts, not
 * with whoever happens to hold the admin flag. The record of who decided is `decided_by`.
 *
 * Failures that are somebody's decision — an approval with no sentence, a refusal with no reason, a
 * candidate already decided — come back as a message. Anything else is a real fault and throws.
 */
async function guarded(work: () => Promise<string>): Promise<void> {
  try {
    await flash(await work());
  } catch (err) {
    if (
      err instanceof RuleTextRequired ||
      err instanceof RuleReasonRequired ||
      err instanceof RuleAlreadyDecided ||
      err instanceof UnknownRule
    ) {
      await flash(err.message);
    } else {
      throw err;
    }
  }
  revalidatePath('/rules');
}

export async function propose(form: FormData): Promise<void> {
  const user = await requireUser();
  await guarded(async () => {
    const agent = String(form.get('agent') ?? '');
    await writeRule(agent, String(form.get('rule') ?? ''), user.userId);
    return `Written for ${agent}. It is a candidate until somebody approves it.`;
  });
}

export async function approve(form: FormData): Promise<void> {
  const user = await requireUser();
  await guarded(async () => {
    await approveRule(String(form.get('id') ?? ''), String(form.get('rule') ?? ''), user.userId);
    return `Approved as ${user.email}. It is in the agent's prompt from the next run.`;
  });
}

export async function refuse(form: FormData): Promise<void> {
  const user = await requireUser();
  await guarded(async () => {
    await rejectRule(String(form.get('id') ?? ''), String(form.get('note') ?? ''), user.userId);
    // Said out loud because it is the non-obvious half: the corrections behind a refused candidate
    // stay attached to the refusal, so the same three never ask again and three fresh ones will.
    return `Refused as ${user.email}. Those corrections will not raise this again.`;
  });
}

export async function retire(form: FormData): Promise<void> {
  const user = await requireUser();
  await guarded(async () => {
    await retireRule(String(form.get('id') ?? ''), String(form.get('note') ?? ''), user.userId);
    return `Withdrawn as ${user.email}. It leaves the prompt and stays in the record.`;
  });
}
