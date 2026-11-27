import type { Socket as NetSocket } from 'node:net'

import { randomUUID } from 'node:crypto'
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http'

import {
  resolveAgentCollaborationSourceCapability,
  type AgentCollaborationSourceCapability,
  type AgentCollaborationSourceReader,
  type AgentOpenPlanFinalIntent,
} from '@pact/agent-runtime'
import {
  COLLABORATION_PAGE_BYTES,
  COLLABORATION_PLAN_CHUNK_BYTES,
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  buildBoundedNativePlanId,
  codexCollaborationSourceWireReadSchema,
  collaborationActor,
  collaborationInputOutcomeAllowed,
  collaborationInputResultSchema,
  collaborationOpenPlanPublishAllowed,
  collaborationPlanRetentionAllowed,
  collaborationPlanRetentionInputSchema,
  collaborationPublishPlanInputSchema,
  collaborationReviewInputSchema,
  collaborationSourceAnyReadSchema,
  collaborationSourceNativeReadSchema,
  collaborationSourceWireReadSchema,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
  peerRequestToolInputSchema,
  sessionTitleInputSchema,
  type CollaborationSourceReadResult,
  type CollaborationTask,
  type CollaborationTurnAuthorization,
  type RuntimeAgentId,
} from '@pact/contracts'

import { AgentExecutionError } from '../agent-execution-error'
import {
  buildCollaborationSourceToolDescription,
  collaborationInputResultAllowed,
  collaborationInputResultDescription,
  collaborationInputResultReceiptText,
  collaborationPlanRetentionReceiptText,
  collaborationReviewMode,
} from '../collaboration-prompt'
import {
  NativeSourceReadFailure,
  readFrozenSourceTool,
  readNativeFrozenSourceTool,
} from '../frozen-source-reader'
import { safeNativePermissionText } from '../native-permission-wait'
import {
  PEER_ASSISTANCE_RECORDED_RESULT,
  PEER_ASSISTANCE_TOOL_DESCRIPTION,
} from '../peer-assistance-policy'
import {
  buildCompactArgsFingerprint,
  canonicalizeProgressToken,
  parseRootProgressToken,
  type AcpToolCallAdmissionResult,
  type PromotedMcpOutcome,
  type RootProofCheckResult,
} from './frame-validator'
import { McpCallCorrelator } from './mcp-correlator'
import {
  AGY_MCP_CLOSE_TIMEOUT_MS,
  AGY_MCP_CORRELATION_WAIT_MS,
  AGY_MCP_HEADERS_TIMEOUT_MS,
  AGY_MCP_MAX_CONCURRENT_REQUESTS,
  AGY_MCP_MAX_CONCURRENT_SOCKETS,
  AGY_MCP_REQUEST_BYTES,
  AGY_MCP_REQUEST_TIMEOUT_MS,
  asString,
  buildAgyPactMcpServerName,
  isPlainObject,
  type CompactArgsFingerprint,
  type McpJsonRpcRequest,
} from './types'

export interface AgyMcpServerConfig {
  runId: string
  getNativeSessionId: () => string | undefined
  getExecutorId: () => string
  getExecutionId?: () => string | undefined
  getRootStepIdx: () => number | undefined
  hasZeroTurnStepBoundary: () => boolean
  tryLoadHostTrajectoryId?: () => Promise<
    { readonly trajectoryId: string; readonly stepCount: number } | undefined
  >
  bindingGeneration: number
  isRootCurrent: () => boolean
  isSourceCurrent: () => boolean
  workflow: CollaborationTask | undefined
  authorization: CollaborationTurnAuthorization | undefined
  requestSessionTitle: boolean
  peerAssistanceAllowed: boolean
  peerTargetAgentId: Exclude<RuntimeAgentId, 'agy'> | undefined
  sourceGrant: { runId: string; grant: string } | undefined
  sourceReader: AgentCollaborationSourceReader | undefined
  legacySourceReader: ((input: unknown) => CollaborationSourceReadResult) | undefined
  isPlanRetentionCurrent: () => boolean
  recordOpenPlanFinalIntent?: ((intent: AgentOpenPlanFinalIntent) => boolean | void) | undefined
  reserveCorrelationBytes?: (nextBytes: number) => boolean
}

/**
 * Per-Run loopback Streamable HTTP MCP server enforcing Antigravity's four-tuple root verification:
 * 1. `_meta['antigravity.google/root_conversation_id'] === activeRoot.nativeSessionId` AND
 *    `_meta['antigravity.google/conversation_id'] === activeRoot.nativeSessionId`
 * 2. Valid monotonic one-shot `_meta.progressToken` strictly owned 1-to-1 by one root trajectory/step & call
 * 3. Active `(executorId, bindingGeneration, runId)` after root prompt start and before root settlement
 * 4. Exact owner-keyed `tool_call` completion in `session/update` with matching args before promoting state.
 */
export class AgyRunMcpServer {
  readonly serverName: string
  private readonly token = randomUUID().replaceAll('-', '')
  private http: HttpServer | undefined
  private readonly activeSockets = new Set<NetSocket>()
  private httpClosed = false
  private activeRequests = 0
  private activeSourceReads = 0
  private readonly correlator: McpCallCorrelator
  readonly sourceCapability: AgentCollaborationSourceCapability
  readonly allowedToolNames = new Set<string>()

