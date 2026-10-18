import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const pactSchemaMeta = sqliteTable('pact_schema_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const appearanceSettings = sqliteTable('appearance_settings', {
  id: integer('id').primaryKey(),
  theme: text('theme', { enum: ['system', 'light', 'dark'] }).notNull(),
  windowMaterial: text('window_material', { enum: ['system', 'solid', 'translucent'] }).notNull(),
  materialOpacity: integer('material_opacity').notNull(),
  revision: integer('revision').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const appSetupState = sqliteTable('app_setup_state', {
  id: integer('id').primaryKey(),
  completedAt: text('completed_at'),
})

export const runtimeCliPaths = sqliteTable('runtime_cli_paths', {
  agentId: text('agent_id', { enum: ['claude', 'codex'] }).primaryKey(),
  executablePath: text('executable_path').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const defaultSessionSettings = sqliteTable('default_session_settings', {
  id: integer('id').primaryKey(),
  primaryAgentId: text('primary_agent_id', { enum: ['claude', 'codex'] }).notNull(),
  claudeModel: text('claude_model'),
  claudeEffort: text('claude_effort'),
  claudeSpeed: text('claude_speed', { enum: ['native', 'standard', 'fast'] })
    .notNull()
    .default('native'),
  codexModel: text('codex_model'),
  codexEffort: text('codex_effort'),
  codexSpeed: text('codex_speed', { enum: ['native', 'standard', 'fast'] })
    .notNull()
    .default('native'),
  maxDiscussionRounds: integer('max_discussion_rounds').notNull(),
  runningMessagePolicy: text('running_message_policy', {
    enum: ['immediate_safe_point', 'next_round'],
  }).notNull(),
  maxReviewCycles: integer('max_review_cycles').notNull(),
  maxRepairAttempts: integer('max_repair_attempts').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const sessionCatalogRevisions = sqliteTable('session_catalog_revisions', {
  id: integer('id').primaryKey(),
  revision: integer('revision').notNull(),
})

export const nativePresenceMetadata = sqliteTable('native_presence_metadata', {
  id: integer('id').primaryKey(),
  openingOrdinal: integer('opening_ordinal').notNull().default(0),
  attentionTotal: integer('attention_total').notNull().default(0),
  initialized: integer('initialized', { mode: 'boolean' }).notNull().default(false),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  directoryPath: text('directory_path').notNull().unique(),
  kind: text('kind', { enum: ['git', 'directory'] }).notNull(),
  createdAt: text('created_at').notNull(),
  archivedAt: text('archived_at'),
  needsAttentionCount: integer('needs_attention_count').notNull().default(0),
})

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    titleSource: text('title_source', {
      enum: ['placeholder', 'local', 'agent', 'user'],
    })
      .notNull()
      .default('placeholder'),
    status: text('status', {
      enum: [
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
      ],
    }).notNull(),
    settingsRevision: integer('settings_revision').notNull(),
    lastSeenMessageSequence: integer('last_seen_message_sequence'),
    lastOpenedOrdinal: integer('last_opened_ordinal'),
    workspaceVisible: integer('workspace_visible', { mode: 'boolean' }).notNull().default(true),
    needsAttention: integer('needs_attention', { mode: 'boolean' }).notNull().default(false),
    jumpListSuppressed: integer('jump_list_suppressed', { mode: 'boolean' })
      .notNull()
      .default(false),
    jumpListRemovalObserved: integer('jump_list_removal_observed', { mode: 'boolean' })
      .notNull()
      .default(false),
    queueEnabled: integer('queue_enabled', { mode: 'boolean' }).notNull().default(true),
    queueRevision: integer('queue_revision').notNull().default(0),
    queuePauseReason: text('queue_pause_reason'),
    commentsRevision: integer('comments_revision').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    archivedAt: text('archived_at'),
  },
  (table) => [
    index('sessions_native_recent_idx')
      .on(table.lastOpenedOrdinal, table.id)
      .where(
        sql`${table.workspaceVisible} = 1 AND ${table.needsAttention} = 0 AND ${table.lastOpenedOrdinal} IS NOT NULL`,
      ),
    index('sessions_native_attention_idx')
      .on(table.lastOpenedOrdinal, table.id)
      .where(sql`${table.workspaceVisible} = 1 AND ${table.needsAttention} = 1`),
    index('sessions_project_native_work_idx').on(table.projectId, table.id),
    index('sessions_project_created_id_active_idx')
      .on(table.projectId, table.createdAt, table.id)
      .where(sql`${table.status} <> 'archived'`),
  ],
)

export const sessionOpenOperations = sqliteTable('session_open_operations', {
  openingId: text('opening_id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
})

export const workspaceArchiveOperations = sqliteTable(
  'workspace_archive_operations',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'restrict' }),
    ownerId: text('owner_id').notNull(),
    state: text('state', {
      enum: ['prepared', 'stopping', 'archived', 'cancelled', 'not_archived', 'unresolved'],
    }).notNull(),
    previewJson: text('preview_json').notNull(),
    resultsJson: text('results_json').notNull().default('[]'),
    message: text('message'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('workspace_archive_scope_active_idx')
      .on(table.projectId, table.sessionId)
      .where(sql`${table.state} IN ('stopping', 'unresolved')`),
    index('workspace_archive_owner_prepared_idx')
      .on(table.ownerId)
      .where(sql`${table.state} = 'prepared'`),
  ],
)

export const sessionSettingsRevisions = sqliteTable(
  'session_settings_revisions',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    primaryAgentId: text('primary_agent_id', { enum: ['claude', 'codex'] }).notNull(),
    claudeModel: text('claude_model'),
    claudeEffort: text('claude_effort'),
    claudeSpeed: text('claude_speed', { enum: ['native', 'standard', 'fast'] })
      .notNull()
      .default('native'),
    codexModel: text('codex_model'),
    codexEffort: text('codex_effort'),
    codexSpeed: text('codex_speed', { enum: ['native', 'standard', 'fast'] })
      .notNull()
      .default('native'),
    claudePermissionMode: text('claude_permission_mode', {
      enum: ['native', 'ask', 'auto', 'full'],
    })
      .notNull()
      .default('ask'),
    codexPermissionMode: text('codex_permission_mode', { enum: ['native', 'ask', 'auto', 'full'] })
      .notNull()
      .default('native'),
    maxDiscussionRounds: integer('max_discussion_rounds').notNull(),
    runningMessagePolicy: text('running_message_policy', {
      enum: ['immediate_safe_point', 'next_round'],
    }).notNull(),
    maxReviewCycles: integer('max_review_cycles').notNull(),
    maxRepairAttempts: integer('max_repair_attempts').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.revision] })],
)

