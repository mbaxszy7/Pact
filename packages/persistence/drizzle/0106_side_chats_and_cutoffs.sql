CREATE TABLE `conversation_cutoff_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`message_id` text,
	`preserved_message_id` text NOT NULL,
	`message_sequence` integer NOT NULL,
	`role` text NOT NULL,
	`agent_id` text,
	`message_created_at` text NOT NULL,
	`valid_up_to_mutation_seq` integer NOT NULL,
	`state` text NOT NULL,
	`is_visible` integer NOT NULL,
	`content_inline` text,
	`body_input_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`body_input_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversation_cutoff_revisions_body_check" CHECK((content_inline IS NOT NULL AND body_input_id IS NULL) OR (content_inline IS NULL AND body_input_id IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_cutoff_revisions_msg_seq_unique_idx` ON `conversation_cutoff_revisions` (`preserved_message_id`,`valid_up_to_mutation_seq`);--> statement-breakpoint
CREATE INDEX `conversation_cutoff_revisions_source_msg_idx` ON `conversation_cutoff_revisions` (`source_session_id`,`preserved_message_id`,`valid_up_to_mutation_seq`);--> statement-breakpoint
CREATE INDEX `conversation_cutoff_revisions_source_seq_idx` ON `conversation_cutoff_revisions` (`source_session_id`,`message_sequence`,`valid_up_to_mutation_seq`);--> statement-breakpoint
CREATE INDEX `conversation_cutoff_revisions_body_input_idx` ON `conversation_cutoff_revisions` (`body_input_id`);--> statement-breakpoint
CREATE INDEX `conversation_body_parts_input_end_bytes_idx` ON `conversation_body_parts` (`input_id`,`end_bytes`);--> statement-breakpoint
CREATE TABLE `conversation_cutoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_operation_id` text NOT NULL,
	`max_message_sequence` integer NOT NULL,
	`session_mutation_seq` integer NOT NULL,
	`streaming_message_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "conversation_cutoffs_bounds_check" CHECK(max_message_sequence >= -1 AND session_mutation_seq >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_cutoffs_owner_unique_idx` ON `conversation_cutoffs` (`owner_kind`,`owner_operation_id`);--> statement-breakpoint
CREATE INDEX `conversation_cutoffs_source_seq_idx` ON `conversation_cutoffs` (`source_session_id`,`session_mutation_seq`);--> statement-breakpoint
CREATE INDEX `conversation_cutoffs_source_max_msg_idx` ON `conversation_cutoffs` (`source_session_id`,`max_message_sequence`,`session_mutation_seq`);--> statement-breakpoint
CREATE TABLE `side_chat_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`request_sha256` text NOT NULL,
	`receipt_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `side_chat_operations_session_kind_idx` ON `side_chat_operations` (`session_id`,`kind`);--> statement-breakpoint
