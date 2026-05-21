---
name: powadb-scope
description: Prepare an implementation plan for MalikAza/powadb from a free-form scope description (no GitHub issue), present it for approval, then implement on a new branch. DO NOT commit, push, or open a PR — the user reviews everything first. Usage&nbsp;: `/powadb-scope <scope description> [--no-git]`.
argument-hint: "<scope description> [--no-git]"
---

# Resolve MalikAza/powadb scope: $ARGUMENTS

Take the free-form scope description, present an implementation plan for approval, then implement it. **You must NOT commit, push, or open any pull request** — the user reviews the diff and ships it themselves.

Run from the repo root. This is a single-repo Tauri 2 desktop app (React 19 frontend in `src/`, Rust backend in `src-tauri/`).

## Flag detection

The arguments are: `$ARGUMENTS`.

- If `--no-git` is present in the arguments:
  - **`--no-git` mode active**: skip **Step 2** (branch creation) entirely. The implementation happens directly on the current branch, with no git operations.
  - The scope is the remaining text (everything except `--no-git`).
- Otherwise, run all steps normally, using `$ARGUMENTS` as the scope.

> In the rest of this document, `<SCOPE>` refers to the scope text extracted from the arguments.

---

## Step 1 — Reformulate the scope

Reformulate `<SCOPE>` in a structured way to validate your understanding:

1. **Objective** — one short sentence describing the goal
2. **Expected behaviour** — what the end user should be able to do
3. **Out of scope** — what is explicitly not requested (if deducible)

If a major ambiguity blocks progress, ask one targeted question before continuing. Otherwise, state clear assumptions and call them out explicitly in the plan.

## Step 2 — Branch setup

> ⏭️ **Skip if `--no-git`**: go straight to Step 3.

1. Determine the type from `<SCOPE>`:
   - Bug fix → `bug/` prefix
   - Anything else (new feature, tweak, refactor…) → `feature/` prefix
2. Build a **short kebab-case slug** (3–6 words) summarising the scope. Example: scope "add a connection filter on the snippets page" → slug `connection-filter-snippets-page`.
3. Branch name:
   ```
   {feature|bug}/<slug>
   ```
   Example: `feature/connection-filter-snippets-page`

**Always branch off the current branch** (usually `dev`) — do NOT switch to `main` first. Capture the current branch, pull the latest from origin, then create the new branch from there:

```bash
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch origin
git pull origin "$CURRENT_BRANCH"
git checkout -b {feature|bug}/<slug>
```

Guardrails:
- If a branch with that name already exists locally, ask the user whether to reuse, rename, or abort — never silently overwrite.
- If `git status` shows uncommitted changes, **stop** and report. Do not stash or discard the user's work.
- If the current branch has no upstream (so `git pull` would fail), skip the pull and just branch off the current local HEAD — mention this in the hand-off.

## Step 3 — Analyze the scope

From `<SCOPE>`, identify:

1. **Type**: feature, bug fix, refactor, or other
2. **Side(s) impacted**: `frontend` (`src/`), `backend` (`src-tauri/`), or both
3. **Acceptance criteria** — explicit list of what must be delivered
4. **Dependencies** — implementation order imposed by technical couplings
5. **Open questions** — any ambiguity, to flag in the plan

## Step 4 — Explore before planning

Before writing the plan, build a mental map of the relevant code. For wide searches use `Agent` with `subagent_type=Explore`; for targeted lookups use `rg` / `fd` directly.

- Frontend layout: `src/components/`, `src/stores/` (Zustand), `src/ipc/` (Tauri command wrappers), `src/lib/`, `src/utils/`
- Backend layout: `src-tauri/src/commands/`, `src-tauri/src/drivers/`, plus `pool_registry.rs`, `job_registry.rs`, `storage.rs`
- Find similar existing patterns (commands, components, stores) and match their style
- Check existing shadcn/ui components in `src/components/ui/` before installing or hand-rolling new ones

## Step 5 — Implementation plan (plan mode)

