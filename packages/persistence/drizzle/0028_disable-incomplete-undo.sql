-- Custom SQL migration file, put your code below! --
-- Older native cards may have advertised patch-only Undo. Preserve every saved
-- version/diff, but do not authorize inverse writes without complete endpoints.
UPDATE workspace_change_sets
SET state = 'mixed',
    undo_unavailable_reason = COALESCE(undo_unavailable_reason,
      'Complete original and final native file versions are unavailable for Undo.'),
    projection_pending = 1
WHERE state = 'ready'
  AND EXISTS (
    SELECT 1 FROM workspace_file_changes AS file
    WHERE file.change_set_id = workspace_change_sets.id
      AND (
        json_extract(file.native_evidence_json, '$.undoStrategy') IN ('patch', 'unavailable')
        OR json_extract(file.native_evidence_json, '$.beforeAvailable') = 0
        OR json_extract(file.native_evidence_json, '$.afterAvailable') = 0
      )
  );
