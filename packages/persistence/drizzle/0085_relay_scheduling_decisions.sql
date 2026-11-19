CREATE TABLE `__new_relay_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`matter_key` text NOT NULL,
	`kind` text NOT NULL,
	`format_version` integer DEFAULT 1 NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`after_run_id` text,
	`handoff_id` text,
	`proof_json` text NOT NULL,
	`answer_nonce` text,
	`answer_digest` text,
	`answer_json` text,
	`result_json` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`after_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_relay_decisions`("id", "session_id", "task_id", "matter_key", "kind", "format_version", "state", "revision", "after_run_id", "handoff_id", "proof_json", "answer_nonce", "answer_digest", "answer_json", "result_json", "active", "created_at", "updated_at") SELECT "id", "session_id", "task_id", "matter_key", "kind", 1, "state", "revision", "after_run_id", "handoff_id", "proof_json", NULL, NULL, NULL, NULL, "active", "created_at", "updated_at" FROM `relay_decisions`;--> statement-breakpoint
CREATE TABLE `__new_collaboration_action_receipts` (
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
	`review_state` text,
	`review_run_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`decision_id`) REFERENCES `__new_relay_decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bound_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action
);

--> statement-breakpoint
INSERT INTO `__new_collaboration_action_receipts` (`id`, `session_id`, `task_id`, `client_nonce`, `request_digest`, `action`, `actor`, `handoff_id`, `decision_id`, `root_receipt_id`, `basis_json`, `state`, `bound_run_id`, `budget_reservation_id`, `active`, `created_at`, `updated_at`, `review_state`, `review_run_id`) SELECT `id`, `session_id`, `task_id`, `client_nonce`, `request_digest`, `action`, `actor`, `handoff_id`, `decision_id`, `root_receipt_id`, `basis_json`, `state`, `bound_run_id`, `budget_reservation_id`, `active`, `created_at`, `updated_at`, `review_state`, `review_run_id` FROM `collaboration_action_receipts`;
--> statement-breakpoint
DROP TABLE `collaboration_action_receipts`;
--> statement-breakpoint
DROP TABLE `relay_decisions`;--> statement-breakpoint
ALTER TABLE `__new_relay_decisions` RENAME TO `relay_decisions`;--> statement-breakpoint
ALTER TABLE `__new_collaboration_action_receipts` RENAME TO `collaboration_action_receipts`;--> statement-breakpoint
CREATE UNIQUE INDEX `relay_decisions_active_matter` ON `relay_decisions` (`session_id`,`matter_key`) WHERE "relay_decisions"."active" = 1;--> statement-breakpoint
CREATE INDEX `relay_decisions_session_active` ON `relay_decisions` (`session_id`,`active`);--> statement-breakpoint
CREATE INDEX `relay_decisions_task_state` ON `relay_decisions` (`task_id`,`state`);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_nonce` ON `collaboration_action_receipts` (`session_id`,`client_nonce`);--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_handoff` ON `collaboration_action_receipts` (`handoff_id`) WHERE "collaboration_action_receipts"."active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_run` ON `collaboration_action_receipts` (`bound_run_id`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_session_state` ON `collaboration_action_receipts` (`session_id`,`state`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_task_state` ON `collaboration_action_receipts` (`task_id`,`state`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_pending_review` ON `collaboration_action_receipts` (`task_id`,`id`) WHERE "collaboration_action_receipts"."review_state" = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_review_run` ON `collaboration_action_receipts` (`review_run_id`);
--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_unsettled` ON `collaboration_action_receipts` (`id`) WHERE "collaboration_action_receipts"."bound_run_id" IS NOT NULL AND "collaboration_action_receipts"."state" IN ('bound', 'unknown');
