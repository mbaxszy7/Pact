-- Before Native settings was supported, legacy Claude Runs stored the shared
-- 'native' default but actually executed with manual approvals. Preserve that
-- historical meaning before new Claude Runs can explicitly choose Native.
UPDATE `agent_runs` SET `permission_mode` = 'ask'
WHERE `agent_id` = 'claude' AND `permission_mode` = 'native';
