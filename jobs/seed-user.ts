/**
 * Create an account. `/signup` only records a request, so this is still the only way one exists.
 *
 * Prints a temporary password and a set of recovery codes once. Neither is recoverable
 * afterwards: the database holds only digests.
 *
 *   pnpm exec tsx jobs/seed-user.ts --request 8f3c…            # an approved access request
 *   pnpm exec tsx jobs/seed-user.ts --email you@x.com --name "Your Name"   # the first account
 *
 * **`--request` exists so that no applicant's text ever reaches a shell.** The admin screen used
 * to print a ready-made command with the request's own email and name interpolated into it, both
 * taken verbatim off the public form, and invite an admin to paste it into a root shell. A name
 * of `" ; curl … | sh #` made that command do something else. The id is 32 hex characters this
 * system minted, so the pasted line carries nothing a stranger chose; the email and the name are
 * read from the row here, inside the database, where they are data and not syntax.
 *
 * `--email`/`--name` stay, because the first account has to exist before anyone can request one.
 * They come from whoever is holding the shell, which is a different trust question.
 */

import { randomBytes } from 'node:crypto';
import { closePool, rowId, serviceTxn } from '../lib/db.ts';
import { approvedRequest } from '../lib/access-requests.ts';
import { issueRecoveryCodes, setPassword } from '../lib/auth.ts';
import { readFlags } from './_args.ts';


async function main(): Promise<void> {
  const flags = readFlags(['request', 'email', 'name']);
  const requestId = flags.str('request');
  const from = requestId ? await approvedRequest(requestId) : null;
  const email = from?.email ?? flags.str('email');
  const name = from?.name ?? flags.str('name');
  if (!email || !name) {
    console.error('usage: tsx jobs/seed-user.ts --request <id>');
    console.error('   or: tsx jobs/seed-user.ts --email <email> --name <name>');
    process.exit(2);
  }

  const id = rowId();
  // An account and its actor are one fact, so they are one transaction. A user row whose actor is
  // missing would fail its own foreign key; an actor with no user would be a principal nobody owns.
  await serviceTxn('system:auth', async (c) => {
    await c.query('INSERT INTO actors (id, kind, label) VALUES ($1, $2, $3)', [id, 'person', name]);
    await c.query('INSERT INTO users (id, email, name) VALUES ($1, $2, $3)', [id, email, name]);
  });

  // A temporary password rather than a null one: the account is usable immediately, and the holder
  // changes it. Printed once.
  const temporary = randomBytes(12).toString('base64url');
  await setPassword(id, temporary, 'system:auth');
  const codes = await issueRecoveryCodes(id, 'system:auth');

  console.log(`\ncreated  ${name} <${email}>`);
  console.log(`actor    ${id}`);
  console.log(`password ${temporary}     (change it on first login)`);
  console.log('\nrecovery codes, shown once:');
  for (const c of codes) console.log(`  ${c}`);
  console.log('');
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
