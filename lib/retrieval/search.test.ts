import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceTxn, type Client } from '../db.ts';
import { embed, toVector, EMBED_MODEL } from './embed.ts';
import { search, MAX_PER_SOURCE } from './search.ts';
import { createTestDatabase, dropTestDatabase } from '../../db/testing.ts';

const DB = `trisula_search_${process.pid}`;

// Repo-local model — see index.test.ts and embed.test.ts, which set this the same way.
const MODEL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models', 'bge-small-en-v1.5');

before(async () => {
  await createTestDatabase(DB);
  process.env.EMBED_MODEL_DIR = MODEL_DIR;
});

after(async () => {
  await dropTestDatabase(DB);
});

let refCounter = 0;

async function addSource(c: Client, companyId: string | null, title: string): Promise<string> {
  const refId = `search_test_${refCounter++}`;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO sources (kind, ref_id, company_id, title, content_hash)
     VALUES ('document_version', $1, $2, $3, 'test-hash') RETURNING id`,
    [refId, companyId, title],
  );
  return rows[0]!.id;
}

/**
 * One source, one or more chunks — the same shape `lib/retrieval/index.ts`'s `indexOne` writes,
 * built directly (bypassing documents/registerAll/indexOne) so each test controls exactly what
 * content and embeddings exist, with no chunker or register-eligibility rules in the way.
 */
async function addChunks(c: Client, companyId: string | null, title: string, texts: string[]): Promise<string> {
  const sourceId = await addSource(c, companyId, title);
  const vectors = await embed(texts);
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i]!;
    await c.query(
      `INSERT INTO chunks (source_id, company_id, ord, text, char_from, char_to, embedding, embed_model)
       VALUES ($1, $2, $3, $4, 0, $5, $6::vector, $7)`,
      [sourceId, companyId, i, text, text.length, toVector(vectors[i]!), EMBED_MODEL],
    );
  }
  return sourceId;
}

// Run first, against a database with no sources or chunks registered at all — the one point where
// this assertion is actually true. This is NOT a relevance-floor test and must never be read as
// one: Task 10 measured the live corpus and found no cosine value separates an answerable question
// from gibberish (`search('zzzz nonexistent qqqq')` returns a real hit at 0.6912 once any chunks
// exist — tasks/relevance-2026-09-10.md). What this pins is strictly structural and holds
// regardless of relevance: the fused SQL only ever admits a row that at least one CTE actually
// ranked (`WHERE v.id IS NOT NULL OR f.id IS NOT NULL` in search.ts), so an empty `chunks` table
// necessarily returns `[]` — "no rows in" implies "no rows out", nothing more. This mirrors
// index.test.ts's own "run this one first" pattern and for the same reason: order is part of the
// test's meaning here, not an accident of file layout.
test('an empty corpus returns no rows — the structural guarantee, not a relevance floor', async () => {
  assert.deepEqual(await search('zzzz nonexistent qqqq'), []);
});

test('an exact symbol in the query beats a merely similar passage', async () => {
  // The keyword half earning its place: "PRAJIND Q3 revenue" is not a semantic question, and the
  // exact-terms chunk should out-rank a chunk that only shares the general topic.
  await serviceTxn('system:index', async (c) => {
    await addChunks(c, null, 'Exact match', [
      "PRAJIND's Q3 revenue rose to 450 crore, up 12% year on year, driven by higher realizations.",
    ]);
    await addChunks(c, null, 'Similar topic, different words', [
      "The ethanol sector's quarterly earnings were broadly steady, with realizations firm across producers.",
    ]);
  });

  const hits = await search('PRAJIND Q3 revenue');
  assert.ok(hits.length > 0);
  assert.match(hits[0]!.text, /PRAJIND/);
});

test('a semantic question finds a passage that shares no words with it', async () => {
  // The vector half earning its place. The target passage never uses "management", "said" or
  // "auditor" — the very words websearch_to_tsquery would OR together — so the keyword path
  // cannot find it at all; only cosine similarity can. A distractor with nothing to do with
  // auditors should rank behind it, or the assertion would pass on a database too small to prove
  // anything.
  let targetText = '';
  let distractorText = '';
  await serviceTxn('system:index', async (c) => {
    targetText =
      "The statutory reviewer flagged related-party balances as a matter warranting closer scrutiny in this year's opinion.";
    distractorText = 'The bagging line commissioning boosted plant utilization in the December quarter.';
    await addChunks(c, null, 'Audit matter, unlike wording', [targetText]);
    await addChunks(c, null, 'Unrelated operational update', [distractorText]);
  });

  const hits = await search('what has management said about the auditor');
  const targetIdx = hits.findIndex((h) => h.text === targetText);
  const distractorIdx = hits.findIndex((h) => h.text === distractorText);
  assert.notEqual(targetIdx, -1, 'the semantically related passage must be found at all');
  if (distractorIdx !== -1) {
    assert.ok(targetIdx < distractorIdx, 'the related passage should rank ahead of the unrelated one');
  }
});

test('one long document cannot fill the result window', async () => {
  let longSourceId = '';
  await serviceTxn('system:index', async (c) => {
    longSourceId = await addChunks(
      c,
      null,
      'Long annual report',
      Array.from({ length: 5 }, (_, i) => `Revenue in segment ${i + 1} grew steadily again this year.`),
    );
  });

  const hits = await search('revenue');
  const perSource = new Map<string, number>();
  for (const h of hits) perSource.set(h.sourceId, (perSource.get(h.sourceId) ?? 0) + 1);
  for (const n of perSource.values()) assert.ok(n <= MAX_PER_SOURCE);
  // Not just "never exceeds the cap" (true vacuously if the long source never surfaced at all) —
  // confirm the cap actually fired on the document built to trigger it.
  assert.equal(perSource.get(longSourceId), MAX_PER_SOURCE);
});

test('a company filter excludes every other company', async () => {
  const coX = `search_co_x_${process.pid}`;
  const coY = `search_co_y_${process.pid}`;
  await serviceTxn('system:index', async (c) => {
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1, $2, 'Company X')", [coX, `CFX${process.pid}`]);
    await c.query("INSERT INTO companies (id, symbol, name) VALUES ($1, $2, 'Company Y')", [coY, `CFY${process.pid}`]);
    await addChunks(c, coX, 'Company X board note', ['The board approved a rights issue for the company this quarter.']);
    await addChunks(c, coY, 'Company Y board note', ['The board approved a rights issue for the company this quarter.']);
  });

  const hits = await search('rights issue', { companyId: coX });
  assert.ok(hits.length > 0);
  for (const h of hits) assert.equal(h.companyId, coX);
});

test('results carry the offsets a citation needs', async () => {
  await serviceTxn('system:index', async (c) => {
    await addChunks(c, null, 'Auditor note', ["The auditor's report highlighted a qualified opinion on related-party balances."]);
  });

  const hits = await search('auditor');
  assert.ok(hits.length > 0);
  for (const h of hits) {
    assert.ok(h.charTo > h.charFrom);
    assert.equal(typeof h.chunkId, 'string');
  }
});

// Runs last: it corrupts every chunk's embed_model in this test database, which would make every
// later assertion in this file pass vacuously (search() returning [] for the wrong reason) rather
// than for the property it names.
test('chunks embedded by another model are never returned', async () => {
  // Vectors from two models occupy different spaces. Excluded, never converted — and "excluded"
  // applies to both paths (see search.ts's SHARED_FILTER), not just the vector one: a chunk from
  // a superseded embedding pass is quarantined from retrieval entirely, not merely un-rankable by
  // cosine distance.
  await serviceTxn('system:index', (c) => c.query(`UPDATE chunks SET embed_model = 'some-other-model'`));
  assert.deepEqual(await search('revenue'), []);
});
