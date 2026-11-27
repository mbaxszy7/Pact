import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  AgentNativeCheckContext,
  AgentNativeCheckOperation,
  AgentNativeProbeInput,
  AgentRunInput,
  AgentShutdownSettlement,
  AgentSourceReadForm,
  NativePermissionRequester,
  NativeUserInputRequester,
} from '@pact/agent-runtime'
import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  NativeEvidenceIdentity,
  NativeProbeResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
  SessionPermissionMode,
} from '@pact/contracts'

import {
  NATIVE_TERMINAL_FAILURE_MAX_CHARS,
  sanitizeNativeTerminalFailure,
} from '@pact/agent-runtime'
import { peerRequestToolInputSchema, type NativePermissionRequest } from '@pact/contracts'

import type { LogicalIpcWorkerTraffic } from '../../../shared/logical-ipc-traffic'
import type {
  CodexAppServerConnection,
  CodexConnectionDiagnostics,
} from '../codex-app-server-connection'
import type { NativeCheckOperation } from '../native-check-operation'
import type { NativeForkFiles } from '../native-fork-files'
import type { NativeMemoryReservation } from '../native-working-memory'
import type { PactPeerToolServer } from '../pact-peer-tool-server'

import { AgentActivityDetail } from '../agent-activity-detail'
import { AgentAnswerAssembler } from '../agent-answer-assembler'
import { AgentExecutionError, classifyAgentError } from '../agent-execution-error'

export interface CodexSettingsBarrier {
  readonly executorId: string
  readonly threadId: string
  readonly done: Promise<void>
}

export interface CodexRelayPermissionInput {
  readonly host?: never
  readonly requestPermission?: NativePermissionRequester | undefined
  readonly requestUserInput?: NativeUserInputRequester | undefined
  readonly permissionMode?: SessionPermissionMode | undefined
  readonly promptEnvelope?: AgentRunInput['promptEnvelope'] | undefined
}

export interface CodexAdapterRuntime {
  readonly id: 'codex'
  readonly executablePath: string
  readonly processFactory?: CodexProcessFactory | undefined
  readonly nativeReadOptions: { storageRoot?: string }
  readonly ipcTraffic?: LogicalIpcWorkerTraffic | undefined
  readonly resolvePeerTarget?: ((sessionId: string) => RuntimeAgentId | undefined) | undefined
  latestExecutorId: string
  readonly evidenceCacheWork: NativeMemoryReservation
  readonly terminalEvidence: Map<string, Extract<NativeProbeResult, { kind: 'ended' }>>
  readonly nativeRebuildReceipts: Map<string, NativeRebuildReceipt>
  connection: CodexAppServerConnection | undefined
  connectionStarting: { key: string; task: Promise<CodexAppServerConnection> } | undefined
  featureProbe: { stop: () => void; task: Promise<string[]> } | undefined
  closingConnection: Promise<void> | undefined
  processCwd: string | undefined
  processStorageRoot: string | undefined
  processEnvironmentKey: string | undefined
  connectionProcess: ChildProcessWithoutNullStreams | undefined
  nativeInspection:
    | {
        controller: AbortController
        connection: CodexAppServerConnection | undefined
        task: Promise<unknown>
      }
    | undefined
  initialized: boolean
  turnSpeedOverrideSupported: boolean
  nativeSourceContextSupported: boolean
  running: boolean
  disposed: boolean
  disposal: Promise<void> | undefined
  shutdownDeadlineAt: number | undefined
  readonly loadedThreadIds: Set<string>
  readonly loadedThreadConfigurations: Map<string, CodexRunConfiguration>
  connectionPeerTarget: RuntimeAgentId | undefined
  currentPeerTarget: RuntimeAgentId
  skillCatalogChanged: (() => void) | undefined
  readonly peerToolServer: PactPeerToolServer
  peerServerName: string
  readonly nativeBackground: Set<NativeBackground>
  readonly pendingSettingsBarriers: Map<string, CodexSettingsBarrier>
  readonly retiredNativeTurns: Set<string>
  readonly retiredNativeChildren: Set<string>
  idleTimer: ReturnType<typeof setTimeout> | undefined
  uncertainTitleExecutor: string | undefined
  readonly nativeForkFiles: NativeForkFiles
  readonly nativeCheck: NativeCheckOperation
  readonly nativeForkOwners: Map<string, CodexNativeForkOwner>
  readonly executorId: string
  withSourceCallable(instructions: string): string
  beginNativeCheck<T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<T>
  hasActiveBackgroundWork(runId?: string): boolean
  describeBackgroundWork(owner: NativeBackground): 'working' | 'stoppable' | undefined
  trackNativeBackground(
    background: NativeBackground,
    item: object,
    ownerThreadId?: string,
    ownerTurnId?: string,
  ): void
  settleNativeBackground(background: NativeBackground): void
  preflightPrompt(input: AgentRunInput): void
  discoverSkills(
    cwd: string,
    signal: AbortSignal,
  ): Promise<import('@pact/contracts').SkillBinding[]>
  runIdentity(
    input: Pick<AgentRunInput, 'sessionId' | 'runId' | 'bindingGeneration'>,
    nativeSessionId: string,
    nativeTurnId?: string,
  ): NativeEvidenceIdentity
  admitEvidenceCache(): void
  recordTerminal(
    input: AgentRunInput,
    nativeSessionId: string,
    nativeTurnId: string,
    outcome: 'completed' | 'failed' | 'interrupted',
    answer: { outputId: string; text: string },
    workflow?: {
      plan?: { nativeId: string; text: string } | undefined
      reviewResult?: CollaborationReviewObservation | undefined
      inputResult?: CollaborationInputObservation | undefined
    },
  ): void
  readonly connections: CodexConnectionManagerPort
  readonly lifecycle: CodexLifecycleCoordinatorPort
}

