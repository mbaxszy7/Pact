import { z } from 'zod'

import { conversationStreamTraceSchema } from './conversation-stream-diagnostics.js'

export const CONVERSATION_INTEREST_ITEMS = 8
export const IPC_CHANNELS = {
  nativeSessionResolve: 'pact:native-session:resolve',
  nativeSessionOpened: 'pact:native-session:opened',
  nativeAttentionRead: 'pact:native-attention:read',
  nativePresenceChanged: 'pact:native-presence:changed',
  sessionReminderChanged: 'pact:session-reminder:changed',
  sessionReminderView: 'pact:session-reminder:view',
  sessionReminderDismiss: 'pact:session-reminder:dismiss',
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
  providerUsageGet: 'pact:provider-usage:get',
  providerUsageRefresh: 'pact:provider-usage:refresh',
  providerUsageCancel: 'pact:provider-usage:cancel',
  schedulingSettingsGet: 'pact:scheduling:settings:get',
  schedulingSettingsSave: 'pact:scheduling:settings:save',
  schedulingStateGet: 'pact:scheduling:state:get',
  schedulingActivityRead: 'pact:scheduling:activity:read',
  relayCredentialSave: 'pact:relay:credential:save',
  relayCredentialRemove: 'pact:relay:credential:remove',
  relayCredentialReceiptRead: 'pact:relay:credential:receipt:read',
  relayCredentialReveal: 'pact:relay:credential:reveal',
  schedulingChanged: 'pact:scheduling:changed',
  defaultSessionSettingsSave: 'pact:default-session-settings:save',
  projectCatalogGet: 'pact:project-catalog:get',
  projectCatalogChooseAndAdd: 'pact:project-catalog:choose-and-add',
  projectCatalogArchive: 'pact:project-catalog:archive',
  projectCatalogRestore: 'pact:project-catalog:restore',
  projectCatalogRename: 'pact:project-catalog:rename',
  projectContextRead: 'pact:project-context:read',
  projectDirectoryOpen: 'pact:project-directory:open',
  sessionCatalogGet: 'pact:session-catalog:get',
  sessionPageGet: 'pact:session-page:get',
  sessionGroupsGet: 'pact:session-groups:get',
  sessionGroupGet: 'pact:session-group:get',
  sessionMembershipGet: 'pact:session-membership:get',
  sessionNavigationLocate: 'pact:session-navigation:locate',
  sessionCreationState: 'pact:session-creation:state',
  sessionOrganizationRecover: 'pact:session-organization:recover',
  sessionGroupCreate: 'pact:session-group:create',
  sessionGroupUpdate: 'pact:session-group:update',
  sessionGroupMove: 'pact:session-group:move',
  sessionGroupDissolve: 'pact:session-group:dissolve',
  sessionGroupSet: 'pact:session-group:set',
  sessionCreationPrepare: 'pact:session-creation:prepare',
  sessionCreate: 'pact:session:create',
  sessionRename: 'pact:session:rename',
  sessionMarkRead: 'pact:session:mark-read',
  sessionArchive: 'pact:session:archive',
  sessionRestore: 'pact:session:restore',
  sessionSidebarHiddenSet: 'pact:session-sidebar-hidden:set',
  sessionSettingsGet: 'pact:session-settings:get',
  sessionSettingsSave: 'pact:session-settings:save',
  sessionPermissionSave: 'pact:session-permission:save',
  sessionSpeedSave: 'pact:session-speed:save',
  collaborationAction: 'pact:collaboration:action',
  preparedInputContinue: 'pact:conversation:prepared-input:continue',
  relayDecisionAnswer: 'pact:relay:decision:answer',
  relayDecisionReceiptRead: 'pact:relay:decision:receipt',
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
  sideChatCreate: 'pact:side-chat:create',
  sideChatCreateReceipt: 'pact:side-chat:create-receipt',
  sideChatDiscardEmpty: 'pact:side-chat:discard-empty',
  sideChatList: 'pact:side-chat:list',
  sideChatSyncMain: 'pact:side-chat:sync-main',
  sideChatSyncMainReceipt: 'pact:side-chat:sync-main-receipt',
  terminalList: 'pact:terminal:list',
  terminalCreate: 'pact:terminal:create',
  terminalSubscribe: 'pact:terminal:subscribe',
  terminalUnsubscribe: 'pact:terminal:unsubscribe',
  terminalAckOutput: 'pact:terminal:ack-output',
  terminalReleaseProjectViews: 'pact:terminal:release-project-views',
  terminalWrite: 'pact:terminal:write',
  terminalResize: 'pact:terminal:resize',
  terminalClose: 'pact:terminal:close',
  terminalReadSnapshot: 'pact:terminal:read-snapshot',
  terminalLastExitNotice: 'pact:terminal:last-exit-notice',
  terminalOutput: 'pact:terminal:output',
  terminalState: 'pact:terminal:state',
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
  'utility-terminal': ['utility-terminal.request', 'terminal-utility.reply'],
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
  'utility-terminal',
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
  'utility-terminal.request',
  'terminal-utility.reply',
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
  'utility-terminal-worker',
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
    owners: z.array(ipcTrafficOwnerSnapshotSchema).max(10),
    uncovered: z.array(ipcTrafficUncoveredSchema).max(10),
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
        (value.owners.length === 10 &&
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

export const nativeMemoryCapacitiesSchema = z
  .strictObject({
    businessLimitBytes: z.literal(512 * 1024 * 1024),
    decisionLimitBytes: z.literal(16 * 1024 * 1024),
    combinedLimitBytes: z.literal(528 * 1024 * 1024),
    chargedBytes: z
      .number()
      .int()
      .nonnegative()
      .max(528 * 1024 * 1024),
    business: nativeMemoryDiagnosticsSchema,
    decision: nativeMemoryDiagnosticsSchema,
  })
  .refine(
    (value) =>
      value.business.chargedBytes !== null &&
      value.decision.chargedBytes !== null &&
      value.decision.chargedBytes <= value.decisionLimitBytes &&
      (value.decision.highWaterBytes === null ||
        value.decision.highWaterBytes <= value.decisionLimitBytes) &&
      value.chargedBytes === value.business.chargedBytes + value.decision.chargedBytes,
  )
export type NativeMemoryCapacities = z.infer<typeof nativeMemoryCapacitiesSchema>

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
      nativeMemoryCapacities: nativeMemoryCapacitiesSchema.optional(),
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
      interestedSessionIds: z.array(z.string().uuid()).max(CONVERSATION_INTEREST_ITEMS).optional(),
      streamTraces: z.array(conversationStreamTraceSchema).max(6).optional(),
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
    .refine(
      (value) =>
        !value.interestedSessionIds ||
        (new Set(value.interestedSessionIds).size === value.interestedSessionIds.length &&
          value.interestedSessionIds.length === value.interestedSessions),
      'Interest diagnostics must describe the actual unique membership.',
    )
    .refine(
      (value) =>
        !value.streamTraces ||
        new Set(value.streamTraces.map((trace) => trace.runId)).size === value.streamTraces.length,
      'Stream diagnostics must have unique Run identities.',
    )
    .optional(),
  status: z.literal('ready'),
  database: z.literal('ready'),
  pid: z.number().int().positive(),
  checkedAt: z.string().datetime(),
})

export type RuntimeHealth = z.infer<typeof runtimeHealthSchema>
