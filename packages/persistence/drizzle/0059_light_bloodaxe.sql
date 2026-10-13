ALTER TABLE `collaboration_turns` ADD `completed_failure_revision` integer;--> statement-breakpoint
CREATE INDEX `anchored_comments_message_source_idx` ON `anchored_comments` (`session_id`, json_extract(`anchor_json`, '$.messageId')) WHERE json_extract(`anchor_json`, '$.type') = 'message';
