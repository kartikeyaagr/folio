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
    }>(
      `SELECT s.user_id, u.name, u.email, s.expires_at
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
      ? { userId: row.user_id, name: row.name, email: row.email, expiresAt: row.expires_at }
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

export async function login(
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: Date; userId: string } | null> {
  const user = await readTxn(async (c) => {
    const { rows } = await c.query<{ id: string; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL',
      [email],
    );
    return rows[0] ?? null;
  });

  const ok = await verifyPassword(user?.password_hash ?? (await getDummyHash()), password);
  if (!ok || !user || user.password_hash === null) return null;

  const { token, expiresAt } = await issueSession(user.id);
  return { token, expiresAt, userId: user.id };
}

/** Used when claiming an account and after a recovery code is redeemed. */
export async function setPassword(userId: string, plain: string, actorId: string): Promise<void> {
  const encoded = await hashPassword(plain);
  await writeTxn(actorId, async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [encoded, userId]);
  });
}

export { digestsEqual, sha256 };
