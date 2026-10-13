CREATE TABLE `appearance_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`theme` text NOT NULL,
	`window_material` text NOT NULL,
	`material_opacity` integer NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `appearance_settings` (`id`, `theme`, `window_material`, `material_opacity`, `revision`, `updated_at`)
VALUES (1, 'system', 'system', 85, 0, CURRENT_TIMESTAMP);
