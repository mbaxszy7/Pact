import {
  updateStoredStateSchema,
  updatePreferencesInputSchema,
  updateNoticeInputSchema,
  updateNoticeResultSchema,
  type UpdateState,
  type UpdatePreferencesInput,
} from './app-updates.js'
export * from './app-updates.js'
import {
  collaborationViewSchema,
  collaborationDocumentSchema,
  collaborationMarkdownNodeSchema,
  collaborationMarkdownTreeWithinBudget,
  collaborationActionInputSchema,
  collaborationResultSchema,
} from './collaboration.js'
export * from './collaboration.js'
export * from './collaboration-todos.js'
export * from './workspace-archive.js'
export * from './native-presence.js'
import {
  conversationImageSchema,
  conversationImagesSchema,
  imageWriteInputSchema,
  imageWriteStateSchema,
  imageReadInputSchema,
  imageReadPartSchema,
} from './images.js'
import {
  nativePresenceSnapshotSchema,
  nativePresenceVersionSchema,
  nativeSessionRowSchema,
  NATIVE_MENU_ITEMS,
  nativeAttentionReadInputSchema,
  nativeAttentionPageSchema,
  nativeSessionResolveInputSchema,
  nativeSessionOpenInputSchema,
  nativeJumpListSuppressionInputSchema,
  nativeSessionOpenedResultSchema,
  nativeJumpListSuppressionResultSchema,
  nativeQuitOperationInputSchema,
  nativeQuitPreparationSchema,
  nativeQuitCancelledResultSchema,
  type NativePresenceVersion,
  type NativeAttentionReadInput,
  type NativeAttentionPage,
  type NativeSessionResolveInput,
  type NativeSessionOpenInput,
  type NativeQuitState,
  type NativeQuitDecisionInput,
  type NativeNavigationIntent,
  type NativeNavigationAckInput,
} from './native-presence.js'
import {
  workspaceArchivePrepareInputSchema,
  workspaceArchiveOperationInputSchema,
  workspaceArchivePreviewSchema,
  workspaceArchiveReceiptSchema,
  type WorkspaceArchivePrepareInput,
  type WorkspaceArchiveOperationInput,
  type WorkspaceArchivePreview,
  type WorkspaceArchiveReceipt,
} from './workspace-archive.js'
export * from './images.js'
import {
  skillCatalogReadSchema,
  skillCatalogPageSchema,
  skillSelectionsSchema,
  skillDocumentReadSchema,
  skillDocumentSchema,
} from './skills.js'
export * from './skills.js'
import { z } from 'zod'

export * from './native-permissions.js'
export * from './native-user-input.js'
export * from './native-fork.js'
export * from './diagnostics.js'
import type { DiagnosticStatus, RendererFault } from './diagnostics.js'

import {
  nativePermissionRequestSchema,
  nativePermissionRespondInputSchema,
  NATIVE_PERMISSION_REQUESTS,
  type NativePermissionRespondInput,
} from './native-permissions.js'
import {
  nativeInputReadSchema,
  nativeInputRespondSchema,
  nativeInteractionDetailsSchema,
  type NativeInputRead,
  type NativeInputRespond,
  type NativeInteractionDetails,
} from './native-user-input.js'

export * from './workspace-changes.js'
export * from './directory-file-operations.js'
import {
  workspaceChangeSetSchema,
  workspaceChangeFileReadInputSchema,
  workspaceChangesReadInputSchema,
  workspaceChangesPageSchema,
  workspaceChangesUndoInputSchema,
  WORKSPACE_PREVIEW_BYTES,
  type WorkspaceChangeFileReadInput,
  type WorkspaceChangesReadInput,
  type WorkspaceChangesPage,
  type WorkspaceChangesUndoInput,
} from './workspace-changes.js'

export {
  anchoredCommentSchema,
  commentAnchorSchema,
  commentDraftRemoveInputSchema,
  commentDraftSaveInputSchema,
  commentSourceResolutionSchema,
  fileCommentAnchorSchema,
  MAX_COMMENTS_PER_MESSAGE,
  MAX_COMMENT_QUOTE_LENGTH,
  MESSAGE_ANCHOR_TEXT_BASIS,
  messageCommentAnchorSchema,
  todoCommentAnchorSchema,
  type TodoCommentAnchor,
  type AnchoredComment,
  type CommentAnchor,
  type CommentDraftRemoveInput,
  type CommentDraftSaveInput,
  type CommentSourceResolution,
  type FileCommentAnchor,
  type MessageCommentAnchor,
} from './anchored-comments.js'
import type {
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  CommentSourceResolution,
} from './anchored-comments.js'

import {
  anchoredCommentSchema,
  commentDraftRemoveInputSchema,
  commentDraftSaveInputSchema,
  commentSourceResolutionSchema,
  MAX_COMMENTS_PER_MESSAGE,
} from './anchored-comments.js'

export {
  normalizedAgentEventSchema,
  sessionTitleInputSchema,
  sessionTitleInputShape,
  conversationStreamDeltaKey,
  type NormalizedAgentEvent,
} from './agent-events.js'

export const CONVERSATION_INTEREST_ITEMS = 8
export const IPC_CHANNELS = {
  nativeSessionResolve: 'pact:native-session:resolve',
  nativeSessionOpened: 'pact:native-session:opened',
  nativeAttentionRead: 'pact:native-attention:read',
  nativePresenceChanged: 'pact:native-presence:changed',
  nativeNavigationGet: 'pact:native-navigation:get',
  nativeNavigationAck: 'pact:native-navigation:ack',
  nativeNavigationChanged: 'pact:native-navigation:changed',
  nativeQuitGet: 'pact:native-quit:get',
  nativeQuitRespond: 'pact:native-quit:respond',
  nativeQuitChanged: 'pact:native-quit:changed',
  workspaceArchivePrepare: 'pact:workspace-archive:prepare',
  workspaceArchiveRead: 'pact:workspace-archive:read',
  workspaceArchiveCancel: 'pact:workspace-archive:cancel',
  diagnosticStatus: 'pact:diagnostics:status',
  diagnosticChanged: 'pact:diagnostics:changed',
  rendererFault: 'pact:diagnostics:renderer-fault',
  updatesGet: 'pact:updates:get',
  updatesCheck: 'pact:updates:check',
  updatesPreferences: 'pact:updates:preferences',
  updatesClaimNotice: 'pact:updates:claim-notice',
  updatesChanged: 'pact:updates:changed',
  appInfo: 'pact:app:info',
  runtimeHealth: 'pact:runtime:health',
  appearanceGet: 'pact:appearance:get',
  appearanceUpdate: 'pact:appearance:update',
  appearanceReset: 'pact:appearance:reset',
  appearanceChanged: 'pact:appearance:changed',
  runtimePreparationGet: 'pact:runtime-preparation:get',
  runtimeExecutableChoose: 'pact:runtime-preparation:choose-executable',
  defaultSessionSettingsGet: 'pact:default-session-settings:get',
  defaultSessionSettingsSave: 'pact:default-session-settings:save',
  projectCatalogGet: 'pact:project-catalog:get',
  projectCatalogChooseAndAdd: 'pact:project-catalog:choose-and-add',
  projectCatalogArchive: 'pact:project-catalog:archive',
  projectCatalogRestore: 'pact:project-catalog:restore',
  projectCatalogRename: 'pact:project-catalog:rename',
  projectContextRead: 'pact:project-context:read',
  projectDirectoryOpen: 'pact:project-directory:open',
  sessionCatalogGet: 'pact:session-catalog:get',
  sessionCreationPrepare: 'pact:session-creation:prepare',
  sessionCreate: 'pact:session:create',
  sessionRename: 'pact:session:rename',
  sessionMarkRead: 'pact:session:mark-read',
  sessionArchive: 'pact:session:archive',
  sessionRestore: 'pact:session:restore',
  sessionSettingsGet: 'pact:session-settings:get',
  sessionSettingsSave: 'pact:session-settings:save',
  sessionPermissionSave: 'pact:session-permission:save',
  sessionSpeedSave: 'pact:session-speed:save',
  collaborationAction: 'pact:collaboration:action',
  conversationGet: 'pact:conversation:get',
  skillCatalogRead: 'pact:skills:read',
  skillCatalogCancel: 'pact:skills:cancel',
  skillDocumentRead: 'pact:skill-document:read',
  skillDocumentCancel: 'pact:skill-document:cancel',
  composerEditingState: 'pact:composer:editing-state',
  composerEditCommand: 'pact:composer:edit-command',
  composerEditReceipt: 'pact:composer:edit-receipt',
  sessionFork: 'pact:session:fork',
  conversationInterest: 'pact:conversation:interest',
  steerQueuedConversationMessage: 'pact:conversation:queue:steer',
  returnQueuedConversationMessage: 'pact:conversation:queue:return',
  removeQueuedConversationMessage: 'pact:conversation:queue:remove',
  resumeConversationQueue: 'pact:conversation:queue:resume',
  setConversationQueueEnabled: 'pact:conversation:queue:enabled',
  conversationSend: 'pact:conversation:send',
  conversationInput: 'pact:conversation:input',
  conversationImageWrite: 'pact:conversation:image-write',
  conversationImageChoose: 'pact:conversation:image-choose',
  conversationImageRead: 'pact:conversation:image-read',
  conversationStop: 'pact:conversation:stop',
  peerProposalAccept: 'pact:peer-proposal:accept',
  peerProposalDismiss: 'pact:peer-proposal:dismiss',
  conversationRetry: 'pact:conversation:retry',
  nativePermissionRespond: 'pact:native-permission:respond',
  nativeInputRead: 'pact:native-input:read',
  nativeInputRespond: 'pact:native-input:respond',
  nativeInputOpen: 'pact:native-input:open',
  nativeContextRebuild: 'pact:native-context:rebuild',
  conversationChanged: 'pact:conversation:changed',
  commentDraftSave: 'pact:comment-draft:save',
  commentDraftRemove: 'pact:comment-draft:remove',
  commentSourceResolve: 'pact:comment-source:resolve',
  projectFileRead: 'pact:project-file:read',
  workspaceChangesRead: 'pact:workspace-changes:read',
  workspaceChangeFileRead: 'pact:workspace-changes:file-read',
  workspaceChangesUndo: 'pact:workspace-changes:undo',
} as const

export const appErrorSchema = z.object({
  code: z.enum([
    'VALIDATION',
    'PERMISSION_DENIED',
    'RUNTIME_UNAVAILABLE',
    'DATABASE_IN_USE',
    'DATABASE_INCOMPATIBLE',
    'DATABASE_BACKUP_FAILED',
    'DATABASE_MIGRATION_FAILED',
    'DATABASE_STORAGE_FAILED',
    'TIMEOUT',
    'CONFLICT',
    'AGENT_CAPACITY',
    'CONTEXT_TOO_LARGE',
    'CONTEXT_UNAVAILABLE',
    'NATIVE_CONTEXT_RECOVERY_REQUIRED',
    'NATIVE_CONTEXT_CHECK_FAILED',
    'COMMENT_LIMIT',
    'WORKSPACE_BUSY',
    'WORKSPACE_CONFLICT',
    'WORKSPACE_UNDO_UNAVAILABLE',
    'WORKSPACE_RECOVERY_REQUIRED',
    'UNCERTAIN',
    'INTERNAL',
  ]),
  message: z.string(),
})

export type AppError = z.infer<typeof appErrorSchema>

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: AppError }

export function rpcResultSchema<T extends z.ZodType>(valueSchema: T) {
  return z.union([
    z.object({ ok: z.literal(true), value: valueSchema }),
    z.object({ ok: z.literal(false), error: appErrorSchema }),
  ])
}

export const appInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32']),
  arch: z.string(),
  packaged: z.boolean(),
})

export type AppInfo = z.infer<typeof appInfoSchema>

export const IPC_TRAFFIC_UNIT =
  'json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1' as const
