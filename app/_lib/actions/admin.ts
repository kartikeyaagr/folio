'use server';

import { revalidatePath } from 'next/cache';

import { decideRequest, NoSuchRequest, ReasonRequired } from '@/lib/access-requests.ts';
import {
  setAgentEffort,
  setAgentEnabled,
  setAlertRule,
  setNewsSourceActive,
  setUserAdmin,
  setUserDisabled,
  WouldLockYouOut,
} from '@/lib/admin.ts';
import { requeue } from '@/lib/agents/runner.ts';

import { flash } from '../flash.ts';
import { requireAdmin } from '../session.ts';

/**
 * Everything the admin panel writes.
 *
 * Every one of these calls `requireAdmin()` itself rather than trusting the page that rendered the
 * form. A server action is a POST endpoint with a stable id; gating only the page would leave the
 * endpoint open to anybody signed in.
 *
 * Failures that are somebody's decision — a rejection with no reason, the last admin, a request
 * already decided — come back as a message rather than an error boundary. Anything else is a real
 * fault and is allowed to throw.
 */
async function guarded(work: () => Promise<string>): Promise<void> {
  try {
    await flash(await work());
  } catch (err) {
    if (
      err instanceof WouldLockYouOut ||
      err instanceof ReasonRequired ||
      err instanceof NoSuchRequest
    ) {
      await flash(err.message);
    } else {
      throw err;
    }
  }
  revalidatePath('/admin');
}

export async function decideRequestAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const decision = String(form.get('decision') ?? '') === 'approved' ? 'approved' : 'rejected';
    const r = await decideRequest(
      String(form.get('id') ?? ''),
      decision,
      admin.userId,
      String(form.get('note') ?? ''),
    );
    return decision === 'approved'
      ? `Approved ${r.email}. Create the account on the VM: pnpm exec tsx jobs/seed-user.ts --email ${r.email} --name "${r.name}"`
      : `Refused ${r.email}, as ${admin.email}`;
  });
}

export async function setAdminAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const id = String(form.get('id') ?? '');
    const grant = String(form.get('grant') ?? '') === '1';
    await setUserAdmin(id, grant, admin.userId);
    return `${grant ? 'Granted' : 'Revoked'} admin, as ${admin.email}`;
  });
}

export async function setDisabledAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const id = String(form.get('id') ?? '');
    const disable = String(form.get('disable') ?? '') === '1';
    await setUserDisabled(id, disable, admin.userId);
    return disable
      ? `Account disabled and its sessions revoked, as ${admin.email}`
      : `Account re-enabled, as ${admin.email}`;
  });
}

export async function setAgentEnabledAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const key = String(form.get('key') ?? '');
    const on = String(form.get('on') ?? '') === '1';
    await setAgentEnabled(key, on, admin.userId);
    return `${key} ${on ? 'enabled' : 'disabled'}, as ${admin.email}`;
  });
}

export async function setAgentEffortAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const key = String(form.get('key') ?? '');
    const effort = String(form.get('effort') ?? '').trim();
    await setAgentEffort(key, effort || null, admin.userId);
    return `${key} now runs at ${effort || 'the model default'}, as ${admin.email}`;
  });
}

export async function setAlertRuleAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const key = String(form.get('key') ?? '');
    const severity = String(form.get('severity') ?? '').trim();
    const active = form.get('active');
    await setAlertRule(
      key,
      { severity: severity || undefined, active: active === null ? undefined : active === '1' },
      admin.userId,
    );
    return `${key} updated, as ${admin.email}`;
  });
}

export async function setNewsSourceAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const key = String(form.get('key') ?? '');
    const on = String(form.get('on') ?? '') === '1';
    await setNewsSourceActive(key, on, admin.userId);
    return `${key} ${on ? 'enabled' : 'disabled'}, as ${admin.email}`;
  });
}

export async function requeueRunAction(form: FormData): Promise<void> {
  const admin = await requireAdmin();
  await guarded(async () => {
    const id = String(form.get('id') ?? '');
    const ok = await requeue(id);
    return ok ? `Run ${id} queued again, as ${admin.email}` : `Run ${id} could not be requeued.`;
  });
}
