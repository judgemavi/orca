PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_entries` (
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
	`retrieval_count` integer DEFAULT 0 NOT NULL,
	`stale` integer DEFAULT false NOT NULL,
	`decay_exempt` integer DEFAULT false NOT NULL,
	`embedding` blob,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_interaction_id`) REFERENCES `task_interactions`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "memory_category_check" CHECK("__new_memory_entries"."category" IN ('pattern', 'pitfall', 'preference', 'convention', 'architecture', 'dependency', 'tooling')),
	CONSTRAINT "memory_source_type_check" CHECK("__new_memory_entries"."source_type" IN ('retro', 'explore'))
);
--> statement-breakpoint
INSERT INTO `__new_memory_entries`("id", "content", "category", "tags", "source_task_id", "source_interaction_id", "confidence", "provenance_hash", "superseded_by", "source_type", "covered_at_commit", "retrieval_count", "stale", "decay_exempt", "embedding", "created_at", "updated_at") SELECT "id", "content", "category", "tags", "source_task_id", "source_interaction_id", "confidence", "provenance_hash", "superseded_by", "source_type", "covered_at_commit", "retrieval_count", "stale", false, "embedding", "created_at", "updated_at" FROM `memory_entries`;--> statement-breakpoint
DROP TABLE `memory_entries`;--> statement-breakpoint
ALTER TABLE `__new_memory_entries` RENAME TO `memory_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_memory_category` ON `memory_entries` (`category`);--> statement-breakpoint
CREATE INDEX `idx_memory_source_task` ON `memory_entries` (`source_task_id`);--> statement-breakpoint
CREATE INDEX `idx_memory_superseded` ON `memory_entries` (`superseded_by`);--> statement-breakpoint
CREATE INDEX `idx_memory_provenance_hash` ON `memory_entries` (`provenance_hash`);