export const IPC_TRAFFIC_OWNER_CATEGORIES = {
  'renderer-bridge': [
    'renderer-main.invoke',
    'main-renderer.reply',
    'renderer-main.send',
    'main-renderer.event',
  ],
  'main-utility': [
    'main-utility.request',
    'utility-main.reply',
    'utility-main.event',
    'main-utility.control',
    'utility-main.control',
  ],
  'main-directory': ['main-directory.request', 'directory-main.reply'],
  'utility-markdown': ['utility-markdown.request', 'markdown-utility.reply'],
  'utility-image': ['utility-image.init', 'image-utility.reply'],
  'utility-native-json': ['utility-native-json.init', 'native-json-utility.reply'],
  'utility-native-fork': [
    'utility-native-fork.init',
    'utility-native-fork.control',
    'native-fork-utility.reply',
  ],
  'main-diagnostic-log': [
    'main-diagnostic-log.init',
    'main-diagnostic-log.request',
    'diagnostic-log-main.reply',
  ],
  'renderer-monaco': ['renderer-monaco.request', 'monaco-renderer.reply'],
} as const
export const ipcTrafficOwnerSchema = z.enum([
  'renderer-bridge',
  'main-utility',
  'main-directory',
  'utility-markdown',
  'utility-image',
  'utility-native-json',
  'utility-native-fork',
  'main-diagnostic-log',
  'renderer-monaco',
])
export const ipcTrafficCategorySchema = z.enum([
  'renderer-main.invoke',
  'main-renderer.reply',
  'renderer-main.send',
  'main-renderer.event',
  'main-utility.request',
  'utility-main.reply',
  'utility-main.event',
  'main-utility.control',
  'utility-main.control',
  'main-directory.request',
  'directory-main.reply',
  'utility-markdown.request',
  'markdown-utility.reply',
  'utility-image.init',
  'image-utility.reply',
  'utility-native-json.init',
  'native-json-utility.reply',
  'utility-native-fork.init',
  'utility-native-fork.control',
  'native-fork-utility.reply',
  'main-diagnostic-log.init',
  'main-diagnostic-log.request',
  'diagnostic-log-main.reply',
  'renderer-monaco.request',
  'monaco-renderer.reply',
])
export type IpcTrafficCategory = z.infer<typeof ipcTrafficCategorySchema>
export const ipcTrafficIssueSchema = z.enum([
  'invalid_limits',
  'byte_limit',
  'node_limit',
  'depth_limit',
  'unsupported_value',
  'unsupported_prototype',
  'unsupported_binary',
  'accessor',
  'to_json',
  'cycle',
  'uninspectable',
  'counter_overflow',
  'epoch_limit',
  'invalid_epoch',
  'unvalidated_message',
  'transport_error',
  'unknown_category',
  'disposed',
  'cleanup_unavailable',
])
export type IpcTrafficIssue = z.infer<typeof ipcTrafficIssueSchema>
export const ipcTrafficMeasurementSchema = z
  .strictObject({
    complete: z.boolean(),
    jsonBytes: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024),
    binaryBytes: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024),
    totalBytes: z
      .number()
      .int()
      .min(0)
      .max(128 * 1024 * 1024),
    reason: ipcTrafficIssueSchema.optional(),
  })
  .refine(
    (value) =>
      value.totalBytes === value.jsonBytes + value.binaryBytes &&
      (value.complete ? value.reason === undefined : value.reason !== undefined),
  )
export type IpcTrafficMeasurement = z.infer<typeof ipcTrafficMeasurementSchema>
export const monacoIpcObservationSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message'),
    unit: z.literal(IPC_TRAFFIC_UNIT),
    category: z.enum(['renderer-monaco.request', 'monaco-renderer.reply']),
    measurement: ipcTrafficMeasurementSchema,
  }),
  z.strictObject({
    type: z.enum(['created', 'termination-requested', 'transport-error']),
    unit: z.literal(IPC_TRAFFIC_UNIT),
  }),
])
export type MonacoIpcObservation = z.infer<typeof monacoIpcObservationSchema>
export const ipcTrafficUncoveredSchema = z.enum([
  'renderer-main-bridge',
  'main-utility-diagnostic-control',
  'main-directory-worker',
  'utility-markdown-worker',
  'utility-image-codec-worker',
  'utility-native-json-worker',
  'utility-native-fork-worker',
  'main-diagnostic-log-worker',
  'renderer-monaco-workers',
])
const ipcTrafficCountsSchema = z
  .strictObject({
    messages: z.number().int().min(0).max(1_000_000),
    incompleteMessages: z.number().int().min(0).max(1_000_000),
    jsonBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    binaryBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    totalBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine(
    (value) =>
      value.totalBytes === value.jsonBytes + value.binaryBytes &&
      value.incompleteMessages <= value.messages,
  )
export const ipcTrafficOwnerSnapshotSchema = z
  .strictObject({
    owner: ipcTrafficOwnerSchema,
    epoch: z.uuid().nullable(),
    transportEpoch: z.number().int().min(1).max(64),
    startedTransports: z.number().int().min(0).max(1_000_000),
    settledTransports: z.number().int().min(0).max(1_000_000),
    activeTransports: z.number().int().min(0).max(64),
    highWaterTransports: z.number().int().min(0).max(64),
    complete: z.boolean(),
    issues: z.array(ipcTrafficIssueSchema).max(19),
    counters: z
      .array(
        z.strictObject({
          category: ipcTrafficCategorySchema,
          business: ipcTrafficCountsSchema,
          control: ipcTrafficCountsSchema,
        }),
      )
      .max(5),
  })
  .refine(
    (value) =>
      new Set(value.counters.map((row) => row.category)).size === value.counters.length &&
      value.counters.length === IPC_TRAFFIC_OWNER_CATEGORIES[value.owner].length &&
      value.counters.every((row) =>
        (IPC_TRAFFIC_OWNER_CATEGORIES[value.owner] as readonly string[]).includes(row.category),
      ) &&
      new Set(value.issues).size === value.issues.length &&
      value.startedTransports - value.settledTransports === value.activeTransports &&
      value.highWaterTransports >= value.activeTransports &&
      Number.isSafeInteger(
        value.counters.reduce(
          (total, row) => total + row.business.totalBytes + row.control.totalBytes,
          0,
        ),
      ) &&
      (!value.complete ||
        (value.epoch !== null &&
          value.issues.length === 0 &&
          value.counters.every(
            (row) => row.business.incompleteMessages === 0 && row.control.incompleteMessages === 0,
          ))),
  )
export type IpcTrafficOwnerSnapshot = z.infer<typeof ipcTrafficOwnerSnapshotSchema>
export const ipcTrafficSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    unit: z.literal(IPC_TRAFFIC_UNIT),
    complete: z.boolean(),
    owners: z.array(ipcTrafficOwnerSnapshotSchema).max(9),
    uncovered: z.array(ipcTrafficUncoveredSchema).max(9),
  })
  .refine(
    (value) =>
      new Set(value.owners.map((owner) => owner.owner)).size === value.owners.length &&
      new Set(value.uncovered).size === value.uncovered.length &&
      Number.isSafeInteger(
        value.owners.reduce(
          (total, owner) =>
            total +
            owner.counters.reduce(
              (bytes, row) => bytes + row.business.totalBytes + row.control.totalBytes,
              0,
            ),
          0,
        ),
      ) &&
      (!value.complete ||
        (value.owners.length === 9 &&
          value.uncovered.length === 0 &&
          value.owners.every((owner) => owner.complete))),
  )
export type IpcTraffic = z.infer<typeof ipcTrafficSchema>

export const nativeMemoryDiagnosticsSchema = z
  .strictObject({
    unit: z.literal('native-working-reservations-v1'),
    observationsComplete: z.boolean(),
    chargedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024)
      .nullable(),
    reservationItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    highWaterBytes: z
      .number()
      .int()
      .nonnegative()
      .max(512 * 1024 * 1024)
      .nullable(),
    highWaterItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    acquiredBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    releasedBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    acquiredItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    releasedItems: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .refine((value) => {
    const complete = Object.values(value).every((count) => count !== null)
    if (value.observationsComplete !== complete) return false
    const {
      acquiredBytes,
      releasedBytes,
      chargedBytes,
      acquiredItems,
      releasedItems,
      reservationItems,
      highWaterBytes,
      highWaterItems,
    } = value
    return (
      (acquiredBytes === null ||
        releasedBytes === null ||
        chargedBytes === null ||
        acquiredBytes - releasedBytes === chargedBytes) &&
      (acquiredItems === null ||
        releasedItems === null ||
        reservationItems === null ||
        acquiredItems - releasedItems === reservationItems) &&
      (highWaterBytes === null || chargedBytes === null || highWaterBytes >= chargedBytes) &&
      (highWaterItems === null ||
        reservationItems === null ||
        highWaterItems >= reservationItems) &&
      (highWaterBytes === null || acquiredBytes === null || highWaterBytes <= acquiredBytes) &&
      (highWaterItems === null || acquiredItems === null || highWaterItems <= acquiredItems)
    )
  })
export type NativeMemoryDiagnostics = z.infer<typeof nativeMemoryDiagnosticsSchema>

export const runtimeHealthSchema = z.object({
  ipcTraffic: ipcTrafficSchema.optional(),
  performance: z
    .strictObject({
      eventLoopLagP95Ms: z.number().finite().nonnegative(),
      eventLoopSamples: z.number().int().nonnegative(),
      databaseBytes: z.number().int().nonnegative().optional(),
      walBytes: z.number().int().nonnegative().optional(),
      activeResources: z.record(z.string().max(64), z.number().int().nonnegative()),
      resourceHighWater: z.number().int().nonnegative(),
      resourceCapacityExceeded: z.boolean(),
      nativeMemory: nativeMemoryDiagnosticsSchema.optional(),
      sqlite: z.strictObject({
        operations: z.number().int().nonnegative(),
        transactions: z.number().int().nonnegative(),
        rowsReturned: z.number().int().nonnegative(),
        totalMs: z.number().finite().nonnegative(),
        maxMs: z.number().finite().nonnegative(),
        planOverflow: z.boolean(),
        unsupportedOperations: z.boolean(),
        firstPlanFailure: z
          .strictObject({
            reason: z.enum([
              'statement-bytes',
              'plan-capacity',
              'plan-rows',
              'plan-detail',
              'plan-bytes',
              'explain-failed',
            ]),
            sqlSha256: z
              .string()
              .regex(/^[a-f\d]{64}$/u)
              .nullable(),
            sourceBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            operationIndex: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
            retainedPlans: z.number().int().nonnegative().max(64),
            retainedPlanBytes: z
              .number()
              .int()
              .nonnegative()
              .max(16 * 1024),
            planRows: z.number().int().nonnegative().max(0xffffffff).nullable(),
          })
          .refine((failure) =>
            failure.sourceBytes > 8192
              ? failure.reason === 'statement-bytes' && failure.sqlSha256 === null
              : failure.reason !== 'statement-bytes' && failure.sqlSha256 !== null,
          )
          .optional(),
        queryPlans: z
          .array(
            z.strictObject({
              sqlSha256: z.string().regex(/^[a-f\d]{64}$/u),
              details: z.array(z.string().max(512)).max(64),
            }),
          )
          .max(64),
      }),
    })
    .optional(),
  conversation: z
    .strictObject({
      interestedSessions: z.number().int().nonnegative().max(CONVERSATION_INTEREST_ITEMS),
      suppressedProgress: z.number().int().nonnegative(),
      publishedProgress: z.number().int().nonnegative(),
      activeExecutions: z.number().int().nonnegative(),
      pendingStreamItems: z.number().int().nonnegative().optional(),
      preparingExecutions: z.number().int().nonnegative().optional(),
      nativeRebuilds: z.number().int().nonnegative().optional(),
      nativeForks: z.number().int().nonnegative().max(5).optional(),
      forkPreparations: z.number().int().nonnegative().max(5).optional(),
      adapterSlots: z.number().int().nonnegative().optional(),
      completeReads: z.number().int().nonnegative(),
    })
    .optional(),
  status: z.literal('ready'),
  database: z.literal('ready'),
  pid: z.number().int().positive(),
  checkedAt: z.string().datetime(),
})

export type RuntimeHealth = z.infer<typeof runtimeHealthSchema>

export const runtimeAgentIdSchema = z.enum(['claude', 'codex'])
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>

export const RUNTIME_MINIMUM_VERSIONS = {
  claude: '2.1.272',
  codex: '0.159.2',
} as const satisfies Record<RuntimeAgentId, string>

export const runtimeReadinessStateSchema = z.enum([
  'ready',
  'missing',
  'unsupported_version',
  'authentication_required',
  'startup_failed',
  'cannot_verify',
])
export type RuntimeReadinessState = z.infer<typeof runtimeReadinessStateSchema>

export const runtimeAgentReadinessSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  state: runtimeReadinessStateSchema,
  executablePath: z.string().optional(),
  version: z.string().optional(),
  detail: z.string().optional(),
  checkedAt: z.string().datetime(),
})
export type RuntimeAgentReadiness = z.infer<typeof runtimeAgentReadinessSchema>

export const runtimePreparationSchema = z.strictObject({
  firstUse: z.boolean(),
  agents: z.tuple([runtimeAgentReadinessSchema, runtimeAgentReadinessSchema]),
})
export type RuntimePreparation = z.infer<typeof runtimePreparationSchema>

export const runtimeExecutablePathUpdateSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  executablePath: z.string().min(1),
})
export type RuntimeExecutablePathUpdate = z.infer<typeof runtimeExecutablePathUpdateSchema>

export const agentSpeedSchema = z.enum(['native', 'standard', 'fast'])
export type AgentSpeed = z.infer<typeof agentSpeedSchema>

export const agentModelSelectionSchema = z
  .strictObject({
    model: z.string().min(1).nullable(),
    effort: z.string().min(1).nullable(),
    // Missing in historical revisions: preserve the native CLI's behavior.
    speed: agentSpeedSchema.optional(),
  })
  .refine((selection) => selection.model !== null || selection.effort === null, {
    message: 'A concrete effort requires a concrete model.',
    path: ['effort'],
  })
export type AgentModelSelection = z.infer<typeof agentModelSelectionSchema>

export const defaultSessionSettingsSchema = z.strictObject({
  primaryAgentId: runtimeAgentIdSchema,
  agents: z.strictObject({
    claude: agentModelSelectionSchema,
    codex: agentModelSelectionSchema,
  }),
  maxDiscussionRounds: z.number().int().min(1).max(20),
  runningMessagePolicy: z.enum(['immediate_safe_point', 'next_round']),
  maxReviewCycles: z.number().int().min(1).max(10),
  maxRepairAttempts: z.number().int().min(1).max(10),
})
export type DefaultSessionSettings = z.infer<typeof defaultSessionSettingsSchema>

