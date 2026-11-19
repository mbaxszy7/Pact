ALTER TABLE `default_session_settings` ADD `secondary_agent_id` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `default_session_settings` ADD `agy_model` text;--> statement-breakpoint
ALTER TABLE `default_session_settings` ADD `agy_effort` text;--> statement-breakpoint
ALTER TABLE `default_session_settings` ADD `agy_speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
UPDATE `default_session_settings`
SET `secondary_agent_id` = CASE WHEN `primary_agent_id` = 'claude' THEN 'codex' ELSE 'claude' END,
    `agy_speed` = 'native';--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `secondary_agent_id` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `agy_model` text;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `agy_effort` text;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `agy_speed` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_settings_revisions` ADD `agy_permission_mode` text DEFAULT 'native' NOT NULL;--> statement-breakpoint
UPDATE `session_settings_revisions`
SET `secondary_agent_id` = CASE WHEN `primary_agent_id` = 'claude' THEN 'codex' ELSE 'claude' END,
    `agy_speed` = 'native',
    `agy_permission_mode` = 'native';--> statement-breakpoint
CREATE TRIGGER `default_session_settings_pair_insert_check` BEFORE INSERT ON `default_session_settings` FOR EACH ROW
WHEN NEW.`primary_agent_id` = NEW.`secondary_agent_id`
  OR NEW.`primary_agent_id` NOT IN ('claude', 'codex', 'agy')
  OR NEW.`secondary_agent_id` NOT IN ('claude', 'codex', 'agy')
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: default_session_settings_distinct_pair');
END;--> statement-breakpoint
CREATE TRIGGER `default_session_settings_pair_update_check` BEFORE UPDATE ON `default_session_settings` FOR EACH ROW
WHEN NEW.`primary_agent_id` = NEW.`secondary_agent_id`
  OR NEW.`primary_agent_id` NOT IN ('claude', 'codex', 'agy')
  OR NEW.`secondary_agent_id` NOT IN ('claude', 'codex', 'agy')
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: default_session_settings_distinct_pair');
END;--> statement-breakpoint
CREATE TRIGGER `session_settings_revisions_pair_insert_check` BEFORE INSERT ON `session_settings_revisions` FOR EACH ROW
WHEN NEW.`primary_agent_id` = NEW.`secondary_agent_id`
  OR NEW.`primary_agent_id` NOT IN ('claude', 'codex', 'agy')
  OR NEW.`secondary_agent_id` NOT IN ('claude', 'codex', 'agy')
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: session_settings_revisions_distinct_pair');
END;--> statement-breakpoint
CREATE TRIGGER `session_settings_revisions_pair_update_check` BEFORE UPDATE ON `session_settings_revisions` FOR EACH ROW
WHEN NEW.`primary_agent_id` = NEW.`secondary_agent_id`
  OR NEW.`primary_agent_id` NOT IN ('claude', 'codex', 'agy')
  OR NEW.`secondary_agent_id` NOT IN ('claude', 'codex', 'agy')
BEGIN
  SELECT RAISE(ABORT, 'CHECK constraint failed: session_settings_revisions_distinct_pair');
END;