/**
 * The embedder. Local, in-process, TypeScript.
 *
 * `BAAI/bge-small-en-v1.5` as ONNX under onnxruntime-node — the same model v2 ran through Python's
 * fastembed, verified against it on real strings before this file existed (R0, tasks/build-log.md).
 * Same model on purpose: it means v2's measured similarity numbers stay comparable rather than
 * needing rediscovery.
 *
 * Nothing leaves the VM. That is not an aesthetic preference — this embeds the desk's own memos,
 * models and notes, and v2 refused a hosted embedder for spreadsheets in as many words: "a model
 * is the thesis expressed in numbers".
 */
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Recorded on every row. Vectors from two models occupy different spaces, and comparing them
 * returns plausible numbers with meaningless neighbours — the worst available failure, because it
 * has no symptom. Changing this constant means re-embedding, never mixing.
 */
export const EMBED_MODEL = 'bge-small-en-v1.5';
export const EMBED_DIM = 384;

/** Where `ops/SETUP.md` provisions it on the box. */
const VM_MODEL_DIR = '/var/lib/trisula/models/bge-small-en-v1.5';

/**
 * Where `ops/fetch-model.sh` actually writes it when called with no argument.
 *
 * Measured 11-Sep-2026, by the first live chat turn: the script's default and this file's default
 * were two different directories, so `pnpm fetch-model` succeeded and every `search_corpus` call
 * then failed with an error telling the reader to run `pnpm fetch-model`. The suite did not catch
 * it because the tests set `EMBED_MODEL_DIR` in a `before()` hook — the app never did, so only a
 * caller outside the tests could ever have hit it.
 *
 * Resolved from this module's own location, not `process.cwd()`: a job run from another directory
 * would otherwise look beside the caller rather than beside the repo.
 *
 * **Built with `path.join`, never `new URL('../../…', import.meta.url)`.** That second form is the
 * bundler-recognised asset-reference pattern: webpack resolves it at build time and fails with
 * *"Module not found: Can't resolve '../../.models/bge-small-en-v1.5'"*, because the target is a
 * directory of weights rather than a module. It works perfectly under `tsx` and breaks `next
 * build`, so the whole test suite passes while every page that reaches retrieval refuses to
 * compile — measured 11-Sep-2026, on the same turn the path mismatch above was found.
 */
const REPO_MODEL_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.models', EMBED_MODEL,
);

const complete = (dir: string): boolean =>
  existsSync(`${dir}/model.onnx`) && existsSync(`${dir}/tokenizer.json`);

/**
 * Where to look, in order.
 *
 * An explicit `EMBED_MODEL_DIR` is the only place tried, deliberately: a setting that silently
 * falls back to somewhere else is a setting that can be wrong without saying so, and the directory
 * it names is how a test points this at a fixture.
 */
function modelDirs(): string[] {
  const named = process.env['EMBED_MODEL_DIR'];
  return named ? [named] : [VM_MODEL_DIR, REPO_MODEL_DIR];
}

let session: InferenceSession | undefined;
let vocab: Record<string, number> | undefined;

/**
 * Loaded once. A 130MB model read per call would dominate every job that uses it.
 *
 * `EMBED_MODEL_DIR` is read here, inside the function, rather than into a module-scope constant.
 * Tests point it at the repo-local `.models/` directory from a `before()` hook (the same pattern
 * `lib/db.ts` uses for `DATABASE_URL`), which runs after this module's own top-level code — a
 * module-scope `const DIR = process.env.EMBED_MODEL_DIR ?? …` would already have frozen on the VM
 * default by the time that hook ran, and every test would silently look in the wrong place.
 */
async function load(): Promise<{ s: InferenceSession; v: Record<string, number> }> {
  if (session === undefined) {
    const tried = modelDirs();
    const dir = tried.find(complete);
    if (dir === undefined) {
      // A bare ENOENT from InferenceSession.create or readFileSync names a path, not a fix. On a
      // dev machine the fix is always the same command, so say it — see decisions in
      // task-5-brief.md: a silent skip here would let the punctuation regression test (below)
      // quietly never run, which is the one thing it exists to prevent.
      //
      // Every path tried is named, because the version that named only one sent a reader who had
      // already run `pnpm fetch-model` off to run it again.
      throw new Error(
        `Embedding model not found. Looked in: ${tried.join(', ')}. ` +
          `Run \`pnpm fetch-model\` (it writes to ${REPO_MODEL_DIR}), or set EMBED_MODEL_DIR to ` +
          `where it already is. Production VMs are provisioned per ops/SETUP.md.`,
      );
    }
    session = await InferenceSession.create(`${dir}/model.onnx`);
    vocab = JSON.parse(readFileSync(`${dir}/tokenizer.json`, 'utf8')).model.vocab;
  }
  return { s: session, v: vocab! };
}

/**
 * Whether `load()` has ever succeeded in this process. Not needed by any production caller — it
 * exists only so `lib/retrieval/index.test.ts` can assert, rather than silently assume, the
 * ordering precondition its one failure-path test depends on (that test is the sole place a bad
 * `EMBED_MODEL_DIR` can be observed, since `session` above is cached after the first successful
 * load and never rechecked). If you're reaching for this anywhere else, you probably want a
 * different design instead.
 */
export function isLoaded(): boolean {
  return session !== undefined;
}

/**
 * WordPiece, greedy longest-match — what bge's tokenizer.json describes.
 *
 * Exported for the tokenization tests below: both are pure functions of the vocab, so they can be
 * checked against real vocab entries without paying for an ONNX session load.
 */
