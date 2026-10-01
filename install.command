#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"
TTS_MODEL_DIR="$ROOT_DIR/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16"
IMAGE_MODEL_DIR="$ROOT_DIR/models/Qwen-Image-2.1-MLX-4bit"
APP_URL="http://127.0.0.1:8788/"
IMAGE_MODEL_REPO="JoyFusionAI/Qwen-Image-2.1-MLX-4bit"
MFLUX_COMMIT="8c00dab2"

say() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\n安装未完成：%s\n' "$1" >&2
  printf '修复提示后可再次双击 install.command；下载会从已完成的文件继续。\n' >&2
  exit 1
}

require_platform() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail "此安装脚本适用于 Apple Silicon macOS。"
  fi
  if [[ "$(uname -m)" != "arm64" ]]; then
    fail "当前机器不是 Apple Silicon；MLX 模型无法在此环境运行。"
  fi
}

ensure_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    return
  fi

  say "正在请求安装 Apple Command Line Tools"
  xcode-select --install >/dev/null 2>&1 || true
  printf '请在 macOS 弹出的窗口中完成安装。安装结束后回到这里按回车继续。\n'
  read -r _
  xcode-select -p >/dev/null 2>&1 || fail "Apple Command Line Tools 尚未完成安装。"
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    return
  fi

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
    return
  fi
  if [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
    return
  fi

  say "正在安装 Homebrew"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  command -v brew >/dev/null 2>&1 || fail "Homebrew 安装后仍不可用。"
}

ensure_node() {
  local node_bin node_major
  node_bin="$(command -v node || true)"
  node_major=0
  if [[ -n "$node_bin" ]]; then
    node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || printf '0')"
  fi

  if [[ "$node_major" -lt 22 ]]; then
    say "正在准备 Node.js 22"
    brew install node@22
    PATH="$(brew --prefix node@22)/bin:$PATH"
    export PATH
  fi

  node_bin="$(command -v node || true)"
  [[ -n "$node_bin" ]] || fail "找不到 Node.js。"
  node_major="$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')"
  [[ "$node_major" -ge 22 ]] || fail "需要 Node.js 22 或更新版本，当前版本为 $("$node_bin" --version)。"
  printf 'Node.js：%s\n' "$("$node_bin" --version)"
}

verify_tts_model() {
  "$PYTHON_BIN" - "$TTS_MODEL_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
index_path = root / "model.safetensors.index.json"
if not (root / "config.json").is_file() or not index_path.is_file():
    raise SystemExit(1)
try:
    weight_map = json.loads(index_path.read_text(encoding="utf-8")).get("weight_map", {})
except (OSError, json.JSONDecodeError):
    raise SystemExit(1)
shards = set(weight_map.values())
if not shards or any(not (root / shard).is_file() for shard in shards):
    raise SystemExit(1)
if not (root / "speech_tokenizer" / "model.safetensors").is_file():
    raise SystemExit(1)
PY
}

verify_image_model() {
  "$PYTHON_BIN" - "$IMAGE_MODEL_DIR" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
for component in ("vae", "transformer", "text_encoder"):
    index_path = root / component / "model.safetensors.index.json"
    if not index_path.is_file():
        raise SystemExit(1)
    try:
        weight_map = json.loads(index_path.read_text(encoding="utf-8")).get("weight_map", {})
    except (OSError, json.JSONDecodeError):
        raise SystemExit(1)
    shards = set(weight_map.values())
    if not shards or any(not (root / component / shard).is_file() for shard in shards):
        raise SystemExit(1)
if not (root / "processor" / "tokenizer.json").is_file():
    raise SystemExit(1)
PY
}

check_free_space() {
  local missing_gib required_gib available_kib
  missing_gib=0
  if ! verify_tts_model >/dev/null 2>&1; then
    missing_gib=$((missing_gib + 5))
  fi
  if ! verify_image_model >/dev/null 2>&1; then
    missing_gib=$((missing_gib + 23))
  fi
  if [[ "$missing_gib" -eq 0 ]]; then
    return
  fi

  required_gib=$((missing_gib + 5))
  available_kib="$(df -Pk "$ROOT_DIR" | awk 'END {print $4}')"
  if [[ "$available_kib" -lt $((required_gib * 1024 * 1024)) ]]; then
    fail "模型下载约需 ${missing_gib} GiB，另建议保留 5 GiB 空间；当前磁盘空间不足。"
  fi
  printf '模型下载和临时文件预计至少需要约 %s GiB 可用空间。\n' "$required_gib"
}

