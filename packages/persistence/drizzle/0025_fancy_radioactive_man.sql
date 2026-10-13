CREATE TABLE `workspace_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workspace_blobs_bytes_idx` ON `workspace_blobs` (`bytes`);--> statement-breakpoint
CREATE TABLE `workspace_change_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`change_set_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload_json` text NOT NULL,
	`payload_bytes` integer NOT NULL,
	`retained_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`reconciled_at` text,
	FOREIGN KEY (`change_set_id`) REFERENCES `workspace_change_sets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `workspace_change_intents_set_id_idx` ON `workspace_change_intents` (`change_set_id`,`id`);--> statement-breakpoint
CREATE INDEX `workspace_change_intents_unfinished_id_idx` ON `workspace_change_intents` (`id`) WHERE "workspace_change_intents"."status" <> 'applied';--> statement-breakpoint
CREATE INDEX `workspace_change_intents_bytes_idx` ON `workspace_change_intents` (`payload_bytes`,`retained_bytes`);--> statement-breakpoint
CREATE INDEX `workspace_change_intents_applied_undo_set_idx` ON `workspace_change_intents` (`change_set_id`) WHERE "workspace_change_intents"."kind" = 'undo' AND "workspace_change_intents"."status" = 'applied' AND "workspace_change_intents"."reconciled_at" IS NULL;--> statement-breakpoint
CREATE TABLE `workspace_change_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`root` text NOT NULL,
	`root_device` text NOT NULL,
	`root_inode` text NOT NULL,
	`staging_root` text NOT NULL,
	`state` text DEFAULT 'recording' NOT NULL,
	`file_count` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`undo_unavailable_reason` text,
	`created_at` text NOT NULL,
	`finalized_at` text,
	`projection_pending` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_change_sets_run_id_unique` ON `workspace_change_sets` (`run_id`);--> statement-breakpoint
CREATE INDEX `workspace_change_sets_root_state_idx` ON `workspace_change_sets` (`root`,`state`);--> statement-breakpoint
CREATE INDEX `workspace_change_sets_reconcile_id_idx` ON `workspace_change_sets` (`id`) WHERE "workspace_change_sets"."projection_pending" = 1 OR "workspace_change_sets"."state" = 'recording' OR "workspace_change_sets"."finalized_at" IS NULL;--> statement-breakpoint
CREATE TABLE `workspace_file_changes` (
	`change_set_id` text NOT NULL,
	`path` text NOT NULL,
	`previous_path` text,
	`kind` text NOT NULL,
	`before_hash` text,
	`before_bytes` integer NOT NULL,
	`before_mode` integer NOT NULL,
	`after_hash` text,
	`after_bytes` integer NOT NULL,
	`after_mode` integer NOT NULL,
	`additions` integer,
	`deletions` integer,
	`hidden` integer NOT NULL,
	`reason` text,
	PRIMARY KEY(`change_set_id`, `path`),
	FOREIGN KEY (`change_set_id`) REFERENCES `workspace_change_sets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`before_hash`) REFERENCES `workspace_blobs`(`hash`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`after_hash`) REFERENCES `workspace_blobs`(`hash`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `workspace_changes_json` text;