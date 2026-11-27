import { randomUUID } from 'node:crypto'
import { basename, isAbsolute, relative } from 'node:path'

import type {
  AgentCollaborationSourceReader,
  AgentPromptEnvelope,
  AgentPromptImage,
  AgentRunInput,
  AgentSourceReadForm,
  RunLifecycleKernel,
} from '@pact/agent-runtime'
import type {
  CollaborationTask,
  CollaborationTurnAuthorization,
  NativeInputField,
  NativePermissionRequest,
  NativeUserInputRequest,
  NormalizedAgentEvent,
  SessionPermissionMode,
} from '@pact/contracts'

import { agentPromptImageGroups } from '@pact/agent-runtime'
import {
  nativeInputDetailsSchema,
  nativeInputValueSchema,
  nativePermissionRequestSchema,
} from '@pact/contracts'

import type { AgyAcpConnection, AgyIngress } from '../agy-acp-connection'
import type { NativePermissionWait } from '../native-permission-wait'
import type { AgyAdapterRuntime } from './adapter-runtime'
import type { AgyRunMcpServer } from './peer-mcp-server'

import { AgentExecutionError } from '../agent-execution-error'
import { buildSourceInstructions, collaborationInstructions } from '../collaboration-prompt'
import { cutoffSourceNavigator } from '../frozen-source-reader'
import { agyPromptInput, nativeImagePreparationBytes } from '../native-image-content'
import { nativeApprovalDisplayFits, safeNativePermissionText } from '../native-permission-wait'
import { PEER_ASSISTANCE_INSTRUCTIONS } from '../peer-assistance-policy'
import { validateAgyFrame } from './frame-validator'
import {
  AGY_PLAN_SUBMISSION_INSTRUCTIONS,
  AGY_READ_ONLY_STAGE_INSTRUCTIONS,
  asString,
  isPlainObject,
  type AcpConfigOptionEntry,
  type AcpSessionDescriptor,
  type ActiveAgyRun,
  type AgyToolState,
} from './types'

export function parseAcpSessionDescriptor(
  result: object,
  fallbackSessionId?: string,
): AcpSessionDescriptor {
  const sessionId = asString(Reflect.get(result, 'sessionId')) ?? fallbackSessionId
  if (!sessionId || sessionId.length > 1024) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity ACP server did not return a valid sessionId.',
      false,
    )
  }
  const modesRaw = Reflect.get(result, 'modes')
  const currentModeId = isPlainObject(modesRaw) ? asString(modesRaw.currentModeId) : undefined
  const availableModes =
    isPlainObject(modesRaw) && Array.isArray(modesRaw.availableModes)
      ? modesRaw.availableModes
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.id ?? entry.modeId)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const modelsRaw = Reflect.get(result, 'models')
  const currentModelId = isPlainObject(modelsRaw) ? asString(modelsRaw.currentModelId) : undefined
  const availableModels =
    isPlainObject(modelsRaw) && Array.isArray(modelsRaw.availableModels)
      ? modelsRaw.availableModels
          .map((entry) =>
            typeof entry === 'string'
              ? entry
              : isPlainObject(entry)
                ? asString(entry.modelId ?? entry.id)
                : undefined,
          )
          .filter((id): id is string => Boolean(id))
      : undefined

  const configOptions = parseConfigOptions(Reflect.get(result, 'configOptions'))
  return {
    sessionId,
    currentModeId,
    availableModes,
    currentModelId,
    availableModels,
    configOptions,
  }
}

export function parseConfigOptions(raw: unknown): AcpConfigOptionEntry[] {
  if (!Array.isArray(raw) || raw.length > 32) return []
  const entries: AcpConfigOptionEntry[] = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = asString(item.id ?? item.configId)
    if (!id) continue
    const currentValue = asString(item.currentValue ?? item.value)
    const rawOptions = Array.isArray(item.options) ? item.options : undefined
    const options =
      rawOptions && rawOptions.length <= 128
        ? rawOptions
            .map((opt) => {
              if (!isPlainObject(opt)) return undefined
              const val = asString(opt.value ?? opt.id)
              if (!val) return undefined
              const mapped: { value: string; name?: string | undefined } = { value: val }
              const optName = asString(opt.name)
              if (optName) mapped.name = optName
              return mapped
            })
            .filter((opt): opt is { value: string; name?: string | undefined } => opt !== undefined)
        : undefined
    entries.push({ id, currentValue, options })
  }
  return entries
}

