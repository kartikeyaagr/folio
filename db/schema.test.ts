/**
 * The attribution trigger, proven rather than asserted.
 *
 * This test builds its own database from `db/migrations` on every run. v2 shipped a suite whose
 * test database was never migrated, so it passed for the wrong reason; the only defence is to
 * build the schema from the same files production uses.
 *
 * A note on how these tests are written. The obvious version — "INSERT with no actor, expect an
 * error" — passes for the wrong reason: the foreign key on `users.id` fires *before* the AFTER
 * trigger, so the write fails without the trigger ever running. Every case below therefore uses a
 * write whose constraints are already satisfied, so the only thing that can reject it is
 * `audit_fn()`.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { migrate } from './migrate.ts';
import { toolReads } from '../lib/agents/tools/index.ts';

const DB = `trisula_test_${process.pid}`;
let client: pg.Client;

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  // A person to write as. `actors` is deliberately unaudited — otherwise the first actor could
  // never be created — but `users` is audited, so seeding it needs an actor like any other write.
  // system:auth is the principal that creates accounts.
  await client.query("INSERT INTO actors (id, kind, label) VALUES ('p1', 'person', 'Tester')");
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:auth']);
  await client.query("INSERT INTO users (id, email, name) VALUES ('p1', 't@example.com', 'Tester')");
  await client.query('COMMIT');
});

after(async () => {
  await client?.end();
  execFileSync('dropdb', ['--if-exists', DB]);
});

/** Run in a transaction with an optional actor, always rolled back. */
async function attempt(actor: string | null, sql: string): Promise<string | null> {
  await client.query('BEGIN');
  try {
    if (actor !== null) {
      await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actor]);
    }
    await client.query(sql);
    await client.query('ROLLBACK');
    return null;
  } catch (err) {
    await client.query('ROLLBACK');
    return err instanceof Error ? err.message : String(err);
  }
}

test('an unattributed UPDATE is refused', async () => {
  const err = await attempt(null, "UPDATE users SET name = 'X' WHERE id = 'p1'");
  assert.match(String(err), /unattributed write to users/);
});

test('an unattributed INSERT is refused, with the foreign key already satisfied', async () => {
  const err = await attempt(
    null,
    "INSERT INTO sessions (token_sha256, user_id, expires_at) VALUES ('t', 'p1', now())",
  );
  assert.match(String(err), /unattributed write to sessions/);
});

test('an unknown actor is refused', async () => {
  const err = await attempt('system:nope', "UPDATE users SET name = 'X' WHERE id = 'p1'");
  assert.match(String(err), /unknown actor system:nope/);
});

test('an empty actor is refused, not treated as present', async () => {
  const err = await attempt('', "UPDATE users SET name = 'X' WHERE id = 'p1'");
  assert.match(String(err), /unattributed write to users/);
});

test('an attributed write succeeds and records before and after', async () => {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'p1']);
  await client.query("UPDATE users SET name = 'Renamed' WHERE id = 'p1'");
  const { rows } = await client.query<{ actor_id: string; op: string; before: { name: string }; after: { name: string } }>(
    'SELECT actor_id, op, before, after FROM audit_log ORDER BY id DESC LIMIT 1',
  );
  await client.query('ROLLBACK');
  const row = rows[0];
  assert.ok(row, 'expected an audit row');
  assert.equal(row.actor_id, 'p1');
  assert.equal(row.op, 'UPDATE');
  assert.equal(row.before.name, 'Tester');
  assert.equal(row.after.name, 'Renamed');
});

test('every audited table carries the trigger', async () => {
  // Coverage is asserted rather than remembered: a new table that should be audited and is not
  // is the failure mode this catches, and it is silent otherwise.
  const { rows } = await client.query<{ tablename: string }>(`
    SELECT c.relname AS tablename
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      -- Each exclusion is deliberate and documented in the migration that created the table:
      -- actors and audit_log would be circular; schema_migrations is the runner's own ledger;
      -- prices is ~2,000 unchanging exchange facts a day whose provenance is ingestion_runs;
      -- ingestion_runs is that provenance table itself; news_items is a copy of somebody else's
      -- feed, written only by the poller, and one audit row per headline would be the largest
      -- table here within a month; news_matched_items is a set of item ids and nothing else;
      -- chunks is derived rows written only by the indexer, whose provenance is the sources row
      -- beside it — ~22,000 rows on a three-name book, ten times news_items, rewritten on every
      -- re-index of an edited document;
      -- chat_tool_calls is itself the audit trail of what a model read, append-only and never
      -- updated, so auditing it is the recursion audit_log is excluded for.
      AND c.relname NOT IN ('actors', 'audit_log', 'schema_migrations', 'prices', 'ingestion_runs',
                            'news_items', 'news_matched_items', 'chunks', 'chat_tool_calls')
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'audit'
      )`);
  assert.deepEqual(
    rows.map((r) => r.tablename),
    [],
    'these tables have no audit trigger; add attach_audit() in their migration',
  );
});

