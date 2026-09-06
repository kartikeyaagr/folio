/**
 * The migration runner.
 *
 * Two properties, both carried from v2 because both were earned:
 *
 * 1. **A migration and its ledger row commit together, in one transaction.** If the process dies
 *    mid-migration there is no state where the schema moved but the ledger says it did not, or
 *    the reverse. Postgres has transactional DDL; this is the whole reason to prefer it here.
 *
 * 2. **An applied migration whose bytes have changed is a hard stop.** Editing a migration that
 *    has already run means the database you have and the database the file describes are
 *    different, and every environment drifts differently from then on. The fix is always a new
 *    migration, never an edit, so the runner refuses rather than warns.
 *
 * Migrations run as `system:migration`, so one that seeds an audited table is attributed like
 * any other write rather than being a hole in the record.
 *
 * Migrations are plain SQL in filename order. There is no ORM and no DSL: `db/migrations/*.sql`
 * is the schema, and both the app and the jobs read the database it produces.
 *
 * Usage:  pnpm migrate            apply anything pending
 *         pnpm migrate --status   list applied and pending, change nothing
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename    text        PRIMARY KEY,
    sha256      text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    applied_by  text        NOT NULL DEFAULT 'system:migration'
  )`;

interface Migration {
  filename: string;
  sql: string;
  sha256: string;
}

function load(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      return { filename, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });
}

export async function migrate(opts: { statusOnly?: boolean } = {}): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(LEDGER);
    const { rows } = await client.query<{ filename: string; sha256: string }>(
      'SELECT filename, sha256 FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.filename, r.sha256]));
    const all = load();

    // Check every applied migration before running anything. A changed file is a stop, not a
    // warning, and finding out after three more have run is worse than finding out now.
    const changed = all.filter((m) => applied.has(m.filename) && applied.get(m.filename) !== m.sha256);
    if (changed.length > 0) {
      throw new Error(
        `applied migrations have been edited: ${changed.map((m) => m.filename).join(', ')}\n` +
          'The database and the file now describe different schemas. Write a new migration; ' +
          'never edit one that has run.',
      );
    }

    const pending = all.filter((m) => !applied.has(m.filename));

    if (opts.statusOnly) {
      for (const m of all) {
        console.log(`${applied.has(m.filename) ? 'applied ' : 'PENDING '} ${m.filename}`);
      }
      console.log(`\n${applied.size} applied, ${pending.length} pending`);
      return;
    }

    if (pending.length === 0) {
      console.log('nothing to apply');
      return;
    }

    for (const m of pending) {
      // One transaction: the DDL and the fact that it ran are the same commit.
      await client.query('BEGIN');
      try {
        // A migration that seeds an audited table is a write like any other, so it names an
        // actor. Set before the SQL runs, because 0001 creates the trigger that requires it.
        await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:migration']);
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)', [
          m.filename,
          m.sha256,
        ]);
        await client.query('COMMIT');
        console.log(`applied  ${m.filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${m.filename} failed and was rolled back: ${String(err)}`);
      }
    }
    console.log(`\n${pending.length} applied`);
  } finally {
    await client.end();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop()!);
if (invokedDirectly) {
  migrate({ statusOnly: process.argv.includes('--status') }).catch((err: unknown) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  });
}
