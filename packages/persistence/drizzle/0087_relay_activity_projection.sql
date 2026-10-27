CREATE TABLE `scheduling_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`evaluation_id` text,
	`fault_id` text,
	`handoff_id` text,
	`reason` text NOT NULL,
	`suggestion_state` text DEFAULT 'none' NOT NULL,
	`action` text,
	`action_result` text,
	`unresolved` integer DEFAULT true NOT NULL,
	`activity_at` text NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `scheduling_evaluations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fault_id`) REFERENCES `scheduling_recovery_faults`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`handoff_id`) REFERENCES `scheduling_handoffs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scheduling_activity_created` ON `scheduling_activity` (`activity_at`,`id`);--> statement-breakpoint
CREATE INDEX `scheduling_activity_unresolved` ON `scheduling_activity` (`unresolved`,`activity_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_activity_evaluation` ON `scheduling_activity` (`evaluation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `scheduling_activity_fault` ON `scheduling_activity` (`fault_id`);--> statement-breakpoint
CREATE INDEX `scheduling_activity_handoff` ON `scheduling_activity` (`handoff_id`);--> statement-breakpoint
DROP INDEX `scheduling_recovery_faults_session`;--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_session` ON `scheduling_recovery_faults` (`session_id`,`active`,`utility_epoch`,`configuration_generation`,`agent_id`,`fault_kind`);--> statement-breakpoint
CREATE INDEX `relay_decisions_handoff_created` ON `relay_decisions` (`handoff_id`,`created_at`,`id`);
--> statement-breakpoint
WITH ranked AS (
 SELECT e.id AS evaluation_id,e.session_id,e.handoff_id,e.called,e.selected_candidate_id,e.active,e.created_at,h.slot,h.action,h.run_id,f.id AS fault_id,
 ROW_NUMBER() OVER(PARTITION BY coalesce(f.id,e.id) ORDER BY e.called DESC,e.created_at DESC,e.id DESC) AS ordinal
 FROM scheduling_evaluations e JOIN scheduling_handoffs h ON h.id=e.handoff_id
 LEFT JOIN scheduling_recovery_faults f ON f.fault_kind=substr(h.fault_subject_id,1,instr(h.fault_subject_id,':')-1) AND f.fault_id=substr(h.fault_subject_id,instr(h.fault_subject_id,':')+1)
), facts AS (
 SELECT x.*,r.id AS target_run_id,r.dispatch_phase,r.native_effects_state,r.native_outcome,
 (SELECT CASE WHEN length(m.content)>0 THEN 1 ELSE EXISTS(
   SELECT 1 FROM workflow_turns w JOIN conversation_body_inputs b ON b.id=w.plan_body_id
   WHERE w.run_id=r.id AND w.plan_native_id IS NOT NULL AND r.dispatch_phase='ended'
     AND r.native_outcome='completed' AND b.sealed=1 AND b.chars>0
 ) END FROM conversation_messages m WHERE m.run_id=r.id AND m.role='assistant' AND m.is_visible=1 AND m.state='complete' LIMIT 1)=1 AS response_ready
 FROM ranked x LEFT JOIN agent_runs r ON r.id=x.run_id WHERE x.ordinal=1
)
INSERT INTO scheduling_activity(id,session_id,evaluation_id,fault_id,handoff_id,reason,suggestion_state,action,action_result,unresolved,activity_at)
SELECT coalesce(x.fault_id,x.evaluation_id),x.session_id,x.evaluation_id,x.fault_id,x.handoff_id,
 CASE x.slot WHEN 'workflow_next' THEN 'workflow' WHEN 'input_dispatch' THEN 'input' WHEN 'native_check' THEN 'native_check' WHEN 'queue_check' THEN 'queue_check' WHEN 'rebuild_check' THEN 'rebuild_check' ELSE 'confirmed_resend' END,
 CASE WHEN x.called=1 AND x.selected_candidate_id IS NOT NULL THEN 'suggested' ELSE 'none' END,x.action,
 CASE WHEN x.target_run_id IS NULL THEN NULL
   WHEN x.dispatch_phase='ended' AND x.native_effects_state='settled' AND x.native_outcome='completed' AND x.response_ready THEN 'completed'
   WHEN x.dispatch_phase='ended' AND x.native_effects_state='settled' AND x.native_outcome IN ('failed','interrupted') THEN 'failed'
   WHEN x.dispatch_phase='ended' THEN 'unconfirmed'
   WHEN x.dispatch_phase IN ('accepted','possibly_sent') THEN 'dispatched' ELSE 'reserved' END,
 CASE WHEN x.active=1 OR EXISTS(SELECT 1 FROM relay_decisions d WHERE d.handoff_id=x.handoff_id AND d.active=1)
   OR (x.target_run_id IS NOT NULL AND NOT(coalesce(x.dispatch_phase='ended' AND x.native_effects_state='settled' AND
     (x.native_outcome IN ('failed','interrupted') OR (x.native_outcome='completed' AND x.response_ready)),0)))
   THEN 1 ELSE 0 END,x.created_at
FROM facts x;
--> statement-breakpoint
INSERT INTO scheduling_activity(id,session_id,fault_id,reason,suggestion_state,action,action_result,unresolved,activity_at)
SELECT f.id,f.session_id,f.id,CASE WHEN f.latest_action='resend' THEN 'confirmed_resend' WHEN f.fault_kind='queue' THEN 'queue_check' WHEN f.fault_kind='rebuild' THEN 'rebuild_check' ELSE 'native_check' END,'none',CASE WHEN f.latest_action='resend' THEN 'confirmed_resend' ELSE 'native_check' END,
 CASE f.result WHEN 'possibly_sent' THEN 'unconfirmed' WHEN 'reserved' THEN 'reserved' ELSE f.result END,
 CASE WHEN f.physical_unconfirmed=1 OR NOT(coalesce(r.dispatch_phase='ended' AND r.native_effects_state='settled' AND
   (r.native_outcome IN ('failed','interrupted') OR (r.native_outcome='completed' AND
     (SELECT CASE WHEN length(m.content)>0 THEN 1 ELSE EXISTS(
       SELECT 1 FROM workflow_turns w JOIN conversation_body_inputs b ON b.id=w.plan_body_id
       WHERE w.run_id=r.id AND w.plan_native_id IS NOT NULL AND r.dispatch_phase='ended'
         AND r.native_outcome='completed' AND b.sealed=1 AND b.chars>0
     ) END FROM conversation_messages m WHERE m.run_id=r.id AND m.role='assistant' AND m.is_visible=1 AND m.state='complete' LIMIT 1)=1)),0)) THEN 1 ELSE 0 END,f.activity_at
FROM scheduling_recovery_faults f JOIN agent_runs r ON r.id=f.run_id
WHERE EXISTS(SELECT 1 FROM scheduling_recovery_attempts a WHERE a.fault_id=f.id)
ON CONFLICT(id) DO UPDATE SET reason=excluded.reason,action=excluded.action,action_result=excluded.action_result,unresolved=excluded.unresolved,activity_at=max(scheduling_activity.activity_at,excluded.activity_at);

--> statement-breakpoint
CREATE INDEX `scheduling_recovery_faults_run` ON `scheduling_recovery_faults` (`run_id`,`id`);
