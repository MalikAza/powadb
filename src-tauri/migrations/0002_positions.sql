-- Manual ordering for the connection sidebar.
--
-- `position` is NULL until the user first drags an item inside a container
-- (folder or root); NULL rows keep sorting alphabetically after positioned
-- ones, so untouched containers preserve the historical name ordering.
ALTER TABLE connections ADD COLUMN position INTEGER;
ALTER TABLE folders ADD COLUMN position INTEGER;
