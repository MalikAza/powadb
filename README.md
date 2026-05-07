# PowaDB

A fast, modern desktop database client for PostgreSQL and MySQL — built with Tauri, React, and Rust.

## Features

- **Multi-engine support** — PostgreSQL and MySQL via `sqlx`
- **SQL editor** — CodeMirror 6 with syntax highlighting and SQL autocompletion
- **Results grid** — virtualized table view powered by TanStack Table for large result sets
- **Schema browser** — introspect databases, schemas, tables, columns, and indexes
- **Browse / edit data** — inline DML editing with primary-key-aware updates
- **EXPLAIN view** — visualize query plans
- **Connection manager** — organize connections in folders, with optional password storage
- **Query history & snippets** — recall past queries and save reusable snippets
- **Command palette** — quick navigation across the app
- **Light & dark themes**

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS 4, Radix UI, Zustand, React Hook Form + Zod
- **Backend**: Rust, Tauri 2, sqlx (Postgres / MySQL / SQLite), Tokio
- **Storage**: local SQLite database for app metadata (connections, history, snippets, folders)

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm/pnpm
- [Rust](https://rustup.rs/) stable toolchain
- Tauri system dependencies — see the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/)

## Development

```bash
# install JS dependencies
npm install

# run the desktop app in dev mode
npm run tauri:dev

# run the web frontend only (no Tauri shell)
npm run dev
```

## Build

```bash
# produce a release build for the current platform
npm run tauri:build
```

Artifacts are emitted to `src-tauri/target/release/bundle/`.

## Quality

```bash
npm run typecheck   # TypeScript
npm run lint        # Biome
npm run check       # both
```

## Installing on macOS (first time)

The app is not signed with an Apple Developer ID, so Gatekeeper will quarantine
the first install from the DMG. One of the following clears it once:

- Right-click `PowaDB.app` in `/Applications` → **Open** → confirm in the
  dialog. macOS remembers the choice for future launches.
- Or, from a terminal: `xattr -dr com.apple.quarantine /Applications/PowaDB.app`.

Subsequent in-app updates do **not** re-trigger the quarantine prompt — the
updater downloads via Tauri's HTTP client, which never writes the
`com.apple.quarantine` xattr.

## Releasing

Releases are built and published automatically by
`.github/workflows/release.yml` when a `v*` tag is pushed.

```bash
./scripts/bump-version.sh 0.2.0
git add -A && git commit -m "chore: release v0.2.0"
git tag v0.2.0 && git push --follow-tags
```

The workflow needs one GitHub Actions secret:

- `TAURI_SIGNING_PRIVATE_KEY` — full contents of the minisign private key
  (generated with `npm run tauri -- signer generate -w ~/.tauri/powadb.key`).

Do **not** add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if the key was generated
without a password — GitHub Actions secrets can't hold an empty value, and
any non-empty value (including a single space) is treated as a real password
and fails to decrypt the key.

Running PowaDB clients pick up new versions within ~30 minutes (or on next
launch) via a non-blocking toast offering a one-click install + restart.

## Project Layout

```
src/                  React app (UI, stores, schemas)
  components/         Editor, ResultsGrid, panels, dialogs
  stores/             Zustand stores
src-tauri/            Rust backend
  src/commands/       Tauri command handlers (query, connections, schema, …)
  src/drivers/        Postgres / MySQL drivers
  src/storage.rs      Local SQLite-backed app storage
```

## License

Private project.
