import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readTxn, serviceTxn } from './db.ts';
import {
  completeReminder, createReminder, deliverDue, dueReminders, EmptyReminder, snoozeReminder,
} from './reminders.ts';
import {
  drainOutbox, MAX_SEND_ATTEMPTS, recordUnitFailure, undeliverable, type Mail,
} from './notify.ts';
import { drain } from './agents/runner.ts';
import { sweepScheduled } from './agents/queue.ts';
import './agents/notify.ts';
import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';

const DB = `trisula_rem_${process.pid}`;
const A = 'u_a';
const B = 'u_b';

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    for (const [id, name] of [[A, 'Ana'], [B, 'Bo']]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, name]);
      await c.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [id, `${id}@x.com`, name]);
    }
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:agents', async (c) => {
    await c.query('DELETE FROM notification_outbox');
    await c.query('DELETE FROM reminders');
    await c.query('DELETE FROM agent_runs');
  });
});

const today = () => new Date().toISOString().slice(0, 10);
const daysFromNow = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

// ---- reminders --------------------------------------------------------------------------------

test('a reminder needs something to say', async () => {
  await assert.rejects(() => createReminder({ body: '  ', dueOn: today() }, A), EmptyReminder);
});

test('only reminders that have come due show up', async () => {
  await createReminder({ body: 'today', dueOn: today() }, A);
  await createReminder({ body: 'next week', dueOn: daysFromNow(7) }, A);
  const due = await dueReminders();
  assert.deepEqual(due.map((r) => r.body), ['today']);
});

test('completing a one-off closes it', async () => {
  const id = await createReminder({ body: 'call the CFO', dueOn: today() }, A);
  await completeReminder(id, A);
  assert.equal((await dueReminders()).length, 0);
});

test('completing a repeating one moves it forward instead of closing it', async () => {
  // A trail of finished rows nobody reads makes the list look busier than it is.
  const id = await createReminder(
    { body: 'quarterly review', dueOn: today(), repeats: 'quarterly' }, A,
  );
  await completeReminder(id, A);
  // Asked of Postgres rather than computed here, because `NEXT.quarterly` is the interval
  // `3 months` and Postgres's month arithmetic is the definition — 30-Nov plus three months is
  // 28-Feb, and a JS reimplementation would have to agree with it on every such day or the test
  // fails once a quarter for a reason that is not the code's fault.
  const { row, expected } = await readTxn(async (c) => {
    const { rows } = await c.query<{ due_on: string; completed_at: Date | null }>(
      'SELECT due_on, completed_at FROM reminders WHERE id = $1', [id],
    );
    const { rows: want } = await c.query<{ d: string }>(
      "SELECT to_char((CURRENT_DATE + interval '3 months')::date, 'YYYY-MM-DD') AS d",
    );
    return { row: rows[0]!, expected: want[0]!.d };
  });
  assert.equal(row.completed_at, null, 'still live');
  // This read `assert.equal(row.due_on, <ternary whose branches are both row.due_on>)` until
  // 21-Sep-2026 — an assertion that compared the value to itself and could not fail, under the
  // label 'moved'. The only live check beside it was that the date is not today, which a
  // reminder moved one day forward would also pass.
  assert.equal(row.due_on, expected, 'exactly three months out');
  assert.equal((await dueReminders()).length, 0);
});

// ---- delivery ---------------------------------------------------------------------------------

test('a due reminder is queued once, not once an hour', async () => {
  await createReminder({ body: 'x', dueOn: today() }, A);
  assert.equal(await deliverDue(), 1);
  assert.equal(await deliverDue(), 0, 'delivered_at is what makes hourly safe');
});

test('an unassigned reminder goes to everyone rather than to nobody', async () => {
  const id = await createReminder({ body: 'y', dueOn: today() }, A);
  await serviceTxn('system:agents', async (c) => {
    await c.query('UPDATE reminders SET assigned_to = NULL WHERE id = $1', [id]);
  });
  assert.equal(await deliverDue(), 2);
});

test('a rescheduled reminder becomes deliverable again', async () => {
  const id = await createReminder({ body: 'z', dueOn: today() }, A);
  await deliverDue();
  await snoozeReminder(id, today(), A);
  assert.equal(await deliverDue(), 1, 'clearing delivered_at is what makes the next one send');
});

// ---- the outbox -------------------------------------------------------------------------------

function recordingSender(fail = false) {
  const sent: Mail[] = [];
  const send = async (m: Mail): Promise<void> => {
    if (fail) throw new Error('relay refused');
    sent.push(m);
  };
  return { send, sent };
}

