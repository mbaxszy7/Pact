DROP INDEX IF EXISTS `conversation_messages_visible_reply_unique`;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `route_kind` text;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `route_agents_json` text;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `source_message_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_visible_reply_unique` ON `conversation_messages` (`reply_to_message_id`,`agent_id`) WHERE "conversation_messages"."role" = 'assistant' AND "conversation_messages"."is_visible" = 1 AND "conversation_messages"."reply_to_message_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_target_agent_id` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_kind` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_reason` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_state` text;--> statement-breakpoint
ALTER TABLE `agent_runs` ADD `peer_proposal_accepted_message_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_runs_peer_proposal_unique` ON `agent_runs` (`peer_proposal_id`) WHERE "agent_runs"."peer_proposal_id" IS NOT NULL;
