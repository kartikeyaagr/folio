/**
 * Auth, against a real database built from `db/migrations`.
 *
 * The cases worth having are the ones where a session should stop working: revoked, expired,
 * disabled. Each is a separate reason and they must all look identical to a caller, because a
 * caller that can tell them apart is a caller that can enumerate accounts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn } from './db.ts';
import {
  hashPassword,
  issueRecoveryCodes,
  issueSession,
  login,
  resolveSession,
  revokeSession,
  setPassword,
  changePassword,
  WrongPassword,
  WeakPassword,
  TooManyAttempts,
  resetWithRecoveryCode,
  BadRecoveryCode,
  verifyPassword,
} from './auth.ts';
import { reset as resetLimits } from './rate-limit.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `trisula_auth_${process.pid}`;
const USER = 'p1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Tester')", [USER]);
    await c.query("INSERT INTO users (id, email, name) VALUES ($1, 'T@Example.com', 'Tester')", [
      USER,
    ]);
  });
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
});

after(async () => {
  await dropTestDatabase(DB);
});

test('a password verifies against its own hash and nothing else', async () => {
  const encoded = await hashPassword('hunter2');
  assert.ok(encoded.startsWith('$argon2id$'), 'expected an Argon2id encoded string');
  assert.equal(await verifyPassword(encoded, 'hunter2'), true);
  assert.equal(await verifyPassword(encoded, 'hunter3'), false);
});

test('a malformed hash fails verification instead of throwing', async () => {
  assert.equal(await verifyPassword('not a hash', 'anything'), false);
});

test('login succeeds and the session resolves', async () => {
  const out = await login('t@example.com', 'correct horse battery staple');
  assert.ok(out, 'expected a session');
  const session = await resolveSession(out.token);
  assert.equal(session?.userId, USER);
  assert.equal(session?.email, 'T@Example.com');
});

test('email matching is case-insensitive', async () => {
  assert.ok(await login('T@EXAMPLE.COM', 'correct horse battery staple'));
});

test('a wrong password and an unknown account both return null', async () => {
  assert.equal(await login('t@example.com', 'wrong'), null);
  assert.equal(await login('nobody@example.com', 'correct horse battery staple'), null);
});

test('changing a password needs the current one, even with a live session', async () => {
  // A session cookie proves the browser authenticated at some point in the last thirty days. It
  // does not prove the person at the keyboard is the account holder, and without this check a
  // borrowed laptop is a permanent takeover.
  const { token } = await issueSession(USER);
  await assert.rejects(
    () => changePassword(USER, 'not the password', 'a much longer replacement', token),
    WrongPassword,
  );
  // and the old one still works, so a failed attempt changed nothing
  assert.ok(await login('t@example.com', 'correct horse battery staple'));
});

test('a new password shorter than the floor is refused', async () => {
  const { token } = await issueSession(USER);
  await assert.rejects(
    () => changePassword(USER, 'correct horse battery staple', 'short', token),
    WeakPassword,
  );
});

test('changing a password revokes every other session but the current one', async () => {
  const mine = await issueSession(USER);
  const other = await issueSession(USER);
  await changePassword(USER, 'correct horse battery staple', 'a much longer replacement', mine.token);

  assert.ok(await resolveSession(mine.token), 'the session that made the change survives');
  assert.equal(await resolveSession(other.token), null, 'every other session is revoked');

  // The new password works and the old one does not.
  assert.ok(await login('t@example.com', 'a much longer replacement'));
  assert.equal(await login('t@example.com', 'correct horse battery staple'), null);

  // Put it back, so the tests after this one still see the fixture's password.
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
});

test('an absent or unknown token resolves to null', async () => {
  assert.equal(await resolveSession(undefined), null);
  assert.equal(await resolveSession('not-a-real-token'), null);
});

test('a revoked session stops resolving', async () => {
  const { token } = await issueSession(USER);
  assert.ok(await resolveSession(token));
  await revokeSession(token, USER);
  assert.equal(await resolveSession(token), null);
});

test('an expired session stops resolving', async () => {
  const { token } = await issueSession(USER);
  await serviceTxn('system:auth', async (c) => {
    await c.query("UPDATE sessions SET expires_at = now() - interval '1 hour' WHERE user_id = $1", [
      USER,
    ]);
  });
  assert.equal(await resolveSession(token), null);
});

test('a disabled user stops resolving, without revoking anything', async () => {
  const { token } = await issueSession(USER);
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [USER]);
  });
  assert.equal(await resolveSession(token), null, 'a disabled account must not hold a session');
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [USER]);
  });
  assert.ok(await resolveSession(token), 'and it comes back when re-enabled');
});

test('guessing is refused after enough wrong attempts', async () => {
  resetLimits();
  // Eight are allowed against one address, then the ninth is refused before any hashing happens —
  // which is the point: every attempt is a 64 MiB Argon2 verify, so an unthrottled endpoint is a
  // way to spend the box's CPU as much as a way to guess a password.
  for (let i = 0; i < 8; i++) {
    assert.equal(await login('t@example.com', `wrong ${i}`), null);
  }
  await assert.rejects(() => login('t@example.com', 'wrong again'), TooManyAttempts);

  // Even the correct password is refused while the window is open: the limit is on the attempt,
  // not on the outcome, or an attacker simply keeps going until they are right.
  await assert.rejects(
    () => login('t@example.com', 'correct horse battery staple'),
    TooManyAttempts,
  );
  resetLimits();
});

test('the limit is per address, so one locked account does not lock the others', async () => {
  resetLimits();
  for (let i = 0; i < 9; i++) await login('someone@example.com', 'wrong').catch(() => undefined);
  // A different address is unaffected, because the key is the email being attacked.
  assert.ok(await login('t@example.com', 'correct horse battery staple'));
  resetLimits();
});

test('getting it right clears the count, so a fumble is not held against you', async () => {
  resetLimits();
  for (let i = 0; i < 5; i++) await login('t@example.com', 'wrong');
  assert.ok(await login('t@example.com', 'correct horse battery staple'), 'succeeds on the sixth');
  // Five more must not now trip a limit that had five against it a moment ago.
  for (let i = 0; i < 5; i++) assert.equal(await login('t@example.com', 'wrong'), null);
  assert.ok(await login('t@example.com', 'correct horse battery staple'));
  resetLimits();
});

test('a recovery code works once', async () => {
  resetLimits();
  const codes = await issueRecoveryCodes(USER, 'system:auth');
  assert.equal(codes.length, 8);
  const code = codes[0]!;
  await resetWithRecoveryCode('t@example.com', code, 'a brand new long password');
  await assert.rejects(
    () => resetWithRecoveryCode('t@example.com', code, 'another long password'),
    BadRecoveryCode,
    'a replayed code must match nothing',
  );
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
  resetLimits();
});

test('issuing a fresh set invalidates the old printout', async () => {
  resetLimits();
  const first = await issueRecoveryCodes(USER, 'system:auth');
  await issueRecoveryCodes(USER, 'system:auth');
  await assert.rejects(
    () => resetWithRecoveryCode('t@example.com', first[0]!, 'a long enough password'),
    BadRecoveryCode,
  );
  resetLimits();
});

test('a recovery code resets the password and ends every session', async () => {
  resetLimits();
  const [code] = await issueRecoveryCodes(USER, 'system:auth');
  const live = await issueSession(USER);

  await resetWithRecoveryCode('t@example.com', code!, 'a brand new long password');

  assert.ok(await login('t@example.com', 'a brand new long password'), 'the new password works');
  assert.equal(await resolveSession(live.token), null, 'the session that existed is revoked');
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
  resetLimits();
});

test('a code belonging to a different address is refused, and NOT used up', async () => {
  // The reason email and code are matched in one statement. Redeeming on the code alone would
  // mean a code found on a desk is enough without knowing whose it is — and a wrong guess about
  // the address would destroy a code that still worked.
  const [code] = await issueRecoveryCodes(USER, 'system:auth');
  await assert.rejects(
    () => resetWithRecoveryCode('somebody@else.com', code!, 'a brand new long password'),
    BadRecoveryCode,
  );
  // Still good: the same code now works for the right address.
  resetLimits();
  await resetWithRecoveryCode('t@example.com', code!, 'another long enough password');
  assert.ok(await login('t@example.com', 'another long enough password'));
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
  resetLimits();
});

test('a code works once, and the second attempt is refused', async () => {
  const [code] = await issueRecoveryCodes(USER, 'system:auth');
  await resetWithRecoveryCode('t@example.com', code!, 'first long enough password');
  await assert.rejects(
    () => resetWithRecoveryCode('t@example.com', code!, 'second long enough password'),
    BadRecoveryCode,
  );
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
  resetLimits();
});

test('a short new password is refused before the code is spent', async () => {
  const [code] = await issueRecoveryCodes(USER, 'system:auth');
  await assert.rejects(() => resetWithRecoveryCode('t@example.com', code!, 'short'), WeakPassword);
  // The code survives, so a fumbled password does not cost somebody one of their eight.
  await resetWithRecoveryCode('t@example.com', code!, 'a long enough password now');
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
  resetLimits();
});

test('a disabled account cannot be reset into', async () => {
  const [code] = await issueRecoveryCodes(USER, 'system:auth');
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [USER]);
  });
  await assert.rejects(
    () => resetWithRecoveryCode('t@example.com', code!, 'a long enough password'),
    BadRecoveryCode,
  );
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [USER]);
  });
  resetLimits();
});

test('an unknown recovery code is refused', async () => {
  resetLimits();
  await assert.rejects(
    () => resetWithRecoveryCode('t@example.com', 'nope', 'a long enough password'),
    BadRecoveryCode,
  );
});
