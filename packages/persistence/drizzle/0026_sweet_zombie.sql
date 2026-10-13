ALTER TABLE `native_agent_contexts` ADD `permission_requests_json` text;--> statement-breakpoint
CREATE INDEX `native_contexts_pending_permission_idx` ON `native_agent_contexts` (`session_id`,`agent_id`) WHERE "native_agent_contexts"."permission_requests_json" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_file_changes` ADD `native_evidence_json` text;