import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { resolveSession, type Session } from '@/lib/auth.ts';

import { SESSION_COOKIE, SECURE_COOKIES } from './session-cookie.ts';

/**
 * The real authentication boundary.
 *
 * The middleware only sees whether a cookie exists; this resolves the token against the database
 * and is what the (app) layout calls. Every page inside that layout is protected by *existing*
 * rather than by its author remembering a check — making a page public means deliberately putting
 * it in (public).
 */
export async function currentUser(): Promise<Session | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<Session> {
  const session = await currentUser();
  if (!session) redirect('/login');
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<string | undefined> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  return token;
}
