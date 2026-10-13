CREATE TABLE `collaboration_required_input_members` (
	`run_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`member_id` text NOT NULL,
	PRIMARY KEY(`run_id`, `batch_id`, `member_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `conversation_input_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collaboration_result_applications` (
	`run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`result_id` text NOT NULL,
	`manifest_json` text NOT NULL,
	`source_json` text NOT NULL,
	`digest` text NOT NULL,
	`state` text DEFAULT 'archived' NOT NULL,
	`settlement_revision` integer,
	`reason` text,
	`created_at` text NOT NULL,
	`applied_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_result_applications_identity_idx` ON `collaboration_result_applications` (`task_id`,`result_id`);--> statement-breakpoint
CREATE TABLE `collaboration_result_input_responses` (
	`run_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`disposition` text NOT NULL,
	`todo_id` text,
	`document_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `batch_id`, `member_id`),
	FOREIGN KEY (`run_id`) REFERENCES `collaboration_result_applications`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collaboration_result_operations` (
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`todo_id` text NOT NULL,
	`expected_revision` integer NOT NULL,
	`operation` text NOT NULL,
	`title_preview` text NOT NULL,
	`document_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `ordinal`),
	FOREIGN KEY (`run_id`) REFERENCES `collaboration_result_applications`(`run_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_result_operations_todo_idx` ON `collaboration_result_operations` (`run_id`,`todo_id`);--> statement-breakpoint
CREATE TABLE `collaboration_review_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text NOT NULL,
	`reviewer` text NOT NULL,
	`phase` text NOT NULL,
	`basis_json` text NOT NULL,
	`ledger_revision` integer NOT NULL,
	`input_watermark` integer NOT NULL,
	`verdict` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_review_facts_run_idx` ON `collaboration_review_facts` (`run_id`);--> statement-breakpoint
CREATE INDEX `collaboration_review_facts_task_phase_idx` ON `collaboration_review_facts` (`task_id`,`phase`,`created_at`);--> statement-breakpoint
CREATE TABLE `collaboration_todo_revisions` (
	`task_id` text NOT NULL,
	`todo_id` text NOT NULL,
	`revision` integer NOT NULL,
	`ledger_revision` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title_preview` text NOT NULL,
	`author` text NOT NULL,
	`source_run_id` text NOT NULL,
	`document_json` text NOT NULL,
	`document_id` text NOT NULL,
	`content_document_json` text NOT NULL,
	`content_document_id` text NOT NULL,
	`reason_document_json` text,
	`reason_document_id` text,
	`resolution_kind` text,
	`merged_into` text,
	`question_id` text,
	`question_revision` integer,
	`question_json` text,
	`answer_resolver` text,
	`confirmed_by` text,
	`confirmed_run_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `todo_id`, `revision`),
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaboration_todo_revisions_snapshot_idx` ON `collaboration_todo_revisions` (`task_id`,`todo_id`,`ledger_revision`,`revision`);--> statement-breakpoint
CREATE INDEX `collaboration_todo_revisions_frozen_page_idx` ON `collaboration_todo_revisions` (`task_id`,`ordinal`,`ledger_revision`);--> statement-breakpoint
CREATE INDEX `collaboration_todo_revisions_document_idx` ON `collaboration_todo_revisions` (`task_id`,`document_id`,`ledger_revision`);--> statement-breakpoint
CREATE INDEX `collaboration_todo_revisions_reason_idx` ON `collaboration_todo_revisions` (`task_id`,`reason_document_id`,`ledger_revision`);--> statement-breakpoint
CREATE INDEX `collaboration_todo_revisions_content_idx` ON `collaboration_todo_revisions` (`task_id`,`content_document_id`,`ledger_revision`);--> statement-breakpoint
CREATE TABLE `collaboration_todos` (
	`task_id` text NOT NULL,
	`todo_id` text NOT NULL,
	`revision` integer NOT NULL,
	`ledger_revision` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`title_preview` text NOT NULL,
	`author` text NOT NULL,
	`source_run_id` text NOT NULL,
	`document_json` text NOT NULL,
	`document_id` text NOT NULL,
	`content_document_json` text NOT NULL,
	`content_document_id` text NOT NULL,
	`reason_document_json` text,
	`reason_document_id` text,
	`resolution_kind` text,
	`merged_into` text,
	`question_id` text,
	`question_revision` integer,
	`question_json` text,
	`answer_resolver` text,
	`confirmed_by` text,
	`confirmed_run_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `todo_id`),
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_todos_task_ordinal_idx` ON `collaboration_todos` (`task_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `collaboration_todos_task_status_ordinal_idx` ON `collaboration_todos` (`task_id`,`status`,`ordinal`);--> statement-breakpoint
CREATE INDEX `collaboration_todos_question_idx` ON `collaboration_todos` (`task_id`,`question_id`,`question_revision`);--> statement-breakpoint
CREATE TABLE `collaboration_turn_authorizations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor` text NOT NULL,
	`duty` text NOT NULL,
	`ledger_revision` integer NOT NULL,
	`input_watermark` integer NOT NULL,
	`input_sequence` integer NOT NULL,
	`input_batch_id` text,
	`basis_json` text NOT NULL,
	`authorization_json` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `collaboration_turn_authorizations_task_idx` ON `collaboration_turn_authorizations` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `comment_draft_receipts` (
	`request_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`comment_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`comments_revision` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `comment_draft_receipts_session_idx` ON `comment_draft_receipts` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversation_input_batch_members` (
	`batch_id` text NOT NULL,
	`member_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`comment_id` text NOT NULL,
	`comment_revision` integer NOT NULL,
	`anchor_json` text NOT NULL,
	`anchor_document_json` text,
	`source_task_id` text,
	`source_todo_id` text,
	`question_id` text,
	`question_revision` integer,
	`body_sha256` text NOT NULL,
	`body_document_json` text,
	`answer_resolver` text,
	`state` text DEFAULT 'pending_response' NOT NULL,
	`response_run_id` text,
	`response_document_json` text,
	`todo_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`batch_id`, `member_id`),
	FOREIGN KEY (`batch_id`) REFERENCES `conversation_input_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `anchored_comments`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_input_batch_members_ordinal_idx` ON `conversation_input_batch_members` (`batch_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `conversation_input_batch_members_state_idx` ON `conversation_input_batch_members` (`batch_id`,`state`,`ordinal`);--> statement-breakpoint
CREATE INDEX `conversation_input_batch_members_question_idx` ON `conversation_input_batch_members` (`source_task_id`,`source_todo_id`,`question_id`,`question_revision`,`state`);--> statement-breakpoint
CREATE TABLE `conversation_input_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text,
	`sequence` integer NOT NULL,
	`client_message_id` text NOT NULL,
	`comments_revision` integer NOT NULL,
	`actor` text NOT NULL,
	`run_id` text,
	`message_id` text,
	`input_id` text,
	`member_count` integer NOT NULL,
	`body_document_json` text,
	`body_state` text DEFAULT 'pending_response' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`closed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `collaboration_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`input_id`) REFERENCES `conversation_body_inputs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_input_batches_nonce_idx` ON `conversation_input_batches` (`session_id`,`client_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_input_batches_task_sequence_idx` ON `conversation_input_batches` (`task_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `conversation_input_batches_task_state_sequence_idx` ON `conversation_input_batches` (`task_id`,`state`,`sequence`);--> statement-breakpoint
CREATE INDEX `conversation_input_batches_run_idx` ON `conversation_input_batches` (`run_id`);--> statement-breakpoint
CREATE TABLE `conversation_rebuild_source_refs` (
	`operation_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`batch_id` text,
	`documents_json` text NOT NULL,
	PRIMARY KEY(`operation_id`, `source_message_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `native_rebuild_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `conversation_input_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversation_run_source_refs` (
	`run_id` text NOT NULL,
	`source_message_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`batch_id` text,
	`documents_json` text NOT NULL,
	PRIMARY KEY(`run_id`, `source_message_id`),
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_message_id`) REFERENCES `conversation_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`batch_id`) REFERENCES `conversation_input_batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_run_source_refs_batch_idx` ON `conversation_run_source_refs` (`run_id`,`batch_id`);--> statement-breakpoint
ALTER TABLE `anchored_comments` ADD `draft_revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `anchored_comments` ADD `answer_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `anchored_comments_unsent_answer_unique` ON `anchored_comments` (`session_id`,`answer_key`) WHERE "anchored_comments"."sent_with_message_id" IS NULL AND "anchored_comments"."pending_receipt_id" IS NULL AND "anchored_comments"."answer_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `collaboration_tasks` ADD `ledger_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collaboration_tasks` ADD `input_sequence` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `collaboration_tasks` ADD `processed_watermark` integer DEFAULT 0 NOT NULL;