CREATE TABLE `conversation_output_snapshots` (
	`session_id` text NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`after_message_id` text NOT NULL,
	`source_message_id` text,
	`source_sequence` integer,
	`after_sequence` integer DEFAULT 0 NOT NULL,
	`has_body` integer DEFAULT false NOT NULL,
	`frozen` integer DEFAULT false NOT NULL,
	`context_sequence` integer NOT NULL,
	`context_rank` integer NOT NULL,
	PRIMARY KEY(`run_id`, `ordinal`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`after_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_output_snapshots_source_unique` ON `conversation_output_snapshots` (`source_message_id`);--> statement-breakpoint
CREATE INDEX `conversation_output_snapshots_session_idx` ON `conversation_output_snapshots` (`session_id`,`run_id`);--> statement-breakpoint
CREATE INDEX `conversation_output_snapshots_source_order_idx` ON `conversation_output_snapshots` (`session_id`,`source_sequence`,`source_message_id`);--> statement-breakpoint
CREATE INDEX `conversation_output_snapshots_input_order_idx` ON `conversation_output_snapshots` (`session_id`,`after_sequence`,`run_id`);--> statement-breakpoint
CREATE INDEX `conversation_output_snapshots_context_order_idx` ON `conversation_output_snapshots` (`session_id`,`context_sequence`,`run_id`) WHERE "conversation_output_snapshots"."ordinal"=0;