export interface CodexConnectionManagerPort {
  rememberThread(threadId: string, configuration?: CodexRunConfiguration): void
  diagnostics(): CodexConnectionDiagnostics
  closeAdapter(shutdown?: AgentShutdownSettlement): Promise<void>
  relayPermission(
    connection: CodexAppServerConnection,
    request: object,
    method: string,
    params: object,
    input: CodexRelayPermissionInput,
    threadId: string | undefined,
    turnId: string | undefined,
    signal: AbortSignal,
    handled: Set<string>,
    items: Map<string, ApprovalItem>,
  ): Promise<void>
  ensureConnection(
    cwd: string,
    peerTarget?: RuntimeAgentId,
    preserveThreadId?: string,
  ): Promise<CodexAppServerConnection>
  resolveTurnSpeed(
    connection: CodexAppServerConnection,
    requested: AgentRunInput['speed'],
    model: string | null | undefined,
    signal: AbortSignal,
    deadlineAt: number,
  ): Promise<{ serviceTier?: 'priority' | 'default'; detail?: string }>
  initializeConnection(connection: CodexAppServerConnection, signal: AbortSignal): Promise<void>
  detachConnection(connection: CodexAppServerConnection): void
  closeConnection(connection: CodexAppServerConnection, error: Error): Promise<void>
  scheduleIdleDisconnect(): void
  interruptForegroundCommands(
    background: NativeBackground,
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    commands: Map<string, string | undefined>,
    signal?: AbortSignal,
    backgroundOnly?: boolean,
  ): Promise<void>
  pactToolConfig(
    connection: CodexAppServerConnection,
    peerToolUrl: string,
    cwd: string,
    signal: AbortSignal,
    permissionMode?: SessionPermissionMode,
  ): Promise<{
    config: object
    nativePolicy: object
    settingsPolicy?: object | undefined
  }>
  injectedProcess(cwd: string): Promise<{
    child: ChildProcessWithoutNullStreams
    close: ((deadlineAt?: number) => Promise<void>) | undefined
    physicalWitness?: (
      ownerId: string,
    ) => Promise<import('@pact/contracts').DecisionPhysicalWitness>
  }>
  startProcess(
    cwd: string,
    storageRoot?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{
    child: ChildProcessWithoutNullStreams
    close: (deadlineAt?: number) => Promise<void>
    physicalWitness: (ownerId: string) => Promise<import('@pact/contracts').DecisionPhysicalWitness>
  }>
  awaitSettingsBarrier(
    connection: CodexAppServerConnection,
    threadId: string,
    signal: AbortSignal,
  ): Promise<boolean>
  applyPermissionSettings(
    connection: CodexAppServerConnection,
    threadId: string,
    policy: object | undefined,
    signal: AbortSignal,
    baselineMessage?: object,
    background?: NativeBackground,
    onBarrierSettled?: () => void,
  ): Promise<object>
}

export function extractCodexRpcErrorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined
  const message = Reflect.get(error, 'message')
  return typeof message === 'string' ? message : undefined
}

export function formatCodexRpcErrorMessage(error: unknown, fallback: string, prefix = ''): string {
  const rawMessage = extractCodexRpcErrorMessage(error)
  let detail = rawMessage ? sanitizeNativeTerminalFailure(rawMessage) : ''
  if (!detail && error && typeof error === 'object' && !Array.isArray(error)) {
    const code = Reflect.get(error, 'code')
    if (typeof code === 'number' && Number.isSafeInteger(code)) {
      detail = `RPC error ${code}`
    }
  }
  const body = detail || sanitizeNativeTerminalFailure(fallback) || 'Codex request failed.'
  if (!prefix) return body
  return sanitizeNativeTerminalFailure(`${prefix}${body}`, NATIVE_TERMINAL_FAILURE_MAX_CHARS)
}

export function classifyCodexRpcError(
  error: unknown,
  fallback: string,
  prefix = '',
): AgentExecutionError {
  const rawMessage = extractCodexRpcErrorMessage(error)
  const sanitized = formatCodexRpcErrorMessage(error, fallback, prefix)
  const classified = classifyAgentError(new Error(rawMessage ?? sanitized))
  if (classified.kind !== 'agent_process_crash') {
    return new AgentExecutionError(classified.kind, sanitized, classified.retryable)
  }
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const info = Reflect.get(error, 'codexErrorInfo')
    const infoText =
      typeof info === 'string'
        ? info
        : info && typeof info === 'object' && !Array.isArray(info)
          ? Object.keys(info).join(' ')
          : ''
    if (infoText) {
      const lower = infoText.toLowerCase()
      if (lower.includes('contextwindow') || lower.includes('context_window')) {
        return new AgentExecutionError('context_limit', sanitized, false)
      }
      if (
        lower.includes('usagelimit') ||
        lower.includes('usage_limit') ||
        lower.includes('ratelimit')
      ) {
        return new AgentExecutionError('quota_or_rate_limit', sanitized, false)
      }
      if (lower.includes('unauth')) {
        return new AgentExecutionError('authentication_required', sanitized, false)
      }
    }
  }
  return new AgentExecutionError(classified.kind, sanitized, classified.retryable)
}

