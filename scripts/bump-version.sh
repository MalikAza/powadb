#!/usr/bin/env bash
# Bump version across package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml.
# Usage: ./scripts/bump-version.sh 0.2.0
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>  (e.g. 0.2.0)" >&2
  exit 1
fi

NEW=$1
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: '$NEW' is not a valid semver string" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# package.json — prefer npm so the lockfile updates too
npm version --no-git-tag-version --allow-same-version "$NEW" >/dev/null

# src-tauri/tauri.conf.json — only the top-level "version" field
node -e '
const fs = require("fs");
const path = "src-tauri/tauri.conf.json";
const c = JSON.parse(fs.readFileSync(path, "utf8"));
c.version = process.argv[1];
fs.writeFileSync(path, JSON.stringify(c, null, 2) + "\n");
' "$NEW"

# src-tauri/Cargo.toml — only the [package] version line
perl -i -pe '
  if (/^\[package\]/ ... /^\[(?!package\])/) {
    s/^version\s*=\s*"[^"]*"/version = "'"$NEW"'"/;
  }
' src-tauri/Cargo.toml

# Refresh Cargo.lock
( cd src-tauri && cargo update -p powadb --offline >/dev/null 2>&1 || cargo generate-lockfile >/dev/null 2>&1 || true )

echo "Bumped to $NEW. Next steps:"
echo "  ⚠️  Don't forget to update CHANGELOG.md with the changes for v$NEW before committing."
echo "  git add -A && git commit -m \"chore: release v$NEW\""
echo "  git push"
echo "  git tag v$NEW && git push origin v$NEW"
