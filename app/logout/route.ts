import { NextResponse } from 'next/server';

import { revokeSession } from '@/lib/auth.ts';

import { clearSessionCookie } from '../_lib/session.ts';

/**
 * Sign out.
 *
 * A route rather than a server action so the rail's menu stays scriptless. **POST, not GET**: this
 * revokes the session in the database, and a state-changing GET is reachable by anything that can
 * make the browser issue one — `<img src="https://…/logout">` in an email signed the reader out.
 * Low stakes behind Tailscale, and the fix costs nothing: a one-button `<form method="post">`
 * needs no script either, which was the whole reason for choosing a route.
 *
 * The session is revoked in the database as well as dropped from the browser — a cookie deleted on
 * one device must not leave the token usable from another.
 */
export async function POST(): Promise<NextResponse> {
  const token = await clearSessionCookie();
  if (token) await revokeSession(token, 'system:auth');
  // 303, so the browser follows with GET rather than re-POSTing to /login.
  return NextResponse.redirect(
    new URL('/login', process.env.APP_URL ?? 'http://localhost:3100'),
    303,
  );
}