export const sessionPermissionModeSchema = z.enum(['native', 'ask', 'auto', 'full'])
export type SessionPermissionMode = z.infer<typeof sessionPermissionModeSchema>
export const sessionSettingsSchema = defaultSessionSettingsSchema.extend({
  permissionModes: z
    .strictObject({
      claude: sessionPermissionModeSchema,
      codex: sessionPermissionModeSchema,
    })
    .optional(),
})
export type SessionSettings = z.infer<typeof sessionSettingsSchema>

export const defaultSessionSettingsStateSchema = z.strictObject({
  settings: defaultSessionSettingsSchema,
  updatedAt: z.string().datetime(),
})
export type DefaultSessionSettingsState = z.infer<typeof defaultSessionSettingsStateSchema>

export const agentModelOptionSchema = z.strictObject({
  id: z.string().min(1),
  // A CLI alias may resolve to a different wire ID for this configuration/CWD.
  resolvedModel: z.string().min(1).max(240).optional(),
  displayName: z.string().min(1),
  supportedEfforts: z.array(z.string().min(1)),
  defaultEffort: z.string().min(1).optional(),
  supportsFastMode: z.boolean().optional(),
})
export type AgentModelOption = z.infer<typeof agentModelOptionSchema>

export const agentModelCatalogSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  status: z.enum(['available', 'unavailable']),
  cliVersion: z.string().min(1).optional(),
  models: z.array(agentModelOptionSchema),
  checkedAt: z.string().datetime(),
  detail: z.string().optional(),
})
export type AgentModelCatalog = z.infer<typeof agentModelCatalogSchema>

export const defaultSessionSettingsEditorStateSchema = z.strictObject({
  modelCatalogs: z.strictObject({
    claude: agentModelCatalogSchema,
    codex: agentModelCatalogSchema,
  }),
  current: defaultSessionSettingsStateSchema.optional(),
})
export type DefaultSessionSettingsEditorState = z.infer<
  typeof defaultSessionSettingsEditorStateSchema
>

export const defaultSessionSettingsSaveInputSchema = z.strictObject({
  settings: defaultSessionSettingsSchema,
})
export type DefaultSessionSettingsSaveInput = z.infer<typeof defaultSessionSettingsSaveInputSchema>

export const projectKindSchema = z.enum(['git', 'directory'])
export type ProjectKind = z.infer<typeof projectKindSchema>

export const projectSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().min(1),
  directoryPath: z.string().min(1),
  kind: projectKindSchema,
  createdAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
})
export type Project = z.infer<typeof projectSchema>

export const projectCatalogStateSchema = z.strictObject({
  projects: z.array(projectSchema),
})
export type ProjectCatalogState = z.infer<typeof projectCatalogStateSchema>

export const projectDirectoryAddInputSchema = z.strictObject({
  directoryPath: z.string().min(1),
})
export type ProjectDirectoryAddInput = z.infer<typeof projectDirectoryAddInputSchema>

export const projectArchiveInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
})
export type ProjectArchiveInput = z.infer<typeof projectArchiveInputSchema>

export const projectContextInputSchema = z.strictObject({ projectId: z.string().uuid() })
export type ProjectContextInput = z.infer<typeof projectContextInputSchema>
export const projectContextSchema = z.strictObject({
  projectId: z.string().uuid(),
  directoryPath: z.string().min(1).max(32_768),
  folderName: z.string().min(1).max(4096),
  git: z.discriminatedUnion('state', [
    z.strictObject({
      state: z.literal('branch'),
      name: z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\p{Cc}]+$/u),
    }),
    z.strictObject({ state: z.literal('detached'), commit: z.string().regex(/^[a-f0-9]{4,64}$/u) }),
    z.strictObject({ state: z.literal('none') }),
    z.strictObject({ state: z.literal('unavailable') }),
  ]),
})
export type ProjectContext = z.infer<typeof projectContextSchema>
export const projectDirectoryOpenResultSchema = z.strictObject({ opened: z.literal(true) })

export const PROJECT_NAME_LIMIT = 120
// Shared by the rename command and its one-item receipt; both remain below 1 KiB.
export const projectNameChangeSchema = z.strictObject({
  projectId: z.string().uuid(),
  name: z
    .string()
    .trim()
    .min(1)
    .max(PROJECT_NAME_LIMIT)
    .regex(/^[^\p{Cc}]+$/u),
})
export type ProjectNameChange = z.infer<typeof projectNameChangeSchema>

export const sessionStatusSchema = z.enum([
  'draft',
  'idle',
  'discussing',
  'waiting_for_user',
  'plan_ready',
  'building',
  'reviewing',
  'completed',
  'paused',
  'archived',
])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export const MAX_AGENT_RUN_ATTEMPTS = 3

export const sessionActivitySchema = z.strictObject({
  state: z.enum([
    'idle',
    'agent_working',
    'recovering',
    'waiting_for_user',
    'error',
    'interrupted',
    'paused',
    'completed',
  ]),
  agentId: runtimeAgentIdSchema.optional(),
  attemptCount: z.number().int().positive().optional(),
})
export type SessionActivity = z.infer<typeof sessionActivitySchema>

export const sessionTitleSourceSchema = z.enum(['placeholder', 'local', 'agent', 'user'])
export type SessionTitleSource = z.infer<typeof sessionTitleSourceSchema>

export const collaborationSessionSchema = z.strictObject({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  title: z.string().min(1),
  titleSource: sessionTitleSourceSchema,
  status: sessionStatusSchema,
  activity: sessionActivitySchema,
  hasUnread: z.boolean(),
  settings: sessionSettingsSchema,
  settingsRevision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
})
export type CollaborationSession = z.infer<typeof collaborationSessionSchema>

export const SESSION_CATALOG_PAGE_ITEMS = 5
export const SESSION_CATALOG_PAGE_BYTES = 1024 * 1024

export const sessionCatalogCursorSchema = z.strictObject({
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
})
export type SessionCatalogCursor = z.infer<typeof sessionCatalogCursorSchema>

export const sessionCatalogPageInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  cursor: sessionCatalogCursorSchema.optional(),
})
export type SessionCatalogPageInput = z.infer<typeof sessionCatalogPageInputSchema>

export const sessionCatalogPageSchema = z.strictObject({
  kind: z.literal('page'),
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  sessions: z.array(collaborationSessionSchema).max(SESSION_CATALOG_PAGE_ITEMS),
  nextCursor: sessionCatalogCursorSchema.optional(),
})
export type SessionCatalogPage = z.infer<typeof sessionCatalogPageSchema>

export const sessionCatalogChangeSchema = z.strictObject({
  kind: z.literal('change'),
  revision: z.number().int().nonnegative(),
  session: collaborationSessionSchema,
})
export type SessionCatalogChange = z.infer<typeof sessionCatalogChangeSchema>

export const sessionCatalogReplySchema = z.discriminatedUnion('kind', [
  sessionCatalogPageSchema,
  sessionCatalogChangeSchema,
])
export type SessionCatalogReply = z.infer<typeof sessionCatalogReplySchema>

export const sessionCreationPrepareInputSchema = z.strictObject({
  projectId: z.string().uuid(),
})
export type SessionCreationPrepareInput = z.infer<typeof sessionCreationPrepareInputSchema>

export const sessionCreateInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  settings: defaultSessionSettingsSchema,
})
export type SessionCreateInput = z.infer<typeof sessionCreateInputSchema>

export const sessionSettingsInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
})
export type SessionSettingsInput = z.infer<typeof sessionSettingsInputSchema>

export const sessionArchiveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  operationId: z.string().uuid().optional(),
})
export type SessionArchiveInput = z.infer<typeof sessionArchiveInputSchema>

export const sessionRenameInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
})
export type SessionRenameInput = z.infer<typeof sessionRenameInputSchema>

export const sessionMarkReadInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  throughSequence: z.number().int().nonnegative(),
})
export type SessionMarkReadInput = z.infer<typeof sessionMarkReadInputSchema>

export const sessionSettingsEditorStateSchema = z.strictObject({
  session: collaborationSessionSchema,
  modelCatalogs: defaultSessionSettingsEditorStateSchema.shape.modelCatalogs,
})
export type SessionSettingsEditorState = z.infer<typeof sessionSettingsEditorStateSchema>

export const sessionSettingsSaveResultSchema = z.strictObject({
  catalogChange: sessionCatalogChangeSchema,
  modelCatalogs: defaultSessionSettingsEditorStateSchema.shape.modelCatalogs,
})
export type SessionSettingsSaveResult = z.infer<typeof sessionSettingsSaveResultSchema>

export const sessionSettingsSaveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  settings: defaultSessionSettingsSchema,
})
export type SessionSettingsSaveInput = z.infer<typeof sessionSettingsSaveInputSchema>

export const sessionPermissionSaveInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    agentId: runtimeAgentIdSchema,
    mode: sessionPermissionModeSchema,
    expectedRevision: z.number().int().positive(),
    confirmedFullAccess: z.boolean().default(false),
  })
  .refine(
    (input) => input.mode !== 'full' || input.confirmedFullAccess,
    'Full access requires explicit confirmation.',
  )
export type SessionPermissionSaveInput = z.infer<typeof sessionPermissionSaveInputSchema>

export const sessionSpeedSaveInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  speed: agentSpeedSchema,
  expectedRevision: z.number().int().positive(),
})
export type SessionSpeedSaveInput = z.infer<typeof sessionSpeedSaveInputSchema>

export const sessionForkSideSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  state: z.enum(['prepared', 'forking', 'unconfirmed', 'initializing', 'ready', 'error']),
  nativeSessionId: z.string().min(1).max(1024).optional(),
  reason: z.string().max(1024).optional(),
  canInitialize: z.boolean(),
  canContinue: z.boolean(),
})
export const sessionForkOperationSchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  sourceSessionId: z.string().uuid(),
  sourceMessageId: z.string().uuid(),
  sourceSequence: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  ready: z.boolean(),
  sides: z.array(sessionForkSideSchema).length(2),
})
export type SessionForkOperation = z.infer<typeof sessionForkOperationSchema>

export const sessionForkPreparedSchema = z.strictObject({
  sourceSessionId: z.string().uuid(),
  messageId: z.string().uuid(),
  messageRevision: z.number().int().nonnegative(),
  settingsRevision: z.number().int().positive(),
  sourceRevision: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  preview: z.string().max(256),
  settings: sessionSettingsSchema,
})
export type SessionForkPrepared = z.infer<typeof sessionForkPreparedSchema>

const sessionForkActionSchema = z.strictObject({
  sessionId: z.string().uuid(),
  operationId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
})
export const sessionForkInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('prepare'),
    sourceSessionId: z.string().uuid(),
    messageId: z.string().uuid(),
  }),
  sessionForkPreparedSchema.omit({ sequence: true, preview: true, settings: true }).extend({
    action: z.literal('create'),
    operationId: z.string().uuid(),
    confirmedFullAccessAgents: z.array(runtimeAgentIdSchema).max(2),
  }),
  z.strictObject({ action: z.literal('read'), sessionId: z.string().uuid() }),
  sessionForkActionSchema.extend({ action: z.literal('check') }),
  sessionForkActionSchema.extend({ action: z.literal('initialize') }),
  sessionForkActionSchema.extend({ action: z.literal('continue') }),
])
export type SessionForkInput = z.infer<typeof sessionForkInputSchema>
export const sessionForkResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('prepared'), prepared: sessionForkPreparedSchema }),
  z.strictObject({
    kind: z.literal('created'),
    change: sessionCatalogChangeSchema,
    operation: sessionForkOperationSchema,
  }),
  z.strictObject({ kind: z.literal('state'), operation: sessionForkOperationSchema.nullable() }),
])
export type SessionForkResult = z.infer<typeof sessionForkResultSchema>

export const conversationMessageRouteSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('primary'), agentId: runtimeAgentIdSchema }),
  z.strictObject({ type: z.literal('agent'), agentId: runtimeAgentIdSchema }),
  z.strictObject({
    type: z.literal('all'),
    firstAgentId: runtimeAgentIdSchema,
    secondAgentId: runtimeAgentIdSchema,
  }),
])
export type ConversationMessageRoute = z.infer<typeof conversationMessageRouteSchema>

export const peerRequestKindSchema = z.enum(['supplement', 'fact_check', 'challenge', 'review'])
export type PeerRequestKind = z.infer<typeof peerRequestKindSchema>

export const peerRequestToolInputShape = {
  target: runtimeAgentIdSchema,
  kind: peerRequestKindSchema,
  reason: z.string().trim().min(1).max(240).optional(),
}
export function peerRequestToolInputShapeFor<T extends RuntimeAgentId>(target: T) {
  return { ...peerRequestToolInputShape, target: z.literal(target) }
}
export const peerRequestToolInputSchema = z.strictObject(peerRequestToolInputShape)
export type PeerRequestToolInput = z.infer<typeof peerRequestToolInputSchema>

export const peerRequestProposalSchema = z.strictObject({
  id: z.string().uuid(),
  targetAgentId: runtimeAgentIdSchema,
  kind: peerRequestKindSchema,
  reason: z.string().min(1).max(240).optional(),
  state: z.enum(['pending', 'accepted', 'dismissed', 'superseded']),
  acceptedMessageId: z.string().uuid().optional(),
})
export type PeerRequestProposal = z.infer<typeof peerRequestProposalSchema>

