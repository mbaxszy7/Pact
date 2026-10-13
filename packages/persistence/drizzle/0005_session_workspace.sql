CREATE TABLE `session_settings_revisions` (
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`primary_agent_id` text NOT NULL,
	`claude_model` text,
	`claude_effort` text,
	`codex_model` text,
	`codex_effort` text,
	`max_discussion_rounds` integer NOT NULL,
	`running_message_policy` text NOT NULL,
	`max_review_cycles` integer NOT NULL,
	`max_repair_attempts` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `revision`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`settings_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
