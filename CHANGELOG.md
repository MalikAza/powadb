## [Unreleased]

### Added
- Close a connection from the command palette; opened tabs for that connection are closed automatically.
- Changelogs panel in settings.

### Changed
- Refactorisation of settings panel with tabs.

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
