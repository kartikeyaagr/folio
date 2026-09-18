/**
 * The date-of-the-call regression: `promoteTranscript` used to omit `written_at` entirely, so every
 * transcript took the `document_versions` column's `now()` default — the moment it was ingested,
 * not the date of the call. `pendingAttachments` is the other half: it is what resolves that date
 * from the linking filing before promotion ever sees it.
 *
 * No real PDF on disk: `pdfText` (unpdf/pdf.js) is exercised nowhere here on purpose — both
 * functions under test take already-extracted text, so the regression is caught without needing a
 * byte-valid PDF fixture.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serviceTxn } from '../db.ts';
import { pendingAttachments, promoteTranscript, writeExtracted, type Row } from './extract.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_extract_${process.pid}`;
const CO = 'c1';

const LONG_TEXT = 'the auditor raised a going-concern note and management pushed back. '.repeat(80);

before(async () => {
  await createTestDatabase(DB);

  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1,'PRAJIND','Praj Industries Limited')", [CO]);
  });
});

after(async () => {
  await dropTestDatabase(DB);
});

test('a transcript promoted from an attachment whose filing has a known announced_at gets that date, not now()', async () => {
  await serviceTxn('system:ingest', async (c) => {
    // documents.from_attachment references attachments(sha256); promoteTranscript itself never
    // writes this row, extractPending's caller does.
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, extracted_text, added_by)
       VALUES ('sha_with_filing', $1, 'PRAJIND_21102022153139_Transcript.pdf', 'application/pdf', 100,
               'transcript', 'placeholder', 'system:ingest')`,
      [CO],
    );
    const row: Row = {
      sha256: 'sha_with_filing',
      company_id: CO,
      filename: 'PRAJIND_21102022153139_Transcript.pdf',
      kind: 'transcript',
      announced_at: '2022-10-21T09:31:39Z',
    };
    await promoteTranscript(c, row, LONG_TEXT);

    const { rows } = await c.query<{ written_at: Date }>(
      `SELECT v.written_at FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE d.from_attachment = $1`,
      [row.sha256],
    );
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0]!.written_at.toISOString(),
      '2022-10-21T09:31:39.000Z',
      'the version must carry the date of the call, not the date it was promoted',
    );
  });
});

test('an attachment with no linking filing falls back to now(), not a silently wrong date', async () => {
  // Captured before the transaction opens: Postgres's now() is fixed at BEGIN, which runs before
  // this callback does, so a startedAt taken inside it can read later than the row it is checking.
  const startedAt = Date.now();
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, extracted_text, added_by)
       VALUES ('sha_no_filing', $1, 'imported.pdf', 'application/pdf', 100, 'transcript', 'placeholder', 'system:ingest')`,
      [CO],
    );
    const row: Row = {
      sha256: 'sha_no_filing',
      company_id: CO,
      filename: 'imported.pdf',
      kind: 'transcript',
      announced_at: null,
    };
    await promoteTranscript(c, row, LONG_TEXT);

    const { rows } = await c.query<{ written_at: Date }>(
      `SELECT v.written_at FROM document_versions v
         JOIN documents d ON d.id = v.document_id
        WHERE d.from_attachment = $1`,
      [row.sha256],
    );
    assert.equal(rows.length, 1);
    assert.ok(
      rows[0]!.written_at.getTime() >= startedAt,
      'with no filing to carry a true date, the honest fallback is now(), not an arbitrary or null date',
    );
  });
});

test('pendingAttachments resolves the queue date from the linking filing, most recently announced wins', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('sha_queued', $1, 'PRAJIND_30052023153904_Transcript.pdf', 'application/pdf', 100, 'transcript', 'system:ingest')`,
      [CO],
    );
    // Filed under two announcements, the shape register.ts's ATTACHMENTS_SELECT already handles —
    // the later one must win, exercising the same DISTINCT ON tie-break this query reuses.
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, attachment_sha256)
       VALUES ('fil_early', $1, 'PRAJIND', 'Press Release', '2023-05-25T10:00:00Z', 'sha_queued')`,
      [CO],
    );
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, attachment_sha256)
       VALUES ('fil_late', $1, 'PRAJIND', 'Press Release', '2023-05-30T15:39:04Z', 'sha_queued')`,
      [CO],
    );

    const rows = await pendingAttachments(c, 100);
    const queued = rows.find((r) => r.sha256 === 'sha_queued');
    assert.ok(queued, 'an attachment with no extracted text yet must be in the queue');
    assert.equal(
      queued!.announced_at && new Date(queued!.announced_at).toISOString(),
      '2023-05-30T15:39:04.000Z',
      'the most recently announced filing wins when one attachment backs two announcements',
    );
  });
});

test('a row whose write fails does not poison the next row\'s write, and is counted apart', async () => {
  // The class of bug the NUL-byte fix cured only one instance of: extractPending's per-row DB work
  // (writeExtracted) used to sit outside any try/catch, so a rejected write took the whole sweep
  // down with it, not just its own row — confirmed live on an AERON annual report whose text layer
  // carried a NUL. pdfText() now strips that specific byte before writeExtracted ever sees it, so a
  // NUL byte can no longer reach this test's target; a company_id that references no row is a
  // different Postgres-rejected write (documents_company_id_fkey, thrown from promoteTranscript's
  // INSERT), reaching the same previously-unguarded code path without it.
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('sha_bad_write', $1, 'BAD_2025.pdf', 'application/pdf', 100, 'transcript', 'system:ingest')`,
      [CO],
    );
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('sha_good_write', $1, 'GOOD_2025.pdf', 'application/pdf', 100, 'transcript', 'system:ingest')`,
      [CO],
    );
  });

  const badRow: Row = {
    sha256: 'sha_bad_write',
    company_id: 'company_that_does_not_exist', // violates documents_company_id_fkey
    filename: 'BAD_2025.pdf',
    kind: 'transcript',
    announced_at: null,
  };
  const goodRow: Row = {
    sha256: 'sha_good_write',
    company_id: CO,
    filename: 'GOOD_2025.pdf',
    kind: 'transcript',
    announced_at: null,
  };

  await assert.rejects(
    () => writeExtracted(badRow, LONG_TEXT),
    /violates foreign key constraint/,
    'a row naming a company that does not exist must fail loudly, not be silently dropped',
  );

  // The load-bearing assertion: if the failed call above had left a poisoned shared transaction (or
  // any other state) behind, this call would fail too — Postgres refuses every further statement on
  // an aborted transaction until it sees a ROLLBACK. It succeeds, because writeExtracted opens its
  // own serviceTxn per call and shares nothing across rows — extractPending needs no SAVEPOINT for
  // this reason, unlike lib/retrieval/index.ts's drain(), which shares one serviceTxn across its
  // whole batch and does need one.
  const made = await writeExtracted(goodRow, LONG_TEXT);
  assert.equal(made, true, 'the row behind the failed one must still be written and promoted');

  await serviceTxn('system:ingest', async (c) => {
    const { rows: bad } = await c.query('SELECT extracted_text FROM attachments WHERE sha256 = $1', [
      'sha_bad_write',
    ]);
    assert.equal(
      bad[0]!.extracted_text,
      null,
      "the bad row's UPDATE must have rolled back along with its failed INSERT — an all-or-nothing " +
        'failure, not a half-written row',
    );

    const { rows: good } = await c.query('SELECT extracted_text FROM attachments WHERE sha256 = $1', [
      'sha_good_write',
    ]);
    assert.equal(good[0]!.extracted_text, LONG_TEXT);
  });
});

test('pendingAttachments leaves announced_at null for an attachment with no filing at all', async () => {
  await serviceTxn('system:ingest', async (c) => {
    // An imported PDF, or one dragged into the import dialog: attachments carry no filings row.
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('sha_orphan', $1, 'AR_2025.pdf', 'application/pdf', 100, 'annual_report', 'system:ingest')`,
      [CO],
    );
    const rows = await pendingAttachments(c, 100);
    const orphan = rows.find((r) => r.sha256 === 'sha_orphan');
    assert.ok(orphan, 'an attachment with no filings row must still be queued for extraction');
    assert.equal(orphan!.announced_at, null);
  });
});
