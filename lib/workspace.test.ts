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
import { readUpload } from './import/index.ts';
import { bodyOf, sheetsOf } from './sheet/book.ts';
import { display } from './sheet/format.ts';
import { evaluateWorkbook } from './sheet/evaluate.ts';
import {
  archiveDocument, createDocument, deleteDocument, getDocument, keepUploadAsAttachment,
  NoSuchDocument, revisionsOf, saveDocument,
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

// ---- a workbook, all the way through -----------------------------------------------------------

test('an uploaded workbook is one document, and its tabs still read each other afterwards', async () => {
  // The whole change, end to end and through Postgres: the bytes a person drags in, the row that is
  // written, the row that is read back, and the arithmetic that comes out of it. Each half of this
  // is covered on its own elsewhere; what this pins is that they join up — a workbook that imports
  // correctly and then loses its tabs on the way into `document_versions` is no better than one
  // that never imported.
  const bytes = await readFile(new URL('./import/__fixtures__/linked.xlsx', import.meta.url));
  const read = await readUpload('linked.xlsx', bytes);
  assert.equal(read.kind, 'sheet');
  if (read.kind !== 'sheet') return;

  const id = await createDocument({ title: 'linked', kind: 'sheet', companyId: CO }, ME);
  await saveDocument(id, bodyOf(read.sheets.map((s) => ({ name: s.name, cells: s.cells }))), ME);

  const doc = await getDocument(id);
  assert.ok(doc);
  const sheets = sheetsOf(doc!.body);
  assert.deepEqual(sheets.map((s) => s.name), ['Model', 'Inputs', 'Q1 FY26'], 'one document, three tabs');

  // The formula survived the round trip as a formula, not as the number Excel last showed.
  assert.equal(sheets[0]!.cells['B1'], '=Inputs!B2*(1+Inputs!B1)');

  const values = evaluateWorkbook({ sheets });
  assert.equal(values[0]!['B1'], 1120, 'it still reads the Inputs tab after a round trip');
  assert.equal(values[0]!['B2'], 1000.12);
  assert.equal(values[0]!['B3'], 84);
});

test('a new spreadsheet is born with one named tab, never the older single-grid body', async () => {
  const id = await createDocument({ title: 'blank', kind: 'sheet', companyId: CO }, ME);
  const doc = await getDocument(id);
  assert.deepEqual(doc!.body, { sheets: [{ name: 'Sheet1', cells: {} }] });
});

test('a version saved under the older single-grid shape still opens', async () => {
  // There are rows like this in the table and nothing rewrites them — a version row is the record
  // of what somebody saved, not a place to tidy. It has to keep opening, forever.
  const id = await createDocument({ title: 'legacy', kind: 'sheet', companyId: CO }, ME);
  await saveDocument(id, { cells: { A1: 'Revenue', B1: '693.2', B2: '=B1*2' } }, ME);

  const doc = await getDocument(id);
  const sheets = sheetsOf(doc!.body);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0]!.name, 'Sheet1');
  assert.equal(evaluateWorkbook({ sheets })[0]!['B2'], 1386.4);
});

// ---- deleting one for good -----------------------------------------------------------------------