export const conversationMessages = sqliteTable(
  'conversation_messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: text('run_id'),
    replyToMessageId: text('reply_to_message_id'),
    isVisible: integer('is_visible', { mode: 'boolean' }).notNull().default(true),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }),
    routeKind: text('route_kind', { enum: ['primary', 'agent', 'all'] }),
    routeAgentsJson: text('route_agents_json'),
    skillInvocationJson: text('skill_invocation_json'),
    routePendingAgentId: text('route_pending_agent_id', { enum: ['claude', 'codex'] }),
    sourceMessageId: text('source_message_id'),
    content: text('content').notNull(),
    contentRevision: integer('content_revision').notNull().default(0),
    state: text('state', { enum: ['complete', 'streaming', 'incomplete'] }).notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('conversation_messages_session_sequence_unique').on(
      table.sessionId,
      table.sequence,
    ),
    index('conversation_messages_session_role_state_sequence_idx').on(
      table.sessionId,
      table.role,
      table.state,
      table.sequence,
    ),
    index('conversation_messages_run_role_idx').on(table.runId, table.role),
    index('conversation_messages_native_complete_idx')
      .on(table.runId, table.id)
      .where(
        sql`${table.role} = 'assistant' AND ${table.isVisible} = 1 AND ${table.state} = 'complete' AND length(${table.content}) > 0`,
      ),
    index('conversation_messages_session_visible_sequence_idx').on(
      table.sessionId,
      table.isVisible,
      table.sequence,
    ),
    uniqueIndex('conversation_messages_visible_reply_unique')
      .on(table.replyToMessageId, table.agentId)
      .where(
        sql`${table.role} = 'assistant' AND ${table.isVisible} = 1 AND ${table.replyToMessageId} IS NOT NULL`,
      ),
    index('conversation_messages_pending_route_idx')
      .on(table.routePendingAgentId, table.sessionId)
      .where(sql`${table.routePendingAgentId} IS NOT NULL`),
  ],
)

/** Presentation cut points; bodies and Comment identity remain ordinary Message sources. */
export const conversationOutputSnapshots = sqliteTable(
  'conversation_output_snapshots',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    afterMessageId: text('after_message_id')
      .notNull()
      .references(() => conversationMessages.id),
    sourceMessageId: text('source_message_id').references(() => conversationMessages.id),
    sourceSequence: integer('source_sequence'),
    afterSequence: integer('after_sequence').notNull().default(0),
    hasBody: integer('has_body', { mode: 'boolean' }).notNull().default(false),
    frozen: integer('frozen', { mode: 'boolean' }).notNull().default(false),
    contextSequence: integer('context_sequence').notNull(),
    contextRank: integer('context_rank').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.ordinal] }),
    uniqueIndex('conversation_output_snapshots_source_unique').on(table.sourceMessageId),
    index('conversation_output_snapshots_session_idx').on(table.sessionId, table.runId),
    index('conversation_output_snapshots_source_order_idx').on(
      table.sessionId,
      table.sourceSequence,
      table.sourceMessageId,
    ),
    index('conversation_output_snapshots_input_order_idx').on(
      table.sessionId,
      table.afterSequence,
      table.runId,
    ),
    index('conversation_output_snapshots_context_order_idx')
      .on(table.sessionId, table.contextSequence, table.runId)
      .where(sql`${table.ordinal}=0`),
  ],
)

export const conversationImageAssets = sqliteTable(
  'conversation_image_assets',
  {
    pendingReceiptId: text('pending_receipt_id'),
    id: text('id').primaryKey(),
    ownerKey: text('owner_key').notNull(),
    ownerSessionId: text('owner_session_id').notNull(),
    name: text('name').notNull(),
    bytes: integer('bytes').notNull().default(0),
    ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
    committed: integer('committed', { mode: 'boolean' }).notNull().default(false),
    mediaType: text('media_type', { enum: ['image/png', 'image/jpeg', 'image/webp'] }),
    width: integer('width'),
    height: integer('height'),
    sha256: text('sha256'),
    thumbnailBytes: integer('thumbnail_bytes').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('conversation_image_assets_owner_temp_idx')
      .on(t.ownerKey)
      .where(sql`${t.committed} = 0`),
    index('conversation_image_assets_temp_idx')
      .on(t.updatedAt)
      .where(sql`${t.committed} = 0`),
  ],
)
export const conversationMessageImages = sqliteTable(
  'conversation_message_images',
  {
    messageId: text('message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    imageId: text('image_id')
      .notNull()
      .references(() => conversationImageAssets.id),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.ordinal] }),
    uniqueIndex('conversation_message_images_unique_idx').on(t.messageId, t.imageId),
    index('conversation_message_images_asset_idx').on(t.imageId),
  ],
)

