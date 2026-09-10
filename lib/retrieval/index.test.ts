import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../db/migrate.ts';
import { closePool, serviceTxn, type Client } from '../db.ts';
import { indexOne, drain } from './index.ts';
import { EMBED_MODEL, isLoaded } from './embed.ts';
import { registerAll } from './register.ts';

const DB = `trisula_idx_${process.pid}`;

// Repo-local model, fetched once with `pnpm fetch-model` and left in place (see embed.test.ts,
// which sets this the same way and for the same reason).
const MODEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models', 'bge-small-en-v1.5');

/** Mirrors register.test.ts's own helper: the minimal insert a save actually does. */
async function saveNewVersion(c: Client, docId: string, body: Record<string, unknown>): Promise<void> {
  await c.query(`INSERT INTO document_versions (document_id, body, written_by) VALUES ($1, $2, 'system:index')`, [
    docId,
    JSON.stringify(body),
  ]);
}

async function newDocument(c: Client, id: string, kind: string, body: Record<string, unknown>): Promise<void> {
  await c.query(`INSERT INTO documents (id, company_id, title, kind, created_by) VALUES ($1, NULL, $2, $3, 'system:index')`, [
    id,
    id,
    kind,
  ]);
  await saveNewVersion(c, id, body);
}

async function sourceIdFor(c: Client, refId: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
    [refId],
  );
  return rows[0]!.id;
}

before(async () => {
  execFileSync('createdb', [DB]);
  process.env.DATABASE_URL = `postgres:///${DB}`;
  process.env.EMBED_MODEL_DIR = MODEL_DIR;
  await migrate();
});

after(async () => {
  await closePool();
  execFileSync('dropdb', ['--if-exists', DB]);
});

// Run first, against a database with nothing registered yet: the one shape where "found nothing"
// really does mean nothing, rather than "haven't gotten to it yet" because an earlier test already
// left something in the queue.
test('an empty queue is not a failure', async () => {
  // The third documented exemption to the zero-items rule (jobs/news-gate.ts, jobs/ingest-eod.ts's
  // bhavcopy case). Most of the 144 daily runs of this job find nothing, because indexing follows
  // people saving and jobs ingesting rather than a schedule of its own.
  const out = await drain();
  assert.deepEqual(out, { registered: 0, indexed: 0, failed: 0 });
});

// Run second, and deliberately before any test below makes a real embed() call: embed.ts caches
// its model session only after a load that actually succeeds, so this is the one point in the
// whole file where pointing EMBED_MODEL_DIR at nothing is guaranteed to make embed() fail rather
// than quietly reuse an already-loaded model. Restored before the test returns, so every later
// test embeds against the real one.
test('a source that fails records why and stays in the queue', async () => {
  // Guards the precondition the comment above claims but does not check: this technique only
  // works the FIRST time embed.ts's load() ever runs in this process, because it caches its ONNX
  // session in a module-level variable set only after a load that succeeds, and never rechecks the
  // directory once that variable is set. If anything earlier — in this file or, after a reorder,
  // moved ahead of it — has already made a real embed() call, drain() below will succeed instead of
  // failing, and the assertions after it will simply report a value mismatch that looks like an
  // ordinary broken test.
  //
  // That reads as an easy fix ("update the expected numbers"), and it is exactly the wrong one: it
  // would silently delete the only coverage this file has for the SAVEPOINT / ROLLBACK /
  // index_error path in drain() — the mechanism that keeps one bad source from poisoning the
  // transaction that records its own failure — while leaving the suite green. If you hit this
  // assertion: put this test back immediately after 'an empty queue is not a failure' (the only
  // other test allowed to run before it), or find a different way to force indexOne to fail that
  // doesn't depend on load() never having succeeded yet.
  assert.equal(
    isLoaded(),
    false,
    'embed.ts already has a cached model session, so this test can no longer make embed() fail by ' +
      'pointing EMBED_MODEL_DIR at nothing. This test must run before any other test in this file ' +
      'calls embed() for the first time — see the comment above this assertion before changing ' +
      'anything below it.',
  );

  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_fail', 'note', { text: 'a memo the indexer will never get to embed' });
  });

  process.env.EMBED_MODEL_DIR = '/nonexistent/trisula-model-dir';
  let out;
  try {
    out = await drain();
  } finally {
    process.env.EMBED_MODEL_DIR = MODEL_DIR;
  }
  assert.deepEqual(out, { registered: 1, indexed: 0, failed: 1 });

  await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query(
      `SELECT indexed_at, index_error FROM sources WHERE kind = 'document_version' AND ref_id = 'd_fail'`,
    );
    assert.equal(rows[0].indexed_at, null);
    assert.match(rows[0].index_error, /./);
  });
});

