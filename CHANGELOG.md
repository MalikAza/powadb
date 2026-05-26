## [Unreleased]

### Security

- **Connection passwords moved to the OS keychain.** Saved DB credentials are now stored in **macOS Keychain**, **Windows Credential Manager**, or **libsecret** on Linux instead of the plaintext `password` column in `powadb.db`. The first time the app reads a saved password, **macOS will prompt for Keychain access** — choose **Always Allow** to avoid being prompted on every connect. Existing plaintext rows are migrated automatically on first launch; the legacy column is then NULL'd out. If the keychain backend is unavailable (CI, headless Linux without secret-service, locked Keychain) the app falls back to the SQLite column and logs a loud stderr warning. See [README → Upgrading](README.md#upgrading-from-010) for the rollback path.
- **Strict Content Security Policy** in the webview (was `null`). Tightens the blast radius of any XSS-like bug that could otherwise read IPC or exfiltrate.
- **Credentials scrubbed from error messages** at the IPC boundary. `scheme://user:pass@host` patterns in driver errors (sqlx / mongodb) are redacted to `scheme://***@host` before reaching the frontend.
- **Diagram-DDL allowlist.** When generating `CREATE TABLE` from a diagram document, column `data_type`, `default_value`, and FK `ON UPDATE` / `ON DELETE` rules are validated against strict allowlists. Diagram JSON imported from disk can no longer ship arbitrary SQL through these fields.
- **PRAGMA identifier hardening.** SQLite introspection now rejects identifiers containing NUL or control characters before quoting them.
- **hstore wire decoder** caps the pre-allocation hint so a hostile server can't trigger a multi-GB allocation via an inflated count field.

### Added