export const conversationDisplayOrderSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  rank: z.number().int().min(0).max(2),
  id: z.string().uuid(),
})
export type ConversationDisplayOrder = z.infer<typeof conversationDisplayOrderSchema>
export const conversationSnapshotViewSchema = z.strictObject({
  runId: z.string().uuid(),
  mode: z.enum(['preserve', 'expanded']),
})
export type ConversationSnapshotView = z.infer<typeof conversationSnapshotViewSchema>
export const conversationRunContextSchema = z.strictObject({
  runId: z.string().uuid(),
  order: conversationDisplayOrderSchema,
  earlierResponseCount: z.number().int().nonnegative().max(64),
  settled: z.boolean(),
})
export type ConversationRunContext = z.infer<typeof conversationRunContextSchema>

export const conversationMessageSchema = z.strictObject({
  outputSnapshot: z
    .strictObject({
      ordinal: z.number().int().nonnegative().max(63),
      frozen: z.boolean(),
      canonical: z.boolean(),
      order: conversationDisplayOrderSchema,
    })
    .optional(),
  skills: skillSelectionsSchema.optional(),
  images: conversationImagesSchema.optional(),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid().optional(),
  replyToMessageId: z.string().uuid().optional(),
  role: z.enum(['user', 'assistant', 'system']),
  agentId: runtimeAgentIdSchema.optional(),
  route: conversationMessageRouteSchema.optional(),
  pendingAgentId: runtimeAgentIdSchema.optional(),
  sourceMessageId: z.string().uuid().optional(),
  content: z.string(),
  contentRevision: z.number().int().nonnegative(),
  state: z.enum(['complete', 'streaming', 'incomplete']),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type ConversationMessage = z.infer<typeof conversationMessageSchema>

export function conversationMessageOrder(
  message: Pick<ConversationMessage, 'id' | 'sequence' | 'outputSnapshot'>,
): ConversationDisplayOrder {
  return message.outputSnapshot?.order ?? { sequence: message.sequence, rank: 1, id: message.id }
}
export function compareConversationDisplayOrder(
  left: ConversationDisplayOrder,
  right: ConversationDisplayOrder,
): number {
  return left.sequence - right.sequence || left.rank - right.rank || left.id.localeCompare(right.id)
}
export function compareConversationMessages(
  left: ConversationMessage,
  right: ConversationMessage,
): number {
  return compareConversationDisplayOrder(
    conversationMessageOrder(left),
    conversationMessageOrder(right),
  )
}

export const agentActivitySchema = z.strictObject({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  runId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  nativeId: z.string().min(1),
  kind: z.enum(['reasoning', 'tool']),
  toolName: z.string().min(1).max(120).optional(),
  title: z.string().min(1),
  detail: z.string().optional(),
  detailRevision: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed']),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentActivity = z.infer<typeof agentActivitySchema>

export const runFailureKindSchema = z.enum([
  'transient_transport',
  'agent_process_crash',
  'authentication_required',
  'quota_or_rate_limit',
  'runtime_incompatible',
  'native_session_occupied',
  'protocol_error',
  'response_too_large',
  'permission_blocked',
  'unknown_delivery',
  'context_resume_failed',
  'context_limit',
  'user_stopped',
])
export type RunFailureKind = z.infer<typeof runFailureKindSchema>

export const nativeContinuationStateSchema = z.enum([
  'ready',
  'responding',
  'waiting_user',
  'checking',
  'recovery_required',
  'rebuilding',
])
export type NativeContinuationState = z.infer<typeof nativeContinuationStateSchema>

export const nativeEvidenceIdentitySchema = z.strictObject({
  answerFormat: z.enum(['collaboration_envelope_v5']).optional(),
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  runId: z.string().uuid().optional(),
  requestId: z.string().uuid(),
  nativeSessionId: z.string().min(1).max(1024),
  nativeTurnId: z.string().min(1).max(1024).optional(),
  bindingGeneration: z.number().int().positive(),
  executorId: z.string().uuid().optional(),
})
export type NativeEvidenceIdentity = z.infer<typeof nativeEvidenceIdentitySchema>

/** Small private initialization receipt; never a copy of native history. */
export const nativeInitializationWitnessSchema = z.strictObject({
  kind: z.literal('codex_rollout_v1'),
  nativeSessionId: nativeEvidenceIdentitySchema.shape.nativeSessionId,
  verifiedPrefixBytes: z
    .number()
    .int()
    .positive()
    .max(32 * 1024 * 1024),
  verifiedPrefixSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  recordCount: z.number().int().positive().max(10_000),
})
export type NativeInitializationWitness = z.infer<typeof nativeInitializationWitnessSchema>

const nativeRecoveredOutputSchema = z.strictObject({
  outputId: z.string().min(1).max(1024),
  text: z.string(),
  completeness: z.enum(['complete', 'partial']),
  submittedReport: collaborationResultSchema.optional(),
})
export type NativeRecoveredOutput = z.infer<typeof nativeRecoveredOutputSchema>
export const nativeProbeResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('binding_ready'),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('completed_initialization_readback'),
    rebuildId: z.string().uuid(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    witness: nativeInitializationWitnessSchema.optional(),
  }),
  z.strictObject({
    kind: z.enum(['running', 'waiting_user']),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('live_runtime'),
  }),
  z.strictObject({
    kind: z.literal('ended'),
    identity: nativeEvidenceIdentitySchema,
    source: z.enum(['live_terminal', 'stored_terminal']),
    outcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
    output: nativeRecoveredOutputSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('missing'),
    identity: nativeEvidenceIdentitySchema,
    source: z.literal('native_error'),
  }),
  z.strictObject({
    kind: z.literal('no_evidence'),
    identity: nativeEvidenceIdentitySchema,
    reason: z.string().min(1).max(240),
    output: nativeRecoveredOutputSchema.optional(),
  }),
])
export type NativeProbeResult = z.infer<typeof nativeProbeResultSchema>

export const nativeRebuildOperationSchema = z.strictObject({
  id: z.string().uuid(),
  oldGeneration: z.number().int().positive(),
  stage: z.enum([
    'preparing',
    'creating',
    'seeding',
    'unconfirmed',
    'completed',
    'failed',
    'superseded',
  ]),
  provisionalNativeSessionId: z.string().min(1).max(1024).optional(),
  sourceHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  failureReason: z.string().max(240).optional(),
  checkAction: z.enum(['inspect', 'rebuild']).optional(),
})
export type NativeRebuildOperation = z.infer<typeof nativeRebuildOperationSchema>
export const pendingNativeRebuildSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  operation: nativeRebuildOperationSchema,
})
export type PendingNativeRebuild = z.infer<typeof pendingNativeRebuildSchema>

export const pendingNativeInteractionSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  bindingGeneration: z.number().int().positive(),
  executorId: z.string().uuid().optional(),
  request: nativePermissionRequestSchema,
})
export type PendingNativeInteraction = z.infer<typeof pendingNativeInteractionSchema>

export const agentRunSchema = z.strictObject({
  outputSnapshots: z
    .strictObject({
      count: z.number().int().nonnegative().max(64),
      lastInputMessageId: z.string().uuid(),
      lastInputSequence: z.number().int().nonnegative(),
      settled: z.boolean(),
    })
    .optional(),
  answerFormat: z.enum(['collaboration_envelope_v5']).optional(),
  collaboration: z
    .strictObject({
      taskId: z.string().uuid(),
      kind: z.enum(['plan', 'build', 'review']),
      stage: z.enum([
        'draft',
        'discuss',
        'clarify',
        'implement',
        'supplement',
        'review',
        'respond',
        'repair',
      ]),
    })
    .optional(),
  forkSourceRunId: z.string().uuid().optional(),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  status: z.enum(['starting', 'running', 'recovering', 'completed', 'failed', 'interrupted']),
  attemptCount: z.number().int().positive(),
  settingsRevision: z.number().int().positive(),
  model: z.string().min(1).nullable(),
  permissionMode: sessionPermissionModeSchema.optional(),
  effort: z.string().min(1).nullable(),
  speed: agentSpeedSchema.optional(),
  observedSpeed: z.enum(['standard', 'fast']).optional(),
  speedDetail: z.string().max(512).optional(),
  nativeSessionId: z.string().min(1).optional(),
  nativeTurnId: z.string().min(1).optional(),
  bindingGeneration: z.number().int().positive().optional(),
  executorId: z.string().uuid().optional(),
  controlDisposition: z.enum(['retained', 'abandoned']).optional(),
  dispatchPhase: z.enum(['not_sent', 'possibly_sent', 'accepted', 'ended', 'rejected']).optional(),
  nativeOutcome: z.enum(['completed', 'failed', 'interrupted']).optional(),
  responseMessageId: z.string().uuid().optional(),
  nativeEffectsState: z.enum(['not_dispatched', 'pending', 'settled', 'unknown']).optional(),
  nativeEffectsReason: z.string().max(128).optional(),
  workspaceRecordingUnavailableReason: z.string().min(1).max(240).optional(),
  reexecutedFromRunId: z.string().uuid().optional(),
  failureKind: runFailureKindSchema.optional(),
  failureMessage: z.string().optional(),
  handoffMessageCount: z.number().int().positive().optional(),
  peerProposal: peerRequestProposalSchema.optional(),
  workspaceChanges: workspaceChangeSetSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type AgentRun = z.infer<typeof agentRunSchema>

export const nativeAgentContextSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  permissionRequests: z
    .array(nativePermissionRequestSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
  nativeSessionId: z.string().min(1),
  bindingGeneration: z.number().int().positive().optional(),
  executorId: z.string().uuid().optional(),
  continuationState: nativeContinuationStateSchema.optional(),
  recoveryReason: z.string().max(240).optional(),
  recoveryAction: z.enum(['retry', 'rebuild', 'none']).optional(),
  rebuildOperation: nativeRebuildOperationSchema.optional(),
  state: z.enum([
    'active',
    'interrupted',
    'missing',
    'rebuilding',
    'unavailable',
    'uncertain',
    'superseded',
  ]),
  lastRunId: z.string().uuid().optional(),
  recoveryFailureKind: runFailureKindSchema.optional(),
  recoveryFailureMessage: z.string().optional(),
  rebuildMessageCount: z.number().int().nonnegative().optional(),
  rebuiltThroughSequence: z.number().int().nonnegative().optional(),
  updatedAt: z.string().datetime(),
})
export type NativeAgentContext = z.infer<typeof nativeAgentContextSchema>

export const sessionIssueSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  generation: z.number().int().positive(),
  nativeSessionId: z.string().min(1).max(1024).optional(),
  runId: z.string().uuid().optional(),
  rebuildId: z.string().uuid().optional(),
  phase: z.enum(['warning', 'checking', 'rebuild_offer', 'rebuilding', 'unconfirmed', 'resolved']),
  title: z.string().max(120),
  reason: z.string().max(1024),
  inputDisposition: z.enum(['not_submitted', 'possibly_submitted', 'submitted']),
  resultDisposition: z.enum(['pending', 'complete', 'incomplete', 'unavailable']),
  action: z.enum(['retry_check', 'rebuild', 'inspect_rebuild', 'none']),
  actionReason: z.string().max(512).optional(),
  abandon: z.boolean(),
  previousCreationUnconfirmed: z.boolean(),
})
export type SessionIssue = z.infer<typeof sessionIssueSchema>
export const sessionIssuesSchema = z.strictObject({
  sessionId: z.string().uuid(),
  inputGate: z.enum(['open', 'send_blocked', 'read_only']),
  agents: z.array(sessionIssueSchema).max(2),
})
export type SessionIssues = z.infer<typeof sessionIssuesSchema>

export const rebuildInputRecoverySchema = z.strictObject({
  inputBatchRef: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.number().int().nonnegative(),
      memberCount: z.number().int().nonnegative(),
    })
    .optional(),
  operationId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  messageId: z.string().uuid(),
  bindingGeneration: z.number().int().positive(),
  state: z.enum(['pending', 'installed']),
  route: conversationMessageRouteSchema,
  commentIds: z.array(z.string().uuid()).default([]),
  draftEligibility: z
    .strictObject({
      commentsRevision: z.number().int().nonnegative(),
      canRestore: z.boolean(),
    })
    .optional(),
})
export type RebuildInputRecovery = z.infer<typeof rebuildInputRecoverySchema>
/** Private durable return receipt; original bodies remain in their existing rows. */
export const rebuildReturnedInputRecordSchema = z.strictObject({
  inputBatchRef: z
    .strictObject({
      id: z.string().uuid(),
      revision: z.number().int().nonnegative(),
      memberCount: z.number().int().nonnegative(),
    })
    .optional(),
  images: z
    .array(z.strictObject({ id: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }))
    .max(128)
    .optional(),
  version: z.literal('rebuild-return-v1'),
  state: z.enum(['prepared', 'pending', 'installed', 'consumed']),
  messageId: z.string().uuid(),
  runId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f\d]{64}$/u),
  route: conversationMessageRouteSchema,
  comments: z.array(
    z.strictObject({
      sourceId: z.string().uuid(),
      cloneId: z.string().uuid(),
      hash: z.string().regex(/^[a-f\d]{64}$/u),
    }),
  ),
})
export type RebuildReturnedInputRecord = z.infer<typeof rebuildReturnedInputRecordSchema>

