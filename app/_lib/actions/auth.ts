'use server';

import { redirect } from 'next/navigation';

import { login, revokeSession } from '@/lib/auth.ts';

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

  const session = await login(email, password);
  if (!session) return 'That email address and password do not match.';

  await setSessionCookie(session.token, session.expiresAt);
  // Only a path on this app, never an absolute URL: an open redirect turns the login page into a
  // credible way to send somebody somewhere else.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export async function signOut(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await revokeSession(token, 'system:auth');
  redirect('/login');
}
