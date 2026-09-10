import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embed, toVector, EMBED_DIM, EMBED_MODEL } from './embed.ts';

// Repo-local, not the VM path `embed.ts` defaults to — fetched once with `pnpm fetch-model` and
// left in place (.gitignore'd; 130MB has no business in git). Set in before(), which runs after
// this file's own top-level code but before any test body, matching how lib/db.ts's DATABASE_URL
// is set in the other test files that need a real backend.
before(() => {
  process.env.EMBED_MODEL_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.models',
    'bge-small-en-v1.5',
  );
});

test('the model constant is recorded, not assumed', () => {
  assert.equal(EMBED_MODEL, 'bge-small-en-v1.5');
  assert.equal(EMBED_DIM, 384);
});

test('an embedding has the declared dimension and unit length', async () => {
  const [v] = await embed(['The promoter has encumbered 12.4% of their holding.']);
  assert.equal(v!.length, EMBED_DIM);
  // L2-normalised, so cosine similarity is a dot product and the SQL can stay simple.
  assert.ok(Math.abs(Math.hypot(...v!) - 1) < 1e-5);
});

test('near-identical sentences score higher than unrelated ones', async () => {
  const [auditor, auditorAgain, weather] = await embed([
    'The statutory auditor resigned with immediate effect.',
    'The company reported the resignation of its statutory auditor.',
    'Rainfall in Maharashtra was above the seasonal average.',
  ]);
  const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);
  assert.ok(dot(auditor!, auditorAgain!) > dot(auditor!, weather!));
});

test('a batch comes back in the order it went in', async () => {
  const [a, b] = await embed(['alpha revenue margin', 'zulu auditor pledge']);
  const [aAgain] = await embed(['alpha revenue margin']);
  const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
  assert.ok(dot(a!, aAgain!) > 0.999);
  assert.ok(dot(b!, aAgain!) < dot(a!, aAgain!));
});

test('an empty batch does not load the model', async () => {
  assert.deepEqual(await embed([]), []);
});

test('a vector renders in the literal form pgvector accepts', () => {
  assert.equal(toVector([1, 2.5, -3]), '[1,2.5,-3]');
});

test('punctuation glued to a word does not change its embedding much', async () => {
  // The R0 regression, as a unit test. A tokenizer that fails to split '%' or '-' embeds
  // "12.4%" as one unknown blob, and the only symptom is a slightly worse vector — which every
  // other test in this file still passes. Measured: the broken tokenizer scored 0.868 against
  // Python on this exact string while the seven cleaner strings scored 0.999999.
  const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i]!, 0);
  const [pct, spelled] = await embed([
    'The promoter has encumbered 12.4% of their holding.',
    'The promoter has encumbered 12.4 percent of their holding.',
  ]);
  assert.ok(dot(pct!, spelled!) > 0.95, `punctuation split looks wrong: ${dot(pct!, spelled!)}`);
});