export function collectAmbiguousPermissionOptionIds(options: readonly unknown[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId) continue
    if (seen.has(optionId)) {
      duplicates.add(optionId)
    } else {
      seen.add(optionId)
    }
  }
  return duplicates
}

export function findRejectOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      if (rawKind === 'reject_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'deny' || optionId === 'reject_once') {
      return optionId
    }
  }
  return undefined
}

export function findAllowOnceOptionId(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length === 0 || options.length > 32) return undefined
  const ambiguousIds = collectAmbiguousPermissionOptionIds(options)
  for (const option of options) {
    if (!isPlainObject(option)) continue
    const optionId = asString(option.optionId)
    if (!optionId || optionId.length > 80 || ambiguousIds.has(optionId)) continue
    const rawKind = option.kind
    if (typeof rawKind === 'string' && rawKind.length > 0) {
      // NEVER auto-select or expose `allow_always` as session-scoped because Antigravity persists it globally.
      if (rawKind === 'allow_once') return optionId
      continue
    }
    if (rawKind !== undefined) continue
    if (optionId === 'allow_always') continue
    if (optionId === 'allow' || optionId === 'allow_once') {
      return optionId
    }
  }
  return undefined
}

export function buildAgyPermissionCard(
  params: Record<string, unknown>,
  cwd: string,
): {
  request: Omit<NativePermissionRequest, 'id' | 'createdAt'>
  responses: Map<string, object>
} {
  const toolCall = isPlainObject(params.toolCall) ? params.toolCall : {}
  const toolName = asString(toolCall.name) ?? asString(toolCall.title) ?? 'tool'
  const rawTitle = asString(toolCall.title) ?? `Antigravity wants to run ${toolName}`
  const title = safeNativePermissionText(rawTitle, 240) || 'Antigravity permission request'

  const args = isPlainObject(toolCall.args)
    ? toolCall.args
    : isPlainObject(toolCall.rawInput)
      ? toolCall.rawInput
      : undefined
  const detailLines: string[] = [`Tool: ${toolName}`]
  if (args) {
    const command = asString(args.CommandLine ?? args.command)
    const targetPath = asString(args.Path ?? args.path ?? args.file_path ?? args.filePath)
    if (command) detailLines.push(`Command: ${command}`)
    if (targetPath) {
      const displayPath = isAbsolute(targetPath)
        ? relative(cwd, targetPath) || basename(targetPath)
        : targetPath
      detailLines.push(`Path: ${displayPath}`)
    }
  }
  const rawDetail = detailLines.join('\n')
  const detailComplete = nativeApprovalDisplayFits(rawDetail, 2048)
  const detail = safeNativePermissionText(rawDetail, 2048)

  const allowOnceOptionId = detailComplete ? findAllowOnceOptionId(params.options) : undefined
  const rejectOnceOptionId = findRejectOnceOptionId(params.options)

  const actions: NonNullable<NativePermissionRequest['actions']> = []
  const responses = new Map<string, object>()

  if (allowOnceOptionId) {
    actions.push({
      id: 'agy-allow-once',
      label: 'Allow once',
      kind: 'allow',
    })
    responses.set('agy-allow-once', {
      outcome: { outcome: 'selected', optionId: allowOnceOptionId },
    })
  }
  if (rejectOnceOptionId) {
    actions.push({
      id: 'agy-reject-once',
      label: 'Decline and continue',
      kind: 'decline',
    })
    responses.set('agy-reject-once', {
      outcome: { outcome: 'selected', optionId: rejectOnceOptionId },
    })
  }
  actions.push({
    id: 'agy-cancel',
    label: 'Cancel this turn',
    kind: 'cancel',
  })
  responses.set('agy-cancel', { outcome: { outcome: 'cancelled' } })

  // Validate against public contract budget; never expose `allow_always` (`kind: 'rule'`).
  nativePermissionRequestSchema.parse({
    id: randomUUID(),
    kind: 'approval',
    title,
    detail,
    actions,
    defaultToNo: true,
    createdAt: new Date().toISOString(),
  })

  return {
    request: {
      kind: 'approval',
      title,
      detail,
      actions,
      defaultToNo: true,
    },
    responses,
  }
}

