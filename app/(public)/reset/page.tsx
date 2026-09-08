import Link from 'next/link';
import { redirect } from 'next/navigation';

import { BadRecoveryCode, resetWithRecoveryCode, WeakPassword } from '@/lib/auth.ts';
import { hit } from '@/lib/rate-limit.ts';

import { clientAddress } from '../../_lib/client-address.ts';
import { currentUser } from '../../_lib/session.ts';

/**
 * Getting back in with a recovery code.
 *
 * The third unauthenticated page, and the one that needed the most argument. `login/page.tsx`
 * declined a reset route on the grounds that it "would quietly re-introduce the account-recovery
 * surface that decision removes", and the readiness audit said plainly: do not add a public redeem
 * form. Added anyway on 08-Sep-2026 at the fund's request, and it is worth being precise about
 * what makes it narrower than the thing that was refused:
 *
 *   * **It cannot mail anything.** No relay is configured, so there is no reset *link* — the only
 *     mechanism available is a code the holder already has, which is the one the recovery codes
 *     were designed for and which had no caller until now.
 *   * **A code is 80 bits, single-use, and stored as a digest.** Redeeming needs the address too,
 *     so a code found on a desk is not enough on its own.
 *   * **Rate limited**, on the address asked about and on the caller.
 *   * Reachable only over Tailscale, like everything else here.
 *
 * What it does not change: codes are still issued once, on the VM, by `jobs/seed-user.ts`.
 * Somebody who has lost both their password and their codes is still a person with shell access.
 */

async function attemptReset(formData: FormData): Promise<void> {
  'use server';

  const email = String(formData.get('email') ?? '').trim();
  const address = await clientAddress();

  // Two keys, the same reasoning as login: the address key stops one account being ground at, the
  // caller key stops the endpoint being used to spend the box's CPU on Argon2 hashes.
  const byEmail = hit(`reset:email:${email.toLowerCase()}`, { max: 5, windowMs: 15 * 60 * 1000 });
  // The address key only exists when a proxy we run put it there. Under a placeholder it would be
  // one bucket for everybody, and fifteen attempts by anyone would lock out the rest.
  const byAddress = address
    ? hit(`reset:addr:${address}`, { max: 15, windowMs: 15 * 60 * 1000 })
    : { allowed: true, retryAfter: 0 };
  if (!byEmail.allowed || !byAddress.allowed) redirect('/reset?error=rate');

  try {
    await resetWithRecoveryCode(
      email,
      String(formData.get('code') ?? ''),
      String(formData.get('password') ?? ''),
    );
  } catch (err) {
    if (err instanceof WeakPassword) redirect('/reset?error=weak');
    if (err instanceof BadRecoveryCode) redirect('/reset?error=1');
    throw err;
  }

  redirect('/login?reset=1');
}

const MESSAGE: Record<string, string> = {
  '1': 'That address and recovery code do not match.',
  weak: 'A password needs at least 12 characters.',
  rate: 'Too many attempts. Wait a few minutes and try again.',
};

export default async function ResetPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect('/');
  const params = await searchParams;

  return (
    <main className="login">
      <section className="login-copy">
        <div className="login-brand">
          <span className="login-mark">T</span>
          Trisula Capital
        </div>
        <div>
          <h1>
            Research, held
            <br />
            to account.
          </h1>
          <p className="lede">
            Every write attributed to a person. Every figure traceable to the filing it came from.
            Fund data never leaves the box.
          </p>
        </div>
        <p className="foot">SEBI Category III AIF · Mumbai · internal system</p>
      </section>

      <section className="login-side">
        <form action={attemptReset} className="login-form">
          <div>
            <h2>Use a recovery code</h2>
            <p className="sub">
              One of the eight printed when the account was created. Each works once.
            </p>
          </div>

          {params.error && (
            <p role="alert" className="alert">
              {MESSAGE[params.error] ?? MESSAGE['1']}
            </p>
          )}

          <label className="lbl">
            Email
            <input className="field field-lg" name="email" type="email" autoComplete="username" required />
          </label>
          <label className="lbl">
            Recovery code
            <input
              className="field field-lg"
              name="code"
              autoComplete="one-time-code"
              spellCheck={false}
              required
            />
          </label>
          <label className="lbl">
            New password
            <input
              className="field field-lg"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
            />
          </label>
          <button type="submit" className="btn btn-primary btn-lg">
            Set the password <span aria-hidden="true">→</span>
          </button>
          {/* Said before it happens rather than after. Somebody resetting a password because it may
              be known to someone else needs to know that this ends every session, including theirs
              on another machine. */}
          <p className="hint">
            This uses the code up and signs out every session. No codes left? Ask someone with VM
            access. <Link href="/login">Back to sign in</Link>.
          </p>
        </form>
      </section>
    </main>
  );
}
