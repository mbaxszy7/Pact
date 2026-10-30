import { z } from 'zod'

export const LOG_RECORD_BYTES = 4096
export const LOG_PRODUCER_ITEMS = 64
export const LOG_WORKER_ITEMS = 128
export const LOG_FILE_BYTES = 5 * 1024 * 1024
export const LOG_FILE_SLOTS = 10
export const LOG_DIRECTORY_BYTES = 50 * 1024 * 1024
export const LOG_METADATA_BYTES = 16 * 1024
export const LOG_SLOT_BYTES = Math.floor(
  (LOG_DIRECTORY_BYTES - LOG_METADATA_BYTES) / LOG_FILE_SLOTS,
)
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const LOG_DEBUG_MS = 30 * 60 * 1000
export const LOG_CLOSE_MS = 2000
export const LOG_IO_MS = 5000
export const LOG_RETRY_MS = 30_000
export const LOG_MAINTENANCE_MS = 60_000

export const diagnosticRequestTypeSchema = z.enum([
  'updates.get.request',
  'updates.check.request',
  'updates.preferences.request',
  'updates.notice.request',
  'native-presence.read.request',
  'native-attention.read.request',
  'native-session.resolve.request',
  'native-session.opened.request',
  'native-jump-list.suppression.request',
  'native-quit.prepare.request',
  'native-quit.cancel.request',
  'collaboration.action.request',
  'relay.decision.answer.request',
  'relay.decision.receipt.request',
  'session.fork.request',
  'conversation.interests.request',
  'runtime.shutdown.request',
  'runtime.health.request',
  'comment-draft.save.request',
  'comment-draft.remove.request',
  'comment-source.resolve.request',
  'appearance.get.request',
  'appearance.update.request',
  'appearance.reset.request',
  'runtime-preparation.get.request',
  'runtime-preparation.path.update.request',
  'default-session-settings.get.request',
  'scheduling.settings.get.request',
  'scheduling.state.get.request',
  'scheduling.state.refresh.request',
  'scheduling.settings.save.request',
  'scheduling.models.refresh.request',
  'scheduling.activity.read.request',
  'default-session-settings.save.request',
  'project-catalog.get.request',
  'project-context.read.request',
  'workspace-archive.prepare.request',
  'workspace-archive.read.request',
  'workspace-archive.cancel.request',
  'project-catalog.add.request',
  'project-catalog.archive.request',
  'project-catalog.restore.request',
  'project-catalog.rename.request',
  'session-catalog.get.request',
  'session-creation.prepare.request',
  'session.create.request',
  'session.rename.request',
  'session.mark-read.request',
  'session.archive.request',
  'session.restore.request',
  'session-settings.get.request',
  'session-settings.save.request',
  'session-permission.save.request',
  'session-speed.save.request',
  'conversation.get.request',
  'skills.read.request',
  'skill-document.read.request',
  'skill-document.cancel.request',
  'skills.cancel.request',
  'conversation.send.request',
  'conversation.prepared-input.continue.request',
  'conversation.queue.steer.request',
  'conversation.queue.return.request',
  'conversation.queue.remove.request',
  'conversation.queue.resume.request',
  'conversation.queue.enabled.request',
  'conversation.input.request',
  'conversation.image.write.request',
  'conversation.image.choose.request',
  'conversation.image.read.request',
  'conversation.input.release-owner.request',
  'peer-proposal.accept.request',
  'peer-proposal.dismiss.request',
  'conversation.retry.request',
  'native-permission.respond.request',
  'native-input.read.request',
  'native-input.respond.request',
  'native-input.opened.request',
  'conversation.stop.request',
  'native-context.rebuild.request',
  'project-file.read.request',
  'workspace-changes.read.request',
  'workspace-changes.file-read.request',
  'workspace-changes.undo.request',
])
export const diagnosticNativeMethodSchema = z.enum([
  'initialize',
  'account/read',
  'config/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/fork',
  'thread/items/list',
  'thread/inject_items',
  'thread/name/set',
  'thread/settings/update',
  'turn/start',
  'turn/interrupt',
  'turn/steer',
  'unrecognized',
])
export const diagnosticFailureSourceSchema = z.enum([
  'native_rpc_rejection',
  'transport_failure',
  'timeout',
  'cancelled',
  'process_exit',
  'classified_error',
])
export type DiagnosticFailureSource = z.infer<typeof diagnosticFailureSourceSchema>

const boundedCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const sourceReadStageSchema = z.enum([
  'entry_owner',
  'request_parse',
  'native_root',
  'native_current',
  'reader_current',
  'original_capture',
  'repository_scope',
  'page_read',
  'navigation',
  'page_validation',
  'cursor',
  'page_budget',
  'unknown',
])
const sourceCheckSchema = z.enum(['passed', 'rejected', 'not_checked'])
export const sourceReadDiagnosticSchema = z.strictObject({
  version: z.literal('source-read-failure-v1'),
  form: z.enum(['nativeRoot', 'sourceReference', 'legacy', 'unknown']),
  source: z.enum([
    'document',
    'batch',
    'root_batch',
    'root_document',
    'inputs',
    'handoff_sources',
    'unknown',
  ]),
  offset: boundedCount.nullable(),
  nativeCallSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  requestSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  entryOwner: sourceCheckSchema,
  rootBinding: sourceCheckSchema,
  currentBeforeRead: sourceCheckSchema,
  readerEntered: z.boolean().nullable(),
  stage: sourceReadStageSchema,
})
export type SourceReadDiagnostic = z.infer<typeof sourceReadDiagnosticSchema>
export type SourceReadStage = z.infer<typeof sourceReadStageSchema>

/** Canonical, domain-separated input for diagnostics only; never grants source authority. */
export function sourceReadCallIdentity(
  threadId: unknown,
  turnId: unknown,
  callId: unknown,
): string | undefined {
  if (
    ![threadId, turnId, callId].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 1024,
    )
  )
    return undefined
  return `pact-source-read-call-v1\0${JSON.stringify([threadId, turnId, callId])}`
}