export function choicesFromAgySchema(
  schema: Record<string, unknown>,
): NonNullable<NativeInputField['options']> | undefined {
  const source = schema.enum ?? schema.oneOf ?? schema.anyOf
  if (source === undefined) return undefined
  if (!Array.isArray(source) || source.length === 0 || source.length > 64) {
    throw new Error('The native Antigravity enum schema is unsupported.')
  }
  const choices = source.map((entry, index) => {
    const value = isPlainObject(entry) ? entry.const : entry
    if (typeof value !== 'string') {
      throw new Error('Only string selectable values can be represented faithfully.')
    }
    const label =
      isPlainObject(entry) && typeof entry.title === 'string'
        ? entry.title
        : Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === 'string'
          ? schema.enumNames[index]
          : value
    const choice: NonNullable<NativeInputField['options']>[number] = { value, label }
    if (isPlainObject(entry) && typeof entry.description === 'string') {
      choice.description = entry.description
    }
    return choice
  })
  if (new Set(choices.map((c) => c.value)).size !== choices.length) {
    throw new Error('Duplicate native selectable values are unsupported.')
  }
  return choices
}

export function parseAgyFormField(id: string, raw: unknown, required: boolean): NativeInputField {
  if (
    !isPlainObject(raw) ||
    '$ref' in raw ||
    '$defs' in raw ||
    'allOf' in raw ||
    'not' in raw ||
    'if' in raw ||
    'then' in raw ||
    'else' in raw
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const title = typeof raw.title === 'string' && raw.title ? raw.title : id
  if (
    raw.writeOnly === true ||
    raw.format === 'password' ||
    /(?:^|[ _-])(?:password|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|authorization|cookie)(?:$|[ _-])/iu.test(
      `${id} ${title}`,
    )
  ) {
    throw new Error(
      'Authentication credentials must be entered in the native browser flow, not a Pact form.',
    )
  }
  let type: NativeInputField['type']
  let choices: NativeInputField['options']
  if (raw.type === 'array') {
    if (
      !isPlainObject(raw.items) ||
      (raw.items.type !== undefined && raw.items.type !== 'string') ||
      '$ref' in raw.items
    ) {
      throw new Error('Only string selection arrays are supported by the native form UI.')
    }
    choices = choicesFromAgySchema(raw.items)
    if (!choices) throw new Error('A native array field must supply selectable options.')
    type = 'multi-select'
  } else {
    choices = choicesFromAgySchema(raw)
    type = choices
      ? 'select'
      : raw.type === 'string'
        ? 'text'
        : raw.type === 'number'
          ? 'number'
          : raw.type === 'integer'
            ? 'integer'
            : raw.type === 'boolean'
              ? 'boolean'
              : (() => {
                  throw new Error('This native Antigravity form field type is unsupported.')
                })()
  }
  const constraints = [
    typeof raw.minimum === 'number' ? `Minimum: ${raw.minimum}` : undefined,
    typeof raw.maximum === 'number' ? `Maximum: ${raw.maximum}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const description = [
    typeof raw.description === 'string' ? raw.description : undefined,
    constraints || undefined,
  ]
    .filter(Boolean)
    .join('\n')

  return {
    id,
    label: title,
    ...(description ? { description } : {}),
    type,
    required,
    ...(raw.allowOther === true ? { allowOther: true } : {}),
    ...(choices ? { options: choices } : {}),
    ...('default' in raw ? { default: nativeInputValueSchema.parse(raw.default) } : {}),
  }
}

export function agyElicitationRequest(params: Record<string, unknown>): NativeUserInputRequest {
  const mode = params.mode ?? 'form'
  const server = typeof params.serverName === 'string' && params.serverName ? params.serverName : ''
  const defaultTitle = server ? `Antigravity · ${server}` : 'Antigravity needs your input'
  const title = safeNativePermissionText(
    typeof params.title === 'string' && params.title ? params.title : defaultTitle,
    240,
  )
  const message = typeof params.message === 'string' ? params.message : ''

  if (mode === 'url') {
    const url = asString(params.url)
    if (!url) throw new Error('Native authorization URL is unavailable.')
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('The native authorization URL is unsupported.')
    }
    const publicDetails = nativeInputDetailsSchema.parse({
      kind: 'url',
      title,
      message: safeNativePermissionText(message, 8192),
      fields: [],
      url,
    })
    return publicDetails
  }

  if (typeof mode !== 'string' || mode !== 'form') {
    throw new Error('This native Antigravity elicitation mode is unsupported.')
  }
  const schema = params.requestedSchema
  if (
    !isPlainObject(schema) ||
    schema.type !== 'object' ||
    !isPlainObject(schema.properties) ||
    '$ref' in schema ||
    '$defs' in schema ||
    'allOf' in schema ||
    'anyOf' in schema ||
    'oneOf' in schema
  ) {
    throw new Error('This native Antigravity form needs a deeper schema UI that is not supported.')
  }
  const required = schema.required ?? []
  const properties = schema.properties
  if (
    !Array.isArray(required) ||
    !required.every((key) => typeof key === 'string') ||
    Object.keys(properties).length === 0 ||
    Object.keys(properties).length > 32
  ) {
    throw new Error('The native Antigravity form field list is unsupported.')
  }
  if (required.some((key) => !Object.hasOwn(properties, key))) {
    throw new Error('The native Antigravity form requires an undeclared field.')
  }
  const fields = Object.entries(properties).map(([id, field]) =>
    parseAgyFormField(id, field, required.includes(id)),
  )
  const publicDetails = nativeInputDetailsSchema.parse({
    kind: 'form',
    title,
    message: safeNativePermissionText(message, 8192),
    fields,
  })
  return {
    ...publicDetails,
    requestedSchema: schema,
  }
}

export function buildAgyTurnSystemAppend(params: {
  readonly workflow: CollaborationTask | undefined
  readonly authorization: CollaborationTurnAuthorization | undefined
  readonly readOnlyStage: boolean
  readonly planModeStage: boolean
  readonly mcpServer: AgyRunMcpServer
}): {
  readonly systemAppend: string
  readonly systemPromptMeta: Record<string, unknown>
} {
  const { workflow, authorization, readOnlyStage, planModeStage, mcpServer } = params
  const systemAppendParts: string[] = []
  if (workflow) {
    systemAppendParts.push(
      collaborationInstructions(workflow, authorization, mcpServer.sourceCapability),
    )
    if (readOnlyStage) {
      systemAppendParts.push(AGY_READ_ONLY_STAGE_INSTRUCTIONS)
    }
    if (planModeStage) {
      systemAppendParts.push(AGY_PLAN_SUBMISSION_INSTRUCTIONS)
    }
  } else {
    if (mcpServer.allowedToolNames.has('request_peer_assistance')) {
      systemAppendParts.push(PEER_ASSISTANCE_INSTRUCTIONS)
    }
    if (mcpServer.allowedToolNames.has('read_collaboration_source')) {
      systemAppendParts.push(buildSourceInstructions(mcpServer.sourceCapability))
    }
  }
  if (mcpServer.hasTools) {
    systemAppendParts.push(mcpServer.formatToolUsageInstructions())
  }
  const systemAppend = systemAppendParts.filter(Boolean).join('\n\n')
  const systemPromptMeta = systemAppend
    ? { _meta: { antigravity: { systemPrompt: { append: systemAppend } } } }
    : {}
  return { systemAppend, systemPromptMeta }
}

export async function prepareAgyTurnPromptBlocks(params: {
  readonly currentEnvelope: AgentPromptEnvelope
  readonly runId: string
  readonly runSignal: AbortSignal
  readonly workflow: CollaborationTask | undefined
  readonly systemAppend: string
  readonly mcpServer: AgyRunMcpServer
  readonly sourceReader: AgentCollaborationSourceReader | undefined
  readonly reservePromptMemory: (bytes: number) => void
}): Promise<{
  readonly promptBlocks: Awaited<ReturnType<typeof agyPromptInput>>
  readonly expectedFullPromptText: string
}> {
  const {
    currentEnvelope,
    runId,
    runSignal,
    workflow,
    systemAppend,
    mcpServer,
    sourceReader,
    reservePromptMemory,
  } = params
  const images: AgentPromptImage[] = []
  const sourceForm: AgentSourceReadForm | undefined = mcpServer.sourceCapability.sourceReference
    ? 'sourceReference'
    : mcpServer.sourceCapability.nativeRoot
      ? 'nativeRoot'
      : mcpServer.sourceCapability.legacy
        ? 'legacy'
        : undefined
  const navigate =
    sourceReader && sourceForm !== undefined
      ? (target: Parameters<AgentCollaborationSourceReader['navigation']>[0]) =>
          sourceReader.navigation(target, sourceForm)
      : undefined
  const navigateCutoff =
    sourceForm !== undefined ? cutoffSourceNavigator(sourceReader, sourceForm) : undefined

  for (const group of agentPromptImageGroups(currentEnvelope)) {
    images.push(...group.images)
  }
  reservePromptMemory(
    64 * 1024 + Buffer.byteLength(systemAppend, 'utf8') * 2 + nativeImagePreparationBytes(images),
  )
  const promptBlocks = await agyPromptInput(currentEnvelope, runSignal, navigate, navigateCutoff, {
    pactRunId: runId,
  })
  if (workflow && systemAppend && promptBlocks[0]?.type === 'text') {
    promptBlocks[0] = {
      type: 'text',
      text: `Pact host instructions for this turn:\n${systemAppend}\n\n${promptBlocks[0].text}`,
    }
  }
  const expectedFullPromptText = promptBlocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim()
  return { promptBlocks, expectedFullPromptText }
}

export interface AgyTurnInteractionRouterHost {
  readonly runtime: AgyAdapterRuntime
  readonly kernel: RunLifecycleKernel
  readonly input: AgentRunInput
  readonly mcpServer: AgyRunMcpServer
  readonly tools: Map<string, AgyToolState>
  readonly approvedBrainPlanCalls: Map<
    string,
    { readonly toolName: string; readonly args: Record<string, unknown> }
  >
  readonly onBrainPlanWriteApproved: (toolCallId: string) => void
  readonly readOnlyStage: boolean
  readonly planModeStage: boolean
  readonly askOnlyStage: boolean
  readonly readOnlyNonInteractive: boolean
  readonly permissionMode: SessionPermissionMode
  readonly signal: AbortSignal
  readonly getActiveRun: () => ActiveAgyRun | undefined
  readonly getResolvedSessionId: () => string | undefined
  readonly getActiveExecutorId: () => string
  readonly isRootFirstByteWritten: () => boolean
  readonly isRootTerminal: () => boolean
  readonly isReplayingHistory: () => boolean
  readonly getPromptCutoffSeq: () => number | undefined
  readonly pushPendingEvent: (event: NormalizedAgentEvent) => void
}

/**
 * Deep module owning ordered ACP server-request validation, permission & elicitation
 * routing, and dynamic foreign-execution revocation for pending interactions (S2-F2/S2-F3).
 */
export class AgyTurnInteractionRouter {
  readonly interactionControllers = new Set<AbortController>()
  private readonly trackedInteractions = new Map<
    AbortController,
    { readonly executionId?: string | undefined; readonly arrivedUnscoped: boolean }
  >()
  private activePermissionRequests = 0

  constructor(private readonly host: AgyTurnInteractionRouterHost) {}

  isExecutionOwned(meta: {
    readonly executionId?: string | undefined
    readonly arrivedUnscoped: boolean
  }): boolean {
    const activeRun = this.host.getActiveRun()
    if (!activeRun) return true
    if (meta.executionId !== undefined) {
      if (activeRun.knownForeignExecutionIds.has(meta.executionId)) return false
      if (
        activeRun.providerExecutionId !== undefined &&
        activeRun.providerExecutionId !== meta.executionId
      ) {
        return false
      }
    }
    if (
      meta.arrivedUnscoped &&
      activeRun.providerExecutionId === undefined &&
      activeRun.foreignTurnActiveUntilRootBound
    ) {
      return false
    }
    return true
  }

  cancelDisowned(): void {
    for (const [ctrl, meta] of this.trackedInteractions) {
      if (!this.isExecutionOwned(meta)) {
        ctrl.abort()
      }
    }
  }

  abortAll(): void {
    for (const ctrl of this.interactionControllers) {
      ctrl.abort()
    }
    this.interactionControllers.clear()
    this.trackedInteractions.clear()
  }

  handleOrderedServerRequest(params: {
    readonly connection: AgyAcpConnection
    readonly canonicalCwd: string
    readonly permissionWait: NativePermissionWait
    readonly req: Extract<AgyIngress, { kind: 'server_request' }>
  }): boolean {
    const { connection, canonicalCwd, permissionWait, req } = params
    const { method, rpcId, message } = req
    if (method !== 'session/request_permission' && method !== 'elicitation/create') {
      void connection
        .respondError(rpcId, 'Unsupported Antigravity ACP server request.', -32_601)
        .catch(() => undefined)
      return false
    }
    const rawParams = Reflect.get(message, 'params')
    const paramsObjectValid = isPlainObject(rawParams)
    const reqParams = paramsObjectValid ? rawParams : {}
    const activeRun = this.host.getActiveRun()
    const promptCutoffSeq = this.host.getPromptCutoffSeq()

    if (
      activeRun?.promptRpcCompleted ||
      activeRun?.promptReplyReceived ||
      (promptCutoffSeq !== undefined && req.seq > promptCutoffSeq)
    ) {
      if (method === 'session/request_permission') {
        const rejectOnce = findRejectOnceOptionId(reqParams.options)
        void connection
          .respond(
            rpcId,
            rejectOnce
              ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
              : { outcome: { outcome: 'cancelled' } },
          )
          .catch(() => undefined)
      } else {
        void connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
      }
      return true
    }

    const resolvedSessionId = this.host.getResolvedSessionId()
    const validated = validateAgyFrame(
      req,
      resolvedSessionId,
      this.host.mcpServer.pinnedTrajectory,
      this.host.mcpServer.minStepIdx,
    )
    const unscopedForeign = Boolean(
      activeRun &&
      activeRun.providerExecutionId === undefined &&
      activeRun.foreignTurnActiveUntilRootBound &&
      validated.executionId === undefined,
    )
    const identityContradicted =
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      unscopedForeign ||
      (validated.executionId !== undefined &&
        activeRun?.providerExecutionId !== undefined &&
        validated.executionId !== activeRun.providerExecutionId) ||
      (validated.executionId !== undefined &&
        Boolean(activeRun?.knownForeignExecutionIds.has(validated.executionId)))

    const permRequestInvalid =
      method === 'session/request_permission' &&
      (!paramsObjectValid ||
        identityContradicted ||
        validated.tokens.hasInvalidToken ||
        validated.tokens.hasConflictingTokens ||
        validated.toolCallIdInvalid ||
        validated.argsEvidence.kind === 'invalid_or_conflict' ||
        (validated.statusPresent &&
          (validated.statusInvalid ||
            validated.status === 'completed' ||
            validated.status === 'failed' ||
            validated.status === 'cancelled')))
    const elicitRequestInvalid =
      method === 'elicitation/create' &&
      (!paramsObjectValid ||
        identityContradicted ||
        validated.tokens.hasInvalidToken ||
        validated.tokens.hasConflictingTokens)

    let preBuiltPermissionCard: ReturnType<typeof buildAgyPermissionCard> | undefined
    let permissionCardValid = false
    if (method === 'session/request_permission' && !permRequestInvalid) {
      try {
        preBuiltPermissionCard = buildAgyPermissionCard(reqParams, canonicalCwd)
        permissionCardValid = true
      } catch {
        permissionCardValid = false
      }
    }

    let preParsedElicitationRequest: NativeUserInputRequest | undefined
    let elicitationPayloadValid = false
    let elicitationParseErrorMessage: string | undefined
    if (method === 'elicitation/create' && !elicitRequestInvalid) {
      try {
        preParsedElicitationRequest = agyElicitationRequest(reqParams)
        elicitationPayloadValid = true
      } catch (error) {
        elicitationPayloadValid = false
        elicitationParseErrorMessage =
          error instanceof Error ? error.message : 'Unsupported Antigravity elicitation schema.'
      }
    }

    const requestValidForAcceptance =
      method === 'session/request_permission'
        ? !permRequestInvalid && permissionCardValid
        : !elicitRequestInvalid && elicitationPayloadValid

    if (
      requestValidForAcceptance &&
      activeRun &&
      this.host.isRootFirstByteWritten() &&
      !activeRun.turnAccepted &&
      !activeRun.promptReplyReceived &&
      !this.host.isRootTerminal() &&
      !this.host.isReplayingHistory()
    ) {
      const executorId = this.host.getActiveExecutorId()
      activeRun.turnAccepted = true
      this.host.kernel.recordDispatch('accepted', activeRun.nativeSessionId, executorId)
      this.host.runtime.recordEvidence(
        this.host.input,
        activeRun.nativeSessionId,
        executorId,
        { kind: 'running', source: 'live_runtime' },
        activeRun.nativeTurnId,
      )
      this.host.pushPendingEvent({
        agentId: 'agy',
        type: 'turn.started',
        turnId: this.host.input.runId,
      })
    }

    const interactionMeta = {
      executionId: validated.executionId,
      arrivedUnscoped: validated.executionId === undefined,
    }
    const registerInteraction = (ctrl: AbortController): void => {
      this.interactionControllers.add(ctrl)
      this.trackedInteractions.set(ctrl, interactionMeta)
    }
    const unregisterInteraction = (ctrl: AbortController): void => {
      this.interactionControllers.delete(ctrl)
      this.trackedInteractions.delete(ctrl)
    }
    const isExecutionStillOwned = (): boolean => this.isExecutionOwned(interactionMeta)

    if (method === 'session/request_permission') {
      this.host.runtime.projector
        .handlePermissionRequest({
          connection,
          validated,
          rpcId,
          params: reqParams,
          paramsObjectValid,
          unscopedDuringForeignTurn: unscopedForeign,
          preBuiltCard: preBuiltPermissionCard,
          cwd: canonicalCwd,
          input: this.host.input,
          activeRun,
          getSessionId: this.host.getResolvedSessionId,
          mcpServer: this.host.mcpServer,
          tools: this.host.tools,
          approvedBrainPlanCalls: this.host.approvedBrainPlanCalls,
          onBrainPlanWriteApproved: this.host.onBrainPlanWriteApproved,
          readOnlyStage: this.host.readOnlyStage,
          planModeStage: this.host.planModeStage,
          permissionMode: this.host.permissionMode,
          permissionWait,
          getActiveCount: () => this.activePermissionRequests,
          adjustActiveCount: (delta) => {
            this.activePermissionRequests += delta
          },
          interactionControllers: this.interactionControllers,
          isExecutionStillOwned,
          registerInteraction,
          unregisterInteraction,
          pushEvent: this.host.pushPendingEvent,
          signal: this.host.signal,
        })
        .catch(() => undefined)
      return true
    }

    if (!elicitRequestInvalid && !elicitationPayloadValid) {
      void connection
        .respondError(
          rpcId,
          elicitationParseErrorMessage ?? 'Unsupported Antigravity elicitation schema.',
          -32_602,
        )
        .catch(() => undefined)
      return true
    }

    this.host.runtime.projector
      .handleElicitationRequest({
        connection,
        validated,
        rpcId,
        params: reqParams,
        paramsObjectValid,
        unscopedDuringForeignTurn: unscopedForeign,
        preParsedRequest: preParsedElicitationRequest,
        input: this.host.input,
        activeRun,
        askOnlyStage: this.host.askOnlyStage,
        readOnlyNonInteractive: this.host.readOnlyNonInteractive,
        permissionWait,
        interactionControllers: this.interactionControllers,
        isExecutionStillOwned,
        registerInteraction,
        unregisterInteraction,
        pushEvent: this.host.pushPendingEvent,
        signal: this.host.signal,
      })
      .catch(() => undefined)
    return true
  }
}