export interface CodexLifecycleCoordinatorPort {
  rememberNativeRebuild(id: string, value: NativeRebuildReceipt): void
  settleNativeRebuild(id: string): void
  readWindowsDefaultPermissionSettings(
    live: CodexAppServerConnection,
    targetThreadId: string,
    signal: AbortSignal,
  ): Promise<object>
}

export function relayPermissionInputFromRun(input: AgentRunInput): CodexRelayPermissionInput {
  return {
    requestPermission: input.host?.interactions?.requestPermission,
    requestUserInput: input.host?.interactions?.requestUserInput,
    permissionMode: input.permissionMode,
    promptEnvelope: input.promptEnvelope,
  }
}

export const IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000
export const MAX_LOADED_THREADS = 8
export const MAX_LOADED_THREAD_BYTES = 64 * 1024
export const CODEX_INJECT_TARGET_BYTES = 768 * 1024
export const CODEX_FEATURE_PROBE_TIMEOUT_MS = 2_000
export const CODEX_FEATURE_PROBE_EXIT_MS = 1_000
export const CODEX_FEATURE_PROBE_BYTES = 64 * 1024
export const CODEX_FEATURE_PROBE_LINES = 256
export const CODEX_STOP_TIMEOUT_MS = 5_000
export const CODEX_STOP_COMMANDS = 64
export const CODEX_STOP_IDENTITY_BYTES = 64 * 1024
export const CODEX_STOP_DISCOVERY_BYTES = 256 * 1024
export const CODEX_INITIALIZATION_TIMEOUT_MS = 10_000
export const CODEX_THREAD_RPC_TIMEOUT_MS = 15_000
export const CODEX_TURN_ACCEPT_TIMEOUT_MS = 30_000
export const CODEX_TITLE_TIMEOUT_MS = 2_000

export function codexCapabilityError(message: string): AgentExecutionError {
  return new AgentExecutionError('runtime_incompatible', message, false)
}

export interface CodexRunConfiguration {
  model: string
  effort: string | null
  peerTargetAgentId?: RuntimeAgentId | undefined
}

export type OwnedCodexProcess = {
  child: ChildProcessWithoutNullStreams
  close: (deadlineAt?: number) => Promise<void>
}
export type CodexProcessFactory = (
  cwd: string,
) => ChildProcessWithoutNullStreams | OwnedCodexProcess | Promise<OwnedCodexProcess>

export interface EarlyNativeFact {
  event: object
  bytes: number
  heldBytes: number
  reservation: NativeMemoryReservation
}

export interface NativeBackground {
  input: AgentRunInput
  sourceGrant?: { runId: string; grant: string } | undefined
  sourceReadForm?: AgentSourceReadForm
  /** Proven ancestry survives a child Turn ending: that child may have spawned grandchildren. */
  parents: Map<string, string>
  threads: Set<string>
  operations: Set<string>
  spawns: Set<string>
  interactions: Set<Promise<void>>
  early: EarlyNativeFact[]
  earlyBytes: number
  earlyTimer?: ReturnType<typeof setTimeout> | undefined
  observation: AbortController
  foregroundReleased: boolean
  rootTerminal: boolean
  rootNotStarted: boolean
  /** A host admission fence proved that this root input reached no native byte. */
  rootInputWithheld?: boolean
  reportedUnknown: boolean
  untrackedWork: boolean
  /** An observation gap, not merely a foreground consumer ending before the native root. */
  unknown: boolean
  closed: boolean
  release?: (() => void) | undefined
  primaryThreadId?: string | undefined
  primaryTurnId?: string | undefined
  turns: Map<string, string>
  turnIds: Set<string>
  recordings: Set<Promise<void>>
  recordingTail: Promise<void>
  // Current foreground Root only, <=64 identities / 64 KiB. Abort transfers
  // this selection to one bounded cancellation, never adding later work.
  foregroundCommands: Map<string, string | undefined>
  foregroundCommandBytes: number
  cancellationPending: boolean
  /** One exact child Stop in flight; the native observer owns its terminal fact. */
  interruptingChild?: { threadId: string; turnId: string; terminal: boolean } | undefined
  connection?: CodexAppServerConnection
  steering?: boolean
  steeringDone?: Promise<void>
  steerInputIds: Set<string>
  steeringInput?: { id: string; consumed: boolean } | undefined
}

export interface ApprovalItem {
  paths: string[]
  complete: boolean
  command?: string | undefined
  cwd?: string | undefined
}

export interface CodexNativeForkOwner {
  executorId: string
  nativeSessionId?: string
  pending: boolean
  release: () => void
  observation: AbortController
  settle: () => Promise<boolean>
}

export interface NativeRebuildReceipt {
  nativeSessionId: string
  sourceHash?: string
  seedHash?: string
  chunkCount?: number
  executorId: string
  cwd: string
  allSeedAcknowledged: boolean
  pending: boolean
  observation?: AbortController
  release?: () => void
  interactions?: Set<Promise<void>>
  startupHooks?: { pending: Set<string>; unconfirmed: boolean }
}

