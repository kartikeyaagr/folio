/**
 * Authentication for three people.
 *
 * There is no signup route and there never will be. An account exists because somebody seeded it
 * (`jobs/seed-user.ts`), which means the interesting operations here are proving who you are and
 * getting back in when you cannot.
 *
 * Two things are stored hashed rather than plain, for the same reason: a stolen database must not
 * yield anything usable. A password hash is Argon2id. A session token and a recovery code are
 * sha256 of a high-entropy random value — no KDF needed, because unlike a password they are not
 * guessable to begin with, and a KDF on every request would only cost latency.
 *
 * Sessions are issued as `system:auth` rather than as the user: the system grants the session, and
 * attributing it to the person would put a write in their name before the cookie proving it exists.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { readTxn, serviceTxn, writeTxn, type Client } from './db.ts';
import { clear as clearLimit, hit, type Limit } from './rate-limit.ts';

/** 30 days. Three people on a private network; re-authenticating weekly buys nothing real. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Constant-time compare of two hex digests, so a wrong guess leaks no timing signal. */
function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

// ------------------------------------------------------------------------------------------------
// Passwords
// ------------------------------------------------------------------------------------------------

/**
 * OWASP's Argon2id floor is 19 MiB and one iteration. This is well above it because the whole
 * system authenticates about three logins a day and can afford to be slow exactly here.
 */
const ARGON = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain, ARGON);
}

export async function verifyPassword(encoded: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(encoded, plain);
  } catch {
    // A malformed hash is a failed verification, not a crash. It should not be possible, and if
    // it happens the answer is still "you are not logged in".
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Sessions
// ------------------------------------------------------------------------------------------------

export interface Session {
  userId: string;
  name: string;
  email: string;
  expiresAt: Date;
  /** Sees model, effort and spend on the agents page. Granted only from the VM. */
  isAdmin: boolean;
}

/** The plaintext token is returned once and never stored. Only its digest reaches the database. */
export async function issueSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await serviceTxn('system:auth', async (c) => {
    await c.query(
      'INSERT INTO sessions (token_sha256, user_id, expires_at) VALUES ($1, $2, $3)',
      [sha256(token), userId, expiresAt],
    );
  });
  return { token, expiresAt };
}

/**
 * The real authentication boundary. Everything that needs to know who is asking goes through here.
 *
 * Returns null for absent, unknown, expired, revoked, or disabled — every one of which means the
 * same thing to a caller, and distinguishing them for the caller would leak account existence.
 */
export async function resolveSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  return readTxn(async (c) => {
    const { rows } = await c.query<{
      user_id: string;
      name: string;
      email: string;
      expires_at: Date;
      is_admin: boolean;
    }>(
      `SELECT s.user_id, u.name, u.email, s.expires_at, u.is_admin
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_sha256 = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL`,
      [sha256(token)],
    );
    const row = rows[0];
    return row
      ? {
          userId: row.user_id,
          name: row.name,
          email: row.email,
          expiresAt: row.expires_at,
          isAdmin: row.is_admin,
        }
      : null;
  });
}

/** Logging out is the user's own act, so it is attributed to them. */
export async function revokeSession(token: string, actorId: string): Promise<void> {
  await writeTxn(actorId, async (c) => {
    await c.query(
      'UPDATE sessions SET revoked_at = now() WHERE token_sha256 = $1 AND revoked_at IS NULL',
      [sha256(token)],
    );
  });
}

/** Expired rows carry no authority; keeping them forever only grows the table. */
export async function pruneExpiredSessions(): Promise<number> {
  return serviceTxn('system:auth', async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM sessions WHERE expires_at < now() - interval '30 days'",
    );
    return rowCount ?? 0;
  });
}

// ------------------------------------------------------------------------------------------------
// Recovery codes
// ------------------------------------------------------------------------------------------------

/**
 * Issued once, shown once, stored only as digests. These exist because there is no password-reset
 * email and no signup route: without them, a locked-out account is recovered by hand-editing the
 * database, which is worse in every way than a code in a password manager.
 *
 * Issuing replaces any unused codes, so a fresh set invalidates an old printout.
 */
export async function issueRecoveryCodes(userId: string, actorId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    randomBytes(10).toString('base64url'),
  );
  await writeTxn(actorId, async (c: Client) => {
    await c.query('DELETE FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
    for (const code of codes) {
      await c.query('INSERT INTO recovery_codes (code_sha256, user_id) VALUES ($1, $2)', [
        sha256(code),
        userId,
      ]);
    }
  });
  return codes;
}

/**
 * Single-use by construction: the UPDATE only matches a row whose `used_at` is still null, so a
 * replayed code matches nothing. Returns the user it belonged to, or null.
 */
export async function redeemRecoveryCode(code: string): Promise<string | null> {
  return serviceTxn('system:auth', async (c) => {
    const { rows } = await c.query<{ user_id: string }>(
      `UPDATE recovery_codes SET used_at = now()
        WHERE code_sha256 = $1 AND used_at IS NULL
        RETURNING user_id`,
      [sha256(code)],
    );
    return rows[0]?.user_id ?? null;
  });
}

