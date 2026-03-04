CREATE VIRTUAL TABLE IF NOT EXISTS memory_entries_fts
USING fts5(id UNINDEXED, content, tags);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_insert
AFTER INSERT ON memory_entries
BEGIN
  INSERT INTO memory_entries_fts(id, content, tags)
  VALUES (NEW.id, NEW.content, NEW.tags);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_update
AFTER UPDATE ON memory_entries
BEGIN
  DELETE FROM memory_entries_fts WHERE id = OLD.id;
  INSERT INTO memory_entries_fts(id, content, tags)
  VALUES (NEW.id, NEW.content, NEW.tags);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS memory_entries_fts_delete
AFTER DELETE ON memory_entries
BEGIN
  DELETE FROM memory_entries_fts WHERE id = OLD.id;
END;
