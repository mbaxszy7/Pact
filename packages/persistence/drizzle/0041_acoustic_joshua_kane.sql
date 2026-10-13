CREATE TABLE `native_fork_intents` (
	`operation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`source_json` text NOT NULL,
	`state` text NOT NULL,
	`dispatched` integer DEFAULT false NOT NULL,
	`candidate_missing` integer DEFAULT false NOT NULL,
	`native_session_id` text,
	`witness_json` text,
	`executor_id` text,
	`native_work_state` text DEFAULT 'not_dispatched' NOT NULL,
	`reason` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`operation_id`, `agent_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `session_fork_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `native_fork_intents_work_idx` ON `native_fork_intents` (`native_work_state`,`operation_id`);--> statement-breakpoint
CREATE TABLE `session_fork_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_sequence` integer NOT NULL,
	`source_revision` text NOT NULL,
	`settings_revision` integer NOT NULL,
	`full_consent_json` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_fork_operations_session_id_unique` ON `session_fork_operations` (`session_id`);--> statement-breakpoint
CREATE INDEX `session_forks_source_pending_idx` ON `session_fork_operations` (`source_session_id`,`ready`);--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `fork_source_run_id` text;