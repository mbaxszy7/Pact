ALTER TABLE `agent_runs` ADD `native_effects_state` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `native_effects_reason` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `reexecuted_from_run_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `reexecution_operation_id` text;--> statement-breakpoint
CREATE INDEX `agent_runs_user_created_idx` ON `agent_runs` (`user_message_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_reexecution_operation_idx` ON `agent_runs` (`reexecution_operation_id`) WHERE "agent_runs"."reexecution_operation_id" IS NOT NULL;