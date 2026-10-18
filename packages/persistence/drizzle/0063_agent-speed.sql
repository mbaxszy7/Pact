ALTER TABLE `agent_runs` ADD `speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `observed_speed` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `speed_detail` text;--> statement-breakpoint
ALTER TABLE `default_session_settings` ADD `claude_speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `default_session_settings` ADD `codex_speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `claude_speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `codex_speed` text DEFAULT 'native' NOT NULL;