/** A registered source and one chunk for it, as the indexer would have left them. */
async function pretendIndexed(docId: string): Promise<void> {
  await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sources (kind, ref_id, company_id, title, content_hash, indexed_at)
       VALUES ('document_version', $1, $2, 'indexed', 'hash', now()) RETURNING id`,
      [docId, CO],
    );
    await c.query(
      `INSERT INTO chunks (source_id, company_id, ord, text, char_from, char_to)
       VALUES ($1, $2, 0, 'Revenue\t693.2', 0, 12)`,
      [rows[0]!.id, CO],
    );
  });
}

const countOf = async (sql: string, params: unknown[]): Promise<number> => {
  const { rows } = await serviceTxn('system:index', (c) => c.query<{ n: number }>(sql, params));
  return rows[0]!.n;
};

test('deleting a document takes its versions and its place in search with it', async () => {
  // `sources` has no foreign key to `documents` — it is keyed (kind, ref_id) across five unrelated
  // kinds — so nothing removes it on its own. reap.ts would catch it on its next run, but "its next
  // run" is a window in which a deleted document is still answering questions.
  const id = await createDocument({ title: 'wrong import', kind: 'sheet', companyId: CO }, ME);
  await saveDocument(id, { cells: { A1: 'one' } }, ME);
  await saveDocument(id, { cells: { A1: 'two' } }, ME);
  await pretendIndexed(id);
  assert.equal((await revisionsOf(id)).length, 3, 'the create plus two saves');

  await deleteDocument(id, ME);

  assert.equal(await getDocument(id), null);
  assert.equal(await countOf('SELECT count(*)::int AS n FROM document_versions WHERE document_id = $1', [id]), 0);
  assert.equal(
    await countOf("SELECT count(*)::int AS n FROM sources WHERE kind = 'document_version' AND ref_id = $1", [id]),
    0,
    'out of search in the same transaction it leaves the table',
  );
  assert.equal(
    await countOf("SELECT count(*)::int AS n FROM chunks c JOIN sources s ON s.id = c.source_id WHERE s.ref_id = $1", [id]),
    0,
    'and its chunks with it, cascading from sources.id',
  );
});

test('deleting a document leaves the file it was imported from', async () => {
  // `attachments` is content-addressed, so the same bytes uploaded twice are one row that more than
  // one document may point at. Removing it here could empty a document nobody asked about.
  const bytes = Buffer.from('%PDF-1.4\nthe original, which outlives the reading of it\n');
  const sha = await writeTxn(ME, (c) =>
    keepUploadAsAttachment(c, { companyId: CO, kind: 'other', filename: 'keep.pdf', bytes, actorId: ME }),
  );
  const id = await createDocument({ title: 'a reading', kind: 'note', companyId: CO }, ME);
  await writeTxn(ME, (c) => c.query('UPDATE documents SET from_attachment = $2 WHERE id = $1', [id, sha]));

  await deleteDocument(id, ME);

  assert.equal(await countOf('SELECT count(*)::int AS n FROM attachments WHERE sha256 = $1', [sha]), 1);
});

test('deleting something that is already gone says so rather than pretending', async () => {
  await assert.rejects(() => deleteDocument('no_such_document', ME), NoSuchDocument);
});

test('archiving still does not delete, which is the whole reason both exist', async () => {
  const id = await createDocument({ title: 'kept', kind: 'note', companyId: CO }, ME);
  await archiveDocument(id, ME);
  const doc = await getDocument(id);
  assert.ok(doc, 'archived is still there');
  assert.ok(doc!.archivedAt, 'and marked as archived');
});

test('a format survives a save, and a tab keeps it through an edit', async () => {
  // Formatting is stored beside the cells and read back by the same codec. What this pins beyond
  // the round trip is that `formats` is a sibling of `cells` rather than something folded into it:
  // the evaluator, the data functions and the chunker all read `cells` and none of them can see a
  // format, which is what makes formatting safe to add to a model.
  const id = await createDocument({ title: 'formatted', kind: 'sheet', companyId: CO }, ME);
  await saveDocument(id, bodyOf([{
    name: 'Model',
    cells: { A1: 'Revenue', B1: '2585.94', B2: '=B1*2' },
    formats: { A1: { bold: true }, B1: { style: 'inr', dp: 0 }, B2: { ink: 'red', align: 'right' } },
  }]), ME);

  const sheets = sheetsOf((await getDocument(id))!.body);
  assert.equal(sheets.length, 1);
  assert.deepEqual(sheets[0]!.formats['A1'], { bold: true });
  assert.deepEqual(sheets[0]!.formats['B1'], { style: 'inr', dp: 0 });

  // The value is untouched by the format; only the rendering of it changes.
  assert.equal(sheets[0]!.cells['B1'], '2585.94');
  assert.equal(display(2585.94, sheets[0]!.formats['B1']), '₹2,586');
});

test('a workbook nobody has formatted stores no formats key at all', async () => {
  // So the diff in the version history stays about the numbers rather than about an empty object
  // turning up on every save of every sheet that has ever existed.
  const body = bodyOf([{ name: 'Model', cells: { A1: '1' }, formats: {} }]);
  assert.deepEqual(body.sheets[0], { name: 'Model', cells: { A1: '1' } });
});
