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
./scripts/bump-version.sh 0.2.1
git add -A && git commit -m "chore: release v0.2.1"
git push
git tag v0.2.1 && git push origin v0.2.1
```

### One-time setup

The repo is private, so the in-app updater needs an embedded GitHub token
to fetch the manifest and release binaries.

1. **Generate a fine-grained PAT** at https://github.com/settings/tokens?type=beta:
   - Resource owner: your account
   - Repository access: **Only select repositories** → `MalikAza/powadb`
   - Repository permissions: **Contents: Read-only**
   - Expiration: as long as you're comfortable (max 1 year)
2. **Add it as GitHub Actions secrets** (Settings → Secrets and variables → Actions):
   - `UPDATER_PAT` — the PAT
   - `TAURI_SIGNING_PRIVATE_KEY` — full contents of `~/.tauri/powadb.key`
     (do **not** add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — GitHub Actions
     secrets can't hold an empty value, and any non-empty value, including
     a single space, fails to decrypt a passwordless key).
3. **Local dev**: create `.env.local` (gitignored) with:
   ```
   VITE_UPDATER_GH_TOKEN=ghp_yourTokenHere
   ```
   Without this, `tauri:dev` builds will still run but the in-app update
   check will hit raw.githubusercontent.com unauthenticated and 404.
4. **Set the repo's default workflow permissions to "Read and write"**
   (Settings → Actions → General → Workflow permissions). Required so the
   release job can create releases and force-push the manifest branch.

### How auto-update actually works

The release workflow:
1. Builds + signs bundles for macOS / Linux / Windows
2. Creates a GitHub Release with the binaries + a `latest.json` manifest
3. Rewrites `latest.json` to point at `api.github.com/.../releases/assets/{id}`
   URLs (these honor `Authorization` headers; public download URLs don't)
4. Force-pushes the rewritten manifest to the orphan `release-manifest`
   branch so the updater has a stable URL to poll

The installed app polls
`https://raw.githubusercontent.com/MalikAza/powadb/release-manifest/latest.json`
every 30 minutes (and once on launch / on demand from Settings) sending
`Authorization: Bearer $VITE_UPDATER_GH_TOKEN`. On match, it downloads the
signed bundle, verifies the minisign signature, and offers to restart.

> The PAT is embedded in distributed binaries — extractable by anyone who
> has the binary. Acceptable here because it's read-only and scoped to a
> single private repo.

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
