ALTER TABLE `agent_run_activities` ADD `detail_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_run_activities_run_sequence_idx` ON `agent_run_activities` (`run_id`,`sequence`);--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `content_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `anchored_comments_sent_message_position_idx` ON `anchored_comments` (`sent_with_message_id`,`position`);--> statement-breakpoint
CREATE INDEX `anchored_comments_session_draft_position_idx` ON `anchored_comments` (`session_id`,`position`) WHERE "anchored_comments"."sent_with_message_id" IS NULL;