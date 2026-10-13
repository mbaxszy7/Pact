CREATE TABLE `native_rebuild_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`old_generation` integer NOT NULL,
	`old_native_session_id` text,
	`abandon` integer NOT NULL,
	`stage` text NOT NULL,
	`provisional_native_session_id` text,
	`source_hash` text,
	`source_chunks_json` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`through_sequence` integer DEFAULT -1 NOT NULL,
	`failure_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `native_rebuild_operations_binding_idx` ON `native_rebuild_operations` (`session_id`,`agent_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `native_rebuild_operations_one_pending_idx` ON `native_rebuild_operations` (`session_id`,`agent_id`) WHERE "native_rebuild_operations"."stage" IN ('preparing', 'creating', 'seeding', 'unconfirmed');--> statement-breakpoint
DROP INDEX `agent_runs_one_active_per_session`;--> statement-breakpoint
DROP INDEX `agent_runs_user_artifacts_idx`;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `binding_generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `executor_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `control_disposition` text DEFAULT 'retained' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `dispatch_phase` text DEFAULT 'not_sent' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `native_outcome` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_one_active_per_session` ON `agent_runs` (`session_id`) WHERE "agent_runs"."status" IN ('starting', 'running', 'recovering') AND "agent_runs"."control_disposition" <> 'abandoned';--> statement-breakpoint
CREATE INDEX `agent_runs_user_artifacts_idx` ON `agent_runs` (`user_message_id`,`agent_id`,`created_at`,`id`) WHERE "agent_runs"."workspace_changes_json" IS NOT NULL OR "agent_runs"."control_disposition" = 'abandoned';--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `binding_generation` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `executor_id` text;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `continuation_state` text DEFAULT 'recovery_required' NOT NULL;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `recovery_reason` text;
--> statement-breakpoint
UPDATE agent_runs SET dispatch_phase = CASE
  WHEN native_session_id IS NOT NULL OR native_turn_id IS NOT NULL OR native_effects_state IN ('pending','unknown') THEN 'possibly_sent'
  ELSE 'not_sent' END;
--> statement-breakpoint
UPDATE native_agent_contexts SET continuation_state='recovery_required',
  recovery_reason='This saved binding needs a native-state check after the recovery upgrade.';
