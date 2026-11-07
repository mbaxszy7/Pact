CREATE TABLE `collaboration_action_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`client_nonce` text NOT NULL,
	`request_digest` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`handoff_id` text NOT NULL,
	`decision_id` text,
	`root_receipt_id` text NOT NULL,
	`basis_json` text NOT NULL,
	`state` text NOT NULL,
	`bound_run_id` text,
	`budget_reservation_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `relay_decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bound_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_nonce` ON `collaboration_action_receipts` (`session_id`,`client_nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_handoff` ON `collaboration_action_receipts` (`handoff_id`) WHERE "collaboration_action_receipts"."active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_run` ON `collaboration_action_receipts` (`bound_run_id`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_session_state` ON `collaboration_action_receipts` (`session_id`,`state`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_task_state` ON `collaboration_action_receipts` (`task_id`,`state`);--> statement-breakpoint
CREATE TABLE `relay_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`matter_key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`after_run_id` text NOT NULL,
	`handoff_id` text,
	`proof_json` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`after_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_decisions_active_matter` ON `relay_decisions` (`session_id`,`matter_key`) WHERE "relay_decisions"."active" = 1;--> statement-breakpoint
CREATE INDEX `relay_decisions_session_active` ON `relay_decisions` (`session_id`,`active`);--> statement-breakpoint
CREATE INDEX `relay_decisions_task_state` ON `relay_decisions` (`task_id`,`state`);