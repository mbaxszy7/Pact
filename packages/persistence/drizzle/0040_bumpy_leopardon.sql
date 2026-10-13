ALTER TABLE `native_rebuild_operations` ADD `check_action` text DEFAULT 'inspect' NOT NULL;--> statement-breakpoint
ALTER TABLE `native_rebuild_operations` ADD `native_work_state` text DEFAULT 'not_dispatched' NOT NULL;--> statement-breakpoint
ALTER TABLE `native_rebuild_operations` ADD `creation_executor_id` text;--> statement-breakpoint
CREATE INDEX `native_rebuild_operations_unsettled_work_idx` ON `native_rebuild_operations` (`session_id`) WHERE "native_rebuild_operations"."native_work_state" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX `agent_runs_session_unsettled_work_idx` ON `agent_runs` (`session_id`) WHERE ("agent_runs"."status" IN ('starting', 'running', 'recovering') AND "agent_runs"."control_disposition" <> 'abandoned') OR "agent_runs"."native_effects_state" IN ('pending', 'unknown');--> statement-breakpoint
CREATE INDEX `sessions_project_native_work_idx` ON `sessions` (`project_id`,`id`);
--> statement-breakpoint
UPDATE native_rebuild_operations SET native_work_state = CASE WHEN stage = 'completed' THEN 'settled' WHEN stage IN ('preparing', 'failed') THEN 'not_dispatched' ELSE 'unknown' END;
