-- Promote snippet grouping from a free-text label to a real folder tree,
-- mirroring the `folders` table used by the connection sidebar: nesting via
-- `parent_id`, manual ordering via `position`.
--
-- Snippets keep their own tree rather than sharing `folders` — a connection
-- folder and a snippet folder are different things and must not collide.

CREATE TABLE IF NOT EXISTS snippet_folders (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    parent_id  TEXT,
    position   INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE snippets ADD COLUMN folder_id TEXT;
ALTER TABLE snippets ADD COLUMN position INTEGER;

-- Carry over the v3 free-text labels: one folder row per distinct label.
INSERT INTO snippet_folders (id, name)
SELECT DISTINCT 'sf:' || folder, folder
FROM snippets
WHERE folder IS NOT NULL AND folder <> '';

UPDATE snippets
SET folder_id = 'sf:' || folder
WHERE folder IS NOT NULL AND folder <> '';

ALTER TABLE snippets DROP COLUMN folder;
