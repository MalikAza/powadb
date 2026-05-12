#!/usr/bin/env bash
# PostToolUse feedback hook for the React/TS frontend.
# Reads the Claude Code hook payload from stdin, runs biome + tsc when a
# frontend source file was touched, and exits 2 on failure so asyncRewake
# pulls the model back with the error output.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)

# Skip if no path or path isn't inside this project's frontend tree.
case "$f" in
  "$ROOT"/src/*) ;;
  *) exit 0 ;;
esac

# Skip non-frontend extensions.
case "$f" in
  *.ts|*.tsx|*.js|*.jsx|*.css) ;;
  *) exit 0 ;;
esac

cd "$ROOT" || exit 0

if ! out=$(pnpm -s lint 2>&1); then
  printf 'Frontend lint failed (biome check src):\n%s\n' "$out"
  exit 2
fi

if ! out=$(pnpm -s typecheck 2>&1); then
  printf 'Frontend typecheck failed (tsc --noEmit):\n%s\n' "$out"
  exit 2
fi

exit 0
