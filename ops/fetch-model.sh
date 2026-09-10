#!/usr/bin/env bash
# The embedding model. ~130MB, two files, and it never changes — if it did, every vector in
# `chunks` would need rebuilding, which is a migration and not a download. That is why it is
# fetched rather than vendored: 130MB of binary in git costs every clone forever.
set -euo pipefail
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/.models/bge-small-en-v1.5}"
mkdir -p "$DIR"
base=https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main

# `[ -s file ]` only proves non-empty. A connection dropped mid-transfer leaves a truncated but
# non-empty file, and the next run would call that "already fetched" and hand a corrupt model to
# ONNX — which fails deep inside a matmul with an error naming nothing useful, not "the file is
# short". So: fetch to a `.part` name, validate the whole thing, and only `mv` into place on
# success. A failed or killed run never leaves anything this script (or a later embed.ts call)
# would mistake for good, and a good file already in place is left alone — no re-download.

# model.onnx: exact byte count measured once and recorded in tasks/build-log.md; this file never
# changes, so a mismatch means a bad transfer, not a stale expectation.
MODEL_SIZE=133093490
model_ok() {
  [ -s "$DIR/model.onnx" ] && [ "$(wc -c <"$DIR/model.onnx")" -eq "$MODEL_SIZE" ]
}

# tokenizer.json has no byte count on record to check against, but a truncated download is not
# valid JSON — parsing it is the check. (Uses node, not python: this is a Node project and node is
# already required to run this script's caller.)
tokenizer_ok() {
  [ -s "$DIR/tokenizer.json" ] &&
    node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$DIR/tokenizer.json" 2>/dev/null
}

if ! model_ok; then
  curl -fsSL -o "$DIR/model.onnx.part" "$base/onnx/model.onnx"
  mv "$DIR/model.onnx.part" "$DIR/model.onnx"
  if ! model_ok; then
    echo "fetch-model: model.onnx came down as $(wc -c <"$DIR/model.onnx") bytes," \
      "expected $MODEL_SIZE — removing it" >&2
    rm -f "$DIR/model.onnx"
    exit 1
  fi
fi

if ! tokenizer_ok; then
  curl -fsSL -o "$DIR/tokenizer.json.part" "$base/tokenizer.json"
  mv "$DIR/tokenizer.json.part" "$DIR/tokenizer.json"
  if ! tokenizer_ok; then
    echo "fetch-model: tokenizer.json failed to parse as JSON after download — removing it" >&2
    rm -f "$DIR/tokenizer.json"
    exit 1
  fi
fi

echo "model at $DIR"
