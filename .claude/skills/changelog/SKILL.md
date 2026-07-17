---
name: changelog
description: Inspect everything that changed since the last released version and prepend a new, user-facing entry to CHANGELOG.md. Purely technical changes (refactors, tests, CI, chores) with no visible effect are excluded. The version number is passed as an argument or left as a placeholder for the user to fill. Uses today's date. Usage&nbsp;: `/changelog [version] [--dry-run] [--from <tag>] [--internal]`.
argument-hint: "[version] [--dry-run] [--from <tag>] [--internal]"
---

# Update CHANGELOG.md for the next release

Look at everything that changed since the **last released version**, then prepend a new **user-facing** entry to `CHANGELOG.md`. Run from the repo root.

The audience is **end users of PowaDB**, not developers. The golden rule: **if a change has no observable effect for someone using the app, it does NOT belong in the changelog.** Refactors, test additions, CI tweaks, dependency bumps with no behaviour change, internal renames, lint/format churn — all excluded by default.

The arguments are: `$ARGUMENTS`.

## Step 0 — Parse arguments

Split `$ARGUMENTS` into flags and a positional version:

- **`version`** — the first non-flag token that looks like a semver (`X.Y.Z` or `X.Y.Z-N`, e.g. `0.12.0` or `0.12.0-4`). Optional.
  - If provided, use it verbatim in the new heading.
  - If **absent**, use the literal placeholder `X.Y.Z` in the heading so the user can replace it after (mention this clearly in the hand-off).
- **`--dry-run`** — do all the analysis and print the proposed entry, but **do not write** to `CHANGELOG.md`.
- **`--from <tag>`** — override the base for the diff (default: the latest git tag). Useful when the last tag isn't the true last release.
- **`--internal`** — additionally include a trailing `### Internal` section for notable technical changes (matching the existing convention used in `0.11.0`). Off by default. Even with this flag, the user-facing sections stay strictly user-facing; tech goes only under `### Internal`.

## Step 1 — Determine the diff range

Find the last released version from git tags (the repo tags releases as `vX.Y.Z`):

```bash
LAST_TAG=$(git tag --sort=-v:refname | head -1)   # unless --from was given
```

- If `--from <tag>` was passed, use that instead of `LAST_TAG`.
- Sanity-check the tag exists (`git rev-parse "$LAST_TAG"`). If there are no tags at all, fall back to summarising the whole history and say so in the hand-off.
- The range to inspect is `"$LAST_TAG"..HEAD`.

Cross-check the tag against the top entry already in `CHANGELOG.md`. If the newest heading in the file is already **newer than or equal to** `LAST_TAG` and matches the version you're about to write, you'd be duplicating — stop and ask the user whether to update the existing top entry instead of prepending a new one.

## Step 2 — Gather the changes

Collect the raw material. Prefer full context over a compressed log:

```bash
# One-line overview
git log --oneline "$LAST_TAG"..HEAD

# Full messages + bodies (bodies often explain the user-facing intent)
git log "$LAST_TAG"..HEAD --format='%h%x09%s%n%b'

# Which files changed, to judge scope (user-facing vs plumbing)
git diff --stat "$LAST_TAG"..HEAD
```

Also account for **work in progress that isn't committed yet** — the git status snapshot may show modified files. If there are meaningful uncommitted changes and no clear release boundary, mention them in the hand-off, but base the changelog on committed history unless the user says otherwise.

For any commit whose user impact is unclear from the message alone, read the actual diff (`git show <hash>` or `git diff "$LAST_TAG"..HEAD -- <path>`) before deciding whether — and how — to describe it. Don't paraphrase a commit subject you don't understand.

## Step 3 — Classify each change

For every change since the base, decide: **does a user notice this?**

**Include** (user-facing) — new features, new supported databases/engines, UI additions or changes, changed defaults or behaviour the user sees, performance improvements they'd feel, bug fixes to something they could hit, security fixes that affect their data/credentials, removed or deprecated features, changed keyboard shortcuts, new settings.

**Exclude** (technical / invisible) — refactors and code moves, internal renames, added/changed tests, CI/workflow changes, lint/format/style churn, dependency bumps with no behaviour change, new internal abstractions or types, comments/docs-only changes, `chore:`/`refactor:`/`test:`/`ci:`/`style:` commits **unless** the diff reveals a genuine user-visible effect.

Judgement calls:
- A refactor that also fixes a visible bug → include the **bug fix**, describe the user effect, not the refactor.
- A perf refactor with a felt improvement (faster load, lower memory, snappier UI) → include it as a **Changed** item phrased around the experience.
- A dependency bump that changes behaviour or fixes a security issue → include the **effect**, not the bump.
- When genuinely unsure whether users care, lean toward **excluding** from the main sections and list it under "excluded" in the recap so the user can pull it back in.

## Step 4 — Draft the entry

Match the existing house style in `CHANGELOG.md` exactly (read the top ~40 lines first to calibrate tone):

- Format is **Keep a Changelog**. Heading: `## [<version>] - <today>`.
- **Write in English** — the whole changelog is in English, regardless of the language of this conversation.
- Today's date, computed dynamically — do **not** hardcode:
  ```bash
  TODAY=$(date +%Y-%m-%d)
  ```
- Group items under the standard sections, in this order, omitting any that are empty:
  `### Security`, `### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`.
  (Add `### Internal` **last**, only if `--internal` was passed.)
- Item style: start impactful items with a **bold lead-in** naming the feature/area, then a plain-language sentence about what it means for the user. Small items can be a single bolded-noun-free line. Mirror the density of recent entries.
- **Pre-release / beta**: if the version has a `-N` suffix (or the user says it's a beta), add a `>` blockquote note under the heading in the same voice as existing beta entries (e.g. `> **Beta release.** …`). If a specific feature is beta-only, say which part is beta and which is stable.
- No developer jargon in user-facing sections: no file names, function names, type names, module paths, or PR/commit hashes. Talk about *what the user can now do* or *what stopped going wrong*.
- Link to README anchors where the existing changelog does (e.g. upgrade notes) if a change needs user action.

## Step 5 — Write it (unless `--dry-run`)

Prepend the new `## [<version>] - <today>` section to the **top** of `CHANGELOG.md`, above the current newest entry. The file has no `# Changelog` title preamble — the first line is the newest `## [...]` heading — so insert directly above it, followed by a blank line.

Do **not** touch version files (`package.json`, `Cargo.toml`, `tauri.conf.json`) — that's `scripts/bump-version.sh`'s job. This skill only edits `CHANGELOG.md`.

Do **not** commit, stage, or push. The user reviews the diff and ships it themselves.

If `--dry-run`, skip writing and just show the proposed entry in your reply.

## Step 6 — Recap for the user

Report back with:

1. **The base** you diffed against (`LAST_TAG` or `--from`) and the number of commits inspected.
2. **The version + date** written (or the `X.Y.Z` placeholder, with a reminder to replace it — and that `./scripts/bump-version.sh <version>` bumps the version files separately).
3. **The entry** you wrote (or would write, for `--dry-run`).
4. **Excluded changes** — a short bulleted list of the notable technical/internal changes you left out (refactors, tests, chores…), each with a one-line reason. This is deliberate: it lets the user judge whether any of them actually deserve a line (or an `### Internal` section via `--internal`). Don't hide what you dropped.
5. **Open questions** — any commit whose user impact you couldn't confidently determine.