/** Ordered temporary inputs and sealed answer versions; referenced versions survive cleanup. */
export const conversationBodyInputs = sqliteTable(
  'conversation_body_inputs',
  {
    projectionBasis: text('projection_basis', {
      enum: ['markdown-visible-v2', 'plain-visible-v1'],
    }),
    projectionPages: integer('projection_pages'),
    sourceRunId: text('source_run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    pendingReceiptId: text('pending_receipt_id'),
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    clientMessageId: text('client_message_id').notNull(),
    ownerKey: text('owner_key').notNull(),
    purpose: text('purpose', { enum: ['input', 'answer', 'collaboration'] }).notNull(),
    bytes: integer('bytes').notNull().default(0),
    chars: integer('chars').notNull().default(0),
    parts: integer('parts').notNull().default(0),
    sealed: integer('sealed', { mode: 'boolean' }).notNull().default(false),
    hash: text('hash'),
    committedMessageId: text('committed_message_id').references(() => conversationMessages.id, {
      onDelete: 'cascade',
    }),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('conversation_body_inputs_owner_nonce_idx')
      .on(table.ownerKey, table.sessionId, table.clientMessageId, table.purpose)
      .where(sql`${table.committedMessageId} IS NULL`),
    index('conversation_body_inputs_owner_capacity_idx')
      .on(table.ownerKey, table.bytes, table.parts)
      .where(
        sql`${table.committedMessageId} IS NULL AND ${table.pendingReceiptId} IS NULL AND ${table.sourceRunId} IS NULL`,
      ),
    index('conversation_body_inputs_bytes_idx')
      .on(table.bytes, table.parts)
      .where(
        sql`${table.committedMessageId} IS NULL AND ${table.pendingReceiptId} IS NULL AND ${table.sourceRunId} IS NULL`,
      ),
    index('conversation_body_inputs_unreferenced_expiry_idx')
      .on(table.updatedAt)
      .where(
        sql`${table.committedMessageId} IS NULL AND ${table.pendingReceiptId} IS NULL AND ${table.sourceRunId} IS NULL`,
      ),
  ],
)

export const conversationBodyParts = sqliteTable(
  'conversation_body_parts',
  {
    inputId: text('input_id')
      .notNull()
      .references(() => conversationBodyInputs.id, { onDelete: 'cascade' }),
    offset: integer('offset').notNull(),
    text: text('text').notNull(),
    endBytes: integer('end_bytes').notNull(),
  },
  (table) => [primaryKey({ columns: [table.inputId, table.offset] })],
)

export const anchoredComments = sqliteTable(
  'anchored_comments',
  {
    pendingReceiptId: text('pending_receipt_id'),
    draftRevision: integer('draft_revision').notNull().default(1),
    answerKey: text('answer_key'),
    returnOperationId: text('return_operation_id'),
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    anchorJson: text('anchor_json').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    sentWithMessageId: text('sent_with_message_id').references(() => conversationMessages.id, {
      onDelete: 'restrict',
    }),
    position: integer('position').notNull(),
  },
  (table) => [
    uniqueIndex('anchored_comments_session_position_unique').on(table.sessionId, table.position),
    index('anchored_comments_sent_message_position_idx').on(
      table.sentWithMessageId,
      table.position,
    ),
    index('anchored_comments_message_source_idx')
      .on(table.sessionId, sql`json_extract(${table.anchorJson}, '$.messageId')`)
      .where(sql`json_extract(${table.anchorJson}, '$.type') = 'message'`),
    index('anchored_comments_session_draft_position_idx')
      .on(table.sessionId, table.position)
      .where(sql`${table.sentWithMessageId} IS NULL`),
    index('anchored_comments_active_return_owner_idx')
      .on(table.sessionId, table.returnOperationId)
      .where(sql`${table.sentWithMessageId} IS NULL AND ${table.pendingReceiptId} IS NULL`),
    uniqueIndex('anchored_comments_unsent_answer_unique')
      .on(table.sessionId, table.answerKey)
      .where(
        sql`${table.sentWithMessageId} IS NULL AND ${table.pendingReceiptId} IS NULL AND ${table.answerKey} IS NOT NULL`,
      ),
  ],
)

export const commentDraftReceipts = sqliteTable(
  'comment_draft_receipts',
  {
    requestId: text('request_id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    commentId: text('comment_id').notNull(),
    payloadHash: text('payload_hash').notNull(),
    commentsRevision: integer('comments_revision').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('comment_draft_receipts_session_idx').on(t.sessionId, t.createdAt)],
)

export const agentRuns = sqliteTable(
  'agent_runs',
  {
    collaborationTaskId: text('collaboration_task_id'),
    answerFormat: text('answer_format', {
      enum: ['collaboration_envelope_v5'],
    }),
    collaborationKind: text('collaboration_kind', { enum: ['plan', 'build', 'review'] }),
    collaborationStage: text('collaboration_stage', {
      enum: [
        'draft',
        'discuss',
        'clarify',
        'implement',
        'supplement',
        'review',
        'respond',
        'repair',
      ],
    }),
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userMessageId: text('user_message_id').notNull(),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    status: text('status', {
      enum: ['starting', 'running', 'recovering', 'completed', 'failed', 'interrupted'],
    }).notNull(),
    attemptCount: integer('attempt_count').notNull(),
    settingsRevision: integer('settings_revision').notNull(),
    model: text('model'),
    permissionMode: text('permission_mode', { enum: ['native', 'ask', 'auto', 'full'] })
      .notNull()
      .default('native'),
    effort: text('effort'),
    speed: text('speed', { enum: ['native', 'standard', 'fast'] })
      .notNull()
      .default('native'),
    observedSpeed: text('observed_speed', { enum: ['standard', 'fast'] }),
    speedDetail: text('speed_detail'),
    nativeSessionId: text('native_session_id'),
    nativeTurnId: text('native_turn_id'),
    nativeInputIdsJson: text('native_input_ids_json').notNull().default('[]'),
    forkSourceRunId: text('fork_source_run_id'),
    bindingGeneration: integer('binding_generation').notNull().default(1),
    executorId: text('executor_id'),
    controlDisposition: text('control_disposition', { enum: ['retained', 'abandoned'] })
      .notNull()
      .default('retained'),
    dispatchPhase: text('dispatch_phase', {
      enum: ['not_sent', 'possibly_sent', 'accepted', 'ended', 'rejected'],
    })
      .notNull()
      .default('not_sent'),
    nativeOutcome: text('native_outcome', { enum: ['completed', 'failed', 'interrupted'] }),
    nativeEffectsState: text('native_effects_state', {
      enum: ['not_dispatched', 'pending', 'settled', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    nativeEffectsReason: text('native_effects_reason'),
    workspaceRecordingUnavailableReason: text('workspace_recording_unavailable_reason'),
    reexecutedFromRunId: text('reexecuted_from_run_id'),
    reexecutionOperationId: text('reexecution_operation_id'),
    failureKind: text('failure_kind', {
      enum: [
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
      ],
    }),
    failureMessage: text('failure_message'),
    handoffSourceIds: text('handoff_source_ids').notNull().default('[]'),
    handoffMessageCount: integer('handoff_message_count').notNull().default(0),
    peerProposalId: text('peer_proposal_id'),
    peerProposalTargetAgentId: text('peer_proposal_target_agent_id', {
      enum: ['claude', 'codex'],
    }),
    peerProposalKind: text('peer_proposal_kind', {
      enum: ['supplement', 'fact_check', 'challenge', 'review'],
    }),
    peerProposalReason: text('peer_proposal_reason'),
    peerProposalState: text('peer_proposal_state', {
      enum: ['pending', 'accepted', 'dismissed', 'superseded'],
    }),
    peerProposalAcceptedMessageId: text('peer_proposal_accepted_message_id'),
    workspaceChangesJson: text('workspace_changes_json'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('agent_runs_one_active_per_session')
      .on(table.sessionId)
      .where(
        sql`${table.status} IN ('starting', 'running', 'recovering') AND ${table.controlDisposition} <> 'abandoned'`,
      ),
    index('agent_runs_session_created_idx').on(table.sessionId, table.createdAt),
    index('agent_runs_session_unsettled_work_idx')
      .on(table.sessionId)
      .where(
        sql`(${table.status} IN ('starting', 'running', 'recovering') AND ${table.controlDisposition} <> 'abandoned') OR ${table.nativeEffectsState} IN ('pending', 'unknown')`,
      ),
    index('agent_runs_native_quit_unsettled_idx')
      .on(table.sessionId)
      .where(
        sql`${table.forkSourceRunId} IS NULL AND ((${table.status} IN ('starting', 'running', 'recovering') AND ${table.controlDisposition} <> 'abandoned') OR ${table.nativeEffectsState} IN ('pending', 'unknown') OR (${table.dispatchPhase} IN ('possibly_sent', 'accepted', 'ended') AND ${table.nativeOutcome} IS NULL))`,
      ),
    index('agent_runs_session_agent_generation_idx').on(
      table.sessionId,
      table.agentId,
      table.bindingGeneration,
    ),
    index('agent_runs_native_latest_idx').on(table.sessionId, table.agentId, table.createdAt),
    index('agent_runs_native_generation_latest_idx').on(
      table.sessionId,
      table.agentId,
      table.bindingGeneration,
      table.createdAt,
    ),
    index('agent_runs_native_unacknowledged_idx')
      .on(table.sessionId, table.agentId, table.createdAt)
      .where(
        sql`${table.forkSourceRunId} IS NULL AND ${table.controlDisposition} <> 'abandoned' AND ${table.dispatchPhase} IN ('possibly_sent', 'accepted') AND ${table.status} IN ('failed', 'interrupted', 'recovering') AND ${table.nativeOutcome} IS NULL`,
      ),
    index('agent_runs_user_created_idx').on(table.userMessageId, table.createdAt, table.id),
    index('agent_runs_user_artifacts_idx')
      .on(table.userMessageId, table.agentId, table.createdAt, table.id)
      .where(
        sql`${table.workspaceChangesJson} IS NOT NULL OR ${table.controlDisposition} = 'abandoned'`,
      ),
    uniqueIndex('agent_runs_reexecution_operation_idx')
      .on(table.reexecutionOperationId)
      .where(sql`${table.reexecutionOperationId} IS NOT NULL`),
    index('agent_runs_session_agent_accepted_idx')
      .on(table.sessionId, table.agentId, table.createdAt)
      .where(sql`${table.nativeTurnId} IS NOT NULL`),
    index('agent_runs_user_agent_accepted_idx')
      .on(table.userMessageId, table.agentId)
      .where(sql`${table.nativeTurnId} IS NOT NULL`),
    uniqueIndex('agent_runs_peer_proposal_unique')
      .on(table.peerProposalId)
      .where(sql`${table.peerProposalId} IS NOT NULL`),
  ],
)

export const agentRunActivities = sqliteTable(
  'agent_run_activities',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    nativeId: text('native_id').notNull(),
    kind: text('kind', { enum: ['reasoning', 'tool'] }).notNull(),
    toolName: text('tool_name'),
    title: text('title').notNull(),
    detail: text('detail'),
    detailRevision: integer('detail_revision').notNull().default(0),
    status: text('status', { enum: ['running', 'completed', 'failed'] }).notNull(),
    sequence: integer('sequence').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('agent_run_activities_run_kind_native_unique').on(
      table.runId,
      table.kind,
      table.nativeId,
    ),
    uniqueIndex('agent_run_activities_session_sequence_unique').on(table.sessionId, table.sequence),
    index('agent_run_activities_run_sequence_idx').on(table.runId, table.sequence),
    index('agent_run_activities_run_status_idx').on(table.runId, table.status),
  ],
)

export const workspaceChangeSets = sqliteTable(
  'workspace_change_sets',
  {
    id: text('id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'restrict' }),
    runId: text('run_id').notNull().unique(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    root: text('root').notNull(),
    rootDevice: text('root_device').notNull(),
    rootInode: text('root_inode').notNull(),
    stagingRoot: text('staging_root').notNull(),
    state: text('state', {
      enum: ['recording', 'ready', 'mixed', 'undone', 'recovery_required'],
    })
      .notNull()
      .default('recording'),
    fileCount: integer('file_count').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    undoUnavailableReason: text('undo_unavailable_reason'),
    effectsUncertain: integer('effects_uncertain', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    finalizedAt: text('finalized_at'),
    projectionPending: integer('projection_pending', { mode: 'boolean' }).notNull().default(true),
    revision: integer('revision').notNull().default(1),
  },
  (table) => [
    index('workspace_change_sets_root_state_idx').on(table.root, table.state),
    index('workspace_change_sets_reconcile_id_idx')
      .on(table.id)
      .where(
        sql`${table.projectionPending} = 1 OR ${table.state} = 'recording' OR ${table.finalizedAt} IS NULL`,
      ),
  ],
)

export const workspaceBlobs = sqliteTable(
  'workspace_blobs',
  {
    hash: text('hash').primaryKey(),
    bytes: integer('bytes').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('workspace_blobs_bytes_idx').on(table.bytes)],
)

export const workspaceFileChanges = sqliteTable(
  'workspace_file_changes',
  {
    changeSetId: text('change_set_id')
      .notNull()
      .references(() => workspaceChangeSets.id, { onDelete: 'restrict' }),
    path: text('path').notNull(),
    previousPath: text('previous_path'),
    kind: text('kind', { enum: ['added', 'modified', 'deleted', 'renamed'] }).notNull(),
    beforeHash: text('before_hash').references(() => workspaceBlobs.hash, {
      onDelete: 'restrict',
    }),
    beforeBytes: integer('before_bytes').notNull(),
    beforeMode: integer('before_mode').notNull(),
    afterHash: text('after_hash').references(() => workspaceBlobs.hash, {
      onDelete: 'restrict',
    }),
    afterBytes: integer('after_bytes').notNull(),
    afterMode: integer('after_mode').notNull(),
    additions: integer('additions'),
    deletions: integer('deletions'),
    hidden: integer('hidden', { mode: 'boolean' }).notNull(),
    reason: text('reason'),
    nativeEvidenceJson: text('native_evidence_json'),
  },
  (table) => [primaryKey({ columns: [table.changeSetId, table.path] })],
)

export const workspaceChangeIntents = sqliteTable(
  'workspace_change_intents',
  {
    id: text('id').primaryKey(),
    changeSetId: text('change_set_id')
      .notNull()
      .references(() => workspaceChangeSets.id, { onDelete: 'restrict' }),
    kind: text('kind', { enum: ['write', 'delete', 'move', 'undo'] }).notNull(),
    payloadJson: text('payload_json').notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    retainedBytes: integer('retained_bytes').notNull().default(0),
    status: text('status', { enum: ['pending', 'applied', 'recovery_required'] })
      .notNull()
      .default('pending'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    reconciledAt: text('reconciled_at'),
  },
  (table) => [
    index('workspace_change_intents_set_id_idx').on(table.changeSetId, table.id),
    index('workspace_change_intents_unreconciled_id_idx')
      .on(table.id)
      .where(sql`${table.reconciledAt} IS NULL`),
    index('workspace_change_intents_unfinished_id_idx')
      .on(table.id)
      .where(sql`${table.status} <> 'applied'`),
    index('workspace_change_intents_bytes_idx').on(table.payloadBytes, table.retainedBytes),
    index('workspace_change_intents_applied_undo_set_idx')
      .on(table.changeSetId)
      .where(
        sql`${table.kind} = 'undo' AND ${table.status} = 'applied' AND ${table.reconciledAt} IS NULL`,
      ),
  ],
)

export const nativeAgentContexts = sqliteTable(
  'native_agent_contexts',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    nativeSessionId: text('native_session_id').notNull(),
    bindingGeneration: integer('binding_generation').notNull().default(1),
    executorId: text('executor_id'),
    continuationState: text('continuation_state', {
      enum: ['ready', 'responding', 'waiting_user', 'checking', 'recovery_required', 'rebuilding'],
    })
      .notNull()
      .default('recovery_required'),
    recoveryReason: text('recovery_reason'),
    recoveryAction: text('recovery_action', { enum: ['retry', 'rebuild', 'none'] }),
    permissionRequestsJson: text('permission_requests_json'),
    state: text('state', {
      enum: [
        'active',
        'interrupted',
        'missing',
        'rebuilding',
        'unavailable',
        'uncertain',
        'superseded',
      ],
    }).notNull(),
    lastRunId: text('last_run_id'),
    recoveryFailureKind: text('recovery_failure_kind', {
      enum: [
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
      ],
    }),
    recoveryFailureMessage: text('recovery_failure_message'),
    rebuildMessageCount: integer('rebuild_message_count'),
    rebuiltThroughSequence: integer('rebuilt_through_sequence'),
    forkThroughSequence: integer('fork_through_sequence'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.agentId] }),
    index('native_contexts_pending_permission_idx')
      .on(table.sessionId, table.agentId)
      .where(sql`${table.permissionRequestsJson} IS NOT NULL`),
    index('native_contexts_quit_unsettled_idx')
      .on(table.sessionId)
      .where(sql`${table.continuationState} IN ('responding', 'waiting_user')`),
    index('native_contexts_recovery_idx')
      .on(table.sessionId)
      .where(
        sql`${table.continuationState} IN ('responding','waiting_user','checking','rebuilding')`,
      ),
  ],
)

export const agentEventJournal = sqliteTable(
  'agent_event_journal',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    runId: text('run_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: text('payload').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.sequence] }),
    index('agent_event_journal_reported_title')
      .on(table.sessionId)
      .where(
        sql`${table.eventType} = 'session.title.updated' AND json_extract(${table.payload}, '$.titleAdopted') = 1`,
      ),
  ],
)

export const nativeRebuildOperations = sqliteTable(
  'native_rebuild_operations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    oldGeneration: integer('old_generation').notNull(),
    oldNativeSessionId: text('old_native_session_id'),
    oldRunId: text('old_run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    abandon: integer('abandon', { mode: 'boolean' }).notNull(),
    stage: text('stage', {
      enum: [
        'preparing',
        'creating',
        'seeding',
        'unconfirmed',
        'completed',
        'failed',
        'superseded',
      ],
    }).notNull(),
    provisionalNativeSessionId: text('provisional_native_session_id'),
    sourceHash: text('source_hash'),
    sourceChunksJson: text('source_chunks_json'),
    initializationWitnessJson: text('initialization_witness_json'),
    returnedInputJson: text('returned_input_json'),
    messageCount: integer('message_count').notNull().default(0),
    throughSequence: integer('through_sequence').notNull().default(-1),
    failureReason: text('failure_reason'),
    checkAction: text('check_action', { enum: ['inspect', 'rebuild'] })
      .notNull()
      .default('inspect'),
    nativeWorkState: text('native_work_state', {
      enum: ['not_dispatched', 'pending', 'unknown', 'settled'],
    })
      .notNull()
      .default('not_dispatched'),
    creationExecutorId: text('creation_executor_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('native_rebuild_operations_returned_input_idx')
      .on(table.sessionId)
      .where(sql`json_extract(${table.returnedInputJson}, '$.state') IN ('pending', 'installed')`),
    index('native_rebuild_operations_unsettled_work_idx')
      .on(table.sessionId)
      .where(sql`${table.nativeWorkState} IN ('pending', 'unknown')`),
    index('native_rebuild_operations_binding_idx').on(
      table.sessionId,
      table.agentId,
      table.createdAt,
      table.id,
    ),
    uniqueIndex('native_rebuild_operations_one_pending_idx')
      .on(table.sessionId, table.agentId)
      .where(sql`${table.stage} IN ('preparing', 'creating', 'seeding', 'unconfirmed')`),
  ],
)

export const sessionForkOperations = sqliteTable(
  'session_fork_operations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: 'restrict' }),
    sourceSessionId: text('source_session_id').notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    sourceSequence: integer('source_sequence').notNull(),
    sourceRevision: text('source_revision').notNull(),
    settingsRevision: integer('settings_revision').notNull(),
    fullConsentJson: text('full_consent_json').notNull(),
    revision: integer('revision').notNull().default(1),
    ready: integer('ready', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('session_forks_source_pending_idx').on(table.sourceSessionId, table.ready)],
)

export const nativeForkIntents = sqliteTable(
  'native_fork_intents',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => sessionForkOperations.id, { onDelete: 'restrict' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    sourceJson: text('source_json').notNull(),
    state: text('state', {
      enum: ['prepared', 'forking', 'unconfirmed', 'initializing', 'ready', 'error'],
    }).notNull(),
    dispatched: integer('dispatched', { mode: 'boolean' }).notNull().default(false),
    candidateMissing: integer('candidate_missing', { mode: 'boolean' }).notNull().default(false),
    candidateVerified: integer('candidate_verified', { mode: 'boolean' }).notNull().default(false),
    phase: text('phase', { enum: ['fork', 'initialize'] })
      .notNull()
      .default('fork'),
    settingsRevision: integer('settings_revision').notNull().default(1),
    nativeSessionId: text('native_session_id'),
    witnessJson: text('witness_json'),
    executorId: text('executor_id'),
    nativeWorkState: text('native_work_state', {
      enum: ['not_dispatched', 'pending', 'unknown', 'settled'],
    })
      .notNull()
      .default('not_dispatched'),
    reason: text('reason'),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.agentId] }),
    index('native_fork_intents_work_idx').on(table.nativeWorkState, table.operationId),
    index('native_fork_intents_recovery_idx')
      .on(table.operationId)
      .where(
        sql`${table.nativeWorkState} = 'pending' OR ${table.state} IN ('forking','initializing') OR (${table.state} = 'prepared' AND ${table.dispatched} = 0)`,
      ),
  ],
)

export const nativeForkCandidateReceipts = sqliteTable(
  'native_fork_candidate_receipts',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => sessionForkOperations.id, { onDelete: 'restrict' }),
    agentId: text('agent_id', { enum: ['claude', 'codex'] }).notNull(),
    nativeSessionId: text('native_session_id').notNull(),
    witnessJson: text('witness_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.operationId, table.agentId, table.nativeSessionId] })],
)

export const collaborationTasks = sqliteTable(
  'collaboration_tasks',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    stateJson: text('state_json').notNull(),
    ledgerRevision: integer('ledger_revision').notNull().default(0),
    inputSequence: integer('input_sequence').notNull().default(0),
    processedWatermark: integer('processed_watermark').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('collaboration_tasks_active_session')
      .on(table.sessionId)
      .where(sql`${table.active} = 1`),
  ],
)
export const collaborationTurns = sqliteTable(
  'collaboration_turns',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    stateJson: text('state_json').notNull(),
    resultJson: text('result_json'),
    completedFailureRevision: integer('completed_failure_revision'),
    pendingEnvelopeBodyId: text('pending_envelope_body_id').references(
      () => conversationBodyInputs.id,
    ),
    nativeEnvelopeBodyId: text('native_envelope_body_id').references(
      () => conversationBodyInputs.id,
    ),
    answerProjectionBodyId: text('answer_projection_body_id').references(
      () => conversationBodyInputs.id,
    ),
  },
  (table) => [index('collaboration_turns_task').on(table.taskId)],
)

/** Run authorization is immutable; the mutable Turn projection is never its basis. */
export const collaborationTurnAuthorizations = sqliteTable(
  'collaboration_turn_authorizations',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    actor: text('actor', { enum: ['claude', 'codex'] }).notNull(),
    duty: text('duty').notNull(),
    ledgerRevision: integer('ledger_revision').notNull(),
    inputWatermark: integer('input_watermark').notNull(),
    inputSequence: integer('input_sequence').notNull(),
    inputBatchId: text('input_batch_id'),
    basisJson: text('basis_json').notNull(),
    authorizationJson: text('authorization_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('collaboration_turn_authorizations_task_idx').on(t.taskId, t.createdAt)],
)

export const collaborationTodos = sqliteTable(
  'collaboration_todos',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    todoId: text('todo_id').notNull(),
    revision: integer('revision').notNull(),
    ledgerRevision: integer('ledger_revision').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind', { enum: ['opinion', 'decision', 'information'] }).notNull(),
    status: text('status', { enum: ['open', 'awaiting_review', 'done'] }).notNull(),
    titlePreview: text('title_preview').notNull(),
    author: text('author', { enum: ['claude', 'codex'] }).notNull(),
    sourceRunId: text('source_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    documentJson: text('document_json').notNull(),
    documentId: text('document_id').notNull(),
    contentDocumentJson: text('content_document_json').notNull(),
    contentDocumentId: text('content_document_id').notNull(),
    reasonDocumentJson: text('reason_document_json'),
    reasonDocumentId: text('reason_document_id'),
    resolutionKind: text('resolution_kind', {
      enum: ['resolved', 'merged', 'not_adopted', 'withdrawn'],
    }),
    mergedInto: text('merged_into'),
    questionId: text('question_id'),
    questionRevision: integer('question_revision'),
    questionJson: text('question_json'),
    answerResolver: text('answer_resolver', { enum: ['claude', 'codex'] }),
    confirmedBy: text('confirmed_by', { enum: ['claude', 'codex'] }),
    confirmedRunId: text('confirmed_run_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.todoId] }),
    uniqueIndex('collaboration_todos_task_ordinal_idx').on(t.taskId, t.ordinal),
    index('collaboration_todos_task_status_ordinal_idx').on(t.taskId, t.status, t.ordinal),
    index('collaboration_todos_question_idx').on(t.taskId, t.questionId, t.questionRevision),
  ],
)

export const collaborationTodoRevisions = sqliteTable(
  'collaboration_todo_revisions',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    todoId: text('todo_id').notNull(),
    revision: integer('revision').notNull(),
    ledgerRevision: integer('ledger_revision').notNull(),
    ordinal: integer('ordinal').notNull(),
    kind: text('kind', { enum: ['opinion', 'decision', 'information'] }).notNull(),
    status: text('status', { enum: ['open', 'awaiting_review', 'done'] }).notNull(),
    titlePreview: text('title_preview').notNull(),
    author: text('author', { enum: ['claude', 'codex'] }).notNull(),
    sourceRunId: text('source_run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    documentJson: text('document_json').notNull(),
    documentId: text('document_id').notNull(),
    contentDocumentJson: text('content_document_json').notNull(),
    contentDocumentId: text('content_document_id').notNull(),
    reasonDocumentJson: text('reason_document_json'),
    reasonDocumentId: text('reason_document_id'),
    resolutionKind: text('resolution_kind', {
      enum: ['resolved', 'merged', 'not_adopted', 'withdrawn'],
    }),
    mergedInto: text('merged_into'),
    questionId: text('question_id'),
    questionRevision: integer('question_revision'),
    questionJson: text('question_json'),
    answerResolver: text('answer_resolver', { enum: ['claude', 'codex'] }),
    confirmedBy: text('confirmed_by', { enum: ['claude', 'codex'] }),
    confirmedRunId: text('confirmed_run_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.todoId, t.revision] }),
    index('collaboration_todo_revisions_snapshot_idx').on(
      t.taskId,
      t.todoId,
      t.ledgerRevision,
      t.revision,
    ),
    index('collaboration_todo_revisions_frozen_page_idx').on(t.taskId, t.ordinal, t.ledgerRevision),
    index('collaboration_todo_revisions_document_idx').on(t.taskId, t.documentId, t.ledgerRevision),
    index('collaboration_todo_revisions_reason_idx').on(
      t.taskId,
      t.reasonDocumentId,
      t.ledgerRevision,
    ),
    index('collaboration_todo_revisions_content_idx').on(
      t.taskId,
      t.contentDocumentId,
      t.ledgerRevision,
    ),
  ],
)

/** One Send freezes all persisted draft members, independently of Renderer paging. */
export const conversationInputBatches = sqliteTable(
  'conversation_input_batches',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    clientMessageId: text('client_message_id').notNull(),
    commentsRevision: integer('comments_revision').notNull(),
    actor: text('actor', { enum: ['claude', 'codex'] }).notNull(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
    messageId: text('message_id').references(() => conversationMessages.id, {
      onDelete: 'cascade',
    }),
    inputId: text('input_id').references(() => conversationBodyInputs.id),
    memberCount: integer('member_count').notNull(),
    bodyDocumentJson: text('body_document_json'),
    bodyState: text('body_state', {
      enum: ['pending_response', 'responded', 'awaiting_confirmation', 'resolved', 'withdrawn'],
    })
      .notNull()
      .default('pending_response'),
    state: text('state', { enum: ['open', 'closed'] })
      .notNull()
      .default('open'),
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [
    uniqueIndex('conversation_input_batches_nonce_idx').on(t.sessionId, t.clientMessageId),
    uniqueIndex('conversation_input_batches_task_sequence_idx').on(t.taskId, t.sequence),
    index('conversation_input_batches_task_state_sequence_idx').on(t.taskId, t.state, t.sequence),
    index('conversation_input_batches_run_idx').on(t.runId),
  ],
)

export const conversationInputBatchMembers = sqliteTable(
  'conversation_input_batch_members',
  {
    batchId: text('batch_id')
      .notNull()
      .references(() => conversationInputBatches.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    ordinal: integer('ordinal').notNull(),
    commentId: text('comment_id')
      .notNull()
      .references(() => anchoredComments.id, { onDelete: 'restrict' }),
    commentRevision: integer('comment_revision').notNull(),
    anchorJson: text('anchor_json').notNull(),
    anchorDocumentJson: text('anchor_document_json'),
    sourceTaskId: text('source_task_id'),
    sourceTodoId: text('source_todo_id'),
    questionId: text('question_id'),
    questionRevision: integer('question_revision'),
    bodySha256: text('body_sha256').notNull(),
    bodyDocumentJson: text('body_document_json'),
    answerResolver: text('answer_resolver', { enum: ['claude', 'codex'] }),
    state: text('state', {
      enum: ['pending_response', 'responded', 'awaiting_confirmation', 'resolved', 'withdrawn'],
    })
      .notNull()
      .default('pending_response'),
    responseRunId: text('response_run_id'),
    responseDocumentJson: text('response_document_json'),
    todoId: text('todo_id'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.batchId, t.memberId] }),
    uniqueIndex('conversation_input_batch_members_ordinal_idx').on(t.batchId, t.ordinal),
    index('conversation_input_batch_members_state_idx').on(t.batchId, t.state, t.ordinal),
    index('conversation_input_batch_members_question_idx').on(
      t.sourceTaskId,
      t.sourceTodoId,
      t.questionId,
      t.questionRevision,
      t.state,
    ),
  ],
)

export const collaborationRequiredInputMembers = sqliteTable(
  'collaboration_required_input_members',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    batchId: text('batch_id')
      .notNull()
      .references(() => conversationInputBatches.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull(),
    inputRevision: integer('input_revision').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.runId, t.batchId, t.memberId] })],
)

/** Frozen quoted-source access for ordinary, collaboration, handoff, and rebuilt Runs. */
export const conversationRunSourceRefs = sqliteTable(
  'conversation_run_source_refs',
  {
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    batchId: text('batch_id').references(() => conversationInputBatches.id, {
      onDelete: 'cascade',
    }),
    documentsJson: text('documents_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.sourceMessageId] }),
    index('conversation_run_source_refs_batch_idx').on(t.runId, t.batchId),
  ],
)

export const conversationRebuildSourceRefs = sqliteTable(
  'conversation_rebuild_source_refs',
  {
    operationId: text('operation_id')
      .notNull()
      .references(() => nativeRebuildOperations.id, { onDelete: 'cascade' }),
    sourceMessageId: text('source_message_id')
      .notNull()
      .references(() => conversationMessages.id, { onDelete: 'cascade' }),
    sourceRevision: integer('source_revision').notNull(),
    batchId: text('batch_id').references(() => conversationInputBatches.id, {
      onDelete: 'cascade',
    }),
    documentsJson: text('documents_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.operationId, t.sourceMessageId] })],
)

export const collaborationReviewFacts = sqliteTable(
  'collaboration_review_facts',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    reviewer: text('reviewer', { enum: ['claude', 'codex'] }).notNull(),
    phase: text('phase', { enum: ['plan', 'code'] }).notNull(),
    basisJson: text('basis_json').notNull(),
    ledgerRevision: integer('ledger_revision').notNull(),
    inputWatermark: integer('input_watermark').notNull(),
    verdict: text('verdict').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('collaboration_review_facts_run_idx').on(t.runId),
    index('collaboration_review_facts_task_phase_idx').on(t.taskId, t.phase, t.createdAt),
  ],
)

export const collaborationResultApplications = sqliteTable(
  'collaboration_result_applications',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    resultId: text('result_id').notNull(),
    manifestJson: text('manifest_json').notNull(),
    sourceJson: text('source_json').notNull(),
    digest: text('digest').notNull(),
    state: text('state', { enum: ['archived', 'applied', 'invalid', 'stale'] })
      .notNull()
      .default('archived'),
    settlementRevision: integer('settlement_revision'),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
    appliedAt: text('applied_at'),
  },
  (t) => [uniqueIndex('collaboration_result_applications_identity_idx').on(t.taskId, t.resultId)],
)

export const collaborationResultOperations = sqliteTable(
  'collaboration_result_operations',
  {
    runId: text('run_id')
      .notNull()
      .references(() => collaborationResultApplications.runId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    todoId: text('todo_id').notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    operation: text('operation').notNull(),
    titlePreview: text('title_preview').notNull(),
    documentJson: text('document_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ordinal] }),
    uniqueIndex('collaboration_result_operations_todo_idx').on(t.runId, t.todoId),
  ],
)

export const collaborationResultInputResponses = sqliteTable(
  'collaboration_result_input_responses',
  {
    runId: text('run_id')
      .notNull()
      .references(() => collaborationResultApplications.runId, { onDelete: 'cascade' }),
    batchId: text('batch_id').notNull(),
    memberId: text('member_id').notNull(),
    disposition: text('disposition').notNull(),
    todoId: text('todo_id'),
    documentJson: text('document_json').notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.batchId, t.memberId] })],
)

export const collaborationMarkdownPages = sqliteTable(
  'collaboration_markdown_pages',
  {
    documentId: text('document_id')
      .notNull()
      .references(() => conversationBodyInputs.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    visibleStart: integer('visible_start').notNull(),
    visibleEnd: integer('visible_end').notNull(),
    treeJson: text('tree_json').notNull(),
    visibleText: text('visible_text').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.ordinal] }),
    index('collaboration_markdown_pages_range').on(t.documentId, t.visibleStart, t.visibleEnd),
  ],
)

