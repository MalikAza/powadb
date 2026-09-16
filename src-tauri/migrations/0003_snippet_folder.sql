-- Optional one-level grouping for snippets in the sidebar panel.
--
-- A folder is just a free-text label, not a row in `folders` (that table is
-- for connections and carries positions/nesting we don't need here). NULL
-- means "ungrouped"; the panel renders those in a trailing section.
ALTER TABLE snippets ADD COLUMN folder TEXT;
