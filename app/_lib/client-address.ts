import { headers } from 'next/headers';

/**
 * The caller's address, for rate limiting.
 *
 * **Only as trustworthy as what sits in front of the app.** `ops/SETUP.md` §8 binds the server to
 * `127.0.0.1` and reaches it over Tailscale or a reverse proxy on the same box, so the leftmost
 * `x-forwarded-for` entry is written by something we run. If the app is ever exposed directly,
 * this header becomes attacker-controlled and the per-address limit becomes decorative.
 *
 * That is why the per-address limit is the looser of the two and the per-email one is the limit
 * that actually protects an account: the email key cannot be forged, because it is the thing being
 * attacked. This returns null rather than a placeholder when no header is present — a shared
 * constant would put every caller in one bucket and lock everybody out at once.
 */
export async function clientAddress(): Promise<string | undefined> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return h.get('x-real-ip')?.trim() || undefined;
}
