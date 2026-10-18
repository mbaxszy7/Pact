ALTER TABLE `conversation_queue_operations` ADD `claim_id` text;--> statement-breakpoint
ALTER TABLE `conversation_queue_operations` ADD `claim_expected_comments_revision` integer;--> statement-breakpoint
ALTER TABLE `conversation_queue_operations` ADD `installed_comments_revision` integer;