test('draining sends what is queued and marks it', async () => {
  await createReminder({ body: 'send me', dueOn: today() }, A);
  await deliverDue();
  const s = recordingSender();
  const r = await drainOutbox(s.send);
  assert.equal(r.sent, 1);
  assert.equal(s.sent[0]?.to, 'u_a@x.com');
  assert.match(String(s.sent[0]?.body), /send me/);
  assert.equal((await drainOutbox(s.send)).sent, 0, 'and not again');
});

test('with no relay configured the drain reports what is waiting rather than success', async () => {
  await createReminder({ body: 'waiting', dueOn: today() }, A);
  await deliverDue();
  const r = await drainOutbox(null);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1, 'a box without mail should not fail its jobs, nor claim it sent');
});

test('a failing send is retried, then becomes findable rather than lost', async () => {
  await createReminder({ body: 'doomed', dueOn: today() }, A);
  await deliverDue();
  const s = recordingSender(true);
  for (let i = 0; i < MAX_SEND_ATTEMPTS; i++) await drainOutbox(s.send);

  const stuck = await undeliverable();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0]?.attempts, MAX_SEND_ATTEMPTS);
  assert.match(String(stuck[0]?.lastError), /relay refused/);
  assert.equal((await drainOutbox(s.send)).sent, 0, 'and it stops being retried forever');
});

// ---- agents 4 and 5 through the runner ---------------------------------------------------------

test('the scheduled agents are enqueued by the sweep, and only once', async () => {
  assert.equal(await sweepScheduled(), 2, 'email-workflow and reminders');
  assert.equal(await sweepScheduled(), 0, 'not again while one is already queued');
});

test('they run through the queue like any other agent, and write no draft', async () => {
  await createReminder({ body: 'via the runner', dueOn: today() }, A);
  await sweepScheduled();
  const r = await drain(5);
  assert.equal(r.ran, 2);
  assert.equal(r.failed, 0);
  assert.equal(r.drafted, 0, 'neither prompts a model');

  const runs = await readTxn(async (c) => {
    const { rows } = await c.query<{ agent_key: string; status: string }>(
      'SELECT agent_key, status FROM agent_runs ORDER BY agent_key',
    );
    return rows;
  });
  assert.deepEqual(runs, [
    { agent_key: 'email-workflow', status: 'done' },
    { agent_key: 'reminders', status: 'done' },
  ], 'the registry is true: both appear in agent_runs');

  // And the reminder agent actually did its work.
  const queued = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM notification_outbox',
    );
    return rows[0]!.n;
  });
  assert.equal(queued, '1');
});

// ---- a failed unit has to reach a person, not just a table --------------------------------------

test('a failed unit is recorded AND addressed to somebody', async () => {
  // The whole point. Before this the job wrote one ingestion_runs row and stopped, which is a
  // pull: the row shows on /admin?tab=ops and waits for an admin to choose to look, so a unit that
  // dies at 04:00 reaches nobody until morning.
  const told = await recordUnitFailure('trisula-job@ingest-eod.service');
  assert.ok(told > 0, 'a notice with no recipient is the failure this replaced');

  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ subject: string; email: string; source: string }>(
      `SELECT o.subject, u.email,
              (SELECT source FROM ingestion_runs WHERE status = 'failed'
                ORDER BY finished_at DESC LIMIT 1) AS source
         FROM notification_outbox o
         JOIN users u ON u.id = o.recipient
        WHERE o.kind = 'unit_failure'`,
    );
    return rows;
  });
  assert.equal(rows.length, told);
  assert.match(rows[0]!.subject, /ingest-eod.*failed/);
  assert.equal(rows[0]!.source, 'systemd:trisula-job@ingest-eod.service');
});

test('with no admin yet, everyone active is told rather than nobody', async () => {
  // A fresh box has no admin until somebody is made one, and that is exactly when a unit failing
  // matters most. Addressing the notice to the empty set would record it and tell no one.
  const told = await recordUnitFailure('trisula-job@refresh-securities.service');
  assert.equal(told, 2, 'both seeded users, neither of whom is an admin');
});

test('once there is an admin, the notice goes to them', async () => {
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET is_admin = true WHERE id = $1', [A]);
  });
  const told = await recordUnitFailure('trisula-job@ingest-calendar.service');
  assert.equal(told, 1, 'a failed unit is an operations matter');
  await serviceTxn('system:auth', async (c) => {
    await c.query('UPDATE users SET is_admin = false WHERE id = $1', [A]);
  });
});
