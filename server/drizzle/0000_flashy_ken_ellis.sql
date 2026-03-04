CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `explore_context` (
	`id` integer PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`hash` text NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "explore_context_singleton" CHECK("explore_context"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result` text,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_interactions_target` ON `interactions` (`target_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `memory_entries` (
	`id` text PRIMARY KEY NOT NULL,
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
	`stale` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_interaction_id`) REFERENCES `task_interactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "memory_category_check" CHECK("memory_entries"."category" IN ('pattern', 'pitfall', 'preference', 'convention', 'architecture', 'dependency')),
	CONSTRAINT "memory_source_type_check" CHECK("memory_entries"."source_type" IN ('retro', 'explore'))
);
--> statement-breakpoint
CREATE INDEX `idx_memory_category` ON `memory_entries` (`category`);--> statement-breakpoint
CREATE INDEX `idx_memory_source_task` ON `memory_entries` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_superseded` ON `memory_entries` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `idx_memory_provenance_hash` ON `memory_entries` (`provenance_hash`);--> statement-breakpoint
CREATE TABLE `memory_file_associations` (
	`memory_id` text NOT NULL,
	`file_path` text NOT NULL,
	PRIMARY KEY(`memory_id`, `file_path`),
	FOREIGN KEY (`memory_id`) REFERENCES `memory_entries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mfa_file_path` ON `memory_file_associations` (`file_path`);--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `orchestrator_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `orchestrator_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "orchestrator_message_role" CHECK("orchestrator_messages"."role" IN ('user', 'assistant', 'tool_use', 'tool_result'))
);
--> statement-breakpoint
CREATE INDEX `idx_orch_msg_session` ON `orchestrator_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `orchestrator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tool` text NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`claude_session_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "orchestrator_session_status" CHECK("orchestrator_sessions"."status" IN ('active', 'closed'))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`tool` text NOT NULL,
	`task_id` text,
	`pid` integer NOT NULL,
	`working_dir` text,
	`cols` integer DEFAULT 80 NOT NULL,
	`rows` integer DEFAULT 24 NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`exit_code` integer DEFAULT -1 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`exited_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_status_created` ON `sessions` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_deps` (
	`task_id` text NOT NULL,
	`depends_on` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_deps_depends_on` ON `task_deps` (`depends_on`);--> statement-breakpoint
CREATE TABLE `task_file_associations` (
	`task_id` text NOT NULL,
	`file_path` text NOT NULL,
	PRIMARY KEY(`task_id`, `file_path`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tfa_file_path` ON `task_file_associations` (`file_path`);--> statement-breakpoint
CREATE TABLE `task_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text,
	`phase` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`run_id` text,
	`tool` text NOT NULL,
	`model` text,
	`log_path` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`error` text,
	`diff` text,
	`exit_code` integer,
	`duration_ms` integer,
	`quality_json` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_cost` real DEFAULT 0 NOT NULL,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_interactions_task_phase` ON `task_interactions` (`task_id`,`phase`);--> statement-breakpoint
CREATE INDEX `idx_interactions_status` ON `task_interactions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_interactions_run_id` ON `task_interactions` (`run_id`);--> statement-breakpoint
CREATE TABLE `task_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`interaction_id` text,
	`feedback` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`addressed_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`interaction_id`) REFERENCES `task_interactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_task_reviews_task_created` ON `task_reviews` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`plan` text,
	`session_id` text,
	`parent_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_created_at` ON `tasks` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_updated_at` ON `tasks` (`updated_at`);