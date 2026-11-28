ALTER TABLE `scheduling_activity` ADD `decision_id` text REFERENCES relay_decisions(id);--> statement-breakpoint
ALTER TABLE `scheduling_activity` ADD `rebuild_id` text REFERENCES native_rebuild_operations(id);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_activity_decision` ON `scheduling_activity` (`decision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_activity_rebuild` ON `scheduling_activity` (`rebuild_id`);