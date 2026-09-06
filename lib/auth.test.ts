/**
 * Auth, against a real database built from `db/migrations`.
 *
 * The cases worth having are the ones where a session should stop working: revoked, expired,
 * disabled. Each is a separate reason and they must all look identical to a caller, because a
 * caller that can tell them apart is a caller that can enumerate accounts.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, serviceTxn } from './db.ts';
import {
  hashPassword,
  issueRecoveryCodes,
  issueSession,
  login,
  redeemRecoveryCode,
  resolveSession,
  revokeSession,
  setPassword,
  verifyPassword,
} from './auth.ts';

const DB = `trisula_auth_${process.pid}`;
const USER = 'p1';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Tester')", [USER]);
    await c.query("INSERT INTO users (id, email, name) VALUES ($1, 'T@Example.com', 'Tester')", [
      USER,
    ]);
  });
  await setPassword(USER, 'correct horse battery staple', 'system:auth');
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
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

test('a recovery code works once', async () => {
  const codes = await issueRecoveryCodes(USER, 'system:auth');
  assert.equal(codes.length, 8);
  const code = codes[0]!;
  assert.equal(await redeemRecoveryCode(code), USER);
  assert.equal(await redeemRecoveryCode(code), null, 'a replayed code must match nothing');
});

test('issuing a fresh set invalidates the old printout', async () => {
  const first = await issueRecoveryCodes(USER, 'system:auth');
  await issueRecoveryCodes(USER, 'system:auth');
  assert.equal(await redeemRecoveryCode(first[0]!), null);
});

test('an unknown recovery code returns null', async () => {
  assert.equal(await redeemRecoveryCode('nope'), null);
});