export function nativeProfileLines(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const lines: string[] = []
  if (Object.keys(value).some((key) => key !== 'fileSystem' && key !== 'network')) return undefined
  const network = Reflect.get(value, 'network')
  if (network != null) {
    if (
      typeof network !== 'object' ||
      (Reflect.get(network, 'enabled') != null &&
        typeof Reflect.get(network, 'enabled') !== 'boolean') ||
      Object.keys(network).some((key) => key !== 'enabled')
    )
      return undefined
    if (Reflect.get(network, 'enabled') != null)
      lines.push(`Network enabled: ${Reflect.get(network, 'enabled')}`)
  }
  const files = Reflect.get(value, 'fileSystem')
  if (files != null) {
    if (
      typeof files !== 'object' ||
      Object.keys(files).some(
        (key) => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key),
      )
    )
      return undefined
    for (const access of ['read', 'write']) {
      const paths = Reflect.get(files, access)
      if (paths == null) continue
      if (
        !Array.isArray(paths) ||
        paths.length > 32 ||
        !paths.every((path) => typeof path === 'string')
      )
        return undefined
      for (const path of paths) lines.push(`Filesystem ${access}: ${path}`)
    }
    const entries = Reflect.get(files, 'entries')
    if (entries != null) {
      if (!Array.isArray(entries) || entries.length > 32) return undefined
      for (const entry of entries) {
        if (
          !entry ||
          typeof entry !== 'object' ||
          Object.keys(entry).some((key) => !['access', 'path'].includes(key))
        )
          return undefined
        const access = Reflect.get(entry, 'access'),
          path = Reflect.get(entry, 'path')
        if (
          !['read', 'write', 'deny'].includes(String(access)) ||
          !path ||
          typeof path !== 'object'
        )
          return undefined
        const type = Reflect.get(path, 'type')
        if (
          Object.keys(path).some(
            (key) =>
              ![
                'type',
                type === 'path' ? 'path' : type === 'glob_pattern' ? 'pattern' : 'value',
              ].includes(key),
          )
        )
          return undefined
        const raw =
          type === 'path'
            ? Reflect.get(path, 'path')
            : type === 'glob_pattern'
              ? Reflect.get(path, 'pattern')
              : undefined
        if (typeof raw === 'string') lines.push(`Filesystem ${access} ${type}: ${raw}`)
        else if (type === 'special') {
          const special = Reflect.get(path, 'value')
          if (!special || typeof special !== 'object') return undefined
          const kind = Reflect.get(special, 'kind')
          if (
            typeof kind !== 'string' ||
            !['root', 'minimal', 'project_roots', 'tmpdir', 'slash_tmp', 'unknown'].includes(kind)
          )
            return undefined
          lines.push(`Filesystem ${access} special scope: ${kind}`)
          const selected = Reflect.get(special, 'path')
          if (selected != null && typeof selected !== 'string') return undefined
          if (typeof selected === 'string') lines.push(`Scope path: ${selected}`)
          const subpath = Reflect.get(special, 'subpath')
          if (subpath != null && typeof subpath !== 'string') return undefined
          if (typeof subpath === 'string') lines.push(`Scope subpath: ${subpath}`)
          if (Object.keys(special).some((key) => !['kind', 'path', 'subpath'].includes(key)))
            return undefined
        } else return undefined
      }
    }
    const depth = Reflect.get(files, 'globScanMaxDepth')
    if (depth != null) {
      if (typeof depth !== 'number' || !Number.isSafeInteger(depth)) return undefined
      lines.push(`Glob scan maximum depth: ${depth}`)
    }
  }
  return lines
}

