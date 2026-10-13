-- Detailed native commands, permission profiles and rule templates are transient.
-- Preserve the durable request/action identities, not unaccepted display snapshots.
UPDATE `agent_event_journal`
SET `payload` = json_set(`payload`, '$.requests', json((
  SELECT json_group_array(json(json_patch(
    json_object(
      'id', json_extract(request.value, '$.id'),
      'kind', coalesce(json_extract(request.value, '$.kind'), 'approval'),
      'title', 'Native interaction',
      'detail', '',
      'createdAt', json_extract(request.value, '$.createdAt')
    ),
    CASE WHEN json_type(request.value, '$.operationId') = 'text'
      THEN json_object('operationId', json_extract(request.value, '$.operationId'))
      ELSE '{}' END
  )))
  FROM json_each(`agent_event_journal`.`payload`, '$.requests') AS request
)))
WHERE `event_type` IN ('native.permission_requested', 'native.permission_decided')
  AND json_valid(`payload`) AND json_type(`payload`, '$.requests') = 'array';
--> statement-breakpoint
-- Pending interactions cannot survive a process restart. Their live templates
-- remain invalid even if the original native work continues outside Pact.
UPDATE `native_agent_contexts` SET `permission_requests_json` = NULL
WHERE `permission_requests_json` IS NOT NULL;
