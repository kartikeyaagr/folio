/**
 * What an admin can change.
 *
 * The guards get the most attention here, because the panel is the only way back in: each of them
 * is one click away from a system nobody can administer, recoverable only by somebody with shell
 * access. Everything else is a setting, and a setting that fails to save is obvious.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { migrate } from '../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from './db.ts';
import { issueSession, resolveSession } from './auth.ts';
import {
  listAgents,
  listAlertRules,
  listNewsSources,
  listUsers,
  recentRuns,
  setAgentEffort,
  setAgentEnabled,
  setAlertRule,
  setNewsSourceActive,
  setUserAdmin,
  setUserDisabled,
  WouldLockYouOut,
} from './admin.ts';

const DB = `trisula_admin_${process.pid}`;
const ONE = 'p1'; // admin
const TWO = 'p2'; // admin
const MEMBER = 'p3';

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  // Created once, never deleted. `audit_log` references `actors`, so an actor who has written
  // anything cannot be removed — which is the audit trail working, and the reason the reset below
  // puts their state back rather than putting them back.
  await serviceTxn('system:auth', async (c) => {
    for (const [id, email, name] of [
      [ONE, 'one@x.com', 'One'],
      [TWO, 'two@x.com', 'Two'],
      [MEMBER, 'three@x.com', 'Three'],
    ] as const) {
      await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', $2)", [id, name]);
      await c.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [id, email, name]);
    }
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

/** Two admins and a member, put back before every case. */
beforeEach(async () => {
  await serviceTxn('system:auth', async (c) => {
    await c.query('DELETE FROM sessions');
    await c.query(
      `UPDATE users
          SET is_admin = (id = ANY($1::text[])), disabled_at = NULL, password_hash = 'x'`,
      [[ONE, TWO]],
    );
  });
});

const find = async (id: string) => (await listUsers()).find((u) => u.id === id)!;

// ------------------------------------------------------------------------------------------------
// The guards
// ------------------------------------------------------------------------------------------------

test('you cannot revoke your own admin', async () => {
  // One click from losing the page you would need to undo it.
  await assert.rejects(() => setUserAdmin(ONE, false, ONE), WouldLockYouOut);
  assert.equal((await find(ONE)).isAdmin, true);
});

test('you cannot remove the last admin', async () => {
  await setUserAdmin(TWO, false, ONE); // now ONE is the only one
  await assert.rejects(() => setUserAdmin(ONE, false, TWO), WouldLockYouOut);
  assert.equal((await find(ONE)).isAdmin, true, 'still an admin');
});

test('a disabled admin does not count towards the last-admin check', async () => {
  // Otherwise a disabled account keeps the door propped open: the count that matters is admins who
  // can actually sign in.
  await setUserDisabled(TWO, true, ONE);
  await assert.rejects(() => setUserAdmin(ONE, false, TWO), WouldLockYouOut);
});

test('you cannot disable your own account', async () => {
  await assert.rejects(() => setUserDisabled(ONE, true, ONE), WouldLockYouOut);
  assert.equal((await find(ONE)).disabledAt, null);
});

test('granting admin is never refused, only revoking', async () => {
  await setUserAdmin(MEMBER, true, ONE);
  assert.equal((await find(MEMBER)).isAdmin, true);
});

// ------------------------------------------------------------------------------------------------
// People
// ------------------------------------------------------------------------------------------------

test('disabling revokes their live sessions', async () => {
  // Disabling somebody who is signed in and leaving their cookie working would be a control that
  // only takes effect the next time they choose to sign in.
  const { token } = await issueSession(MEMBER);
  assert.ok(await resolveSession(token), 'signed in to begin with');

  await setUserDisabled(MEMBER, true, ONE);
  assert.equal(await resolveSession(token), null, 'the session stops resolving immediately');
  assert.ok((await find(MEMBER)).disabledAt);
});

