ALTER TABLE `native_rebuild_operations` ADD `old_run_id` text REFERENCES agent_runs(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE native_rebuild_operations SET old_run_id = (
  SELECT id FROM agent_runs r
  WHERE r.session_id = native_rebuild_operations.session_id
    AND r.agent_id = native_rebuild_operations.agent_id
    AND r.binding_generation = native_rebuild_operations.old_generation
    AND r.created_at <= native_rebuild_operations.created_at
  ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1
) WHERE old_run_id IS NULL;
