CREATE TABLE `conversation_queue_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`enabled` integer,
	`target_run_id` text,
	`binding_generation` integer,
	`native_turn_id` text,
	`executor_id` text,
	`input_revision` integer,
	`result_nonce` text,
	`input_scope_json` text,
	`batch_id` text,
	`message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `collaboration_inputs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`target_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `conversation_input_batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_queue_operations_session_idx` ON `conversation_queue_operations` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_queue_operations_run_idx` ON `conversation_queue_operations` (`target_run_id`,`input_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_queue_operations_returned_idx` ON `conversation_queue_operations` (`session_id`) WHERE "conversation_queue_operations"."state" IN ('returned','installed');--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_collaboration_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
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
	`queue_state` text DEFAULT 'queued' NOT NULL,
	`queue_reason` text,
	`queue_revision` integer DEFAULT 0 NOT NULL,
	`preview` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_collaboration_inputs`("id", "session_id", "task_id", "anchor_run_id", "input_id", "metadata_json", "digest", "actor", "policy", "state", "materialized_run_id", "created_at", "deadline", "queue_state", "queue_reason", "queue_revision", "preview") SELECT "id", "session_id", "task_id", "anchor_run_id", "input_id", "metadata_json", "digest", "actor", "policy", "state", "materialized_run_id", "created_at", "deadline", CASE WHEN "state" = 'materialized' THEN 'delivered' WHEN "state" = 'cancelled' THEN 'removed' ELSE 'paused' END, CASE WHEN "state" IN ('accepted','blocked') THEN 'Queue restored after upgrade. Resume when ready.' ELSE NULL END, 0, coalesce((SELECT substr(p.text,1,512) FROM conversation_body_parts p WHERE p.input_id=collaboration_inputs.input_id ORDER BY p.offset LIMIT 1),'') FROM `collaboration_inputs`;--> statement-breakpoint
DROP TABLE `collaboration_inputs`;--> statement-breakpoint
ALTER TABLE `__new_collaboration_inputs` RENAME TO `collaboration_inputs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_inputs_pending_session` ON `collaboration_inputs` (`session_id`) WHERE "collaboration_inputs"."state" IN ('accepted','blocked');--> statement-breakpoint
CREATE INDEX `collaboration_inputs_state` ON `collaboration_inputs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `collaboration_inputs_session_created` ON `collaboration_inputs` (`session_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `collaboration_required_input_members` ADD `input_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `queue_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `queue_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `queue_pause_reason` text;