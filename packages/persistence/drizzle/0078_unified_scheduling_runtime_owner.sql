CREATE TABLE `scheduling_runtime_owners` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text,
	`evaluation_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`configuration_fingerprint` text NOT NULL,
	`physical_witness_json` text,
	`active` integer DEFAULT true NOT NULL,
	`phase` text DEFAULT 'reserved' NOT NULL,
	`created_at` text NOT NULL,
	`deadline` text NOT NULL,
	`settled_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`evaluation_id`) REFERENCES `scheduling_evaluations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_runtime_owners_active_app` ON `scheduling_runtime_owners` (`active`) WHERE "scheduling_runtime_owners"."active" = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_runtime_owners_evaluation` ON `scheduling_runtime_owners` (`evaluation_id`);--> statement-breakpoint
INSERT INTO `scheduling_runtime_owners` (`id`, `kind`, `session_id`, `evaluation_id`, `provider`, `model`, `configuration_fingerprint`, `physical_witness_json`, `active`, `phase`, `created_at`, `deadline`)
SELECT `id`, 'evaluation', `session_id`, `id`, `provider`, `model`, `configuration_fingerprint`, `physical_witness_json`, 1, 'cleanup_unconfirmed', `created_at`, `deadline`
FROM `scheduling_evaluations` WHERE `active` = 1;
