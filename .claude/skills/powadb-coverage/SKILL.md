---
name: powadb-coverage
description: Audit frontend (Vitest) and backend (cargo-llvm-cov) test suites, measure coverage, identify the highest-impact gaps, propose a target list for approval, then add or extend tests to lift coverage. DO NOT commit, push, or open a PR — the user reviews everything first. Usage&nbsp;: `/powadb-coverage [frontend|backend|both] [--target N] [--no-write]`.
argument-hint: "[frontend|backend|both] [--target N] [--no-write]"
---

# Audit & lift PowaDB test coverage: $ARGUMENTS

Goal: measure the current coverage for frontend and/or backend, identify the files where extra tests will move the needle most, get the user's sign-off on a target list, then write tests and re-measure to report the delta. **You must NOT commit, push, or open any pull request** — the user reviews the diff and ships it themselves.

Run from the repo root (`/Users/aza/personnal/web/powadb`). Layout is documented in `CLAUDE.md`: React 19 / TS frontend in `src/`, Rust backend in `src-tauri/`. Tests live next to the code they cover.

## Flag parsing

Arguments are: `$ARGUMENTS`.

- **Scope token** (`frontend`, `backend`, or `both`): default `both`. Restricts the audit/improvements to that side.
- **`--target N`**: explicit numeric coverage target (line %) for the scope, e.g. `--target 80`. If absent, default to **+5 percentage points** above the current baseline for the scope (capped at 95%).
- **`--no-write`**: audit & report only, skip Step 5 (test writing). Useful for a status check.

> In the rest of this document, `<SCOPE>` refers to the scope token resolved from the arguments.

## Step 1 — Sanity checks & baseline

Verify the tooling is wired up before measuring:

```bash
# Frontend
node --version
npm ls vitest --depth=0 2>/dev/null | head -3

# Backend (only if <SCOPE> includes backend)
cargo --version
cargo llvm-cov --version 2>/dev/null || echo "MISSING: cargo-llvm-cov"
```

If `cargo-llvm-cov` is missing and backend is in scope, tell the user once and offer:

```bash
cargo install cargo-llvm-cov --locked
```

Do NOT install it without asking — it's a global tool install. If the user declines, fall back to plain `cargo test --lib` for backend (you'll have test pass/fail but no line-level coverage).

If `git status` shows uncommitted changes that are unrelated to tests, **stop** and report. Do not stash or discard the user's work.

## Step 2 — Run the suites & gather coverage

Always run both passes in this order: **tests first** (catch failing tests before talking about coverage), **then coverage**.

### Frontend (if `<SCOPE>` ∈ {`frontend`, `both`})

```bash
npm test                 # vitest run — must be green before proceeding
npm run test:coverage    # writes coverage/lcov.info + coverage/index.html
```

If `npm test` fails, **stop the coverage workflow** and switch to fixing the failing tests first — report which ones and ask the user whether to fix them or abort. A red suite makes the coverage numbers meaningless.

Parse `coverage/coverage-summary.json` if present, otherwise extract the totals printed by the v8 reporter. Capture:

- `total.lines.pct`, `total.statements.pct`, `total.branches.pct`, `total.functions.pct`
- Per-file `lines.pct` for everything under `src/` not excluded by `vitest.config.ts` / `codecov.yml`

### Backend (if `<SCOPE>` ∈ {`backend`, `both`})

```bash
cd src-tauri
cargo test --lib                                            # must be green
cargo llvm-cov --lib --lcov --output-path lcov.info         # if available
cargo llvm-cov report --summary-only                        # human-readable totals
cd ..
```

Capture overall line %, plus per-file line % from the report. If `cargo-llvm-cov` is unavailable, skip coverage numbers and just record which files have *no* `#[cfg(test)] mod tests` block (those are the obvious gaps).

### Coverage exclusions (do not write tests for these)

From `vitest.config.ts` and `codecov.yml`:

- Frontend ignore: `src/components/ui/**`, `src/main.tsx`, `src/vite-env.d.ts`, `src/types.ts`, `src/ipc/**`
- Backend ignore: `src-tauri/src/main.rs`

Also skip anything that's purely a Tauri command wrapper around IPC — those are integration-tested via the live app, not unit-tested.

## Step 3 — Identify high-impact targets

For each in-scope side, build a ranked target list. Sort by **impact = (uncovered lines) × (testability factor)** rather than raw percentage — a 40 %-covered 200-line file beats a 0 %-covered 10-line file.

Heuristic for **testability factor** (1 = easy, 0 = avoid):

- **1.0** — Pure functions, parsers, formatters, validators, DSL helpers, store reducers, utility modules (`src/lib/`, `src/utils/`)
- **0.8** — React components with simple props → render output (no heavy mocking)
- **0.6** — Rust modules with deterministic logic and no DB / network (`error.rs`, helpers, `commands/*_util.rs`, capability mapping, SQL builders)
- **0.3** — Components that touch IPC, stores, or async effects (need careful mocking)
- **0.1** — Anything that requires a live DB connection, the Tauri runtime, or platform-specific code

Discard targets with factor ≤ 0.2 unless the user explicitly asked for them — the test cost will exceed the coverage gain. Cap the proposal at the top **8 files per side** so the diff stays reviewable.