Enter plan mode (`EnterPlanMode`) and structure the plan as follows. Present it, then wait for user approval before any implementation.

### Frontend (if relevant)
- Components to create / modify (kebab-case, ≤ ~400 lines each)
- Zustand stores affected (`src/stores/`)
- New IPC wrappers to add in `src/ipc/`
- Forms (React Hook Form + Zod schemas in `src/lib/schemas.ts`) if applicable
- Existing shadcn/ui primitives to reuse
- Routes / tabs affected, if applicable

### Backend (if relevant)
- New command(s) in `src-tauri/src/commands/<module>.rs`
- Registration in the `invoke_handler![...]` list in `src-tauri/src/lib.rs`
- Driver work in `src-tauri/src/drivers/{postgres,mysql}.rs` if it branches per `DbKind`
- Persistent state changes (`storage.rs`, SQL migrations inline in `Storage::open`)
- Pool / job / settings touchpoints (`pool_registry.rs`, `job_registry.rs`, `settings.rs`)
- Events emitted (`pools-changed`, dump progress, …)

### IPC contract changes
- New / changed command names, argument shapes (camelCase JS → snake_case Rust), and return types
- Corresponding typed wrapper additions to `src/ipc/index.ts`

### Implementation order
- Step-by-step sequence. When the change spans both halves, usually backend first (so the typed wrapper has something concrete to wrap), then frontend.

### Complexity & risks
- Estimate: low / medium / high
- Notable risks (driver-specific edge cases, schema migrations, perf, platform-specific behaviour under `#[cfg(target_os = "macos")]`)

### Assumptions
- Explicit list of assumptions you took to interpret `<SCOPE>` (especially useful here since there is no issue of record).

### Open questions
- Anything still ambiguous — flag, don't invent.

For non-trivial work, also create a TaskCreate list to track the implementation steps.

---

Present the full plan to the user and wait for approval before continuing.

## Step 6 — Implement

Once approved, match the existing codebase style strictly. Highlights:

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
- Use the existing `error.rs` error type; return `AppResult<T>` from commands
- Connection state via `pool_registry.rs`; long-running work via `job_registry.rs`
- Persistent state via `storage.rs`
- Keep `unsafe`, `unwrap`, `expect` out of command paths — propagate errors

### Cross-cutting
- Don't add features, abstractions, or error handling beyond what `<SCOPE>` requires
- Match neighbouring code's style; don't drive-by-refactor unrelated files
- Tests live next to the code they cover (Vitest for frontend, `#[cfg(test)] mod tests` for Rust) — only add tests if the scope explicitly asks for them or the change is non-trivial logic

## Step 7 — Quality checks

Run the relevant checks before reporting done.

Frontend (always, if `src/` changed):
```bash
npm run check        # runs typecheck + biome lint
# or individually:
npm run typecheck
npm run lint
```

If lint complains and the fix is mechanical, `npm run lint:fix` is fine.

Backend (if `src-tauri/` changed):
```bash
cd src-tauri
cargo check
cargo clippy -- -D warnings
cargo fmt --check
cd ..
```

If any check fails, fix the root cause — do not paper over it. Re-run until green.

> Note: PostToolUse hooks in `.claude/settings.json` run these checks automatically after edits. If they're already green, you don't need to re-run by hand — but do confirm before the hand-off.

## Step 8 — Hand-off (no commits, no PRs)

When everything is implemented and green:

1. **Do NOT** `git commit`
2. **Do NOT** `git push`
3. **Do NOT** create a pull request (no `gh pr create`)

Report back to the user with:

- The branch name (or "current branch" if `--no-git` was used)
- A summary of files created / modified (grouped by frontend / backend)
- Status of each quality check (typecheck, lint, clippy) — pass/fail with details if relevant
- Notable decisions and assumptions taken during implementation (especially anywhere `<SCOPE>` was ambiguous)
- Any open questions or follow-ups the user should be aware of before committing

The user owns the commit, push, and PR steps after reviewing the diff.
