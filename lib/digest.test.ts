/**
 * One envelope a morning, per person, and never more.
 *
 * The three properties the instruction rests on: everything a person is owed arrives in **one**
 * mail, it goes to **their own** address, and a second run the same day sends **nothing**. The last
 * is the one that would fail silently — a digest that re-sent every hour looks fine in the code and
 * arrives twenty-four times.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';
import { readTxn, serviceTxn } from './db.ts';
import { composeDigest, DIGEST_HOUR, istHour, sendDigests } from './digest.ts';
import { forgetMailbox, linkMailbox } from './mailbox.ts';
import type { Mail } from './notify.ts';

const DB = `folio_digest_${process.pid}`;
const ANNA = 'u1';
const BOB = 'u2';

/** 08:00 IST on a Thursday — after the gate. */
const MORNING = new Date('2026-09-17T02:30:00Z');
/** 04:00 IST the same day — before it. */
const NIGHT = new Date('2026-09-16T22:30:00Z');

let outbox: Mail[] = [];
const collecting = async (m: Mail): Promise<void> => { outbox.push(m); };
const refusing = async (): Promise<void> => { throw new Error('relay said no'); };

before(async () => {
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    for (const [id, email, name] of [
      [ANNA, 'anna@trisulacapital.com', 'Anna'],
      [BOB, 'bob@trisulacapital.com', 'Bob'],
    ]) {
      await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person',$2)", [id, name]);
      await c.query('INSERT INTO users (id,email,name) VALUES ($1,$2,$3)', [id, email, name]);
    }
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  outbox = [];
  await serviceTxn('system:alerts', (c) => c.query('DELETE FROM notification_outbox'));
});

let n = 0;
const queue = (to: string, kind: string, subject: string, body = 'the body'): Promise<unknown> =>
  serviceTxn('system:alerts', (c) =>
    c.query(
      'INSERT INTO notification_outbox (id, kind, recipient, subject, body) VALUES ($1,$2,$3,$4,$5)',
      [`n${n++}`, kind, to, subject, body],
    ));

const unsent = (to: string): Promise<number> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notification_outbox WHERE recipient=$1 AND sent_at IS NULL',
      [to]);
    return rows[0]!.n;
  });

// ---- the instruction -----------------------------------------------------------------------------

test('five events become one mail, to that person’s own address', async () => {
  await queue(ANNA, 'alert', 'PRAJIND fell 9%');
  await queue(ANNA, 'alert', 'TEGA volume spike');
  await queue(ANNA, 'reminder', 'Ask Praj about the auditor');
  await queue(ANNA, 'backfill', 'AERON history filled in');
  await queue(ANNA, 'unit_failure', 'ingest-eod failed');

  const r = await sendDigests(collecting, MORNING);
  assert.equal(r.sent, 1, 'one envelope, not five');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.to, 'anna@trisulacapital.com');
  assert.equal(await unsent(ANNA), 0, 'every row it carried is marked sent');

  // All five are in it, under headings, most-decidable first.
  const body = outbox[0]!.body;
  for (const s of ['PRAJIND fell 9%', 'TEGA volume spike', 'Ask Praj about the auditor',
    'AERON history filled in', 'ingest-eod failed']) {
    assert.ok(body.includes(s), `${s} is in the envelope`);
  }
  assert.ok(body.indexOf('Due today') < body.indexOf('Alerts'), 'what is due is read first');
});

test('two people get two mails, each holding only their own', async () => {
  await queue(ANNA, 'alert', 'Anna’s alert');
  await queue(BOB, 'alert', 'Bob’s alert');

  await sendDigests(collecting, MORNING);
  assert.equal(outbox.length, 2);
  const anna = outbox.find((m) => m.to.startsWith('anna'))!;
  const bob = outbox.find((m) => m.to.startsWith('bob'))!;
  assert.ok(anna.body.includes('Anna’s alert') && !anna.body.includes('Bob’s alert'));
  assert.ok(bob.body.includes('Bob’s alert') && !bob.body.includes('Anna’s alert'));
});

