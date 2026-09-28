/**
 * A person's own mailbox: sealing it, opening it, and proving it works before it is stored.
 *
 * **The first reversible secret in this system.** `password_hash` is Argon2id, session tokens and
 * recovery codes are sha256 — none of them can be turned back into what was typed, and that is the
 * property every one of them is designed around. An SMTP password cannot be like that, because
 * AUTH LOGIN sends it. So this file exists to make the exception narrow and to say where its edges
 * are.
 *
 * Four rules, and each one is a decision rather than a default:
 *
 *   1. **AES-256-GCM under `MAILBOX_KEY`**, 32 bytes of base64 in the box's environment. Not
 *      pgcrypto — `vector` is this schema's only extension, and a key inside the database next to
 *      the ciphertext is filing, not encryption. `MAILBOX_KEY` lives in `/etc/folio/folio.env`
 *      with the other credentials and is not in a backup of the database.
 *   2. **No plaintext fallback.** `seal` throws with `MAILBOX_KEY` unset. A system that stores a
 *      password in the clear when a setting is missing is worse than one that refuses, because
 *      nothing about it looks wrong afterwards.
 *   3. **The web process seals and never opens.** `link()` proves the credentials by sending a real
 *      message with the plaintext it was just handed, then seals it. `open()` is called by the
 *      digest job and by nothing else. No screen can render this value, because no screen-facing
 *      code path decrypts it.
 *   4. **Authenticated.** GCM's tag means a tampered ciphertext raises rather than decrypting into
 *      a password-shaped string that gets sent somewhere.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { readTxn, serviceTxn, writeTxn } from './db.ts';
import { smtpSender, type SmtpConfig } from './notify.ts';

export class NoMailboxKey extends Error {}
export class MailboxRefused extends Error {}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's standard nonce length; anything else costs a rehash internally.

/**
 * The key, read at call time rather than at import.
 *
 * Module scope would freeze it before `jobs/*` has loaded the environment, which is the exact shape
 * of the bug `lib/retrieval/embed.ts` documents for `EMBED_MODEL_DIR` — a value captured at import
 * that was right in the tests and wrong in the one process that mattered.
 */
function key(): Buffer {
  const raw = process.env['MAILBOX_KEY'];
  if (!raw) {
    throw new NoMailboxKey(
      'MAILBOX_KEY is not set, so a mailbox password cannot be stored. Generate one with ' +
        '`openssl rand -base64 32` and put it in /etc/folio/folio.env. See ops/SETUP.md §9b.',
    );
  }
  const aesKey = Buffer.from(raw, 'base64');
  if (aesKey.length !== 32) {
    throw new NoMailboxKey(`MAILBOX_KEY must decode to 32 bytes; got ${aesKey.length}. Use \`openssl rand -base64 32\`.`);
  }
  return aesKey;
}

