/**
 * The session cookie's name, and nothing else.
 *
 * Dependency-free on purpose. `middleware.ts` runs on the Edge runtime, which has no node:crypto
 * and no TCP sockets, so anything it imports must stay clear of the auth and database code.
 *
 * On the `__Host-` prefix: browsers enforce it, refusing the cookie unless it is Secure, Path=/ and
 * carries no Domain attribute. That last part is the point — if this app ever shares a parent
 * domain with anything else, the prefix makes the cookie host-only in a way an attacker cannot talk
 * the browser out of.
 *
 * Over plain HTTP the `__Host-` prefix is refused outright, so the name drops the prefix when the
 * app is not served over TLS. That is a development affordance and nothing else: the VM terminates
 * TLS, so the prefix is present everywhere it matters.
 */
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-trisula_session' : 'trisula_session';

export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
