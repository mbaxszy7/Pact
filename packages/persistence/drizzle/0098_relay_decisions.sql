CREATE TABLE `relay_credential_receipts` (
	`nonce` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`revision` integer NOT NULL,
	`configured` integer NOT NULL,
	`request_fingerprint` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relay_credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`ciphertext` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `scheduling_evaluations` ADD `remote_outcome` text;--> statement-breakpoint
ALTER TABLE `scheduling_runtime_owners` ADD `http_owner_json` text;--> statement-breakpoint
ALTER TABLE `scheduling_settings` DROP COLUMN `selection_json`;--> statement-breakpoint
UPDATE `scheduling_settings`
SET `enabled` = 0,
    `revision` = `revision` + 1,
    `configuration_generation` = `configuration_generation` + 1,
    `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
