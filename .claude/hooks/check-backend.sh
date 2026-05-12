#!/usr/bin/env bash
# PostToolUse feedback hook for the Rust/Tauri backend.
# Reads the Claude Code hook payload from stdin, runs cargo fmt/check/clippy
# when a backend file was touched, and exits 2 on failure so asyncRewake
# pulls the model back with the error output.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
TAURI="$ROOT/src-tauri"
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)

# Skip if no path or path isn't inside the Rust crate.
case "$f" in
  "$TAURI"/*.rs|"$TAURI"/Cargo.toml|"$TAURI"/Cargo.lock) ;;
  *) exit 0 ;;
esac

cd "$TAURI" || exit 0

if ! out=$(cargo fmt --check 2>&1); then
  printf 'Backend rustfmt failed (cargo fmt --check):\n%s\n' "$out"
  exit 2
fi

if ! out=$(cargo check --message-format=short 2>&1); then
  printf 'Backend cargo check failed:\n%s\n' "$out"
  exit 2
fi

if ! out=$(cargo clippy --message-format=short -- -D warnings 2>&1); then
  printf 'Backend cargo clippy failed:\n%s\n' "$out"
  exit 2
fi

exit 0
