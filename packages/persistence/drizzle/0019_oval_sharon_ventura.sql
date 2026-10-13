ALTER TABLE `conversation_messages` ADD `reply_to_message_id` text;--> statement-breakpoint
ALTER TABLE `conversation_messages` ADD `is_visible` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `conversation_messages_session_visible_sequence_idx` ON `conversation_messages` (`session_id`,`is_visible`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_messages_visible_reply_unique` ON `conversation_messages` (`reply_to_message_id`) WHERE "conversation_messages"."role" = 'assistant' AND "conversation_messages"."is_visible" = 1 AND "conversation_messages"."reply_to_message_id" IS NOT NULL;
--> statement-breakpoint
UPDATE conversation_messages SET is_visible = 0 WHERE role = 'assistant';
--> statement-breakpoint
UPDATE conversation_messages SET reply_to_message_id = (
  SELECT user_message_id FROM agent_runs WHERE agent_runs.id = conversation_messages.run_id
) WHERE role = 'assistant';
--> statement-breakpoint
UPDATE conversation_messages SET state = 'incomplete'
WHERE role = 'assistant' AND state = 'complete' AND EXISTS (
  SELECT 1 FROM agent_runs WHERE agent_runs.id = conversation_messages.run_id AND agent_runs.status <> 'completed'
);
--> statement-breakpoint
UPDATE conversation_messages SET state = 'complete'
WHERE role = 'assistant' AND EXISTS (
  SELECT 1 FROM agent_runs WHERE agent_runs.id = conversation_messages.run_id AND agent_runs.status = 'completed'
);
--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY coalesce(reply_to_message_id, id)
    ORDER BY CASE WHEN state = 'complete' THEN 0 WHEN length(content) > 0 THEN 1 ELSE 2 END,
      CASE WHEN state = 'complete' THEN -sequence ELSE sequence END
  ) AS position FROM conversation_messages WHERE role = 'assistant'
)
UPDATE conversation_messages SET is_visible = 1 WHERE id IN (SELECT id FROM ranked WHERE position = 1);
