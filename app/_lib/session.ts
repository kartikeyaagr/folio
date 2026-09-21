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

/**
 * The same check, for a caller that cannot carry on without an answer.
 *
 * **`redirect()` works by throwing.** Nothing after this line runs, and a `try` that catches
 * broadly swallows the bounce and carries on as though nobody had been turned away. That is why
 * every action in `_lib/actions/` resolves its user *before* opening a try block, never inside
 * one — `admin.ts` and `rules.ts` call it outside `guarded()` for exactly this reason.
 *
 * The destination is not preserved here, and nothing downstream recovers it. `middleware.ts`
 * builds `?next=<path>`, but only for a request carrying no session cookie at all — the one case
 * that never reaches this function. What reaches it is the cookie that exists and no longer
 * resolves: expired, revoked from another browser, or an account disabled since the tab was
 * opened. Those land on a bare `/login`, and `signIn` then sends them to `/` because there is no
 * `next` to read.
 */
export async function requireUser(): Promise<Session> {
  const session = await currentUser();
  if (!session) redirect('/login');
  return session;
}

/**
 * The admin boundary, and the only one.
 *
 * Redirects rather than 404s: a person who lost admin between opening the page and submitting is
 * not an intruder, and sending them somewhere useful beats a dead end. Every admin action calls
 * this itself — a server action is its own entry point, reachable without ever rendering the page
 * that hosts it, so gating only the page would gate nothing.
 */
export async function requireAdmin(): Promise<Session> {
  const session = await requireUser();
  if (!session.isAdmin) redirect('/');
  return session;
}

/**
 * Hand the browser the session it has just earned. Four flags, each load-bearing.
 *
 * `httpOnly` keeps the token out of `document.cookie`, so script on the page cannot read it back
 * out. `secure` and `path: '/'` are both demanded by the `__Host-` prefix the name carries in
 * production — see `session-cookie.ts`. And `sameSite: 'lax'` rather than `'strict'`, because
 * `strict` withholds the cookie on a cross-site navigation: a bookmark, or a link pasted into
 * chat, would land on `/login` despite a perfectly good session, which reads as the app being
 * broken rather than as a policy.
 *
 * `expiresAt` is the value `issueSession` wrote into `sessions.expires_at`, passed through
 * unchanged, never recomputed here. The row is what `resolveSession` enforces; a cookie outliving
 * it leaves a browser that believes it is signed in and is bounced anyway, and a cookie expiring
 * first leaves a live row nobody can present.
 */
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

/**
 * Take the cookie off this browser, and hand the token back so the caller can kill the row too.
 *
 * **Returning the token is the whole point of the function.** Deleting the cookie ends the session
 * for this browser and for nothing else: `sessions` still holds a row that is neither revoked nor
 * expired, so any other copy of that token still resolves to a live session. A caller that drops
 * the return value has signed the person out of the screen in front of them and left the
 * credential working — `signOut` is the one caller, and it revokes.
 *
 * Undefined means there was no cookie to clear, which is the ordinary result of signing out twice
 * rather than a fault.
 */
export async function clearSessionCookie(): Promise<string | undefined> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  jar.delete(SESSION_COOKIE);
  return token;
}