export const collaborationReportItems = sqliteTable(
  'collaboration_report_items',
  {
    runId: text('run_id')
      .notNull()
      .references(() => collaborationTurns.runId, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    itemId: text('item_id').notNull(),
    category: text('category', { enum: ['blocking', 'suggestion', 'decision'] }).notNull(),
    disposition: text('disposition', {
      enum: ['open', 'addressed', 'declined', 'needs_user'],
    }).notNull(),
    documentJson: text('document_json').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.ordinal] }),
    uniqueIndex('collaboration_report_items_identity').on(t.runId, t.itemId),
  ],
)

export const collaborationInputs = sqliteTable(
  'collaboration_inputs',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => collaborationTasks.id, { onDelete: 'cascade' }),
    anchorRunId: text('anchor_run_id').notNull(),
    inputId: text('input_id')
      .notNull()
      .references(() => conversationBodyInputs.id),
    metadataJson: text('metadata_json').notNull(),
    digest: text('digest').notNull(),
    actor: text('actor', { enum: ['claude', 'codex'] }).notNull(),
    policy: text('policy', { enum: ['immediate_safe_point', 'next_round'] }).notNull(),
    state: text('state', { enum: ['accepted', 'blocked', 'cancelled', 'materialized'] }).notNull(),
    materializedRunId: text('materialized_run_id'),
    createdAt: text('created_at').notNull(),
    deadline: text('deadline').notNull(),
    queueState: text('queue_state', {
      enum: ['queued', 'paused', 'dispatching', 'unknown', 'returned', 'removed', 'delivered'],
    })
      .notNull()
      .default('queued'),
    queueReason: text('queue_reason'),
    queueRevision: integer('queue_revision').notNull().default(0),
    preview: text('preview').notNull().default(''),
  },
  (t) => [
    uniqueIndex('collaboration_inputs_pending_session')
      .on(t.sessionId)
      .where(sql`${t.state} IN ('accepted','blocked')`),
    index('collaboration_inputs_state').on(t.state, t.createdAt),
    index('collaboration_inputs_session_created').on(t.sessionId, t.createdAt),
  ],
)

