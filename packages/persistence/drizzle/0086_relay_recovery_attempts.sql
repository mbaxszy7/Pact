CREATE TABLE `scheduling_recovery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`fault_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`handoff_json` text NOT NULL,
	`utility_pid` integer NOT NULL,
	`physical_owner_json` text NOT NULL,
	`started` integer DEFAULT false NOT NULL,
	`result` text DEFAULT 'reserved' NOT NULL,
	`physical_released` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`deadline` text NOT NULL,
	FOREIGN KEY (`id`) REFERENCES `scheduling_runtime_owners`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fault_id`) REFERENCES `scheduling_recovery_faults`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`reservation_id`) REFERENCES `scheduling_budget_reservations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `scheduling_recovery_attempts_fault` ON `scheduling_recovery_attempts` (`fault_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `scheduling_recovery_faults` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`fault_kind` text NOT NULL,
	`fault_id` text NOT NULL,
	`run_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`utility_epoch` text NOT NULL,
	`configuration_generation` integer NOT NULL,
	`origin_sequence` integer NOT NULL,
	`observed_fingerprint` text NOT NULL,
	`considered_fingerprint` text,
	`armed` integer DEFAULT false NOT NULL,
	`pending` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`latest_action` text DEFAULT 'check' NOT NULL,
	`result` text DEFAULT 'not_sent' NOT NULL,
	`physical_unconfirmed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`activity_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_recovery_faults_origin` ON `scheduling_recovery_faults` (`fault_kind`,`fault_id`);--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_eligible` ON `scheduling_recovery_faults` (`utility_epoch`,`configuration_generation`,`active`,`pending`,`id`);--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_session` ON `scheduling_recovery_faults` (`session_id`,`agent_id`,`fault_kind`,`active`);--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_activity` ON `scheduling_recovery_faults` (`activity_at`,`id`);--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_unresolved` ON `scheduling_recovery_faults` (`physical_unconfirmed`,`activity_at`,`id`);