/** One durable pending input; previews never carry complete message bodies. */
export const conversationQueuedInputSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  recipient: z.enum(['claude', 'codex', 'all']),
  preview: z.string().max(512),
  workflowCommand: z.boolean(),
  state: z.enum(['queued', 'paused', 'dispatching', 'unknown']),
  delivery: z.strictObject({ runId: z.string().uuid(), canRemove: z.boolean() }).optional(),
  reason: z.string().max(512).optional(),
  imageCount: z.number().int().nonnegative().max(128),
  commentCount: z.number().int().nonnegative(),
  skillCount: z.number().int().nonnegative(),
})
export type ConversationQueuedInput = z.infer<typeof conversationQueuedInputSchema>
export const conversationQueueStateSchema = z.strictObject({
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  input: conversationQueuedInputSchema.nullable(),
  returnedInput: z
    .strictObject({
      inputId: z.string().uuid(),
      operationId: z.string().uuid(),
      expectedRevision: z.number().int().nonnegative(),
      claimId: z.string().uuid().optional(),
      installedCommentsRevision: z.number().int().nonnegative().optional(),
      state: z.enum(['pending', 'installed']),
    })
    .nullable()
    .optional(),
})
export type ConversationQueueState = z.infer<typeof conversationQueueStateSchema>
export const conversationQueueActionInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  inputId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
})
export type ConversationQueueActionInput = z.infer<typeof conversationQueueActionInputSchema>
export const conversationQueueReturnInputSchema = conversationQueueActionInputSchema.extend({
  phase: z.enum(['return', 'claim']).default('return'),
  claimId: z.string().uuid().optional(),
  expectedCommentsRevision: z.number().int().nonnegative().optional(),
})
export type ConversationQueueReturnInput = z.infer<typeof conversationQueueReturnInputSchema>
export const conversationQueueEnabledInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  enabled: z.boolean(),
  expectedRevision: z.number().int().nonnegative(),
  operationId: z.string().uuid(),
})
export type ConversationQueueEnabledInput = z.infer<typeof conversationQueueEnabledInputSchema>

export const conversationSnapshotSchema = z.strictObject({
  observation: z.strictObject({
    incarnation: z.string().uuid(),
    sequence: z.number().int().positive(),
  }),
  sessionId: z.string().uuid(),
  session: z.strictObject({
    id: z.string().uuid(),
    title: z.string().min(1),
    titleSource: sessionTitleSourceSchema,
    status: sessionStatusSchema,
    activity: sessionActivitySchema,
    hasUnread: z.boolean(),
    updatedAt: z.string().datetime(),
  }),
  messages: z.array(conversationMessageSchema),
  comments: z.array(anchoredCommentSchema),
  commentsRevision: z.number().int().nonnegative(),
  activities: z.array(agentActivitySchema),
  runs: z.array(agentRunSchema),
  nativeContexts: z.array(nativeAgentContextSchema),
  rebuildOperations: z.array(pendingNativeRebuildSchema).max(2).optional(),
  rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
  forkOperation: sessionForkOperationSchema.optional(),
  forkBlocked: z.boolean().optional(),
  pendingNativeInteractions: z
    .array(pendingNativeInteractionSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
})
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>

export const CONVERSATION_PAGE_ITEMS = 25
export const CONVERSATION_PAGE_BYTES = 1024 * 1024
export const CONVERSATION_WINDOW_MESSAGES = 100
export const CONVERSATION_WORK_LOG_ITEMS = 50
export const CONVERSATION_EXPAND_BYTES = 2 * 1024 * 1024
export const CONVERSATION_MARKDOWN_BYTES = 128 * 1024
export const CONVERSATION_PATCH_BYTES = 64 * 1024
export const CONVERSATION_PATCH_TEXT_BYTES = 16 * 1024
export const CONVERSATION_PATCH_ACTIVITY_ITEMS = 16
export const CONVERSATION_STREAM_BATCH_ITEMS = 64
export const CONVERSATION_STREAM_BATCH_BYTES = 1024 * 1024
export const conversationInterestSchema = z.strictObject({
  sessionId: z.string().uuid().nullable(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
export const conversationInterestsSchema = z
  .strictObject({
    sessionIds: z.array(z.string().uuid()).max(CONVERSATION_INTEREST_ITEMS),
  })
  .refine(
    (value) =>
      new Set(value.sessionIds).size === value.sessionIds.length &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 512,
    'Conversation interests exceed their unique-item or byte limit.',
  )

const conversationPageBaseInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
})
export const conversationGetInputSchema = z.discriminatedUnion('scope', [
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration-markdown'),
    basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']).optional(),
    runId: z.string().uuid(),
    document: collaborationDocumentSchema,
    offset: z.number().int().nonnegative(),
    aroundOffset: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration-text'),
    runId: z.string().uuid(),
    document: collaborationDocumentSchema,
    offset: z.number().int().nonnegative(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('collaboration'),
    runId: z.string().uuid().optional(),
    projection: z.enum(['current', 'report', 'plan', 'todos']).optional(),
    taskId: z.string().uuid().optional(),
    ledgerRevision: z.number().int().nonnegative().optional(),
    todoStatus: z.enum(['active', 'done', 'all', 'source']).optional(),
    todoOffset: z.number().int().nonnegative().optional(),
    todoId: z.string().min(1).max(80).optional(),
    todoRevision: z.number().int().positive().optional(),
    feedbackOffset: z.number().int().nonnegative().optional(),
    feedbackId: z.string().min(1).max(80).optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('queued-input'),
    source: z.enum(['queued', 'returned']),
    inputId: z.string().uuid(),
    operationId: z.string().uuid().optional(),
    offset: z.number().int().nonnegative(),
    commentsAfterPosition: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('rebuild-input'),
    operationId: z.string().uuid(),
    offset: z.number().int().nonnegative(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('messages'),
    beforeSequence: z.number().int().nonnegative().optional(),
    beforeDisplay: conversationDisplayOrderSchema.optional(),
    snapshotView: conversationSnapshotViewSchema.optional(),
    preserveRunId: z.string().uuid().optional(),
    aroundMessageId: z.string().uuid().optional(),
    includeHistoricalSource: z.boolean().optional(),
    incarnation: z.string().uuid().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('drafts'),
    afterPosition: z.number().int().nonnegative().optional(),
    expectedRevision: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('comments'),
    messageIds: z
      .array(z.string().uuid())
      .min(1)
      .max(CONVERSATION_WINDOW_MESSAGES)
      .refine((ids) => new Set(ids).size === ids.length, 'Message IDs must be unique.'),
    afterPosition: z.number().int().nonnegative().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('activities'),
    runId: z.string().uuid(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('run-artifacts'),
    userMessageId: z.string().uuid(),
    agentId: runtimeAgentIdSchema,
    before: z.strictObject({ createdAt: z.string().datetime(), id: z.string().uuid() }).optional(),
    incarnation: z.string().uuid().optional(),
  }),
  conversationPageBaseInputSchema.extend({
    scope: z.literal('activity-body'),
    activityId: z.string().uuid(),
    detailRevision: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
  }),
])
export type ConversationGetInput = z.infer<typeof conversationGetInputSchema>

const conversationObservationSchema = z.strictObject({
  incarnation: z.string().uuid(),
  sequence: z.number().int().positive(),
})
export type ConversationObservation = z.infer<typeof conversationObservationSchema>

const conversationPageMessageSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('complete'),
    message: conversationMessageSchema,
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('oversized'),
    message: conversationMessageSchema.omit({ content: true }),
    contentBytes: z.number().int().positive(),
    preview: z.string(),
    previewChars: z.number().int().nonnegative(),
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  }),
])
export type ConversationPageMessage = z.infer<typeof conversationPageMessageSchema>

const conversationPageActivitySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete'), activity: agentActivitySchema }),
  z.strictObject({
    kind: z.literal('oversized'),
    activity: agentActivitySchema.omit({ detail: true }),
    detailBytes: z.number().int().positive(),
    preview: z.string(),
    previewChars: z.number().int().nonnegative(),
  }),
])
export type ConversationPageActivity = z.infer<typeof conversationPageActivitySchema>

const conversationPageHeaderSchema = z.strictObject({
  queue: conversationQueueStateSchema.optional(),
  receivedInputIds: z.array(z.string().uuid()).max(1).optional(),
  session: conversationSnapshotSchema.shape.session,
  commentsRevision: z.number().int().nonnegative(),
  latestRun: agentRunSchema.optional(),
  latestCompleteAssistantSequence: z.number().int().nonnegative().optional(),
  nativeContexts: z.array(nativeAgentContextSchema).max(2).optional(),
  rebuildOperations: z.array(pendingNativeRebuildSchema).max(2).optional(),
  rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
  forkOperation: sessionForkOperationSchema.optional(),
  forkBlocked: z.boolean().optional(),
  sessionIssues: sessionIssuesSchema.optional(),
  pendingNativeInteractions: z
    .array(pendingNativeInteractionSchema)
    .max(NATIVE_PERMISSION_REQUESTS)
    .optional(),
})