test('a second run the same day sends nothing at all', async () => {
  // The failure that would arrive twenty-four times before anybody read the code.
  await queue(ANNA, 'alert', 'the only thing today');
  assert.equal((await sendDigests(collecting, MORNING)).sent, 1);

  await queue(ANNA, 'alert', 'something that happened at lunch');
  const second = await sendDigests(collecting, new Date('2026-09-17T08:30:00Z')); // 14:00 IST
  assert.equal(second.sent, 0, 'one envelope a day, whatever else arrives');
  assert.equal(outbox.length, 1);
  assert.equal(await unsent(ANNA), 1, 'and lunch is still waiting, for tomorrow');
});

test('tomorrow it goes again, carrying what waited', async () => {
  await queue(ANNA, 'alert', 'Wednesday');
  await sendDigests(collecting, new Date('2026-09-16T02:30:00Z'));
  await queue(ANNA, 'alert', 'Thursday');
  const r = await sendDigests(collecting, MORNING);

  assert.equal(r.sent, 1);
  assert.ok(outbox[1]!.body.includes('Thursday'));
  assert.ok(!outbox[1]!.body.includes('Wednesday'), 'yesterday already went');
});

// ---- the brief, which is not the digest's --------------------------------------------------------

test('a brief sent this morning does not spend the day’s envelope', async () => {
  // Mailed at 08:03 by the agents job (0067). Counted as the day's envelope, it would hold every
  // alert raised after it until tomorrow.
  await queue(ANNA, 'brief', 'Folio brief — Thu 17 Sep: 3 names, 9 quiet');
  await serviceTxn('system:agents', (c) =>
    c.query("UPDATE notification_outbox SET sent_at = $1 WHERE kind = 'brief'", [MORNING.toISOString()]));
  await queue(ANNA, 'alert', 'raised at lunch');

  const r = await sendDigests(collecting, new Date('2026-09-17T08:30:00Z')); // 14:00 IST
  assert.equal(r.sent, 1, 'the digest still goes: the brief was a mail of its own');
  assert.ok(outbox[0]!.body.includes('raised at lunch'));
});

test('an unsent brief is never folded into the digest', async () => {
  await queue(ANNA, 'brief', 'Folio brief — the one the relay refused');
  await queue(ANNA, 'alert', 'PRAJIND fell 9%');

  const r = await sendDigests(collecting, MORNING);
  assert.equal(r.sent, 1);
  assert.ok(!outbox[0]!.body.includes('the one the relay refused'), 'it has its own sender and retries');
  assert.equal(await unsent(ANNA), 1, 'and it is still waiting for them');
});

test('a person owed only a brief is not somebody the digest is waiting on', async () => {
  await queue(ANNA, 'brief', 'Folio brief — waiting on the relay');
  assert.deepEqual(await sendDigests(collecting, NIGHT), { sent: 0, failed: 0, skipped: 0 });
});

// ---- the gates -----------------------------------------------------------------------------------

test('nothing goes out before the hour, and what is waiting is said out loud', async () => {
  await queue(ANNA, 'alert', 'queued overnight');
  const r = await sendDigests(collecting, NIGHT);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1, 'reported rather than silently skipped');
  assert.equal(outbox.length, 0);
  assert.equal(await unsent(ANNA), 1, 'still queued, for the morning');
});

test('no relay is a valid state: nothing is sent, nothing is lost, and it says so', async () => {
  await queue(ANNA, 'alert', 'nowhere to send this');
  const r = await sendDigests(null, MORNING);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 1);
  assert.equal(await unsent(ANNA), 1, 'the outbox is still the record');
});

test('a relay that refuses credits an attempt to every row and keeps the reason', async () => {
  await queue(ANNA, 'alert', 'one');
  await queue(ANNA, 'alert', 'two');
  const r = await sendDigests(refusing, MORNING);
  assert.equal(r.failed, 1);

  const rows = await readTxn(async (c) => {
    const { rows } = await c.query<{ attempts: number; last_error: string }>(
      'SELECT attempts, last_error FROM notification_outbox WHERE recipient=$1', [ANNA]);
    return rows;
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.attempts, 1, 'every row in the envelope wears the attempt');
    assert.match(row.last_error, /relay said no/);
  }
  // And it may be tried again, because nothing was marked sent.
  assert.equal(await unsent(ANNA), 2);
});

