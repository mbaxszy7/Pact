CREATE TABLE `session_catalog_revisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `session_catalog_revisions` (`id`, `revision`) VALUES (1, 0);
--> statement-breakpoint
CREATE INDEX `sessions_project_created_id_active_idx` ON `sessions` (`project_id`,`created_at`,`id`) WHERE "sessions"."status" <> 'archived';
