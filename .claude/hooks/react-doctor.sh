#!/usr/bin/env bash
# Stop hook: run react-doctor on files changed vs the base branch and surface
# any errors back to the agent so they get fixed before the turn ends.
#
# Exits 0 (silent pass) when:
#   - the hook was triggered by a previous stop-hook run (avoid infinite loops)
#   - no frontend files are dirty vs the base branch
# Exits 2 with diagnostics on stderr when react-doctor reports errors, which
# pulls the agent back to address them.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
payload=$(cat)

# Avoid infinite loops: if this Stop event was itself caused by a stop-hook
# blocking, don't re-run.
if [ "$(printf '%s' "$payload" | jq -r '.stop_hook_active // false')" = "true" ]; then
  exit 0
fi

cd "$ROOT" || exit 0

# Quick bail-out: if no frontend files differ from the base branch, skip the
# (relatively slow) react-doctor invocation entirely.
base="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
base="${base:-main}"
if ! git rev-parse --verify --quiet "$base" >/dev/null 2>&1; then
  # No base ref to diff against — let react-doctor decide what to do.
  base=""
fi

if [ -n "$base" ]; then
  changed=$(git diff --name-only "$base"...HEAD -- 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.js' 'src/**/*.jsx' 2>/dev/null; \
            git diff --name-only -- 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.js' 'src/**/*.jsx' 2>/dev/null; \
            git ls-files --others --exclude-standard -- 'src/**/*.ts' 'src/**/*.tsx' 'src/**/*.js' 'src/**/*.jsx' 2>/dev/null)
  if [ -z "$(printf '%s' "$changed" | tr -d '[:space:]')" ]; then
    exit 0
  fi
fi

# Run react-doctor scoped to changed files vs base, offline (no score API),
# failing only on errors. stderr/stdout are merged so we can surface them.
if ! out=$(pnpm dlx react-doctor@latest --diff "${base:-main}" --offline --fail-on error 2>&1); then
  {
    printf 'react-doctor found React issues that need fixing before this turn ends:\n\n'
    printf '%s\n' "$out"
    printf '\nRun `pnpm dlx react-doctor@latest --diff %s --verbose` for full details.\n' "${base:-main}"
  } >&2
  exit 2
fi

exit 0
