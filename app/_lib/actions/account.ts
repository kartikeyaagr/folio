'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';

import { changePassword, WeakPassword, WrongPassword } from '@/lib/auth.ts';
import { forgetMailbox, linkMailbox, markMailboxPrompted, MailboxRefused, NoMailboxKey } from '@/lib/mailbox.ts';

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
    await flash('The two new passwords do not match.');
    return;
  }

  // The current session's token is kept alive; every other one is revoked inside changePassword.
  // Read here rather than passed from the client: a token the browser could send is a token the
  // browser could send a different value for.
  const keep = (await cookies()).get(SESSION_COOKIE)?.value ?? '';

  try {
    await changePassword(user.userId, current, next, keep);
    await flash(`Password changed for ${user.email}. Every other session has been signed out.`);
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

/**
 * Link the mailbox the daily digest goes out through.
 *
 * **The password is proved and then sealed, and this action never sees it again.** `linkMailbox`
 * sends a real message with what was typed — a relay that accepts AUTH and then refuses the
 * envelope is a working login and a useless mailbox, which is exactly what Hostinger does when the
 * From: is not the authenticated box — and only writes the row if that message went. Nothing is
 * stored on a failure: a credential that has never carried anything is one somebody has to go and
 * test later, which is how a mailbox comes to be "linked" and dead.
 *
 * `MAILBOX_KEY` absent is refused rather than worked around. There is no path here that writes a
 * password in the clear.
 */
export async function linkMailboxAction(form: FormData): Promise<void> {
  const user = await requireUser();
  const port = Number(form.get('port') ?? 587);
  try {
    await linkMailbox(user.userId, {
      host: String(form.get('host') ?? ''),
      port: Number.isFinite(port) ? port : 587,
      username: String(form.get('username') ?? ''),
      password: String(form.get('password') ?? ''),
      fromAddress: String(form.get('from') ?? ''),
    });
    await flash(`Mailbox linked. A test message is on its way to ${String(form.get('from') ?? '')}.`);
  } catch (err) {
    // Both are things a person can fix from the form they are looking at — a wrong password, a
    // host that does not resolve, a From: the relay will not send as — so both are said in words
    // rather than becoming an error page.
    if (err instanceof MailboxRefused || err instanceof NoMailboxKey) await flash(err.message);
    else throw err;
  }
  revalidatePath('/', 'layout');
}

/** Unlink. The digest goes back through the shared relay, which is where everybody starts. */
export async function forgetMailboxAction(): Promise<void> {
  const user = await requireUser();
  await forgetMailbox(user.userId);
  await flash('Mailbox unlinked. Your daily update will come from the desk relay.');
  revalidatePath('/', 'layout');
}

/** "Not now." Recorded so the prompt is shown once, whichever way it is answered. */
export async function dismissMailboxPromptAction(): Promise<void> {
  const user = await requireUser();
  await markMailboxPrompted(user.userId);
  revalidatePath('/', 'layout');
}
