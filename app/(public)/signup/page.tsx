import Link from 'next/link';
import { redirect } from 'next/navigation';

import { REQUEST_LIMITS, requestAccess } from '@/lib/access-requests.ts';
import { hit } from '@/lib/rate-limit.ts';

import { clientAddress } from '../../_lib/client-address.ts';
import { currentUser } from '../../_lib/session.ts';

/**
 * Asking for an account.
 *
 * The second unauthenticated page, and it creates nothing: it records a request an admin decides
 * on. Migration `0032` records why the no-signup rule was reversed and what keeps the reversal
 * narrow — chiefly that approval still ends with `jobs/seed-user.ts` on the box, so a password
 * never appears in a browser.
 *
 * **The answer is the same whether or not the address already has an account.** An endpoint that
 * told them apart would be a way to find out who works at the fund, which is the property
 * `login()` spends a whole dummy Argon2 verify to protect.
 */

async function submitRequest(formData: FormData): Promise<void> {
  'use server';

  // Same limiter as login. This writes a row for anyone who can reach the page, and while the page
  // is only reachable over Tailscale, "on the tailnet" is not the same as "should be able to fill
  // the approver's queue".
  // Skipped rather than bucketed under a placeholder when the address is not trustworthy: one
  // shared key would let the first five requests of the hour lock out everybody else, which is a
  // denial of service dressed as a rate limit. See app/_lib/client-address.ts.
  const address = await clientAddress();
  if (address) {
    const verdict = hit(`signup:${address}`, { max: 5, windowMs: 60 * 60 * 1000 });
    if (!verdict.allowed) redirect('/signup?error=rate');
  }

  await requestAccess(
    String(formData.get('email') ?? ''),
    String(formData.get('name') ?? ''),
    String(formData.get('note') ?? ''),
  );

  redirect('/signup?sent=1');
}

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ sent?: string; error?: string }>;
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
        {params.sent ? (
          <div className="login-form">
            <div>
              <h2>Request received</h2>
              {/* Deliberately says nothing about whether an account already exists for that
                  address. And it still promises this requester no email: the system does send mail
                  now (the daily digest, `0054`), but mailing a stranger who asked for access would
                  confirm to them that the address reached something, which is the property the
                  identical response above exists to protect. */}
              <p className="sub">
                Somebody with access will decide on it and get in touch. No reply is sent by
                email.
              </p>
            </div>
            <Link href="/login" className="btn btn-primary btn-lg">
              Back to sign in
            </Link>
          </div>
        ) : (
          <form action={submitRequest} className="login-form">
            <div>
              <h2>Ask for access</h2>
              <p className="sub">
                This does not create an account. It sends a request to somebody who can.
              </p>
            </div>

            {params.error === 'rate' && (
              <p role="alert" className="alert">
                Too many requests from here. Try again later.
              </p>
            )}

            <label className="lbl">
              Your name
              <input
                className="field field-lg"
                name="name"
                autoComplete="name"
                maxLength={REQUEST_LIMITS.name}
                required
              />
            </label>
            <label className="lbl">
              Work email
              <input
                className="field field-lg"
                name="email"
                type="email"
                autoComplete="username"
                maxLength={REQUEST_LIMITS.email}
                required
              />
              {/* Said here rather than discovered after approval. This address is not only the
                  account name: it is where the daily update goes, and it is the mailbox a person
                  can later link so that update leaves from their own address instead of the
                  desk's. Getting it wrong costs a round trip through whoever approves requests. */}
              <span className="picker-none">
                Your account name, and where your daily update arrives. Once signed in you can link
                this mailbox so the update is sent from it.
              </span>
            </label>
            <label className="lbl">
              Why you need access
              <textarea
                className="field"
                name="note"
                rows={3}
                maxLength={REQUEST_LIMITS.note}
                placeholder="Who you are, and what you would use it for."
              />
            </label>
            <button type="submit" className="btn btn-primary btn-lg">
              Send <span aria-hidden="true">→</span>
            </button>
            <p className="hint">
              Already have an account? <Link href="/login">Sign in</Link>.
            </p>
            {/* Separated from the request form above by a rule, because they are different things:
                one asks somebody to make a decision, the other needs no decision from anybody. */}
            <hr />
            <div>
              <p className="sub">Lost the password to an account you already have?</p>
              <Link href="/reset" className="btn btn-lg">
                Reset with a recovery code
              </Link>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
