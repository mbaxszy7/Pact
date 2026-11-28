CREATE TABLE `run_execution_inputs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`document_json` text NOT NULL,
	`requested_json` text NOT NULL,
	`effective_json` text,
	`proof_json` text,
	`native_generation` text NOT NULL,
	`configuration_generation` integer NOT NULL,
	`utility_epoch` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `run_reexecution_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`fault_id` text NOT NULL,
	`original_run_id` text NOT NULL,
	`replacement_run_id` text NOT NULL,
	`budget_reservation_id` text NOT NULL,
	`handoff_json` text NOT NULL,
	`result` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`fault_id`) REFERENCES `scheduling_recovery_faults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`original_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`replacement_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`budget_reservation_id`) REFERENCES `scheduling_budget_reservations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_reexecution_operations_fault` ON `run_reexecution_operations` (`fault_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `run_reexecution_operations_replacement` ON `run_reexecution_operations` (`replacement_run_id`);--> statement-breakpoint
CREATE INDEX `run_reexecution_operations_original` ON `run_reexecution_operations` (`original_run_id`);