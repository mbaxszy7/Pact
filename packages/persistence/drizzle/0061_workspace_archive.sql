CREATE TABLE `workspace_archive_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`owner_id` text NOT NULL,
	`state` text NOT NULL,
	`preview_json` text NOT NULL,
	`results_json` text DEFAULT '[]' NOT NULL,
	`message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `workspace_archive_scope_active_idx` ON `workspace_archive_operations` (`project_id`,`session_id`) WHERE "workspace_archive_operations"."state" IN ('stopping', 'unresolved');--> statement-breakpoint
CREATE INDEX `workspace_archive_owner_prepared_idx` ON `workspace_archive_operations` (`owner_id`) WHERE "workspace_archive_operations"."state" = 'prepared';