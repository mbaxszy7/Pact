-- Clean up groups left empty by the old sidebar removal behavior.
CREATE TEMP TABLE pact_legacy_sidebar_empty_groups AS
SELECT g.id, g.project_id
FROM session_groups AS g
WHERE EXISTS (
  SELECT 1 FROM session_group_members AS m
  JOIN sessions AS s ON s.id = m.session_id
  WHERE m.group_id = g.id AND m.project_id = g.project_id AND s.sidebar_hidden = 1
)
AND NOT EXISTS (
  SELECT 1 FROM session_group_members AS m
  JOIN sessions AS s ON s.id = m.session_id
  WHERE m.group_id = g.id AND m.project_id = g.project_id
    AND s.archived_at IS NULL AND s.status <> 'archived' AND s.sidebar_hidden = 0
);
--> statement-breakpoint
DELETE FROM session_groups WHERE id IN (SELECT id FROM pact_legacy_sidebar_empty_groups);
--> statement-breakpoint
UPDATE session_groups SET position = -1 - position
WHERE project_id IN (SELECT project_id FROM pact_legacy_sidebar_empty_groups);
--> statement-breakpoint
WITH ranked AS MATERIALIZED (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY position DESC) - 1 AS next_position
  FROM session_groups
  WHERE project_id IN (SELECT project_id FROM pact_legacy_sidebar_empty_groups)
)
UPDATE session_groups SET position = ranked.next_position
FROM ranked WHERE session_groups.id = ranked.id;
--> statement-breakpoint
UPDATE projects SET session_group_revision = session_group_revision + 1
WHERE id IN (SELECT project_id FROM pact_legacy_sidebar_empty_groups);
--> statement-breakpoint
UPDATE session_catalog_revisions SET revision = revision + 1
WHERE id = 1 AND EXISTS (SELECT 1 FROM pact_legacy_sidebar_empty_groups);
--> statement-breakpoint
DROP TABLE pact_legacy_sidebar_empty_groups;