/** `tokenizer.json`'s `model.max_input_chars_per_word`. Read from the file, not guessed. */
const MAX_WORD_CHARS = 100;

export function encode(v: Record<string, number>, s: string): number[] {
  const ids = [v['[CLS]']!];
  // Split on EVERY Unicode punctuation character, which is what BERT's BertPreTokenizer does
  // (HuggingFace's _is_punctuation: category \p{P} plus ASCII 33-47, 58-64, 91-96, 123-126).
  // Measured in R0: a hand-picked set like [.,?:;!] leaves '%' (37) and '-' (45) glued to their
  // neighbouring word, and 3 of 10 real strings then scored as low as cosine 0.868 against Python
  // — "12.4%", "18%", "Related-party". The seven strings without stray punctuation passed at
  // 0.999999 either way, which is exactly why this is easy to ship broken.
  //
  // Accents are stripped as well, which is the other half of what the file asks for. Read out of
  // `.models/bge-small-en-v1.5/tokenizer.json` on 18-Sep-2026: the normalizer is
  // `BertNormalizer{clean_text:true, handle_chinese_chars:true, strip_accents:null,
  // lowercase:true}`, and HuggingFace defaults `strip_accents` to the value of `lowercase` when it
  // is null — so it is on. Without this, `Śrī` is one [UNK] here and `sri` in the reference, and
  // the difference has no symptom: you still get a valid unit-length vector, just one that lands
  // somewhere slightly wrong. NFD splits a letter from its marks; \p{Mn} is the marks.
  //
  // `clean_text` and `handle_chinese_chars` from the same normalizer are still not implemented.
  const words = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/(\p{P})/gu, ' $1 ')
    .split(/\s+/)
    .filter(Boolean);

  // bge-small has 512 position embeddings, so [CLS] + subword ids + [SEP] must never exceed 512.
  // R1: the old cap ran only BETWEEN words ("if (ids.length >= 511) break"), so a single word that
  // explodes into many subword pieces (a hash, a URL, a run of digits, an unusual proper noun —
  // reproduced with 200 repetitions of a 15-character nonsense word, which WordPiece breaks into
  // 12 single/double-character pieces each) overshot 511 before that check ever ran, and the
  // unconditional [SEP] push after the loop pushed it further still. onnxruntime then throws
  // inside the position-embedding Add node ("512 by 518") instead of returning a valid embedding.
  // Checking per *token*, inside the inner loop, is what actually bounds the total.
  outer: for (const word of words) {
    // WordPiece emits a SINGLE [UNK] for the whole word when no decomposition covers it — that is
    // what tokenizer.json's WordpieceTokenizer does. Buffering locally and only committing to
    // `ids` on full success (or a lone [UNK] on failure) matches that; pushing each matched piece
    // straight into `ids`, as the previous version did, leaves partial-pieces-plus-one-[UNK] for a
    // word that fails partway through, which is a different (and longer) token sequence than the
    // reference tokenizer would produce for the same input.
    // A word longer than this is one [UNK], not a greedy decomposition of it — `tokenizer.json`
    // says `max_input_chars_per_word: 100` and the reader only ever consumed `.model.vocab`, so
    // this was the character-axis twin of the R1 bug above: a 500-character unbroken run (a URL, a
    // base64 blob pasted into a note) became ~400 subword pieces and ate the whole 512 budget,
    // silently truncating everything after it in the chunk.
    if (word.length > MAX_WORD_CHARS) {
      if (ids.length >= 511) break outer;
      ids.push(v['[UNK]']!);
      continue;
    }

    const pieces: number[] = [];
    let rest = word;
    let first = true;
    let ok = true;
    while (rest.length > 0) {
      let cut = rest.length;
      let piece: string | undefined;
      while (cut > 0) {
        const cand = first ? rest.slice(0, cut) : `##${rest.slice(0, cut)}`;
        if (v[cand] !== undefined) {
          piece = cand;
          break;
        }
        cut--;
      }
      if (piece === undefined) {
        ok = false;
        break;
      }
      pieces.push(v[piece]!);
      rest = rest.slice(cut);
      first = false;
    }
    for (const id of ok ? pieces : [v['[UNK]']!]) {
      // Past 511, the tail is dropped rather than the call failing — same policy as before, now
      // enforced tightly enough that [SEP] below can never push the total past 512.
      if (ids.length >= 511) break outer;
      ids.push(id);
    }
  }
  ids.push(v['[SEP]']!);
  return ids;
}

export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const { s, v } = await load();

  const out: number[][] = [];
  for (const text of texts) {
    const ids = encode(v, text);
    const mask = ids.map(() => 1n);
    const r = await s.run({
      input_ids: new Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      attention_mask: new Tensor('int64', BigInt64Array.from(mask), [1, ids.length]),
      token_type_ids: new Tensor('int64', BigInt64Array.from(ids.map(() => 0n)), [1, ids.length]),
    });
    const hidden = r['last_hidden_state']!;
    const data = hidden.data as Float32Array;
    // CLS pooling: bge uses the first token, not a mean over all of them. Getting this wrong
    // produces vectors that look fine and cluster wrongly.
    const cls = Array.from(data.slice(0, EMBED_DIM));
    const norm = Math.hypot(...cls);
    out.push(cls.map((x) => x / norm));
  }
  return out;
}

/** pgvector accepts a bracketed literal; node-postgres has no native type for it. */
export function toVector(v: number[]): string {
  return `[${v.join(',')}]`;
}
