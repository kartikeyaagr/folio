import { changePasswordAction, forgetMailboxAction, linkMailboxAction } from '@/app/_lib/actions/account.ts';
import type { MailboxView } from '@/lib/mailbox.ts';

import { DialogButton } from './DialogButton.tsx';

/**
 * The person, at the foot of the rail.
 *
 * A <details>, so it needs no script: one click opens it, the next closes it. Everything about the
 * account lives here — who is signed in, how to change the password, which mailbox the daily update
 * leaves from, and the way out.
 */
export function AvatarMenu({
  email,
  name,
  isAdmin,
  mailbox,
}: {
  email: string;
  name: string | null;
  isAdmin: boolean;
  /** The mailbox this person's daily update goes out through, or null for the shared relay. */
  mailbox: MailboxView | null;
}) {
  const source = name?.trim() || email.split('@')[0] || '?';
  const initials = source
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <details className="rail-menu">
      <summary title={`${email} · account`}>{initials}</summary>
      <div className="rail-menu-pop">
        <p className="who">
          {name ?? email}
          {name && <span>{email}</span>}
        </p>
        <hr />
        {/* Admin is not a hub in the rail: it is a place you go occasionally to change a setting,
            not one of the five things the desk is for. It lives with the account it belongs to. */}
        {isAdmin && <a href="/admin">Admin</a>}
        <DialogButton
          label="Password"
          title="Change password"
          className="btn btn-link"
          buttonTitle="Change the password for this account"
        >
          <form action={changePasswordAction} className="form-grid">
            <label className="lbl">
              Current password
              <input
                className="field"
                type="password"
                name="current"
                autoComplete="current-password"
                required
              />
            </label>
            <label className="lbl">
              New password
              <input
                className="field"
                type="password"
                name="next"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            <label className="lbl">
              New password again
              <input
                className="field"
                type="password"
                name="confirm"
                autoComplete="new-password"
                minLength={12}
                required
              />
            </label>
            {/* Said before the button rather than after the failure: both of these surprise people,
                and a form that explains itself only once you have got it wrong is a worse form. */}
            <p className="picker-none">
              At least 12 characters. This signs out every other session.
            </p>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Change
              </button>
            </div>
          </form>
        </DialogButton>
        {/*
          Where the daily update comes from.
          
          It sits with the password rather than on a settings page of its own for the same reason
          Admin does: this is a thing about the account, and the account lives here. The summary
          line is the whole point of the panel — a person should be able to tell at a glance which
          address their mail leaves from, because the failure this guards against is a linked
          mailbox that quietly stopped working and fell back to the desk relay.
        */}
        <DialogButton
          label="Mailbox"
          title="The mailbox your daily update comes from"
          className="btn btn-link"
          // The label is one word, so the state it used to carry ("Your mailbox · linked") moves
          // to the tooltip rather than being lost. A broken mailbox is the case that matters: the
          // digest still arrives, from the desk relay, so nothing else would tell you.
          buttonTitle={
            mailbox === null
              ? 'Not linked — your daily update comes from the desk relay'
              : mailbox.lastError
                ? `Linked to ${mailbox.fromAddress}, but the last send failed`
                : `Linked — your daily update is sent from ${mailbox.fromAddress}`
          }
        >
          {mailbox && (
            <div className="mbx-now">
              <p>
                Your daily update is sent from <b>{mailbox.fromAddress}</b>, through{' '}
                <code>{mailbox.host}:{mailbox.port}</code>.
              </p>
              {mailbox.lastError ? (
                /* The reason this panel exists. A mailbox that stopped working is invisible
                   otherwise: the digest falls back to the shared relay and arrives, so nobody
                   notices their address quietly stopped being theirs. */
                <p className="mbx-bad">
                  The last send failed: {mailbox.lastError}
                  <br />
                  Your update was sent from the desk relay instead. Re-link below to fix it.
                </p>
              ) : (
                <p className="picker-none">
                  Last used{' '}
                  {mailbox.lastOkAt ? mailbox.lastOkAt.toISOString().slice(0, 10) : 'never'}.
                </p>
              )}
              <form action={forgetMailboxAction}>
                <button type="submit" className="btn btn-quiet btn-sm">Unlink</button>
              </form>
              <hr />
            </div>
          )}

          <form action={linkMailboxAction} className="form-grid">
            <label className="lbl">
              Server
              <input className="field" name="host" placeholder="smtp.hostinger.com"
                     defaultValue={mailbox?.host ?? ''} required />
            </label>
            <label className="lbl">
              Port
              {/* The three submission ports. 25 is absent on purpose and the database refuses it
                  too: it is the port that talks to other servers, usually unencrypted, and a
                  password must never cross it. */}
              <select className="field" name="port" defaultValue={String(mailbox?.port ?? 587)}>
                <option value="587">587 — STARTTLS</option>
                <option value="465">465 — TLS</option>
                <option value="2525">2525 — STARTTLS</option>
              </select>
            </label>
            <label className="lbl">
              Mailbox
              <input className="field" name="username" type="email" placeholder={email}
                     defaultValue={mailbox?.username ?? ''} autoComplete="username" required />
            </label>
            <label className="lbl">
              Password
              {/* Never populated, on any render: there is no code path that decrypts this into a
                  screen, and an input showing dots that are not the real password is a lie the
                  browser tells for you. Re-linking always means retyping it. */}
              <input className="field" name="password" type="password"
                     autoComplete="off" required />
            </label>
            <label className="lbl">
              Send as
              <input className="field" name="from" type="email" placeholder={email}
                     defaultValue={mailbox?.fromAddress ?? email} required />
            </label>
            <p className="picker-none">
              Saving sends a test message and links nothing unless it arrives. The password is
              encrypted, is used only to send you your daily update, and is never shown again.
            </p>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                {mailbox ? 'Relink' : 'Link'}
              </button>
            </div>
          </form>
        </DialogButton>
        <a href="/logout">Logout</a>
      </div>
    </details>
  );
}