/** Native response templates never cross IPC; each displayed action maps to this request's exact value. */
export function codexApprovalActions(
  params: object,
  mode: 'command' | 'file' | 'permissions',
  legacy: boolean,
  completeScope: string | undefined,
  targetComplete = true,
): { actions: NonNullable<NativePermissionRequest['actions']>; responses: Map<string, object> } {
  const actions: NonNullable<NativePermissionRequest['actions']> = []
  const responses = new Map<string, object>()
  const add = (
    action: Omit<NonNullable<NativePermissionRequest['actions']>[number], 'id'>,
    response: object,
  ): void => {
    if (actions.length >= 8) throw new Error('Native approval action budget exceeded.')
    const id = `native-${actions.length}`
    actions.push({ id, ...action })
    responses.set(id, response)
  }
  if (mode === 'permissions') {
    const profile = Reflect.get(params, 'permissions')
    add({ label: 'Deny permissions', kind: 'decline' }, { permissions: {}, scope: 'turn' })
    if (!targetComplete) return { actions, responses }
    add(
      {
        label: 'Allow for this turn',
        kind: 'allow',
        ...(completeScope ? { scope: completeScope } : {}),
      },
      { permissions: profile, scope: 'turn' },
    )
    if (completeScope) {
      add(
        {
          label: 'Allow for this session…',
          kind: 'rule',
          scope: completeScope,
          confirmation: 'Grant exactly these permissions for later turns in this native session.',
        },
        { permissions: profile, scope: 'session' },
      )
    }
    return { actions, responses }
  }
  const grantRoot = Reflect.get(params, 'grantRoot')
  const reason = Reflect.get(params, 'reason')
  const network = Reflect.get(params, 'networkApprovalContext')
  let decisions: unknown[]
  const available = Reflect.get(params, 'availableDecisions')
  if (!targetComplete) decisions = ['decline', 'cancel']
  else if (mode === 'file')
    decisions = [
      'accept',
      ...(grantRoot == null && reason == null && completeScope ? ['acceptForSession'] : []),
      'decline',
      'cancel',
    ]
  else if (available != null) {
    if (!Array.isArray(available) || available.length > 8)
      throw new Error('Invalid native available decisions.')
    decisions = available
  } else if (network != null) decisions = ['accept', 'acceptForSession', 'cancel']
  else decisions = ['accept', 'cancel']
  // Persistent command/network amendments are not offered by Pact. An unknown
  // native decision is never relabelled as a one-call or Session approval.
  for (const decision of decisions) {
    if (decision === 'accept') {
      // grantRoot has unstable native semantics: never relabel a broad root grant as a one-time file approval.
      if (mode === 'file' && grantRoot != null) continue
      if (
        Reflect.get(params, 'kind') === 'writeStdin' &&
        typeof Reflect.get(params, 'command') !== 'string'
      )
        continue
      add(
        {
          label:
            mode === 'file'
              ? 'Allow these file changes'
              : network
                ? 'Allow this network request'
                : Reflect.get(params, 'kind') === 'writeStdin'
                  ? 'Allow terminal input'
                  : 'Allow this command',
          kind: 'allow',
        },
        { decision: legacy ? 'approved' : decision },
      )
    } else if (decision === 'acceptForSession') {
      if (!completeScope || (mode === 'file' && (grantRoot != null || reason != null))) continue
      add(
        {
          label: 'Allow for this session…',
          kind: 'rule',
          scope: completeScope,
          confirmation:
            'Codex may reuse this approval for the displayed scope in this native session.',
        },
        { decision: legacy ? 'approved_for_session' : decision },
      )
    } else if (decision === 'decline') {
      add(
        { label: 'Decline and continue', kind: 'decline' },
        {
          decision: legacy
            ? { denied: { rejection: 'The user declined this request.' } }
            : decision,
        },
      )
    } else if (decision === 'cancel') {
      add({ label: 'Cancel this turn', kind: 'cancel' }, { decision: legacy ? 'abort' : decision })
    }
  }
  return { actions, responses }
}

export function cacheApprovalItem(
  items: Map<string, ApprovalItem>,
  item: object,
  threadId: unknown,
  turnId: unknown,
): void {
  const id = Reflect.get(item, 'id')
  if (
    typeof id !== 'string' ||
    id.length > 1024 ||
    typeof threadId !== 'string' ||
    threadId.length > 1024 ||
    typeof turnId !== 'string' ||
    turnId.length > 1024
  )
    return
  const key = JSON.stringify([threadId, turnId, id])
  if (!items.has(key) && items.size >= 128) return
  const changes = Reflect.get(item, 'changes')
  const paths: string[] = []
  let complete = Array.isArray(changes) && changes.length <= 256
  if (complete && Array.isArray(changes)) {
    for (const entry of changes) {
      if (!entry || typeof entry !== 'object') {
        complete = false
        break
      }
      const path = Reflect.get(entry, 'path'),
        kind = Reflect.get(entry, 'kind')
      if (
        !kind ||
        typeof kind !== 'object' ||
        !['add', 'delete', 'update'].includes(String(Reflect.get(kind, 'type')))
      ) {
        complete = false
        break
      }
      const destination =
        kind && typeof kind === 'object' ? Reflect.get(kind, 'move_path') : undefined
      if (
        typeof path !== 'string' ||
        !path ||
        path.length > 4096 ||
        (destination != null &&
          (typeof destination !== 'string' || !destination || destination.length > 4096))
      ) {
        complete = false
        break
      }
      paths.push(path)
      if (typeof destination === 'string') paths.push(destination)
    }
  }
  const command = Reflect.get(item, 'command'),
    cwd = Reflect.get(item, 'cwd')
  const next: ApprovalItem = {
    paths: complete ? [...new Set(paths)] : [],
    complete,
    ...(typeof command === 'string' && command.length <= 4096 ? { command } : {}),
    ...(typeof cwd === 'string' && cwd.length <= 4096 ? { cwd } : {}),
  }
  // One Run owns <=128 entries / 1 MiB; an incomplete target is never approvable.
  const bytes = Buffer.byteLength(JSON.stringify(next))
  const total = [...items].reduce(
    (sum, [entryKey, value]) =>
      sum +
      (entryKey === key
        ? 0
        : Buffer.byteLength(entryKey) + Buffer.byteLength(JSON.stringify(value))),
    0,
  )
  if (total + Buffer.byteLength(key) + 32 > 1024 * 1024) {
    items.delete(key)
    return
  }
  items.set(
    key,
    bytes > 32 * 1024 || total + bytes + Buffer.byteLength(key) > 1024 * 1024
      ? { paths: [], complete: false }
      : next,
  )
}

export function resolveCodexThreadConfiguration(
  input: Pick<AgentRunInput, 'model' | 'effort'>,
  response: { model: string; reasoningEffort?: string | undefined },
): CodexRunConfiguration {
  return {
    model: response.model,
    effort: input.effort ?? response.reasoningEffort ?? null,
  }
}

