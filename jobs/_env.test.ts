/**
 * `.env.local` reaches every job, and never over a value that is already set.
 *
 * The second half is the one that matters on the VM. There, systemd sets the environment from
 * `/etc/folio/folio.env`, and a stray `.env.local` must not be able to repoint a job at another
 * database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fillUnset } from './_env.ts';

test('fills what is unset, and an exported value wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'folio-env-'));
  const file = join(dir, '.env.local');
  writeFileSync(file, 'DATABASE_URL=postgres:///from_file\nATTACHMENT_DIR=/from/file\n');
  const env: Record<string, string | undefined> = { DATABASE_URL: 'postgres:///exported' };
  fillUnset(file, env);
  assert.equal(env['DATABASE_URL'], 'postgres:///exported');
  assert.equal(env['ATTACHMENT_DIR'], '/from/file');
  rmSync(dir, { recursive: true, force: true });
});

test('no file is not an error, because the VM has none', () => {
  const env: Record<string, string | undefined> = {};
  fillUnset(join(tmpdir(), 'folio-env-absent', '.env.local'), env);
  assert.deepEqual(env, {});
});

test('every job imports ./_env.ts before anything else', () => {
  const dir = import.meta.dirname;
  const jobs = readdirSync(dir).filter(
    (f) => f.endsWith('.ts') && !f.startsWith('_') && !f.endsWith('.test.ts'),
  );
  // A glob that matched nothing would pass the check below vacuously.
  assert.ok(jobs.length >= 24, `found ${jobs.length} jobs`);
  const late = jobs.filter(
    (f) => readFileSync(join(dir, f), 'utf8').match(/^import .*$/m)?.[0] !== "import './_env.ts';",
  );
  assert.deepEqual(late, [], 'these jobs would not see .env.local');
});
