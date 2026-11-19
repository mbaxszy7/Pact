ALTER TABLE `scheduling_evaluations` ADD `input_sha256` text;--> statement-breakpoint
ALTER TABLE `scheduling_evaluations` ADD `selected_candidate_id` text;--> statement-breakpoint
ALTER TABLE `workflow_turns` ADD `task_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `workflow_turns_task_stage_revision_idx` ON `workflow_turns` (`task_id`,`stage`,`task_revision`);--> statement-breakpoint
UPDATE `workflow_turns` SET `task_revision` = json_extract(`authorization_json`, '$.taskRevision') WHERE json_valid(`authorization_json`) AND json_type(`authorization_json`, '$.taskRevision') = 'integer' AND json_extract(`authorization_json`, '$.taskRevision') >= 0;
