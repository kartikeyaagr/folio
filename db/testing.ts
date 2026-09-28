/**
 * A database of a test file's own.
 *
 * Thirty-seven test files opened with a verbatim copy of createdb → point `DATABASE_URL` at it →
 * `migrate()`, and closed with a byte-identical drop. Two things made that worth collapsing.
 *
 * The first is ordering. `dropdb` fails while a connection is still open, so `closePool()` has to
 * come first — and nothing said so except thirty-six files happening to do it. A new test file
 * getting it backwards leaves a stray database behind and reports an error about the drop rather
 * than about the pool.
 *
 * The second is that `createdb` was called without first dropping. These names carry the pid
 * (`folio_admin_${process.pid}`), pids are reused, and a run that crashed before its `after`
 * leaves the database behind — so the next run to draw that pid fails at startup on something
 * that is not its fault.
 *
 * Deliberately not `pg-mem` or `testcontainers`. This suite uses pgvector, `FOR UPDATE SKIP
 * LOCKED`, `websearch_to_tsquery`, generated columns and triggers that RAISE on an unattributed
 * write — most of what it tests is the part an in-memory emulation does not have. And
 * `testcontainers` wants a Docker daemon where this needs only `createdb` on PATH.
 */

import { execFileSync } from 'node:child_process';

import { closePool } from '../lib/db.ts';
import { migrate } from './migrate.ts';

/** Create it, point `DATABASE_URL` at it, and bring the schema up. */
export async function createTestDatabase(name: string): Promise<void> {
  execFileSync('dropdb', ['--if-exists', name]);
  execFileSync('createdb', [name]);
  process.env.DATABASE_URL = `postgres:///${name}`;
  await migrate();
}

/** Close the pool, then drop it. Always that order. */
export async function dropTestDatabase(name: string): Promise<void> {
  await closePool();
  execFileSync('dropdb', ['--if-exists', name]);
}
