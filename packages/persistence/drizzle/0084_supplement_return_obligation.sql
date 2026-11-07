ALTER TABLE `collaboration_action_receipts` ADD `review_state` text;--> statement-breakpoint
ALTER TABLE `collaboration_action_receipts` ADD `review_run_id` text REFERENCES agent_runs(id);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_pending_review` ON `collaboration_action_receipts` (`task_id`,`id`) WHERE "collaboration_action_receipts"."review_state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `collaboration_action_receipts_review_run` ON `collaboration_action_receipts` (`review_run_id`);--> statement-breakpoint
CREATE INDEX `collaboration_action_receipts_unsettled` ON `collaboration_action_receipts` (`id`) WHERE "collaboration_action_receipts"."bound_run_id" IS NOT NULL AND "collaboration_action_receipts"."state" IN ('bound', 'unknown');--> statement-breakpoint
-- Preserve every admitted extra as an obligation. The repository reconciles only exact
-- receipt/budget/native/source facts; an unbound grant or unbudgeted Plan fallback is excluded.
UPDATE `collaboration_action_receipts`
SET `review_state` = 'pending'
WHERE `bound_run_id` IS NOT NULL
  AND `budget_reservation_id` IS NOT NULL
  AND `action` IN ('supplement_plan', 'supplement_code_response');
