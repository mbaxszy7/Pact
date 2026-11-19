CREATE TABLE `scheduling_budget_counters` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`evaluation_calls` integer DEFAULT 0 NOT NULL,
	`extra_plan_turns` integer DEFAULT 0 NOT NULL,
	`extra_code_turns` integer DEFAULT 0 NOT NULL,
	`automatic_checks` integer DEFAULT 0 NOT NULL,
	`automatic_resends` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scheduling_budget_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`budget_subject_id` text NOT NULL,
	`fault_subject_id` text,
	`fact_fingerprint` text NOT NULL,
	`budget` text NOT NULL,
	`authorization_id` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`handoff_id`) REFERENCES `scheduling_handoffs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_budget_reservations_handoff` ON `scheduling_budget_reservations` (`handoff_id`,`budget`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_budget_reservations_fault_fact` ON `scheduling_budget_reservations` (`fault_subject_id`,`budget`,`fact_fingerprint`);--> statement-breakpoint
CREATE TABLE `scheduling_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`handoff_id` text NOT NULL,
	`budget_subject_id` text NOT NULL,
	`fact_fingerprint` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`configuration_fingerprint` text NOT NULL,
	`handoff_json` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`called` integer DEFAULT false NOT NULL,
	`outcome` text NOT NULL,
	`usage_json` text,
	`created_at` text NOT NULL,
	`deadline` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`handoff_id`) REFERENCES `scheduling_handoffs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_evaluations_fact` ON `scheduling_evaluations` (`budget_subject_id`,`fact_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_evaluations_active_app` ON `scheduling_evaluations` (`active`) WHERE "scheduling_evaluations"."active" = 1;--> statement-breakpoint
CREATE INDEX `scheduling_evaluations_handoff` ON `scheduling_evaluations` (`handoff_id`);--> statement-breakpoint
CREATE TABLE `scheduling_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`budget_subject_id` text NOT NULL,
	`event_id` text NOT NULL,
	`slot` text NOT NULL,
	`fault_subject_id` text,
	`fact_fingerprint` text NOT NULL,
	`freshness_guard_json` text NOT NULL,
	`action` text,
	`run_id` text,
	`operation_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_handoffs_event_slot` ON `scheduling_handoffs` (`budget_subject_id`,`event_id`,`slot`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_handoffs_run` ON `scheduling_handoffs` (`run_id`);