/**
 * Reset an account's password. The login page tells a locked-out person to "ask someone with VM
 * access"; this is the thing that person runs. `seed-user.ts` can only create an account, and the
 * temporary password it prints is unrecoverable afterwards — the database holds an argon2 digest,
 * and the recovery codes beside it are digests too.
 *
 * Prints the new password once. Nothing stores it.
 *
 *   pnpm exec tsx jobs/reset-password.ts --email you@trisulacapital.com
 */

import { randomBytes } from 'node:crypto';
import { closePool, readTxn } from '../lib/db.ts';
import { setPassword } from '../lib/auth.ts';
import { readFlags } from './_args.ts';


async function main(): Promise<void> {
  const flags = readFlags(['email']);
  const email = flags.str('email');
  if (!email) {
    console.error('usage: tsx jobs/reset-password.ts --email <email>');
    process.exit(2);
  }

  // Matched case-insensitively and gated on disabled_at, the same way login() reads it. A disabled
  // account that could still have its password reset would be a way back in around the disabling.
  const user = await readTxn(async (c) => {
    const { rows } = await c.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE lower(email) = lower($1) AND disabled_at IS NULL',
      [email],
    );
    return rows[0] ?? null;
  });

  if (!user) {
    console.error(`no live account for ${email}`);
    process.exit(1);
  }

  const temporary = randomBytes(12).toString('base64url');
  await setPassword(user.id, temporary, 'system:auth');

  console.log(`\nreset    ${user.name} <${email}>`);
  console.log(`password ${temporary}     (change it on next login)`);
  console.log('\nExisting recovery codes are untouched. Sessions stay live — revoke them separately');
  console.log('if the old password is believed compromised.\n');
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