For each target, jot down (you'll need this in Step 4):

- Path & current line %
- A one-line description of *what the file does*
- 2–4 specific test cases worth adding (happy path + the obvious edge cases)
- Existing test infrastructure to lean on (sibling `.test.ts(x)` files, helpers in `src/test/` if present, Rust `tempfile::tempdir()` / `Storage::open_in_memory` patterns)

## Step 4 — Present the plan for approval

Report to the user, in this order:

1. **Baseline coverage**, per side: lines / statements / branches / functions %.
2. **Target**: the resolved `--target N` (or the default baseline + 5 pp).
3. **Test-suite status**: pass/fail counts, any flaky or skipped tests noticed.
4. **Proposed targets** as a table:

   | Side | File | Current % | Uncovered lines | Why it's worth it | Tests to add |
   |------|------|-----------|-----------------|-------------------|--------------|
   | … | … | … | … | … | … |

5. **Out of scope** — files you considered and rejected (with reason: excluded by config, low testability, integration-only).
6. **Estimated effort**: low / medium / high, and how confident you are the proposed tests will hit the target.

Then **wait for user approval** before writing any tests. If `--no-write` is set, stop here: this is the deliverable.

If the user wants to add, drop, or re-order targets, do so and re-confirm before continuing.

## Step 5 — Write the tests

Walk the approved target list **one file at a time**. For each:

1. Read the source file fully to understand its public surface and pitfalls.
2. Read any sibling tests (or analogous tests elsewhere in the repo) and match their style — imports, helper usage, naming, assertion library calls.
3. Add tests next to the code:
   - Frontend: `<file>.test.ts` or `<file>.test.tsx` colocated. Use Vitest's `describe` / `it` / `expect`, `@testing-library/react` for components (already a dep — check `package.json` before adding new libs), `vi.fn()` / `vi.mock()` for mocks.
   - Backend: an inline `#[cfg(test)] mod tests { … }` block at the bottom of the file. Use `tempfile::TempDir` for filesystem fixtures, `sqlx::SqlitePool` in-memory (`sqlite::memory:`) for storage-layer tests, `tokio::test` for async.
4. Run the relevant subset to check it goes green:
   - Frontend: `npx vitest run path/to/file.test.ts`
   - Backend: `cd src-tauri && cargo test --lib <module>::tests`
5. If a test you wrote keeps failing, **read the code again** — a failing test is data, not an obstacle. Either the test was wrong (fix it) or the code has a bug (stop and report it; do not "fix" production code without the user's say-so unless it's a trivial typo).

**Hard rules while writing tests:**

- **No mocking the DB drivers to assert "the code calls sqlx".** That's a tautology. Test the *logic around* the DB calls (parameter building, result mapping, error translation), not the call itself.
- **No tests that just re-encode the implementation.** A test that has to change every time the implementation changes is noise.
- **No new test utilities or abstractions** unless you'll reuse them ≥ 3 times. Inline duplication is fine.
- **Don't touch `src/components/ui/**`** — shadcn-managed.
- **Don't add new runtime dependencies.** Test-only `devDependencies` are OK but ask first.
- TypeScript strict applies to tests too: no `any`, no unchecked `as` casts.

## Step 6 — Re-measure & verify

After the batch is written, re-run the full coverage pass:

```bash
# Frontend
npm test
npm run test:coverage

# Backend
cd src-tauri && cargo test --lib && cargo llvm-cov --lib --summary-only && cd ..
```

Also run the project's standard quality gates so the new files don't break the build:

```bash
npm run check                                    # if src/ changed
cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check && cd ..   # if src-tauri/ changed
```

If clippy or biome complains in test code, fix the root cause. Test code is real code.

> Note: PostToolUse hooks in `.claude/settings.json` already run check-frontend.sh / check-backend.sh after edits. If they're green, you don't need to re-run by hand — but do confirm before hand-off.

## Step 7 — Hand-off (no commits, no PRs)

When the batch is done:

1. **Do NOT** `git commit`
2. **Do NOT** `git push`
3. **Do NOT** create a pull request

Report back to the user with:

- **Coverage delta**, per side: baseline → new, per metric (lines / branches / functions). Highlight whether the resolved `--target` was hit.
- **Files touched**: list of new / modified test files, grouped by side.
- **Test counts**: how many `it(...)` blocks / `#[test]` fns added; total pass count before vs after.
- **Quality gate status**: tsc, biome, clippy, fmt — pass/fail.
- **Anything left on the table**: targets you didn't fully cover, edge cases you noticed but didn't test (with a one-line reason — "would need a live Postgres" / "depends on user decision about X").
- **Suggested next batch** (optional): the 2–3 next-best files for a future run of `/powadb-coverage`.

The user owns the commit, push, and PR steps after reviewing the diff.

## Common pitfalls (read before starting)

- **Coverage % can drop even when you add tests** if you import previously-unloaded files into the test runner — the denominator grows. Compare absolute *covered lines* alongside %.
- **`npm run test:coverage` runs the whole suite**; on this repo it's fast enough, but if it's slow, write tests incrementally and use `npx vitest run <path>` for tight loops, only re-running the full coverage pass at Step 6.
- **Backend `cargo llvm-cov` needs a clean build** the first time. The first run after a `cargo clean` is slow (full instrumented rebuild); subsequent runs are fast.
- **`src/ipc/**` and `src-tauri/src/main.rs` are excluded for a reason** — don't try to test them. Test the modules they wrap instead.
- **Tauri-runtime-dependent code** (anything that calls `tauri::AppHandle`, `app.emit`, the updater plugin, etc.) is not unit-testable without a heavy harness. Extract the pure logic into a helper and test that.
- **Don't chase 100 %.** The codecov config is informational with a 1 % threshold — the goal is meaningful coverage of logic that can break, not a green badge.
