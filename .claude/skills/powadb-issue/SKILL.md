---
name: powadb-issue
description: Fetch a GitHub issue from MalikAza/powadb via the `gh` CLI (title, description, labels, comments) and resolve it on a new branch. DO NOT commit, push, or open a PR — the user reviews everything first. Usage&nbsp;: `/powadb-issue <issue number>`.
argument-hint: "<issue number>"
---

# Resolve MalikAza/powadb issue #$ARGUMENTS

Fetch issue **#$ARGUMENTS** from `MalikAza/powadb` and implement it. **You must NOT commit, push, or open any pull request** — the user reviews the diff and ships it themselves.

Run from the repo root. This is a single-repo Tauri 2 desktop app (React 19 frontend in `src/`, Rust backend in `src-tauri/`).

---

## Step 1 — Fetch the issue

Pull the issue body, metadata, and comments in one shot via `gh`:

```bash
gh issue view $ARGUMENTS --repo MalikAza/powadb \
  --json number,title,state,author,labels,milestone,assignees,url,body,comments,createdAt,updatedAt
```

For a human-readable view that includes the comment thread inline, also run:

```bash
gh issue view $ARGUMENTS --repo MalikAza/powadb --comments
```

If the command fails (auth, network, unknown issue), surface the exact error to the user and stop — do not guess the issue contents. If `gh auth status` shows the CLI is not logged in, ask the user to run `gh auth login` themselves.

Read carefully:
- **Title** and full **description**
- **Labels** — type hints (`bug`, `enhancement`, `feature`, etc.) and scope hints (`frontend`, `backend`, `tauri`, …)
- **Comments** in chronological order — these usually contain clarifications and final decisions that override the description
- **Assignees / milestone** — useful context, not blocking

## Step 2 — Analyze

From the fetched content, determine:

1. **Branch prefix** from labels:
   - `bug` / `type/bug` → `bug/`
   - `feature` / `enhancement` / `type/feature` → `feature/`
   - missing/other → `feature/` (default)
2. **Scope**: `frontend` (`src/`), `backend` (`src-tauri/`), or both
3. **Acceptance criteria** — every checkbox / explicit requirement
4. **Implementation order** — if the change spans both Rust and TS, usually do the Tauri command first, then wire the frontend
5. **Open questions** — if anything is genuinely ambiguous, ask the user before writing code. Do not invent product decisions.

For non-trivial work, create a TaskCreate list to track the steps.

## Step 3 — Branch setup

Build the branch name as kebab-case derived from the issue title:

```
{feature|bug}/$ARGUMENTS-<short-kebab-case-description>
```

Example: `feature/42-connection-pool-metrics`

**Always branch off the current branch** (usually `dev`) — do NOT switch to `main` first. Capture the current branch, pull the latest from origin, then create the new branch from there:

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin
git pull origin "$CURRENT_BRANCH"
git checkout -b {feature|bug}/$ARGUMENTS-<slug>
```

Guardrails:
- If a branch with that name already exists locally, ask the user whether to reuse, rename, or abort — never silently overwrite.
- If `git status` shows uncommitted changes, **stop** and report. Do not stash or discard the user's work.
- If the current branch has no upstream (so `git pull` would fail), skip the pull and just branch off the current local HEAD — mention this in the hand-off.

## Step 4 — Explore before editing

Before touching code, build a mental map. For wide searches use `Agent` with `subagent_type=Explore`; for targeted lookups use `rg` / `fd` directly.

- Frontend layout: `src/components/`, `src/stores/` (Zustand), `src/ipc/` (Tauri command wrappers), `src/lib/`, `src/utils/`
- Backend layout: `src-tauri/src/commands/`, `src-tauri/src/drivers/`, plus `pool_registry.rs`, `job_registry.rs`, `storage.rs`
- Find similar existing patterns (commands, components, stores) and match their style
- Check existing shadcn/ui components in `src/components/ui/` before installing or hand-rolling new ones

## Step 5 — Implement

Match the existing codebase style strictly. Highlights:

### Frontend (React 19 + Vite + Tailwind v4 + shadcn/ui + Zustand)
- TypeScript strict; no `any`, prefer `type` over `interface`, no `as` casts (use `satisfies`)
- Components ≤ ~400 lines; split when they grow
- State: Zustand stores in `src/stores/`; local UI state with `useState`
- Forms: React Hook Form + Zod resolver + shadcn `Form*` components
- Toasts via Sonner (`toast.success` / `.error` / `.promise`)
- Tauri IPC: wrap `invoke(...)` calls in `src/ipc/` modules — never call `invoke` directly from components
- Icons from `lucide-react`
- Styling via Tailwind v4 utilities + `tailwind-merge` / `clsx`; avoid inline `style` unless dynamic

### Backend (Rust + Tauri 2)
- Commands live in `src-tauri/src/commands/` and are registered in `lib.rs`
- DB drivers in `src-tauri/src/drivers/`
- Use the existing `error.rs` error type; return `Result<T, AppError>` from commands
- Connection state via `pool_registry.rs`; long-running work via `job_registry.rs`
- Persistent state via `storage.rs`
- Keep `unsafe`, `unwrap`, `expect` out of command paths — propagate errors

### Cross-cutting
- Don't add features, abstractions, or error handling beyond what the issue requires
- Match neighbouring code's style; don't drive-by-refactor unrelated files
- No tests — there is no test framework in this project

## Step 6 — Quality checks

Run the relevant checks before reporting done.

Frontend (always, if `src/` changed):
```bash
pnpm check        # runs typecheck + biome lint
# or individually:
pnpm typecheck
pnpm lint
```

If lint complains and the fix is mechanical, `pnpm lint:fix` is fine.

Backend (if `src-tauri/` changed):
```bash
cd src-tauri
cargo check
cargo clippy -- -D warnings
cargo fmt --check
cd ..
```

If any check fails, fix the root cause — do not paper over it. Re-run until green.

## Step 7 — Hand-off (no commits, no PRs)

When everything is implemented and green:

1. **Do NOT** `git commit`
2. **Do NOT** `git push`
3. **Do NOT** create a pull request (no `gh pr create`)

Report back to the user with:

- The branch name
- A summary of files created / modified (grouped by frontend / backend)
- Status of each quality check (typecheck, lint, clippy) — pass/fail with details if relevant
- Notable decisions taken during implementation (especially anywhere the issue was ambiguous)
- Any open questions or follow-ups the user should be aware of before committing

The user owns the commit, push, and PR steps after reviewing the diff.