  constructor(private readonly config: AgyMcpServerConfig) {
    this.serverName = buildAgyPactMcpServerName(config.runId)
    this.correlator = new McpCallCorrelator(
      config.reserveCorrelationBytes,
      () => config.getRootStepIdx() ?? (config.hasZeroTurnStepBoundary() ? 0 : undefined),
    )
    this.sourceCapability = resolveAgentCollaborationSourceCapability({
      readCollaborationSourcePart: config.legacySourceReader,
      collaborationSourceReader: config.sourceReader,
    })
    if (this.sourceCapability.tier !== 'none') {
      this.allowedToolNames.add('read_collaboration_source')
    }
    if (config.requestSessionTitle) {
      this.allowedToolNames.add('publish_session_title')
    }
    if (config.peerAssistanceAllowed && !config.workflow) {
      this.allowedToolNames.add('request_peer_assistance')
    }
    if (collaborationReviewMode(config.workflow, config.authorization)) {
      this.allowedToolNames.add('submit_review')
    }
    if (collaborationInputResultAllowed(config.workflow, config.authorization)) {
      this.allowedToolNames.add('submit_input_result')
    }
    if (collaborationPlanRetentionAllowed(config.workflow, config.authorization)) {
      this.allowedToolNames.add('retain_current_plan')
    }
    if (
      collaborationOpenPlanPublishAllowed(config.workflow, config.authorization) &&
      typeof config.recordOpenPlanFinalIntent === 'function'
    ) {
      this.allowedToolNames.add('publish_plan')
    }
  }

  get hasTools(): boolean {
    return this.allowedToolNames.size > 0
  }

  get hasAcknowledgedFinalOpenPlan(): boolean {
    return this.correlator.hasAcknowledgedFinalOpenPlan
  }

  get pinnedTrajectory(): string | undefined {
    return this.correlator.pinnedTrajectory
  }

  get minStepIdx(): number | undefined {
    return (
      this.config.getRootStepIdx() ??
      this.correlator.minHostStepIdx ??
      (this.config.hasZeroTurnStepBoundary() ? 0 : undefined)
    )
  }

  isRootActive(): boolean {
    return !this.correlator.isClosed && !this.correlator.isRevoked && this.config.isRootCurrent()
  }

  disallowLazyStorageDbPin(): void {
    this.correlator.disallowLazyStorageDbPin()
  }

  beginWakeBatch(): void {
    this.correlator.beginWakeBatch()
  }

  endWakeBatch(): void {
    this.correlator.endWakeBatch()
  }

  notifyRootProofUpdated(): void {
    this.correlator.notifyRootProofUpdated()
  }

  clearPendingTransferredPlanBytes(): void {
    this.correlator.clearPendingTransferredPlanBytes()
  }

  revokeRun(): void {
    this.correlator.revokeRun()
  }

  observeNonMcpProgressToken(token: unknown): void {
    this.correlator.observeNonMcpProgressToken(token)
  }

  pinHostTrajectoryId(trajectoryId: string, stepCount?: number): void {
    this.correlator.pinHostTrajectoryId(trajectoryId, stepCount)
  }

  pinRootTrajectoryId(trajectoryId: string): void {
    this.correlator.pinRootTrajectoryId(trajectoryId)
  }

  lookupVerifiedCallToolName(toolCallId: string): string | undefined {
    const tool = this.correlator.lookupVerifiedCallToolName(toolCallId)
    return tool !== undefined ? `mcp_${this.serverName}_${tool}` : undefined
  }

  observeNonPactCall(toolCallId: string | undefined, allCanonicalTokens: readonly string[]): void {
    this.correlator.observeNonPactCall(toolCallId, allCanonicalTokens)
  }

  revokeDisputedTokens(
    toolCallId: string | undefined,
    allCanonicalTokens: readonly string[],
  ): void {
    this.correlator.revokeDisputedTokens(toolCallId, allCanonicalTokens)
  }

  revokeAcpToolCall(toolCallId?: string, rawProgressToken?: unknown): void {
    this.correlator.revokeAcpToolCall(toolCallId, rawProgressToken)
  }

  revokeIfKnownMcpCall(toolCallId: string, rawProgressToken?: unknown): void {
    this.correlator.revokeIfKnownMcpCall(toolCallId, rawProgressToken)
  }

  observeAcpToolCall(entry: {
    toolCallId: string
    rawToolName: string
    status: string
    invalidStatus?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    invalidArgs?: boolean | undefined
    progressToken?: unknown
    disputedTokens?: readonly string[] | undefined
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
  }): AcpToolCallAdmissionResult {
    const authorized = this.isAuthorizedMcpToolCallName(entry.rawToolName)
    if (!authorized) {
      const tokens: string[] = [...(entry.disputedTokens ?? [])]
      if (entry.progressToken !== undefined) {
        const parsed = canonicalizeProgressToken(entry.progressToken)
        if (parsed && !tokens.includes(parsed.canonical)) {
          tokens.push(parsed.canonical)
        }
      }
      this.correlator.observeNonPactCall(entry.toolCallId, tokens)
      return 'already_retired'
    }
    return this.correlator.observeAcpToolCall({
      toolCallId: entry.toolCallId,
      toolName: authorized.tool,
      status: entry.status,
      ...(entry.invalidStatus !== undefined ? { invalidStatus: entry.invalidStatus } : {}),
      ...(entry.args !== undefined ? { args: entry.args } : {}),
      ...(entry.argsFingerprint !== undefined ? { argsFingerprint: entry.argsFingerprint } : {}),
      ...(entry.invalidArgs !== undefined ? { invalidArgs: entry.invalidArgs } : {}),
      ...(entry.progressToken !== undefined ? { progressToken: entry.progressToken } : {}),
      ...(entry.disputedTokens !== undefined ? { disputedTokens: entry.disputedTokens } : {}),
      ...(entry.invalidProgressToken !== undefined
        ? { invalidProgressToken: entry.invalidProgressToken }
        : {}),
      ...(entry.trajectoryId !== undefined ? { trajectoryId: entry.trajectoryId } : {}),
      ...(entry.stepIdx !== undefined ? { stepIdx: entry.stepIdx } : {}),
      ...(entry.rootEvidenceContradicted !== undefined
        ? { rootEvidenceContradicted: entry.rootEvidenceContradicted }
        : {}),
    })
  }

