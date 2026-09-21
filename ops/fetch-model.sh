#!/usr/bin/env bash
# The embedding model. ~130MB, two files, and it never changes — if it did, every vector in
# `chunks` would need rebuilding, which is a migration and not a download. That is why it is
# fetched rather than vendored: 130MB of binary in git costs every clone forever.
set -euo pipefail
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/.models/bge-small-en-v1.5}"
mkdir -p "$DIR"

# Pinned to a commit, not to `main`. `/resolve/main` is a moving reference — the repo owner can
# push to it at any time — and "it never changes" above is a statement about this model, not a
# guarantee Hugging Face offers about that URL. The byte count below would catch a moved upload,
# but it would catch it as a failure on a machine being set up by somebody with no way to know the
# upload moved. Pinning turns that into a non-event. 5c38ec7 is the revision every vector now in
# `chunks` came from; BAAI last pushed to this repo on 22-Feb-2024. Changing this line is a
# migration, not a download.
REV=5c38ec7c405ec4b44b94cc5a9bb96e735b38267a
base="https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/$REV"

# `[ -s file ]` only proves non-empty. A connection dropped mid-transfer leaves a truncated but
# non-empty file, and the next run would call that "already fetched" and hand a corrupt model to
# ONNX — which fails deep inside a matmul with an error naming nothing useful, not "the file is
# short". So: fetch to a `.part` name, validate the whole thing, and only `mv` into place on
# success. A failed or killed run never leaves anything this script (or a later embed.ts call)
# would mistake for good, and a good file already in place is left alone — no re-download.

# model.onnx: exact byte count measured once and recorded in tasks/build-log.md; this file never
# changes, so a mismatch means a bad transfer, not a stale expectation. Hugging Face reports the
# same 133,093,490 for onnx/model.onnx at the pinned revision, so the count and the pin agree.
MODEL_SIZE=133093490
model_ok() {
  [ -s "$1" ] && [ "$(wc -c <"$1")" -eq "$MODEL_SIZE" ]
}

# tokenizer.json had no integrity check at all: a truncated download is not valid JSON, so parsing
# it was the whole test, and a *complete* file of different content passed. It is 711,396 bytes —
# small enough to hash on every run — and a hash is the check a byte count cannot be, because a
# re-tokenized vocabulary of the same length would silently change every embedding this system
# produces. Computed 21-Sep-2026 from the copy in `.models/`, whose git blob id
# (688882a79f44442ddc1f60d70334a7ff5df0fb47) is the one Hugging Face reports for tokenizer.json at
# revision 5c38ec7 — so these are the bytes at the pinned commit, not the bytes on one laptop.
# (Hashed with node, not sha256sum/shasum: this is a Node project, node is already required to run
# this script's caller, and the two coreutils spellings differ across macOS and Linux.)
TOKENIZER_SHA256=d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66
sha256_of() {
  node -e 'const{createHash}=require("node:crypto");const{readFileSync}=require("node:fs");
    process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"
}
tokenizer_ok() {
  [ -s "$1" ] && [ "$(sha256_of "$1")" = "$TOKENIZER_SHA256" ]
}

if ! model_ok "$DIR/model.onnx"; then
  curl -fsSL -o "$DIR/model.onnx.part" "$base/onnx/model.onnx"
  if ! model_ok "$DIR/model.onnx.part"; then
    echo "fetch-model: model.onnx came down as $(wc -c <"$DIR/model.onnx.part") bytes," \
      "expected $MODEL_SIZE — discarding it" >&2
    rm -f "$DIR/model.onnx.part"
    exit 1
  fi
  mv "$DIR/model.onnx.part" "$DIR/model.onnx"
fi

if ! tokenizer_ok "$DIR/tokenizer.json"; then
  curl -fsSL -o "$DIR/tokenizer.json.part" "$base/tokenizer.json"
  if ! tokenizer_ok "$DIR/tokenizer.json.part"; then
    echo "fetch-model: tokenizer.json hashed $(sha256_of "$DIR/tokenizer.json.part")," \
      "expected $TOKENIZER_SHA256 — discarding it" >&2
    rm -f "$DIR/tokenizer.json.part"
    exit 1
  fi
  mv "$DIR/tokenizer.json.part" "$DIR/tokenizer.json"
fi

echo "model at $DIR (revision $REV)"
