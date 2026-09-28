/**
 * One copy in the corpus, and why each of the two rules is not the other.
 *
 * Content-addressing already stops the same bytes being stored twice, and
 * `register.test.ts` already proves the filing fan-out cannot register one attachment twice. Both
 * of those are about identity of BYTES. These are the two cases where the bytes differ and the
 * document does not, which is what a reader means by a duplicate:
 *
 *   1. A transcript's words live in `attachments.extracted_text` AND in the `documents` row
 *      `extractPending` promotes so agent 2 has a queue. Two sources, one call — 35 documents and
 *      2,063 duplicate chunks on the live corpus, 17-Sep-2026.
 *   2. A company re-files a corrected PDF: new signature, new timestamp, same words, different sha.
 *      TCL did it twice, once nine minutes apart.
 *
 * Its own file rather than four more tests in `register.test.ts`, which shares one database across
 * fourteen sequential tests that assert on exact source counts — a new attachment inserted into
 * that fixture changes the arithmetic of tests written months ago.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';
import { readTxn, serviceTxn } from '../db.ts';
import { registerAll } from './register.ts';

const DB = `folio_dedupe_${process.pid}`;
const CO = 'c1';
const WORDS = 'Management guided to a mid-teens margin for the full year. '.repeat(40);

before(async () => {
  await createTestDatabase(DB);
});

after(async () => {
  await dropTestDatabase(DB);
});

beforeEach(async () => {
  await serviceTxn('system:index', async (c) => {
    await c.query('DELETE FROM sources');
    await c.query('DELETE FROM document_versions');
    await c.query('DELETE FROM documents');
    await c.query('DELETE FROM filings');
    await c.query('DELETE FROM attachments');
    await c.query('DELETE FROM companies');
    await c.query(
      "INSERT INTO companies (id, symbol, name) VALUES ($1,'TCL','Thaai Casting Limited')", [CO]);
  });
});

const attach = (sha: string, filename: string, text: string): Promise<void> =>
  serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind,
                                extracted_text, added_by)
       VALUES ($1,$2,$3,'application/pdf',100,'transcript',$4,'system:ingest')`,
      [sha, CO, filename, text],
    );
  });

const fileIt = (id: string, sha: string, on: string): Promise<void> =>
  serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, attachment_url,
                            attachment_sha256, summary)
       VALUES ($1,$2,'TCL','Outcome',$3::timestamptz,'http://x/'||$1,$4,'Board outcome')`,
      [id, CO, on, sha],
    );
  });

const sources = (): Promise<{ kind: string; ref_id: string }[]> =>
  readTxn(async (c) =>
    (await c.query<{ kind: string; ref_id: string }>(
      'SELECT kind, ref_id FROM sources ORDER BY kind, ref_id')).rows);

// ------------------------------------------------------------------------------------------------

test('a transcript promoted from an attachment is indexed once, as the attachment', async () => {
  await attach('sha_call', 'TCL_Transcript.pdf', WORDS);
  await fileIt('f1', 'sha_call', '2026-06-03');
  // What extractPending writes: the same words again, as a document, so agent 2 has a queue.
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by, from_attachment)
       VALUES ('d1',$1,'Transcript','transcript','system:ingest','sha_call')`, [CO]);
    await c.query(
      `INSERT INTO document_versions (document_id, body, written_by)
       VALUES ('d1',$1,'system:ingest')`, [JSON.stringify({ text: WORDS })]);
  });

  await serviceTxn('system:index', (c) => registerAll(c));

  const rows = await sources();
  assert.deepEqual(
    rows.filter((r) => r.kind === 'document_version'),
    [],
    'the document carries no text of its own; the attachment it came from is the copy',
  );
  assert.deepEqual(
    rows.filter((r) => r.kind === 'attachment').map((r) => r.ref_id),
    ['sha_call'],
    'and the attachment is indexed, because the PDF behind it is what a passage can be checked against',
  );
});

test('a document written here is still indexed', async () => {
  await serviceTxn('system:index', async (c) => {
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d2',$1,'Meeting with the CFO','meeting','system:index')`, [CO]);
    await c.query(
      `INSERT INTO document_versions (document_id, body, written_by)
       VALUES ('d2',$1,'system:index')`, [JSON.stringify({ text: WORDS })]);
  });

  await serviceTxn('system:index', (c) => registerAll(c));

  assert.deepEqual(
    (await sources()).filter((r) => r.kind === 'document_version').map((r) => r.ref_id),
    ['d2'],
    'the exclusion is from_attachment, not kind — a note nobody extracted is the corpus s own',
  );
});

test('a re-filed PDF with the same words is indexed once, keeping the first filing', async () => {
  // TCL's 12-Nov board outcome, filed at 19:20 and again at 19:25 with a fresh signature.
  await attach('sha_first', 'THAAI_12112025192048_OUTCOME.pdf', WORDS);
  await attach('sha_again', 'THAAI_12112025192545_OUTCOME.pdf', WORDS);
  await fileIt('f1', 'sha_first', '2025-11-12T19:20:48+05:30');
  await fileIt('f2', 'sha_again', '2025-11-12T19:25:45+05:30');

  await serviceTxn('system:index', (c) => registerAll(c));

  assert.deepEqual(
    (await sources()).filter((r) => r.kind === 'attachment').map((r) => r.ref_id),
    ['sha_first'],
    'the earliest filing is when the document was released; a correction does not move that',
  );
});

test('two documents that merely share a company are both indexed', async () => {
  await attach('sha_a', 'A.pdf', `${WORDS} and then something about capex.`);
  await attach('sha_b', 'B.pdf', `${WORDS} and then something about the order book.`);
  await fileIt('f1', 'sha_a', '2026-01-01');
  await fileIt('f2', 'sha_b', '2026-01-02');

  await serviceTxn('system:index', (c) => registerAll(c));

  assert.deepEqual(
    (await sources()).filter((r) => r.kind === 'attachment').map((r) => r.ref_id).sort(),
    ['sha_a', 'sha_b'],
    'dedup is on the words, not on the company — collapsing these would lose a real document',
  );
});

test('the retraction runs on the same rule: a duplicate already in the corpus leaves', async () => {
  await attach('sha_first', 'first.pdf', WORDS);
  await fileIt('f1', 'sha_first', '2025-11-12T19:20:48+05:30');
  await serviceTxn('system:index', (c) => registerAll(c));
  assert.equal((await sources()).length, 2, 'the attachment and its filing');

  // The correction arrives afterwards and is EARLIER than nothing — it loses, and the already
  // registered winner stays. Then the winner is withdrawn, and the loser takes over rather than
  // the company losing the document altogether.
  await attach('sha_again', 'again.pdf', WORDS);
  await fileIt('f2', 'sha_again', '2025-11-12T19:25:45+05:30');
  await serviceTxn('system:index', (c) => registerAll(c));
  assert.deepEqual(
    (await sources()).filter((r) => r.kind === 'attachment').map((r) => r.ref_id),
    ['sha_first'],
  );

  await serviceTxn('system:index', async (c) => {
    await c.query("UPDATE filings SET attachment_sha256 = NULL WHERE id = 'f1'");
    await c.query("DELETE FROM attachments WHERE sha256 = 'sha_first'");
  });
  await serviceTxn('system:index', (c) => registerAll(c));
  assert.deepEqual(
    (await sources()).filter((r) => r.kind === 'attachment').map((r) => r.ref_id),
    ['sha_again'],
    'reap retracts the gone copy and the surviving one is admitted in its place',
  );
});
