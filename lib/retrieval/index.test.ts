import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../db/migrate.ts';
import { closePool, serviceTxn, type Client } from '../db.ts';
import { indexOne, drain } from './index.ts';
import { EMBED_MODEL, isLoaded } from './embed.ts';
import { registerAll, contentHash } from './register.ts';

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
  // One of the documented exemptions to the zero-items rule; CLAUDE.md carries the roster. Most of the 144 daily runs of this job find nothing, because indexing follows
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

// Regression test for the livelock finding: a 50-SOURCE claim limit meant nothing once a source
// could be a 177-character filing or a 795,000-character annual report — a batch of the latter
// shape blew well past the systemd job's 30-minute timeout, inside one transaction, with nothing
// surviving the kill to say why. Bounding by chunk count instead is what this test pins: three
// sources are claimed, but a budget of one chunk must stop the batch after the FIRST one, leaving
// the other two `indexed_at IS NULL` for the next call — never "claimed all three because three is
// under some source-count limit."
test('drain bounds a batch by its chunk budget, not by how many sources it claims', async () => {
  // Clear whatever the file's own fixtures left unindexed (the 'a source that fails' test above
  // registers d_fail but never successfully indexes it; a real model is loaded again by now, so it
  // would otherwise be the row this test's own claim picks up first).
  await drain();

  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_budget_1', 'note', { text: 'first short memo, well under a thousand characters' });
    await newDocument(c, 'd_budget_2', 'note', { text: 'second short memo, also just one chunk' });
    await newDocument(c, 'd_budget_3', 'note', { text: 'third short memo, also just one chunk' });
  });

  const out = await drain(1);
  assert.equal(out.registered, 3);
  assert.equal(out.indexed, 1, 'a chunk budget of 1 must stop the batch after one source, not after claiming all three');
  assert.equal(out.failed, 0);

  await serviceTxn('system:index', async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sources
        WHERE ref_id IN ('d_budget_1','d_budget_2','d_budget_3') AND indexed_at IS NULL`,
    );
    assert.equal(rows[0]!.n, '2', 'the two sources the budget did not reach must stay indexed_at IS NULL for the next tick');
  });

  // Proves the remainder was left alone rather than claimed-and-dropped: the very next call picks
  // up exactly what the first one could not get to.
  const rest = await drain(10);
  assert.equal(rest.indexed, 2);
});

test('drain always indexes at least one source, even at a chunk budget of zero', async () => {
  // The guard jobs/index-content.ts's --all loop depends on: untilQueueEmpty stops the moment a
  // batch reports indexed:0, reading that as "no forward progress possible." A budget that could
  // round down to zero sources processed would make a batch report indexed:0 despite unindexed
  // sources still waiting — ending a backfill early while believing it finished.
  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_budget_zero', 'note', { text: 'a memo that must still be indexed' });
  });

  const out = await drain(0);
  assert.equal(out.indexed, 1, 'a batch must always make forward progress, however small the budget');
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

test('a multi-tab spreadsheet indexes as its rows, with each tab named', async () => {
  // The body shape written since 0052. This is the one that fails SILENTLY if anything forgets it:
  // a `{sheets}` body that DOCUMENTS_SELECT does not recognise as a spreadsheet falls to the prose
  // branch, gets hashed with no renderer tag, and is chunked by chunkText — so the corpus ends up
  // holding `{"sheets":[{"name":"Inputs"...` as though it were a passage somebody wrote. It looks
  // exactly like a working index right up until a search should have found a figure that is in it.
  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_tabs', 'sheet', {
      sheets: [
        { name: 'Inputs', cells: { A1: 'Growth', B1: '0.12' } },
        { name: 'Model', cells: { A1: 'Revenue', B1: '693.2', A2: 'PAT', B2: '58.1' } },
      ],
    });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_tabs');
    await indexOne(c, sourceId);

    const { rows } = await c.query<{ chunk_text: string }>(
      `SELECT text AS chunk_text FROM chunks WHERE source_id = $1 ORDER BY char_from`,
      [sourceId],
    );
    assert.equal(rows.length, 2, 'one chunk per tab — a chunk spanning two is a passage nobody wrote');
    assert.equal(rows[0]!.chunk_text, 'Inputs\nGrowth\t0.12');
    assert.equal(rows[1]!.chunk_text, 'Model\nRevenue\t693.2\nPAT\t58.1');
    for (const r of rows) {
      assert.doesNotMatch(r.chunk_text, /[{}"]/, 'indexed as rows, never as the body JSON');
    }
  });
});

test('a multi-tab body is hashed as a spreadsheet, not as prose', async () => {
  // The other half: SHEET_BODY_SQL and lib/sheet/book.ts's isSheetBody ask the same question on
  // two sides of the wire and must agree. If the SQL missed `{sheets}`, the hash would be the raw
  // body with no renderer tag — which is exactly `contentHash(body::text)`.
  await serviceTxn('system:index', async (c) => {
    await newDocument(c, 'd_tabs_hash', 'sheet', { sheets: [{ name: 'Model', cells: { A1: 'Revenue' } }] });
    await registerAll(c);
    const { rows } = await c.query<{ content_hash: string }>(
      `SELECT content_hash FROM sources WHERE kind = 'document_version' AND ref_id = 'd_tabs_hash'`,
    );
    const { rows: raw } = await c.query<{ t: string }>(
      `SELECT body::text AS t FROM document_versions WHERE document_id = 'd_tabs_hash'`,
    );
    assert.notEqual(
      rows[0]!.content_hash,
      contentHash(raw[0]!.t),
      'a {sheets} body hashed as prose cannot be re-chunked when the grid renderer changes',
    );
  });
});

test("a sheet's hash is not its body's hash, so the grid renderer can invalidate it", async () => {
  // What gets chunked for a sheet is `sheetGridText(cells)`, not the body. If the hash were taken
  // straight off `body::text`, a change to that renderer would leave `content_hash` unmoved and
  // `indexed_at` set — so the sheet would never re-chunk, and its stored char_from/char_to would go
  // on indexing a string `textFor` no longer returns. `chunk.ts`'s header records that divergence
  // happening once already. The renderer tag in DOCUMENTS_SELECT is what makes it invalidatable.
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_grid','GRID','Grid Ltd')");
    const body = { cells: { A1: 'Revenue', B1: '693.2' } };
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_grid',$1,'Model','sheet','system:index')`,
      ['co_grid'],
    );
    await c.query(`INSERT INTO document_versions (document_id, body, written_by) VALUES ($1,$2,'system:index')`, [
      'd_grid',
      JSON.stringify(body),
    ]);
    await registerAll(c);

    const { rows } = await c.query<{ content_hash: string }>(
      `SELECT content_hash FROM sources WHERE kind = 'document_version' AND ref_id = 'd_grid'`,
    );
    const { rows: raw } = await c.query<{ t: string }>(
      `SELECT body::text AS t FROM document_versions WHERE document_id = 'd_grid'`,
    );
    assert.notEqual(
      rows[0]!.content_hash,
      contentHash(raw[0]!.t),
      "a sheet hashed as its raw body cannot be re-chunked when the renderer changes",
    );

    // And the other half of the bargain: a prose document must be untouched by the tag, or every
    // note in the corpus re-embeds the next time the grid renderer is bumped.
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_prose_hash',$1,'Note','note','system:index')`,
      ['co_grid'],
    );
    await saveNewVersion(c, 'd_prose_hash', { text: 'ordinary prose, no cells anywhere' });
    await registerAll(c);
    const prose = await c.query<{ content_hash: string }>(
      `SELECT content_hash FROM sources WHERE kind = 'document_version' AND ref_id = 'd_prose_hash'`,
    );
    assert.equal(
      prose.rows[0]!.content_hash,
      contentHash('ordinary prose, no cells anywhere'),
      'a prose document must hash its text exactly, with no renderer tag',
    );
  });
});

test('every written chunk names the model that embedded it', async () => {
  const { rows } = await serviceTxn('system:index', (c) => c.query('SELECT DISTINCT embed_model FROM chunks'));
  assert.deepEqual(
    rows.map((r) => r.embed_model),
    [EMBED_MODEL],
  );
});
