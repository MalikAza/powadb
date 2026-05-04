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