export const conversationPageSchema = z
  .discriminatedUnion('scope', [
    z
      .strictObject({
        scope: z.literal('collaboration-markdown'),
        basis: z.enum(['markdown-visible-v2', 'plain-visible-v1']),
        sessionId: z.string().uuid(),
        document: collaborationDocumentSchema,
        offset: z.number().int().nonnegative(),
        visibleStart: z.number().int().nonnegative(),
        visibleEnd: z.number().int().nonnegative(),
        tree: collaborationMarkdownNodeSchema,
        nextOffset: z.number().int().nonnegative().nullable(),
        previousOffset: z.number().int().nonnegative().nullable(),
      })
      .refine(
        (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 48 * 1024,
        'Collaboration Markdown page exceeds its byte budget.',
      )
      .refine(
        (page) => collaborationMarkdownTreeWithinBudget(page.tree),
        'Markdown page exceeds its node or stack budget.',
      ),
    z
      .strictObject({
        scope: z.literal('collaboration-text'),
        sessionId: z.string().uuid(),
        document: collaborationDocumentSchema,
        offset: z.number().int().nonnegative(),
        text: z.string(),
        nextOffset: z.number().int().nonnegative().nullable(),
      })
      .refine(
        (v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= 48 * 1024,
        'Collaboration text page exceeds its byte budget.',
      ),
    z.strictObject({
      scope: z.literal('collaboration'),
      sessionId: z.string().uuid(),
      view: collaborationViewSchema,
    }),
    z.strictObject({
      scope: z.literal('queued-input'),
      source: z.enum(['queued', 'returned']),
      offset: z.number().int().nonnegative(),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
      operationId: z.string().uuid().optional(),
      text: z.string().max(8192),
      nextOffset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      commentsNextPosition: z.number().int().nonnegative().nullable(),
      images: conversationImagesSchema.optional(),
      skills: skillSelectionsSchema.optional(),
      route: conversationMessageRouteSchema,
      batchId: z.string().uuid().optional(),
      planningAction: z.enum(['maintain_plan', 'review_plan']).optional(),
    }),
    z.strictObject({
      scope: z.literal('rebuild-input'),
      images: conversationImagesSchema.optional(),
      skills: skillSelectionsSchema.optional(),
      sessionId: z.string().uuid(),
      operationId: z.string().uuid(),
      messageId: z.string().uuid(),
      text: z.string().max(8192),
      nextOffset: z.number().int().nonnegative(),
      hasMore: z.boolean(),
      route: conversationMessageRouteSchema,
    }),
    z.strictObject({
      scope: z.literal('messages'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      header: conversationPageHeaderSchema,
      messages: z.array(conversationPageMessageSchema).max(CONVERSATION_PAGE_ITEMS),
      runContexts: z.array(conversationRunContextSchema).max(CONVERSATION_PAGE_ITEMS).optional(),
      snapshotView: conversationSnapshotViewSchema.optional(),
      preserveRunId: z.string().uuid().optional(),
      runs: z.array(agentRunSchema).max(CONVERSATION_PAGE_ITEMS),
      runArtifacts: z
        .array(
          z.strictObject({
            userMessageId: z.string().uuid(),
            agentId: runtimeAgentIdSchema,
            totalCount: z.number().int().nonnegative(),
            latestRunId: z.string().uuid(),
          }),
        )
        .max(50)
        .optional(),
      hasOlder: z.boolean(),
      hasNewer: z.boolean(),
      sourceMessageId: z.string().uuid().optional(),
    }),
    z.strictObject({
      scope: z.literal('drafts'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      commentsRevision: z.number().int().nonnegative(),
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      hasMore: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('comments'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      comments: z.array(anchoredCommentSchema).max(CONVERSATION_PAGE_ITEMS),
      hasMore: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('activities'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      runId: z.string().uuid(),
      activities: z.array(conversationPageActivitySchema).max(CONVERSATION_WORK_LOG_ITEMS),
      truncated: z.boolean(),
    }),
    z.strictObject({
      scope: z.literal('run-artifacts'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      userMessageId: z.string().uuid(),
      agentId: runtimeAgentIdSchema,
      runs: z.array(agentRunSchema).max(3),
      totalCount: z.number().int().nonnegative(),
      latestRunId: z.string().uuid().optional(),
      nextBefore: z
        .strictObject({ createdAt: z.string().datetime(), id: z.string().uuid() })
        .optional(),
    }),
    z.strictObject({
      scope: z.literal('activity-body'),
      sessionId: z.string().uuid(),
      observation: conversationObservationSchema,
      activityId: z.string().uuid(),
      detailRevision: z.number().int().nonnegative(),
      offset: z.number().int().nonnegative(),
      text: z.string(),
      nextOffset: z.number().int().nonnegative().optional(),
    }),
  ])
  .superRefine((page, context) => {
    if (
      page.scope === 'messages' &&
      page.messages.length + (page.runContexts?.length ?? 0) > CONVERSATION_PAGE_ITEMS
    )
      context.addIssue({
        code: 'custom',
        message: 'Message and Run context rows exceed the shared page limit.',
      })
  })
export type ConversationPage = z.infer<typeof conversationPageSchema>

const conversationPatchTextEncoder = new TextEncoder()

const patchTextSchema = z
  .string()
  .refine(
    (value) =>
      conversationPatchTextEncoder.encode(value).byteLength <= CONVERSATION_PATCH_TEXT_BYTES,
    `Patch text must not exceed ${CONVERSATION_PATCH_TEXT_BYTES} UTF-8 bytes.`,
  )

const conversationMessageChangeSchema = z
  .strictObject({
    message: conversationMessageSchema.omit({ content: true }),
    mode: z.enum(['replace', 'append', 'advance', 'metadata', 'invalidate']),
    text: patchTextSchema.optional(),
    previousRevision: z.number().int().nonnegative().optional(),
    contentBytes: z.number().int().nonnegative().optional(),
    hasActivities: z.boolean(),
    hasComments: z.boolean(),
  })
  .superRefine((change, context) => {
    if ((change.mode === 'replace' || change.mode === 'append') && change.text === undefined) {
      context.addIssue({ code: 'custom', message: 'Text is required for this Message change.' })
    }
    if (
      (change.mode === 'append' || change.mode === 'advance') &&
      change.previousRevision === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Incremental change requires a previous revision.',
      })
    }
    if (
      (change.mode === 'advance' || change.mode === 'metadata' || change.mode === 'invalidate') &&
      change.text !== undefined
    ) {
      context.addIssue({ code: 'custom', message: 'This Message change cannot contain text.' })
    }
  })
export type ConversationMessageChange = z.infer<typeof conversationMessageChangeSchema>

const conversationActivityChangeSchema = z
  .strictObject({
    activity: agentActivitySchema.omit({ detail: true }),
    mode: z.enum(['replace', 'append', 'advance', 'metadata', 'invalidate']),
    detail: patchTextSchema.optional(),
    previousRevision: z.number().int().nonnegative().optional(),
    detailBytes: z.number().int().nonnegative().optional(),
  })
  .superRefine((change, context) => {
    if ((change.mode === 'replace' || change.mode === 'append') && change.detail === undefined) {
      context.addIssue({ code: 'custom', message: 'Detail is required for this Activity change.' })
    }
    if (
      (change.mode === 'append' || change.mode === 'advance') &&
      change.previousRevision === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Incremental change requires a previous revision.',
      })
    }
    if (
      (change.mode === 'advance' || change.mode === 'metadata' || change.mode === 'invalidate') &&
      change.detail !== undefined
    ) {
      context.addIssue({ code: 'custom', message: 'This Activity change cannot contain detail.' })
    }
  })
export type ConversationActivityChange = z.infer<typeof conversationActivityChangeSchema>

export const conversationPatchSchema = z
  .strictObject({
    version: z.literal('conversation-patch-v1'),
    runContexts: z.array(conversationRunContextSchema).max(1).optional(),
    queue: conversationQueueStateSchema.optional(),
    commentDraftReceipt: z
      .strictObject({ requestId: z.string().uuid(), commentId: z.string().uuid() })
      .optional(),
    sessionId: z.string().uuid(),
    observation: conversationObservationSchema,
    session: conversationSnapshotSchema.shape.session,
    messages: z.array(conversationMessageChangeSchema).max(4),
    removedMessageIds: z.array(z.string().uuid()).max(4).optional(),
    runs: z.array(agentRunSchema).max(4),
    latestRunId: z.string().uuid().optional(),
    activities: z.array(conversationActivityChangeSchema).max(CONVERSATION_PATCH_ACTIVITY_ITEMS),
    activityStates: z
      .array(
        z.strictObject({
          runId: z.string().uuid(),
          status: z.enum(['completed', 'failed']),
        }),
      )
      .max(4),
    nativeContexts: z.array(nativeAgentContextSchema).max(2).optional(),
    rebuildOperations: z.array(pendingNativeRebuildSchema).max(2).optional(),
    rebuildInputRecovery: rebuildInputRecoverySchema.nullable().optional(),
    forkOperation: sessionForkOperationSchema.optional(),
    forkBlocked: z.boolean().optional(),
    sessionIssues: sessionIssuesSchema.optional(),
    pendingNativeInteractions: z
      .array(pendingNativeInteractionSchema)
      .max(NATIVE_PERMISSION_REQUESTS)
      .optional(),
    comments: z
      .strictObject({
        revision: z.number().int().nonnegative(),
        upserts: z.array(anchoredCommentSchema).max(MAX_COMMENTS_PER_MESSAGE),
        removedIds: z.array(z.string().uuid()).max(MAX_COMMENTS_PER_MESSAGE),
        sent: z
          .strictObject({
            messageId: z.string().uuid(),
            commentIds: z.array(z.string().uuid()).max(MAX_COMMENTS_PER_MESSAGE),
          })
          .optional(),
      })
      .optional(),
    receivedInputIds: z.array(z.string().uuid()).max(1).optional(),
    // Send acknowledgement only: work was genuinely active when this input was received.
    queuedInputIds: z.array(z.string().uuid()).max(1).optional(),
    resync: z
      .strictObject({
        messages: z.boolean(),
        drafts: z.boolean(),
        activityRunIds: z.array(z.string().uuid()).max(4),
      })
      .optional(),
  })
  .refine(
    (patch) =>
      conversationPatchTextEncoder.encode(JSON.stringify(patch)).byteLength <=
      CONVERSATION_PATCH_BYTES,
    `Conversation Patch must not exceed ${CONVERSATION_PATCH_BYTES} UTF-8 bytes.`,
  )
export type ConversationPatch = z.infer<typeof conversationPatchSchema>

/** Bounded physical writes; logical message text is assembled by the Utility owner. */
export const CONVERSATION_INPUT_PART_CHARS = 8192
export const CONVERSATION_INPUT_WRITE_BYTES = 64 * 1024
export const conversationInputWriteSchema = z
  .discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('begin'),
      sessionId: z.string().uuid(),
      clientMessageId: z.string().uuid(),
    }),
    z.strictObject({
      type: z.literal('append'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
      offset: z.number().int().nonnegative(),
      text: z.string().min(1).max(CONVERSATION_INPUT_PART_CHARS),
    }),
    z.strictObject({
      type: z.literal('seal'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
    }),
    z.strictObject({
      type: z.literal('release'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
    }),
  ])
  .refine(
    (input) =>
      conversationPatchTextEncoder.encode(JSON.stringify(input)).byteLength <=
      CONVERSATION_INPUT_WRITE_BYTES,
    'Input write exceeds its transport budget.',
  )
export type ConversationInputWrite = z.infer<typeof conversationInputWriteSchema>
export const conversationInputStateSchema = z.strictObject({
  inputId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  sealed: z.boolean(),
  bytes: z.number().int().nonnegative(),
  chars: z.number().int().nonnegative(),
})
export type ConversationInputState = z.infer<typeof conversationInputStateSchema>

export const conversationSendInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    clientMessageId: z.string().uuid(),
    returnedInputOperationId: z.string().uuid().optional(),
    queueReturnOperationId: z.string().uuid().optional(),
    inputId: z.string().uuid().optional(),
    imageIds: z.array(z.string().uuid()).max(128).optional(),
    skills: skillSelectionsSchema.optional(),
    content: z.string().trim(),
    planningAction: z.enum(['maintain_plan', 'review_plan']).optional(),
    batchId: z.string().uuid().optional(),
    freezeDrafts: z.boolean().optional(),
    expectedCommentsRevision: z.number().int().nonnegative(),
    commentIds: z.array(z.string().uuid()).default([]),
    route: z
      .discriminatedUnion('type', [
        z.strictObject({ type: z.literal('primary') }),
        z.strictObject({ type: z.literal('agent'), agentId: runtimeAgentIdSchema }),
        z.strictObject({ type: z.literal('all') }),
      ])
      .optional(),
  })
  .superRefine((input, context) => {
    if (
      !input.content &&
      !input.inputId &&
      !input.imageIds?.length &&
      input.commentIds.length === 0 &&
      !input.freezeDrafts
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A message or Comment is required.',
        path: ['content'],
      })
    }
    if (input.inputId && input.content)
      context.addIssue({
        code: 'custom',
        message: 'Use either sealed input or inline content.',
        path: ['inputId'],
      })
    if (new Set(input.commentIds).size !== input.commentIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Comment IDs must be unique.',
        path: ['commentIds'],
      })
    }
  })
export type ConversationSendInput = z.infer<typeof conversationSendInputSchema>
export const collaborationReceivedMetadataSchema = z.strictObject({
  steerSkillInvocation: collaborationDocumentSchema.optional(),
  workflowCommand: z.boolean().default(false),
  skills: skillSelectionsSchema.default([]),
  imageIds: conversationSendInputSchema.shape.imageIds.default([]),
  commentIds: conversationSendInputSchema.shape.commentIds,
  route: conversationSendInputSchema.shape.route,
  planningAction: conversationSendInputSchema.shape.planningAction,
  batchId: conversationSendInputSchema.shape.batchId,
  freezeDrafts: conversationSendInputSchema.shape.freezeDrafts,
})

export const peerProposalAcceptInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  proposalId: z.string().uuid(),
  clientMessageId: z.string().uuid(),
})
export type PeerProposalAcceptInput = z.infer<typeof peerProposalAcceptInputSchema>

export const peerProposalDismissInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  proposalId: z.string().uuid(),
})
export type PeerProposalDismissInput = z.infer<typeof peerProposalDismissInputSchema>

export const conversationRetryInputSchema = z.strictObject({
  runId: z.string().uuid(),
  intent: z.literal('inspect').optional(),
  sessionId: z.string().uuid().optional(),
  agentId: runtimeAgentIdSchema.optional(),
})
export type ConversationRetryInput = z.infer<typeof conversationRetryInputSchema>

export const conversationStopInputSchema = z.strictObject({ sessionId: z.string().uuid() })
export type ConversationStopInput = z.infer<typeof conversationStopInputSchema>

export const nativeContextRebuildInputSchema = z.strictObject({
  sessionId: z.string().uuid(),
  agentId: runtimeAgentIdSchema,
  clientOperationId: z.string().uuid().optional(),
  expectedGeneration: z.number().int().positive().optional(),
  expectedNativeSessionId: z.string().min(1).max(1024).optional(),
  expectedRunId: z.string().uuid().nullable().optional(),
  expectedRebuildId: z.string().uuid().nullable().optional(),
  abandon: z.boolean().optional(),
  intent: z.enum(['create', 'inspect', 'claim_input', 'discard_input']).optional(),
  expectedCommentsRevision: z.number().int().nonnegative().optional(),
})
export type NativeContextRebuildInput = z.infer<typeof nativeContextRebuildInputSchema>

export const nativeContextRebuildChunkSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    image: conversationImageSchema,
  }),
  z.strictObject({
    kind: z.literal('message'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    speaker: z.enum(['user', 'claude', 'codex']),
    state: z.enum(['complete', 'incomplete']),
    part: z.number().int().nonnegative(),
    final: z.boolean(),
    content: z.string().max(64 * 1024),
  }),
  z.strictObject({
    kind: z.literal('comment'),
    messageId: z.string().uuid(),
    sequence: z.number().int().nonnegative(),
    comment: anchoredCommentSchema.pick({ id: true, body: true, anchor: true }),
  }),
])
export type NativeContextRebuildChunk = z.infer<typeof nativeContextRebuildChunkSchema>

export const projectFileReadInputSchema = z
  .strictObject({
    sessionId: z.string().uuid(),
    path: z.string().min(1).max(4096),
    lineStart: z.number().int().positive().optional(),
    lineEnd: z.number().int().positive().optional(),
  })
  .refine(
    (input) =>
      input.lineStart === undefined ||
      input.lineEnd === undefined ||
      input.lineEnd >= input.lineStart,
    { message: 'Line range is invalid.', path: ['lineEnd'] },
  )
export type ProjectFileReadInput = z.infer<typeof projectFileReadInputSchema>

export const projectFileSchema = z.strictObject({
  sessionId: z.string().uuid(),
  relativePath: z.string().min(1),
  absolutePath: z.string().min(1),
  isExternal: z.boolean().optional(),
  content: z.string(),
  contentHash: z.string().regex(/^[a-f\d]{64}$/iu),
  lineCount: z.number().int().nonnegative(),
  lineStart: z.number().int().positive().optional(),
  lineEnd: z.number().int().positive().optional(),
  updatedAt: z.string().datetime(),
})
export type ProjectFile = z.infer<typeof projectFileSchema>

export const workspaceChangeFilePreviewSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('available'),
      changeSetId: z.string().uuid(),
      side: z.enum(['before', 'after', 'patch']),
      patchIndex: z.number().int().min(0).max(63).optional(),
      file: projectFileSchema,
      patchCount: z.number().int().min(0).max(64),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      changeSetId: z.string().uuid(),
      side: z.enum(['before', 'after', 'patch']),
      patchIndex: z.number().int().min(0).max(63).optional(),
      sessionId: z.string().uuid(),
      relativePath: z.string().min(1).max(4096),
      reason: z.enum([
        'not_recorded',
        'not_final',
        'blob_missing',
        'blob_corrupt',
        'too_large',
        'unsupported_encoding',
        'temporary_io',
      ]),
      patchCount: z.number().int().min(0).max(64),
    }),
  ])
  .refine(
    (preview) =>
      new TextEncoder().encode(JSON.stringify(preview)).byteLength <= WORKSPACE_PREVIEW_BYTES,
    'Saved preview exceeds its serialized byte limit.',
  )
export type WorkspaceChangeFilePreview = z.infer<typeof workspaceChangeFilePreviewSchema>

export const appearanceThemeSchema = z.enum(['system', 'light', 'dark'])
export type AppearanceTheme = z.infer<typeof appearanceThemeSchema>

export const windowMaterialSchema = z.enum(['system', 'solid', 'translucent'])
export type WindowMaterial = z.infer<typeof windowMaterialSchema>

export const MATERIAL_OPACITY_MIN = 70
export const MATERIAL_OPACITY_MAX = 100
export const materialOpacitySchema = z
  .number()
  .int()
  .min(MATERIAL_OPACITY_MIN)
  .max(MATERIAL_OPACITY_MAX)

export const appearanceSettingsSchema = z.object({
  theme: appearanceThemeSchema,
  windowMaterial: windowMaterialSchema,
  materialOpacity: materialOpacitySchema,
  revision: z.number().int().nonnegative(),
})
export type AppearanceSettings = z.infer<typeof appearanceSettingsSchema>

export const appearanceSettingsUpdateSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    theme: appearanceThemeSchema.optional(),
    windowMaterial: windowMaterialSchema.optional(),
    materialOpacity: materialOpacitySchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      value.theme === undefined &&
      value.windowMaterial === undefined &&
      value.materialOpacity === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Appearance update must change at least one setting.',
      })
    }
  })
export type AppearanceSettingsUpdate = z.infer<typeof appearanceSettingsUpdateSchema>

export const appearanceSettingsResetSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
})
export type AppearanceSettingsReset = z.infer<typeof appearanceSettingsResetSchema>

export const appearanceFallbackReasonSchema = z.enum([
  'native_material_not_supported',
  'reduced_transparency',
  'high_contrast',
  'forced_colors',
  'native_material_initialization_failed',
])
export type AppearanceFallbackReason = z.infer<typeof appearanceFallbackReasonSchema>

export const appearanceEffectiveSettingsSchema = z.object({
  theme: z.enum(['light', 'dark']),
  windowMaterial: z.enum(['solid', 'translucent']),
  fallbackReason: appearanceFallbackReasonSchema.optional(),
  restartRequired: z.boolean().optional(),
  revision: z.number().int().nonnegative(),
})
export type AppearanceEffectiveSettings = z.infer<typeof appearanceEffectiveSettingsSchema>

export const appearanceSnapshotSchema = z.object({
  requested: appearanceSettingsSchema,
  effective: appearanceEffectiveSettingsSchema,
  projectionVersion: z.number().int().nonnegative(),
})
export type AppearanceSnapshot = z.infer<typeof appearanceSnapshotSchema>

