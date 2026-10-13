CREATE TABLE `agent_event_journal` (
	`session_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`run_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `sequence`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`settings_revision` integer NOT NULL,
	`native_session_id` text,
	`native_turn_id` text,
	`failure_kind` text,
	`failure_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_one_active_per_session` ON `agent_runs` (`session_id`) WHERE "agent_runs"."status" IN ('starting', 'running', 'recovering');--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_id` text,
	`role` text NOT NULL,
	`agent_id` text,
	`content` text NOT NULL,
	`state` text NOT NULL,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_session_sequence_unique` ON `conversation_messages` (`session_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `native_agent_contexts` (
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`state` text NOT NULL,
	`last_run_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`session_id`, `agent_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