/** Durable queue operation receipts and append-only same-Run input grants. */
export const conversationQueueOperations = sqliteTable(
  'conversation_queue_operations',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    inputId: text('input_id').references(() => collaborationInputs.id),
    kind: text('kind', { enum: ['enabled', 'resume', 'remove', 'return', 'steer'] }).notNull(),
    state: text('state', {
      enum: [
        'complete',
        'returned',
        'installed',
        'consumed',
        'prepared',
        'possibly_sent',
        'accepted',
        'unknown',
        'refused',
      ],
    }).notNull(),
    expectedRevision: integer('expected_revision').notNull(),
    claimId: text('claim_id'),
    claimExpectedCommentsRevision: integer('claim_expected_comments_revision'),
    installedCommentsRevision: integer('installed_comments_revision'),
    enabled: integer('enabled', { mode: 'boolean' }),
    targetRunId: text('target_run_id').references(() => agentRuns.id),
    bindingGeneration: integer('binding_generation'),
    nativeTurnId: text('native_turn_id'),
    executorId: text('executor_id'),
    inputRevision: integer('input_revision'),
    resultNonce: text('result_nonce'),
    inputScopeJson: text('input_scope_json'),
    candidateCarrierJson: text('candidate_carrier_json'),
    batchId: text('batch_id').references(() => conversationInputBatches.id),
    messageId: text('message_id'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('conversation_queue_operations_session_idx').on(t.sessionId, t.createdAt),
    index('conversation_queue_operations_run_idx').on(t.targetRunId, t.inputRevision),
    index('conversation_queue_operations_kind_state_idx').on(t.kind, t.state, t.createdAt),
    index('conversation_queue_operations_input_kind_idx').on(t.inputId, t.kind, t.createdAt),
    index('conversation_queue_operations_active_grant_idx')
      .on(t.targetRunId, t.inputRevision)
      .where(
        sql`${t.kind} = 'steer' AND ${t.state} IN ('prepared','possibly_sent','accepted','consumed','unknown')`,
      ),
    uniqueIndex('conversation_queue_operations_returned_idx')
      .on(t.sessionId)
      .where(sql`${t.state} IN ('returned','installed')`),
  ],
)

