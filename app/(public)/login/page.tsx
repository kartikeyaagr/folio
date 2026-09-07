import { redirect } from 'next/navigation';

import { login } from '@/lib/auth.ts';

import { currentUser, setSessionCookie } from '../../_lib/session.ts';

/**
 * The only unauthenticated page in the application.
 *
 * There is no sibling "register" or "forgot password" route, and there should not be: there is no
 * public signup, and accounts are created on the VM by someone with shell access. A reset route
 * would quietly re-introduce the account-recovery surface that decision removes — a lost password
 * is handled by a person with VM access, in person, using a recovery code.
 */

async function attemptLogin(formData: FormData): Promise<void> {
  'use server';

  const next = String(formData.get('next') ?? '');
  const session = await login(
    String(formData.get('email') ?? ''),
    String(formData.get('password') ?? ''),
  );

  // One message for every failure. `login()` already spends the same work whether or not the
  // address exists — it verifies against a computed dummy hash — and a message that distinguished
  // them would hand back the timing equivalence for nothing.
  if (!session) {
    redirect(`/login?error=1${next ? `&next=${encodeURIComponent(next)}` : ''}`);
  }

  await setSessionCookie(session.token, session.expiresAt);
  // Only ever a path on this origin. A full URL here would be an open redirect.
  redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
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
        <form action={attemptLogin} className="login-form">
          <div>
            <h2>Sign in</h2>
            <p className="sub">No signup here. Accounts are created on the VM.</p>
          </div>

          {params.error && (
            <p role="alert" className="alert">
              That email address and password do not match.
            </p>
          )}

          <input type="hidden" name="next" value={params.next ?? ''} />
          <label className="lbl">
            Email
            <input className="field field-lg" name="email" type="email" autoComplete="username" required />
          </label>
          <label className="lbl">
            Password
            <input
              className="field field-lg"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="btn btn-primary btn-lg">
            Sign in <span aria-hidden="true">→</span>
          </button>
          <p className="hint">Lost your password? Ask someone with VM access for a recovery code.</p>
        </form>
      </section>
    </main>
  );
}