test('the runner refuses a migration whose bytes have changed', async () => {
  await client.query("UPDATE schema_migrations SET sha256 = 'tampered' WHERE filename LIKE '0001%'");
  await assert.rejects(() => migrate(), /applied migrations have been edited/);
});

test('the indexer principal exists in the database as well as the type', async () => {
  const { rows } = await client.query("SELECT label FROM actors WHERE id = 'system:index'");
  assert.equal(rows[0]?.label, 'Content indexer');
});

test('the desk analyst can reach every table its tools read', async () => {
  // `tools` and `data_scope` are two hand-written columns of one migration, and nothing else
  // compares them. A tool added to the first without its tables added to the second fails at
  // runtime — on a claimed run, after the queue has already spent an attempt on it — with a
  // ScopeViolation that reads like a code bug rather than the seed data it is.
  const { rows } = await client.query<{ tools: string[]; data_scope: string[] }>(
    "SELECT tools, data_scope FROM agents WHERE key = 'desk-analyst'",
  );
  const row = rows[0];
  assert.ok(row, 'agent 8 is seeded');
  const missing = toolReads(row.tools).filter((t) => !row.data_scope.includes(t));
  assert.deepEqual(missing, [], 'data_scope must name every table the declared tools read');
});

test('a source can only be registered once per referenced row', async () => {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:index']);
  await client.query(
    `INSERT INTO sources (kind, ref_id, title, content_hash) VALUES ('filing', 'f1', 't', 'h')`,
  );
  await assert.rejects(
    () => client.query(
      `INSERT INTO sources (kind, ref_id, title, content_hash) VALUES ('filing', 'f1', 't2', 'h2')`,
    ),
    /sources_identity/,
  );
  await client.query('ROLLBACK');
});

test('a chunk cannot carry an embedding without naming the model that made it', async () => {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:index']);
  const { rows } = await client.query(
    `INSERT INTO sources (kind, ref_id, title, content_hash)
     VALUES ('filing', 'f900', 'x', 'h900') RETURNING id`,
  );
  const src = rows[0].id;
  await assert.rejects(
    () => client.query(
      `INSERT INTO chunks (source_id, ord, text, char_from, char_to, embedding)
       VALUES ($1, 0, 'x', 0, 1, $2)`,
      [src, `[${Array(384).fill(0).join(',')}]`],
    ),
    /chunks_embedding_has_a_model/,
  );
  await client.query('ROLLBACK');
});

test('a chunk span must run forwards', async () => {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:index']);
  const { rows } = await client.query(
    `INSERT INTO sources (kind, ref_id, title, content_hash)
     VALUES ('filing', 'f901', 'x', 'h901') RETURNING id`,
  );
  await assert.rejects(
    () => client.query(
      `INSERT INTO chunks (source_id, ord, text, char_from, char_to)
       VALUES ($1, 0, 'x', 10, 10)`,
      [rows[0].id],
    ),
    /chunks_span_is_forward/,
  );
  await client.query('ROLLBACK');
});

test('deleting a source takes its chunks with it', async () => {
  await client.query('BEGIN');
  await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', 'system:index']);
  const { rows } = await client.query(
    `INSERT INTO sources (kind, ref_id, title, content_hash)
     VALUES ('filing', 'f902', 'x', 'h902') RETURNING id`,
  );
  const src = rows[0].id;
  await client.query(
    `INSERT INTO chunks (source_id, ord, text, char_from, char_to) VALUES ($1, 0, 'x', 0, 1)`,
    [src],
  );
  await client.query('DELETE FROM sources WHERE id = $1', [src]);
  const { rows: left } = await client.query(
    'SELECT count(*)::int AS n FROM chunks WHERE source_id = $1',
    [src],
  );
  assert.equal(left[0].n, 0);
  await client.query('ROLLBACK');
});
