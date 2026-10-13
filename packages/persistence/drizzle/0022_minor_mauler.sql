ALTER TABLE `native_agent_contexts` ADD `recovery_failure_kind` text;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `recovery_failure_message` text;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `rebuild_message_count` integer;--> statement-breakpoint
ALTER TABLE `native_agent_contexts` ADD `rebuilt_through_sequence` integer;