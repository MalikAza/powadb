#!/usr/bin/env bash
# Wrapper for `tauri build` that injects the updater signing key from a local
# file when TAURI_SIGNING_PRIVATE_KEY is not already set in the environment.
# In CI, the secret is provided directly and this fallback is skipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/powadb.key}"

if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  if [[ -f "$KEY_PATH" ]]; then
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_PATH")"
    export TAURI_SIGNING_PRIVATE_KEY
    export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD-}"
  else
    cat >&2 <<EOF
ERROR: Tauri updater signing key not found.

  Looked at: $KEY_PATH
  Override with: TAURI_SIGNING_PRIVATE_KEY_PATH=/path/to/key

Generate a new keypair with:
  npm run tauri -- signer generate -w "$KEY_PATH" --ci -p ""
EOF
    exit 1
  fi
fi

./node_modules/.bin/tauri build "$@"
./scripts/hide-dmg-volume-icon.sh
