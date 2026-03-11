CREATE TABLE `_changelog` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	`action` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY DEFAULT 'config',
	`value` text DEFAULT '{"project":{"name":"","integrationBranch":"orca/integration","worktreeDir":".orca/worktrees"},"tools":["claude"],"orchestrator":{"tool":"claude","model":"","mode":"cli"},"workers":{"maxParallel":3},"monitor":{"stuckCheckIntervalMs":60000,"maxStuckCycles":10,"conflictCheckIntervalMs":30000},"memory":{"enabled":true,"retro":true,"sync":true},"postMerge":{"enabled":true},"schemaVersion":3,"cost":{"budgetUsd":0},"logging":{"level":"info","file":".orca/orca.log","maxSize":"50mb"}}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`task_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`payload` text,
	`error` text,
	`result` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`started_at` text,
	`completed_at` text,
	CONSTRAINT `fk_jobs_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY,
	`content` text NOT NULL,
	`category` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_task_id` text,
	`source_interaction_id` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`provenance_hash` text NOT NULL,
	`superseded_by` text,
	`source_type` text DEFAULT 'retro' NOT NULL,
	`covered_at_commit` text DEFAULT '' NOT NULL,
	`retrieval_count` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`decay_exempt` integer DEFAULT false NOT NULL,
	`embedding` blob,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_memory_entries_source_task_id_tasks_id_fk` FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_memory_entries_source_interaction_id_task_interactions_id_fk` FOREIGN KEY (`source_interaction_id`) REFERENCES `task_interactions`(`id`) ON DELETE SET NULL,
	CONSTRAINT "memory_category_check" CHECK("category" IN ('pattern', 'pitfall', 'preference', 'convention', 'architecture', 'dependency', 'tooling')),
	CONSTRAINT "memory_source_type_check" CHECK("source_type" IN ('retro', 'explore'))
);
--> statement-breakpoint
CREATE TABLE `memory_file_associations` (
	`memory_id` text NOT NULL,
	`file_path` text NOT NULL,
	CONSTRAINT `memory_file_associations_pk` PRIMARY KEY(`memory_id`, `file_path`),
	CONSTRAINT `fk_memory_file_associations_memory_id_memory_entries_id_fk` FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_deps` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	CONSTRAINT `task_deps_pk` PRIMARY KEY(`task_id`, `depends_on`),
	CONSTRAINT `fk_task_deps_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_deps_depends_on_tasks_id_fk` FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_interactions` (
	`id` text PRIMARY KEY,
	`task_id` text,
	`type` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`step_name` text,
	`tool` text NOT NULL,
	`model` text,
	`log_path` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`output` text,
	`exit_code` integer,
	`duration_ms` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost` real DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`finished_at` text,
	`previous_interaction_id` text,
	`commit_sha` text,
	`session_id` text,
	`chain_id` text,
	CONSTRAINT `fk_task_interactions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `task_questions` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`interaction_id` text,
	`question` text NOT NULL,
	`answer` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`answered_at` text,
	CONSTRAINT `fk_task_questions_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_questions_interaction_id_task_interactions_id_fk` FOREIGN KEY (`interaction_id`) REFERENCES `task_interactions`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`parent_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow` text,
	`current_step` text,
	`auto_run_overrides` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_changelog_id` ON `_changelog` (`id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_status` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_jobs_task_id` ON `jobs` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_jobs_priority_created` ON `jobs` (`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_category` ON `memory_entries` (`category`);--> statement-breakpoint
CREATE INDEX `idx_memory_source_task` ON `memory_entries` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_superseded` ON `memory_entries` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `idx_memory_provenance_hash` ON `memory_entries` (`provenance_hash`);--> statement-breakpoint
CREATE INDEX `idx_mfa_file_path` ON `memory_file_associations` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_task_deps_depends_on` ON `task_deps` (`depends_on`);--> statement-breakpoint
CREATE INDEX `idx_interactions_task_type` ON `task_interactions` (`task_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_interactions_status` ON `task_interactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_interactions_chain` ON `task_interactions` (`chain_id`);--> statement-breakpoint
CREATE INDEX `idx_task_questions_task_id` ON `task_questions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_questions_status` ON `task_questions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_created_at` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_updated_at` ON `tasks` (`updated_at`);