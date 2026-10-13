CREATE TABLE `native_fork_candidate_receipts` (
	`operation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`native_session_id` text NOT NULL,
	`witness_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`operation_id`, `agent_id`, `native_session_id`),
	FOREIGN KEY (`operation_id`) REFERENCES `session_fork_operations`(`id`) ON UPDATE no action ON DELETE restrict
);
