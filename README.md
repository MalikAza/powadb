<div align="center">

<img src="./powadb_logo_black.png" alt="PowaDB" width="128" height="128" />

# PowaDB

**A fast, modern desktop database client for PostgreSQL and MySQL.**

Built with [Tauri 2](https://tauri.app), [React 19](https://react.dev) and [Rust](https://www.rust-lang.org).

[![Latest release](https://img.shields.io/github/v/release/MalikAza/powadb?style=flat-square)](https://github.com/MalikAza/powadb/releases/latest)
[![Release workflow](https://img.shields.io/github/actions/workflow/status/MalikAza/powadb/release.yml?style=flat-square&label=release)](https://github.com/MalikAza/powadb/actions/workflows/release.yml)
![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square)

[Download](#download) · [Features](#features) · [Build from source](#build-from-source) · [Contributing](#contributing)

</div>

---

## Features

- 🔌 **Multi-engine** — PostgreSQL and MySQL, connected via [`sqlx`](https://github.com/launchbadge/sqlx).
- ✍️ **SQL editor** — CodeMirror 6 with syntax highlighting and autocompletion.
- 📊 **Virtualized results grid** — TanStack Table + Virtual, fluid on millions of rows.
- 🗂️ **Schema browser** — schemas, tables, columns and indexes at a glance.
- 🛠️ **Inline DML editing** — primary-key-aware updates straight from the grid.
- 🧭 **EXPLAIN view** — visualize query plans.
- 📁 **Connection manager** — organize connections in folders, optional saved passwords.
- 🕓 **History & snippets** — recall past queries and save reusable SQL.
- ⌘ **Command palette** — quick navigation across the app.
- 🌗 **Light & dark themes.**
- ⬆️ **Auto-update** — built-in, signed updates.

## Download

Grab the latest signed bundle for your OS from the [**Releases**](https://github.com/MalikAza/powadb/releases/latest) page:

| Platform | Bundle |
| :--- | :--- |
| macOS (Apple Silicon / Intel) | `.dmg` |
| Linux | `.AppImage` / `.deb` |
| Windows | `.msi` / `.exe` |

### macOS — first launch

The app is **not** signed with an Apple Developer ID, so Gatekeeper will quarantine it the first time you install from the DMG. Clear it once with either:

- **Finder** — right-click `PowaDB.app` in `/Applications` → **Open** → confirm. macOS remembers the choice.
- **Terminal** — `xattr -dr com.apple.quarantine /Applications/PowaDB.app`

Subsequent in-app updates don't trigger this prompt again — the Tauri updater downloads outside of Gatekeeper's web-download path.

## Build from source

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm (pnpm works too)
- [Rust](https://rustup.rs/) stable toolchain
- Tauri system dependencies — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

### Run in dev

```bash
npm install
npm run tauri:dev     # full desktop app
npm run dev           # frontend only at http://localhost:1420 (no IPC)
```

### Build a release

```bash
npm run tauri:build
```

Artifacts land in `src-tauri/target/release/bundle/`.

### Quality checks

```bash
npm run check         # typecheck + biome lint
npm run lint:fix      # auto-fix biome issues
cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check
```

## Architecture at a glance

PowaDB is a single Tauri 2 app — React 19 / TypeScript frontend in `src/`, Rust backend in `src-tauri/`. The two halves communicate **only** through typed IPC wrappers in `src/ipc/index.ts`.

```
src/                       React app
  components/              UI (editor, results grid, panels, dialogs)
  stores/                  Zustand stores (connections, tabs, schema, …)
  ipc/index.ts             Typed wrappers for every Tauri command
src-tauri/src/
  commands/                Tauri command handlers (query, schema, dump, …)
  drivers/                 Postgres / MySQL execution + value coercion
  pool_registry.rs         Live sqlx pool cache + query cancellation
  storage.rs               Local SQLite store (connections, history, snippets)
```

For a deeper tour — IPC contract, the four `AppState` sub-systems, cancellation patterns — see [`CLAUDE.md`](./CLAUDE.md).

## Contributing

Contributions are welcome — bug reports, feature requests and pull requests.

1. **Fork** the repository and clone your fork.
2. **Create a branch** off `main` (`feature/...` or `bug/...`).
3. **Make your changes** and run the quality checks above. The project has no test suite yet, so PRs that include reproductions / manual test steps are especially helpful.
4. **Open a pull request** describing the change and the motivation.

A few non-obvious conventions worth knowing before you patch:

- Frontend never calls `invoke()` directly — every IPC goes through a typed wrapper in `src/ipc/index.ts`.
- shadcn/ui components under `src/components/ui/` are vendored and excluded from biome — leave them alone.
- TypeScript is strict with `noUnusedLocals` / `noUnusedParameters` — unused identifiers fail the build.
- See [`CLAUDE.md`](./CLAUDE.md) for the full architecture and conventions.

## Tech stack

- **Frontend** — React 19, TypeScript, Vite, Tailwind CSS 4, Radix UI / shadcn, Zustand, React Hook Form + Zod, CodeMirror 6, TanStack Table + Virtual
- **Backend** — Rust, Tauri 2, `sqlx` (Postgres / MySQL / SQLite), Tokio
- **Local storage** — SQLite at `<app_data_dir>/powadb.db` for connections, folders, query history, snippets, settings

## Releasing

<details>
<summary><b>Maintainer-only</b> — how releases are cut and how the auto-updater is wired.</summary>

<br>

Releases are built and published automatically by `.github/workflows/release.yml` when a `v*` tag is pushed.

```bash
./scripts/bump-version.sh 0.3.1
git add -A && git commit -m "chore: release v0.3.1"
git push
git tag v0.3.1 && git push origin v0.3.1
```

### Required secrets

- `TAURI_SIGNING_PRIVATE_KEY` — full contents of `~/.tauri/powadb.key`. Do **not** set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for a passwordless key (GitHub secrets cannot hold empty values, and any non-empty value — including a space — fails to decrypt).

The repo's default workflow permissions must be **Read and write** (Settings → Actions → General → Workflow permissions) so the release job can create releases and force-push the manifest branch.

### How auto-update works

The release workflow:

1. Builds and signs bundles for macOS / Linux / Windows.
2. Creates a GitHub Release with the binaries + a `latest.json` manifest.
3. (Legacy) Force-pushes a rewritten copy of `latest.json` to the orphan `release-manifest` branch so v0.3.0-and-older installs — which embed a PAT and poll that stable URL — can still find updates.

From v0.3.1 onward the installed app polls `https://github.com/MalikAza/powadb/releases/latest/download/latest.json` anonymously (the repo is public, so no PAT is needed). It checks on launch, every 30 minutes, and on demand from Settings. On match, it downloads the signed bundle, verifies the minisign signature and offers to restart. The `release-manifest` branch + `UPDATER_PAT` will be removed once active installs have all moved past v0.3.0.

</details>