export const schema = {
  conversationOutputSnapshots,
  conversationQueueOperations,
  nativePresenceMetadata,
  sessionOpenOperations,
  workspaceArchiveOperations,
  commentDraftReceipts,
  collaborationTodos,
  collaborationTodoRevisions,
  collaborationTurnAuthorizations,
  conversationInputBatches,
  conversationInputBatchMembers,
  collaborationRequiredInputMembers,
  conversationRunSourceRefs,
  conversationRebuildSourceRefs,
  collaborationReviewFacts,
  collaborationResultApplications,
  collaborationResultOperations,
  collaborationResultInputResponses,
  collaborationInputs,
  collaborationTasks,
  collaborationTurns,
  collaborationReportItems,
  collaborationMarkdownPages,
  conversationImageAssets,
  conversationMessageImages,
  pactSchemaMeta,
  appearanceSettings,
  appSetupState,
  defaultSessionSettings,
  sessionCatalogRevisions,
  runtimeCliPaths,
  projects,
  sessions,
  sessionSettingsRevisions,
  conversationMessages,
  conversationBodyInputs,
  conversationBodyParts,
  anchoredComments,
  agentRuns,
  workspaceChangeSets,
  workspaceBlobs,
  workspaceFileChanges,
  workspaceChangeIntents,
  agentRunActivities,
  nativeAgentContexts,
  nativeRebuildOperations,
  agentEventJournal,
  sessionForkOperations,
  nativeForkIntents,
  nativeForkCandidateReceipts,
}
