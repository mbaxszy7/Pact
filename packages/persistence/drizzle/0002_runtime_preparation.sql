CREATE TABLE `app_setup_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
INSERT INTO `app_setup_state` (`id`, `completed_at`) VALUES (1, NULL);
--> statement-breakpoint
CREATE TABLE `runtime_cli_paths` (
	`agent_id` text PRIMARY KEY NOT NULL,
	`executable_path` text NOT NULL,
	`updated_at` text NOT NULL
);
