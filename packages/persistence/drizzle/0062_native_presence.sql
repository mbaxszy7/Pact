CREATE TABLE `native_presence_metadata` (
	`id` integer PRIMARY KEY NOT NULL,
	`opening_ordinal` integer DEFAULT 0 NOT NULL,
	`attention_total` integer DEFAULT 0 NOT NULL,
	`initialized` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_open_operations` (
	`opening_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `needs_attention_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_opened_ordinal` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `workspace_visible` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `needs_attention` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `jump_list_suppressed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `jump_list_removal_observed` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_native_recent_idx` ON `sessions` (`last_opened_ordinal`,`id`) WHERE "sessions"."workspace_visible" = 1 AND "sessions"."needs_attention" = 0 AND "sessions"."last_opened_ordinal" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sessions_native_attention_idx` ON `sessions` (`last_opened_ordinal`,`id`) WHERE "sessions"."workspace_visible" = 1 AND "sessions"."needs_attention" = 1;--> statement-breakpoint
CREATE INDEX `agent_runs_native_quit_unsettled_idx` ON `agent_runs` (`session_id`) WHERE "agent_runs"."fork_source_run_id" IS NULL AND (("agent_runs"."status" IN ('starting', 'running', 'recovering') AND "agent_runs"."control_disposition" <> 'abandoned') OR "agent_runs"."native_effects_state" IN ('pending', 'unknown') OR ("agent_runs"."dispatch_phase" IN ('possibly_sent', 'accepted', 'ended') AND "agent_runs"."native_outcome" IS NULL));--> statement-breakpoint
CREATE INDEX `agent_runs_native_latest_idx` ON `agent_runs` (`session_id`,`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_native_generation_latest_idx` ON `agent_runs` (`session_id`,`agent_id`,`binding_generation`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_runs_native_unacknowledged_idx` ON `agent_runs` (`session_id`,`agent_id`,`created_at`) WHERE "agent_runs"."fork_source_run_id" IS NULL AND "agent_runs"."control_disposition" <> 'abandoned' AND "agent_runs"."dispatch_phase" IN ('possibly_sent', 'accepted') AND "agent_runs"."status" IN ('failed', 'interrupted', 'recovering') AND "agent_runs"."native_outcome" IS NULL;--> statement-breakpoint
CREATE INDEX `conversation_messages_native_complete_idx` ON `conversation_messages` (`run_id`,`id`) WHERE "conversation_messages"."role" = 'assistant' AND "conversation_messages"."is_visible" = 1 AND "conversation_messages"."state" = 'complete' AND length("conversation_messages"."content") > 0;--> statement-breakpoint
CREATE INDEX `native_contexts_quit_unsettled_idx` ON `native_agent_contexts` (`session_id`) WHERE "native_agent_contexts"."continuation_state" IN ('responding', 'waiting_user');--> statement-breakpoint
CREATE INDEX `native_contexts_recovery_idx` ON `native_agent_contexts` (`session_id`) WHERE "native_agent_contexts"."continuation_state" IN ('responding','waiting_user','checking','rebuilding');--> statement-breakpoint
CREATE INDEX `native_fork_intents_recovery_idx` ON `native_fork_intents` (`operation_id`) WHERE "native_fork_intents"."native_work_state" = 'pending' OR "native_fork_intents"."state" IN ('forking','initializing') OR ("native_fork_intents"."state" = 'prepared' AND "native_fork_intents"."dispatched" = 0);
--> statement-breakpoint
INSERT INTO native_presence_metadata(id, opening_ordinal, attention_total, initialized) VALUES (1, 0, 0, 0);
--> statement-breakpoint
UPDATE sessions SET workspace_visible = (archived_at IS NULL AND status <> 'archived' AND EXISTS (SELECT 1 FROM projects p WHERE p.id = sessions.project_id AND p.archived_at IS NULL));
