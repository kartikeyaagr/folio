/**
 * That a save announces itself, and that the announcement is cheap.
 *
 * The re-embedding half of this was always right — `content_hash` clears `indexed_at` only when the
 * text actually moved, and `indexOne` deletes before it writes. What was missing was anything
 * telling the indexer to look. Migration `0052` adds a statement-level trigger; these assert the
 * three properties the design rests on.
 *
 * **`listen` opens a real connection, not a pooled one**, which is the thing under test as much as
 * the trigger is: a `LISTEN` on a pooled client survives only until the next caller borrows it.
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { migrate } from '../../db/migrate.ts';
import { closePool, listen, serviceTxn, writeTxn } from '../db.ts';

const DB = `trisula_notify_${process.pid}`;
const ME = 'p1';
const CO = 'c1';

let heard = 0;
let stop: (() => Promise<void>) | undefined;

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();
  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id,kind,label) VALUES ($1,'person','T')", [ME]);
    await c.query("INSERT INTO users (id,email,name) VALUES ($1,'t@x.com','T')", [ME]);
    await c.query("INSERT INTO companies (id,symbol,name) VALUES ($1,'TEGA','Tega')", [CO]);
  });
  stop = await listen('trisula_content', () => { heard++; });
});

after(async () => {
  await stop?.();
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

beforeEach(() => { heard = 0; });

/** Notifications are delivered after COMMIT, on the socket. Give it a moment to arrive. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 250));

test('the three tables that feed the content store all announce a change', async () => {
  const rows = await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ table: string; level: string }>(
      `SELECT tgrelid::regclass::text AS table,
              CASE tgtype & 1 WHEN 1 THEN 'ROW' ELSE 'STATEMENT' END AS level
         FROM pg_trigger WHERE tgname = 'notify_content' ORDER BY 1`);
    return rows;
  });
  assert.deepEqual(rows.map((r) => r.table), ['attachments', 'document_versions', 'documents']);
  // STATEMENT, not ROW: a 900-row bulk insert should wake the listener once. The audit trigger on
  // these same tables is per row because it records *what* changed; this only says that something
  // did, so per row would be 900 identical wake-ups for one pass of work.
  for (const r of rows) assert.equal(r.level, 'STATEMENT', `${r.table} announces per statement`);
});

test('saving a document is heard', async () => {
  await writeTxn(ME, async (c) => {
    await c.query(
      "INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ('d1',$1,'A note','note',$2)",
      [CO, ME]);
  });
  await settle();
  assert.ok(heard > 0, 'a committed save reaches the listener');
});

test('a rolled-back save is never heard', async () => {
  // The whole reason this is a trigger and not a call in the save path: a notification sent by
  // application code before the commit wakes a worker that then finds nothing, and one sent for a
  // transaction that rolls back is a lie. Postgres queues the notify until COMMIT.
  await writeTxn(ME, async (c) => {
    await c.query(
      "INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ('d2',$1,'Doomed','note',$2)",
      [CO, ME]);
    throw new Error('rolled back on purpose');
  }).catch(() => { /* expected */ });
  await settle();
  assert.equal(heard, 0, 'nothing committed, so nothing announced');
});

test('importing a many-tab workbook wakes the indexer once, not once per tab', async () => {
  // Postgres collapses duplicate (channel, payload) pairs inside one transaction, which is the
  // entire reason the payload is a constant string. An eleven-tab workbook is eleven documents and
  // eleven versions in one transaction — twenty-two statements, one notification.
  await writeTxn(ME, async (c) => {
    for (let i = 0; i < 11; i++) {
      await c.query(
        'INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ($1,$2,$3,$4,$5)',
        [`tab${i}`, CO, `Workbook — tab ${i}`, 'sheet', ME]);
      await c.query(
        'INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,$3)',
        [`tab${i}`, JSON.stringify({ cells: { A1: `tab ${i}` } }), ME]);
    }
  });
  await settle();
  assert.equal(heard, 1, `22 statements in one transaction, one notification (heard ${heard})`);
});

test('an attachment gaining its text layer is heard, because that is when it becomes indexable', async () => {
  // The half that is easy to miss. An uploaded PDF is not indexable when it lands — `sources`
  // requires extracted text — so the INSERT is not the interesting event. The later UPDATE that
  // writes `extracted_text` is, and it is an UPDATE to the same table, so the same trigger covers
  // it without anybody having to remember a second rule.
  await writeTxn(ME, (c) => c.query(
    `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
     VALUES ('abc',$1,'r.pdf','application/pdf',10,'other',$2)`, [CO, ME]));
  await settle();
  heard = 0;

  await serviceTxn('system:ingest', (c) =>
    c.query("UPDATE attachments SET extracted_text = 'the text layer' WHERE sha256 = 'abc'"));
  await settle();
  assert.ok(heard > 0, 'extraction is what makes it eligible, and it announces');
});
