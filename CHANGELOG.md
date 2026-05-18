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
