ALTER TABLE `sessions` ADD `title_source` text DEFAULT 'placeholder' NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `status` = 'idle' WHERE `status` = 'waiting_for_user';
