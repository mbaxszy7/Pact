CREATE TABLE `default_session_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`primary_agent_id` text NOT NULL,
	`claude_model` text,
	`claude_effort` text,
	`codex_model` text,
	`codex_effort` text,
	`max_discussion_rounds` integer NOT NULL,
	`running_message_policy` text NOT NULL,
	`max_review_cycles` integer NOT NULL,
	`max_repair_attempts` integer NOT NULL,
	`updated_at` text NOT NULL
);
