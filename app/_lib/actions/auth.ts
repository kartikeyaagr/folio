'use server';

import { redirect } from 'next/navigation';

import { login, revokeSession, TooManyAttempts } from '@/lib/auth.ts';

import { clientAddress } from '../client-address.ts';
import { localPath } from '../local-path.ts';

import { clearSessionCookie, setSessionCookie } from '../session.ts';

/**
 * Sign in.
 *
 * The failure message never distinguishes an unknown address from a wrong password. `login()`
 * already spends the same work on both — it verifies against a computed dummy hash when no user
 * exists — and a message that told them apart would give that timing equivalence away for free.
 */
export async function signIn(_prev: string | null, form: FormData): Promise<string | null> {
  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  const next = String(form.get('next') ?? '/');

  if (!email || !password) return 'Enter your email address and password.';

  let session: Awaited<ReturnType<typeof login>>;
  try {
    session = await login(email, password, await clientAddress());
  } catch (err) {
    if (err instanceof TooManyAttempts) return err.message;
    throw err;
  }
  if (!session) return 'That email address and password do not match.';

  await setSessionCookie(session.token, session.expiresAt);
  redirect(localPath(next));
}

/**
 * Sign out, and mean it.
 *
 * Deliberately not behind `requireUser()`, unlike every other action outside this file. The
 * request most in need of this one is the request whose session no longer resolves — expired,
 * revoked from another browser, an account just disabled — and demanding a live session before
 * letting go of a dead one would redirect that person to `/login` with the stale cookie still on
 * their machine, which is the single state sign-out exists to escape. There is nothing to guard
 * either: the only thing reachable from here is the token the caller already presented.
 *
 * The revocation is attributed to `system:auth` rather than to the person, because no user id is
 * in hand — nothing here resolves the token, and doing so would cost a round trip to learn a name
 * this write does not need. `pruneExpiredSessions` uses the same principal, so `audit_log` tells a
 * consistent story about sessions ending; the cost is that it cannot say who ended this one.
 *
 * The cookie goes first and the row second, so a revoke that fails still leaves the browser signed
 * out — and the row it could not reach expires on its own.
 */
export async function signOut(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await revokeSession(token, 'system:auth');
  redirect('/login');
}