- **Versioned schema-migration runner** for `powadb.db`. Replaces the inline `CREATE TABLE IF NOT EXISTS` + best-effort `ALTER TABLE ADD COLUMN` block in `Storage::open` with a `schema_version` table and per-migration SQL files under `src-tauri/migrations/`. Existing installs pick up version 1 transparently.
- **Pre-migration DB backup.** On every launch, before any schema or password migration touches the file, `powadb.db` is copied to `powadb.db.backup-pre-<version>` alongside it. One backup per upgraded-to version; safe to delete once the new version proves stable. See [README → Upgrading](README.md#upgrading-from-010).
- `history-degraded` IPC event surfaces the first storage-write failure when query history can't be saved (full disk, corrupted `powadb.db`, etc.). Previously these failures were silently swallowed.
- Typed `AppError` variants: `Unsupported { feature, engine }`, `BadInput { field, reason }`, `Schema(_)`. The frontend can now branch on these (e.g. tag the field a `BadInput` complained about) instead of pattern-matching on a free-form string.
- `validate_ident_chars` helper that every DDL-generating path now uses before reaching `quote_ident`.

### Changed

- **Cancellation latency on large dumps** is now bounded to ~200 ms. The initial `SELECT *` in `dump_table_data` races against the dump's cancel flag — clicking Cancel mid-fetch on a multi-million-row scan no longer waits for the full read to complete.
- **`PoolRegistry::swap_pool_for_database`** no longer holds the pools mutex across the pool's `close().await`, so switching the active database doesn't block concurrent registry operations.
- Engine-feature mismatches (e.g. asking Mongo for a SQL-only operation) now return a typed `Unsupported` error with the failing feature name and engine kind, instead of a generic string.
- `validate_db_name` and "drop currently-used database" guards now return `BadInput { field, reason }` so the frontend can highlight the offending input.

### Internal

- **Dev/prod state split.** Debug builds (`npm run tauri:dev`) now read `powadb-dev.db` and use Keychain service `com.aza.powadb-dev`; release builds keep `powadb.db` and `com.aza.powadb`. The dev DB is seeded from the prod one on first launch so contributors don't start with an empty store. See [README → Build from source](README.md#dev-and-prod-run-side-by-side).
- Duplicate `isGeoColumn` / `isByteaColumn` helpers extracted from `BrowseTabPane.tsx` and `ResultsGrid/Grid.tsx` into a shared `src/lib/columnTypes.ts`.
- Dump chunk size lifted from a magic `500usize` to a named `DUMP_CHUNK_SIZE` constant with a one-line rationale.
- `commands/diagram_diff.rs`'s five `unreachable!("Mongo has no DDL")` panics are now typed `Unsupported` errors; `commands/geo.rs` `UnsupportedType` misuse converted to `Unsupported` with the engine kind.
- Unused `DocColumn::id` field dropped from the diagram-diff struct (serde silently ignores the extra incoming key).

## [0.10.0] - 2026-05-22

### Added
- **MongoDB support** — first-class fourth engine alongside Postgres, MySQL and SQLite. Schema browsing, document display, CRUD, filters, sort, query cancellation and history all work end-to-end.
- MongoDB query editor with two modes: a JSON form with context-aware completions, and a mongosh-style DSL (`db.collection.find({...}).sort({...}).limit(N)`).
- `dropDatabase` for MongoDB connections from the schema tree.
- Frontend feature gating driven by an engine `Capabilities` descriptor — UI controls that don't apply to the active engine are hidden instead of erroring.
- Front-end coverage suite (Vitest) and unit tests for the SQL statement-handling helpers.

### Changed
- Engine layer refactored behind an `Engine` trait (`engine/{postgres,mysql,sqlite,mongo}.rs`) with a capabilities-driven architecture. SQL-only command paths route through `engine::require_sql_pool`; the frontend never invokes operations an engine doesn't support.
- Tunnel-connection lifecycle reworked so SSH and WireGuard pools shut down cleanly.

### Fixed
- SSH / WireGuard tunneled connections not disconnecting correctly on close.
- Query editor selection highlight color and cursor-line styling.

## [0.9.2] - 2026-05-21

### Added
- Postgres `hstore` type coverage.
- Postgres `ltree` type coverage.
- Postgres `arrays` type coverage.
- Postgres `ranges` type coverage.

### Changed
- Improved fallback when no typed decoder matches the bytes aren't clean UTF-8 return them as a hex literal instead of bubbling an `UnsupportedType` error

### Fixed
- Fix `VECTOR` type handling in PostgreSQL.

## [0.9.1] - 2026-05-21

### Added
- Diagram view: searchable table picker with autocomplete that zooms to the selected table.

### Changed
- Diagram toolbar file actions are grouped under a single dropdown for a tidier toolbar.
- Diagram view performance improvements on large schemas.
- Update toast now shows a clearer message and a "Later" cancel button.

### Fixed
- PostgreSQL decoding of user-defined types (enums, domains, etc.) — falls back to reading the raw UTF-8 bytes when sqlx's `String` decoder rejects the type.

## [0.9.0] - 2026-05-20

### Added
- Diagram visualization now renders foreign-key relationships, plus per-table indexes and sequences.
- Custom query tabs can now be executed as scripts: multiple statements run sequentially and each result is surfaced.
- Better query editor with usability improvements.
- Snippets opened from the snippets panel now use the snippet's name as the tab title.
- BYTEA type selection (Hex / UTF-8 / UUID / ULID / Base64) is now persisted for snippets and custom query tabs.
- Filtering a BYTEA column by value now follows the column's selected BYTEA type (ULID / UUID) for input parsing.
- Filter cells expose selection options for a smoother filter UX.
- Filter inputs are now debounced to avoid re-querying on every keystroke.
- Results grid columns are now resizable by dragging the column edge.
- Report-a-bug button in Settings → About.

### Changed
- Wider spacing between tables in diagram visualization for better readability.
- Frontend-wide refactor pass (react-doctor audit) across components, hooks and stores.

### Fixed
- Column resize handle UI in the results grid.

## [0.8.2] - 2026-05-19

### Fixed
- Fix `INTERVAL` type handling on PostregSQL

## [0.8.1] - 2026-05-18

### Added
- Foreign-key click-to-browser: now works with custom queries.

### Fixed
- Keyboard shortcut to open settings dialog on non-mac OSs.

## [0.8.0] - 2026-05-18

### Added
- BYTEA display modes — render binary columns as Hex, UTF-8, UUID, ULID or Base64, with per-column overrides remembered across sessions.
- Foreign-key click-to-browse — clicking a foreign-key cell opens the referenced row in a new browse tab.
- Cell preview dialog — inspect long text, JSON or other values in a dedicated full-value viewer from the results grid.
- Geometry map feature popover — clicking a feature on the map surfaces its lat/long and the row's other column values.

### Changed
- Double-clicking an entry in the snippets or history panel now opens it in a new tab.
- The custom themes list in Settings is wrapped in a scroll area so long lists stay usable.
- SSH and WireGuard tunnels now receive the target host and port explicitly, avoiding a silent fallback to `localhost`.

### Fixed
- Custom query columns in the results grid are aligned consistently with the rest of the grid (#13).
- Geometry feature popover behavior after clicking through to a feature (#13, follow-up to #12).

## [0.7.0] - 2026-05-15

### Added
- DB diagram modeler — view, edit, alter (with live alter) and import an existing schema as an interactive diagram.
- Custom themes — drop-in `.powadb-theme.json` files validated against a schema.
- Community themes bundled with the app: Catppuccin Latte/Mocha, Dracula, Gruvbox Dark, Nord, Solarized Light/Dark, Tokyo Night.
- SSH tunnel connections — connect to remote databases through an SSH jump host, managed transparently by the app.

### Fixed
- Tunnel flags are now preserved when switching databases from the command palette or the schema tree.
- `information_schema` columns are cast to `CHAR` to avoid MySQL collation mismatches.
- MySQL row decoding now handles the `TIMESTAMP` type correctly.
- Tunneled DB pools are kept clean of stale connections after the tunnel is reset.

## [0.6.0] - 2026-05-13

### Added
- Geometry data vizualisation on a cartography modal by right clicking on the geometry data cell.
- Multiple geometry data row/column can be vizualised by selecting them before or right clicking the column header.

## [0.5.0] - 2026-05-13

### Added
- Wireguard tunnel connections.
- Connections form now accepts a custom color via a color picker.

### Changed
- Dangerous actions now triggers an alert as a confirmation dialog as a better UX than a double click.

## [0.4.1] - 2026-05-12

Oopsie, we forgot about the latest version's changelog... So here it is.

## [0.4.0] — 2026-05-12

### Added
- SQLite support alongside Postgres and MySQL (driver, schema introspection, dump/import, browse and table ops).
- Multiple databases per connection: switch the active database from the command palette and the schema tree.
- Create a connection without preselecting a database.
- Create and delete databases from the schema tree.

## [0.3.1] — 2026-05-12

### Added
- Close a connection from the command palette; opened tabs for that connection are closed automatically.
- Changelogs panel in settings.

### Changed
- Refactorisation of settings panel with tabs.
- Auto-updater now fetches the manifest and binaries anonymously via public release URLs (the repo is public — no PAT needed). The `release-manifest` branch is still published for backward compatibility with previously-installed clients.

## [0.3.0] — 2026-05-11

### Added
- List active pool connections and close them from the UI.

## [0.2.4] — 2026-05-07

First tagged release.

### Added
- Settings dialog with light theme and a theme switcher (light / dark / system).
- In-app version display and update checker.
- Per-connection color tag, with a color indicator surfaced in the command palette.
- Schema-aware SQL autocomplete.
- Export / import of connections.
- Multi-row select and bulk delete in the browse grid.
- Schema search focus (replaces the previous Cmd+K menu).
- Scrollable tab bar.
- New-tab keyboard shortcuts and tab management.
- Window state and layout persistence.
- `Cmd+W` to close the window on macOS.
- Lazy loading and an optimised build bundle.
- Toggle for showing the connection password.

### Fixed
- Column metadata for empty result sets.
- SQL placeholder casting for PostgreSQL and MySQL compatibility.
- Cast primary key column to text in DML `WHERE` clauses on PostgreSQL.
- Keymap priority handling in the SQL editor.

### Changed
- No default query tab is opened when opening a connection.
- Forms migrated to Zod v4.