// ------------------------------------------------------------------------------------------------
// Login
// ------------------------------------------------------------------------------------------------

/**
 * Verifies a password and issues a session, or returns null.
 *
 * A missing user still costs an Argon2id verification against a dummy hash, so "no such account"
 * and "wrong password" take the same time and the response cannot be used to enumerate who works
 * here.
 */
// Computed at first use, not written down. A hand-written constant risks being malformed, and a
// malformed hash makes verify() throw and return early — which would defeat the very timing
// equivalence it exists for.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> =>
  (dummyHash ??= argonHash(randomBytes(32).toString('hex'), ARGON));

export class TooManyAttempts extends Error {
  // Declared and assigned, not a parameter property: Node runs this file in strip-only mode, where
  // `constructor(public readonly x)` is a runtime syntax error rather than a style preference. tsc
  // accepts it, so the type checker will not catch this one for you.
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`);
    this.retryAfter = retryAfter;
  }
}

/**
 * Two limits, because they defend against different things.
 *
 * The per-email one stops a password being guessed. The per-address one stops the endpoint being
 * used as a way to spend the box's CPU: every attempt is a 64 MiB Argon2id verify, Node's libuv
 * threadpool defaults to four, and `t4g.small` is burstable — so an unthrottled login is both a
 * brute-force path and a cheap outage. The address allowance is the looser of the two because
 * three people behind one office address fumbling passwords is ordinary.
 */
const PER_EMAIL: Limit = { max: 8, windowMs: 15 * 60 * 1000 };
const PER_ADDRESS: Limit = { max: 30, windowMs: 15 * 60 * 1000 };

export async function login(
  email: string,
  password: string,
  address?: string,
): Promise<{ token: string; expiresAt: Date; userId: string } | null> {
  // Checked before any hashing, and refused *fast*. Burning the same wall clock on a refusal
  // would preserve a timing property that is not at risk — being told you are rate limited says
  // nothing about whether the account exists, because you caused the limit yourself — while
  // handing back exactly the CPU cost this exists to deny.
  const emailKey = `login:email:${email.trim().toLowerCase()}`;
  const addressKey = address ? `login:addr:${address}` : null;
  const byEmail = hit(emailKey, PER_EMAIL);
  const byAddress = addressKey ? hit(addressKey, PER_ADDRESS) : { allowed: true, retryAfter: 0 };
  if (!byEmail.allowed || !byAddress.allowed) {
    throw new TooManyAttempts(Math.max(byEmail.retryAfter, byAddress.retryAfter));
  }

  const user = await readTxn(async (c) => {
    const { rows } = await c.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL',
      [email],
    );
    return rows[0] ?? null;
  });

  const ok = await verifyPassword(user?.password_hash ?? (await getDummyHash()), password);
  if (!ok || !user || user.password_hash === null) return null;

  // A fumbled password should not count against you once you get it right.
  clearLimit(emailKey);
  if (addressKey) clearLimit(addressKey);

  const { token, expiresAt } = await issueSession(user.id);
  return { token, expiresAt, userId: user.id };
}

export class WrongPassword extends Error {}
export class WeakPassword extends Error {}

/**
 * Change your own password.
 *
 * **The current password is required even though the caller is already signed in.** A session
 * cookie proves the browser was authenticated at some point in the last thirty days; it does not
 * prove the person at the keyboard is the account holder. Without this check a borrowed laptop is
 * a permanent account takeover, and the session TTL is long precisely because this is a private
 * network — the two decisions have to hold together.
 *
 * Every session but the current one is revoked afterwards. If the reason for changing a password
 * is that somebody else may know it, leaving their session alive defeats the change.
 */
export async function changePassword(
  userId: string,
  current: string,
  next: string,
  keepToken: string,
): Promise<void> {
  // 12 is a floor, not a policy. There is no rotation, no character-class rule and no history:
  // those push people towards passwords they can predict, and this system has three users and a
  // password manager rather than a compliance department.
  if (next.length < 12) throw new WeakPassword('A password needs at least 12 characters.');

  const encoded = await readTxn(async (c) => {
    const { rows } = await c.query<{ password_hash: string | null }>(
      'SELECT password_hash FROM users WHERE id = $1 AND disabled_at IS NULL',
      [userId],
    );
    return rows[0]?.password_hash ?? null;
  });
  if (!encoded || !(await verifyPassword(encoded, current))) {
    throw new WrongPassword('That is not the current password.');
  }

  const hashed = await hashPassword(next);
  await writeTxn(userId, async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashed, userId]);
    await c.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND token_sha256 <> $2`,
      [userId, sha256(keepToken)],
    );
  });
}

/** Used when claiming an account and after a recovery code is redeemed. */
export async function setPassword(userId: string, plain: string, actorId: string): Promise<void> {
  const encoded = await hashPassword(plain);
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [encoded, userId]);
  });
}

export { digestsEqual, sha256 };