export function resolveLoadedCodexConfiguration(
  input: Pick<AgentRunInput, 'model' | 'effort'>,
  cached: CodexRunConfiguration,
): CodexRunConfiguration {
  return { model: input.model ?? cached.model, effort: input.effort ?? cached.effort }
}

export function acceptsCodexReroute(
  threadId: string | undefined,
  turnId: string | undefined,
  eventThreadId: unknown,
  eventTurnId: unknown,
): eventThreadId is string {
  return (
    typeof eventThreadId === 'string' &&
    eventThreadId === threadId &&
    typeof eventTurnId === 'string' &&
    (!turnId || eventTurnId === turnId)
  )
}

export function* resolvedModelEvent(configuration: {
  model: string
  effort: string | null
}): Generator<NormalizedAgentEvent> {
  yield {
    agentId: 'codex',
    type: 'run.model.resolved',
    model: configuration.model,
    effort: configuration.effort,
  }
}

export function interruptArgs(inventory: string): string[] {
  let offset = 0,
    count = 0,
    entries = 0,
    host: { enabled: boolean; stage: string } | undefined,
    interruption: { enabled: boolean; stage: string } | undefined
  while (offset < inventory.length) {
    if (++count > CODEX_FEATURE_PROBE_LINES) throw new Error('Too many native features.')
    const end = inventory.indexOf('\n', offset)
    const line = inventory.slice(offset, end < 0 ? undefined : end).trim()
    offset = end < 0 ? inventory.length : end + 1
    if (!line) continue
    const entry =
      /^([a-z0-9][a-z0-9_.-]{0,127})\s+(stable|experimental|under development|removed|deprecated)\s+(true|false)$/u.exec(
        line,
      )
    if (!entry) throw new Error('Invalid native feature.')
    entries += 1
    const feature = { enabled: entry[3] === 'true', stage: entry[2]! }
    if (entry[1] === 'code_mode_host') {
      if (host) throw new Error('Duplicate native host feature.')
      host = feature
    } else if (entry[1] === 'code_mode_interrupt') {
      if (interruption) throw new Error('Duplicate native interruption feature.')
      interruption = feature
    }
  }
  if (!entries) throw new Error('Empty native feature inventory.')
  if (!host?.enabled) return ['app-server']
  if (host.stage === 'removed' || !interruption || interruption.stage === 'removed')
    throw new Error('Native host interruption is unavailable.')
  return ['--enable', 'code_mode_interrupt', 'app-server']
}

export function confirmPermissionMode(message: object, mode?: SessionPermissionMode): void {
  const result = Reflect.get(message, 'result')
  if (!mode || mode === 'native') {
    if (
      !result ||
      Reflect.get(result, 'approvalPolicy') == null ||
      Reflect.get(result, 'approvalsReviewer') == null ||
      !Reflect.get(result, 'sandbox')
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex did not return its actual native permissions. No task was submitted.',
        false,
      )
    return
  }
  const sandbox = result && Reflect.get(result, 'sandbox')
  const actualSandbox = sandbox && Reflect.get(sandbox, 'type')
  if (
    !result ||
    Reflect.get(result, 'approvalPolicy') !== (mode === 'full' ? 'never' : 'on-request') ||
    Reflect.get(result, 'approvalsReviewer') !== (mode === 'auto' ? 'auto_review' : 'user') ||
    (mode === 'full'
      ? actualSandbox !== 'dangerFullAccess'
      : Reflect.get(Reflect.get(result, 'activePermissionProfile') ?? {}, 'id') !== ':workspace')
  )
    throw new AgentExecutionError(
      'runtime_incompatible',
      'Codex did not confirm the selected permission mode. No task was submitted; check native policy or choose another mode.',
      false,
    )
}

export function permissionReadback(message: object): object {
  const result = Reflect.get(message, 'result')
  const profile = Reflect.get(result, 'activePermissionProfile')
  return {
    approvalPolicy: Reflect.get(result, 'approvalPolicy'),
    approvalsReviewer: Reflect.get(result, 'approvalsReviewer'),
    sandboxPolicy: normalizeSandboxPolicy(Reflect.get(result, 'sandbox')),
    permissionProfile:
      profile && typeof profile === 'object' ? (Reflect.get(profile, 'id') ?? null) : null,
  }
}

export function samePermissionPolicy(actual: unknown, expected: object): boolean {
  if (
    !actual ||
    typeof actual !== 'object' ||
    Array.isArray(actual) ||
    Reflect.get(expected, 'approvalPolicy') == null ||
    Reflect.get(expected, 'approvalsReviewer') == null ||
    !isDeepStrictEqual(
      Reflect.get(actual, 'approvalPolicy'),
      Reflect.get(expected, 'approvalPolicy'),
    ) ||
    Reflect.get(actual, 'approvalsReviewer') !== Reflect.get(expected, 'approvalsReviewer')
  )
    return false
  const sandbox = Reflect.get(actual, 'sandboxPolicy')
  if (
    !sandbox ||
    typeof sandbox !== 'object' ||
    Array.isArray(sandbox) ||
    typeof Reflect.get(sandbox, 'type') !== 'string' ||
    !['dangerFullAccess', 'readOnly', 'externalSandbox', 'workspaceWrite'].includes(
      Reflect.get(sandbox, 'type'),
    )
  )
    return false
  const profile = Reflect.get(expected, 'permissions')
  if (typeof profile === 'string' && profile) {
    const activeProfile = Reflect.get(actual, 'activePermissionProfile')
    return (
      activeProfile != null &&
      typeof activeProfile === 'object' &&
      !Array.isArray(activeProfile) &&
      Reflect.get(activeProfile, 'id') === profile
    )
  }
  return (
    Reflect.get(expected, 'sandboxPolicy') != null &&
    Reflect.get(actual, 'sandboxPolicy') != null &&
    sameSandboxPolicy(Reflect.get(actual, 'sandboxPolicy'), Reflect.get(expected, 'sandboxPolicy'))
  )
}