export const utilityRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('updates.get.request'), requestId: z.string().uuid() }),
  z.strictObject({ type: z.literal('updates.check.request'), requestId: z.string().uuid() }),
  z.strictObject({
    type: z.literal('updates.preferences.request'),
    requestId: z.string().uuid(),
    input: updatePreferencesInputSchema,
  }),
  z.strictObject({
    type: z.literal('updates.notice.request'),
    requestId: z.string().uuid(),
    input: updateNoticeInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.prepare.request'),
    requestId: z.string().uuid(),
    input: workspaceArchivePrepareInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.read.request'),
    requestId: z.string().uuid(),
    input: workspaceArchiveOperationInputSchema,
  }),
  z.strictObject({
    type: z.literal('workspace-archive.cancel.request'),
    requestId: z.string().uuid(),
    input: workspaceArchiveOperationInputSchema,
  }),
  z.object({
    type: z.literal('skill-document.read.request'),
    requestId: z.string().uuid(),
    input: skillDocumentReadSchema,
  }),
  z.object({
    type: z.literal('skill-document.cancel.request'),
    requestId: z.string().uuid(),
    input: z.object({ requestId: z.string().uuid() }),
  }),
  z.object({
    type: z.literal('session.fork.request'),
    requestId: z.string().uuid(),
    input: sessionForkInputSchema,
  }),
  z.object({
    type: z.literal('conversation.interests.request'),
    requestId: z.string().uuid(),
    input: conversationInterestsSchema,
  }),
  z.object({ type: z.literal('runtime.shutdown.request'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('native-presence.read.request'), requestId: z.string().uuid() }),
  z.object({
    type: z.literal('native-attention.read.request'),
    requestId: z.string().uuid(),
    input: nativeAttentionReadInputSchema,
  }),
  z.object({
    type: z.literal('native-session.resolve.request'),
    requestId: z.string().uuid(),
    input: nativeSessionResolveInputSchema,
  }),
  z.object({
    type: z.literal('native-session.opened.request'),
    requestId: z.string().uuid(),
    input: nativeSessionOpenInputSchema,
  }),
  z.object({
    type: z.literal('native-jump-list.suppression.request'),
    requestId: z.string().uuid(),
    input: nativeJumpListSuppressionInputSchema,
  }),
  z.object({
    type: z.literal('native-quit.prepare.request'),
    requestId: z.string().uuid(),
    input: nativeQuitOperationInputSchema,
  }),
  z.object({
    type: z.literal('native-quit.cancel.request'),
    requestId: z.string().uuid(),
    input: nativeQuitOperationInputSchema,
  }),
  z.object({
    type: z.literal('runtime.health.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('comment-draft.save.request'),
    requestId: z.string().uuid(),
    input: commentDraftSaveInputSchema,
  }),
  z.object({
    type: z.literal('comment-draft.remove.request'),
    requestId: z.string().uuid(),
    input: commentDraftRemoveInputSchema,
  }),
  z.object({
    type: z.literal('comment-source.resolve.request'),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    commentId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('appearance.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('appearance.update.request'),
    requestId: z.string().uuid(),
    input: appearanceSettingsUpdateSchema,
  }),
  z.object({
    type: z.literal('appearance.reset.request'),
    requestId: z.string().uuid(),
    input: appearanceSettingsResetSchema,
  }),
  z.object({
    type: z.literal('runtime-preparation.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('runtime-preparation.path.update.request'),
    requestId: z.string().uuid(),
    input: runtimeExecutablePathUpdateSchema,
  }),
  z.object({
    type: z.literal('default-session-settings.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('default-session-settings.save.request'),
    requestId: z.string().uuid(),
    input: defaultSessionSettingsSaveInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.get.request'),
    requestId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('project-context.read.request'),
    requestId: z.string().uuid(),
    input: projectContextInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.add.request'),
    requestId: z.string().uuid(),
    input: projectDirectoryAddInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.archive.request'),
    requestId: z.string().uuid(),
    input: projectArchiveInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.restore.request'),
    requestId: z.string().uuid(),
    input: projectArchiveInputSchema,
  }),
  z.object({
    type: z.literal('project-catalog.rename.request'),
    requestId: z.string().uuid(),
    input: projectNameChangeSchema,
  }),
  z.object({
    type: z.literal('session-catalog.get.request'),
    requestId: z.string().uuid(),
    input: sessionCatalogPageInputSchema,
  }),
  z.object({
    type: z.literal('session-creation.prepare.request'),
    requestId: z.string().uuid(),
    input: sessionCreationPrepareInputSchema,
  }),
  z.object({
    type: z.literal('session.create.request'),
    requestId: z.string().uuid(),
    input: sessionCreateInputSchema,
  }),
  z.object({
    type: z.literal('session.rename.request'),
    requestId: z.string().uuid(),
    input: sessionRenameInputSchema,
  }),
  z.object({
    type: z.literal('session.mark-read.request'),
    requestId: z.string().uuid(),
    input: sessionMarkReadInputSchema,
  }),
  z.object({
    type: z.literal('session.archive.request'),
    requestId: z.string().uuid(),
    input: sessionArchiveInputSchema,
  }),
  z.object({
    type: z.literal('session.restore.request'),
    requestId: z.string().uuid(),
    input: sessionArchiveInputSchema,
  }),
  z.object({
    type: z.literal('session-settings.get.request'),
    requestId: z.string().uuid(),
    input: sessionSettingsInputSchema,
  }),
  z.object({
    type: z.literal('session-settings.save.request'),
    requestId: z.string().uuid(),
    input: sessionSettingsSaveInputSchema,
  }),
  z.object({
    type: z.literal('session-permission.save.request'),
    requestId: z.string().uuid(),
    input: sessionPermissionSaveInputSchema,
  }),
  z.object({
    type: z.literal('session-speed.save.request'),
    requestId: z.string().uuid(),
    input: sessionSpeedSaveInputSchema,
  }),
  z.object({
    type: z.literal('skills.cancel.request'),
    requestId: z.string().uuid(),
    input: z.object({ sessionId: z.string().uuid() }),
  }),
  z.object({
    type: z.literal('skills.read.request'),
    requestId: z.string().uuid(),
    input: skillCatalogReadSchema,
  }),
  z.object({
    type: z.literal('conversation.image.write.request'),
    requestId: z.string().uuid(),
    input: imageWriteInputSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.image.choose.request'),
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    paths: z.array(z.string().min(1).max(4096)).max(128),
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.image.read.request'),
    requestId: z.string().uuid(),
    input: imageReadInputSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.input.request'),
    requestId: z.string().uuid(),
    input: conversationInputWriteSchema,
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.input.release-owner.request'),
    requestId: z.string().uuid(),
    ownerKey: z.string().uuid(),
  }),
  z.object({
    type: z.literal('conversation.get.request'),
    requestId: z.string().uuid(),
    input: conversationGetInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.steer.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.return.request'),
    requestId: z.string().uuid(),
    input: conversationQueueReturnInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.remove.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.resume.request'),
    requestId: z.string().uuid(),
    input: conversationQueueActionInputSchema,
  }),
  z.object({
    type: z.literal('conversation.queue.enabled.request'),
    requestId: z.string().uuid(),
    input: conversationQueueEnabledInputSchema,
  }),
  z.object({
    type: z.literal('conversation.send.request'),
    requestId: z.string().uuid(),
    input: conversationSendInputSchema,
    ownerKey: z.string().uuid().optional(),
  }),
  z.object({
    type: z.literal('collaboration.action.request'),
    requestId: z.string().uuid(),
    input: collaborationActionInputSchema,
  }),
  z.object({
    type: z.literal('peer-proposal.accept.request'),
    requestId: z.string().uuid(),
    input: peerProposalAcceptInputSchema,
  }),
  z.object({
    type: z.literal('peer-proposal.dismiss.request'),
    requestId: z.string().uuid(),
    input: peerProposalDismissInputSchema,
  }),
  z.object({
    type: z.literal('conversation.retry.request'),
    requestId: z.string().uuid(),
    input: conversationRetryInputSchema,
  }),
  z.object({
    type: z.literal('native-permission.respond.request'),
    requestId: z.string().uuid(),
    input: nativePermissionRespondInputSchema,
  }),
  z.object({
    type: z.literal('native-input.read.request'),
    requestId: z.string().uuid(),
    input: nativeInputReadSchema,
  }),
  z.object({
    type: z.literal('native-input.respond.request'),
    requestId: z.string().uuid(),
    input: nativeInputRespondSchema,
  }),
  z.object({
    type: z.literal('native-input.opened.request'),
    requestId: z.string().uuid(),
    input: nativeInputReadSchema,
  }),
  z.object({
    type: z.literal('conversation.stop.request'),
    requestId: z.string().uuid(),
    input: conversationStopInputSchema,
  }),
  z.object({
    type: z.literal('native-context.rebuild.request'),
    requestId: z.string().uuid(),
    input: nativeContextRebuildInputSchema,
  }),
  z.object({
    type: z.literal('project-file.read.request'),
    requestId: z.string().uuid(),
    input: projectFileReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.read.request'),
    requestId: z.string().uuid(),
    input: workspaceChangesReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.file-read.request'),
    requestId: z.string().uuid(),
    input: workspaceChangeFileReadInputSchema,
  }),
  z.object({
    type: z.literal('workspace-changes.undo.request'),
    requestId: z.string().uuid(),
    input: workspaceChangesUndoInputSchema,
  }),
])

export type UtilityRequest = z.infer<typeof utilityRequestSchema>

export const utilityResponseSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('updates.state.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(updateStoredStateSchema),
  }),
  z.strictObject({
    type: z.literal('updates.notice.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(updateNoticeResultSchema),
  }),
  z.strictObject({
    type: z.literal('workspace-archive.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceArchivePreviewSchema),
  }),
  z.strictObject({
    type: z.literal('workspace-archive.receipt.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceArchiveReceiptSchema),
  }),
  z.object({
    type: z.literal('skill-document.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(skillDocumentSchema),
  }),
  z.object({
    type: z.literal('skill-document.cancel.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('session.fork.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionForkResultSchema),
  }),
  z.object({
    type: z.literal('native-input.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeInteractionDetailsSchema),
  }),
  z.object({
    type: z.literal('conversation.interests.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('runtime.shutdown.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ flushed: z.literal(true) })),
  }),
  z.object({
    type: z.literal('native-presence.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativePresenceSnapshotSchema),
  }),
  z.object({
    type: z.literal('native-attention.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeAttentionPageSchema),
  }),
  z.object({
    type: z.literal('native-session.resolve.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionCatalogChangeSchema),
  }),
  z.object({
    type: z.literal('native-session.opened.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeSessionOpenedResultSchema),
  }),
  z.object({
    type: z.literal('native-jump-list.suppression.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeJumpListSuppressionResultSchema),
  }),
  z.object({
    type: z.literal('native-quit.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeQuitPreparationSchema),
  }),
  z.object({
    type: z.literal('native-quit.cancel.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(nativeQuitCancelledResultSchema),
  }),
  z.object({
    type: z.literal('runtime.health.response'),
    requestId: z.string().uuid(),
    health: runtimeHealthSchema,
  }),
  z.object({
    type: z.literal('comment-source.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(commentSourceResolutionSchema),
  }),
  z.object({
    type: z.literal('appearance.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(appearanceSettingsSchema),
  }),
  z.object({
    type: z.literal('runtime-preparation.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(runtimePreparationSchema),
  }),
  z.object({
    type: z.literal('default-session-settings.get.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('default-session-settings.save.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsStateSchema),
  }),
  z.object({
    type: z.literal('project-catalog.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectCatalogStateSchema),
  }),
  z.object({
    type: z.literal('project-context.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectContextSchema),
  }),
  z.object({
    type: z.literal('project-catalog.rename.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectNameChangeSchema),
  }),
  z.object({
    type: z.literal('session-catalog.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionCatalogReplySchema),
  }),
  z.object({
    type: z.literal('session-creation.prepare.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(defaultSessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('session-settings.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionSettingsEditorStateSchema),
  }),
  z.object({
    type: z.literal('session-settings.save.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(sessionSettingsSaveResultSchema),
  }),
  z.object({
    type: z.literal('skills.page.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(skillCatalogPageSchema),
  }),
  z.object({
    type: z.literal('conversation.image.write.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(imageWriteStateSchema),
  }),
  z.object({
    type: z.literal('conversation.image.choose.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationImagesSchema),
  }),
  z.object({
    type: z.literal('conversation.image.read.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(imageReadPartSchema),
  }),
  z.object({
    type: z.literal('conversation.input.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationInputStateSchema),
  }),
  z.object({
    type: z.literal('conversation.input.release-owner.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(z.object({ ready: z.literal(true) })),
  }),
  z.object({
    type: z.literal('conversation.page.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationPageSchema),
  }),
  z.object({
    type: z.literal('conversation.patch.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(conversationPatchSchema),
  }),
  z.object({
    type: z.literal('project-file.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(projectFileSchema),
  }),
  z.object({
    type: z.literal('workspace-changes.response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceChangesPageSchema),
  }),
  z.object({
    type: z.literal('workspace-changes.file-response'),
    requestId: z.string().uuid(),
    result: rpcResultSchema(workspaceChangeFilePreviewSchema),
  }),
])

export type UtilityResponse = z.infer<typeof utilityResponseSchema>

export const runtimeStartupFailureSchema = z.strictObject({
  type: z.literal('runtime.startup-failed.event'),
  failureId: z.string().uuid(),
  stage: z.enum(['persistence', 'runtime']),
  code: z.enum([
    'DATABASE_IN_USE',
    'DATABASE_INCOMPATIBLE',
    'DATABASE_BACKUP_FAILED',
    'DATABASE_MIGRATION_FAILED',
    'DATABASE_STORAGE_FAILED',
  ]),
  reason: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z-]+$/u),
  dataFilePath: z.string().min(1).max(4096),
  backupFilePath: z.string().min(1).max(4096).optional(),
  partialBackupFilePath: z.string().min(1).max(4096).optional(),
  stagingFilePath: z.string().min(1).max(4096).optional(),
})
export type RuntimeStartupFailure = z.infer<typeof runtimeStartupFailureSchema>
export const runtimeStartupFailureAckSchema = z.strictObject({
  type: z.literal('runtime.startup-failed.ack'),
  failureId: z.string().uuid(),
})

export const utilityEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('runtime.ready.event') }),
  z.strictObject({
    type: z.literal('native-presence.quit-recent.event'),
    version: nativePresenceVersionSchema,
    sessions: z.array(nativeSessionRowSchema).max(NATIVE_MENU_ITEMS),
  }),
  z.strictObject({
    type: z.literal('native-presence.changed.event'),
    version: nativePresenceVersionSchema,
  }),
  runtimeStartupFailureSchema,
  z.strictObject({
    type: z.literal('conversation.patch.event'),
    patch: conversationPatchSchema,
    progress: z.boolean(),
  }),
])
export type UtilityEvent = z.infer<typeof utilityEventSchema>

export interface DesktopBridge {
  getUpdateState(): Promise<RpcResult<UpdateState>>
  checkForUpdates(): Promise<RpcResult<UpdateState>>
  setUpdatePreferences(input: UpdatePreferencesInput): Promise<RpcResult<UpdateState>>
  claimUpdateNotice(input: { version: string }): Promise<RpcResult<{ claimed: boolean }>>
  onUpdateStateChanged(listener: (state: UpdateState) => void): () => void
  resolveNativeSession(input: NativeSessionResolveInput): Promise<RpcResult<SessionCatalogChange>>
  recordNativeSessionOpened(input: NativeSessionOpenInput): Promise<RpcResult<{ recorded: true }>>
  readNativeAttention(input: NativeAttentionReadInput): Promise<RpcResult<NativeAttentionPage>>
  onNativePresenceChanged(listener: (version: NativePresenceVersion) => void): () => void
  getNativeNavigation(): Promise<RpcResult<NativeNavigationIntent | null>>
  acknowledgeNativeNavigation(
    input: NativeNavigationAckInput,
  ): Promise<RpcResult<{ acknowledged: true }>>
  onNativeNavigationChanged(listener: (intent: NativeNavigationIntent) => void): () => void
  getNativeQuitState(): Promise<RpcResult<NativeQuitState | null>>
  onNativeQuitStateChanged(listener: (state: NativeQuitState | null) => void): () => void
  respondNativeQuit(input: NativeQuitDecisionInput): Promise<RpcResult<{ accepted: true }>>
  prepareWorkspaceArchive(
    input: WorkspaceArchivePrepareInput,
  ): Promise<RpcResult<WorkspaceArchivePreview>>
  readWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  cancelWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  /** Fixture-only scalar observation; local Preload counters, never generic IPC or business DTOs. */
  observeMonacoWorkerTraffic?(this: void, observation: MonacoIpcObservation): void
  getDiagnosticStatus?(): Promise<DiagnosticStatus>
  onDiagnosticStatusChanged?(listener: (status: DiagnosticStatus) => void): () => void
  reportRendererFault?(fault: RendererFault): void
  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>>
  saveSessionPermission(input: SessionPermissionSaveInput): Promise<RpcResult<SessionCatalogChange>>
  saveSessionSpeed(input: SessionSpeedSaveInput): Promise<RpcResult<SessionCatalogChange>>
  readNativeInput(input: NativeInputRead): Promise<RpcResult<NativeInteractionDetails>>
  respondNativeInput(input: NativeInputRespond): Promise<RpcResult<ConversationPatch>>
  openNativeInputURL(input: NativeInputRead): Promise<RpcResult<{ opened: true }>>
  respondNativePermission(
    input: NativePermissionRespondInput,
  ): Promise<RpcResult<ConversationPatch>>
  getAppInfo(): Promise<RpcResult<AppInfo>>
  getRuntimeHealth(): Promise<RpcResult<RuntimeHealth>>
  getRuntimePreparation(): Promise<RpcResult<RuntimePreparation>>
  chooseRuntimeExecutable(agentId: RuntimeAgentId): Promise<RpcResult<RuntimePreparation>>
  getDefaultSessionSettingsEditorState(): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  saveDefaultSessionSettings(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>>
  getProjectCatalog(): Promise<RpcResult<ProjectCatalogState>>
  readProjectContext(input: ProjectContextInput): Promise<RpcResult<ProjectContext>>
  openProjectDirectory(input: ProjectContextInput): Promise<RpcResult<{ opened: true }>>
  chooseAndAddProject(): Promise<RpcResult<ProjectCatalogState>>
  archiveProject(projectId: string, operationId?: string): Promise<RpcResult<ProjectCatalogState>>
  restoreProject(projectId: string): Promise<RpcResult<ProjectCatalogState>>
  renameProject(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>>
  getSessionCatalog(
    projectId: string,
    cursor?: SessionCatalogCursor,
  ): Promise<RpcResult<SessionCatalogPage>>
  prepareSessionCreation(projectId: string): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  createSession(input: SessionCreateInput): Promise<RpcResult<SessionCatalogChange>>
  renameSession(input: SessionRenameInput): Promise<RpcResult<SessionCatalogChange>>
  markSessionRead(input: SessionMarkReadInput): Promise<RpcResult<SessionCatalogChange>>
  archiveSession(sessionId: string, operationId?: string): Promise<RpcResult<SessionCatalogChange>>
  restoreSession(sessionId: string): Promise<RpcResult<SessionCatalogChange>>
  getSessionSettings(sessionId: string): Promise<RpcResult<SessionSettingsEditorState>>
  saveSessionSettings(
    input: SessionSettingsSaveInput,
  ): Promise<RpcResult<SessionSettingsSaveResult>>
  cancelSkillCatalog(sessionId: string): Promise<RpcResult<{ ready: true }>>
  setComposerEditingState(
    input: import('./skills.js').ComposerEditingState,
  ): Promise<RpcResult<{ ready: true }>>
  onComposerEditCommand(
    listener: (command: import('./skills.js').ComposerEditCommand) => void,
  ): () => void
  settleComposerEdit(
    input: import('./skills.js').ComposerEditReceipt,
  ): Promise<RpcResult<{ ready: true }>>
  readSkillDocument(
    input: import('./skills.js').SkillDocumentRead,
  ): Promise<RpcResult<import('./skills.js').SkillDocument>>
  cancelSkillDocument(requestId: string): Promise<RpcResult<{ ready: true }>>
  readSkillCatalog(
    input: import('./skills.js').SkillCatalogRead,
  ): Promise<RpcResult<import('./skills.js').SkillCatalogPage>>
  actOnCollaboration(
    input: import('./collaboration.js').CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  getConversation(input: ConversationGetInput): Promise<RpcResult<ConversationPage>>
  setConversationInterest(
    sessionId: string | null,
    generation: number,
  ): Promise<RpcResult<{ ready: true }>>
  writeConversationImage(
    input: import('./images.js').ImageWriteInput,
  ): Promise<RpcResult<import('./images.js').ImageWriteState>>
  chooseConversationImages(
    input: import('./images.js').ImageChooseInput,
  ): Promise<RpcResult<import('./images.js').ConversationImage[]>>
  readConversationImage(
    input: import('./images.js').ImageReadInput,
  ): Promise<RpcResult<import('./images.js').ImageReadPart>>
  writeConversationInput(input: ConversationInputWrite): Promise<RpcResult<ConversationInputState>>
  steerQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  returnQueuedConversationMessage(
    input: ConversationQueueReturnInput,
  ): Promise<RpcResult<ConversationPatch>>
  removeQueuedConversationMessage(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  resumeConversationQueue(
    input: ConversationQueueActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  setConversationQueueEnabled(
    input: ConversationQueueEnabledInput,
  ): Promise<RpcResult<ConversationPatch>>
  sendConversationMessage(input: ConversationSendInput): Promise<RpcResult<ConversationPatch>>
  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>>
  dismissPeerProposal(input: PeerProposalDismissInput): Promise<RpcResult<ConversationPatch>>
  saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>>
  removeCommentDraft(input: CommentDraftRemoveInput): Promise<RpcResult<ConversationPatch>>
  resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>>
  retryConversationRun(
    runId: string,
    options?: Omit<ConversationRetryInput, 'runId'>,
  ): Promise<RpcResult<ConversationPatch>>
  stopConversation(input: ConversationStopInput): Promise<RpcResult<ConversationPatch>>
  rebuildNativeContext(input: NativeContextRebuildInput): Promise<RpcResult<ConversationPatch>>
  onConversationChanged(listener: (patch: ConversationPatch) => void): () => void
  readProjectFile(input: ProjectFileReadInput): Promise<RpcResult<ProjectFile>>
  readWorkspaceChanges(input: WorkspaceChangesReadInput): Promise<RpcResult<WorkspaceChangesPage>>
  readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>>
  undoWorkspaceChanges(input: WorkspaceChangesUndoInput): Promise<RpcResult<ConversationPatch>>
  getAppearanceSettings(): Promise<RpcResult<AppearanceSnapshot>>
  updateAppearanceSettings(input: AppearanceSettingsUpdate): Promise<RpcResult<AppearanceSnapshot>>
  resetAppearanceSettings(input: AppearanceSettingsReset): Promise<RpcResult<AppearanceSnapshot>>
  onAppearanceSettingsChanged(listener: (snapshot: AppearanceSnapshot) => void): () => void
}
