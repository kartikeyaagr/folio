import { NextResponse } from 'next/server';

import { revokeSession } from '@/lib/auth.ts';

import { clearSessionCookie } from '../_lib/session.ts';

/**
 * Sign out.
 *
 * A route rather than a server action so the rail's menu can be a plain link and stay scriptless.
 * The session is revoked in the database as well as dropped from the browser — a cookie deleted on
 * one device must not leave the token usable from another.
 */
export async function GET(): Promise<NextResponse> {
  const token = await clearSessionCookie();
  if (token) await revokeSession(token, 'system:auth');
  return NextResponse.redirect(new URL('/login', process.env.APP_URL ?? 'http://localhost:3100'));
}