  promoteCompletedAcpToolCall(info: {
    toolCallId: string
    rawToolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): PromotedMcpOutcome | undefined {
    const authorized = this.isAuthorizedMcpToolCallName(info.rawToolName)
    if (!authorized) return undefined
    return this.correlator.promoteCompletedAcpToolCall({
      toolCallId: info.toolCallId,
      toolName: authorized.tool,
      ...(info.progressToken !== undefined ? { progressToken: info.progressToken } : {}),
      ...(info.invalidProgressToken !== undefined
        ? { invalidProgressToken: info.invalidProgressToken }
        : {}),
      ...(info.args !== undefined ? { args: info.args } : {}),
      ...(info.argsFingerprint !== undefined ? { argsFingerprint: info.argsFingerprint } : {}),
      ...(info.trajectoryId !== undefined ? { trajectoryId: info.trajectoryId } : {}),
      ...(info.stepIdx !== undefined ? { stepIdx: info.stepIdx } : {}),
      ...(info.rootEvidenceContradicted !== undefined
        ? { rootEvidenceContradicted: info.rootEvidenceContradicted }
        : {}),
      ...(info.receivedAfterPromptReply !== undefined
        ? { receivedAfterPromptReply: info.receivedAfterPromptReply }
        : {}),
    })
  }

  failAcpToolCall(info: {
    toolCallId: string
    rawToolName: string
    progressToken?: unknown
  }): void {
    const authorized = this.isAuthorizedMcpToolCallName(info.rawToolName)
    if (!authorized) return
    this.correlator.failAcpToolCall({
      toolCallId: info.toolCallId,
      toolName: authorized.tool,
      ...(info.progressToken !== undefined ? { progressToken: info.progressToken } : {}),
    })
  }

  private peerTargetEnum(): ReadonlyArray<Exclude<RuntimeAgentId, 'agy'>> {
    return this.config.peerTargetAgentId ? [this.config.peerTargetAgentId] : ['claude', 'codex']
  }

  formatToolUsageInstructions(): string {
    const contracts: string[] = []
    const prefix = `mcp_${this.serverName}_`
    if (this.allowedToolNames.has('read_collaboration_source')) {
      const legacyForm =
        '{ runId: uuid, grant: uuid, source: "document"|"batch"|"inputs"|"handoff_sources"|"cutoff", offset: integer, document?: object, batchId?: uuid, cutoffId?: uuid, part?: "catalog"|"message"|"comments"|"comment", messageId?: uuid, commentId?: uuid }'
      const sourceRefForm = '{ sourceReference: string, offset: integer }'
      const nativeRootForm =
        '{ context: "native-root-v1", source: "document"|"batch"|"root_batch"|"root_document"|"inputs"|"handoff_sources"|"cutoff", offset: integer, part?: "body"|"user_information"|"clarification_answer"|"comment"|"catalog"|"message"|"comments", ordinal?: integer, document?: object, batchId?: uuid, cutoffId?: uuid, messageId?: uuid, commentId?: uuid }'
      const supportedForms: string[] = []
      if (this.sourceCapability.sourceReference) supportedForms.push(sourceRefForm)
      if (this.sourceCapability.nativeRoot) supportedForms.push(nativeRootForm)
      if (this.sourceCapability.legacy) supportedForms.push(legacyForm)
      contracts.push(`${prefix}read_collaboration_source(${supportedForms.join(' | ')})`)
    }
    if (this.allowedToolNames.has('publish_session_title')) {
      contracts.push(`${prefix}publish_session_title({ title: string(1..120) })`)
    }
    if (this.allowedToolNames.has('request_peer_assistance')) {
      const targetUnion = this.peerTargetEnum()
        .map((target) => JSON.stringify(target))
        .join('|')
      contracts.push(
        `${prefix}request_peer_assistance({ target: ${targetUnion}, kind: "supplement"|"fact_check"|"challenge"|"review", reason? })`,
      )
    }
    if (this.allowedToolNames.has('submit_review')) {
      contracts.push(
        `${prefix}submit_review({ verdict: "accepted"|"changes_requested"|"needs_user"|"incomplete", questions?: [{ prompt: string, selection: "single"|"multiple", options?: [{ label: string, description?: string }] }] })`,
      )
    }
    if (this.allowedToolNames.has('submit_input_result')) {
      contracts.push(
        `${prefix}submit_input_result({ outcome: "processed"|"needs_user"|"explanation_only", questions?: [{ prompt: string, selection: "single"|"multiple", options?: [{ label: string, description?: string }] }] })`,
      )
    }
    if (this.allowedToolNames.has('retain_current_plan')) {
      contracts.push(`${prefix}retain_current_plan({})`)
    }
    if (this.allowedToolNames.has('publish_plan')) {
      contracts.push(
        `${prefix}publish_plan({ text: string, offset?: integer, complete?: boolean })`,
      )
    }
    return `Registered Pact MCP tools on "${this.serverName}": ${contracts.join('; ')}. Call these MCP tools directly using the contracts above; never call read_file on <appDataDir>/mcp paths or run shell commands to inspect MCP directories.`
  }

  isAuthorizedMcpToolCallName(rawToolName: string): { tool: string } | undefined {
    const underscorePrefix = `mcp_${this.serverName}_`
    const slashPrefix = `${this.serverName}/`
    const doubleUnderscorePrefix = `mcp__${this.serverName}__`
    const suffix = rawToolName.startsWith(underscorePrefix)
      ? rawToolName.slice(underscorePrefix.length)
      : rawToolName.startsWith(doubleUnderscorePrefix)
        ? rawToolName.slice(doubleUnderscorePrefix.length)
        : rawToolName.startsWith(slashPrefix)
          ? rawToolName.slice(slashPrefix.length)
          : undefined
    if (!suffix || !this.allowedToolNames.has(suffix)) return undefined
    return { tool: suffix }
  }

  async start(): Promise<{ type: 'http'; name: string; url: string; headers: never[] }> {
    const server = createServer((req, res) => {
      this.handleHttp(req, res)
    })
    server.headersTimeout = AGY_MCP_HEADERS_TIMEOUT_MS
    server.requestTimeout = AGY_MCP_REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = 2_000
    server.on('connection', (socket) => {
      if (this.httpClosed || this.activeSockets.size >= AGY_MCP_MAX_CONCURRENT_SOCKETS) {
        socket.destroy()
        return
      }
      this.activeSockets.add(socket)
      socket.setTimeout(AGY_MCP_REQUEST_TIMEOUT_MS, () => {
        socket.destroy()
      })
      socket.once('close', () => {
        this.activeSockets.delete(socket)
      })
    })
    this.http = server
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen)
        resolveListen()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.close()
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Could not bind loopback Pact MCP server for Antigravity.',
        false,
      )
    }
    return {
      type: 'http',
      name: this.serverName,
      url: `http://127.0.0.1:${address.port}/${this.token}`,
      headers: [],
    }
  }

  async close(deadlineMs = AGY_MCP_CLOSE_TIMEOUT_MS): Promise<void> {
    this.httpClosed = true
    this.correlator.close()
    const server = this.http
    this.http = undefined
    if (!server) return
    server.closeIdleConnections?.()
    for (const socket of this.activeSockets) {
      socket.destroy()
    }
    this.activeSockets.clear()
    server.closeAllConnections?.()
    await new Promise<void>((resolveClose) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveClose()
      }
      const timer = setTimeout(
        () => {
          for (const socket of this.activeSockets) {
            socket.destroy()
          }
          this.activeSockets.clear()
          server.closeAllConnections?.()
          finish()
        },
        Math.max(50, deadlineMs),
      )
      timer.unref?.()
      server.close(() => finish())
    })
  }

  private handleHttp(request: import('node:http').IncomingMessage, response: ServerResponse): void {
    if (request.url !== `/${this.token}`) {
      response.writeHead(404).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    const declaredBytes = Number(request.headers['content-length'] ?? 0)
    if (!Number.isFinite(declaredBytes) || declaredBytes > AGY_MCP_REQUEST_BYTES) {
      response.writeHead(413).end()
      return
    }
    if (this.activeRequests >= AGY_MCP_MAX_CONCURRENT_REQUESTS) {
      response.writeHead(429).end()
      return
    }
    this.activeRequests += 1
    const chunks: Buffer[] = []
    let bytes = 0
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      this.activeRequests = Math.max(0, this.activeRequests - 1)
    }
    const timeout = setTimeout(() => request.destroy(), AGY_MCP_REQUEST_TIMEOUT_MS)
    let processing = false
    request.once('close', () => {
      if (!processing && !request.complete) settle()
    })
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > AGY_MCP_REQUEST_BYTES) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', () => {
      processing = true
      void (async () => {
        let rpc: McpJsonRpcRequest
        try {
          const decodedBody = new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          )
          const parsed: unknown = JSON.parse(decodedBody)
          if (
            !isPlainObject(parsed) ||
            parsed.jsonrpc !== '2.0' ||
            typeof parsed.method !== 'string'
          ) {
            throw new Error('Invalid MCP request.')
          }
          const rawId = parsed.id
          let validId: string | number | undefined
          if ('id' in parsed) {
            if (typeof rawId !== 'string' && typeof rawId !== 'number') {
              throw new Error('Invalid MCP request ID.')
            }
            validId = rawId
          }
          rpc = {
            jsonrpc: '2.0',
            method: parsed.method,
            ...(validId !== undefined ? { id: validId } : {}),
            ...('params' in parsed ? { params: parsed.params } : {}),
          }
        } catch {
          this.replyJson(response, {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32_700, message: 'Invalid MCP request.' },
          })
          settle()
          return
        }
        if (rpc.id === undefined) {
          if (!response.destroyed && !response.writableEnded) {
            response.writeHead(202).end()
          }
          settle()
          return
        }
        try {
          const result = await this.dispatchRpc(rpc)
          this.replyJson(response, { jsonrpc: '2.0', id: rpc.id, result })
        } catch (error) {
          this.replyJson(response, {
            jsonrpc: '2.0',
            id: rpc.id,
            error: {
              code: -32_602,
              message: safeNativePermissionText(
                error instanceof Error ? error.message : 'MCP tool invocation failed.',
                512,
              ),
            },
          })
        } finally {
          settle()
        }
      })()
    })
  }

  private replyJson(response: ServerResponse, body: object): void {
    if (response.destroyed || response.writableEnded) return
    const payload = Buffer.from(JSON.stringify(body), 'utf8')
    response
      .writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(payload.byteLength),
      })
      .end(payload)
  }

  private async dispatchRpc(rpc: McpJsonRpcRequest): Promise<object> {
    if (rpc.method === 'initialize') {
      return {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: this.serverName, version: '1.0.0' },
        instructions: this.formatToolUsageInstructions(),
      }
    }
    if (rpc.method === 'ping') {
      return {}
    }
    if (rpc.method === 'tools/list') {
      return { tools: this.describeTools() }
    }
    if (rpc.method === 'tools/call') {
      return this.callTool(rpc.params)
    }
    throw new Error(`Unsupported MCP method: ${rpc.method}`)
  }

  private buildSourceToolInputSchema(): object {
    const cap = this.sourceCapability
    if (cap.nativeRoot && cap.sourceReference && cap.legacy) {
      return codexCollaborationSourceWireReadSchema.toJSONSchema()
    }
    if (!cap.nativeRoot && cap.sourceReference && cap.legacy) {
      return collaborationSourceWireReadSchema.toJSONSchema()
    }
    const sourceRefOnlySchema: Record<string, unknown> = {
      type: 'object',
      properties: {
        sourceReference: { type: 'string', minLength: 1, maxLength: 2048 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['sourceReference', 'offset'],
      additionalProperties: false,
    }
    if (cap.sourceReference && !cap.nativeRoot && !cap.legacy) {
      return sourceRefOnlySchema
    }
    if (cap.nativeRoot && !cap.sourceReference && !cap.legacy) {
      return collaborationSourceNativeReadSchema.toJSONSchema()
    }
    if (cap.legacy && !cap.sourceReference && !cap.nativeRoot) {
      return collaborationSourceAnyReadSchema.toJSONSchema()
    }
    const variants: object[] = []
    if (cap.sourceReference) variants.push(sourceRefOnlySchema)
    if (cap.nativeRoot) {
      const { $schema: _ignoredNativeSchema, ...nativeVariant } =
        collaborationSourceNativeReadSchema.toJSONSchema() as Record<string, unknown>
      variants.push(nativeVariant)
    }
    if (cap.legacy) {
      const { $schema: _ignoredLegacySchema, ...legacyVariant } =
        collaborationSourceAnyReadSchema.toJSONSchema() as Record<string, unknown>
      variants.push(legacyVariant)
    }
    return { anyOf: variants }
  }

  private describeTools(): object[] {
    const tools: object[] = []
    if (this.allowedToolNames.has('read_collaboration_source')) {
      const inputSchema = this.buildSourceToolInputSchema()
      tools.push({
        name: 'read_collaboration_source',
        description: buildCollaborationSourceToolDescription(this.sourceCapability),
        inputSchema,
      })
    }
    if (this.allowedToolNames.has('publish_session_title')) {
      tools.push({
        name: 'publish_session_title',
        description:
          'Supply a concise title during this same root Turn; never starts another model or edits the project.',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string', minLength: 1, maxLength: 120 } },
          required: ['title'],
          additionalProperties: false,
        },
      })
    }
    if (this.allowedToolNames.has('request_peer_assistance')) {
      const targetEnum = [...this.peerTargetEnum()]
      tools.push({
        name: 'request_peer_assistance',
        description: PEER_ASSISTANCE_TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            target: { type: 'string', enum: targetEnum },
            kind: {
              type: 'string',
              enum: ['supplement', 'fact_check', 'challenge', 'review'],
            },
            reason: { type: 'string', maxLength: 240 },
          },
          required: ['target', 'kind'],
          additionalProperties: false,
        },
      })
    }
    if (this.allowedToolNames.has('submit_review')) {
      tools.push({
        name: 'submit_review',
        description:
          'Submit the current independent review conclusion after writing its natural-language report. needs_user requires 1 to 3 explicit questions with selection ("single"|"multiple") and optional options ([{ label, description? }]); other verdicts must omit questions. Only the current root reviewer can submit; this never starts another turn or permits project edits.',
        inputSchema: collaborationReviewInputSchema.toJSONSchema(),
      })
    }
    if (this.allowedToolNames.has('submit_input_result')) {
      tools.push({
        name: 'submit_input_result',
        description: collaborationInputResultDescription,
        inputSchema: collaborationInputResultSchema.toJSONSchema(),
      })
    }
    if (this.allowedToolNames.has('retain_current_plan')) {
      tools.push({
        name: 'retain_current_plan',
        description:
          'Explicitly retain the existing frozen official plan when no plan text change is needed.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })
    }
    if (this.allowedToolNames.has('publish_plan')) {
      tools.push({
        name: 'publish_plan',
        description:
          'Publish an updated Plan Markdown version in open collaboration mode (<= 48 KiB UTF-8 per chunk).',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            complete: { type: 'boolean' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      })
    }
    return tools
  }

  private async verifyFourTupleRoot(
    toolName: string,
    rawArgs: unknown,
    meta: unknown,
  ): Promise<
    | {
        ok: true
        nativeSessionId: string
        progressToken: string
        ownerKey: string
        httpFingerprint: CompactArgsFingerprint
      }
    | { ok: false; error: string }
  > {
    const expectedSessionId = this.config.getNativeSessionId()
    const executorId = this.config.getExecutorId()
    const isCurrent = (): boolean =>
      toolName === 'read_collaboration_source'
        ? this.config.isSourceCurrent()
        : this.config.isRootCurrent()
    if (
      this.correlator.isClosed ||
      this.correlator.isRevoked ||
      !isCurrent() ||
      !expectedSessionId ||
      !executorId ||
      this.config.bindingGeneration <= 0 ||
      !this.config.runId
    ) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (!isPlainObject(meta)) {
      return { ok: false, error: 'Missing Antigravity MCP _meta root authentication.' }
    }
    const rootConvId = asString(meta['antigravity.google/root_conversation_id'])
    const rawLegacyRootConvId = Object.hasOwn(meta, 'root_conversation_id')
      ? meta.root_conversation_id
      : undefined
    const agyConvId = asString(meta['antigravity.google/conversation_id'])
    const rawLegacyConvId = Object.hasOwn(meta, 'conversation_id')
      ? meta.conversation_id
      : undefined
    if (
      !rootConvId ||
      rootConvId !== expectedSessionId ||
      (rawLegacyRootConvId !== undefined && rawLegacyRootConvId !== expectedSessionId)
    ) {
      return {
        ok: false,
        error: 'The MCP call root_conversation_id does not match the active Antigravity session.',
      }
    }
    if (
      !agyConvId ||
      agyConvId !== expectedSessionId ||
      (rawLegacyConvId !== undefined && rawLegacyConvId !== expectedSessionId)
    ) {
      return {
        ok: false,
        error: 'Delegated subagent conversations cannot invoke root-scoped Pact tools.',
      }
    }
    const parsedPt = parseRootProgressToken(meta.progressToken)
    if (!parsedPt) {
      return {
        ok: false,
        error:
          'Missing or invalid structured <trajectoryId>:<stepIdx> Antigravity MCP progressToken.',
      }
    }
    const canonicalPt = parsedPt.canonical
    const { trajectoryId, stepIdx } = parsedPt.structured

    const httpFingerprint = buildCompactArgsFingerprint(
      isPlainObject(rawArgs) ? rawArgs : {},
      false,
    )
    if (!httpFingerprint) {
      return {
        ok: false,
        error: 'Antigravity MCP arguments exceed structured correlation limits.',
      }
    }

    const inFlightAdmission = this.correlator.beginInFlightToken(canonicalPt, httpFingerprint)
    if (!inFlightAdmission.ok) {
      return inFlightAdmission
    }
    try {
      const deadlineAt = Date.now() + AGY_MCP_CORRELATION_WAIT_MS
      const hasProvenBoundary =
        this.config.getRootStepIdx() !== undefined ||
        this.correlator.minHostStepIdx !== undefined ||
        this.config.hasZeroTurnStepBoundary()
      if (
        this.correlator.pinnedTrajectory === undefined &&
        hasProvenBoundary &&
        this.correlator.canLazyPinStorageDb
      ) {
        const hostIdentity = await this.config.tryLoadHostTrajectoryId?.()
        if (this.correlator.isClosed || this.correlator.isRevoked || !isCurrent()) {
          return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
        }
        if (hostIdentity) {
          this.correlator.pinHostTrajectoryId(hostIdentity.trajectoryId, undefined)
        }
      }

      const checkRootProof = (): RootProofCheckResult => {
        const minStepIdx =
          this.config.getRootStepIdx() ??
          this.correlator.minHostStepIdx ??
          (this.config.hasZeroTurnStepBoundary() ? 0 : undefined)
        if (minStepIdx !== undefined && (!Number.isSafeInteger(stepIdx) || stepIdx < minStepIdx)) {
          return {
            kind: 'reject',
            error: 'Antigravity MCP progressToken precedes the active root Turn step boundary.',
          }
        }
        if (
          this.correlator.pinnedTrajectory !== undefined &&
          trajectoryId !== this.correlator.pinnedTrajectory
        ) {
          return {
            kind: 'reject',
            error:
              'Antigravity MCP progressToken does not match an ACP-authenticated root trajectory.',
          }
        }
        if (minStepIdx === undefined || this.correlator.pinnedTrajectory === undefined) {
          return 'wait'
        }
        return 'ok'
      }

      const claimed = await this.correlator.claimOrWaitForHttp(
        toolName,
        httpFingerprint,
        canonicalPt,
        isCurrent,
        checkRootProof,
        Math.max(0, deadlineAt - Date.now()),
      )
      if (!claimed.ok) {
        return claimed
      }
      return {
        ok: true,
        nativeSessionId: expectedSessionId,
        progressToken: canonicalPt,
        ownerKey: claimed.ownerKey,
        httpFingerprint,
      }
    } finally {
      this.correlator.releaseInFlightToken(canonicalPt)
    }
  }

  private async callTool(params: unknown): Promise<object> {
    if (!isPlainObject(params) || typeof params.name !== 'string') {
      return this.toolError('Invalid MCP tool call parameters.')
    }
    const toolName = params.name
    if (!this.allowedToolNames.has(toolName)) {
      return this.toolError(`Tool ${toolName} is not authorized for this turn.`)
    }
    const rawArgs = params.arguments ?? {}
    const auth = await this.verifyFourTupleRoot(toolName, rawArgs, Reflect.get(params, '_meta'))
    if (!auth.ok) {
      return this.toolError(auth.error)
    }
    const rejectClaimedTool = (message: string): object => {
      this.correlator.consumeRejectedClaim(auth.progressToken)
      return this.toolError(message)
    }
    const isCurrent = (): boolean =>
      toolName === 'read_collaboration_source'
        ? this.config.isSourceCurrent()
        : this.config.isRootCurrent()
    const liveClaim = this.correlator.revalidateLiveClaim(
      auth.progressToken,
      toolName,
      auth.httpFingerprint,
      isCurrent,
    )
    if (!liveClaim.ok) {
      return rejectClaimedTool(liveClaim.error)
    }

    if (toolName === 'read_collaboration_source') {
      if (!this.config.sourceGrant) {
        return rejectClaimedTool('No source capability is bound to this root.')
      }
      if (this.activeSourceReads >= 2) {
        return rejectClaimedTool('Concurrent source reads exceeded the per-root limit.')
      }
      this.activeSourceReads += 1
      try {
        const nativeReq = collaborationSourceNativeReadSchema.safeParse(rawArgs)
        if (nativeReq.success && !this.sourceCapability.nativeRoot) {
          return rejectClaimedTool(
            'Native-root source reads are not supported by this source reader.',
          )
        }
        const hasSourceRefArg = isPlainObject(rawArgs) && 'sourceReference' in rawArgs
        if (!nativeReq.success && hasSourceRefArg && !this.sourceCapability.sourceReference) {
          return rejectClaimedTool(
            'Source-reference reads are not supported by this source reader.',
          )
        }
        if (!nativeReq.success && !hasSourceRefArg && !this.sourceCapability.legacy) {
          return rejectClaimedTool('Legacy source reads are not supported by this source reader.')
        }
        const page =
          nativeReq.success && this.sourceCapability.nativeRoot && this.config.sourceReader
            ? readNativeFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                this.config.sourceReader,
                { threadId: auth.nativeSessionId, turnId: this.config.runId },
              )
            : readFrozenSourceTool(
                this.config.sourceGrant,
                rawArgs,
                hasSourceRefArg
                  ? this.sourceCapability.sourceReference
                    ? this.config.sourceReader
                    : undefined
                  : this.sourceCapability.legacy
                    ? this.config.sourceReader
                    : undefined,
                !hasSourceRefArg && this.sourceCapability.legacy
                  ? this.config.legacySourceReader
                  : undefined,
              )
        const serialized = JSON.stringify(page)
        if (Buffer.byteLength(serialized, 'utf8') > COLLABORATION_PAGE_BYTES * 2) {
          return rejectClaimedTool('Source page exceeded its bounded transport size.')
        }
        return { content: [{ type: 'text', text: serialized }] }
      } catch (error) {
        const message =
          error instanceof NativeSourceReadFailure || error instanceof Error
            ? error.message
            : 'Source read failed.'
        return rejectClaimedTool(safeNativePermissionText(message, 512))
      } finally {
        this.activeSourceReads = Math.max(0, this.activeSourceReads - 1)
      }
    }

    if (toolName === 'publish_session_title') {
      if (this.correlator.isTitleSlotTaken) {
        return rejectClaimedTool('A session title was already submitted in this turn.')
      }
      const parsed = sessionTitleInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid Session title.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'title', title: parsed.data.title },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return {
        content: [{ type: 'text', text: 'Title validated. Continue your substantive answer.' }],
      }
    }

    if (toolName === 'request_peer_assistance') {
      if (this.correlator.isPeerSlotTaken) {
        return rejectClaimedTool('This answer already has a peer request.')
      }
      const parsed = peerRequestToolInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Peer request arguments are invalid.')
      }
      const target = parsed.data.target
      if (target === 'agy') {
        return rejectClaimedTool('An Agent can only request the other Pact Agent.')
      }
      if (this.config.peerTargetAgentId && target !== this.config.peerTargetAgentId) {
        return rejectClaimedTool('An Agent can only request the active peer Agent in this session.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        {
          type: 'peer',
          targetAgentId: target,
          proposalKind: parsed.data.kind,
          ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
        },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: PEER_ASSISTANCE_RECORDED_RESULT }] }
    }

    if (toolName === 'submit_review') {
      const task = this.config.workflow
      const authorization = this.config.authorization
      const stage = authorization?.stage ?? task?.stage
      const actor = authorization?.actor ?? task?.actor
      if (
        !task ||
        !stage ||
        !['plan_review', 'code_review'].includes(stage) ||
        actor !== collaborationActor(task, stage)
      ) {
        return rejectClaimedTool('This turn is not authorized to submit a review verdict.')
      }
      const parsed = collaborationReviewInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid review verdict payload.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'review', observation: parsed.data },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return {
        content: [
          {
            type: 'text',
            text: 'Verdict validated. Include a non-empty natural-language review report in your assistant response before ending this root turn; Pact will bind it after normal completion.',
          },
        ],
      }
    }

    if (toolName === 'submit_input_result') {
      const task = this.config.workflow
      const authorization = this.config.authorization
      const parsed = collaborationInputResultSchema.safeParse(rawArgs)
      if (
        !task ||
        !parsed.success ||
        !collaborationInputOutcomeAllowed(task, authorization, parsed.data.outcome)
      ) {
        return rejectClaimedTool('This root is not authorized to submit that input result.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'input_result', observation: parsed.data },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: collaborationInputResultReceiptText }] }
    }

    if (toolName === 'retain_current_plan') {
      if (
        !this.config.isPlanRetentionCurrent() ||
        !collaborationPlanRetentionInputSchema.safeParse(rawArgs).success
      ) {
        return rejectClaimedTool(
          'Plan retention is unavailable because the plan was modified or retention arguments were invalid.',
        )
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        { type: 'retain_plan' },
        isCurrent,
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      return { content: [{ type: 'text', text: collaborationPlanRetentionReceiptText }] }
    }

    if (toolName === 'publish_plan') {
      if (this.correlator.isOpenPlanFinalizedOrPendingFinal) {
        return rejectClaimedTool('A published Plan has already been finalized in this root turn.')
      }
      const parsed = collaborationPublishPlanInputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return rejectClaimedTool('Invalid publish_plan payload.')
      }
      const chunkBytes = Buffer.from(parsed.data.text, 'utf8')
      if (chunkBytes.byteLength > COLLABORATION_PLAN_CHUNK_BYTES) {
        return rejectClaimedTool('Plan chunk exceeds 48 KiB UTF-8 limit.')
      }
      const expectedOffset =
        this.correlator.confirmedPlanByteCount + this.correlator.pendingPlanBufferBytes()
      const offset = parsed.data.offset ?? 0
      if (offset !== expectedOffset) {
        return rejectClaimedTool(`Expected byte offset ${expectedOffset}, received ${offset}.`)
      }
      const nextTotalBytes = expectedOffset + chunkBytes.byteLength
      if (nextTotalBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
        return rejectClaimedTool('Published Plan exceeds maximum byte capacity.')
      }
      const complete = parsed.data.complete ?? parsed.data.offset === undefined
      if (!complete && chunkBytes.byteLength === 0) {
        return rejectClaimedTool('Non-final Plan chunk cannot be empty.')
      }
      if (this.correlator.pendingPlanChunkCount >= 64) {
        return rejectClaimedTool('Too many pending Plan chunks in this turn.')
      }
      const chunkHasNonWhitespace = /\S/u.test(parsed.data.text)
      if (complete && !this.correlator.hasNonWhitespacePlanContent(chunkHasNonWhitespace)) {
        return rejectClaimedTool('Published Plan Markdown cannot be empty.')
      }
      const staged = this.correlator.stageOutcome(
        auth,
        toolName,
        {
          type: 'publish_plan_chunk',
          offset,
          byteLength: chunkBytes.byteLength,
          complete,
        },
        isCurrent,
        { offset, bytes: chunkBytes, hasNonWhitespace: chunkHasNonWhitespace, complete },
      )
      if (!staged.ok) {
        return rejectClaimedTool(staged.error)
      }
      if (complete) {
        const candidateMarkdown = this.correlator.assembleCandidateOpenPlanMarkdown(staged.ownerKey)
        if (!candidateMarkdown) {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            'All preceding Plan chunks must complete before finalizing publish_plan.',
          )
        }
        if (typeof this.config.recordOpenPlanFinalIntent !== 'function') {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            'Open-mode plan publication requires a configured durable intent persistence callback.',
          )
        }
        const executionId = this.config.getExecutionId?.()
        const boundedCallKey = encodeBoundedOpenPlanCallKey(staged.ownerKey)
        const boundedProgressToken = encodeBoundedOpenPlanProgressToken(auth.progressToken)
        const nativePlanId = staged.ownerKey.startsWith('call:')
          ? buildBoundedNativePlanId(auth.nativeSessionId, staged.ownerKey.slice('call:'.length))
          : undefined
        try {
          const persisted = this.config.recordOpenPlanFinalIntent({
            ...(executionId ? { executionId } : {}),
            callKey: boundedCallKey,
            progressToken: boundedProgressToken,
            ...(nativePlanId ? { nativePlanId } : {}),
            candidateMarkdown,
          })
          if (persisted !== true) {
            throw new Error('Open-mode plan publish intent persistence was rejected.')
          }
        } catch (error) {
          this.correlator.rollbackFailedFinalOpenPlanIntent(staged.ownerKey, auth.progressToken)
          return this.toolError(
            safeNativePermissionText(
              error instanceof Error
                ? error.message
                : 'Failed to persist open-mode plan publish intent.',
              512,
            ),
          )
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: complete
              ? 'Updated Plan staged. Pact will publish it once this root turn completes.'
              : `Accepted Plan chunk (${nextTotalBytes} bytes).`,
          },
        ],
      }
    }

    return rejectClaimedTool('Unsupported Pact MCP tool.')
  }

  private toolError(message: string): object {
    return {
      content: [{ type: 'text', text: message }],
      isError: true,
    }
  }
}
