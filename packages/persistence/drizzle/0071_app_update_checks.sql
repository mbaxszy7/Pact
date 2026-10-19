CREATE TABLE `app_update_notices` (
	`version` text PRIMARY KEY NOT NULL,
	`notified_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_update_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`auto_check` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`release_version` text,
	`release_published_at` text,
	`release_url` text,
	`checked_at` text,
	`retry_at` text
);

--> statement-breakpoint
INSERT INTO `app_update_settings` (`id`, `auto_check`, `revision`) VALUES (1, 1, 0);
