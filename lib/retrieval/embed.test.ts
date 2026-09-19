import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { embed, encode, toVector, EMBED_DIM, EMBED_MODEL } from './embed.ts';

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

/** The real vocab. `encode` needs only this, so these checks cost no ONNX session. */
function loadVocab(): Record<string, number> {
  const at = path.join(process.env.EMBED_MODEL_DIR!, 'tokenizer.json');
  return JSON.parse(readFileSync(at, 'utf8')).model.vocab as Record<string, number>;
}

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

test('a word with no vocab entry cannot explode the sequence past the 512-token limit', async () => {
  // The R1 regression. Reproduced exactly as found: 200 repetitions of a word with no vocab
  // entry at any granularity. WordPiece falls back to 12 single/double-character pieces per
  // repetition (measured against the real vocab: 'z','##z','##q','##x','##w','##vb','##h','##k',
  // '##j','##fm','##pg','##y') — 2400 pieces uncapped, nowhere near the model's 512 positions.
  // Before the fix, the cap ran only between words, so this threw deep inside onnxruntime
  // ("Attempting to broadcast an axis by a dimension other than 1. 512 by 518") instead of
  // returning an embedding. It must now return a normal, valid vector.
  const overflow = Array(200).fill('zzqxwvbhkjfmpgy').join(' ');
  const [v] = await embed([overflow]);
  assert.equal(v!.length, EMBED_DIM);
  assert.ok(Math.abs(Math.hypot(...v!) - 1) < 1e-5);
});

test('WordPiece emits one [UNK] for a whole word that fails, not matched-pieces-plus-[UNK]', () => {
  // A pure tokenizer.json-only check — no ONNX session needed, since encode() only needs the
  // vocab. "hello" is a whole-word vocab entry; a trailing emoji has no entry at any granularity
  // (checked directly against the vocab: neither "🎉" nor "##🎉" exists), and it isn't Unicode
  // punctuation so the pre-tokenizer doesn't split it off — the whole string "hello🎉" reaches
  // WordPiece as one word. The reference WordpieceTokenizer emits a single [UNK] for that word.
  // The pre-fix code instead committed "hello" to `ids` before discovering the emoji couldn't
  // match, yielding [hello, UNK] — two tokens where the reference tokenizer produces one.
  const vocab = loadVocab();
  const ids = encode(vocab, 'hello🎉');
  assert.deepEqual(ids, [vocab['[CLS]'], vocab['[UNK]'], vocab['[SEP]']]);
});

test('accents are stripped, as the model\u2019s own normalizer asks', () => {
  // tokenizer.json: BertNormalizer{strip_accents:null, lowercase:true}, and HuggingFace defaults
  // strip_accents to lowercase when null. Without this the accented form is one [UNK] here and a
  // real word in the reference, and the resulting vector is valid, unit-length and slightly wrong.
  const v = loadVocab();
  const unk = [v['[CLS]'], v['[UNK]'], v['[SEP]']];
  assert.deepEqual(encode(v, 'caf\u00e9'), encode(v, 'cafe'), 'the accent must not change the ids');
  assert.notDeepEqual(encode(v, 'caf\u00e9'), unk, 'and the result must not simply be [UNK]');
});

test('a word past max_input_chars_per_word is one [UNK], not four hundred pieces', () => {
  // tokenizer.json: model.max_input_chars_per_word = 100.
  const v = loadVocab();
  const long = 'a'.repeat(500);
  assert.deepEqual(encode(v, long), [v['[CLS]'], v['[UNK]'], v['[SEP]']]);
});
