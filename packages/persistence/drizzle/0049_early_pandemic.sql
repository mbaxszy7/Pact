CREATE TABLE `collaboration_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`state_json` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_tasks_active_session` ON `collaboration_tasks` (`session_id`) WHERE "collaboration_tasks"."active" = 1;--> statement-breakpoint
CREATE TABLE `collaboration_turns` (
	`run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`state_json` text NOT NULL,
	`result_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaboration_turns_task` ON `collaboration_turns` (`task_id`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `collaboration_task_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `collaboration_kind` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `collaboration_stage` text;