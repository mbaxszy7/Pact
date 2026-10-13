ALTER TABLE `agent_runs` ADD `workspace_recording_unavailable_reason` text;--> statement-breakpoint
ALTER TABLE `workspace_change_sets` ADD `revision` integer DEFAULT 1 NOT NULL;