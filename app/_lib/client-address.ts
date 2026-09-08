import { headers } from 'next/headers';

/**
 * The caller's address, for rate limiting — and **only when something we run put it there**.
 *
 * `x-forwarded-for` is a request header. Unless a proxy we control overwrites it, the client
 * chooses its value, and a rate-limit key the attacker chooses is not a rate limit. Worse than
 * useless, in fact: an attacker who can set the header can rotate it to evade the limit *and* can
 * forge a colleague's address to lock them out. A forgeable key hands out a denial-of-service.
 *
 * So it is trusted only when `TRUST_PROXY_HEADER=1`, which the operator sets when — and only when
 * — a reverse proxy on the box is overwriting the header. `ops/SETUP.md` §8 binds the app to
 * loopback and reaches it over Tailscale with no proxy in between, so the default is *not* to
 * trust it, and the per-address limit is simply not applied.
 *
 * That leaves the per-email limit, which is the one that protects an account and which cannot be
 * forged: the email is the thing being attacked. Losing the address limit costs the CPU protection
 * against a single attacker, which is real; claiming a protection that does not hold would be
 * worse, and the lockout vector worse still.
 */
export async function clientAddress(): Promise<string | undefined> {
  if (process.env['TRUST_PROXY_HEADER'] !== '1') return undefined;

  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    // Leftmost is the client where a trusted proxy appends. Only meaningful because the header was
    // rewritten by something we run — which is exactly what the flag above asserts.
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.get('x-real-ip')?.trim() || undefined;
}
