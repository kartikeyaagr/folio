import { changePasswordAction } from '@/app/_lib/actions/account.ts';

import { DialogButton } from './DialogButton.tsx';

/**
 * The person, at the foot of the rail.
 *
 * A <details>, so it needs no script: one click opens it, the next closes it. Everything about the
 * account lives here — who is signed in, how to change the password, and the way out.
 */
export function AvatarMenu({
  email,
  name,
  isAdmin,
}: {
  email: string;
  name: string | null;
  isAdmin: boolean;
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
          label="Change password"
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
              At least 12 characters. Changing it signs out every other session — this one stays.
            </p>
            <div className="form-actions">
              <button type="submit" className="btn btn-primary">
                Change password
              </button>
            </div>
          </form>
        </DialogButton>
        <a href="/logout">Sign out</a>
      </div>
    </details>
  );
}
