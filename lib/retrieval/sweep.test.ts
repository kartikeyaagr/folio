/**
 * `syncChunkMetadata` — the sweep that corrects a chunk's copies of its source's labels.
 *
 * Split out of `index.test.ts` once it outgrew that file, for the reason `reap.test.ts` was split
 * out before it: `index.test.ts` is about what the indexer writes, and this is about what corrects
 * it afterwards without re-embedding.
 *
 * Every test here marks its source `indexed_at` by hand, because `indexOne` deliberately does not —
 * `drain()` does, after it returns. Without that line the sweep skips the row and every assertion
 * below passes against a no-op, which is exactly how the first version of three of these tests
 * shipped: they were green with their own fixes reverted. Mutation-check any change here.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceTxn, type Client } from '../db.ts';
import { indexOne } from './index.ts';
import { registerAll } from './register.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `folio_sweep_${process.pid}`;
const MODEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models', 'bge-small-en-v1.5');

async function saveNewVersion(c: Client, docId: string, body: Record<string, unknown>): Promise<void> {
  await c.query(`INSERT INTO document_versions (document_id, body, written_by) VALUES ($1, $2, 'system:index')`, [
    docId,
    JSON.stringify(body),
  ]);
}

async function sourceIdFor(c: Client, refId: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `SELECT id FROM sources WHERE kind = 'document_version' AND ref_id = $1`,
    [refId],
  );
  return rows[0]!.id;
}

before(async () => {
  await createTestDatabase(DB);
  process.env.EMBED_MODEL_DIR = MODEL_DIR;
});

after(async () => {
  await dropTestDatabase(DB);
});

test('a re-attributed source carries its already-indexed chunks to the new company', async () => {
  // `company_id` and `occurred_at` are written onto every chunk above, and `search.ts`'s
  // SHARED_FILTER matches the chunk's copy rather than the source's. So when a story is
  // re-attributed to the other followed name, or a filing's date corrected, the source moves and
  // its chunks do not: unreachable under the new name, still answering under the old. `0048`
  // repaired exactly those rows by hand.
  //
  // `registerAll` corrects them in place rather than re-queueing the source, because a vector is a
  // function of the text — which did not change — and a document's `occurred_at` is its current
  // version's `written_at`, so re-queueing on it would cost one embed per save.
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_from','FROM','From Ltd'),('co_to','TO','To Ltd')");
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_moved','co_from','Moved','note','system:index')`,
    );
    await saveNewVersion(c, 'd_moved', { text: 'text that does not change when the name does' });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_moved');
    assert.ok((await indexOne(c, sourceId)) > 0, 'the fixture must index before it can go stale');
    // `drain()` marks the source indexed after `indexOne` returns; the sweep skips anything still
    // queued, because `drain` is about to rewrite those chunks anyway. Stand in for that here.
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1::bigint', [sourceId]);

    await c.query("UPDATE documents SET company_id = 'co_to' WHERE id = 'd_moved'");
    await registerAll(c);

    const { rows } = await c.query('SELECT DISTINCT company_id FROM chunks WHERE source_id = $1', [sourceId]);
    assert.deepEqual(rows.map((r) => r.company_id), ['co_to'], 'every chunk must follow its source');
  });
});

test('re-saving a document does not re-date its chunks', async () => {
  // The sweep must never touch `occurred_at`, and this is the test that says why.
  //
  // `occurred_at` is "the date the content is about" (`0042`, `v4.md` §4.1). For a
  // `document_version` source it is read straight off the current version's `written_at`
  // (DOCUMENTS_SELECT), and `saveDocument` mints a new version on every save — so an ordinary save,
  // even of byte-identical text, moves `sources.occurred_at` to now(). `content_hash` correctly
  // suppresses the re-embed, which is what used to keep the chunks' true date. A sweep that copied
  // `occurred_at` down would re-date every chunk to today instead, and `search.ts`'s SHARED_FILTER
  // reads the CHUNK's copy — so `search_corpus`'s `since` would start returning a 2022 concall as
  // this week's news the moment somebody fixed a typo in it. That is precisely the trap `0042`
  // exists to undo: *"ranking a backfilled transcript by indexed_at instead would put it at the top
  // of every search the day it happens to be ingested."*
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_dated','DATED','Dated Ltd')");
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_dated','co_dated','Transcript','transcript','system:index')`,
    );
    // A version dated to the call, the way extract.ts writes one after 0042.
    await c.query(
      `INSERT INTO document_versions (document_id, body, written_by, written_at)
       VALUES ('d_dated', $1, 'system:ingest', '2022-10-21T15:31:39+05:30')`,
      [JSON.stringify({ text: 'the call as it was actually held, in October 2022' })],
    );
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_dated');
    assert.ok((await indexOne(c, sourceId)) > 0, 'the fixture must index first');
    // `drain()` marks the source indexed after `indexOne`; the sweep skips anything still queued, so
    // without this the sweep is a no-op here and the test passes with its own fix reverted.
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1::bigint', [sourceId]);

    // Somebody fixes a typo — or re-saves the identical text. Either way a new version is minted.
    await saveNewVersion(c, 'd_dated', { text: 'the call as it was actually held, in October 2022' });
    await registerAll(c);

    const { rows } = await c.query(
      'SELECT DISTINCT date_part($1, occurred_at)::int AS yr FROM chunks WHERE source_id = $2',
      ['year', sourceId],
    );
    assert.deepEqual(rows.map((r) => r.yr), [2022], 'the chunk keeps the date the content is about');
  });
});

test('an annual report re-dated by its own announcement stops claiming it is this week', async () => {
  // The `occurred_at` exclusion protects `document_version`, whose date is the save time. It must
  // not reach the other four kinds, and `attachment` is the one that proves it: ATTACHMENTS_SELECT
  // reads `coalesce(f.announced_at, a.added_at)`, so a report pulled straight from the exchange's
  // annual-report endpoint is dated *today* until the announcement feed catches up and supplies a
  // filings row — at which point the source moves to the real date, the text never changed, and
  // `content_hash` correctly keeps it out of the re-index queue.
  //
  // Exclude `occurred_at` for every kind and that chunk keeps today's date forever. `search.ts`
  // filters the chunk's copy, and `search_corpus` describes `since` to the model as "only passages
  // from sources dated on or after it" — so an FY23 annual report answers "what's new this week",
  // permanently. Same trap as 0042, one kind over.
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_ar','ARCO','Annual Report Co')");
    await c.query(
      `INSERT INTO attachments (sha256, company_id, filename, media_type, bytes, kind, extracted_text, added_by, added_at)
       VALUES ('sha_annual','co_ar','AR2023.pdf','application/pdf',100,'annual_report',
               'the annual report as filed for the year ended March 2023', 'system:ingest', now())`,
    );
    await registerAll(c);
    const { rows: src } = await c.query<{ id: string }>(
      `SELECT id FROM sources WHERE kind = 'attachment' AND ref_id = 'sha_annual'`,
    );
    const sourceId = src[0]!.id;
    assert.ok((await indexOne(c, sourceId)) > 0, 'the fixture must index first');
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1::bigint', [sourceId]);

    // The announcement feed catches up. No attachment byte changes; only the date it is filed under.
    await c.query(
      `INSERT INTO filings (id, company_id, symbol, category, summary, announced_at, attachment_sha256)
       VALUES ('fil_ar','co_ar','ARCO','Annual Report','Annual Report FY23','2023-07-14T10:00:00Z','sha_annual')`,
    );
    await registerAll(c);

    const { rows } = await c.query(
      'SELECT DISTINCT date_part($1, occurred_at)::int AS yr FROM chunks WHERE source_id = $2',
      ['year', sourceId],
    );
    assert.deepEqual(rows.map((r) => r.yr), [2023], 'the chunk must take the announcement date, not the fetch date');
  });
});

test('a source queued for re-indexing is left for the indexer, not swept first', async () => {
  // The sweep skips `indexed_at IS NULL` because `drain()` is about to delete and rewrite those
  // chunks anyway; sweeping first writes every one of them twice, and `company_id` sits in
  // `chunks_company_idx` so the update can never be HOT — measured at 1,727 ms for one 1,082-chunk
  // annual report, almost all of it re-inserting 384-dim vectors into the HNSW index.
  //
  // The honest cost of that guard, asserted here rather than left to be discovered: between the
  // registration and the re-index, the chunks still answer under the OLD company. The window is one
  // batch — bounded by CHUNK_BUDGET and the ten-minute timer, longer during an `--all` backfill.
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_q1','QA','Q A Ltd'),('co_q2','QB','Q B Ltd')");
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_queued','co_q1','Queued','note','system:index')`,
    );
    await saveNewVersion(c, 'd_queued', { text: 'the original wording, before the edit' });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_queued');
    assert.ok((await indexOne(c, sourceId)) > 0, 'the fixture must index first');
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1::bigint', [sourceId]);

    // Both at once: the text changes (so content_hash moves and the source re-queues) AND the
    // company changes (so the source is in `moved` and the sweep would otherwise touch it).
    await saveNewVersion(c, 'd_queued', { text: 'an entirely different wording after the edit' });
    await c.query("UPDATE documents SET company_id = 'co_q2' WHERE id = 'd_queued'");
    await registerAll(c);

    const queued = await c.query('SELECT indexed_at FROM sources WHERE id = $1::bigint', [sourceId]);
    assert.equal(queued.rows[0].indexed_at, null, 'a content change must re-queue the source');
    const before = await c.query('SELECT DISTINCT company_id FROM chunks WHERE source_id = $1', [sourceId]);
    assert.deepEqual(before.rows.map((r) => r.company_id), ['co_q1'], 'the sweep must leave a queued source alone');

    // And the indexer puts it right, which is why skipping it was safe.
    await indexOne(c, sourceId);
    const after = await c.query('SELECT DISTINCT company_id FROM chunks WHERE source_id = $1', [sourceId]);
    assert.deepEqual(after.rows.map((r) => r.company_id), ['co_q2'], 're-indexing writes the current company');
  });
});

test('the metadata sweep is bounded to the sources that moved this run', async () => {
  // The bound is the whole design. An unconditional `UPDATE chunks … FROM sources` reconciles the
  // entire table, and `drain()` calls `registerAll` once per BATCH — so `index-content --all`
  // re-scans every chunk written so far on every batch of a backfill, over a table that is growing
  // as it goes. Measured on a synthetic 200k-chunk / 20k-source corpus: 210 ms and 17,645 buffer
  // reads per call, to find nothing, in the steady state where nothing drifted.
  //
  // So the sweep only ever looks at sources this run's upserts actually changed. The cost of that
  // bound, pinned here so it is a decision rather than a surprise: a chunk whose company drifted
  // without its source moving is not self-healed. Writing one by hand is what this test does.
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ('co_stale','STALE','Stale Ltd')");
    await c.query(
      `INSERT INTO documents (id, company_id, title, kind, created_by)
       VALUES ('d_still','co_stale','Still','note','system:index')`,
    );
    await saveNewVersion(c, 'd_still', { text: 'a document nobody touches again' });
    await registerAll(c);
    const sourceId = await sourceIdFor(c, 'd_still');
    assert.ok((await indexOne(c, sourceId)) > 0, 'the fixture must index first');
    // As above: without this the sweep skips the row and the bound is never exercised.
    await c.query('UPDATE sources SET indexed_at = now() WHERE id = $1::bigint', [sourceId]);

    // Hand-corrupt one chunk. Its source is untouched, so this run has no reason to look at it.
    await c.query("UPDATE chunks SET company_id = NULL WHERE source_id = $1::bigint", [sourceId]);
    await registerAll(c);

    const { rows } = await c.query('SELECT DISTINCT company_id FROM chunks WHERE source_id = $1', [sourceId]);
    assert.deepEqual(rows.map((r) => r.company_id), [null], 'an untouched source is not swept');
  });
});

