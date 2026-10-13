CREATE TABLE `conversation_body_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`client_message_id` text NOT NULL,
	`owner_key` text NOT NULL,
	`purpose` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`chars` integer DEFAULT 0 NOT NULL,
	`parts` integer DEFAULT 0 NOT NULL,
	`sealed` integer DEFAULT false NOT NULL,
	`hash` text,
	`committed_message_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`committed_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_body_inputs_owner_nonce_idx` ON `conversation_body_inputs` (`owner_key`,`session_id`,`client_message_id`,`purpose`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL;--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_owner_capacity_idx` ON `conversation_body_inputs` (`owner_key`,`committed_message_id`,`bytes`,`parts`);--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_bytes_idx` ON `conversation_body_inputs` (`bytes`,`parts`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL;--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_unreferenced_expiry_idx` ON `conversation_body_inputs` (`updated_at`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL;--> statement-breakpoint
CREATE TABLE `conversation_body_parts` (
	`input_id` text NOT NULL,
	`offset` integer NOT NULL,
	`text` text NOT NULL,
	`end_bytes` integer NOT NULL,
	PRIMARY KEY(`input_id`, `offset`),
	FOREIGN KEY (`input_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE cascade
);
