# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Dev — full desktop app (Tauri shell + Vite). Starts both.
npm run tauri:dev

# Dev — frontend only in a browser at http://localhost:1420 (no IPC available).
npm run dev

# Quality gates (also enforced by .claude/hooks on every edit — see below).
npm run typecheck   # tsc --noEmit
npm run lint        # biome check src
npm run lint:fix    # biome check --write src
npm run check       # typecheck + lint
npm run format      # biome format --write src

# Tests.
npm test                       # vitest run
npm run test:watch             # vitest in watch mode
npm run test:coverage          # vitest run --coverage (writes ./coverage/lcov.info)

# Rust side (run from src-tauri/):
cargo check
cargo clippy -- -D warnings
cargo fmt --check    # or `cargo fmt` to apply
cargo test --lib     # backend unit tests
# Coverage (requires cargo-llvm-cov): `cargo llvm-cov --lib --lcov --output-path lcov.info`

# Release build for current platform (delegates to scripts/build.sh).
npm run tauri:build

# Bump version across package.json, Cargo.toml, tauri.conf.json, CHANGELOG.
./scripts/bump-version.sh <new-version>
```

Tests live next to the code they cover: `src/**/*.test.ts(x)` for the frontend (Vitest + jsdom) and `#[cfg(test)] mod tests` blocks inside each Rust file. CI runs both and uploads `lcov.info` to Codecov under the `frontend` / `backend` flags (see `.github/workflows/checks.yml` and `codecov.yml`).

## Architecture

PowaDB is a single Tauri 2 app: React 19 / TS frontend in `src/`, Rust backend in `src-tauri/`. The two halves only meet through Tauri IPC.

### IPC contract

**The frontend never calls `invoke()` directly.** Every IPC call is wrapped as a method on the `ipc` object in `src/ipc/index.ts`, which is the single source of truth for command names, argument shapes, and TS types of returned payloads. When you add a Rust command, you must:

1. Implement it in the relevant `src-tauri/src/commands/<module>.rs`.
2. Register it in the `invoke_handler![...]` list in `src-tauri/src/lib.rs`.
3. Add a typed wrapper to `src/ipc/index.ts` (camelCase method, snake_case Rust args).

Rust↔TS naming: Tauri auto-converts camelCase JS args to snake_case Rust params. Returned structs serialize with their Rust field names (snake_case) — the TS types in `ipc/index.ts` mirror that exactly.

Backend → frontend events are emitted via `app.emit(...)`. Notable ones: `pools-changed` (active connection IDs), `open-settings`, `new-tab`, plus dump progress events.

### Rust backend layout

`src-tauri/src/lib.rs` builds the Tauri app and installs `AppState` (managed singleton). `AppState` holds four sub-systems:

- **`storage: Storage`** — wraps a SQLite pool at `<app_data_dir>/powadb.db`. Persists connections (with optional plaintext passwords), folders, query history, snippets, and `AppSettings`. All schema migrations are inline `CREATE TABLE IF NOT EXISTS` in `Storage::open`.
- **`pools: PoolRegistry`** — caches live `sqlx` Postgres/MySQL pools keyed by `connection_id`. `get_or_open` is the only entry point: it resolves saved credentials, opens a pool lazily, and emits `pools-changed`. Query cancellation is a `oneshot::channel` registered per `query_id` and selected against via `tokio::select!` in `run_with_cancel`.
- **`jobs: JobRegistry`** — `AtomicBool` cancel flags keyed by `job_id` for long-running export/import operations in `commands/dump.rs`.
- **`settings: SettingsStore`** — `RwLock`-wrapped in-memory cache of `AppSettings` (paths to `pg_dump` / `mysqldump` / etc.), backed by `storage`.

Driver-specific SQL execution and value coercion lives in `src-tauri/src/drivers/{postgres,mysql}.rs` behind a `PoolHandle` enum. Anything that branches per `DbKind` belongs here — keep the command layer engine-agnostic where possible.

All command handlers return `AppResult<T>` (`error.rs`). `AppError` serializes to a string for the frontend, so the JS side sees `error.message`-style strings, not structured variants.

### Frontend layout

State is split across small Zustand stores in `src/stores/`:

- `connections` — saved connections + which is "active" (selected in the sidebar) + which pools are currently open in Rust (synced via the `pools-changed` event).
- `tabs` — open query/browse tabs per connection.
- `schema` — cached introspection results.
- `theme`, `ui`, `panelLayouts`, `windowState` — UI/chrome state. `windowState` and `panelLayouts` persist to disk.

UI primitives are shadcn/ui under `src/components/ui/` (excluded from biome — don't lint/format them). Feature components live one level up.

- Path alias: `@/*` → `src/*`.
- Forms use React Hook Form + Zod resolver; schemas in `src/lib/schemas.ts`.
- Toasts are Sonner.
- The SQL editor is CodeMirror 6 (`@uiw/react-codemirror`).
- Results grids use TanStack Table + TanStack Virtual for virtualization.

### Auto-updater (production builds)

The app is distributed via the GitHub Release attached to each `v*` tag. `.github/workflows/release.yml` builds bundles, signs them with minisign (`TAURI_SIGNING_PRIVATE_KEY` secret), and publishes `latest.json` as a release asset. Installed apps poll `https://github.com/MalikAza/powadb/releases/latest/download/latest.json` anonymously — the repo is public. See README "Auto-update" section.

Releasing: `./scripts/bump-version.sh X.Y.Z`, commit, push, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

## Conventions

- TypeScript strict + `noUnusedLocals` + `noUnusedParameters` — unused vars are hard errors, not warnings.
- Biome formats at 100 cols / 2-space indent.
- Don't hand-edit anything under `src/components/ui/` (shadcn-managed).
- macOS-specific behaviors live behind `#[cfg(target_os = "macos")]` blocks in `lib.rs` (window-hide-on-close, reopen-on-dock-click).

## Tooling notes

`.claude/hooks/check-frontend.sh` and `.claude/hooks/check-backend.sh` run after every `Edit`/`Write`/`MultiEdit` via PostToolUse hooks in `.claude/settings.json`. They use `asyncRewake`, so they run in the background and only interrupt the agent if a check fails. The frontend hook runs biome + tsc when `src/**` changes; the backend hook runs `cargo fmt --check` + `cargo check` + `cargo clippy -D warnings` when `src-tauri/**/*.rs` or `Cargo.toml` changes. If a Rust edit keeps tripping `cargo fmt --check` on unrelated files, run `cargo fmt` once from `src-tauri/` to clear pre-existing drift.
