ALTER TABLE `conversation_input_batches` ADD `dispatch_state` text;--> statement-breakpoint
ALTER TABLE `conversation_input_batches` ADD `dispatch_metadata_json` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_input_batches_preparing_session_idx` ON `conversation_input_batches` (`session_id`) WHERE "conversation_input_batches"."dispatch_state" = 'prepared';