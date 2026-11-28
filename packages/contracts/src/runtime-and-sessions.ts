import { z } from 'zod'

import { AGENTS } from './collaboration.js'
import { agentSpeedSchema, sessionPermissionModeSchema } from './execution-settings.js'
import { sideChatAnchorSchema, sideChatOriginSchema } from './side-chats.js'

export const runtimeAgentIdSchema = z.enum(AGENTS)
export type RuntimeAgentId = z.infer<typeof runtimeAgentIdSchema>

export const RUNTIME_MINIMUM_VERSIONS = {
  claude: '2.1.272',
  codex: '0.159.2',
  agy: '1.5.9',
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
  agentInfoVersion: z.string().optional(),
  acpVersion: z.string().optional(),
  detail: z.string().optional(),
  checkedAt: z.string().datetime(),
})
export type RuntimeAgentReadiness = z.infer<typeof runtimeAgentReadinessSchema>

export const runtimePreparationSchema = z
  .strictObject({
    firstUse: z.boolean(),
    agents: z.array(runtimeAgentReadinessSchema).min(2).max(3),
  })
  .refine(
    (prep) => new Set(prep.agents.map((entry) => entry.agentId)).size === prep.agents.length,
    'Runtime preparation entries must have unique Agent identities.',
  )
export type RuntimePreparation = z.infer<typeof runtimePreparationSchema>

export const runtimePreparationGetInputSchema = z.strictObject({
  forceRefresh: z.boolean().optional(),
})
export type RuntimePreparationGetInput = z.infer<typeof runtimePreparationGetInputSchema>

export const runtimeExecutablePathUpdateSchema = z.strictObject({
  agentId: runtimeAgentIdSchema,
  executablePath: z.string().min(1),
})
export type RuntimeExecutablePathUpdate = z.infer<typeof runtimeExecutablePathUpdateSchema>

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

const defaultSessionSettingsBaseSchema = z.strictObject({
  primaryAgentId: runtimeAgentIdSchema,
  secondaryAgentId: runtimeAgentIdSchema,
  agents: z.strictObject({
    claude: agentModelSelectionSchema,
    codex: agentModelSelectionSchema,
    agy: agentModelSelectionSchema,
  }),
  maxDiscussionRounds: z.number().int().min(1).max(20),
  maxReviewCycles: z.number().int().min(1).max(10),
  maxRepairAttempts: z.number().int().min(1).max(10),
})

export const defaultSessionSettingsSchema = defaultSessionSettingsBaseSchema.refine(
  (settings) => settings.primaryAgentId !== settings.secondaryAgentId,
  {
    message: 'Primary and Secondary Agents must be distinct.',
    path: ['secondaryAgentId'],
  },
)
export type DefaultSessionSettings = z.infer<typeof defaultSessionSettingsSchema>

