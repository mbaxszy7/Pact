ALTER TABLE `agent_runs` ADD `handoff_source_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `handoff_message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_runs_session_agent_accepted_idx` ON `agent_runs` (`session_id`,`agent_id`,`created_at`) WHERE "agent_runs"."native_turn_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_runs_user_agent_accepted_idx` ON `agent_runs` (`user_message_id`,`agent_id`) WHERE "agent_runs"."native_turn_id" IS NOT NULL;