CREATE INDEX `side_chat_operations_target_kind_idx` ON `side_chat_operations` (`target_session_id`,`kind`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_session_id` text REFERENCES `sessions`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `sessions` ADD `side_chat_origin` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_cutoff_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_message_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_quote` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_quote_preview` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_start_offset` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `anchor_end_offset` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `mutation_seq` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `sessions_side_chat_origin_insert_check` BEFORE INSERT ON `sessions` FOR EACH ROW
WHEN (CASE WHEN (((NEW.parent_session_id IS NULL AND NEW.side_chat_origin IS NULL AND NEW.anchor_cutoff_id IS NULL AND NEW.anchor_message_id IS NULL AND NEW.anchor_quote IS NULL AND NEW.anchor_quote_preview IS NULL AND NEW.anchor_start_offset IS NULL AND NEW.anchor_end_offset IS NULL) OR (NEW.parent_session_id IS NOT NULL AND NEW.parent_session_id <> NEW.id AND NEW.side_chat_origin = 'selection' AND NEW.anchor_cutoff_id IS NOT NULL AND NEW.anchor_message_id IS NOT NULL AND NEW.anchor_quote IS NOT NULL AND NEW.anchor_quote_preview IS NOT NULL AND NEW.anchor_start_offset IS NOT NULL AND NEW.anchor_end_offset IS NOT NULL AND NEW.anchor_start_offset >= 0 AND NEW.anchor_end_offset > NEW.anchor_start_offset) OR (NEW.parent_session_id IS NOT NULL AND NEW.parent_session_id <> NEW.id AND NEW.side_chat_origin = 'btw' AND NEW.anchor_cutoff_id IS NOT NULL AND NEW.anchor_message_id IS NULL AND NEW.anchor_quote IS NULL AND NEW.anchor_quote_preview IS NULL AND NEW.anchor_start_offset IS NULL AND NEW.anchor_end_offset IS NULL))) THEN 1 ELSE 0 END) = 0
BEGIN
	SELECT RAISE(ABORT, 'CHECK constraint failed: sessions_side_chat_origin_check');
END;--> statement-breakpoint
CREATE TRIGGER `sessions_side_chat_origin_update_check` BEFORE UPDATE ON `sessions` FOR EACH ROW
WHEN (CASE WHEN (((NEW.parent_session_id IS NULL AND NEW.side_chat_origin IS NULL AND NEW.anchor_cutoff_id IS NULL AND NEW.anchor_message_id IS NULL AND NEW.anchor_quote IS NULL AND NEW.anchor_quote_preview IS NULL AND NEW.anchor_start_offset IS NULL AND NEW.anchor_end_offset IS NULL) OR (NEW.parent_session_id IS NOT NULL AND NEW.parent_session_id <> NEW.id AND NEW.side_chat_origin = 'selection' AND NEW.anchor_cutoff_id IS NOT NULL AND NEW.anchor_message_id IS NOT NULL AND NEW.anchor_quote IS NOT NULL AND NEW.anchor_quote_preview IS NOT NULL AND NEW.anchor_start_offset IS NOT NULL AND NEW.anchor_end_offset IS NOT NULL AND NEW.anchor_start_offset >= 0 AND NEW.anchor_end_offset > NEW.anchor_start_offset) OR (NEW.parent_session_id IS NOT NULL AND NEW.parent_session_id <> NEW.id AND NEW.side_chat_origin = 'btw' AND NEW.anchor_cutoff_id IS NOT NULL AND NEW.anchor_message_id IS NULL AND NEW.anchor_quote IS NULL AND NEW.anchor_quote_preview IS NULL AND NEW.anchor_start_offset IS NULL AND NEW.anchor_end_offset IS NULL))) THEN 1 ELSE 0 END) = 0
BEGIN
	SELECT RAISE(ABORT, 'CHECK constraint failed: sessions_side_chat_origin_check');
END;--> statement-breakpoint
DROP INDEX IF EXISTS `sessions_native_recent_idx`;--> statement-breakpoint
CREATE INDEX `sessions_native_recent_idx` ON `sessions` (`last_opened_ordinal`,`id`) WHERE "sessions"."workspace_visible" = 1 AND "sessions"."needs_attention" = 0 AND "sessions"."last_opened_ordinal" IS NOT NULL AND "sessions"."parent_session_id" IS NULL;--> statement-breakpoint
CREATE INDEX `sessions_parent_created_id_idx` ON `sessions` (`parent_session_id`,`created_at`,`id`);--> statement-breakpoint
ALTER TABLE `conversation_image_assets` ADD `storage_object_id` text;--> statement-breakpoint
CREATE INDEX `conversation_image_assets_storage_object_idx` ON `conversation_image_assets` (`storage_object_id`);--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `origin_side_chat_json` text;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `delivered_cutoff_ids_json` text;--> statement-breakpoint
CREATE TRIGGER `conversation_messages_cutoff_preserve_before_delete` BEFORE DELETE ON `conversation_messages` FOR EACH ROW
WHEN EXISTS (SELECT 1 FROM `sessions` s WHERE s.`id` = OLD.`session_id`)
 AND EXISTS (
   SELECT 1 FROM `conversation_cutoffs` c
   WHERE c.`source_session_id` = OLD.`session_id`
     AND c.`max_message_sequence` >= OLD.`sequence`
 )
 AND NOT EXISTS (
   SELECT 1 FROM `conversation_cutoff_revisions` r
   WHERE r.`source_session_id` = OLD.`session_id`
     AND r.`preserved_message_id` = OLD.`id`
     AND r.`valid_up_to_mutation_seq` >= (
       SELECT max(c2.`session_mutation_seq`) FROM `conversation_cutoffs` c2
       WHERE c2.`source_session_id` = OLD.`session_id`
         AND c2.`max_message_sequence` >= OLD.`sequence`
     )
 )
BEGIN
  INSERT INTO `conversation_cutoff_revisions` (
    `id`,
    `source_session_id`,
    `message_id`,
    `preserved_message_id`,
    `message_sequence`,
    `role`,
    `agent_id`,
    `message_created_at`,
    `valid_up_to_mutation_seq`,
    `state`,
    `is_visible`,
    `content_inline`,
    `body_input_id`,
    `created_at`
  )
  VALUES (
    lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-8' || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))),
    OLD.`session_id`,
    OLD.`id`,
    OLD.`id`,
    OLD.`sequence`,
    OLD.`role`,
    OLD.`agent_id`,
    OLD.`created_at`,
    (
      SELECT max(c3.`session_mutation_seq`) FROM `conversation_cutoffs` c3
      WHERE c3.`source_session_id` = OLD.`session_id`
        AND c3.`max_message_sequence` >= OLD.`sequence`
    ),
    CASE WHEN OLD.`state` = 'streaming' THEN 'incomplete' ELSE OLD.`state` END,
    OLD.`is_visible`,
    OLD.`content`,
    NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;--> statement-breakpoint
ALTER TABLE `sessions` ADD `next_message_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sessions` SET `next_message_sequence` = max(
  COALESCE((SELECT max(m.`sequence`) + 1 FROM `conversation_messages` m WHERE m.`session_id` = `sessions`.`id`), 0),
  COALESCE((SELECT max(c.`max_message_sequence`) + 1 FROM `conversation_cutoffs` c WHERE c.`source_session_id` = `sessions`.`id`), 0)
);--> statement-breakpoint
CREATE TRIGGER `conversation_messages_next_seq_after_insert` AFTER INSERT ON `conversation_messages` FOR EACH ROW
BEGIN
  UPDATE `sessions`
  SET `next_message_sequence` = max(`next_message_sequence`, NEW.`sequence` + 1)
  WHERE `id` = NEW.`session_id`;
END;--> statement-breakpoint
DROP INDEX IF EXISTS `conversation_body_inputs_owner_capacity_idx`;--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_owner_capacity_idx` ON `conversation_body_inputs` (`owner_key`,`bytes`,`parts`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL AND "conversation_body_inputs"."pending_receipt_id" IS NULL AND "conversation_body_inputs"."source_run_id" IS NULL AND "conversation_body_inputs"."purpose" <> 'cutoff';--> statement-breakpoint
DROP INDEX IF EXISTS `conversation_body_inputs_bytes_idx`;--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_bytes_idx` ON `conversation_body_inputs` (`bytes`,`parts`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL AND "conversation_body_inputs"."pending_receipt_id" IS NULL AND "conversation_body_inputs"."source_run_id" IS NULL AND "conversation_body_inputs"."purpose" <> 'cutoff';--> statement-breakpoint
DROP INDEX IF EXISTS `conversation_body_inputs_unreferenced_expiry_idx`;--> statement-breakpoint
CREATE INDEX `conversation_body_inputs_unreferenced_expiry_idx` ON `conversation_body_inputs` (`updated_at`) WHERE "conversation_body_inputs"."committed_message_id" IS NULL AND "conversation_body_inputs"."pending_receipt_id" IS NULL AND "conversation_body_inputs"."source_run_id" IS NULL AND "conversation_body_inputs"."purpose" <> 'cutoff';