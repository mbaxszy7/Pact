CREATE TABLE `agent_run_activities` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`native_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool_name` text,
	`title` text NOT NULL,
	`detail` text,
	`status` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_activities_run_native_unique` ON `agent_run_activities` (`run_id`,`native_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_activities_session_sequence_unique` ON `agent_run_activities` (`session_id`,`sequence`);