export const sessionSettingsSchema = defaultSessionSettingsBaseSchema
  .extend({
    permissionModes: z
      .strictObject({
        claude: sessionPermissionModeSchema,
        codex: sessionPermissionModeSchema,
        agy: sessionPermissionModeSchema,
      })
      .optional(),
  })
  .refine((settings) => settings.primaryAgentId !== settings.secondaryAgentId, {
    message: 'Primary and Secondary Agents must be distinct.',
    path: ['secondaryAgentId'],
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

export const activeAgentPairInputSchema = z
  .strictObject({
    primaryAgentId: runtimeAgentIdSchema,
    secondaryAgentId: runtimeAgentIdSchema,
  })
  .refine((pair) => pair.primaryAgentId !== pair.secondaryAgentId, {
    message: 'Primary and Secondary Agents must be distinct.',
    path: ['secondaryAgentId'],
  })
export type ActiveAgentPairInput = z.infer<typeof activeAgentPairInputSchema>

export const defaultSessionSettingsGetInputSchema = z.strictObject({
  activePair: activeAgentPairInputSchema.optional(),
})
export type DefaultSessionSettingsGetInput = z.infer<typeof defaultSessionSettingsGetInputSchema>

export const defaultSessionSettingsEditorStateSchema = z.strictObject({
  modelCatalogs: z.strictObject({
    claude: agentModelCatalogSchema,
    codex: agentModelCatalogSchema,
    agy: agentModelCatalogSchema,
  }),
  recommendedPair: activeAgentPairInputSchema.optional(),
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
  groupId: z.string().uuid().nullable().optional(),
  sidebarHidden: z.literal(true).optional(),
  parentSessionId: z.string().uuid().nullable().optional(),
  sideChatOrigin: sideChatOriginSchema.optional(),
  sideChatAnchor: sideChatAnchorSchema.optional(),
  sideChatHasContext: z.boolean().optional(),
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
  groupRevision: z.number().int().nonnegative().optional(),
  dissolvedGroupId: z.string().uuid().optional(),
  session: collaborationSessionSchema,
  resolvedSideChat: collaborationSessionSchema.optional(),
})
export type SessionCatalogChange = z.infer<typeof sessionCatalogChangeSchema>

export const sessionCatalogReplySchema = z.discriminatedUnion('kind', [
  sessionCatalogPageSchema,
  sessionCatalogChangeSchema,
])
export type SessionCatalogReply = z.infer<typeof sessionCatalogReplySchema>

export const SESSION_GROUP_PAGE_ITEMS = 20
export const SESSION_GROUP_PAGE_BYTES = 64 * 1024
export const SESSION_GROUP_NAME_LIMIT = 120

export const SESSION_GROUP_COLORS = [
  'gray',
  'blue',
  'red',
  'yellow',
  'green',
  'rose',
  'purple',
  'cyan',
  'orange',
] as const
export const sessionGroupColorSchema = z.enum(SESSION_GROUP_COLORS)
export type SessionGroupColor = z.infer<typeof sessionGroupColorSchema>

export const sessionGroupNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SESSION_GROUP_NAME_LIMIT)
  .regex(/^[^\r\n\u2028\u2029]+$/, 'Use a single line for a Session group name.')

export const sessionGroupSchema = z.strictObject({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: sessionGroupNameSchema,
  color: sessionGroupColorSchema,
  creationOrdinal: z.number().int().positive(),
  position: z.number().int().nonnegative(),
  collapsed: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})
export type SessionGroup = z.infer<typeof sessionGroupSchema>

export const sessionPageScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ungrouped') }),
  z.strictObject({ kind: z.literal('group'), groupId: z.string().uuid() }),
])
export type SessionPageScope = z.infer<typeof sessionPageScopeSchema>

export const sessionPageCursorSchema = z
  .strictObject({
    projectId: z.string().uuid(),
    scope: sessionPageScopeSchema,
    revision: z.number().int().nonnegative(),
    direction: z.enum(['newer', 'older']),
    createdAt: z.string().datetime(),
    id: z.string().uuid(),
    groupPosition: z.number().int().nonnegative().optional(),
  })
  .refine((value) => (value.scope.kind === 'group') === (value.groupPosition !== undefined))
export type SessionPageCursor = z.infer<typeof sessionPageCursorSchema>

export const sessionPageInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  scope: sessionPageScopeSchema,
  cursor: sessionPageCursorSchema.optional(),
})
export type SessionPageInput = z.infer<typeof sessionPageInputSchema>

export const sessionPageSchema = z.strictObject({
  kind: z.literal('page'),
  projectId: z.string().uuid(),
  scope: sessionPageScopeSchema,
  groupRevision: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  sessions: z.array(collaborationSessionSchema).max(SESSION_CATALOG_PAGE_ITEMS),
  nextCursor: sessionPageCursorSchema.optional(),
  previousCursor: sessionPageCursorSchema.optional(),
  hasGroups: z.boolean(),
})
export type SessionPage = z.infer<typeof sessionPageSchema>

export const sessionGroupPageCursorSchema = z.strictObject({
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  direction: z.enum(['newer', 'older']),
  position: z.number().int().nonnegative(),
  id: z.string().uuid(),
})
export type SessionGroupPageCursor = z.infer<typeof sessionGroupPageCursorSchema>

export const sessionGroupPageInputSchema = z
  .strictObject({
    projectId: z.string().uuid(),
    aroundGroupId: z.string().uuid().optional(),
    cursor: sessionGroupPageCursorSchema.optional(),
  })
  .refine((input) => !input.cursor || !input.aroundGroupId)
