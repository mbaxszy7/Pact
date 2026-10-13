CREATE TABLE `conversation_image_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`owner_session_id` text NOT NULL,
	`name` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	`committed` integer DEFAULT false NOT NULL,
	`media_type` text,
	`width` integer,
	`height` integer,
	`sha256` text,
	`thumbnail_bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_image_assets_owner_temp_idx` ON `conversation_image_assets` (`owner_key`) WHERE "conversation_image_assets"."committed" = 0;--> statement-breakpoint
CREATE INDEX `conversation_image_assets_temp_idx` ON `conversation_image_assets` (`updated_at`) WHERE "conversation_image_assets"."committed" = 0;--> statement-breakpoint
CREATE TABLE `conversation_message_images` (
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`image_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `ordinal`),
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `conversation_image_assets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_message_images_unique_idx` ON `conversation_message_images` (`message_id`,`image_id`);--> statement-breakpoint
CREATE INDEX `conversation_message_images_asset_idx` ON `conversation_message_images` (`image_id`);