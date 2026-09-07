/**
 * The person, at the foot of the rail.
 *
 * A <details>, so it needs no script: one click opens it, the next closes it. Everything about the
 * account lives here — who is signed in, and the way out.
 */
export function AvatarMenu({ email, name }: { email: string; name: string | null }) {
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
        <a href="/logout">Sign out</a>
      </div>
    </details>
  );
}
