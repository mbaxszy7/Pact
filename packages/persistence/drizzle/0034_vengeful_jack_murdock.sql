ALTER TABLE `agent_runs` ADD `permission_mode` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `claude_permission_mode` text DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `codex_permission_mode` text DEFAULT 'native' NOT NULL;