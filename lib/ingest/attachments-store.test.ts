/**
 * The attachment store's two promises: it holds the bytes it says it holds, and it fetches one
 * company's documents when asked for one company's documents.
 *
 * Split from `backfill.test.ts` when that file passed the 300-line cap. The seam is real rather
 * than arithmetic — those tests are about what a backfill step *decides*, these are about what the
 * store *has* — and both are exercised against a real database because the bug in each case was in
 * a predicate, not in a branch.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { migrate } from '../../db/migrate.ts';
import { closePool, readTxn, serviceTxn } from '../db.ts';
import { clearMissingBytes, fetchAttachments, pathFor } from './attachments.ts';
import { extractPending } from './extract.ts';

const DB = `trisula_store_${process.pid}`;

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  // Its own store. The default is the VM's /var/lib/trisula/attachments, which is not writable
  // here — and a test that passes or fails on the ambient environment is not a test.
  process.env['ATTACHMENT_DIR'] = mkdtempSync(join(tmpdir(), 'trisula-store-'));
  await migrate();
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
  rmSync(process.env['ATTACHMENT_DIR'] ?? '', { recursive: true, force: true });
});

beforeEach(async () => {
  await serviceTxn('system:ingest', async (c) => {
    // In dependency order: a filing points at an attachment, and both point at a company.
    await c.query('DELETE FROM filings');
    await c.query('DELETE FROM attachments');
    await c.query('DELETE FROM companies');
    await c.query(
      `INSERT INTO companies (id, symbol, name) VALUES
         ('c1','TEGA','Tega Industries Limited'),
         ('c2','PRAJIND','Praj Industries Limited')`,
    );
  });
});

/** A closed port on loopback: refuses in microseconds, no DNS, no internet. */
const DEAD = 'http://127.0.0.1:1/t.pdf';

const filing = (id: string, company: string, url: string, sha?: string): Promise<void> =>
  serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, announced_at, attachment_url,
                            attachment_sha256)
       VALUES ($1,$2,'X','Filing', now(), $3, $4)`,
      [id, company, url, sha ?? null],
    );
  });

test('fetchAttachments narrows to one company when the backfill asks it to', async () => {
  // Unscoped, the queue is ordered `announced_at DESC` across every followed name and capped, so a
  // newly followed company — whose history is by definition the oldest material in it — sorts below
  // everyone else's backlog. Measured 17-Sep-2026: adding TEGA put 480 unfetched attachments behind
  // an existing 268, against one pass of 500, with no timer to collect the remainder.
  await filing('f1', 'c2', DEAD);

  const mine = await fetchAttachments(100, 'c1');
  assert.deepEqual(
    { pending: mine.pending, failed: mine.failed },
    { pending: 0, failed: 0 },
    "TEGA owns none of PRAJIND's filings, so its step must not even try them",
  );
  assert.equal((await fetchAttachments(100, 'c2')).pending, 1);
  assert.equal((await fetchAttachments(100)).pending, 1, 'unscoped still sees the whole desk');
});

/**
 * The repair `ops/backup.sh` makes necessary.
 *
 * The backup is `pg_dump` and nothing else, so a restore produces exactly this row: a filing with a
 * sha, an attachments row, and no bytes anywhere. `fetchAttachments` asks "which filing has no sha
 * yet", so before `clearMissingBytes` that filing was never offered again and its document was
 * unrecoverable. Found live on 17-Sep-2026 with 822 of PRAJIND's attachments in that state.
 */
test('a sha whose bytes are gone is forgotten, so the document can be fetched again', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('deadbeef', 'c1', 'TEGA_Transcript.pdf', 'application/pdf', 100, 'transcript',
               'system:ingest')`,
    );
  });
  await filing('f1', 'c1', DEAD, 'deadbeef');

  // Nothing is pending while the database believes the bytes are held.
  assert.equal((await fetchAttachments(10, 'c1')).pending, 0);

  assert.equal(await clearMissingBytes('c1'), 1);
  assert.equal(
    (await fetchAttachments(10, 'c1')).pending,
    1,
    'forgetting the sha is what puts the document back on the fetch queue',
  );

  // The attachments row survives: documents.from_attachment references it, and it is a true record
  // that the file was once held. Only the filing's claim to it is withdrawn.
  const rows = await readTxn(async (c) =>
    (await c.query<{ n: string }>("SELECT count(*)::text AS n FROM attachments WHERE sha256='deadbeef'")).rows);
  assert.equal(rows[0]!.n, '1');
});

test('a sha whose bytes are present is left alone', async () => {
  const bytes = Buffer.from('a real document');
  const sha = createHash('sha256').update(bytes).digest('hex');
  await mkdir(dirname(pathFor(sha)), { recursive: true });
  await writeFile(pathFor(sha), bytes);

  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ($1,'c1','held.pdf','application/pdf',15,'filing','system:ingest')`, [sha]);
  });
  await filing('f2', 'c1', DEAD, sha);

  assert.equal(await clearMissingBytes('c1'), 0, 'a document the store actually holds is not re-fetched');
  assert.equal((await fetchAttachments(10, 'c1')).pending, 0);
});

/**
 * NSE writes a bare "-" where a filing has no attachment, and it reaches the database as a URL
 * ending in slash-hyphen. The exclusion above it claimed to catch that and caught only the bare
 * hyphen, so two of AERON's 85 filings 404'd on every pass — harmless while a failed fetch was a
 * counter, and fatal once a failed fetch meant the backfill could not finish.
 */
test("the exchange's no-attachment placeholder is never fetched", async () => {
  await filing('f1', 'c1', 'https://nsearchives.nseindia.com/corporate/-');
  await filing('f2', 'c1', DEAD);
  assert.equal((await fetchAttachments(10, 'c1')).pending, 1, 'only the real URL is offered');
});

/**
 * A 4xx is the archive's answer about the document; anything else is about the run. The backfill
 * acts on the difference — `gone` does not hold a company in the queue and `failed` does — so the
 * two must not be summed here.
 */
test('a 404 counts as gone, not as a failure', async () => {
  await filing('f1', 'c1', 'https://nsearchives.nseindia.com/corporate/does-not-exist-404.pdf');
  const r = await fetchAttachments(10, 'c1');
  assert.deepEqual({ gone: r.gone, failed: r.failed }, { gone: 1, failed: 0 });
});

test('a refused connection counts as a failure, not as gone', async () => {
  await filing('f1', 'c1', DEAD);
  const r = await fetchAttachments(10, 'c1');
  assert.deepEqual({ gone: r.gone, failed: r.failed }, { gone: 0, failed: 1 });
});

/**
 * `extractPending` reads `attachments`, not `filings`, so a row whose bytes are gone is offered on
 * every pass — `extracted_text` stays null, which is the signal for "unread". `pdfText` then raises
 * ENOENT, which from inside looks exactly like a fault. Six of PRAJIND's did that until this
 * existed, and a backfill that counted them as failures could never finish.
 */
test('an attachment with no bytes is counted as missing, not extracted and not failed', async () => {
  await serviceTxn('system:ingest', async (c) => {
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, added_by)
       VALUES ('nobytes','c1','vanished.pdf','application/pdf',100,'filing','system:ingest')`,
    );
  });

  const r = await extractPending(10, 'c1');
  assert.deepEqual(
    { pending: r.pending, missing: r.missing, failed: r.failed, extracted: r.extracted },
    { pending: 1, missing: 1, failed: 0, extracted: 0 },
    'the row is still offered — it is genuinely unread — but not blamed on this run',
  );
});
