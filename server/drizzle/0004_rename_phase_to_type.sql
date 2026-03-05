ALTER TABLE task_interactions RENAME COLUMN phase TO type;
DROP INDEX IF EXISTS idx_interactions_task_phase;
CREATE INDEX idx_interactions_task_type ON task_interactions(task_id, type);
