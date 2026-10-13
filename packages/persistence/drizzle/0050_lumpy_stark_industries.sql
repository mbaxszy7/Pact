CREATE TABLE `collaboration_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`anchor_run_id` text NOT NULL,
	`input_id` text NOT NULL,
	`metadata_json` text NOT NULL,
	`digest` text NOT NULL,
	`actor` text NOT NULL,
	`policy` text NOT NULL,
	`state` text NOT NULL,
	`materialized_run_id` text,
	`created_at` text NOT NULL,
	`deadline` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_inputs_pending_session` ON `collaboration_inputs` (`session_id`) WHERE "collaboration_inputs"."state" IN ('accepted', 'blocked');--> statement-breakpoint
CREATE INDEX `collaboration_inputs_state` ON `collaboration_inputs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `collaboration_inputs_session_created` ON `collaboration_inputs` (`session_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `anchored_comments` ADD `pending_receipt_id` text;--> statement-breakpoint
ALTER TABLE `conversation_body_inputs` ADD `pending_receipt_id` text;--> statement-breakpoint
ALTER TABLE `conversation_image_assets` ADD `pending_receipt_id` text;