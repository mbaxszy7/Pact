CREATE TABLE `workflow_turns` (
	`run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`stage` text NOT NULL,
	`actor` text NOT NULL,
	`input_sequence` integer NOT NULL,
	`authorization_json` text NOT NULL,
	`state_json` text NOT NULL,
	`plan_body_id` text,
	`plan_native_id` text,
	`verdict` text,
	`verdict_conflict` integer DEFAULT false NOT NULL,
	`report_body_id` text,
	`applied` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_body_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_body_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workflow_turns_task_created_idx` ON `workflow_turns` (`task_id`,`created_at`);
--> statement-breakpoint
UPDATE `collaboration_tasks`
SET `active` = 0
WHERE `active` = 1 AND coalesce(json_extract(`state_json`, '$.protocol'), '') <> 'native-workflow-v1';