test('re-enabling clears the flag but does not restore the old sessions', async () => {
  const { token } = await issueSession(MEMBER);
  await setUserDisabled(MEMBER, true, ONE);
  await setUserDisabled(MEMBER, false, ONE);

  assert.equal((await find(MEMBER)).disabledAt, null, 'active again');
  assert.equal(await resolveSession(token), null, 'the revoked session stays revoked');
});

test('an account with no password is reported as such', async () => {
  // A seeded account nobody has claimed looks identical to an active one otherwise, and "active"
  // on a login that cannot be used is the wrong thing to tell an admin.
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET password_hash = NULL WHERE id = $1', [MEMBER]);
  });
  assert.equal((await find(MEMBER)).hasPassword, false);
});

test('live accounts are listed before disabled ones', async () => {
  await setUserDisabled(MEMBER, true, ONE);
  const rows = await listUsers();
  assert.equal(rows[rows.length - 1]?.id, MEMBER, 'the disabled one sinks to the bottom');
});

test('every change is attributed to the admin who made it', async () => {
  await setUserAdmin(MEMBER, true, TWO);
  const actor = await readTxn(async (c) => {
    const { rows } = await c.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit_log WHERE table_name = 'users' ORDER BY id DESC LIMIT 1",
    );
    return rows[0]?.actor_id;
  });
  assert.equal(actor, TWO);
});

// ------------------------------------------------------------------------------------------------
// Agents, rules and feeds
// ------------------------------------------------------------------------------------------------

test('an agent can be stopped and started', async () => {
  const before = (await listAgents())[0]!;
  await setAgentEnabled(before.key, false, ONE);
  assert.equal((await listAgents()).find((a) => a.key === before.key)?.enabled, false);
  await setAgentEnabled(before.key, true, ONE);
  assert.equal((await listAgents()).find((a) => a.key === before.key)?.enabled, true);
});

test('effort can be set and cleared back to the model default', async () => {
  const key = 'results-figures';
  await setAgentEffort(key, 'low', ONE);
  assert.equal((await listAgents()).find((a) => a.key === key)?.effort, 'low');
  await setAgentEffort(key, null, ONE);
  assert.equal((await listAgents()).find((a) => a.key === key)?.effort, null);
});

test('an alert rule keeps its severity when only its activity is changed', async () => {
  // The panel posts one field at a time, so a partial update that quietly reset the other one
  // would change how loudly something interrupts as a side effect of switching it off and on.
  const rule = (await listAlertRules())[0]!;
  await setAlertRule(rule.key, { active: false }, ONE);
  const after = (await listAlertRules()).find((r) => r.key === rule.key)!;
  assert.equal(after.active, false);
  assert.equal(after.severity, rule.severity, 'severity untouched');
});

test('an alert rule keeps its activity when only its severity is changed', async () => {
  const rule = (await listAlertRules())[0]!;
  await setAlertRule(rule.key, { severity: 'low' }, ONE);
  const after = (await listAlertRules()).find((r) => r.key === rule.key)!;
  assert.equal(after.severity, 'low');
  assert.equal(after.active, rule.active, 'activity untouched');
});

test('a news feed can be stopped and started', async () => {
  const source = (await listNewsSources())[0]!;
  await setNewsSourceActive(source.key, !source.active, ONE);
  assert.equal(
    (await listNewsSources()).find((s) => s.key === source.key)?.active,
    !source.active,
  );
});

// ------------------------------------------------------------------------------------------------
// Operations
// ------------------------------------------------------------------------------------------------

test('runs come back newest first, with their detail', async () => {
  // Nothing in the application read ingestion_runs before this: report-failure.ts wrote a row and
  // nothing ever selected from it, so a failed job reached no human by any path.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO ingestion_runs (source, status, items, detail, finished_at)
       VALUES ('nse_test', 'failed', 0, 'the feed returned nothing', now())`,
    );
  });
  const runs = await recentRuns(5);
  assert.equal(runs[0]?.source, 'nse_test');
  assert.equal(runs[0]?.status, 'failed');
  assert.equal(runs[0]?.detail, 'the feed returned nothing');
});