test('a disabled account is not mailed', async () => {
  await queue(BOB, 'alert', 'to a closed account');
  await serviceTxn('system:auth', (c) =>
    c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [BOB]));
  assert.equal((await sendDigests(collecting, MORNING)).sent, 0);
  await serviceTxn('system:auth', (c) =>
    c.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [BOB]));
});

test('nobody with nothing waiting gets an empty mail', async () => {
  const r = await sendDigests(collecting, MORNING);
  assert.deepEqual(r, { sent: 0, failed: 0, skipped: 0 });
  assert.equal(outbox.length, 0);
});

// ---- the pieces ----------------------------------------------------------------------------------

test('the hour is read in IST wherever the box thinks it is', async () => {
  // `ops/systemd/folio-job@.service` sets TZ=Asia/Kolkata and a laptop does not. A digest whose
  // hour depends on whose machine ran it is the kind of thing nobody notices until a Monday.
  assert.equal(istHour(new Date('2026-09-17T02:30:00Z')), 8);
  assert.equal(istHour(new Date('2026-09-16T22:30:00Z')), 4);
  assert.ok(DIGEST_HOUR > 4 && DIGEST_HOUR < 12, 'the gate is a morning hour');
});

test('the subject says what is inside, so opening it is a decision made once', async () => {
  const { subject } = composeDigest(
    { name: 'Anna' },
    [{ kind: 'alert', subject: 'a', body: '' }, { kind: 'alert', subject: 'b', body: '' },
     { kind: 'reminder', subject: 'c', body: '' }],
    MORNING,
    { draftsWaiting: 0, runsNeedingSomebody: 0 },
  );
  assert.match(subject, /^Folio — 17 Sep/);
  assert.match(subject, /1 reminder\b/, 'singular where it is one');
  assert.match(subject, /2 alerts/, 'plural where it is more');
});

test('"nothing is waiting" is said, because a quiet morning is worth knowing', async () => {
  const { body } = composeDigest(
    { name: 'Anna' }, [{ kind: 'alert', subject: 'a', body: '' }], MORNING,
    { draftsWaiting: 0, runsNeedingSomebody: 0 },
  );
  assert.match(body, /Nothing in the review queue/);

  const busy = composeDigest(
    { name: 'Anna' }, [{ kind: 'alert', subject: 'a', body: '' }], MORNING,
    { draftsWaiting: 3, runsNeedingSomebody: 1 },
  );
  assert.match(busy.body, /3 drafts waiting/);
  assert.match(busy.body, /1 agent run out of attempts/);
});

test('a linked mailbox is a route of its own, so no shared relay does not withhold their digest', async () => {
  // `sendDigests` returned early on `sender === null` and skipped everybody — before any
  // person's own mailbox had been looked up. This module's header states the rule the other way
  // round, in as many words: "A null shared relay **and** no linked mailbox is a valid state."
  // And, not or. Someone who has linked their own company address needs no shared relay at all,
  // and was having their digest withheld because somebody else's route was unconfigured.
  //
  // Asserted as attempted-rather-than-withheld, which is the whole of the change: the linked host
  // is deliberately unreachable — port 2525 on localhost, which the table's submission-port check
  // permits and nothing is listening on — so the send fails fast and lands in `failed`. Under the old
  // behaviour it was `skipped` and nothing was tried.
  process.env['MAILBOX_KEY'] = Buffer.alloc(32, 7).toString('base64');
  await linkMailbox(
    ANNA,
    { host: '127.0.0.1', port: 2525, username: 'anna', password: 'pw', fromAddress: 'anna@trisulacapital.com' },
    async () => {},
  );
  await queue(ANNA, 'alert', 'One thing');

  const r = await sendDigests(null, MORNING);
  assert.equal(r.skipped, 0, 'not withheld for want of a shared relay');
  assert.equal(r.failed, 1, 'attempted down her own route, which is unreachable in this test');
  assert.equal(await unsent(ANNA), 1, 'and the row is still the record');

  await forgetMailbox(ANNA);
  delete process.env['MAILBOX_KEY'];
});
