CREATE TABLE `session_group_members` (
	`session_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`group_id` text NOT NULL,
	FOREIGN KEY (`session_id`,`project_id`) REFERENCES `sessions`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`group_id`,`project_id`) REFERENCES `session_groups`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_group_members_group_idx` ON `session_group_members` (`group_id`,`project_id`,`session_id`);--> statement-breakpoint
CREATE TABLE `session_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`creation_ordinal` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`position` integer NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_groups_id_project_unique` ON `session_groups` (`id`,`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_groups_project_creation_ordinal_unique` ON `session_groups` (`project_id`,`creation_ordinal`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_groups_project_position_unique` ON `session_groups` (`project_id`,`position`);--> statement-breakpoint
CREATE INDEX `session_groups_project_position_id_idx` ON `session_groups` (`project_id`,`position`,`id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `session_group_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `next_session_group_ordinal` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_id_project_unique` ON `sessions` (`id`,`project_id`);