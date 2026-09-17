import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from '../db/migrate.ts';
import { closePool, serviceTxn, writeTxn } from './db.ts';
import { pathFor } from './ingest/attachments.ts';
import {
  documentsFor,
  keepUploadAsAttachment,
} from './workspace.ts';

const DB = `trisula_workspace_${process.pid}`;
const CO = 'c1'; // Aeron Composite Limited — one of the two names this path exists for
const ME = 'p1';

// The five-byte magic number is all `keepUploadAsAttachment` looks at, so a short fixture is
// enough — same reason `lib/import/index.ts`'s own PDF branch is tested without a real PDF.
const PDF = Buffer.from('%PDF-1.4\nfake, just needs the magic number for this test\n');

let attachDir: string;

before(async () => {
  attachDir = mkdtempSync(join(tmpdir(), 'trisula-workspace-test-'));
  process.env['ATTACHMENT_DIR'] = attachDir;

  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  await migrate();

  await serviceTxn('system:auth', async (c) => {
    await c.query("INSERT INTO actors (id, kind, label) VALUES ($1, 'person', 'Tester')", [ME]);
    await c.query("INSERT INTO users (id, email, name) VALUES ($1, 't@x.com', 'Tester')", [ME]);
  });
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      "INSERT INTO companies (id, symbol, name) VALUES ($1,'AERON','Aeron Composite Limited')",
      [CO],
    );
  });
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
  rmSync(attachDir, { recursive: true, force: true });
});

test('an imported PDF is kept as an attachment, so it can be searched', async () => {
  // Zero human uploads exist in the corpus to date. The import path stores a document and throws
  // the bytes away, so an imported annual report or DRHP was never retrievable as a source.
  await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: CO, kind: 'annual_report', filename: 'AERON_RHP.pdf', bytes: PDF, actorId: ME,
    }),
  );
  const { rows } = await writeTxn(ME, (c) =>
    c.query(`SELECT kind, company_id FROM attachments WHERE filename = 'AERON_RHP.pdf'`),
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'annual_report');
  assert.equal(rows[0].company_id, CO);
});

test('the returned sha256 is the content hash, and the bytes actually land on disk under it', async () => {
  // "Made to work" means more than a row in the table — the download route
  // (app/api/attachment/[sha]/route.ts) reads the file back from exactly this path.
  const sha = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: CO, kind: 'other', filename: 'note.pdf', bytes: PDF, actorId: ME,
    }),
  );
  assert.equal(sha, createHash('sha256').update(PDF).digest('hex'));
  assert.deepEqual(await readFile(pathFor(sha)), PDF);
});

test('a PDF is recognised by its magic number, not its filename', async () => {
  // `lib/ingest/extract.ts`'s pendingAttachments only ever looks at media_type LIKE '%pdf%' to
  // decide what to extract text from — get this wrong and the row sits stored but never becomes
  // searchable, which is the whole failure this task exists to close.
  const sha = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: CO, kind: 'other', filename: 'a_report.bin', bytes: PDF, actorId: ME,
    }),
  );
  const { rows } = await writeTxn(ME, (c) =>
    c.query('SELECT media_type FROM attachments WHERE sha256 = $1', [sha]),
  );
  assert.equal(rows[0].media_type, 'application/pdf');
});

test('a non-PDF upload is kept too, honestly labelled as unclassified', async () => {
  const bytes = Buffer.from('just a plain text broker note, not a PDF at all');
  const sha = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: null, kind: 'other', filename: 'scribble.txt', bytes, actorId: ME,
    }),
  );
  const { rows } = await writeTxn(ME, (c) =>
    c.query('SELECT media_type, company_id FROM attachments WHERE sha256 = $1', [sha]),
  );
  assert.equal(rows[0].media_type, 'application/octet-stream');
  assert.equal(rows[0].company_id, null, 'an upload need not be tied to a company');
});

test('the same bytes kept twice is one row, not two — content-addressing, not a filename key', async () => {
  const bytes = Buffer.from('%PDF-1.4\nseen once, then imported again under a different name\n');
  const first = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: CO, kind: 'annual_report', filename: 'first_name.pdf', bytes, actorId: ME,
    }),
  );
  const second = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, {
      companyId: CO, kind: 'other', filename: 'second_name.pdf', bytes, actorId: ME,
    }),
  );
  assert.equal(first, second);
  const { rows } = await writeTxn(ME, (c) =>
    c.query('SELECT count(*)::int AS n, min(filename) AS filename FROM attachments WHERE sha256 = $1', [first]),
  );
  // ON CONFLICT DO NOTHING: the row that already existed wins, the same rule fetchAttachments
  // (lib/ingest/attachments.ts) relies on for a document filed twice under different announcements.
  assert.equal(rows[0].n, 1);
  assert.equal(rows[0].filename, 'first_name.pdf');
});

/**
 * The date a document carries, against the moment its row was last touched.
 *
 * `0042` made `promoteTranscript` stamp the linking filing's `announced_at`, so a 2022 transcript
 * is dated 2022 — but every list read `documents.updated_at`, which the backfill moves whenever it
 * re-promotes one. On 17-Sep-2026 all 35 transcripts showed today's timestamp and sorted by nothing.
 */
test('a document is dated and ordered by the version it carries, not by when its row moved', async () => {
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by, from_attachment)
       VALUES ('d_old',$1,'Transcript','transcript','system:ingest',NULL)`, [CO]);
    await c.query(
      `INSERT INTO document_versions (document_id, body, written_by, written_at)
       VALUES ('d_old',$1,'system:ingest','2022-02-21T19:04:00+05:30')`,
      [JSON.stringify({ text: 'the call' })]);
    // Touched after the old one, which is what used to decide the order.
    await c.query("UPDATE documents SET updated_at = now() WHERE id = 'd_old'");

    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_new',$1,'A note','note','system:index')`, [CO]);
    await c.query(
      `INSERT INTO document_versions (document_id, body, written_by, written_at)
       VALUES ('d_new',$1,'system:index','2026-09-16T12:00:00+05:30')`,
      [JSON.stringify({ text: 'written later' })]);
    await c.query("UPDATE documents SET updated_at = now() - interval '1 hour' WHERE id = 'd_new'");
  });

  const docs = await documentsFor(CO);
  const old = docs.find((d) => d.id === 'd_old')!;
  assert.equal(old.documentDate.getFullYear(), 2022, 'the date of the call, not of the ingest');

  const order = docs.map((d) => d.id);
  assert.ok(
    order.indexOf('d_new') < order.indexOf('d_old'),
    'newest first means newest by the date it carries; updated_at would invert these',
  );
});
