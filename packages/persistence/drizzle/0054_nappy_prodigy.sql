CREATE TABLE `collaboration_markdown_pages` (
	`document_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`visible_start` integer NOT NULL,
	`visible_end` integer NOT NULL,
	`tree_json` text NOT NULL,
	`visible_text` text NOT NULL,
	PRIMARY KEY(`document_id`, `ordinal`),
	FOREIGN KEY (`document_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaboration_markdown_pages_range` ON `collaboration_markdown_pages` (`document_id`,`visible_start`,`visible_end`);--> statement-breakpoint
ALTER TABLE `conversation_body_inputs` ADD `projection_pages` integer;