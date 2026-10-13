CREATE TABLE `anchored_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`body` text NOT NULL,
	`anchor_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`sent_with_message_id` text,
	`position` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sent_with_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anchored_comments_session_position_unique` ON `anchored_comments` (`session_id`,`position`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `comments_revision` integer DEFAULT 0 NOT NULL;