test('indexing a source writes chunks that slice back to the original', async () => {
  // Long enough to break into several chunks (TARGET_CHARS is 1000), so the slice invariant is
  // checked across a real chunk boundary, not just on a single one-piece document.
  const text = Array.from(
    { length: 30 },
    (_, i) => `Sentence number ${i} about the promoter pledge and the auditor's note on related-party transactions.`,
  ).join(' ');

  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_slice', 'note', { text });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_slice');

    const n = await indexOne(c, sourceId);
    assert.ok(n > 1, 'expected more than one chunk from a multi-thousand-character document');

    const { rows } = await c.query(
      `SELECT ord, text AS chunk_text, char_from, char_to FROM chunks WHERE source_id = $1 ORDER BY ord`,
      [sourceId],
    );
    assert.equal(rows.length, n);
    rows.forEach((r, i) => {
      assert.equal(r.ord, i);
      assert.equal(text.slice(r.char_from, r.char_to), r.chunk_text);
    });
  });
});

test('re-indexing replaces chunks rather than adding to them', async () => {
  // Otherwise an edited memo is retrievable in both its old and new wording, and the old one wins
  // as often as not.
  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_edit', 'note', { text: 'the first wording, entirely about the auditor' });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_edit');
    await indexOne(c, sourceId);

    await saveNewVersion(c, 'd_edit', { text: 'a completely different second wording, about the pledge' });
    await registerAll(c); // re-hashes; textFor now reads the new current version
    const n = await indexOne(c, sourceId);

    const { rows } = await c.query<{ chunk_text: string }>(
      `SELECT text AS chunk_text FROM chunks WHERE source_id = $1`,
      [sourceId],
    );
    assert.equal(rows.length, n, "indexOne's own count must match what is actually in the table");
    assert.equal(rows.length, 1, 'both wordings are short enough to be a single chunk each');
    assert.match(rows[0]!.chunk_text, /pledge/);
    assert.doesNotMatch(rows[0]!.chunk_text, /auditor/, 'the old wording must not survive re-indexing');
  });
});

test('a spreadsheet document_version is chunked by row, chosen by content not by kind', async () => {
  // register.ts's document_version branch hands textFor's chunker whatever the body actually is;
  // a sheet's body has no top-level "text" key, so what arrives is the body's own JSON, and the
  // indexer has to recognise that and reach for chunkCells rather than treating it as one long
  // string of JSON punctuation.
  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_sheet', 'sheet', {
      cells: { A1: 'Revenue', B1: '693.2', A2: 'PAT', B2: '58.1' },
    });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_sheet');
    const n = await indexOne(c, sourceId);
    assert.equal(n, 1);

    const { rows } = await c.query<{ chunk_text: string }>(`SELECT text AS chunk_text FROM chunks WHERE source_id = $1`, [
      sourceId,
    ]);
    // Row-packed (tab between cells, newline between rows), not the raw '{"cells":...}' JSON.
    assert.equal(rows[0]!.chunk_text, 'Revenue\t693.2\nPAT\t58.1');
  });
});

test('every written chunk names the model that embedded it', async () => {
  const { rows } = await serviceTxn('system:index', (c) => c.query('SELECT DISTINCT embed_model FROM chunks'));
  assert.deepEqual(
    rows.map((r) => r.embed_model),
    [EMBED_MODEL],
  );
});
