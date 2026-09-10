#!/usr/bin/env bash
# The embedding model. ~130MB, two files, and it never changes — if it did, every vector in
# `chunks` would need rebuilding, which is a migration and not a download. That is why it is
# fetched rather than vendored: 130MB of binary in git costs every clone forever.
set -euo pipefail
DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)/.models/bge-small-en-v1.5}"
mkdir -p "$DIR"
base=https://huggingface.co/BAAI/bge-small-en-v1.5/resolve/main
[ -s "$DIR/model.onnx" ]     || curl -fsSL -o "$DIR/model.onnx"     "$base/onnx/model.onnx"
[ -s "$DIR/tokenizer.json" ] || curl -fsSL -o "$DIR/tokenizer.json" "$base/tokenizer.json"
echo "model at $DIR"