/** `iv.tag.ciphertext`, base64 each. */
export function seal(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

/**
 * Any failure to open is `MailboxRefused`, never a raw crypto error.
 *
 * Checking the three parts are present is not enough: `not.a.secret` has three parts and reaches
 * `setAuthTag` with zero bytes, which throws `TypeError: Invalid authentication tag length: 0`.
 * That is the same event as a wrong key or a flipped bit — the secret cannot be opened — and a
 * caller that handles one should not have to know the other three shapes it can arrive in. The
 * digest catches this, records it against the mailbox and falls back to the shared relay; a
 * TypeError there would instead be an unhandled throw in a timer.
 *
 * `NoMailboxKey` is deliberately let through rather than folded in. "There is no key on this box"
 * is an operator's problem with an operator's fix, and flattening it into "this secret is bad"
 * would send somebody looking at the wrong thing.
 */
export function open(sealed: string): string {
  const [iv, tag, ct] = sealed.split('.');
  if (!iv || !tag || !ct) throw new MailboxRefused('stored mailbox secret is not in the expected shape');
  const aesKey = key();
  try {
    const decipher = createDecipheriv(ALGORITHM, aesKey, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    // Raises on a bad tag rather than returning plausible bytes, which is the whole reason for GCM.
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    // The message is deliberately about the row and not about the bytes: "unable to authenticate
    // data" tells an attacker which of their guesses got further than the others.
    throw new MailboxRefused(
      `stored mailbox secret could not be opened (${err instanceof Error ? err.constructor.name : 'error'}) — ` +
        'it was written under a different MAILBOX_KEY, or it has been altered',
    );
  }
}

/** What a screen may know about a linked mailbox. Deliberately no secret, of any shape. */
export interface MailboxView {
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  linkedAt: Date;
  lastOkAt: Date | null;
  lastError: string | null;
}

export async function mailboxFor(userId: string): Promise<MailboxView | null> {
  return readTxn(async (c) => {
    const { rows } = await c.query<MailboxView>(
      `SELECT host, port, username, from_address AS "fromAddress",
              linked_at AS "linkedAt", last_ok_at AS "lastOkAt", last_error AS "lastError"
         FROM mailboxes WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ?? null;
  });
}

/** Everything the digest needs to send as this person, opened. Job-side only. */
export async function configFor(userId: string): Promise<SmtpConfig | null> {
  const row = await readTxn(async (c) => {
    const { rows } = await c.query<{
      host: string; port: number; username: string; secret: string; from_address: string;
    }>(
      'SELECT host, port, username, secret, from_address FROM mailboxes WHERE user_id = $1',
      [userId],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;
  return {
    host: row.host, port: row.port, user: row.username,
    password: open(row.secret), from: row.from_address,
  };
}

export interface LinkInput {
  host: string;
  port: number;
  username: string;
  password: string;
  fromAddress: string;
}

/**
 * Prove the credentials, then seal them.
 *
 * **The proof is a real message**, sent to the address being linked, with the plaintext the person
 * just typed. Two reasons it is a send rather than a connect-and-authenticate: a relay that accepts
 * AUTH and then refuses the envelope is a working login and a useless mailbox — Hostinger does
 * exactly this when `from_address` is not the authenticated box — and a person who sees the message
 * arrive knows it is linked without being told.
 *
 * Nothing is written if the send fails. A stored credential that has never carried anything is a
 * thing somebody has to go and test later, which is how a mailbox comes to be "linked" and dead.
 */
export async function linkMailbox(
  userId: string,
  input: LinkInput,
  probe: (cfg: SmtpConfig, to: string) => Promise<void> = defaultProbe,
): Promise<void> {
  const cfg: SmtpConfig = {
    host: input.host.trim(), port: input.port, user: input.username.trim(),
    password: input.password, from: input.fromAddress.trim(),
  };
  if (!cfg.host || !cfg.user || !cfg.from) throw new MailboxRefused('host, username and from address are all required');

  // Sealed before the probe so a throw from the relay cannot leave the plaintext in scope any
  // longer than it has to be, and so `MAILBOX_KEY` being absent fails before anything is sent.
  const sealed = seal(input.password);
  try {
    await probe(cfg, cfg.from);
  } catch (err) {
    throw new MailboxRefused(
      `The relay would not send with those details: ${String(err instanceof Error ? err.message : err)}`,
    );
  }

  await writeTxn(userId, async (c) => {
    await c.query(
      `INSERT INTO mailboxes (user_id, host, port, username, secret, from_address, last_ok_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (user_id) DO UPDATE
          SET host = EXCLUDED.host, port = EXCLUDED.port, username = EXCLUDED.username,
              secret = EXCLUDED.secret, from_address = EXCLUDED.from_address,
              linked_at = now(), last_ok_at = now(), last_error = NULL`,
      [userId, cfg.host, cfg.port, cfg.user, sealed, cfg.from],
    );
    // Same transaction: somebody who has just linked has plainly seen the prompt, and leaving the
    // column null would open it again on their next page load, over a mailbox they already have.
    await c.query(
      'UPDATE users SET mailbox_prompted_at = now() WHERE id = $1 AND mailbox_prompted_at IS NULL',
      [userId]);
  });
}

const defaultProbe = async (cfg: SmtpConfig, to: string): Promise<void> => {
  await smtpSender(cfg)({
    to,
    subject: 'Folio — your mailbox is linked',
    body:
      'This is the message that proved it.\n\n' +
      'Your daily update will arrive from this address from tomorrow morning. Nothing reads this ' +
      'mailbox; the password is used only to send you your own digest, and it is stored encrypted.\n\n' +
      'Folio',
  });
};

/**
 * Whether this box can store a mailbox password at all.
 *
 * The same question `key()` asks, without throwing, so a caller can decide not to offer something
 * rather than offering it and failing. Checks the length too: a `MAILBOX_KEY` that is set but not
 * 32 bytes fails exactly as completely as one that is missing, and the difference is visible only
 * in the message.
 */
export function mailboxKeyPresent(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this person has been offered the mailbox prompt yet.
 *
 * Asked of `users` rather than of `mailboxes`, and those are different questions: somebody who was
 * asked and said no has no mailbox and must not be asked again, which a `mailboxes` lookup alone
 * cannot tell from somebody who has never been asked.
 *
 * With no `MAILBOX_KEY` on the box, nobody is asked. `components/MailboxPrompt.tsx` is a modal
 * that cannot be dismissed by Escape or by clicking away — deliberately, so the one-time offer is
 * answered rather than ignored — and without the key its primary action throws `NoMailboxKey` and
 * flashes a sentence. The first screen of somebody's first sign-in was therefore a modal whose
 * only working button was "Skip".
 *
 * Suppressing it does NOT spend the offer: `mailbox_prompted_at` is written by answering the
 * prompt, and a prompt never shown is never answered, so the day the key is set everybody who has
 * not seen it still gets it.
 */
export async function shouldPromptForMailbox(userId: string): Promise<boolean> {
  if (!mailboxKeyPresent()) return false;
  return readTxn(async (c) => {
    const { rows } = await c.query<{ ask: boolean }>(
      'SELECT mailbox_prompted_at IS NULL AS ask FROM users WHERE id = $1', [userId]);
    return rows[0]?.ask ?? false;
  });
}

/**
 * Record that they have been asked. Set by dismissing and by linking alike — the prompt is shown
 * once either way, and a person who linked has plainly seen it.
 */
export async function markMailboxPrompted(userId: string): Promise<void> {
  await writeTxn(userId, (c) =>
    c.query('UPDATE users SET mailbox_prompted_at = now() WHERE id = $1 AND mailbox_prompted_at IS NULL',
      [userId]));
}

/** Unlink. The digest falls back to the shared relay, which is the state everybody starts in. */
export async function forgetMailbox(userId: string): Promise<void> {
  await writeTxn(userId, (c) => c.query('DELETE FROM mailboxes WHERE user_id = $1', [userId]));
}

/**
 * Record how the last send through a person's mailbox went.
 *
 * Written by the digest job, so it runs under a service principal rather than as the person: the
 * person did not do this, a timer did, and `audit_log` should say so.
 */
export async function recordMailboxResult(userId: string, error: string | null): Promise<void> {
  await serviceTxn('system:agents', (c) =>
    c.query(
      error === null
        ? 'UPDATE mailboxes SET last_ok_at = now(), last_error = NULL WHERE user_id = $1'
        : 'UPDATE mailboxes SET last_error = $2 WHERE user_id = $1',
      error === null ? [userId] : [userId, error.slice(0, 500)],
    ));
};


