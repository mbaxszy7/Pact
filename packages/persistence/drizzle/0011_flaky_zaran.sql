DROP INDEX `agent_run_activities_run_native_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_run_activities_run_kind_native_unique` ON `agent_run_activities` (`run_id`,`kind`,`native_id`);