export const diagnosticEventSchema = z.strictObject({
  inputAdviceResult: z
    .enum([
      'clarify_prepared_input',
      'route_codex',
      'route_claude',
      'no_advice',
      'other_candidate',
      'disabled',
      'busy',
      'duplicate',
      'invalid_input',
      'invalid_output',
      'cancelled',
      'timeout',
      'stale',
      'runtime_unavailable',
    ])
    .optional(),
  informationAdviceRefusal: z
    .enum(['missing_field', 'unavailable_field', 'field_mismatch', 'host_validation'])
    .optional(),
  sourceRead: sourceReadDiagnosticSchema.optional(),
  planStage: z.enum(['capture', 'submission']).optional(),
  planReason: z
    .enum([
      'captured',
      'submitted',
      'retained',
      'hook_prompt_missing',
      'hook_prompt_mismatch',
      'history_binding_missing',
      'history_lookup_failed',
      'plan_capture_failed',
      'submission_hook_unverified',
      'plan_pending',
      'plan_unavailable',
      'plan_missing',
      'retained_basis_mismatch',
    ])
    .optional(),
  planCapture: z
    .strictObject({
      code: z.enum([
        'hook_prompt_missing',
        'hook_prompt_mismatch',
        'history_binding_missing',
        'history_lookup_failed',
        'plan_capture_failed',
      ]),
      tool: z.enum(['Write', 'Edit', 'ExitPlanMode']),
      phase: z.enum(['begin', 'success', 'failure']),
    })
    .optional(),
  settingsCatalogPhase: z
    .enum([
      'admission',
      'readiness',
      'catalogs',
      'claude_close',
      'codex_close',
      'post_catalog',
      'repository_read',
    ])
    .optional(),
  settingsCatalogFailure: z
    .enum([
      'readiness_failed',
      'disposed',
      'catalog_deadline',
      'cancelled',
      'capacity',
      'root_identity',
      'anchor_lost',
      'identity_changed',
      'os_observation',
      'invalid_observation',
      'physical_cleanup_deadline',
      'input_cleanup_deadline',
      'other',
    ])
    .optional(),
  settingsCatalogIdentity: z
    .strictObject({
      reason: z.enum(['missing', 'ppid_mismatch', 'pgid_mismatch', 'ppid_and_pgid_mismatch']),
      initialPresent: z.boolean(),
      refreshed: z.boolean(),
      captureExited: z.boolean(),
      captureClosed: z.boolean(),
      cleanupExited: z.boolean(),
      cleanupClosed: z.boolean(),
      pidZero: z.enum(['success', 'ESRCH', 'EPERM', 'other_error', 'not_observed']),
      groupZero: z.enum(['success', 'ESRCH', 'EPERM', 'other_error', 'not_observed']),
    })
    .optional(),
  scope: z.enum(['request', 'run', 'process']).optional(),
  requestType: diagnosticRequestTypeSchema.optional(),
  nativeMethod: diagnosticNativeMethodSchema.optional(),
  nativeErrorCode: z.number().int().min(-0x80000000).max(0x7fffffff).optional(),
  failureSource: diagnosticFailureSourceSchema.optional(),
  runtimeBoundary: z
    .enum([
      'native_notification',
      'foreground',
      'projection',
      'source_read',
      'archive',
      'workflow_reconcile',
    ])
    .optional(),
  runtimeErrorType: z
    .enum([
      'AgentExecutionError',
      'Error',
      'TypeError',
      'RangeError',
      'SyntaxError',
      'AbortError',
      'other',
    ])
    .optional(),
  nativeWillRetry: z.boolean().optional(),
  executorId: z.uuid().optional(),
  operation: z.enum([
    'app',
    'utility',
    'ipc',
    'readiness',
    'send',
    'stop',
    'native_check',
    'claude_plan',
    'native_rebuild',
    'fork',
    'undo',
    'renderer',
    'debug',
    'queue',
    'shutdown',
    'process',
  ]),
  phase: z.enum([
    'started',
    'ready',
    'dispatched',
    'completed',
    'failed',
    'timeout',
    'closed',
    'interrupted',
    'unknown_delivery',
    'blocked',
    'dropped',
  ]),
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  sessionId: z.uuid().optional(),
  runId: z.uuid().optional(),
  operationId: z.uuid().optional(),
  agentId: z.enum(['claude', 'codex']).optional(),
  cliVersion: z
    .string()
    .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.\d{1,5})?$/u)
    .optional(),
  durationMs: boundedCount.optional(),
  count: boundedCount.optional(),
  pid: z.number().int().positive().max(0x7fffffff).optional(),
  exitCode: z.number().int().min(-0x7fffffff).max(0x7fffffff).optional(),
  code: z
    .enum([
      'VALIDATION',
      'PERMISSION_DENIED',
      'CONFLICT',
      'AGENT_CAPACITY',
      'NATIVE_CONTEXT_RECOVERY_REQUIRED',
      'NATIVE_CONTEXT_CHECK_FAILED',
      'COMMENT_LIMIT',
      'NOT_FOUND',
      'RUNTIME_UNAVAILABLE',
      'TIMEOUT',
      'CONTEXT_TOO_LARGE',
      'CONTEXT_UNAVAILABLE',
      'WORKSPACE_BUSY',
      'WORKSPACE_CONFLICT',
      'WORKSPACE_UNDO_UNAVAILABLE',
      'WORKSPACE_RECOVERY_REQUIRED',
      'UNCERTAIN',
      'INTERNAL',
      'agent_process_crash',
      'native_rpc_rejected',
      'transport_failure',
      'request_cancelled',
      'protocol_error',
      'context_limit',
      'context_resume_failed',
      'user_stopped',
      'authentication_required',
      'quota_or_rate_limit',
      'permission_blocked',
      'transient_transport',
      'runtime_incompatible',
      'response_too_large',
      'native_session_occupied',
      'unknown_delivery',
      'ENOSPC',
      'EACCES',
      'EPERM',
      'EIO',
      'NO_SLOT',
      'INVALID_RECORD',
      'WORKER_EXIT',
      'RENDERER_CRASH',
      'RENDERER_VIEW',
      'UNHANDLED_ERROR',
      'UNHANDLED_REJECTION',
      'DATABASE_IN_USE',
      'DATABASE_INCOMPATIBLE',
      'DATABASE_BACKUP_FAILED',
      'DATABASE_MIGRATION_FAILED',
      'DATABASE_STORAGE_FAILED',
      'STARTUP_FAILURE_DISPLAY_FAILED',
    ])
    .optional(),
})
export type DiagnosticEvent = z.input<typeof diagnosticEventSchema>
export const diagnosticIdentitySchema = z.strictObject({
  launchId: z.uuid(),
  appVersion: z.string().regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}$/u),
  process: z.enum(['main', 'utility', 'renderer']),
  pid: z.number().int().positive().max(0x7fffffff),
})
export type DiagnosticIdentity = z.infer<typeof diagnosticIdentitySchema>
export const diagnosticRecordSchema = diagnosticEventSchema.extend({
  timestamp: z.iso.datetime(),
  identity: diagnosticIdentitySchema,
})
export type DiagnosticRecord = z.infer<typeof diagnosticRecordSchema>
export const diagnosticStatusSchema = z.strictObject({
  state: z.enum(['starting', 'ready', 'unavailable', 'closed']),
  dropped: boundedCount,
  debugUntil: boundedCount,
})
export type DiagnosticStatus = z.infer<typeof diagnosticStatusSchema>
export const rendererFaultSchema = z.enum(['view', 'error', 'rejection'])
export type RendererFault = z.infer<typeof rendererFaultSchema>
export const diagnosticPacketSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('diagnostic.record'),
    id: z.uuid(),
    record: diagnosticRecordSchema,
  }),
  z.strictObject({ type: z.literal('diagnostic.ack'), id: z.uuid(), written: z.boolean() }),
  z.strictObject({ type: z.literal('diagnostic.debug'), until: boundedCount }),
  z.strictObject({ type: z.literal('diagnostic.close') }),
  z.strictObject({ type: z.literal('diagnostic.closed') }),
  z.strictObject({ type: z.literal('diagnostic.busy'), busy: z.boolean() }),
  z.strictObject({ type: z.literal('diagnostic.state'), state: z.enum(['ready', 'unavailable']) }),
])
export type DiagnosticPacket = z.infer<typeof diagnosticPacketSchema>