ensure_python_environment() {
  say "正在准备 Python 3.13 虚拟环境"
  uv python install 3.13

  if [[ -x "$PYTHON_BIN" ]]; then
    local python_minor backup_dir
    python_minor="$("$PYTHON_BIN" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)"
    if [[ "$python_minor" != "3.13" ]]; then
      backup_dir="$ROOT_DIR/.venv.backup.$(date '+%Y%m%d-%H%M%S')"
      mv "$VENV_DIR" "$backup_dir"
      printf '保留了旧虚拟环境：%s\n' "$backup_dir"
    fi
  elif [[ -e "$VENV_DIR" ]]; then
    local backup_dir
    backup_dir="$ROOT_DIR/.venv.backup.$(date '+%Y%m%d-%H%M%S')"
    mv "$VENV_DIR" "$backup_dir"
    printf '保留了旧虚拟环境：%s\n' "$backup_dir"
  fi

  if [[ ! -x "$PYTHON_BIN" ]]; then
    uv venv --python 3.13 "$VENV_DIR"
  fi

  say "正在安装本地语音和图片模型运行环境"
  uv pip install --python "$PYTHON_BIN" \
    mlx-audio \
    huggingface_hub \
    "mflux @ git+https://github.com/mflux-community/mflux.git@${MFLUX_COMMIT}"
  [[ -x "$VENV_DIR/bin/hf" ]] || fail "Hugging Face 下载命令没有安装成功。"
  [[ -x "$VENV_DIR/bin/mflux-generate-qwen-2.1" ]] || fail "mflux 的 Qwen Image 2.1 命令没有安装成功。"
}

download_models() {
  local hf_bin
  hf_bin="$VENV_DIR/bin/hf"

  if verify_tts_model; then
    printf '语音模型已完整，跳过下载。\n'
  else
    say "正在下载 Qwen3-TTS VoiceDesign 语音模型"
    "$hf_bin" download \
      mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16 \
      --local-dir "$TTS_MODEL_DIR"
    verify_tts_model || fail "语音模型文件校验未通过。"
  fi

  if verify_image_model; then
    printf '图片模型已完整，跳过下载。\n'
  else
    say "正在下载 Qwen Image 2.1 MLX 4-bit 图片模型（约 20 GB）"
    "$hf_bin" download "$IMAGE_MODEL_REPO" --local-dir "$IMAGE_MODEL_DIR"
    verify_image_model || fail "图片模型文件校验未通过。"
  fi
}

config_is_ready() {
  "$NODE_BIN" -e 'let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{try{const c=JSON.parse(input);process.exit(c.modelReady&&c.runtimeReady&&c.illustrationReady?0:1)}catch{process.exit(1)}})'
}

open_existing_server() {
  local config
  config="$(curl -fsS --max-time 2 "$APP_URL/api/config" 2>/dev/null || true)"
  if [[ -n "$config" ]] && printf '%s' "$config" | config_is_ready; then
    say "本机练习服务已经运行，正在打开页面"
    open "$APP_URL"
    return 0
  fi
  if lsof -nP -iTCP:8788 -sTCP:LISTEN >/dev/null 2>&1; then
    fail "8788 端口已被其他程序占用。请关闭该程序后重新运行安装脚本。"
  fi
  return 1
}

start_app() {
  local server_pid attempt config ready
  if open_existing_server; then
    return
  fi

  say "正在启动 KET Speaking 本地 Web App"
  cd "$ROOT_DIR"
  npm run start:tts &
  server_pid=$!
  trap 'kill "$server_pid" >/dev/null 2>&1 || true' EXIT INT TERM
  ready=0

  for attempt in {1..60}; do
    config="$(curl -fsS --max-time 2 "$APP_URL/api/config" 2>/dev/null || true)"
    if [[ -n "$config" ]] && printf '%s' "$config" | config_is_ready; then
      ready=1
      break
    fi
    if ! kill -0 "$server_pid" >/dev/null 2>&1; then
      wait "$server_pid" || true
      fail "本地服务未能启动；请查看上方错误信息。"
    fi
    sleep 1
  done

  if [[ "$ready" -ne 1 ]]; then
    fail "等待本地服务就绪超时；请查看上方错误信息。"
  fi

  say "安装完成，正在打开练习页面"
  open "$APP_URL"
  printf '服务会保持运行。结束时在此终端按 Control-C。\n'
  wait "$server_pid"
}

main() {
  require_platform
  ensure_command_line_tools
  ensure_homebrew

  if ! command -v uv >/dev/null 2>&1; then
    say "正在安装 uv"
    brew install uv
  fi

  ensure_node
  NODE_BIN="$(command -v node)"
  export NODE_BIN
  export PATH="$VENV_DIR/bin:$PATH"

  ensure_python_environment
  check_free_space
  download_models

  printf '\n注意：Qwen Image 2.1 衍生模型采用 Qwen Research License；商业用途需另行取得许可。\n'
  start_app
}

main "$@"
