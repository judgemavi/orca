ALTER TABLE `tasks` ADD `workflow_snapshot` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_config` (
	`key` text PRIMARY KEY DEFAULT 'config',
	`value` text DEFAULT '{"project":{"name":"","integrationBranch":"orca/integration","worktreeDir":".orca/worktrees"},"tools":["claude"],"orchestrator":{"tool":"claude","model":""},"workers":{"maxParallel":3},"monitor":{"stuckCheckIntervalMs":60000,"maxStuckCycles":10,"conflictCheckIntervalMs":30000},"memory":{"enabled":true,"retro":true,"sync":true},"postMerge":{"enabled":true},"schemaVersion":3,"logging":{"level":"info","file":".orca/orca.log","maxSize":"50mb"}}' NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_config`(`key`, `value`) SELECT `key`, `value` FROM `config`;--> statement-breakpoint
DROP TABLE `config`;--> statement-breakpoint
ALTER TABLE `__new_config` RENAME TO `config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `task_interactions` DROP COLUMN `input_tokens`;--> statement-breakpoint
ALTER TABLE `task_interactions` DROP COLUMN `output_tokens`;--> statement-breakpoint
ALTER TABLE `task_interactions` DROP COLUMN `estimated_cost`;