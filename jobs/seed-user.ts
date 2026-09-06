/**
 * Create an account. There is no signup route, so this is the only way one exists.
 *
 * Prints a claim URL and a set of recovery codes once. Neither is recoverable afterwards: the
 * database holds only digests.
 *
 *   pnpm exec tsx jobs/seed-user.ts --email you@trisulacapital.com --name "Your Name"
 */

import { randomBytes } from 'node:crypto';
import { closePool, serviceTxn } from '../lib/db.ts';
import { issueRecoveryCodes, setPassword } from '../lib/auth.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('--email');
  const name = arg('--name');
  if (!email || !name) {
    console.error('usage: tsx jobs/seed-user.ts --email <email> --name <name>');
    process.exit(2);
  }

  const id = randomBytes(16).toString('hex');
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
