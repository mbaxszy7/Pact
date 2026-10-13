CREATE TABLE `collaboration_report_items` (
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`item_id` text NOT NULL,
	`category` text NOT NULL,
	`disposition` text NOT NULL,
	`document_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `ordinal`),
	FOREIGN KEY (`run_id`) REFERENCES `collaboration_turns`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_report_items_identity` ON `collaboration_report_items` (`run_id`,`item_id`);--> statement-breakpoint
ALTER TABLE `collaboration_turns` ADD `native_envelope_body_id` text REFERENCES conversation_body_inputs(id);--> statement-breakpoint
ALTER TABLE `collaboration_turns` ADD `answer_projection_body_id` text REFERENCES conversation_body_inputs(id);--> statement-breakpoint
ALTER TABLE `conversation_body_inputs` ADD `source_run_id` text REFERENCES agent_runs(id);