export function sameSandboxPolicy(actual: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(normalizeSandboxPolicy(actual), normalizeSandboxPolicy(expected))
}

export function normalizeSandboxPolicy(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Reflect.get(value, 'type') !== 'workspaceWrite')
    return value
  const roots = Reflect.get(value, 'writableRoots')
  if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string')) return value
  return { ...value, writableRoots: [...new Set(roots)].toSorted() }
}

export function isPeerTool(item: object, serverName: string): boolean {
  return (
    Reflect.get(item, 'type') === 'mcpToolCall' &&
    Reflect.get(item, 'server') === serverName &&
    Reflect.get(item, 'tool') === 'request_peer_assistance'
  )
}

export function peerProposal(
  item: object,
  turnId: string,
  expectedReceipt: string,
  serverName: string,
  expectedTarget: RuntimeAgentId = 'claude',
): Extract<NormalizedAgentEvent, { type: 'peer.assistance.requested' }> | undefined {
  if (
    Reflect.get(item, 'status') !== 'completed' ||
    Reflect.get(item, 'error') !== null ||
    !isPeerTool(item, serverName)
  )
    return undefined
  const input = Reflect.get(item, 'arguments')
  const parsed = peerRequestToolInputSchema.safeParse(input)
  if (!parsed.success || parsed.data.target !== expectedTarget) return undefined
  const result = Reflect.get(item, 'result')
  const structured =
    result && typeof result === 'object' ? Reflect.get(result, 'structuredContent') : undefined
  const receipt =
    structured && typeof structured === 'object'
      ? Reflect.get(structured, 'pactPeerProposal')
      : undefined
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Reflect.get(receipt, 'accepted') !== true ||
    Reflect.get(receipt, 'receipt') !== expectedReceipt
  )
    return undefined
  return {
    agentId: 'codex',
    type: 'peer.assistance.requested',
    turnId,
    proposalId: randomUUID(),
    targetAgentId: parsed.data.target,
    kind: parsed.data.kind,
    ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
  }
}

export function probeIdentity(input: AgentNativeProbeInput): NativeEvidenceIdentity {
  const {
    sessionId,
    agentId,
    runId,
    requestId,
    nativeSessionId,
    nativeTurnId,
    bindingGeneration,
    executorId,
  } = input
  return {
    sessionId,
    agentId,
    requestId,
    nativeSessionId,
    bindingGeneration,
    ...(runId ? { runId } : {}),
    ...(nativeTurnId ? { nativeTurnId } : {}),
    ...(executorId ? { executorId } : {}),
  }
}

export function matchingTurn(turns: unknown, input: AgentNativeProbeInput): object | undefined {
  if (!Array.isArray(turns) || turns.length > 1000) return undefined
  const matches = turns.filter(
    (turn) =>
      turn &&
      typeof turn === 'object' &&
      (input.nativeTurnId
        ? Reflect.get(turn, 'id') === input.nativeTurnId
        : Array.isArray(Reflect.get(turn, 'items')) &&
          Reflect.get(turn, 'items').some(
            (item: unknown) =>
              item &&
              typeof item === 'object' &&
              Reflect.get(item, 'type') === 'userMessage' &&
              Reflect.get(item, 'clientId') === input.requestId,
          )),
  )
  if (matches.length !== 1) return undefined
  return matches[0]
}

export function historicalOutput(
  turns: unknown,
  input: AgentNativeProbeInput,
  terminalComplete = false,
): Extract<NativeProbeResult, { kind: 'no_evidence' }>['output'] {
  const turn = matchingTurn(turns, input)
  if (!turn) return undefined
  const items = Reflect.get(turn, 'items')
  if (!Array.isArray(items)) return undefined
  using answer = new AgentAnswerAssembler(input.requestId)
  let full = terminalComplete && Reflect.get(turn, 'itemsView') === 'full'
  const ids = new Set<string>()
  let plan: { nativeId: string; text: string } | undefined
  for (const item of items) {
    if (!item || typeof item !== 'object' || typeof Reflect.get(item, 'type') !== 'string') {
      full = false
      continue
    }
    const type = Reflect.get(item, 'type'),
      id = Reflect.get(item, 'id'),
      text = Reflect.get(item, 'text')
    if (type === 'agentMessage' || type === 'plan') {
      if (typeof id !== 'string' || !id || typeof text !== 'string' || ids.has(id)) {
        full = false
        continue
      }
      ids.add(id)
      if (type === 'agentMessage') answer.complete(id, text)
      else if (text.trim()) plan = { nativeId: id, text }
    }
  }
  return answer.text || plan
    ? {
        outputId: answer.outputId,
        text: answer.text,
        completeness: full ? 'complete' : 'partial',
        ...(plan ? { plan } : {}),
      }
    : undefined
}