export type SessionGroupPageInput = z.infer<typeof sessionGroupPageInputSchema>

export const sessionGroupPageSchema = z.strictObject({
  kind: z.literal('groups'),
  projectId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  groups: z.array(sessionGroupSchema).max(SESSION_GROUP_PAGE_ITEMS),
  nextCursor: sessionGroupPageCursorSchema.optional(),
  previousCursor: sessionGroupPageCursorSchema.optional(),
})
export type SessionGroupPage = z.infer<typeof sessionGroupPageSchema>

export const sessionGroupDetailInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
})
export type SessionGroupDetailInput = z.infer<typeof sessionGroupDetailInputSchema>

export const sessionGroupDetailSchema = z.union([
  z.strictObject({
    exists: z.literal(false),
    revision: z.number().int().nonnegative(),
  }),
  z.strictObject({
    exists: z.literal(true),
    group: sessionGroupSchema,
    previousGroupId: z.string().uuid().optional(),
    nextGroupId: z.string().uuid().optional(),
    revision: z.number().int().nonnegative(),
  }),
])
export type SessionGroupDetail = z.infer<typeof sessionGroupDetailSchema>

export const sessionMembershipInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
})
export type SessionMembershipInput = z.infer<typeof sessionMembershipInputSchema>

export const sessionMembershipSchema = z.strictObject({
  exists: z.boolean(),
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  groupId: z.string().uuid().nullable(),
  archived: z.boolean(),
  createdAt: z.string().datetime().optional(),
  groupPosition: z.number().int().nonnegative().optional(),
  previousSessionId: z.string().uuid().optional(),
  nextSessionId: z.string().uuid().optional(),
  revision: z.number().int().nonnegative(),
})
export type SessionMembership = z.infer<typeof sessionMembershipSchema>

export const locateSessionNavigationInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
})
export type LocateSessionNavigationInput = z.infer<typeof locateSessionNavigationInputSchema>

export const locatedSessionNavigationSchema = z.strictObject({
  membership: sessionMembershipSchema,
  catalogRevision: z.number().int().nonnegative(),
  sessions: z.array(collaborationSessionSchema).max(SESSION_CATALOG_PAGE_ITEMS),
  nextCursor: sessionPageCursorSchema.optional(),
  previousCursor: sessionPageCursorSchema.optional(),
  groups: z.array(sessionGroupSchema).max(SESSION_GROUP_PAGE_ITEMS),
  nextGroupCursor: sessionGroupPageCursorSchema.optional(),
  previousGroupCursor: sessionGroupPageCursorSchema.optional(),
  hasGroups: z.boolean(),
})
export type LocatedSessionNavigation = z.infer<typeof locatedSessionNavigationSchema>

export const sessionCreationStateInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  sessionId: z.string().uuid(),
})
export type SessionCreationStateInput = z.infer<typeof sessionCreationStateInputSchema>

const creationRevisions = {
  revision: z.number().int().nonnegative(),
  catalogRevision: z.number().int().nonnegative(),
}

export const sessionCreationStateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('pending'), ...creationRevisions }),
  z.strictObject({ state: z.literal('absent'), ...creationRevisions }),
  z.strictObject({
    state: z.literal('present'),
    session: collaborationSessionSchema,
    groupId: z.string().uuid().nullable(),
    ...creationRevisions,
  }),
])
export type SessionCreationState = z.infer<typeof sessionCreationStateSchema>

export const createSessionGroupInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
  name: sessionGroupNameSchema,
  color: sessionGroupColorSchema,
  expectedRevision: z.number().int().nonnegative(),
  sessionId: z.string().uuid().optional(),
})
export type CreateSessionGroupInput = z.infer<typeof createSessionGroupInputSchema>

export const updateSessionGroupInputSchema = z.strictObject({
  projectId: z.string().uuid(),
  groupId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  name: sessionGroupNameSchema.optional(),
  color: sessionGroupColorSchema.optional(),
  collapsed: z.boolean().optional(),
})
export type UpdateSessionGroupInput = z.infer<typeof updateSessionGroupInputSchema>
