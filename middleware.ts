import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@/app/_lib/session-cookie.ts';

/**
 * Cheap first pass: bounce requests with no session cookie straight to /login.
 *
 * This is NOT the authentication boundary. It runs on the Edge runtime and cannot reach Postgres,
 * so it can only see that a cookie exists, never that it names a live session. The real check is
 * `requireUser()` in the (app) layout. This exists so an unauthenticated visitor gets a login page
 * without a database round trip first.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  // The uptime monitor cannot authenticate. Health is the one exempt route; it exposes nothing but
  // reachability, and gating it would mean the monitor only ever proved that /login renders.
  if (pathname === '/api/health') return NextResponse.next();

  if (!request.cookies.has(SESSION_COOKIE) && pathname !== '/login') {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next internals and static assets. There is no allowlist of public pages
  // beyond /login: this is an internal tool with no guest access at all.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
