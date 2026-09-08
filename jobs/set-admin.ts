/**
 * Grant or revoke admin on an existing account.
 *
 * Admin is granted from the VM and nowhere else, for the same reason there is no signup route: the
 * set of people who can see what the system costs to run should change by someone deciding it on
 * the box, not by a form somebody found.
 *
 *   pnpm exec tsx jobs/set-admin.ts --email you@trisulacapital.com
 *   pnpm exec tsx jobs/set-admin.ts --email them@trisulacapital.com --revoke
 *   pnpm exec tsx jobs/set-admin.ts --list
 *
 * This does not create accounts. `jobs/seed-user.ts` does that, and a new account is an ordinary
 * one until this is run against it.
 */
import { closePool, readTxn, serviceTxn } from '../lib/db.ts';

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);

async function main(): Promise<void> {
  if (has('--list')) {
    const rows = await readTxn(async (c) => {
      const { rows } = await c.query<{ email: string; name: string; is_admin: boolean }>(
        'SELECT email, name, is_admin FROM users WHERE disabled_at IS NULL ORDER BY email',
      );
      return rows;
    });
    if (rows.length === 0) {
      console.error('no live accounts; seed one with jobs/seed-user.ts');
      process.exitCode = 1;
      return;
    }
    for (const r of rows) {
      console.log(`${r.is_admin ? 'admin ' : '      '} ${r.email.padEnd(32)} ${r.name}`);
    }
    return;
  }

  const email = arg('--email');
  if (!email) {
    console.error('usage: tsx jobs/set-admin.ts --email <email> [--revoke]   |   --list');
    process.exitCode = 2;
    return;
  }

  const grant = !has('--revoke');
  // Matched case-insensitively and gated on disabled_at, the same way login() reads it: granting
  // admin to a disabled account would be a live permission on a dead login.
  const updated = await serviceTxn('system:auth', async (c) => {
    const { rows } = await c.query<{ email: string; name: string }>(
      `UPDATE users SET is_admin = $2
        WHERE lower(email) = lower($1) AND disabled_at IS NULL
        RETURNING email, name`,
      [email, grant],
    );
    return rows[0] ?? null;
  });

  if (!updated) {
    console.error(`no live account for ${email}`);
    process.exitCode = 1;
    return;
  }

  console.log(`${grant ? 'granted' : 'revoked'} admin: ${updated.name} <${updated.email}>`);
  console.log('They will see the change on their next page load; no need to sign out.');
}

main()
  .catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
