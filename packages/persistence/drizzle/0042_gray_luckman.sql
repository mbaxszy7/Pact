ALTER TABLE `native_agent_contexts` ADD `fork_through_sequence` integer;--> statement-breakpoint
ALTER TABLE `native_fork_intents` ADD `candidate_verified` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `native_fork_intents` ADD `phase` text DEFAULT 'fork' NOT NULL;--> statement-breakpoint
ALTER TABLE `native_fork_intents` ADD `settings_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `session_forks_one_pending_source_idx` ON `session_fork_operations` (`source_session_id`) WHERE "session_fork_operations"."ready"=0;