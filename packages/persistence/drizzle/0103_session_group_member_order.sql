DROP INDEX `session_group_members_group_idx`;--> statement-breakpoint
ALTER TABLE `session_group_members` ADD `position` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked AS (
  SELECT member.session_id,
         row_number() OVER (
           PARTITION BY member.group_id, member.project_id
           ORDER BY session.created_at DESC, session.id DESC
         ) - 1 AS position
  FROM session_group_members AS member
  JOIN sessions AS session
    ON session.id = member.session_id AND session.project_id = member.project_id
)
UPDATE session_group_members
SET position = ranked.position
FROM ranked
WHERE session_group_members.session_id = ranked.session_id;--> statement-breakpoint
CREATE UNIQUE INDEX `session_group_members_position_unique` ON `session_group_members` (`group_id`,`project_id`,`position`);