export function storedTurnOutcome(
  turn: object,
): 'completed' | 'failed' | 'interrupted' | undefined {
  const id = Reflect.get(turn, 'id')
  const status = Reflect.get(turn, 'status')
  const completedAt = Reflect.get(turn, 'completedAt')
  const startedAt = Reflect.get(turn, 'startedAt')
  const durationMs = Reflect.get(turn, 'durationMs')
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 1024 ||
    !['completed', 'failed', 'interrupted'].includes(status) ||
    !Number.isSafeInteger(completedAt) ||
    completedAt < 0 ||
    (startedAt != null &&
      (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > completedAt)) ||
    (durationMs != null && (!Number.isSafeInteger(durationMs) || durationMs < 0)) ||
    (status === 'completed' && Reflect.get(turn, 'error') != null)
  )
    return undefined
  return status
}

export function describeTool(
  item: object,
  cwd: string,
  completed: boolean,
):
  | { toolCallId: string; toolName: string; title: string; detail?: string | undefined }
  | undefined {
  const toolCallId = Reflect.get(item, 'id')
  const type = Reflect.get(item, 'type')
  if (typeof toolCallId !== 'string' || typeof type !== 'string') return undefined

  switch (type) {
    case 'commandExecution': {
      const command = stringValue(Reflect.get(item, 'command'))
      return {
        toolCallId,
        toolName: 'command',
        title: completed ? 'Ran a command' : 'Running a command',
        ...(command ? { detail: AgentActivityDetail.redact(command) } : {}),
      }
    }
    case 'fileChange': {
      const changes = Reflect.get(item, 'changes')
      const count = Array.isArray(changes) ? changes.length : 0
      return {
        toolCallId,
        toolName: 'fileChange',
        title: completed ? 'Reviewed file changes' : 'Reviewing file changes',
        ...(count > 0 ? { detail: `${count} ${count === 1 ? 'file' : 'files'}` } : {}),
      }
    }
    case 'mcpToolCall': {
      const tool = stringValue(Reflect.get(item, 'tool')) || 'MCP tool'
      const server = stringValue(Reflect.get(item, 'server'))
      return {
        toolCallId,
        toolName: tool.slice(0, 120),
        title: completed ? `Used ${tool}` : `Using ${tool}`,
        ...(server ? { detail: AgentActivityDetail.redact(server) } : {}),
      }
    }
    case 'dynamicToolCall': {
      const tool = stringValue(Reflect.get(item, 'tool')) || 'tool'
      return {
        toolCallId,
        toolName: tool.slice(0, 120),
        title: completed ? `Used ${tool}` : `Using ${tool}`,
      }
    }
    case 'collabToolCall': {
      const tool = stringValue(Reflect.get(item, 'tool')) || 'collaboration'
      return {
        toolCallId,
        toolName: tool.slice(0, 120),
        title: completed ? 'Finished collaboration step' : 'Coordinating with an Agent',
      }
    }
    case 'webSearch': {
      const query = stringValue(Reflect.get(item, 'query'))
      return {
        toolCallId,
        toolName: 'webSearch',
        title: completed ? 'Searched the web' : 'Searching the web',
        ...(query ? { detail: AgentActivityDetail.redact(query) } : {}),
      }
    }
    case 'imageView': {
      const rawPath = stringValue(Reflect.get(item, 'path'))
      const path = rawPath ? AgentActivityDetail.projectPath(rawPath, cwd) : ''
      return {
        toolCallId,
        toolName: 'imageView',
        title: path ? `Viewing ${basename(path)}` : 'Viewing an image',
        ...(path ? { detail: path } : {}),
      }
    }
    default:
      return undefined
  }
}

export function reasoningSummary(item: object): string {
  const summary = Reflect.get(item, 'summary')
  if (typeof summary === 'string') return summary.trim()
  if (!Array.isArray(summary)) return ''
  return summary
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const text = Reflect.get(part, 'text')
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

export function toolFailed(item: object): boolean {
  const status = Reflect.get(item, 'status')
  const success = Reflect.get(item, 'success')
  const exitCode = Reflect.get(item, 'exitCode')
  return (
    status === 'failed' ||
    status === 'declined' ||
    success === false ||
    Boolean(Reflect.get(item, 'error')) ||
    (typeof exitCode === 'number' && exitCode !== 0)
  )
}

export function stringValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    return value.join(' ')
  }
  return ''
}

export function observeThreadTitle(
  thread: unknown,
  observe: ((nativeSessionId: string, logicalTitle?: string) => void) | undefined,
): void {
  if (!thread || typeof thread !== 'object') return
  const name = Reflect.get(thread, 'name'),
    id = Reflect.get(thread, 'id')
  if (typeof id === 'string' && typeof name === 'string' && name.trim())
    observe?.(id, cleanTitle(name))
}

export function threadTitle(thread: unknown): string | undefined {
  return thread && typeof thread === 'object' ? cleanTitle(Reflect.get(thread, 'name')) : undefined
}

export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const plain = value.trim()
  // Derived Native names are a display label, not another Agent-generated
  // Pact title. Check before the 120-character logical-title projection.
  if (plain.startsWith('[Pact] ')) return undefined
  const title = plain.slice(0, 120)
  return title || undefined
}
