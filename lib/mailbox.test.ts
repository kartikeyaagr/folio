/**
 * The first reversible secret in this system, and the rules that keep the exception narrow.
 *
 * What is asserted here is not "encryption works" — that is Node's job — but the four decisions
 * `lib/mailbox.ts` makes around it: no plaintext ever reaches the column, a missing key refuses
 * rather than degrades, a tampered row raises rather than decrypting into something
 * password-shaped, and a credential is never stored until it has actually carried a message.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDatabase, dropTestDatabase } from '../db/testing.ts';
import { readTxn, serviceTxn } from './db.ts';
import {
  configFor, forgetMailbox, linkMailbox, mailboxFor, MailboxRefused, NoMailboxKey,
  open, recordMailboxResult, seal, shouldPromptForMailbox,
} from './mailbox.ts';
import type { SmtpConfig } from './notify.ts';

const DB = `trisula_mbx_${process.pid}`;
const ME = 'u1';
const PASSWORD = 'the-mailbox-password-nobody-should-see';

/** A probe that records what it was given instead of talking to a relay. */
let probed: { cfg: SmtpConfig; to: string }[] = [];
const accepting = async (cfg: SmtpConfig, to: string): Promise<void> => { probed.push({ cfg, to }); };
const refusing = async (): Promise<void> => { throw new Error('535 authentication failed'); };

const link = (over: Partial<Parameters<typeof linkMailbox>[1]> = {}, probe = accepting) =>
  linkMailbox(ME, {
    host: 'smtp.hostinger.com', port: 587, username: 'desk@trisulacapital.com',
    password: PASSWORD, fromAddress: 'desk@trisulacapital.com', ...over,
  }, probe);

before(async () => {
  process.env['MAILBOX_KEY'] = Buffer.alloc(32, 7).toString('base64');
  await createTestDatabase(DB);
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','K')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'k@trisulacapital.com','K')", [ME]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  probed = [];
  process.env['MAILBOX_KEY'] = Buffer.alloc(32, 7).toString('base64');
  await serviceTxn('system:auth', (c) => c.query('DELETE FROM mailboxes'));
});

/** What is actually on disk, which is the only thing worth asserting about a secret. */
const storedSecret = (): Promise<string> =>
  readTxn(async (c) => {
    const { rows } = await c.query<{ secret: string }>(
      'SELECT secret FROM mailboxes WHERE user_id = $1', [ME]);
    return rows[0]!.secret;
  });

// ---- the column never holds the password -----------------------------------------------------------

test('the stored secret contains no part of the password, in any encoding', async () => {
  await link();
  const secret = await storedSecret();

  assert.ok(!secret.includes(PASSWORD), 'not in the clear');
  assert.ok(!secret.includes(Buffer.from(PASSWORD).toString('base64')), 'and not merely base64');
  assert.ok(!secret.includes(Buffer.from(PASSWORD).toString('hex')), 'and not merely hex');
  assert.equal(secret.split('.').length, 3, 'iv.tag.ciphertext');
  assert.equal(open(secret), PASSWORD, 'and it is the password that comes back out');
});

test('the same password sealed twice gives two different ciphertexts', async () => {
  // A fresh IV per seal. Without it, two people with the same password store the same bytes, and
  // the column becomes a way to find that out.
  assert.notEqual(seal(PASSWORD), seal(PASSWORD));
  assert.equal(open(seal(PASSWORD)), PASSWORD);
});

test('a tampered secret raises rather than opening into something password-shaped', async () => {
  await link();
  const [iv, tag, ct] = (await storedSecret()).split('.');
  // Flip the ciphertext, keep the tag. Without GCM's tag this decrypts to garbage and the garbage
  // gets sent to a relay; with it, this throws.
  const flipped = Buffer.from(ct!, 'base64');
  flipped[0] = flipped[0]! ^ 0xff;
  assert.throws(() => open([iv, tag, flipped.toString('base64')].join('.')));
  assert.throws(() => open('not.a.secret'), MailboxRefused);
  assert.throws(() => open('only-one-part'), MailboxRefused);
});

// ---- a missing key refuses, and never degrades ------------------------------------------------------

test('with no MAILBOX_KEY, linking refuses and writes nothing', async () => {
  delete process.env['MAILBOX_KEY'];
  await assert.rejects(() => link(), NoMailboxKey);
  assert.equal(await mailboxFor(ME), null, 'nothing was stored in the clear as a fallback');
  assert.equal(probed.length, 0, 'and nothing was sent before the refusal');
});

test('a MAILBOX_KEY of the wrong size refuses rather than being padded into one', async () => {
  process.env['MAILBOX_KEY'] = Buffer.from('too short').toString('base64');
  await assert.rejects(() => link(), NoMailboxKey);
});

