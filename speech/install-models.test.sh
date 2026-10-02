#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SCRIPT="$ROOT_DIR/install.command"
FIXTURE_DIR="$(mktemp -d)"
trap 'rm -rf "$FIXTURE_DIR"' EXIT

source "$INSTALL_SCRIPT"
PYTHON_BIN="$(command -v python3)"

assert_model_valid() {
  local kind="$1" directory="$2"
  if ! "verify_${kind}_model" "$directory"; then
    printf 'FAIL: %s model fixture should be accepted: %s\n' "$kind" "$directory" >&2
    exit 1
  fi
}

assert_model_invalid() {
  local kind="$1" directory="$2"
  if "verify_${kind}_model" "$directory"; then
    printf 'FAIL: incomplete %s model fixture was accepted: %s\n' "$kind" "$directory" >&2
    exit 1
  fi
}

asr_dir="$FIXTURE_DIR/asr"
mkdir -p "$asr_dir"
printf '{}\n' > "$asr_dir/config.json"
touch "$asr_dir/weights.safetensors"
assert_model_valid asr "$asr_dir"
rm "$asr_dir/weights.safetensors"
assert_model_invalid asr "$asr_dir"
touch "$asr_dir/weights.safetensors"
rm "$asr_dir/config.json"
assert_model_invalid asr "$asr_dir"

scoring_dir="$FIXTURE_DIR/scoring"
mkdir -p "$scoring_dir"
printf '{}\n' > "$scoring_dir/config.json"
printf '{"weight_map":{"layer":"model-00001-of-00001.safetensors"}}\n' > "$scoring_dir/model.safetensors.index.json"
touch "$scoring_dir/model-00001-of-00001.safetensors"
printf '{}\n' > "$scoring_dir/tokenizer.json"
assert_model_valid scoring "$scoring_dir"
rm "$scoring_dir/model-00001-of-00001.safetensors"
assert_model_invalid scoring "$scoring_dir"
touch "$scoring_dir/model-00001-of-00001.safetensors"
rm "$scoring_dir/tokenizer.json"
assert_model_invalid scoring "$scoring_dir"
printf '{"weight_map":{}}\n' > "$scoring_dir/model.safetensors.index.json"
assert_model_invalid scoring "$scoring_dir"
rm "$scoring_dir/config.json"
assert_model_invalid scoring "$scoring_dir"

printf '模型文件 fixture 校验通过。\n'
