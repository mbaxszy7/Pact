CREATE TABLE `scheduling_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`selection_json` text,
	`show_indicator` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `scheduling_evaluations_activity_created` ON `scheduling_evaluations` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `scheduling_evaluations_activity_unresolved` ON `scheduling_evaluations` (`active`,`created_at`,`id`);