test('with no MAILBOX_KEY, nobody is prompted to link a mailbox at all', async () => {
  // `MailboxPrompt` cannot be dismissed by Escape or by clicking away, deliberately, so the offer
  // is answered rather than ignored. Without a key its primary action throws — which made the
  // first screen of somebody's first sign-in a modal whose only working button was "Skip".
  //
  // The reset is what gives this test teeth. Earlier tests link successfully, and linking answers
  // the prompt — so without it this passed with the key check deleted from `mailbox.ts`, which is
  // a test that asserts nothing. Confirmed by deleting the check and watching it fail.
  await serviceTxn('system:auth', async (c) =>
    c.query('UPDATE users SET mailbox_prompted_at = NULL WHERE id = $1', [ME]));

  delete process.env['MAILBOX_KEY'];
  assert.equal(await shouldPromptForMailbox(ME), false);
});

test('and the offer is not spent: the key arriving later still gets everybody asked', async () => {
  // The distinction that matters. `mailbox_prompted_at` is written by ANSWERING the prompt, so
  // suppressing it must leave the row untouched — otherwise setting the key on a live box would
  // silently mean nobody is ever offered their own mailbox.
  //
  // Reset explicitly: earlier tests in this file link successfully, and linking answers the prompt.
  // Without this the second assertion passes for the wrong reason, which is how it first failed.
  await serviceTxn('system:auth', async (c) =>
    c.query('UPDATE users SET mailbox_prompted_at = NULL WHERE id = $1', [ME]));

  delete process.env['MAILBOX_KEY'];
  assert.equal(await shouldPromptForMailbox(ME), false, 'not asked while the key is missing');

  process.env['MAILBOX_KEY'] = Buffer.alloc(32, 7).toString('base64');
  assert.equal(await shouldPromptForMailbox(ME), true, 'asked the moment the key exists');
});

test('a MAILBOX_KEY of the wrong size prompts nobody either', async () => {
  // A key that is set but not 32 bytes fails linking exactly as completely as a missing one, so
  // it must suppress the modal the same way. A presence check alone would pass the two tests above.
  await serviceTxn('system:auth', async (c) =>
    c.query('UPDATE users SET mailbox_prompted_at = NULL WHERE id = $1', [ME]));
  process.env['MAILBOX_KEY'] = Buffer.from('too short').toString('base64');
  assert.equal(await shouldPromptForMailbox(ME), false);
});

// ---- nothing is stored until it has carried a message -----------------------------------------------

test('a relay that refuses the credentials links nothing', async () => {
  await assert.rejects(() => link({}, refusing), MailboxRefused);
  assert.equal(await mailboxFor(ME), null,
    'a credential that has never carried anything is one somebody must go and test later');
});

test('the proof is a real send, to the address being linked', async () => {
  await link({ fromAddress: 'ka@trisulacapital.com' });
  assert.equal(probed.length, 1);
  assert.equal(probed[0]!.to, 'ka@trisulacapital.com', 'the person sees it arrive');
  assert.equal(probed[0]!.cfg.password, PASSWORD, 'proved with what was typed, not with what was stored');
});

test('host, username and from are all required before anything is sent', async () => {
  for (const missing of [{ host: '' }, { username: '' }, { fromAddress: '' }]) {
    await assert.rejects(() => link(missing), MailboxRefused);
  }
  assert.equal(probed.length, 0);
});

// ---- what a screen may know -------------------------------------------------------------------------

test('the view a screen gets carries no secret of any kind', async () => {
  await link();
  const view = await mailboxFor(ME);
  assert.ok(view);
  assert.deepEqual(Object.keys(view).sort(),
    ['fromAddress', 'host', 'lastError', 'lastOkAt', 'linkedAt', 'port', 'username']);
  assert.ok(!JSON.stringify(view).includes(PASSWORD));
});

test('the job can open what the browser sealed', async () => {
  await link();
  const cfg = await configFor(ME);
  assert.equal(cfg?.password, PASSWORD);
  assert.equal(cfg?.host, 'smtp.hostinger.com');
  assert.equal(cfg?.from, 'desk@trisulacapital.com');
});

test('re-linking replaces rather than accumulating, and clears the last error', async () => {
  await link();
  await recordMailboxResult(ME, 'relay went away');
  assert.match((await mailboxFor(ME))!.lastError!, /went away/);

  await link({ host: 'smtp.gmail.com' });
  const n = await readTxn(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM mailboxes WHERE user_id = $1', [ME]);
    return rows[0]!.n;
  });
  assert.equal(n, 1, 'one mailbox per person; the primary key says so');
  assert.equal((await mailboxFor(ME))!.host, 'smtp.gmail.com');
  assert.equal((await mailboxFor(ME))!.lastError, null, 'a working re-link is not still broken');
});

test('unlinking leaves nothing behind', async () => {
  await link();
  await forgetMailbox(ME);
  assert.equal(await mailboxFor(ME), null);
  assert.equal(await configFor(ME), null);
});

test('port 25 is refused by the database, not only by the form', async () => {
  // The form offers three submission ports and 25 is not among them. A constraint says so too,
  // because a form is a suggestion and this is the port that crosses the internet unencrypted.
  await assert.rejects(
    () => serviceTxn('system:auth', (c) => c.query(
      `INSERT INTO mailboxes (user_id, host, port, username, secret, from_address)
       VALUES ($1,'h',25,'u','s','f')`, [ME])),
    /mailboxes_port_is_submission/,
  );
});
