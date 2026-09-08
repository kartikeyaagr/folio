'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { changePassword, WeakPassword, WrongPassword } from '@/lib/auth.ts';

import { flash } from '../flash.ts';
import { SESSION_COOKIE } from '../session-cookie.ts';
import { requireUser } from '../session.ts';

/**
 * Changing your own password, from inside the application.
 *
 * Deliberately *not* a "forgot password" route. `app/(public)/login/page.tsx` declines that on
 * purpose — a lost password is recovered by a person with VM access using a recovery code — and
 * this does not reopen it: you must already be signed in, and you must know the current password.
 * What it replaces is the previous situation, where `setPassword` existed with no caller at all,
 * so the temporary password `jobs/seed-user.ts` prints was the password forever, despite the job
 * telling you to change it on first login.
 */
export async function changePasswordAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');
  const confirm = String(form.get('confirm') ?? '');

  if (next !== confirm) {
    await flash('The two new passwords do not match. Nothing was changed.');
    return;
  }

  // The current session's token is kept alive; every other one is revoked inside changePassword.
  // Read here rather than passed from the client: a token the browser could send is a token the
  // browser could send a different value for.
  const keep = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  try {
    await changePassword(user.userId, current, next, keep);
    await flash(
      `Password changed for ${user.email}. Any other signed-in session has been signed out.`,
    );
  } catch (err) {
    // Both are things a person did rather than faults, and both say which so the reader knows
    // whether to retype the old one or pick a longer new one.
    if (err instanceof WrongPassword || err instanceof WeakPassword) {
      await flash(err.message);
      return;
    }
    throw err;
  }

  revalidatePath('/');
}
