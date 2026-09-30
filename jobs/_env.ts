/**
 * A job reads `.env.local`, the way the app does.
 *
 * Next loads that file for the app, and tsx loads nothing. So until 28-Sep-2026, a job run by hand
 * on a laptop needed `DATABASE_URL` exported first. Without it, `pg` connects to the database named
 * after the login user and fails with `database "<you>" does not exist`, an error that says nothing
 * about the variable that was missing. That is how a password reset failed for the person who had
 * just been told to run it.
 *
 * Every job imports this first, as a side effect. Imports are evaluated in order, so anything that
 * read the environment while loading would otherwise see it before this ran. `_env.test.ts` holds
 * every job to that, including the next one written.
 *
 * It fills only what is unset, and does nothing when the file is absent. The VM has no
 * `.env.local`, because systemd hands each unit `/etc/folio/folio.env`, and a variable exported in
 * a shell is a deliberate choice this must not undo. That precedence is written out here rather than
 * left to `process.loadEnvFile`, so it does not depend on which Node the box runs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

export function fillUnset(
  file: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    env[key] ??= value;
  }
}

fillUnset(join(import.meta.dirname, '..', '.env.local'));
