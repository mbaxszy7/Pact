import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, resolve as resolvePath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  NativeContextRebuildChunk,
  CollaborationAnswerFormat,
  NativeEvidenceIdentity,
  NativeProbeResult,
  NativeInitializationWitness,
  SessionPermissionMode,
  NormalizedAgentEvent,
} from '@pact/contracts'

import {
  type AgentAdapter,
  type AgentNativeProbeInput,
  type AgentNativeInitializedBindingProbeInput,
  type AgentNativeContextRebuildInput,
  type AgentNativeContextRebuildResult,
  type AgentRunInput,
  type AgentTitleEnrichmentInput,
  type AgentNativeForkSourceInput,
  type AgentNativeForkBoundary,
  type AgentNativeForkInput,
  type AgentNativeForkResult,
  type AgentNativeForkInspection,
  type AgentNativeForkWitness,
} from '@pact/agent-runtime'
import { collaborationOutputSchema } from '@pact/contracts'
import { nativeCodexSkillListSchema } from '@pact/contracts'
import {
  nativePermissionRequestSchema,
  peerRequestToolInputSchema,
  type NativePermissionRequest,
} from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'

import type { LogicalIpcWorkerTraffic } from '../../shared/logical-ipc-traffic'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../owned-process-group'
import { AgentActivityDetail } from './agent-activity-detail'
import { AgentAnswerAssembler } from './agent-answer-assembler'
import {
  AgentExecutionError,
  PermissionModeRejectedError,
  NativeThreadOccupiedError,
  NativeThreadArchivedError,
  isCodexArchivedSessionRejection,
  NativeCapacityError,
  classifyAgentError,
} from './agent-execution-error'
import {
  CodexAppServerConnection,
  type CodexConnectionDiagnostics,
} from './codex-app-server-connection'
import { readCodexInitializationRollout } from './codex-native-rollout'
import { codexProcessEnvironment } from './codex-process-environment'
import {
  projectCollaborationAnswer,
  readCollaborationAnswer,
  readCollaborationEnvelopeText,
  collaborationNaturalFallback,
  readSubmittedCollaborationReport,
  collaborationResultEvent,
} from './collaboration-answer'
import {
  collaborationInstructions,
  collaborationReadOnly,
  frozenSourceInstructions,
} from './collaboration-prompt'
import {
  codexFileChanges,
  nativeEffectsUncertain,
  nativeFileChangesSettled,
  recordNativeChanges,
} from './native-file-changes'
import { NativeForkFiles, type NativeForkFileResult } from './native-fork-files'
import {
  codexPromptInput,
  nativeImageBlock,
  nativeImagePreparationBytes,
  requireNativeImageReference,
} from './native-image-content'
import { freezeNativeJsonFrame } from './native-json-encoder'
import {
  exactNativeSessionScope,
  nativeApprovalDisplayFits,
  NativePermissionWait,
  safeNativePermissionText,
} from './native-permission-wait'
import { nativeSkillCatalog } from './native-skill-catalog'
import { codexQuestions, nativeElicitation } from './native-user-input'
import { NativeWorkingMemory, type NativeMemoryReservation } from './native-working-memory'
import { NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'
import { PactPeerToolServer } from './pact-peer-tool-server'

const IDLE_CONNECTION_TIMEOUT_MS = 5 * 60 * 1000
const MAX_LOADED_THREADS = 8
const MAX_LOADED_THREAD_BYTES = 64 * 1024
const CODEX_INJECT_TARGET_BYTES = 768 * 1024
const CODEX_FEATURE_PROBE_TIMEOUT_MS = 2_000
const CODEX_FEATURE_PROBE_EXIT_MS = 1_000
const CODEX_FEATURE_PROBE_BYTES = 64 * 1024
const CODEX_FEATURE_PROBE_LINES = 256
const CODEX_STOP_TIMEOUT_MS = 5_000
const CODEX_STOP_COMMANDS = 64
const CODEX_STOP_IDENTITY_BYTES = 64 * 1024
const CODEX_STOP_DISCOVERY_BYTES = 256 * 1024
export const CODEX_INITIALIZATION_TIMEOUT_MS = 10_000
export const CODEX_THREAD_RPC_TIMEOUT_MS = 15_000
export const CODEX_TURN_ACCEPT_TIMEOUT_MS = 30_000
export const CODEX_TITLE_TIMEOUT_MS = 2_000

function codexCapabilityError(message: string): AgentExecutionError {
  return new AgentExecutionError('runtime_incompatible', message, false)
}

export interface CodexRunConfiguration {
  model: string
  effort: string | null
}

type CodexProcessFactory = (cwd: string) => ChildProcessWithoutNullStreams

interface EarlyNativeFact {
  event: object
  bytes: number
  heldBytes: number
  reservation: NativeMemoryReservation
}

interface NativeBackground {
  input: AgentRunInput
  sourceGrant?: { runId: string; grant: string } | undefined
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
  connection?: CodexAppServerConnection
}

interface ApprovalItem {
  paths: string[]
  complete: boolean
  command?: string | undefined
  cwd?: string | undefined
}

interface CodexNativeForkOwner {
  executorId: string
  nativeSessionId?: string
  pending: boolean
  release: () => void
  observation: AbortController
  settle: () => Promise<boolean>
}

interface NativeRebuildReceipt {
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

function nativeProfileLines(value: unknown): string[] | undefined {
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
function codexApprovalActions(
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

function cacheApprovalItem(
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

function* resolvedModelEvent(configuration: {
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

export class CodexAgentAdapter implements AgentAdapter {
  readonly id = 'codex' as const
  private latestExecutorId = randomUUID()
  get executorId(): string {
    return this.connection?.executorId ?? this.latestExecutorId
  }
  // Recent native terminal evidence only, <=8 entries; cleared at disposal.
  private readonly evidenceCacheWork = new NativeWorkingMemory().reserve(0)
  private readonly terminalEvidence = new Map<
    string,
    Extract<NativeProbeResult, { kind: 'ended' }>
  >()
  // Own bootstrap receipts only: <=8 / 64 KiB, connection-scoped, cleared at disposal.
  private readonly nativeRebuildReceipts = new Map<string, NativeRebuildReceipt>()
  private connection: CodexAppServerConnection | undefined
  // One startup/probe at a time; no capability result survives an actor generation.
  private connectionStarting: { key: string; task: Promise<CodexAppServerConnection> } | undefined
  private featureProbe: { stop: () => void; task: Promise<string[]> } | undefined
  private closingConnection: Promise<void> | undefined
  private processCwd: string | undefined
  private processStorageRoot: string | undefined
  private processEnvironmentKey: string | undefined
  private connectionProcess: ChildProcessWithoutNullStreams | undefined
  private nativeInspection:
    | { controller: AbortController; connection: CodexAppServerConnection; task: Promise<unknown> }
    | undefined
  private initialized = false
  private running = false
  private disposed = false
  private readonly loadedThreadIds = new Set<string>()
  private readonly loadedThreadConfigurations = new Map<
    string,
    { model: string; effort: string | null }
  >()
  private skillCatalogChanged: (() => void) | undefined
  setSkillCatalogListener(listener: (() => void) | undefined): void {
    this.skillCatalogChanged = listener
  }
  private readonly peerToolServer = new PactPeerToolServer()
  private peerServerName = `pact_peer_${randomUUID().replaceAll('-', '')}`
  private readonly nativeBackground = new Set<NativeBackground>()
  // Current connection generation only; <=256 identities / 512 KiB each, cleared on replacement.
  private readonly retiredNativeTurns = new Set<string>()
  private readonly retiredNativeChildren = new Set<string>()
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private uncertainTitleExecutor: string | undefined
  private readonly nativeForkFiles: NativeForkFiles
  // Pending actual Fork/startup owners count against the same eight-context ceiling.
  private readonly nativeForkOwners = new Map<string, CodexNativeForkOwner>()

  constructor(
    private readonly executablePath: string,
    private readonly processFactory?: CodexProcessFactory,
    private readonly nativeReadOptions: { storageRoot?: string } = {},
    private readonly ipcTraffic?: LogicalIpcWorkerTraffic,
  ) {
    this.nativeForkFiles = new NativeForkFiles(ipcTraffic)
  }

  retireSourceGrant(owner: { runId: string; grant: string }): void {
    this.peerToolServer.retireSourceReader(owner)
  }

  async probe(): Promise<{ id: 'codex'; available: true }> {
    return { id: 'codex', available: true }
  }

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    const live = await this.ensureConnection(input.cwd)
    await this.initializeConnection(live, signal)
    return this.withNativeInspectionConnection(
      live,
      input.cwd,
      signal,
      async (reader, readSignal) => {
        const prefix = await this.readForkRollout(
          reader,
          input.nativeSessionId,
          input.nativeTurnId,
          input.cwd,
          readSignal,
          undefined,
          input.responseHash,
          input.answerFormat,
        )
        const turns = await this.readNativeTurns(
          reader,
          input.nativeSessionId,
          readSignal,
          input.nativeTurnId,
        )
        const turn = turns.find((value) => Reflect.get(value, 'id') === input.nativeTurnId)
        if (
          !turn ||
          Reflect.get(turn, 'status') !== 'completed' ||
          Reflect.get(turn, 'error') != null
        )
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Codex Fork requires the exact completed native Turn.',
            false,
          )
        return {
          nativeSessionId: input.nativeSessionId,
          nativeTurnId: input.nativeTurnId,
          nativeCutId: input.nativeTurnId,
          bindingGeneration: input.bindingGeneration,
          throughSequence: input.throughSequence,
          deliveryCursor: input.deliveryCursor,
          ...(input.answerFormat ? { answerFormat: input.answerFormat } : {}),
          prefixHash: prefix.prefixHash,
          prefixRecords: prefix.prefixRecords,
          prefixBytes: prefix.prefixBytes,
        }
      },
    )
  }

  private async readForkRollout(
    connection: CodexAppServerConnection,
    nativeSessionId: string,
    nativeTurnId: string,
    cwd: string,
    signal: AbortSignal,
    witness?: AgentNativeForkWitness,
    responseHash?: string,
    answerFormat?: CollaborationAnswerFormat,
  ): Promise<NativeForkFileResult> {
    const read = await connection.request(
      'thread/read',
      { threadId: nativeSessionId, includeTurns: false },
      { timeoutMs: 10_000, signal },
    )
    const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
    if (
      Reflect.get(read, 'error') ||
      thread?.id !== nativeSessionId ||
      typeof thread.path !== 'string' ||
      !this.processStorageRoot
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex did not provide the exact native Fork rollout identity.',
        false,
      )
    // The omitted fixed-wire default is legacy. Paginated forks retain an exact
    // parent byte/ordinal prefix; the Worker resolves it through this reader.
    if (
      thread.historyMode !== undefined &&
      thread.historyMode !== 'legacy' &&
      thread.historyMode !== 'paginated'
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex returned an unknown native history format for Fork.',
        false,
      )
    if (witness && thread.forkedFromId !== witness.sourceNativeSessionId)
      throw new Error('Codex native Fork thread lineage mismatch.')
    return this.nativeForkFiles.execute(
      {
        provider: 'codex',
        action: 'read',
        cwd,
        nativeSessionId,
        nativeTurnId,
        path: thread.path,
        storageRoot: this.processStorageRoot,
        historyMode: thread.historyMode ?? 'legacy',
        ...(witness ? { witness } : {}),
        ...(responseHash ? { responseHash } : {}),
        ...(answerFormat
          ? { answerFormat }
          : witness?.answerFormat
            ? { answerFormat: witness.answerFormat }
            : {}),
      },
      signal,
      undefined,
      async (id, referenceSignal) => {
        const response = await connection.request(
          'thread/read',
          { threadId: id, includeTurns: false },
          { timeoutMs: 10_000, signal: referenceSignal },
        )
        const parent = Reflect.get(Reflect.get(response, 'result') ?? {}, 'thread')
        if (
          Reflect.get(response, 'error') ||
          parent?.id !== id ||
          typeof parent.path !== 'string' ||
          (parent.historyMode !== 'legacy' && parent.historyMode !== 'paginated')
        )
          throw new Error('Codex could not resolve the exact native history parent.')
        return { nativeSessionId: id, path: parent.path, historyMode: parent.historyMode }
      },
    )
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    if (!input.nativeSessionId || !input.witness)
      return {
        kind: 'unconfirmed',
        reason: 'Codex Fork candidate identity or native witness is unconfirmed.',
      }
    const witness = input.witness
    if (
      witness.nativeSessionId !== input.nativeSessionId ||
      witness.sourceNativeSessionId !== input.source.nativeSessionId ||
      witness.sourceCutId !== input.source.nativeCutId ||
      witness.sourcePrefixHash !== input.source.prefixHash
    )
      return {
        kind: 'unconfirmed',
        reason: 'Codex Fork witness belongs to another source or settings revision.',
      }
    try {
      const live = await this.ensureConnection(input.cwd)
      await this.initializeConnection(live, signal)
      const prefix = await this.withNativeInspectionConnection(
        live,
        input.cwd,
        signal,
        (reader, readSignal) =>
          this.readForkRollout(
            reader,
            input.nativeSessionId!,
            input.source.nativeTurnId,
            input.cwd,
            readSignal,
            witness,
          ),
      )
      const owner = this.nativeForkOwners.get(input.operationId)
      const ownerSettled =
        owner?.nativeSessionId === input.nativeSessionId ? await owner.settle() : false
      return {
        kind: 'verified',
        ready:
          Boolean(prefix.initializedVerified) &&
          witness.model === input.model &&
          witness.effort === input.effort &&
          witness.permissionMode === input.permissionMode,
        workSettled: Boolean(prefix.initializedVerified) || ownerSettled,
        result: { nativeSessionId: input.nativeSessionId, witness },
      }
    } catch (error) {
      // RPC access failures and non-authoritative discovery are never absence proof.
      return {
        kind: 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Codex Fork inspection failed.',
      }
    }
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    if (input.nativeSessionId) return this.initializeNativeFork(input, signal)
    return this.createOrInitializeFork(input, signal, false)
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    const inspected = await this.inspectNativeFork(input, signal)
    if (inspected.kind !== 'verified')
      throw new AgentExecutionError('runtime_incompatible', inspected.reason, false)
    if (inspected.ready) return inspected.result
    return this.createOrInitializeFork(input, signal, true)
  }

  private async resolveForkConfiguration(
    connection: CodexAppServerConnection,
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<CodexRunConfiguration> {
    if (input.model && input.effort) return { model: input.model, effort: input.effort }
    const read = await connection.request(
      'config/read',
      { cwd: input.cwd, includeLayers: false },
      { timeoutMs: 10_000, signal },
    )
    const config = Reflect.get(Reflect.get(read, 'result') ?? {}, 'config')
    if (Reflect.get(read, 'error') || !config || typeof config !== 'object')
      throw new Error('Native defaults could not be read for this Fork.')
    let model = input.model ?? Reflect.get(config, 'model')
    let effort = input.effort ?? Reflect.get(config, 'model_reasoning_effort')
    if (typeof model === 'string' && model && typeof effort === 'string' && effort)
      return { model, effort }
    // One uncached, bounded catalog scan resolves actual native defaults. Null
    // settings-update/resume fields mean "unchanged", not "use defaults".
    let cursor: string | undefined,
      items = 0,
      bytes = 0
    const controller = new AbortController(),
      observed = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    try {
      do {
        // oxlint-disable-next-line no-await-in-loop -- Native catalog cursor pages are ordered.
        const page = await connection.request(
          'model/list',
          { limit: 25, includeHidden: true, ...(cursor ? { cursor } : {}) },
          { timeoutMs: 10_000, signal: observed },
        )
        const result = Reflect.get(page, 'result'),
          data = result && Reflect.get(result, 'data'),
          next = result && Reflect.get(result, 'nextCursor')
        if (
          Reflect.get(page, 'error') ||
          !Array.isArray(data) ||
          data.length > 25 ||
          (next != null && (typeof next !== 'string' || next.length > 8192 || next === cursor))
        )
          throw new Error('Invalid native defaults catalog page.')
        for (const entry of data) {
          bytes += Buffer.byteLength(JSON.stringify(entry))
          if (++items > 200 || bytes > 256 * 1024 || !entry || typeof entry !== 'object')
            throw new Error('Native defaults catalog exceeded its bounded read.')
          const name = Reflect.get(entry, 'model'),
            id = Reflect.get(entry, 'id')
          if (
            !model &&
            Reflect.get(entry, 'isDefault') === true &&
            typeof name === 'string' &&
            name
          )
            model = name
          if (model && (name === model || id === model) && !effort)
            effort = Reflect.get(entry, 'defaultReasoningEffort')
        }
        if (typeof model === 'string' && model && typeof effort === 'string' && effort)
          return { model, effort }
        cursor = next ?? undefined
      } while (cursor)
      throw new Error(
        'The effective native model/effort defaults could not be resolved; no prior explicit values were reused.',
      )
    } finally {
      clearTimeout(deadline)
      controller.abort()
    }
  }

  private async applyForkModelSettings(
    connection: CodexAppServerConnection,
    threadId: string,
    configuration: CodexRunConfiguration,
    signal: AbortSignal,
  ): Promise<void> {
    const read = await connection.request(
      'thread/read',
      { threadId, includeTurns: false },
      { timeoutMs: 10_000, signal },
    )
    const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
    if (Reflect.get(read, 'error') || thread?.id !== threadId)
      throw new Error('Native Fork model settings could not be read.')
    if (thread.model === configuration.model && thread.reasoningEffort === configuration.effort)
      return
    const controller = new AbortController(),
      observed = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    let resolve: ((settings: unknown) => void) | undefined
    const acknowledged = new Promise<unknown>((settle) => {
      resolve = settle
    })
    const aborted = () => resolve?.(undefined)
    observed.addEventListener('abort', aborted, { once: true })
    const release = connection.subscribeBackground((event) => {
      const params = Reflect.get(event, 'params')
      if (
        Reflect.get(event, 'method') !== 'thread/settings/updated' ||
        !params ||
        typeof params !== 'object' ||
        Reflect.get(params, 'threadId') !== threadId
      )
        return false
      resolve?.(Reflect.get(params, 'threadSettings'))
      return true
    })
    try {
      const updated = await connection.request(
        'thread/settings/update',
        { threadId, model: configuration.model, effort: configuration.effort },
        { timeoutMs: 10_000, signal: observed },
      )
      if (Reflect.get(updated, 'error'))
        throw new Error('Native Fork model/effort settings update was rejected.')
      const actual = await acknowledged
      if (
        observed.aborted ||
        !actual ||
        typeof actual !== 'object' ||
        Reflect.get(actual, 'model') !== configuration.model ||
        Reflect.get(actual, 'effort') !== configuration.effort
      )
        throw new Error('Native Fork did not acknowledge the requested model/effort defaults.')
      const after = await connection.request(
        'thread/read',
        { threadId, includeTurns: false },
        { timeoutMs: 10_000, signal: observed },
      )
      const current = Reflect.get(Reflect.get(after, 'result') ?? {}, 'thread')
      if (
        Reflect.get(after, 'error') ||
        current?.id !== threadId ||
        current.model !== configuration.model ||
        current.reasoningEffort !== configuration.effort
      )
        throw new Error('Native Fork model/effort settings readback changed after acknowledgement.')
    } finally {
      release()
      clearTimeout(deadline)
      observed.removeEventListener('abort', aborted)
      controller.abort()
      resolve?.(undefined)
    }
  }

  private async createOrInitializeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
    resume: boolean,
  ): Promise<AgentNativeForkResult> {
    if (
      this.running ||
      this.nativeForkOwners.has(input.operationId) ||
      this.nativeBackground.size +
        [...this.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending).length +
        this.nativeForkOwners.size >=
        MAX_LOADED_THREADS
    )
      throw new NativeCapacityError(
        'Codex native context capacity is unavailable; no new Fork work was dispatched.',
      )
    this.running = true
    let owner: CodexNativeForkOwner | undefined
    let threadId = input.nativeSessionId,
      provisional: string | undefined,
      dispatched = false
    const observation = new AbortController(),
      interactions = new Set<Promise<void>>(),
      hooks = new Set<string>(),
      handled = new Set<string>(),
      approvalItems = new Map<string, ApprovalItem>()
    let unconfirmed = false,
      settling = false,
      foregroundFinished = false
    try {
      if (resume && input.witness && input.nativeSessionId) {
        const {
          initializedAt: _initializedAt,
          initializedPrefixHash: _initializedPrefixHash,
          initializedPrefixBytes: _initializedPrefixBytes,
          initializedPrefixRecords: _initializedPrefixRecords,
          ...originalWitness
        } = input.witness
        const freshWitness = {
          ...originalWitness,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
        }
        await input.onCandidate(input.nativeSessionId, freshWitness)
        input = { ...input, witness: freshWitness }
      }
      const connection = await this.ensureConnection(input.cwd)
      await this.initializeConnection(connection, signal)
      const toolConfig = await this.pactToolConfig(
        connection,
        await this.peerToolServer.start(),
        input.cwd,
        signal,
        input.permissionMode,
      )
      const forkConfiguration = await this.resolveForkConfiguration(connection, input, signal)
      const sourcePrefix = !resume
        ? await this.withNativeInspectionConnection(
            connection,
            input.cwd,
            signal,
            (reader, readSignal) =>
              this.readForkRollout(
                reader,
                input.source.nativeSessionId,
                input.source.nativeTurnId,
                input.cwd,
                readSignal,
                undefined,
                undefined,
                input.source.answerFormat,
              ),
          )
        : undefined
      if (sourcePrefix && sourcePrefix.prefixHash !== input.source.prefixHash)
        throw new Error('The complete native source context changed before Fork dispatch.')
      // Native config/read serializes an absent legacy workspace policy as null.
      // Forward only its actual structured value, preserving all other native config.
      const forkConfig = Object.fromEntries(
        Object.entries(toolConfig.config).filter(
          ([key, value]) =>
            key !== 'sandbox_workspace_write' ||
            (value !== null && typeof value === 'object' && !Array.isArray(value)),
        ),
      )
      const releaseEvents = connection.subscribeBackground((event) => {
        const params = Reflect.get(event, 'params'),
          method = Reflect.get(event, 'method')
        if (
          !dispatched ||
          !params ||
          typeof params !== 'object' ||
          !['hook/started', 'hook/completed'].includes(String(method))
        )
          return false
        const nativeThread = Reflect.get(params, 'threadId')
        if (
          typeof nativeThread !== 'string' ||
          ((threadId ?? provisional) && nativeThread !== (threadId ?? provisional))
        )
          return false
        provisional ??= nativeThread
        const run = Reflect.get(params, 'run'),
          hookId = run && typeof run === 'object' ? Reflect.get(run, 'id') : undefined
        if (typeof hookId !== 'string' || hookId.length > 1024) unconfirmed = true
        else if (method === 'hook/started') {
          if (hooks.size >= 64) unconfirmed = true
          else hooks.add(hookId)
        } else if (
          ['completed', 'failed', 'blocked', 'stopped'].includes(String(Reflect.get(run, 'status')))
        )
          hooks.delete(hookId)
        if (foregroundFinished) void owner?.settle().catch(() => undefined)
        return true
      })
      const releaseRequests = connection.subscribeServerRequests((request) => {
        const params = Reflect.get(request, 'params'),
          method = Reflect.get(request, 'method')
        if (!dispatched || typeof method !== 'string' || !params || typeof params !== 'object')
          return false
        const nativeThread = Reflect.get(params, 'threadId'),
          turnId = Reflect.get(params, 'turnId')
        if (
          typeof nativeThread !== 'string' ||
          ((threadId ?? provisional) && nativeThread !== (threadId ?? provisional))
        )
          return false
        provisional ??= nativeThread
        if (interactions.size >= 8) {
          unconfirmed = true
          return false
        }
        const work = this.relayPermission(
          connection,
          request,
          method,
          params,
          input,
          nativeThread,
          typeof turnId === 'string' ? turnId : undefined,
          observation.signal,
          handled,
          approvalItems,
        ).catch(() => {
          unconfirmed = true
        })
        interactions.add(work)
        void work.finally(() => {
          interactions.delete(work)
          if (foregroundFinished) void owner?.settle().catch(() => undefined)
        })
        return true
      })
      owner = {
        executorId: connection.executorId,
        ...(threadId ? { nativeSessionId: threadId } : {}),
        pending: true,
        observation,
        settle: async () => {
          if (
            !foregroundFinished ||
            !threadId ||
            settling ||
            hooks.size ||
            interactions.size ||
            unconfirmed ||
            observation.signal.aborted ||
            !owner?.pending
          )
            return false
          settling = true
          try {
            const read = await connection.request(
              'thread/read',
              { threadId, includeTurns: false },
              { timeoutMs: 10_000, signal: observation.signal },
            )
            const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
            if (
              Reflect.get(read, 'error') ||
              thread?.id !== threadId ||
              thread.status?.type !== 'idle' ||
              hooks.size ||
              interactions.size ||
              unconfirmed
            )
              return false
            input.reportNativeWork({ executorId: connection.executorId, state: 'settled' })
            owner.pending = false
            owner.release()
            if (this.nativeForkOwners.get(input.operationId) === owner)
              this.nativeForkOwners.delete(input.operationId)
            this.scheduleIdleDisconnect()
            return true
          } finally {
            settling = false
          }
        },
        release: () => {
          releaseEvents()
          releaseRequests()
          observation.abort()
        },
      }
      this.nativeForkOwners.set(input.operationId, owner)
      await input.onDispatched(connection.executorId)
      const response = await connection.request(
        resume ? 'thread/resume' : 'thread/fork',
        {
          threadId: resume ? threadId : input.source.nativeSessionId,
          ...(!resume ? { lastTurnId: input.source.nativeCutId, deferGoalContinuation: true } : {}),
          cwd: input.cwd,
          excludeTurns: true,
          config: {
            ...forkConfig,
            model_reasoning_effort: forkConfiguration.effort,
          },
          ...toolConfig.nativePolicy,
          model: forkConfiguration.model,
        },
        {
          timeoutMs: 10_000,
          signal,
          onDispatch: () => {
            dispatched = true
            input.reportNativeWork({ executorId: connection.executorId, state: 'unknown' })
          },
        },
      )
      if (Reflect.get(response, 'error'))
        throw classifyAgentError(new Error(JSON.stringify(Reflect.get(response, 'error'))))
      const result = Reflect.get(response, 'result'),
        thread = result && Reflect.get(result, 'thread')
      if (
        !thread ||
        typeof thread.id !== 'string' ||
        (resume && thread.id !== input.nativeSessionId) ||
        thread.forkedFromId !== input.source.nativeSessionId ||
        (provisional && provisional !== thread.id)
      )
        throw new Error('Codex Fork acknowledgement did not match its exact lineage.')
      threadId = thread.id
      owner.nativeSessionId = threadId!
      let witness: AgentNativeForkWitness = input.witness ?? {
        version: 'pact-native-fork-v1',
        nativeSessionId: threadId!,
        sourceNativeSessionId: input.source.nativeSessionId,
        sourceCutId: input.source.nativeCutId,
        ...(input.source.answerFormat ? { answerFormat: input.source.answerFormat } : {}),
        sourcePrefixHash: input.source.prefixHash,
        candidatePrefixHash: input.source.prefixHash,
        idMap: sourcePrefix?.idMap ?? [],
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
      }
      await input.onCandidate(threadId!, witness)
      await this.applyPermissionSettings(
        connection,
        threadId!,
        toolConfig.settingsPolicy,
        signal,
        response,
      )
      await this.applyForkModelSettings(connection, threadId!, forkConfiguration, signal)
      if (thread.status?.type !== 'idle' || hooks.size || interactions.size || unconfirmed)
        throw new Error(
          'Codex Fork startup work is not confirmed settled; the candidate was preserved.',
        )
      const prefix = await this.withNativeInspectionConnection(
        connection,
        input.cwd,
        signal,
        (reader, readSignal) =>
          this.readForkRollout(
            reader,
            threadId!,
            input.source.nativeTurnId,
            input.cwd,
            readSignal,
            witness,
          ),
      )
      const finalRead = await connection.request(
        'thread/read',
        { threadId, includeTurns: false },
        { timeoutMs: 10_000, signal },
      )
      const finalThread = Reflect.get(Reflect.get(finalRead, 'result') ?? {}, 'thread')
      if (
        Reflect.get(finalRead, 'error') ||
        finalThread?.id !== threadId ||
        finalThread.status?.type !== 'idle' ||
        hooks.size ||
        interactions.size ||
        unconfirmed
      )
        throw new Error('Codex Fork startup work changed during native readback.')
      witness = {
        ...witness,
        idMap: prefix.idMap,
        ...(prefix.nativeStorageRoot ? { nativeStorageRoot: prefix.nativeStorageRoot } : {}),
        ...(prefix.nativePath ? { nativePath: prefix.nativePath } : {}),
        initializedAt: new Date().toISOString(),
        initializedPrefixHash: prefix.rawHash,
        initializedPrefixBytes: prefix.rawBytes,
        initializedPrefixRecords: prefix.rawRecords,
      }
      await input.onCandidate(threadId!, witness)
      input.reportNativeWork({ executorId: connection.executorId, state: 'settled' })
      owner.pending = false
      this.rememberThread(threadId!, {
        model: forkConfiguration.model,
        effort: forkConfiguration.effort,
      })
      return { nativeSessionId: threadId!, witness }
    } finally {
      foregroundFinished = true
      this.running = false
      if (owner?.pending && dispatched) void owner.settle().catch(() => undefined)
      if (owner && (!dispatched || !owner.pending)) {
        owner.release()
        this.nativeForkOwners.delete(input.operationId)
      }
      this.scheduleIdleDisconnect()
    }
  }

  async probeNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    if (input.target === 'initialized_binding') return this.probeInitializedBinding(input, signal)
    const identity = CodexAgentAdapter.probeIdentity(input)
    const owner = [...this.nativeBackground].find(
      (candidate) =>
        candidate.input.runId === input.requestId &&
        candidate.primaryThreadId === input.nativeSessionId &&
        candidate.input.bindingGeneration === input.bindingGeneration,
    )
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    try {
      const connection = await this.ensureConnection(input.cwd)
      await this.initializeConnection(connection, signal)
      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const error = Reflect.get(response, 'error')
      if (error) {
        const detail = JSON.stringify(error)
        if (/not found|does not exist|unknown thread|missing thread/iu.test(detail))
          return { kind: 'missing', identity, source: 'native_error' }
        throw classifyAgentError(new Error(detail))
      }
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      const threadId = thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
      if (threadId !== input.nativeSessionId)
        throw new AgentExecutionError(
          'protocol_error',
          'Codex returned an unexpected Native Session.',
          false,
        )
      CodexAgentAdapter.observeThreadTitle(thread, input.observeNativeTitle)
      const terminal = this.terminalEvidence.get(input.requestId)
      if (terminal) {
        this.terminalEvidence.delete(input.requestId)
        this.terminalEvidence.set(input.requestId, terminal)
      }
      if (
        terminal &&
        terminal.identity.answerFormat === input.answerFormat &&
        terminal.identity.nativeSessionId === input.nativeSessionId &&
        terminal.identity.bindingGeneration === input.bindingGeneration &&
        (!input.nativeTurnId || terminal.identity.nativeTurnId === input.nativeTurnId)
      ) {
        const confirmed = {
          ...terminal,
          source:
            terminal.identity.executorId === connection.executorId
              ? ('live_terminal' as const)
              : ('stored_terminal' as const),
          identity: {
            ...terminal.identity,
            ...identity,
            ...(terminal.identity.executorId ? { executorId: terminal.identity.executorId } : {}),
          },
        }
        if (confirmed.output?.completeness === 'complete' || !confirmed.identity.nativeTurnId)
          return confirmed
        try {
          const output = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            confirmed.identity.nativeTurnId,
            { ...input, nativeTurnId: confirmed.identity.nativeTurnId },
            signal,
            confirmed.outcome === 'completed',
          )
          return { ...confirmed, ...(output ? { output } : {}) }
        } catch {
          return confirmed
        }
      }
      // A fresh App Server's historical interrupted/notLoaded projection is not
      // evidence that another executor stopped. Preserve text independently.
      // The unknown-delivery case may have no Turn ACK. Match the original
      // client request through bounded item pages, never a guessed latest Turn.
      let matchedNativeTurnId = input.nativeTurnId
      if (!matchedNativeTurnId) {
        matchedNativeTurnId = await this.withNativeInspectionConnection(
          connection,
          input.cwd,
          signal,
          async (reader, readSignal) => {
            const matches = new Set<string>()
            for await (const entry of this.readNativeItems(
              reader,
              input.nativeSessionId,
              undefined,
              readSignal,
              10_000,
              8 * 1024 * 1024,
            )) {
              const item = Reflect.get(entry, 'item')
              if (
                item &&
                typeof item === 'object' &&
                Reflect.get(item, 'type') === 'userMessage' &&
                Reflect.get(item, 'clientId') === input.requestId &&
                typeof Reflect.get(entry, 'turnId') === 'string'
              )
                matches.add(Reflect.get(entry, 'turnId'))
            }
            return matches.size === 1 ? [...matches][0] : undefined
          },
        )
      }
      const matchedInput = { ...input, nativeTurnId: matchedNativeTurnId }
      const turns = await this.readNativeTurns(
        connection,
        input.nativeSessionId,
        signal,
        matchedNativeTurnId,
      )
      if (
        owner?.connection === connection &&
        input.executorId === owner.connection.executorId &&
        Array.isArray(turns)
      ) {
        const matched = CodexAgentAdapter.matchingTurn(turns, matchedInput)
        const matchedId = matched ? Reflect.get(matched, 'id') : undefined
        if (
          typeof matchedId === 'string' &&
          (!owner.primaryTurnId || owner.primaryTurnId === matchedId)
        ) {
          owner.primaryTurnId = matchedId
          connection.replayBackgroundNotifications()
          const observedTerminal = this.terminalEvidence.get(input.requestId)
          if (observedTerminal) {
            this.terminalEvidence.delete(input.requestId)
            this.terminalEvidence.set(input.requestId, observedTerminal)
          }
          if (observedTerminal && observedTerminal.identity.answerFormat === input.answerFormat)
            return observedTerminal
        }
        if (
          matched &&
          typeof matchedId === 'string' &&
          Reflect.get(matched, 'status') === 'inProgress'
        )
          return {
            kind: owner.interactions.size ? 'waiting_user' : 'running',
            identity: {
              ...identity,
              nativeTurnId: matchedId,
              executorId: this.executorId,
            },
            source: 'live_runtime',
          }
      }
      const matched = Array.isArray(turns)
        ? CodexAgentAdapter.matchingTurn(turns, matchedInput)
        : undefined
      const matchedId = matched ? Reflect.get(matched, 'id') : undefined
      const outcome = matched ? CodexAgentAdapter.storedTurnOutcome(matched) : undefined
      const matchedIndex = Array.isArray(turns) && matched ? turns.indexOf(matched) : -1
      const threadStatus =
        thread && typeof thread === 'object' ? Reflect.get(thread, 'status') : undefined
      const active =
        threadStatus &&
        typeof threadStatus === 'object' &&
        Reflect.get(threadStatus, 'type') === 'active'
      const historyReady =
        threadStatus &&
        typeof threadStatus === 'object' &&
        !Array.isArray(threadStatus) &&
        ['idle', 'notLoaded'].includes(Reflect.get(threadStatus, 'type'))
      if (
        outcome &&
        typeof matchedId === 'string' &&
        matchedIndex >= 0 &&
        historyReady &&
        Array.isArray(turns) &&
        turns
          .slice(matchedIndex + 1)
          .every(
            (turn) =>
              turn &&
              typeof turn === 'object' &&
              CodexAgentAdapter.storedTurnOutcome(turn) !== undefined,
          )
      ) {
        // Completion metadata is projected from a persisted native terminal
        // event, unlike default Completed/Interrupted or this process's notLoaded.
        // Body recovery has its own limits and cannot undo known termination.
        let recovered: Extract<NativeProbeResult, { kind: 'ended' }>['output']
        try {
          recovered = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            matchedId,
            matchedInput,
            signal,
            outcome === 'completed',
          )
        } catch {
          /* Known ending remains usable if its body cannot be read safely. */
        }
        return {
          kind: 'ended',
          source: 'stored_terminal',
          outcome,
          identity: { ...identity, nativeTurnId: matchedId },
          ...(recovered ? { output: recovered } : {}),
        }
      }
      let output: Extract<NativeProbeResult, { kind: 'no_evidence' }>['output']
      try {
        if (typeof matchedId === 'string')
          output = await this.readNativeOutput(
            connection,
            input.nativeSessionId,
            matchedId,
            matchedInput,
            signal,
          )
      } catch {
        // An unavailable answer does not change the native-state evidence.
      }
      return {
        kind: 'no_evidence',
        identity:
          typeof matchedId === 'string' ? { ...identity, nativeTurnId: matchedId } : identity,
        reason: active
          ? 'The native session still reports active work.'
          : !historyReady
            ? 'The native check returned an unsupported Thread status.'
            : outcome
              ? 'The native session has a later Turn without reliable terminal metadata.'
              : 'Native history has no explicit terminal metadata for this Turn.',
        ...(output ? { output } : {}),
      }
    } catch (error) {
      return {
        kind: 'no_evidence',
        identity,
        reason: safeNativePermissionText(
          `Native status check failed: ${error instanceof Error ? error.message : 'No reliable response was received.'}`,
          240,
        ),
      }
    } finally {
      this.scheduleIdleDisconnect()
    }
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    if (this.running)
      throw new AgentExecutionError('protocol_error', 'Codex already has an active Run.', false)
    if (
      this.nativeBackground.size +
        this.nativeForkOwners.size +
        [...this.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending).length >=
      8
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex has too many owned native contexts. No new bootstrap was created.',
        false,
      )
    this.running = true
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    let threadId: string | undefined
    let provisionalThreadId: string | undefined
    let releaseNativeRequests: (() => void) | undefined
    let releaseHookObservation: (() => void) | undefined
    const observation = new AbortController()
    let nativeCreationDispatched = false
    let creationExecutorId: string | undefined
    let creationNotStarted = false
    const startupHooks = { pending: new Set<string>(), unconfirmed: false }
    const interactions = new Set<Promise<void>>()
    const handledRequests = new Set<string>()
    const approvalItems = new Map<string, ApprovalItem>()
    let permissionRejected = false
    let inspectRejectedIdle: (() => Promise<void>) | undefined
    try {
      const connection = await this.ensureConnection(input.cwd)
      await this.initializeConnection(connection, signal)
      const peerToolUrl = await this.peerToolServer.start()
      const toolConfig = await this.pactToolConfig(
        connection,
        peerToolUrl,
        input.cwd,
        signal,
        input.permissionMode,
      )
      let rejectionCheckPending = false
      inspectRejectedIdle = async () => {
        if (
          !permissionRejected ||
          !threadId ||
          interactions.size ||
          startupHooks.pending.size ||
          startupHooks.unconfirmed ||
          rejectionCheckPending ||
          observation.signal.aborted
        )
          return
        rejectionCheckPending = true
        try {
          const read = await connection.request(
            'thread/read',
            { threadId, includeTurns: false },
            { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal: observation.signal },
          )
          const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
          if (
            !Reflect.get(read, 'error') &&
            thread?.id === threadId &&
            thread.status?.type === 'idle' &&
            interactions.size === 0 &&
            !startupHooks.pending.size &&
            !startupHooks.unconfirmed
          ) {
            input.reportNativeWork?.({
              executorId: connection.executorId,
              nativeSessionId: threadId,
              state: 'settled',
            })
            this.settleNativeRebuild(input.rebuildId)
          }
        } catch {
          /* No proof of idle: keep the actual native owner. */
        } finally {
          rejectionCheckPending = false
        }
      }
      releaseHookObservation = connection.subscribeBackground((event) => {
        const method = Reflect.get(event, 'method'),
          params = Reflect.get(event, 'params')
        if (
          !nativeCreationDispatched ||
          !['hook/started', 'hook/completed'].includes(String(method)) ||
          !params ||
          typeof params !== 'object'
        )
          return false
        const nativeThread = Reflect.get(params, 'threadId'),
          turn = Reflect.get(params, 'turnId')
        if (
          typeof nativeThread !== 'string' ||
          !nativeThread ||
          nativeThread.length > 1024 ||
          ((threadId ?? provisionalThreadId) && nativeThread !== (threadId ?? provisionalThreadId))
        )
          return false
        provisionalThreadId ??= nativeThread
        const hook = Reflect.get(params, 'run'),
          id = hook && typeof hook === 'object' ? Reflect.get(hook, 'id') : undefined
        if (
          typeof id !== 'string' ||
          !id ||
          id.length > 1024 ||
          (turn != null && (typeof turn !== 'string' || turn.length > 1024))
        )
          startupHooks.unconfirmed = true
        else {
          const key = JSON.stringify([connection.executorId, nativeThread, turn ?? null, id])
          if (method === 'hook/started') {
            const bytes = [...startupHooks.pending].reduce(
              (sum, value) => sum + Buffer.byteLength(value),
              0,
            )
            if (
              startupHooks.pending.has(key) ||
              (startupHooks.pending.size < 64 && bytes + Buffer.byteLength(key) <= 64 * 1024)
            )
              startupHooks.pending.add(key)
            else startupHooks.unconfirmed = true
          } else if (
            ['completed', 'failed', 'blocked', 'stopped'].includes(
              String(Reflect.get(hook, 'status')),
            )
          )
            startupHooks.pending.delete(key)
        }
        void inspectRejectedIdle?.()
        return true
      })
      releaseNativeRequests = connection.subscribeServerRequests((request) => {
        const method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') return false
        if (method !== 'mcpServer/elicitation/request') return false
        const nativeThread = Reflect.get(params, 'threadId')
        if (typeof nativeThread !== 'string' || !nativeThread || nativeThread.length > 1024)
          return false
        if ((threadId ?? provisionalThreadId) && nativeThread !== (threadId ?? provisionalThreadId))
          return false
        // A startup MCP interaction can precede thread/start's ACK. Its sole
        // foreground request owner is verified against that ACK below.
        provisionalThreadId ??= nativeThread
        const nativeTurn = Reflect.get(params, 'turnId')
        if (interactions.size >= 8) {
          const id = Reflect.get(request, 'id')
          if (typeof id === 'string' || typeof id === 'number')
            void connection
              .respondError(
                id,
                'Pact cannot display another native initialization interaction within its bounded owner.',
              )
              .catch(() => undefined)
          return true
        }
        const interaction = this.relayPermission(
          connection,
          request,
          method,
          params,
          input,
          nativeThread,
          typeof nativeTurn === 'string' ? nativeTurn : undefined,
          observation.signal,
          handledRequests,
          approvalItems,
        ).catch(() => undefined)
        interactions.add(interaction)
        void interaction.finally(() => {
          interactions.delete(interaction)
          void inspectRejectedIdle?.()
        })
        return true
      })
      const releaseRequests = releaseNativeRequests
      releaseNativeRequests = () => {
        releaseRequests()
        releaseHookObservation?.()
      }
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: '',
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
        observation,
        release: releaseNativeRequests,
        interactions,
        startupHooks,
      })
      await input.onNativeCreationDispatched?.(connection.executorId)
      creationExecutorId = connection.executorId

      const started = await connection.request(
        'thread/start',
        {
          cwd: input.cwd,
          ephemeral: false,
          allowProviderModelFallback: false,
          config: toolConfig.config,
          ...(input.permissionMode && input.permissionMode !== 'native'
            ? toolConfig.nativePolicy
            : {}),
          ...(input.model ? { model: input.model } : {}),
        },
        {
          timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS,
          signal,
          onDispatch: () => {
            nativeCreationDispatched = true
          },
        },
      )
      const startError = Reflect.get(started, 'error')
      if (startError) {
        // Only an exact invalid-params response proves routing rejected this
        // creation before native startup. Other RPC failures may follow startup.
        creationNotStarted =
          typeof startError === 'object' &&
          Reflect.get(startError, 'code') === -32602 &&
          !provisionalThreadId &&
          !interactions.size &&
          !startupHooks.pending.size &&
          !startupHooks.unconfirmed
        throw classifyAgentError(new Error(JSON.stringify(startError)))
      }
      const result = Reflect.get(started, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      const resolvedId =
        thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
      if (typeof resolvedId !== 'string')
        throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
      if (provisionalThreadId && provisionalThreadId !== resolvedId)
        throw new AgentExecutionError(
          'protocol_error',
          'Codex returned a Thread different from its startup interaction.',
          false,
        )
      threadId = resolvedId
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
      })
      await input.onNativeSessionCreated?.(threadId)

      try {
        CodexAgentAdapter.confirmPermissionMode(started, input.permissionMode)
      } catch (error) {
        permissionRejected = true
        await inspectRejectedIdle()
        throw error
      }
      const items: object[] = []
      let bytes = 0
      let chunkIndex = 0
      const seedHash = createHash('sha256')
      const expectedSeed: string[] = []
      const flush = async (): Promise<void> => {
        if (items.length === 0) return
        const response = await connection.request(
          'thread/inject_items',
          { threadId, items: items.splice(0) },
          { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
        )
        bytes = 0
        const error = Reflect.get(response, 'error')
        if (error) throw classifyAgentError(new Error(JSON.stringify(error)))
        if (!Reflect.has(response, 'result'))
          throw new AgentExecutionError(
            'protocol_error',
            'Codex did not acknowledge the transcript append.',
            false,
          )
      }
      for await (const text of this.nativeSeedTexts(input, source, signal)) {
        chunkIndex += 1
        seedHash.update(text)
        expectedSeed.push(createHash('sha256').update(text).digest('hex'))
        const marker: NativeContextRebuildChunk = JSON.parse(text)
        if (marker.kind === 'image') {
          await flush()
          if (!input.resolveImage)
            throw new AgentExecutionError(
              'protocol_error',
              'The Pact image source is unavailable.',
              false,
            )
          const image = await input.resolveImage(marker.image.id, signal)
          requireNativeImageReference(image, marker.image)
          const reservation = connection.reserveWorkingMemory(nativeImagePreparationBytes([image]))
          try {
            const block = await nativeImageBlock(image, signal)
            const response = await connection.request(
              'thread/inject_items',
              {
                threadId,
                items: [
                  {
                    type: 'message',
                    role: 'user',
                    content: [
                      { type: 'input_text', text },
                      {
                        type: 'input_image',
                        image_url: `data:${block.source.media_type};base64,${block.source.data}`,
                      },
                    ],
                  },
                ],
              },
              { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
            )
            if (Reflect.get(response, 'error'))
              throw classifyAgentError(new Error(JSON.stringify(Reflect.get(response, 'error'))))
            if (!Reflect.has(response, 'result'))
              throw new AgentExecutionError(
                'protocol_error',
                'Codex did not acknowledge the image append.',
                false,
              )
          } finally {
            reservation.release()
          }
          continue
        }
        const item = {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text }],
        }
        const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8')
        if (items.length > 0 && bytes + itemBytes > CODEX_INJECT_TARGET_BYTES) await flush()
        items.push(item)
        bytes += itemBytes
      }
      const completeHash = seedHash.digest('hex')
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        seedHash: completeHash,
        chunkCount: chunkIndex,
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: false,
        pending: true,
      })
      await flush()
      this.rememberNativeRebuild(input.rebuildId, {
        nativeSessionId: threadId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        seedHash: completeHash,
        chunkCount: chunkIndex,
        executorId: connection.executorId,
        cwd: input.cwd,
        allSeedAcknowledged: true,
        pending: true,
      })
      const initializationWitness = await this.verifyNativeSeed(
        connection,
        input,
        threadId,
        expectedSeed,
        completeHash,
        signal,
      )
      if (!initializationWitness)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'The rebuilt Codex context was not confirmed idle by its creating executor. Its native Thread was preserved.',
          false,
        )
      input.reportNativeWork?.({
        executorId: connection.executorId,
        nativeSessionId: threadId,
        state: 'settled',
      })
      this.settleNativeRebuild(input.rebuildId)
      return { nativeSessionId: threadId, initializationWitness }
    } finally {
      if (
        creationExecutorId &&
        (!nativeCreationDispatched || creationNotStarted) &&
        !provisionalThreadId &&
        !interactions.size &&
        !startupHooks.pending.size &&
        !startupHooks.unconfirmed
      ) {
        input.reportNativeWork?.({ executorId: creationExecutorId, state: 'settled' })
        this.settleNativeRebuild(input.rebuildId)
      }
      if (!threadId && !provisionalThreadId) {
        // Durable unknown work still reserves its receipt. This ended owner
        // has no identity with which to claim a later creation's events.
        releaseNativeRequests?.()
        releaseHookObservation?.()
      }
      if (!nativeCreationDispatched || creationNotStarted)
        this.nativeRebuildReceipts.delete(input.rebuildId)
      if (
        !this.nativeRebuildReceipts.get(input.rebuildId)?.pending &&
        !observation.signal.aborted
      ) {
        releaseNativeRequests?.()
        releaseHookObservation?.()
        observation.abort()
      }
      this.running = false
      this.scheduleIdleDisconnect()
    }
  }

  async inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    if (this.disposed || signal.aborted || !input.nativeSessionId) return undefined

    const { expected, seedHash: expectedHash } = await this.nativeSeedExpectation(
      input,
      source,
      signal,
    )
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    try {
      const connection = await this.ensureConnection(input.cwd)
      await this.initializeConnection(connection, signal)
      const initializationWitness = await this.verifyNativeSeed(
        connection,
        input,
        input.nativeSessionId,
        expected,
        expectedHash,
        signal,
      )
      if (!initializationWitness) return undefined
      this.settleNativeRebuild(input.rebuildId)
      return { nativeSessionId: input.nativeSessionId, initializationWitness }
    } catch {
      return undefined
    } finally {
      this.scheduleIdleDisconnect()
    }
  }

  private async probeInitializedBinding(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    const identity: NativeEvidenceIdentity = {
      sessionId: input.sessionId,
      agentId: input.agentId,
      requestId: input.requestId,
      nativeSessionId: input.nativeSessionId,
      bindingGeneration: input.bindingGeneration,
    }
    const unavailable = (): NativeProbeResult => ({
      kind: 'no_evidence',
      identity,
      reason: 'The completed native initialization could not be confirmed by full readback.',
    })
    const unsettledOwner = (): boolean =>
      [...this.nativeBackground].some(
        (owner) =>
          !owner.closed &&
          (owner.primaryThreadId === input.nativeSessionId ||
            owner.threads.has(input.nativeSessionId)),
      ) ||
      [...this.nativeRebuildReceipts.values()].some(
        (receipt) => receipt.pending && receipt.nativeSessionId === input.nativeSessionId,
      )
    if (
      this.disposed ||
      signal.aborted ||
      input.agentId !== this.id ||
      input.runId !== undefined ||
      input.nativeTurnId !== undefined ||
      input.executorId !== undefined ||
      !input.confirmedInitialization.witness ||
      unsettledOwner()
    )
      return unavailable()
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    try {
      const connection = await this.ensureConnection(input.cwd)
      await this.initializeConnection(connection, signal)

      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const error = Reflect.get(response, 'error')
      if (error) {
        if (
          /not found|does not exist|unknown thread|missing thread|no rollout found/iu.test(
            JSON.stringify(error),
          )
        )
          return { kind: 'missing', identity, source: 'native_error' }
        return unavailable()
      }
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      if (
        !thread ||
        typeof thread !== 'object' ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        !['idle', 'notLoaded'].includes(Reflect.get(thread, 'status')?.type)
      )
        return unavailable()
      const { expected, seedHash } = await this.nativeSeedExpectation(
        input.confirmedInitialization,
        input.source,
        signal,
      )
      if (
        !(await this.readNativeSeed(
          connection,
          input.confirmedInitialization,
          input.nativeSessionId,
          expected,
          seedHash,
          signal,
          input.confirmedInitialization.witness,
        )) ||
        unsettledOwner()
      )
        return unavailable()
      CodexAgentAdapter.observeThreadTitle(thread, input.observeNativeTitle)
      return {
        kind: 'binding_ready',
        source: 'completed_initialization_readback',
        identity,
        ...input.confirmedInitialization,
        witness: input.confirmedInitialization.witness,
      }
    } catch {
      return unavailable()
    } finally {
      this.scheduleIdleDisconnect()
    }
  }

  private async nativeSeedExpectation(
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<{ expected: string[]; seedHash: string }> {
    const expected: string[] = []
    const digest = createHash('sha256')
    for await (const text of this.nativeSeedTexts(input, source, signal)) {
      digest.update(text)
      expected.push(createHash('sha256').update(text).digest('hex'))
    }
    return { expected, seedHash: digest.digest('hex') }
  }

  /** Creation and cold verification must serialize exactly the same seed evidence. */
  private async *nativeSeedTexts(
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): AsyncGenerator<string> {
    let count = 0
    let sourceBytes = 0
    for await (const chunk of source) {
      if (signal.aborted)
        throw new AgentExecutionError(
          'user_stopped',
          'Native source inspection was cancelled.',
          false,
        )
      sourceBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (count >= 4096 || sourceBytes > 8 * 1024 * 1024)
        throw new AgentExecutionError(
          'response_too_large',
          'The complete native source exceeded its technical budget; it was not truncated.',
          false,
        )
      yield JSON.stringify({
        pactContext: true,
        pactRebuildId: input.rebuildId,
        pactSourceHash: input.sourceHash,
        chunkIndex: count++,
        ...(chunk.kind === 'image' ? { formatVersion: 'pact-native-context-v2' } : {}),
        ...chunk,
      })
    }
    if (signal.aborted)
      throw new AgentExecutionError(
        'user_stopped',
        'Native source preparation was cancelled.',
        false,
      )
    if (count === 0)
      yield JSON.stringify({
        pactContext: true,
        pactRebuildId: input.rebuildId,
        pactSourceHash: input.sourceHash,
        chunkIndex: 0,
        formatVersion: 'pact-native-context-v1',
        chunks: [],
      })
  }

  /** Cold native reads retain their complete-history work budget and never hydrate a full Thread. */
  private async *nativePages(
    connection: CodexAppServerConnection,
    method: 'thread/turns/list' | 'thread/items/list',
    params: object,
    signal: AbortSignal,
    maxItems: number,
    maxBytes: number,
  ): AsyncGenerator<object> {
    let cursor: string | undefined
    let count = 0
    let bytes = 0
    do {
      // oxlint-disable-next-line no-await-in-loop -- Native opaque cursor pages are ordered.
      const response = await connection.request(
        method,
        { limit: 25, sortDirection: 'asc', ...params, ...(cursor ? { cursor } : {}) },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const data = result && typeof result === 'object' ? Reflect.get(result, 'data') : undefined
      const next =
        result && typeof result === 'object' ? Reflect.get(result, 'nextCursor') : undefined
      if (
        Reflect.get(response, 'error') ||
        !Array.isArray(data) ||
        data.length > (Reflect.get(params, 'limit') ?? 25) ||
        (next != null && (typeof next !== 'string' || !next || next.length > 8192)) ||
        (next != null && (next === cursor || !data.length))
      )
        throw new AgentExecutionError('protocol_error', 'Invalid native history page.', false)
      for (const entry of data) {
        bytes += Buffer.byteLength(JSON.stringify(entry), 'utf8')
        if (++count > maxItems || bytes > maxBytes)
          throw new AgentExecutionError(
            'response_too_large',
            'The complete native read exceeded its technical budget; it was not truncated.',
            false,
          )
        if (!entry || typeof entry !== 'object' || Array.isArray(entry))
          throw new AgentExecutionError('protocol_error', 'Invalid native history entry.', false)
        yield entry
      }
      cursor = next ?? undefined
    } while (cursor)
  }

  private async readNativeTurns(
    connection: CodexAppServerConnection,
    threadId: string,
    signal: AbortSignal,
    targetTurnId?: string,
  ): Promise<object[]> {
    const turns: object[] = []
    const identities = new Set<string>()
    for await (const turn of this.nativePages(
      connection,
      'thread/turns/list',
      { threadId, itemsView: 'notLoaded', sortDirection: 'desc' },
      signal,
      1000,
      1024 * 1024,
    )) {
      const id = Reflect.get(turn, 'id')
      if (typeof id !== 'string' || !id || id.length > 1024 || identities.has(id))
        throw new AgentExecutionError('protocol_error', 'Invalid native Turn identity.', false)
      identities.add(id)
      turns.push(turn)
      // Older Turns cannot affect this request's terminal safety. Long native
      // histories therefore do not force Rebuild just to check a recent Turn.
      if (id === targetTurnId) break
    }
    return turns.toReversed()
  }

  private readNativeItems(
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string | undefined,
    signal: AbortSignal,
    maxItems: number,
    maxBytes: number,
  ): AsyncGenerator<object> {
    return this.nativePages(
      connection,
      'thread/items/list',
      { threadId, limit: 1, ...(turnId ? { turnId } : {}) },
      signal,
      maxItems,
      maxBytes,
    )
  }

  private async readNativeOutput(
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    complete = false,
  ): Promise<Extract<NativeProbeResult, { kind: 'no_evidence' }>['output']> {
    return this.withNativeInspectionConnection(
      connection,
      input.cwd,
      signal,
      async (reader, readSignal) => {
        const items: object[] = []
        for await (const entry of this.readNativeItems(
          reader,
          threadId,
          turnId,
          readSignal,
          128,
          8 * 1024 * 1024,
        )) {
          const item = Reflect.get(entry, 'item')
          if (Reflect.get(entry, 'turnId') !== turnId || !item || typeof item !== 'object')
            throw new AgentExecutionError(
              'protocol_error',
              'Native answer ownership mismatch.',
              false,
            )
          items.push(item)
        }
        return CodexAgentAdapter.historicalOutput(
          [{ id: turnId, items, itemsView: 'full' }],
          input,
          complete,
        )
      },
    )
  }

  private async withNativeInspectionConnection<T>(
    live: CodexAppServerConnection,
    cwd: string,
    signal: AbortSignal,
    read: (reader: CodexAppServerConnection, readSignal: AbortSignal) => Promise<T>,
    options: {
      nativeIdentity?: boolean
      beforeInitialize?: (reader: CodexAppServerConnection) => void
    } = {},
  ): Promise<T> {
    if (
      this.nativeInspection ||
      this.disposed ||
      !this.processStorageRoot ||
      this.connection !== live
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The bounded native history reader is unavailable.',
        false,
      )
    const controller = new AbortController()
    const readSignal = AbortSignal.any([signal, controller.signal])
    const deadline = setTimeout(() => controller.abort(), 10_000)
    let child: ChildProcessWithoutNullStreams
    let closeProcess: (() => Promise<void>) | undefined
    try {
      if (this.processFactory) child = this.processFactory(cwd)
      else {
        const owned = await this.startProcess(cwd, this.processStorageRoot)
        child = owned.child
        closeProcess = owned.close
      }
      if (child === this.connectionProcess)
        throw new AgentExecutionError(
          'protocol_error',
          'The read-only process factory reused the live executor.',
          false,
        )
    } catch (error) {
      clearTimeout(deadline)
      controller.abort()
      throw error
    }
    const connection = new CodexAppServerConnection(child, undefined, closeProcess, this.ipcTraffic)
    const owner = { controller, connection, task: Promise.resolve<unknown>(undefined) }
    this.nativeInspection = owner
    const release = (): void => {
      if (this.nativeInspection === owner) this.nativeInspection = undefined
    }
    try {
      const task = (async () => {
        options.beforeInitialize?.(connection)
        const initialized = await connection.request(
          'initialize',
          {
            clientInfo: options.nativeIdentity
              ? { name: 'pact', title: 'Pact', version: '0.0.0' }
              : {
                  name: 'pact-native-reader',
                  title: 'Pact native history reader',
                  version: '0.0.0',
                },
            capabilities: { experimentalApi: true },
          },
          { timeoutMs: 10_000, signal: readSignal },
        )
        if (!Reflect.has(initialized, 'result') || Reflect.get(initialized, 'error'))
          throw new AgentExecutionError(
            'protocol_error',
            'The native history reader did not initialize.',
            false,
          )
        await connection.notify('initialized', {})
        return read(connection, readSignal)
      })()
      owner.task = task
      return await task
    } finally {
      clearTimeout(deadline)
      controller.abort()
      // Inspection retires only this short-lived observer, never the model executor.
      await connection.close(new Error('Read-only native history inspection finished.'))
      release()
    }
  }

  /** Resolve only implicit Windows readonly defaults; never inherit an old Thread's grant. */
  private async readWindowsDefaultPermissionSettings(
    live: CodexAppServerConnection,
    targetThreadId: string,
    signal: AbortSignal,
  ): Promise<object> {
    const cwd = this.processCwd,
      storageRoot = this.processStorageRoot,
      environmentKey = this.processEnvironmentKey
    const refusal = new PermissionModeRejectedError(
      'Native default permissions could not be safely resolved. Choose Ask for approval or configure a native permissions profile; no task was submitted.',
    )
    if (!cwd || !storageRoot || !environmentKey || this.connection !== live) throw refusal
    const current = (): boolean =>
      !signal.aborted &&
      !this.disposed &&
      live.isOpen &&
      this.connection === live &&
      this.processCwd === cwd &&
      this.processStorageRoot === storageRoot &&
      this.processEnvironmentKey === environmentKey &&
      createHash('sha256')
        .update(
          JSON.stringify({
            executable: this.executablePath,
            cwd,
            env: codexProcessEnvironment(storageRoot),
          }),
        )
        .digest('hex') === environmentKey
    let unexpected = false,
      releaseEvents: (() => void) | undefined,
      releaseRequests: (() => void) | undefined
    try {
      const policy = await this.withNativeInspectionConnection(
        live,
        cwd,
        signal,
        async (reader, readSignal) => {
          const readConfig = async (connection: CodexAppServerConnection): Promise<object> => {
            if (!current() || unexpected) throw refusal
            const response = await connection.request(
              'config/read',
              { cwd, includeLayers: false },
              { timeoutMs: 10_000, signal: readSignal },
            )
            const result = Reflect.get(response, 'result')
            if (
              Reflect.get(response, 'error') ||
              !result ||
              typeof result !== 'object' ||
              Array.isArray(result) ||
              Buffer.byteLength(JSON.stringify(result)) > 64 * 1024
            )
              throw refusal
            return result
          }
          const before = await readConfig(reader)
          if (!isDeepStrictEqual(before, await readConfig(live))) throw refusal
          const config = Reflect.get(before, 'config')
          if (!config || typeof config !== 'object' || Array.isArray(config)) throw refusal
          for (const key of ['hooks', 'mcp_servers', 'plugins']) {
            const value = Reflect.get(config, key)
            if (key === 'hooks') {
              if (!Object.hasOwn(config, key)) throw refusal
              if (value === null) continue
            }
            if (
              !value ||
              typeof value !== 'object' ||
              Array.isArray(value) ||
              Object.keys(value).length
            )
              throw refusal
          }
          const hookReply = await reader.request(
            'hooks/list',
            { cwds: [cwd] },
            { timeoutMs: 10_000, signal: readSignal },
          )
          const hooks = Reflect.get(Reflect.get(hookReply, 'result') ?? {}, 'data')
          if (
            Reflect.get(hookReply, 'error') ||
            !Array.isArray(hooks) ||
            hooks.length !== 1 ||
            hooks[0]?.cwd !== cwd ||
            !['hooks', 'warnings', 'errors'].every(
              (key) => Array.isArray(hooks[0][key]) && hooks[0][key].length === 0,
            )
          )
            throw refusal
          if (!current() || unexpected) throw refusal
          const response = await reader.request(
            'thread/start',
            { cwd, ephemeral: true, allowProviderModelFallback: false },
            { timeoutMs: 10_000, signal: readSignal },
          )
          const result = Reflect.get(response, 'result'),
            thread = result && typeof result === 'object' && Reflect.get(result, 'thread'),
            sandbox = result && Reflect.get(result, 'sandbox'),
            profile = result && Reflect.get(result, 'activePermissionProfile')
          if (
            Reflect.get(response, 'error') ||
            !thread ||
            typeof thread.id !== 'string' ||
            !thread.id ||
            thread.id.length > 1024 ||
            thread.id === targetThreadId ||
            this.loadedThreadIds.has(thread.id) ||
            thread.ephemeral !== true ||
            thread.cwd !== cwd ||
            !['untrusted', 'on-failure', 'on-request', 'never'].includes(result.approvalPolicy) ||
            !['user', 'auto_review'].includes(result.approvalsReviewer) ||
            sandbox?.type !== 'readOnly' ||
            sandbox.networkAccess !== false ||
            Object.keys(sandbox).length !== 2 ||
            profile?.id !== ':read-only' ||
            profile.extends !== null ||
            !isDeepStrictEqual(before, await readConfig(reader)) ||
            !isDeepStrictEqual(before, await readConfig(live)) ||
            !current() ||
            unexpected
          )
            throw refusal
          // One <=64-KiB result is owned by this permission installation, with no cache.
          return {
            approvalPolicy: result.approvalPolicy,
            approvalsReviewer: result.approvalsReviewer,
            sandboxPolicy: { ...sandbox },
          }
        },
        {
          nativeIdentity: true,
          beforeInitialize: (reader) => {
            const retire = (): void => {
              unexpected = true
              void reader.close(refusal).catch(() => undefined)
            }
            releaseEvents = reader.subscribeBackground((message) => {
              if (/^(?:hook|turn)\//u.test(String(Reflect.get(message, 'method')))) retire()
              return false
            })
            releaseRequests = reader.subscribeServerRequests(() => {
              retire()
              return true
            })
          },
        },
      )
      // The inspection's finally has already physically closed its independent process.
      if (!current() || unexpected) throw refusal
      return policy
    } catch {
      if (signal.aborted)
        throw new AgentExecutionError(
          'user_stopped',
          'Permission update was cancelled. No task was submitted.',
          false,
        )
      throw refusal
    } finally {
      releaseEvents?.()
      releaseRequests?.()
    }
  }

  private async verifyNativeSeed(
    connection: CodexAppServerConnection,
    input: AgentNativeContextRebuildInput,
    nativeSessionId: string,
    expected: readonly string[],
    seedHash: string,
    signal: AbortSignal,
  ): Promise<NativeInitializationWitness | undefined> {
    const receipt = this.nativeRebuildReceipts.get(input.rebuildId)
    if (
      !receipt ||
      receipt.executorId !== connection.executorId ||
      receipt.nativeSessionId !== nativeSessionId ||
      receipt.cwd !== input.cwd ||
      receipt.sourceHash !== input.sourceHash ||
      receipt.seedHash !== seedHash ||
      receipt.chunkCount !== expected.length ||
      !expected.length ||
      receipt.interactions?.size ||
      receipt.startupHooks?.pending.size ||
      receipt.startupHooks?.unconfirmed
    )
      return undefined
    const witness = await this.readNativeSeed(
      connection,
      input,
      nativeSessionId,
      expected,
      seedHash,
      signal,
    )
    return receipt.interactions?.size ||
      receipt.startupHooks?.pending.size ||
      receipt.startupHooks?.unconfirmed
      ? undefined
      : witness
  }

  /** Injected bootstrap seeds are response_items in the official rollout, not timeline Turns. */
  private async readNativeSeed(
    connection: CodexAppServerConnection,
    input: Pick<AgentNativeContextRebuildInput, 'rebuildId' | 'sourceHash'>,
    nativeSessionId: string,
    expected: readonly string[],
    seedHash: string,
    signal: AbortSignal,
    witness?: NativeInitializationWitness,
  ): Promise<NativeInitializationWitness | undefined> {
    const metadata = async (): Promise<object | undefined> => {
      const response = await connection.request(
        'thread/read',
        { threadId: nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const thread =
        result && typeof result === 'object' ? Reflect.get(result, 'thread') : undefined
      if (
        Reflect.get(response, 'error') ||
        !thread ||
        typeof thread !== 'object' ||
        Reflect.get(thread, 'id') !== nativeSessionId ||
        !(witness ? ['idle', 'notLoaded'] : ['idle']).includes(Reflect.get(thread, 'status')?.type)
      )
        return undefined
      return thread
    }
    const thread = await metadata()
    const path = thread && Reflect.get(thread, 'path')
    if (!thread || typeof path !== 'string' || !this.processStorageRoot) return undefined
    const verified = await readCodexInitializationRollout(
      {
        storageRoot: this.processStorageRoot,
        path,
        nativeSessionId,
        rebuildId: input.rebuildId,
        ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
        expectedSeedHashes: expected,
        seedHash,
        ...(witness ? { witness } : {}),
      },
      signal,
    )
    const after = await metadata()
    return after && Reflect.get(after, 'path') === path ? verified : undefined
  }

  async discoverSkills(
    cwd: string,
    signal: AbortSignal,
  ): Promise<import('@pact/contracts').SkillBinding[]> {
    signal.throwIfAborted()
    const connection = await this.ensureConnection(cwd)
    await this.initializeConnection(connection, signal)
    const reply = await connection.request(
      'skills/list',
      { cwds: [cwd], forceReload: true },
      { timeoutMs: 10_000, signal },
    )
    const error = Reflect.get(reply, 'error')
    if (error) throw new Error('Codex could not provide its native Skill catalog.')
    const result = nativeCodexSkillListSchema.parse(Reflect.get(reply, 'result'))
    const entry = result?.data?.find((value) => value.cwd === cwd)
    if (!entry || entry.errors.length)
      throw new Error(
        'Codex reported incomplete Skill discovery. Refresh after correcting its native configuration.',
      )
    return nativeSkillCatalog('codex', cwd, this.executablePath, entry.skills)
  }

  preflightPrompt(input: AgentRunInput): void {
    const workflow = input.promptEnvelope.collaboration
    const authorization = input.promptEnvelope.collaborationAuthorization
    if (
      workflow &&
      (!authorization ||
        authorization.runId !== input.runId ||
        authorization.taskId !== workflow.id ||
        workflow.sessionId !== input.sessionId ||
        input.promptEnvelope.sessionId !== input.sessionId ||
        authorization.actor !== this.id ||
        workflow.actor !== this.id)
    )
      throw new AgentExecutionError(
        'protocol_error',
        'The frozen Pact duty authorization is missing or inconsistent. Nothing was sent.',
        false,
      )
    const request = {
      id: Number.MAX_SAFE_INTEGER,
      method: 'turn/start',
      params: {
        threadId: input.nativeSessionId ?? 'x'.repeat(256),
        clientUserMessageId: input.runId,
        input: [
          ...(input.promptEnvelope.collaboration || input.readCollaborationSourcePart
            ? [
                {
                  type: 'text',
                  text: input.promptEnvelope.collaboration
                    ? collaborationInstructions(
                        input.promptEnvelope.collaboration,
                        input.promptEnvelope.collaborationAuthorization,
                      )
                    : frozenSourceInstructions,
                },
              ]
            : []),
          ...codexPromptInput(input.promptEnvelope),
        ],
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(input.promptEnvelope.collaboration
          ? {
              outputSchema: collaborationOutputSchema(
                input.promptEnvelope.collaboration,
                input.promptEnvelope.collaborationAuthorization,
              ),
            }
          : {}),
      },
    }
    if (freezeNativeJsonFrame(request) + 256 * 1024 > NATIVE_OWNER_WORKING_BYTES)
      throw new AgentExecutionError(
        'response_too_large',
        'Native request preparation capacity is full. Nothing was sent.',
        false,
      )
  }

  async *run(input: AgentRunInput, signal: AbortSignal): AsyncIterable<NormalizedAgentEvent> {
    if (this.peerToolServer.hasSourceGrant())
      throw new NativeCapacityError(
        'The previous native root still owns its frozen sources. No new task was submitted.',
      )
    const sourceGrant = input.promptEnvelope.sourceGrant
      ? { ...input.promptEnvelope.sourceGrant }
      : undefined
    if (
      input.readCollaborationSourcePart &&
      (!sourceGrant ||
        sourceGrant.runId !== input.runId ||
        (input.nativeGeneration && sourceGrant.grant !== input.nativeGeneration))
    )
      throw new AgentExecutionError(
        'protocol_error',
        'The source reader has no exact root owner.',
        false,
      )
    if (
      this.nativeBackground.size +
        this.nativeForkOwners.size +
        [...this.nativeRebuildReceipts.values()].filter((receipt) => receipt.pending).length >=
      8
    )
      throw new NativeCapacityError(
        'Codex has too many owned native background contexts. Wait for one to settle; no new task was submitted.',
      )
    if (this.running) {
      throw new AgentExecutionError(
        'protocol_error',
        'This Codex connection already has an active Run.',
        false,
      )
    }
    if (this.disposed) {
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    }
    if (signal.aborted) {
      throw new AgentExecutionError('agent_process_crash', 'Codex was interrupted.', false)
    }

    const workflow = input.promptEnvelope.collaboration
    const envelopeMode = Boolean(workflow)
    this.running = true
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.terminalEvidence.delete(input.runId)
    this.admitEvidenceCache()
    let connection: CodexAppServerConnection | undefined
    let threadId = input.nativeSessionId
    let turnId: string | undefined
    const delivery: {
      phase: 'before_dispatch' | 'possibly_delivered' | 'accepted' | 'terminal'
    } = { phase: 'before_dispatch' }
    let lastSuggestedTitle: string | undefined
    let peerProposalEmitted = false
    let peerReceipt: string | undefined
    let retryNotifications = 0
    let foreignErrorNotifications = 0
    const background: NativeBackground = {
      input,
      sourceGrant,
      parents: new Map(),
      threads: new Set(),
      operations: new Set(),
      spawns: new Set(),
      interactions: new Set(),
      early: [],
      earlyBytes: 0,
      observation: new AbortController(),
      foregroundReleased: false,
      rootTerminal: false,
      rootNotStarted: false,
      reportedUnknown: false,
      untrackedWork: false,
      turns: new Map(),
      turnIds: new Set(),
      recordings: new Set(),
      recordingTail: Promise.resolve(),
      foregroundCommands: new Map(),
      foregroundCommandBytes: 0,
      cancellationPending: false,
      unknown: false,
      closed: false,
    }
    // Stop withdraws only the foreground's current interaction. Native child
    // and detached requests keep their separate observation owner.
    const foregroundInteractionSignal = AbortSignal.any([signal, background.observation.signal])
    let stoppedCommands: Map<string, string | undefined> | undefined
    const freezeForegroundCommands = (): void => {
      if (background.closed || stoppedCommands) return
      if (sourceGrant) this.peerToolServer.retireSourceReader(sourceGrant)
      stoppedCommands = background.rootTerminal ? new Map() : background.foregroundCommands
      background.foregroundCommands = new Map()
      background.foregroundCommandBytes = 0
      background.cancellationPending = true
    }
    signal.addEventListener('abort', freezeForegroundCommands, { once: true })
    const handledRequests = new Set<string>()
    const approvalItems = new Map<string, ApprovalItem>()
    let provisionalThreadId: string | undefined
    let nativeStartupDispatched = false
    let releaseNativeRequests: (() => void) | undefined
    let releaseApprovalMetadata: (() => void) | undefined
    const answer = new AgentAnswerAssembler(input.runId)
    const carrierMemory = new NativeWorkingMemory().reserve(0)
    let finalCarrier: unknown
    let projectionFailure: unknown
    background.release = () => {
      if (sourceGrant) this.peerToolServer.retireSourceReader(sourceGrant)
      releaseNativeRequests?.()
      releaseApprovalMetadata?.()
      answer.dispose()
      finalCarrier = undefined
      carrierMemory.release()
    }
    const reasoningSummaryStates = new Map<string, { pendingPrefix: string; emitted: boolean }>()
    const observed = new WeakSet<object>()
    let replaying = false
    const reportUnknown = (
      reason: string,
      scope: 'unlisted' | 'recorded_files' = 'unlisted',
      evidence: 'incomplete' | 'awaiting_terminal' = 'incomplete',
    ): void => {
      if (evidence === 'incomplete') background.unknown = true
      nativeEffectsUncertain(input, reason, scope)
      if (!background.reportedUnknown) {
        background.reportedUnknown = true
        nativeFileChangesSettled(
          input,
          'unknown',
          evidence === 'awaiting_terminal'
            ? 'native_completion_pending'
            : 'native_work_unconfirmed',
        )
      }
    }
    const maybeSettle = (): void => {
      if (
        background.foregroundReleased &&
        (background.rootTerminal || background.rootNotStarted) &&
        !background.threads.size &&
        !background.operations.size &&
        !background.spawns.size &&
        !background.interactions.size &&
        !background.recordings.size &&
        !background.early.length &&
        !background.cancellationPending &&
        !background.untrackedWork
      )
        this.settleNativeBackground(background)
    }
    const bufferEarly = (event: object, retained?: EarlyNativeFact): boolean => {
      const params = Reflect.get(event, 'params')
      const child =
        params && typeof params === 'object' ? Reflect.get(params, 'threadId') : undefined
      if (
        !background.spawns.size &&
        !(
          nativeStartupDispatched &&
          !background.primaryThreadId &&
          ['hook/started', 'hook/completed'].includes(String(Reflect.get(event, 'method')))
        ) &&
        delivery.phase !== 'possibly_delivered' &&
        !(typeof child === 'string' && background.parents.has(child))
      )
        return false
      let reservation = retained?.reservation
      try {
        const heldBytes = retained?.heldBytes ?? freezeNativeJsonFrame(event)
        // Admission includes the immutable DTO and worst-case UTF-16 escaped JSON counting copy.
        if (!connection?.isOpen) throw new Error('The early Native fact owner closed.')
        reservation ??= connection.reserveWorkingMemory(heldBytes * 7 + 4096)
        const bytes = retained?.bytes ?? Buffer.byteLength(JSON.stringify(event))
        if (background.early.length >= 128 || background.earlyBytes + bytes > 8 * 1024 * 1024) {
          reservation.release()
          background.untrackedWork = true
          reportUnknown(
            'Early native child events exceeded the observation budget; complete attribution is unavailable.',
          )
          return true
        }
        reservation.resize(heldBytes)
        background.early.push(retained ?? { event, bytes, heldBytes, reservation })
        background.earlyBytes += bytes
      } catch {
        reservation?.release()
        background.untrackedWork = true
        reportUnknown(
          'Early native facts could not be retained within the Connection working budget.',
        )
        return true
      }
      background.earlyTimer ??= setTimeout(() => {
        if (background.early.length) background.untrackedWork = true
        if (background.early.length)
          reportUnknown(
            'Early native child events could not be bound to an owned spawn before the deadline.',
          )
        for (const entry of background.early) entry.reservation.release()
        background.early = []
        background.earlyBytes = 0
        background.earlyTimer = undefined
        maybeSettle()
      }, 30_000)
      return true
    }
    const replayEarly = (): void => {
      if (replaying || !background.early.length) return
      replaying = true
      try {
        for (let pass = 0; pass < 128 && background.early.length; pass += 1) {
          const queued: (EarlyNativeFact | undefined)[] = background.early
          background.early = []
          background.earlyBytes = 0
          let progressed = false
          try {
            for (let index = 0; index < queued.length; index += 1) {
              const entry = queued[index]!
              queued[index] = undefined
              try {
                if (!handleOwnedNativeEvent(entry.event)) bufferEarly(entry.event, entry)
                else progressed = true
              } finally {
                if (!background.early.includes(entry)) entry.reservation.release()
              }
            }
          } finally {
            for (const entry of queued) entry?.reservation.release()
          }
          if (!progressed) break
        }
      } finally {
        replaying = false
        if (!background.early.length) {
          clearTimeout(background.earlyTimer)
          background.earlyTimer = undefined
        }
      }
    }
    const handleOwnedNativeEvent = (event: object): boolean => {
      const nativeConnection = connection
      if (!nativeConnection || background.closed || background.connection !== nativeConnection)
        return false
      const eventParams = Reflect.get(event, 'params')
      if (!eventParams || typeof eventParams !== 'object') return false
      const eventMethod = Reflect.get(event, 'method')
      const startedThread =
        eventMethod === 'thread/started' ? Reflect.get(eventParams, 'thread') : undefined
      const suppliedThread =
        Reflect.get(eventParams, 'threadId') ?? Reflect.get(eventParams, 'conversationId')
      const suppliedTurn =
        Reflect.get(eventParams, 'turnId') ??
        (Reflect.get(eventParams, 'turn') && typeof Reflect.get(eventParams, 'turn') === 'object'
          ? Reflect.get(Reflect.get(eventParams, 'turn'), 'id')
          : undefined)
      const suppliedChild =
        startedThread && typeof startedThread === 'object'
          ? Reflect.get(startedThread, 'id')
          : suppliedThread
      if (
        (typeof suppliedChild === 'string' && this.retiredNativeChildren.has(suppliedChild)) ||
        (typeof suppliedThread === 'string' &&
          typeof suppliedTurn === 'string' &&
          this.retiredNativeTurns.has(JSON.stringify([suppliedThread, suppliedTurn])))
      ) {
        const requestId = Reflect.get(event, 'id')
        if (typeof requestId === 'string' || typeof requestId === 'number')
          void nativeConnection
            .respondError(requestId, 'This native request belongs to a retired Run generation.')
            .catch(() => undefined)
        return true
      }
      if (startedThread && typeof startedThread === 'object') {
        const parent = Reflect.get(startedThread, 'parentThreadId'),
          child = Reflect.get(startedThread, 'id')
        if (
          typeof child === 'string' &&
          child.length <= 1024 &&
          typeof parent === 'string' &&
          (parent === background.primaryThreadId || background.parents.has(parent)) &&
          background.spawns.size > 0
        ) {
          if (background.parents.size < 64) {
            background.parents.set(child, parent)
            background.threads.add(child)
            replayEarly()
          } else {
            background.untrackedWork = true
            reportUnknown('Native child ancestry exceeded its bounded observer.')
          }
          return true
        }
      }
      const eventThread =
        Reflect.get(eventParams, 'threadId') ??
        Reflect.get(eventParams, 'conversationId') ??
        (startedThread && typeof startedThread === 'object'
          ? Reflect.get(startedThread, 'id')
          : undefined)
      const root = eventThread === background.primaryThreadId
      const detachedRoot = root && background.rootTerminal && eventMethod !== 'turn/completed'
      if (typeof eventThread !== 'string' || (!root && !background.parents.has(eventThread)))
        return replaying ? false : bufferEarly(event)
      const eventTurn = Reflect.get(eventParams, 'turn')
      const eventTurnId =
        Reflect.get(eventParams, 'turnId') ??
        (eventTurn && typeof eventTurn === 'object' ? Reflect.get(eventTurn, 'id') : undefined)
      const ownedTurn = root
        ? eventTurnId === background.primaryTurnId
        : typeof eventTurnId === 'string' &&
          background.turnIds.has(JSON.stringify([eventThread, eventTurnId]))
      if (eventMethod === 'turn/started' && !root && typeof eventTurnId === 'string') {
        if (
          background.turnIds.size >= 256 &&
          !background.turnIds.has(JSON.stringify([eventThread, eventTurnId]))
        ) {
          background.untrackedWork = true
          reportUnknown('Native child Turn identities exceeded the bounded observer.')
          return true
        }
        background.turns.set(eventThread, eventTurnId)
        background.turnIds.add(JSON.stringify([eventThread, eventTurnId]))
        background.threads.add(eventThread)
      }
      if (
        eventMethod !== 'turn/started' &&
        typeof eventMethod === 'string' &&
        (eventMethod.startsWith('item/') || eventMethod === 'turn/completed') &&
        !ownedTurn
      ) {
        if (root) return false
        if (!background.turns.has(eventThread) && typeof eventTurnId === 'string')
          return replaying ? false : bufferEarly(event)
        const requestId = Reflect.get(event, 'id')
        if (typeof requestId === 'string' || typeof requestId === 'number')
          void nativeConnection
            .respondError(
              requestId,
              'This native request does not belong to the registered child Turn.',
            )
            .catch(() => undefined)
        return true
      }
      if (eventMethod === 'hook/started' || eventMethod === 'hook/completed') {
        // Thread-scoped startup Hooks have no Turn ID. An older released Run
        // may finish its own Hook, but cannot claim a later startup's new Hook.
        const hook = Reflect.get(eventParams, 'run')
        const hookId = hook && typeof hook === 'object' ? Reflect.get(hook, 'id') : undefined
        const nullableTurn = eventTurnId == null ? null : eventTurnId
        if (nullableTurn !== null && !ownedTurn) return false
        const validIdentity =
          typeof hookId === 'string' &&
          Boolean(hookId) &&
          hookId.length <= 1024 &&
          eventThread.length <= 1024 &&
          (nullableTurn === null ||
            (typeof nullableTurn === 'string' && nullableTurn.length <= 1024))
        if (eventMethod === 'hook/completed' && !validIdentity) return false
        const key = validIdentity
          ? JSON.stringify(['hook', nativeConnection.executorId, eventThread, nullableTurn, hookId])
          : ''
        if (
          eventMethod === 'hook/started' &&
          root &&
          background.foregroundReleased &&
          nullableTurn === null &&
          !background.operations.has(key)
        )
          return false
        if (!validIdentity) {
          background.untrackedWork = true
          reportUnknown('Native Hook identity exceeded its bounded observer.')
        } else if (eventMethod === 'hook/started') {
          const hookBytes = [...background.operations]
            .filter((value) => value.startsWith('["hook",'))
            .reduce((sum, value) => sum + Buffer.byteLength(value), 0)
          if (
            background.operations.has(key) ||
            (background.operations.size < 64 && hookBytes + Buffer.byteLength(key) <= 64 * 1024)
          )
            background.operations.add(key)
          else {
            background.untrackedWork = true
            reportUnknown('Native Hook work exceeded its bounded operation owner.')
          }
          nativeEffectsUncertain(
            input,
            'Native hooks may modify files beyond reported operation evidence.',
          )
        } else {
          // A different Run can own a nullable-turn Hook on this Thread.
          // Leave unmatched completion available to its exact owner.
          if (!background.operations.has(key)) return false
          if (
            ['completed', 'failed', 'blocked', 'stopped'].includes(
              String(Reflect.get(hook, 'status')),
            )
          )
            background.operations.delete(key)
        }
        maybeSettle()
        return true
      }
      if (observed.has(event)) return !root || background.foregroundReleased
      observed.add(event)
      if (envelopeMode && root && ownedTurn && eventMethod === 'item/completed') {
        const item = Reflect.get(eventParams, 'item')
        if (
          item &&
          typeof item === 'object' &&
          Reflect.get(item, 'type') === 'agentMessage' &&
          typeof Reflect.get(item, 'id') === 'string' &&
          typeof Reflect.get(item, 'text') === 'string' &&
          Reflect.get(item, 'phase') === 'commentary'
        )
          answer.complete(Reflect.get(item, 'id'), Reflect.get(item, 'text'))
        if (
          item &&
          typeof item === 'object' &&
          Reflect.get(item, 'type') === 'agentMessage' &&
          Reflect.get(item, 'phase') !== 'commentary'
        ) {
          const text = Reflect.get(item, 'text')
          finalCarrier = undefined
          if (typeof text === 'string') {
            input.recordCollaborationCarrierText?.(text)
            // Raw DTO text and the parsed string workspace; ordered dump/projection copies were removed.
            carrierMemory.resize(4096 + text.length * 4 + Buffer.byteLength(text) * 2)
            finalCarrier = readCollaborationEnvelopeText(text)
            if (finalCarrier === undefined) {
              const natural = collaborationNaturalFallback(text)
              if (natural !== undefined) answer.complete(String(Reflect.get(item, 'id')), natural)
            }
          }
        }
      }
      // Envelope deltas are protocol, not natural answer items. The root completed carrier is authoritative.
      if (eventMethod === 'turn/completed') {
        if (root) {
          const status =
            eventTurn && typeof eventTurn === 'object'
              ? Reflect.get(eventTurn, 'status')
              : undefined
          if (status === 'completed' || status === 'failed' || status === 'interrupted') {
            background.rootTerminal = true
            if (sourceGrant) this.peerToolServer.retireSourceReader(sourceGrant)
            let submittedReport: ReturnType<typeof readSubmittedCollaborationReport>
            if (envelopeMode) {
              try {
                input.recordCollaborationCarrier?.(finalCarrier)
                const canonical = readCollaborationAnswer(finalCarrier, input.answerFormat)
                if (canonical !== undefined) answer.replace(canonical)
                submittedReport = readSubmittedCollaborationReport(finalCarrier, input.answerFormat)
              } catch (error) {
                projectionFailure = error
                recordDiagnostic({
                  operation: 'native_check',
                  phase: 'failed',
                  level: 'warn',
                  scope: 'run',
                  agentId: 'codex',
                  sessionId: input.sessionId,
                  runId: input.runId,
                  runtimeBoundary: 'projection',
                  code: classifyAgentError(error).kind,
                  runtimeErrorType:
                    diagnosticEventSchema.shape.runtimeErrorType.safeParse(
                      error instanceof Error ? error.name : 'other',
                    ).data ?? 'other',
                })
              }
            }
            this.recordTerminal(
              input,
              background.primaryThreadId!,
              background.primaryTurnId!,
              status,
              projectionFailure ? { outputId: answer.outputId, text: '' } : answer,
              submittedReport,
            )
            if (background.foregroundReleased) {
              const text = projectionFailure
                ? undefined
                : envelopeMode
                  ? answer.text
                  : answer.finalize()
              if (text !== undefined)
                input.recordArchivedEvent?.({
                  agentId: 'codex',
                  type: 'text.completed',
                  turnId: background.primaryTurnId!,
                  outputId: answer.outputId,
                  text,
                })
              input.recordArchivedEvent?.({
                agentId: 'codex',
                type: 'turn.completed',
                turnId: background.primaryTurnId!,
                outcome: status,
              })
            }
          }
        } else if (background.turns.get(eventThread) === eventTurnId)
          background.threads.delete(eventThread)
      }
      if (root && background.foregroundReleased && ownedTurn) {
        if (!envelopeMode && eventMethod === 'item/agentMessage/delta') {
          const itemId = Reflect.get(eventParams, 'itemId'),
            delta = Reflect.get(eventParams, 'delta')
          if (typeof itemId === 'string' && typeof delta === 'string') {
            const text = answer.append(itemId, delta)
            input.recordArchivedEvent?.({
              agentId: 'codex',
              type: 'text.delta',
              turnId: background.primaryTurnId!,
              outputId: answer.outputId,
              text,
            })
          }
        } else if (!envelopeMode && eventMethod === 'item/completed') {
          const item = Reflect.get(eventParams, 'item')
          if (item && typeof item === 'object' && Reflect.get(item, 'type') === 'agentMessage') {
            const itemId = Reflect.get(item, 'id'),
              text = Reflect.get(item, 'text')
            if (typeof itemId === 'string' && typeof text === 'string') {
              const completed = answer.complete(itemId, text)
              if (completed !== undefined)
                input.recordArchivedEvent?.({
                  agentId: 'codex',
                  type: 'text.completed',
                  turnId: background.primaryTurnId!,
                  outputId: answer.outputId,
                  text: completed,
                })
            }
          }
        }
      }
      if (eventMethod === 'item/started') {
        const item = Reflect.get(eventParams, 'item')
        if (item && typeof item === 'object') {
          cacheApprovalItem(approvalItems, item, eventThread, eventTurnId)
          const itemId = Reflect.get(item, 'id'),
            type = Reflect.get(item, 'type')
          if (
            root &&
            ownedTurn &&
            !detachedRoot &&
            !signal.aborted &&
            !background.foregroundReleased &&
            nativeConnection === this.connection &&
            type === 'commandExecution' &&
            ['agent', 'unifiedExecStartup'].includes(String(Reflect.get(item, 'source')))
          ) {
            const processId = Reflect.get(item, 'processId')
            if (
              typeof itemId !== 'string' ||
              !itemId ||
              Buffer.byteLength(itemId) > 1024 ||
              (processId != null &&
                (typeof processId !== 'string' ||
                  !processId ||
                  Buffer.byteLength(processId) > 1024))
            ) {
              reportUnknown('Native foreground command identity could not be verified.')
            } else {
              const handle = typeof processId === 'string' ? processId : undefined
              const bytes = Buffer.byteLength(JSON.stringify([itemId, handle ?? null]))
              const previous = background.foregroundCommands.get(itemId)
              const previousBytes = background.foregroundCommands.has(itemId)
                ? Buffer.byteLength(JSON.stringify([itemId, previous ?? null]))
                : 0
              if (
                (!background.foregroundCommands.has(itemId) &&
                  background.foregroundCommands.size >= CODEX_STOP_COMMANDS) ||
                background.foregroundCommandBytes - previousBytes + bytes >
                  CODEX_STOP_IDENTITY_BYTES ||
                (previous !== undefined && handle !== previous)
              ) {
                reportUnknown('Native foreground command ownership exceeded its bounded evidence.')
              } else {
                background.foregroundCommands.set(itemId, handle)
                background.foregroundCommandBytes += bytes - previousBytes
              }
            }
          }
          if (
            typeof itemId === 'string' &&
            itemId.length <= 1024 &&
            typeof eventTurnId === 'string'
          ) {
            const key = JSON.stringify([eventThread, eventTurnId, itemId])
            if (
              ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(
                String(type),
              )
            ) {
              if (background.operations.size < 64) background.operations.add(key)
              else {
                background.untrackedWork = true
                reportUnknown('Native command observation exceeded its bounded item set.')
              }
            }
            if (
              ['collabAgentToolCall', 'collabToolCall'].includes(String(type)) &&
              Reflect.get(item, 'tool') === 'spawnAgent'
            ) {
              if (background.spawns.size < 64) background.spawns.add(key)
              else {
                background.untrackedWork = true
                reportUnknown('Native spawn observation exceeded its bounded item set.')
              }
            }
          }
        }
      }
      if (Object.hasOwn(event, 'id') && typeof eventMethod === 'string') {
        if (root && !background.foregroundReleased && !detachedRoot) return false
        if (background.interactions.size >= 8) {
          reportUnknown('Native interactions exceeded their bounded request owner.')
          const requestId = Reflect.get(event, 'id')
          if (typeof requestId === 'string' || typeof requestId === 'number')
            void nativeConnection
              .respondError(
                requestId,
                'Pact cannot display another native interaction within its request budget. No approval response was sent.',
              )
              .catch(() => undefined)
          return true
        }
        const interaction = this.relayPermission(
          nativeConnection,
          event,
          eventMethod,
          eventParams,
          input,
          eventThread,
          eventThread === background.primaryThreadId
            ? background.primaryTurnId
            : typeof eventTurnId === 'string'
              ? eventTurnId
              : background.turns.get(eventThread),
          background.observation.signal,
          handledRequests,
          approvalItems,
        ).catch(() => reportUnknown('Native background approval delivery could not be confirmed.'))
        background.interactions.add(interaction)
        void interaction.finally(() => {
          background.interactions.delete(interaction)
          maybeSettle()
        })
      }
      if (eventMethod === 'item/completed') {
        const item = Reflect.get(eventParams, 'item')
        if (item && typeof item === 'object')
          this.trackNativeBackground(
            background,
            item,
            eventThread,
            typeof eventTurnId === 'string' ? eventTurnId : undefined,
          )
        replayEarly()
        if (
          item &&
          typeof item === 'object' &&
          Reflect.get(item, 'type') === 'fileChange' &&
          (!root || background.foregroundReleased || detachedRoot)
        ) {
          if (background.recordings.size >= 8)
            reportUnknown(
              'Native background evidence exceeded its bounded recording queue.',
              'recorded_files',
            )
          else {
            const evidence = codexFileChanges(item, input.cwd)
            const nativeId = Reflect.get(item, 'id')
            evidence.changes = evidence.changes.map((change, index) => ({
              ...change,
              ...(typeof nativeId === 'string'
                ? { operationId: `${eventThread}:${nativeId}:${index}` }
                : { unavailableReason: 'The native operation identity was unavailable.' }),
            }))
            const recording = background.recordingTail.then(() =>
              recordNativeChanges(input, evidence, background.observation.signal),
            )
            background.recordingTail = recording
            background.recordings.add(recording)
            void recording.finally(() => {
              background.recordings.delete(recording)
              maybeSettle()
            })
          }
        }
      }
      maybeSettle()
      if (!root)
        nativeEffectsUncertain(
          input,
          'Native child/background work may include effects outside recorded file operations.',
        )
      return !root || background.foregroundReleased || detachedRoot
    }

    try {
      connection = await this.ensureConnection(input.cwd)
      input.recordExecutor?.(connection.executorId)
      background.connection = connection
      this.nativeBackground.add(background)
      await this.initializeConnection(connection, signal)
      peerReceipt = this.peerToolServer.beginTurn(
        'claude',
        !workflow && input.peerAssistanceAllowed !== false,
        workflow,
        input.promptEnvelope.requestSessionTitle === true,
        input.readCollaborationSourcePart
          ? (raw) => {
              if (
                background.closed ||
                background.rootTerminal ||
                signal.aborted ||
                !connection?.isOpen
              )
                throw new Error('This source reader belongs to a retired root Turn.')
              return input.readCollaborationSourcePart!(raw)
            }
          : undefined,
        sourceGrant,
      )
      // Loaded Threads ignore resume config: their installed capability URL must stay stable.
      const peerToolUrl = await this.peerToolServer.start()
      const toolConfig = await this.pactToolConfig(
        connection,
        peerToolUrl,
        input.cwd,
        signal,
        input.permissionMode,
      )
      const phasePolicy = collaborationReadOnly(
        workflow,
        input.promptEnvelope.collaborationAuthorization,
      )
        ? {
            approvalPolicy: 'never',
            approvalsReviewer: 'user',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
          }
        : toolConfig.settingsPolicy
      const nativeConnection = connection
      releaseApprovalMetadata = nativeConnection.subscribeBackground((event) => {
        // Settings ACK belongs to the current next-task update, not an older Run.
        if (Reflect.get(event, 'method') === 'thread/settings/updated') return false
        if (handleOwnedNativeEvent(event)) return true
        const params = Reflect.get(event, 'params')
        if (
          !params ||
          typeof params !== 'object' ||
          Reflect.get(params, 'threadId') !== (threadId ?? provisionalThreadId)
        )
          return false
        const item = Reflect.get(params, 'item')
        if (item && typeof item === 'object') {
          if (Reflect.get(event, 'method') === 'item/started')
            cacheApprovalItem(
              approvalItems,
              item,
              Reflect.get(params, 'threadId'),
              Reflect.get(params, 'turnId'),
            )
        }
        return false
      })
      releaseNativeRequests = nativeConnection.subscribeServerRequests((request) => {
        if (handleOwnedNativeEvent(request)) return true
        const method = Reflect.get(request, 'method'),
          params = Reflect.get(request, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') return false
        const nativeThread =
          Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId')
        if (
          !nativeStartupDispatched ||
          (delivery.phase === 'before_dispatch' && method !== 'mcpServer/elicitation/request') ||
          typeof nativeThread !== 'string' ||
          !nativeThread ||
          nativeThread.length > 1024 ||
          ((threadId ?? provisionalThreadId) && nativeThread !== (threadId ?? provisionalThreadId))
        )
          return false
        provisionalThreadId ??= nativeThread
        const requestedTurn = Reflect.get(params, 'turnId')
        if (delivery.phase !== 'before_dispatch' && typeof requestedTurn === 'string') {
          if (turnId && turnId !== requestedTurn) return false
          // A native request can precede the Turn ACK. That ACK must confirm
          // this exact identity before it can own subsequent stream events.
          turnId ??= requestedTurn
        }
        if (background.interactions.size >= 8) {
          reportUnknown('Native interactions exceeded their bounded request owner.')
          const requestId = Reflect.get(request, 'id')
          if (typeof requestId === 'string' || typeof requestId === 'number')
            void nativeConnection
              .respondError(
                requestId,
                'Pact cannot display another native interaction within its request budget. No approval response was sent.',
              )
              .catch(() => undefined)
          return true
        }
        const interaction = this.relayPermission(
          nativeConnection,
          request,
          method,
          params,
          input,
          nativeThread,
          delivery.phase === 'before_dispatch' && typeof requestedTurn === 'string'
            ? requestedTurn
            : turnId,
          foregroundInteractionSignal,
          handledRequests,
          approvalItems,
        ).catch(() =>
          nativeEffectsUncertain(
            input,
            'Native interaction response delivery could not be confirmed.',
          ),
        )

        background.interactions.add(interaction)
        void interaction.finally(() => {
          background.interactions.delete(interaction)
          maybeSettle()
        })
        return true
      })

      // Native resume preserves the installed stable capability for a loaded Thread.
      {
        nativeStartupDispatched = true
        const message = await connection.request(
          input.nativeSessionId ? 'thread/resume' : 'thread/start',
          input.nativeSessionId
            ? {
                threadId: input.nativeSessionId,
                excludeTurns: true,
                cwd: input.cwd,
                config: toolConfig.config,
                ...(input.model ? { model: input.model } : {}),
              }
            : {
                cwd: input.cwd,
                ephemeral: false,
                allowProviderModelFallback: false,
                config: toolConfig.config,
                ...(input.permissionMode && input.permissionMode !== 'native'
                  ? toolConfig.nativePolicy
                  : {}),
                ...(input.model ? { model: input.model } : {}),
              },
          { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
        )
        const rpcError = Reflect.get(message, 'error')
        if (rpcError) {
          // An explicit startup rejection proves no Turn was submitted. This is
          // not a completed Turn; outstanding startup interactions still drain.
          background.rootNotStarted = true
          input.recordDispatch?.('rejected', input.nativeSessionId, connection.executorId)
          if (input.nativeSessionId) {
            if (
              typeof rpcError === 'object' &&
              !Array.isArray(rpcError) &&
              Reflect.get(rpcError, 'code') === -32600 &&
              Reflect.get(rpcError, 'message') ===
                `thread ${input.nativeSessionId} already has an active writer`
            )
              throw new NativeThreadOccupiedError()
            const detail = safeNativePermissionText(JSON.stringify(rpcError), 1024)
            if (isCodexArchivedSessionRejection(rpcError, input.nativeSessionId))
              throw new NativeThreadArchivedError(`Codex thread/resume rejected: ${detail}`)
            if (
              !/not found|does not exist|unknown thread|missing thread|no rollout found/iu.test(
                detail,
              )
            )
              throw classifyAgentError(new Error(`Codex thread/resume rejected: ${detail}`))
            throw new AgentExecutionError(
              'context_resume_failed',
              `Codex thread/resume could not find the saved native session: ${detail}`,
              false,
            )
          }
          throw classifyAgentError(new Error(JSON.stringify(rpcError)))
        }
        const result = Reflect.get(message, 'result')
        const thread = result && typeof result === 'object' ? Reflect.get(result, 'thread') : null
        const resolvedModel =
          result && typeof result === 'object' ? Reflect.get(result, 'model') : undefined
        const resolvedEffort =
          result && typeof result === 'object' ? Reflect.get(result, 'reasoningEffort') : undefined
        const resolvedThreadId =
          thread && typeof thread === 'object' ? Reflect.get(thread, 'id') : undefined
        if (typeof resolvedThreadId !== 'string') {
          throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
        }
        if (input.nativeSessionId && input.nativeSessionId !== resolvedThreadId) {
          background.rootNotStarted = true
          input.recordDispatch?.('rejected', input.nativeSessionId, nativeConnection.executorId)
          throw new AgentExecutionError(
            'context_resume_failed',
            'Codex resumed a different native Thread. The original binding was preserved.',
            false,
          )
        }
        if (provisionalThreadId && provisionalThreadId !== resolvedThreadId)
          throw new AgentExecutionError(
            'protocol_error',
            'Codex returned a Thread different from its startup interaction.',
            false,
          )
        threadId = resolvedThreadId
        background.primaryThreadId = threadId
        replayEarly()
        try {
          if (
            input.nativeSessionId ||
            collaborationReadOnly(workflow, input.promptEnvelope.collaborationAuthorization)
          )
            await this.applyPermissionSettings(
              connection,
              resolvedThreadId,
              phasePolicy,
              signal,
              message,
            )
          else CodexAgentAdapter.confirmPermissionMode(message, input.permissionMode)
        } catch (error) {
          background.rootNotStarted = true
          input.recordDispatch?.('rejected', resolvedThreadId, connection.executorId)
          throw error
        }
        this.rememberThread(resolvedThreadId)
        if (typeof resolvedModel === 'string' && resolvedModel) {
          const configuration = resolveCodexThreadConfiguration(input, {
            model: resolvedModel,
            ...(typeof resolvedEffort === 'string' ? { reasoningEffort: resolvedEffort } : {}),
          })
          this.rememberThread(resolvedThreadId, configuration)
          yield* resolvedModelEvent(configuration)
        }
        yield { agentId: 'codex', type: 'session.started', nativeSessionId: threadId }
        CodexAgentAdapter.observeThreadTitle(thread, input.observeNativeTitle)
        const existingTitle = CodexAgentAdapter.threadTitle(thread)
        if (existingTitle) {
          lastSuggestedTitle = existingTitle
          yield { agentId: 'codex', type: 'session.title.updated', title: existingTitle }
        }
      }

      if (!threadId) {
        throw new AgentExecutionError('protocol_error', 'Codex returned no Thread ID.', false)
      }
      this.preflightPrompt({ ...input, nativeSessionId: threadId })
      if (input.promptEnvelope.skillInvocation) {
        const selected = input.promptEnvelope.skillInvocation.bindings.filter(
          (entry) => entry.agentId === 'codex',
        )
        const current = await this.discoverSkills(input.cwd, signal)
        if (selected.some((entry) => !current.some((candidate) => candidate.id === entry.id)))
          throw new AgentExecutionError(
            'protocol_error',
            'The native Skill catalog changed before this task was sent.',
            false,
          )
      }
      const turnResponse = await connection.request(
        'turn/start',
        {
          threadId,
          clientUserMessageId: input.runId,
          input: [
            ...(workflow || input.readCollaborationSourcePart
              ? [
                  {
                    type: 'text',
                    text: workflow
                      ? collaborationInstructions(
                          workflow,
                          input.promptEnvelope.collaborationAuthorization,
                        )
                      : frozenSourceInstructions,
                  },
                ]
              : []),
            ...codexPromptInput(input.promptEnvelope),
          ],
          ...(workflow ? phasePolicy : {}),
          ...(envelopeMode
            ? {
                outputSchema: collaborationOutputSchema(
                  workflow!,
                  input.promptEnvelope.collaborationAuthorization,
                ),
              }
            : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        },
        {
          timeoutMs: CODEX_TURN_ACCEPT_TIMEOUT_MS,
          signal,
          onDispatch: () => {
            delivery.phase = 'possibly_delivered'
            input.recordDispatch?.('possibly_sent', threadId, nativeConnection.executorId)
          },
        },
      )
      const turnRpcError = Reflect.get(turnResponse, 'error')
      if (turnRpcError) {
        delivery.phase = 'before_dispatch'
        background.rootNotStarted = true
        input.recordDispatch?.('rejected', threadId, connection.executorId)
        throw classifyAgentError(new Error(JSON.stringify(turnRpcError)))
      }
      const turnResult = Reflect.get(turnResponse, 'result')
      const turn =
        turnResult && typeof turnResult === 'object' ? Reflect.get(turnResult, 'turn') : null
      const resolvedTurnId = turn && typeof turn === 'object' ? Reflect.get(turn, 'id') : undefined
      if (typeof resolvedTurnId !== 'string') {
        throw new AgentExecutionError('protocol_error', 'Codex returned no Turn ID.', false)
      }
      if (turnId && turnId !== resolvedTurnId)
        throw new AgentExecutionError(
          'protocol_error',
          'Codex acknowledged a different Turn from its native permission request.',
          false,
        )
      turnId = resolvedTurnId
      background.primaryTurnId = turnId
      delivery.phase = 'accepted'
      input.recordDispatch?.('accepted', threadId, connection.executorId)
      input.recordNativeEvidence?.({
        kind: 'running',
        source: 'live_runtime',
        identity: this.runIdentity(input, threadId, turnId),
      })
      yield { agentId: 'codex', type: 'turn.started', turnId }

      while (delivery.phase !== 'terminal') {
        // The Adapter consumes only provider notifications; RPC responses are routed independently.
        // oxlint-disable-next-line no-await-in-loop
        const message = await connection.nextNotification(undefined, signal)
        const method = Reflect.get(message, 'method')
        const params = Reflect.get(message, 'params')
        if (typeof method !== 'string' || !params || typeof params !== 'object') continue
        if (handleOwnedNativeEvent(message)) continue
        // The cached connection can still deliver notifications from an earlier Turn.
        // Filter before progress accounting or stream coalescing; the ACK owns identity.
        const notificationThreadId = Reflect.get(params, 'threadId')
        if (typeof notificationThreadId === 'string' && notificationThreadId !== threadId) {
          const requestId = Reflect.get(message, 'id')
          if (typeof requestId === 'string' || typeof requestId === 'number')
            // oxlint-disable-next-line no-await-in-loop -- Explicitly reject an unowned native request.
            await connection.respondError(requestId, 'This native thread is not owned by the Run.')
          continue
        }
        const notificationTurn = Reflect.get(params, 'turn')
        const notificationTurnId =
          Reflect.get(params, 'turnId') ??
          (notificationTurn && typeof notificationTurn === 'object'
            ? Reflect.get(notificationTurn, 'id')
            : undefined)
        if (
          method === 'error' &&
          (notificationThreadId !== threadId || notificationTurnId !== turnId)
        ) {
          foreignErrorNotifications = Math.min(
            Number.MAX_SAFE_INTEGER,
            foreignErrorNotifications + 1,
          )
          if (foreignErrorNotifications === 1)
            recordDiagnostic({
              operation: 'native_check',
              phase: 'dropped',
              level: 'warn',
              scope: 'run',
              agentId: 'codex',
              sessionId: input.sessionId,
              runId: input.runId,
              runtimeBoundary: 'native_notification',
              count: foreignErrorNotifications,
            })
          continue
        }
        if (
          (method.startsWith('item/') || method === 'turn/completed') &&
          notificationTurnId !== turnId
        )
          continue
        if (typeof notificationTurnId === 'string' && notificationTurnId !== turnId) continue
        if (method === 'thread/name/updated') {
          const eventThreadId = Reflect.get(params, 'threadId')
          const rawTitle = Reflect.get(params, 'threadName')
          const title = CodexAgentAdapter.cleanTitle(rawTitle)
          if (eventThreadId === threadId && typeof rawTitle === 'string' && rawTitle.trim())
            input.observeNativeTitle?.(threadId, title)
          if (eventThreadId === threadId && title && title !== lastSuggestedTitle) {
            lastSuggestedTitle = title
            yield { agentId: 'codex', type: 'session.title.updated', title }
          }
        } else if (method === 'model/rerouted') {
          const eventThreadId = Reflect.get(params, 'threadId')
          const eventTurnId = Reflect.get(params, 'turnId')
          const toModel = Reflect.get(params, 'toModel')
          if (
            acceptsCodexReroute(threadId, turnId, eventThreadId, eventTurnId) &&
            typeof toModel === 'string' &&
            toModel
          ) {
            const current = this.loadedThreadConfigurations.get(eventThreadId)
            const configuration = {
              model: toModel,
              effort: input.effort ?? current?.effort ?? null,
            }
            this.rememberThread(eventThreadId, configuration)
            yield* resolvedModelEvent(configuration)
          }
        } else if (method === 'item/started') {
          const item = Reflect.get(params, 'item')
          if (!turnId || !item || typeof item !== 'object') continue
          const itemId = Reflect.get(item, 'id')
          cacheApprovalItem(approvalItems, item, threadId, turnId)
          if (Reflect.get(item, 'type') === 'reasoning' && typeof itemId === 'string') continue
          if (
            CodexAgentAdapter.isPeerTool(item, this.peerServerName) ||
            (Reflect.get(item, 'type') === 'mcpToolCall' &&
              Reflect.get(item, 'server') === this.peerServerName &&
              Reflect.get(item, 'tool') === 'publish_session_title')
          )
            continue
          const activity = CodexAgentAdapter.describeTool(item, input.cwd, false)
          if (activity) {
            yield {
              agentId: 'codex',
              type: 'tool.started',
              turnId,
              toolCallId: activity.toolCallId,
              toolName: activity.toolName,
              title: activity.title,
              ...(activity.detail ? { detail: activity.detail } : {}),
            }
          }
        } else if (method === 'item/reasoning/summaryTextDelta') {
          const delta = Reflect.get(params, 'delta')
          const itemId = Reflect.get(params, 'itemId')
          if (turnId && typeof itemId === 'string' && typeof delta === 'string') {
            const state = reasoningSummaryStates.get(itemId) ?? {
              pendingPrefix: '',
              emitted: false,
            }
            if (!state.emitted && !delta.trim()) {
              state.pendingPrefix += delta
              reasoningSummaryStates.set(itemId, state)
            } else if (!state.emitted) {
              state.emitted = true
              reasoningSummaryStates.set(itemId, state)
              yield {
                agentId: 'codex',
                type: 'reasoning.summary.delta',
                turnId,
                activityId: itemId,
                text: `${state.pendingPrefix}${delta}`,
              }
            } else if (delta) {
              yield {
                agentId: 'codex',
                type: 'reasoning.summary.delta',
                turnId,
                activityId: itemId,
                text: delta,
              }
            }
          }
        } else if (method === 'item/agentMessage/delta') {
          if (envelopeMode) continue
          const delta = Reflect.get(params, 'delta')
          const itemId = Reflect.get(params, 'itemId')
          if (typeof delta === 'string' && typeof itemId === 'string') {
            if (!turnId) continue
            const appended = answer.append(itemId, delta)
            yield {
              agentId: 'codex',
              type: 'text.delta',
              turnId,
              outputId: answer.outputId,
              text: appended,
            }
          }
        } else if (method === 'item/completed') {
          const item = Reflect.get(params, 'item')
          if (!item || typeof item !== 'object' || !turnId) continue
          if (Reflect.get(item, 'type') === 'agentMessage') {
            if (envelopeMode) continue
            const text = Reflect.get(item, 'text')
            const itemId = Reflect.get(item, 'id')
            if (typeof text === 'string' && typeof itemId === 'string') {
              const completed = answer.complete(itemId, text)
              if (completed !== undefined)
                yield {
                  agentId: 'codex',
                  type: 'text.completed',
                  turnId,
                  outputId: answer.outputId,
                  text: completed,
                }
            }
          } else if (Reflect.get(item, 'type') === 'reasoning') {
            const itemId = Reflect.get(item, 'id')
            const text = CodexAgentAdapter.reasoningSummary(item)
            if (typeof itemId === 'string') reasoningSummaryStates.delete(itemId)
            if (typeof itemId === 'string' && text) {
              yield {
                agentId: 'codex',
                type: 'reasoning.summary.completed',
                turnId,
                activityId: itemId,
                text,
              }
            }
          } else if (
            input.promptEnvelope.requestSessionTitle &&
            Reflect.get(item, 'type') === 'mcpToolCall' &&
            Reflect.get(item, 'server') === this.peerServerName &&
            Reflect.get(item, 'tool') === 'publish_session_title'
          ) {
            const result = Reflect.get(item, 'result')
            const structured =
              result && typeof result === 'object'
                ? Reflect.get(result, 'structuredContent')
                : undefined
            const receipt =
              structured && typeof structured === 'object'
                ? Reflect.get(structured, 'pactSessionTitle')
                : undefined
            if (
              notificationThreadId === threadId &&
              Reflect.get(item, 'status') === 'completed' &&
              Reflect.get(item, 'error') === null &&
              receipt &&
              typeof receipt === 'object' &&
              Reflect.get(receipt, 'accepted') === true &&
              Reflect.get(receipt, 'receipt') === this.peerToolServer.capabilityReceipt
            ) {
              const title = this.peerToolServer.acceptSessionTitle(
                Reflect.get(item, 'arguments'),
                peerReceipt,
              )
              if (title)
                yield {
                  agentId: 'codex',
                  type: 'session.title.updated',
                  title,
                  origin: 'turn_result',
                }
            }
          } else if (CodexAgentAdapter.isPeerTool(item, this.peerServerName)) {
            const proposal = CodexAgentAdapter.peerProposal(
              item,
              turnId,
              this.peerToolServer.capabilityReceipt,
              this.peerServerName,
            )
            if (
              proposal &&
              notificationThreadId === threadId &&
              !peerProposalEmitted &&
              this.peerToolServer.acceptCompleted(Reflect.get(item, 'arguments'), peerReceipt)
            ) {
              peerProposalEmitted = true
              yield proposal
            }
          } else {
            if (Reflect.get(item, 'type') === 'fileChange') {
              const evidence = codexFileChanges(item, input.cwd)
              const nativeId = Reflect.get(item, 'id')
              evidence.changes = evidence.changes.map((change, index) => ({
                ...change,
                ...(typeof nativeId === 'string'
                  ? { operationId: `${nativeId}:${index}` }
                  : { unavailableReason: 'The native operation identity was unavailable.' }),
              }))
              // oxlint-disable-next-line no-await-in-loop -- Preserve applied native operation order.
              await recordNativeChanges(input, evidence, background.observation.signal)
            } else if (
              [
                'commandExecution',
                'mcpToolCall',
                'collabAgentToolCall',
                'collabToolCall',
                'dynamicToolCall',
              ].includes(String(Reflect.get(item, 'type'))) &&
              !(
                Reflect.get(item, 'type') === 'mcpToolCall' &&
                Reflect.get(item, 'server') === this.peerServerName &&
                Reflect.get(item, 'tool') === 'read_collaboration_source'
              )
            ) {
              nativeEffectsUncertain(
                input,
                'Native shell, MCP or child-Agent effects are not fully represented by file operation results.',
              )
            }
            const activity = CodexAgentAdapter.describeTool(item, input.cwd, true)
            if (activity) {
              yield {
                agentId: 'codex',
                type: 'tool.completed',
                turnId,
                toolCallId: activity.toolCallId,
                toolName: activity.toolName,
                title: activity.title,
                ...(activity.detail ? { detail: activity.detail } : {}),
                outcome: CodexAgentAdapter.toolFailed(item) ? 'failed' : 'completed',
              }
            }
          }
        } else if (method === 'turn/completed') {
          const completedTurn = Reflect.get(params, 'turn')
          if (!completedTurn || typeof completedTurn !== 'object') continue
          const status = Reflect.get(completedTurn, 'status')
          if (!turnId) continue
          if (!['completed', 'failed', 'interrupted'].includes(String(status))) continue
          delivery.phase = 'terminal'
          if (projectionFailure) throw projectionFailure
          if (status === 'failed') {
            const error = Reflect.get(completedTurn, 'error')
            throw classifyAgentError(new Error(JSON.stringify(error ?? 'Codex Run failed.')))
          }
          const finalText = envelopeMode ? answer.text : answer.finalize()
          if (finalText !== undefined)
            yield {
              agentId: 'codex',
              type: 'text.completed',
              turnId,
              outputId: answer.outputId,
              text: finalText,
            }
          if (envelopeMode && workflow && status === 'completed')
            yield collaborationResultEvent(
              finalCarrier,
              workflow,
              turnId,
              input.answerFormat,
              input.promptEnvelope.collaborationAuthorization,
            )
          yield {
            agentId: 'codex',
            type: 'turn.completed',
            turnId,
            outcome: status === 'interrupted' ? 'interrupted' : 'completed',
          }
        } else if (method === 'error') {
          const nativeError = Reflect.get(params, 'error'),
            willRetry = Reflect.get(params, 'willRetry')
          const rawMessage =
            nativeError && typeof nativeError === 'object'
              ? Reflect.get(nativeError, 'message')
              : undefined
          if (typeof willRetry !== 'boolean' || typeof rawMessage !== 'string')
            throw new AgentExecutionError(
              'protocol_error',
              'Invalid owned native error notification.',
              false,
            )
          const failure = classifyAgentError(new Error(safeNativePermissionText(rawMessage, 1024)))
          if (willRetry) {
            retryNotifications = Math.min(Number.MAX_SAFE_INTEGER, retryNotifications + 1)
            if (retryNotifications === 1)
              recordDiagnostic({
                operation: 'native_check',
                phase: 'dispatched',
                level: 'warn',
                scope: 'run',
                agentId: 'codex',
                sessionId: input.sessionId,
                runId: input.runId,
                runtimeBoundary: 'native_notification',
                nativeWillRetry: true,
                code: failure.kind,
                count: retryNotifications,
              })
            // Native retries the same owned Turn. Keep observing; Pact never starts another.
            continue
          }
          recordDiagnostic({
            operation: 'native_check',
            phase: 'failed',
            level: 'warn',
            scope: 'run',
            agentId: 'codex',
            sessionId: input.sessionId,
            runId: input.runId,
            runtimeBoundary: 'native_notification',
            nativeWillRetry: false,
            code: failure.kind,
          })
          throw failure
        } else if (Object.hasOwn(message, 'id')) {
          input.recordNativeEvidence?.({
            kind: 'waiting_user',
            source: 'live_runtime',
            identity: this.runIdentity(input, threadId, turnId),
          })
          // oxlint-disable-next-line no-await-in-loop -- A native approval is one ordered request/reply exchange.
          await this.relayPermission(
            connection,
            message,
            method,
            params,
            input,
            threadId,
            turnId,
            signal,
            handledRequests,
            approvalItems,
          )
          if (!background.rootTerminal)
            input.recordNativeEvidence?.({
              kind: 'running',
              source: 'live_runtime',
              identity: this.runIdentity(input, threadId, turnId),
            })
        } else if (
          method === 'mcpServer/elicitation/complete' ||
          method === 'mcpServer/elicitation/completed'
        ) {
          // This is native progress, not a Pact assertion that OAuth succeeded.
        }
      }
    } catch (error) {
      const failure = classifyAgentError(error)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'run',
        agentId: 'codex',
        sessionId: input.sessionId,
        runId: input.runId,
        runtimeBoundary: 'foreground',
        code: failure.kind,
        runtimeErrorType:
          diagnosticEventSchema.shape.runtimeErrorType.safeParse(
            error instanceof Error ? error.name : 'other',
          ).data ?? 'other',
      })
      if (!nativeStartupDispatched) {
        background.rootNotStarted = true
        input.recordDispatch?.('rejected', input.nativeSessionId, connection?.executorId)
      }
      if (!background.rootTerminal && !background.rootNotStarted && threadId)
        input.recordNativeEvidence?.({
          kind: 'no_evidence',
          identity: this.runIdentity(input, threadId, turnId),
          reason: 'The native stream ended without a matching terminal receipt.',
        })
      // A foreground deadline/error does not prove native commands or descendants stopped.
      // Actual connection loss is retired by detachConnection, not by killing a healthy server.
      if (
        delivery.phase === 'possibly_delivered' ||
        (delivery.phase === 'accepted' &&
          [
            'transient_transport',
            'agent_process_crash',
            'protocol_error',
            'response_too_large',
          ].includes(failure.kind))
      ) {
        throw new AgentExecutionError(
          'unknown_delivery',
          'Codex may have received the Turn, but Pact could not confirm its final state.',
          false,
          failure.kind === 'response_too_large' ? 'response_too_large' : undefined,
        )
      }
      throw failure
    } finally {
      signal.removeEventListener('abort', freezeForegroundCommands)
      background.foregroundReleased = true
      if (background.closed) answer.dispose()
      if (peerReceipt) this.peerToolServer.endTurn(peerReceipt)
      if (
        sourceGrant &&
        (background.rootTerminal ||
          background.rootNotStarted ||
          signal.aborted ||
          !connection?.isOpen)
      )
        this.peerToolServer.retireSourceReader(sourceGrant)
      if (retryNotifications || foreignErrorNotifications)
        recordDiagnostic({
          operation: 'native_check',
          phase: background.rootTerminal ? 'completed' : 'interrupted',
          scope: 'run',
          agentId: 'codex',
          sessionId: input.sessionId,
          runId: input.runId,
          runtimeBoundary: 'native_notification',
          nativeWillRetry: retryNotifications > 0,
          count: retryNotifications + foreignErrorNotifications,
        })
      if (signal.aborted && connection && threadId && turnId && connection.isOpen) {
        try {
          await this.interruptForegroundCommands(
            background,
            connection,
            threadId,
            turnId,
            stoppedCommands ?? new Map(),
          )
        } catch {
          reportUnknown(
            'Codex interruption could not be confirmed. Native observation remains active.',
          )
        }
      }
      stoppedCommands?.clear()
      background.cancellationPending = false
      this.running = false
      if (!nativeStartupDispatched) background.rootNotStarted = true
      if (!connection?.isOpen) {
        if (!background.rootNotStarted) background.unknown = true
        await Promise.allSettled(background.recordings)
        this.settleNativeBackground(background)
      } else {
        if (!background.rootTerminal && !background.rootNotStarted)
          // The background observer still receives every frame on this live connection.
          // Its later exact terminal and fully drained work can settle this temporary state.
          reportUnknown(
            'The foreground ended without proof that native work finished.',
            'unlisted',
            'awaiting_terminal',
          )
        maybeSettle()
      }
      this.scheduleIdleDisconnect()
    }
  }

  async enrichTitle(
    input: AgentTitleEnrichmentInput,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    if (this.disposed || signal.aborted) return undefined
    try {
      const connection = this.connection
      if (!connection?.isOpen || this.processCwd !== input.cwd) return undefined
      const response = await connection.request(
        'thread/read',
        { threadId: input.nativeSessionId, includeTurns: false },
        { timeoutMs: CODEX_TITLE_TIMEOUT_MS, signal },
      )
      const result = Reflect.get(response, 'result')
      const thread = result && typeof result === 'object' ? Reflect.get(result, 'thread') : null
      if (
        Reflect.get(response, 'error') ||
        !thread ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        this.connection !== connection ||
        signal.aborted
      )
        return undefined
      CodexAgentAdapter.observeThreadTitle(thread, input.observeNativeTitle)
      return CodexAgentAdapter.threadTitle(thread)
    } catch {
      return undefined
    }
  }

  async setNativeTitle(
    input: import('@pact/agent-runtime').AgentNativeTitleInput,
    signal: AbortSignal,
  ): Promise<'synchronized' | 'unavailable' | 'unknown_delivery'> {
    const connection = this.connection
    if (
      this.disposed ||
      signal.aborted ||
      !this.initialized ||
      !connection?.isOpen ||
      this.processCwd !== input.cwd ||
      !input.isCurrent() ||
      Buffer.byteLength(JSON.stringify({ threadId: input.nativeSessionId, name: input.title })) >
        8192
    )
      return 'unavailable'
    // A lost metadata ACK may still finish in this executor. Do not race it with
    // another write; the next normal connection reconciles the latest Pact value.
    if (this.uncertainTitleExecutor === connection.executorId) return 'unknown_delivery'
    let dispatched = false
    const request = async (method: string, params: object, write = false): Promise<object> => {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), CODEX_TITLE_TIMEOUT_MS)
      try {
        return await connection.request(method, params, {
          timeoutMs: CODEX_TITLE_TIMEOUT_MS,
          signal: AbortSignal.any([signal, deadline.signal]),
          ...(write
            ? {
                canDispatch: () =>
                  this.connection === connection &&
                  connection.isOpen &&
                  !signal.aborted &&
                  input.isCurrent(),
                onDispatch: () => {
                  dispatched = true
                },
              }
            : {}),
        })
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      const read = await request('thread/read', {
        threadId: input.nativeSessionId,
        includeTurns: false,
      })
      const thread = Reflect.get(Reflect.get(read, 'result') ?? {}, 'thread')
      if (
        Reflect.get(read, 'error') ||
        !thread ||
        Reflect.get(thread, 'id') !== input.nativeSessionId ||
        this.connection !== connection ||
        !connection.isOpen ||
        signal.aborted ||
        !input.isCurrent()
      )
        return 'unavailable'
      if (Reflect.get(thread, 'name') === input.title) return 'synchronized'
      const response = await request(
        'thread/name/set',
        { threadId: input.nativeSessionId, name: input.title },
        true,
      )
      if (Reflect.get(response, 'error')) return 'unavailable'
      if (!Reflect.has(response, 'result')) {
        this.uncertainTitleExecutor = connection.executorId
        return 'unknown_delivery'
      }
      return 'synchronized'
    } catch {
      if (dispatched) {
        this.uncertainTitleExecutor = connection.executorId
        return 'unknown_delivery'
      }
      return 'unavailable'
    }
  }

  private rememberThread(threadId: string, configuration?: CodexRunConfiguration): void {
    const value = configuration ?? this.loadedThreadConfigurations.get(threadId)
    this.loadedThreadIds.delete(threadId)
    this.loadedThreadConfigurations.delete(threadId)
    if (
      Buffer.byteLength(JSON.stringify({ threadId, configuration: value }), 'utf8') >
      MAX_LOADED_THREAD_BYTES
    )
      return
    this.loadedThreadIds.add(threadId)
    if (value) this.loadedThreadConfigurations.set(threadId, value)
    while (this.loadedThreadIds.size > MAX_LOADED_THREADS) {
      const oldest = this.loadedThreadIds.values().next().value
      if (!oldest) break
      this.loadedThreadIds.delete(oldest)
      this.loadedThreadConfigurations.delete(oldest)
    }
  }

  diagnostics(): CodexConnectionDiagnostics {
    return (
      this.connection?.diagnostics() ?? {
        pendingRequests: 0,
        queuedMessages: 0,
        queuedInboundBytes: 0,
        queuedOutboundFrames: 0,
        queuedOutboundBytes: 0,
        waitingForNotification: false,
        stdoutPaused: false,
        open: false,
      }
    )
  }

  async dispose(): Promise<void> {
    this.skillCatalogChanged = undefined
    this.disposed = true
    const probe = this.featureProbe
    probe?.stop()
    await probe?.task.catch(() => undefined)
    await this.connectionStarting?.task.catch(() => undefined)
    if (this.nativeInspection) {
      const reader = this.nativeInspection
      reader.controller.abort()
      await reader.task.catch(() => undefined)
      await reader.connection.close(new Error('Native history reader is shutting down.'))
    }
    this.terminalEvidence.clear()
    this.evidenceCacheWork.release()
    for (const receipt of this.nativeRebuildReceipts.values()) {
      receipt.release?.()
      receipt.observation?.abort()
    }
    this.nativeRebuildReceipts.clear()
    await this.nativeForkFiles.dispose()
    for (const owner of this.nativeForkOwners.values()) owner.release()
    this.nativeForkOwners.clear()
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    const connection = this.connection
    if (connection) this.detachConnection(connection)
    const closing = connection
      ? this.closeConnection(connection, new Error('Codex connection closed.'))
      : this.closingConnection
    if (closing) await closing
    for (const background of this.nativeBackground) {
      background.unknown = true
      this.settleNativeBackground(background)
    }
    await this.peerToolServer.dispose()
    if (probe && this.featureProbe === probe)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The Codex capability probe did not confirm process exit.',
        false,
      )
  }

  hasActiveBackgroundWork(runId?: string): boolean {
    return (
      [...this.nativeForkOwners].some(([id]) => !runId || id === runId) ||
      [...this.nativeBackground].some((background) => !runId || background.input.runId === runId) ||
      [...this.nativeRebuildReceipts].some(
        ([id, receipt]) => receipt.pending && (!runId || runId === id),
      )
    )
  }

  private rememberNativeRebuild(id: string, value: NativeRebuildReceipt): void {
    const previous = this.nativeRebuildReceipts.get(id)
    this.nativeRebuildReceipts.delete(id)
    this.nativeRebuildReceipts.set(id, { ...previous, ...value })
    while (
      this.nativeRebuildReceipts.size > 8 ||
      Buffer.byteLength(JSON.stringify([...this.nativeRebuildReceipts]), 'utf8') > 64 * 1024
    ) {
      const oldest = [...this.nativeRebuildReceipts].find(([, receipt]) => !receipt.pending)?.[0]
      if (!oldest)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native bootstrap metadata exceeded its bounded owner; live work was not terminated.',
          false,
        )
      this.nativeRebuildReceipts.delete(oldest)
    }
  }

  private settleNativeRebuild(id: string): void {
    const receipt = this.nativeRebuildReceipts.get(id)
    if (!receipt) return
    receipt.pending = false
    receipt.release?.()
    receipt.observation?.abort()
    delete receipt.release
    delete receipt.observation
    delete receipt.interactions
    delete receipt.startupHooks
  }

  private trackNativeBackground(
    background: NativeBackground,
    item: object,
    ownerThreadId?: string,
    ownerTurnId?: string,
  ): void {
    const type = Reflect.get(item, 'type')
    if (
      ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(String(type))
    ) {
      const id = Reflect.get(item, 'id')
      if (typeof id !== 'string' || !ownerThreadId || !ownerTurnId) {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      background.operations.delete(JSON.stringify([ownerThreadId, ownerTurnId, id]))
      if (
        ownerThreadId === background.primaryThreadId &&
        ownerTurnId === background.primaryTurnId &&
        background.foregroundCommands.has(id)
      ) {
        const handle = background.foregroundCommands.get(id)
        background.foregroundCommands.delete(id)
        background.foregroundCommandBytes -= Buffer.byteLength(JSON.stringify([id, handle ?? null]))
      }
    } else if (type === 'collabAgentToolCall' || type === 'collabToolCall') {
      const itemId = Reflect.get(item, 'id')
      if (typeof itemId === 'string' && ownerThreadId && ownerTurnId)
        background.spawns.delete(JSON.stringify([ownerThreadId, ownerTurnId, itemId]))
      const sender = Reflect.get(item, 'senderThreadId')
      if (sender !== ownerThreadId || typeof ownerThreadId !== 'string') {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      const receivers = Reflect.get(item, 'receiverThreadIds')
      const states = Reflect.get(item, 'agentsStates')
      if (!Array.isArray(receivers) || receivers.length > 64) {
        background.unknown = true
        background.untrackedWork = true
        return
      }
      for (const id of receivers) {
        if (typeof id !== 'string' || id.length > 1024) {
          background.unknown = true
          background.untrackedWork = true
          continue
        }
        const state = states && typeof states === 'object' ? Reflect.get(states, id) : undefined
        const status = state && typeof state === 'object' ? Reflect.get(state, 'status') : undefined
        if (!background.parents.has(id)) {
          if (Reflect.get(item, 'tool') !== 'spawnAgent' || background.parents.size >= 64) {
            background.unknown = true
            background.untrackedWork = true
            continue
          }
          background.parents.set(id, ownerThreadId)
        }
        if (['completed', 'errored', 'shutdown', 'notFound'].includes(String(status)))
          background.threads.delete(id)
        else background.threads.add(id)
      }
    }
  }

  private settleNativeBackground(background: NativeBackground): void {
    if (background.closed) return
    background.closed = true
    if (background.sourceGrant) this.peerToolServer.retireSourceReader(background.sourceGrant)
    background.foregroundCommands.clear()
    background.foregroundCommandBytes = 0
    background.release?.()
    clearTimeout(background.earlyTimer)
    for (const entry of background.early) entry.reservation.release()
    background.early = []
    background.earlyBytes = 0
    background.observation.abort()
    for (const [thread, turn] of background.turns)
      this.retiredNativeTurns.add(JSON.stringify([thread, turn]))
    if (background.primaryThreadId && background.primaryTurnId)
      this.retiredNativeTurns.add(
        JSON.stringify([background.primaryThreadId, background.primaryTurnId]),
      )
    for (const child of background.parents.keys()) this.retiredNativeChildren.add(child)
    for (const retired of [this.retiredNativeTurns, this.retiredNativeChildren]) {
      let bytes = [...retired].reduce((sum, identity) => sum + Buffer.byteLength(identity), 0)
      while (retired.size > 256 || bytes > 512 * 1024) {
        const oldest = retired.values().next().value
        if (!oldest) break
        retired.delete(oldest)
        bytes -= Buffer.byteLength(oldest)
      }
    }
    this.nativeBackground.delete(background)
    // Uncertainty and resource release are different facts. The early unknown
    // report cannot substitute for this final notification after ownership ends.
    nativeFileChangesSettled(
      background.input,
      background.unknown ? 'unknown' : 'settled',
      background.rootNotStarted
        ? 'native_turn_not_started'
        : background.unknown
          ? 'native_observation_released'
          : 'native_work_drained',
    )
    this.scheduleIdleDisconnect()
  }

  private async relayPermission(
    connection: CodexAppServerConnection,
    request: object,
    method: string,
    params: object,
    input: Pick<AgentRunInput, 'requestPermission' | 'requestUserInput'> &
      Partial<Pick<AgentRunInput, 'promptEnvelope'>>,
    threadId: string | undefined,
    turnId: string | undefined,
    signal: AbortSignal,
    handled: Set<string>,
    items: Map<string, ApprovalItem>,
  ): Promise<void> {
    const id = Reflect.get(request, 'id')
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      String(id).length > 1024 ||
      method.length > 256
    )
      return
    const nativeThread = Reflect.get(params, 'threadId') ?? Reflect.get(params, 'conversationId')
    const nativeTurn = Reflect.get(params, 'turnId')
    if (nativeThread !== threadId || (nativeTurn != null && nativeTurn !== turnId)) {
      await connection.respondError(id, 'This native request does not belong to the bound Turn.')
      return
    }
    const key = `${method}:${id}`
    if (handled.has(key)) return
    if (handled.size >= 1024) {
      await connection.respondError(id, 'The native request identity budget was exceeded.')
      return
    }
    handled.add(key)
    if (method === 'item/tool/requestUserInput' && input.promptEnvelope?.collaboration) {
      await connection.respondError(
        id,
        'Return material questions as versioned Todo definitions in this duty’s final structured result.',
      )
      return
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      const endWait = connection.beginPermissionWait()
      try {
        const question =
          method === 'item/tool/requestUserInput' ? codexQuestions({ ...params }) : undefined
        const userRequest = question?.request ?? nativeElicitation({ ...params }, 'Codex')
        const result = input.requestUserInput
          ? await NativePermissionWait.decision(
              input.requestUserInput(
                { ...userRequest, ...(threadId ? { nativeSessionId: threadId } : {}) },
                signal,
              ),
              signal,
            )
          : await Promise.reject(
              new Error('The native input request has no current user response handler.'),
            )
        if (signal.aborted) return
        if (question) {
          await connection.respond(id, {
            answers:
              result.action === 'accept' && result.values ? question.answers(result.values) : {},
          })
        } else {
          if (result.action === 'accept' && userRequest.kind === 'form' && !result.values)
            throw new Error('No submitted native form values were supplied.')
          await connection.respond(id, {
            action: result.action,
            ...(result.action === 'accept' && userRequest.kind === 'form'
              ? { content: result.values ?? {} }
              : {}),
          })
        }
      } catch (error) {
        await connection.respondError(
          id,
          error instanceof Error
            ? error.message
            : 'This native input request could not be displayed safely.',
        )
      } finally {
        endWait()
      }
      return
    }
    const modern = [
      'item/commandExecution/requestApproval',
      'item/fileChange/requestApproval',
    ].includes(method)
    const legacy = ['execCommandApproval', 'applyPatchApproval'].includes(method)
    const permissions = method === 'item/permissions/requestApproval'
    if (!modern && !legacy && !permissions) {
      await connection.respondError(
        id,
        'Pact does not yet have the native interaction UI required for this request. Native configuration was not changed.',
      )
      return
    }
    const fileApproval = method.includes('fileChange') || method === 'applyPatchApproval'
    const network = Reflect.get(params, 'networkApprovalContext')
    const stdin = Reflect.get(params, 'kind') === 'writeStdin'
    const title = fileApproval
      ? 'Codex wants to apply file changes'
      : permissions
        ? 'Codex requests additional native permissions'
        : network
          ? 'Codex requests network access'
          : stdin
            ? 'Codex wants to send terminal input'
            : 'Codex wants to run a command'
    const reason = Reflect.get(params, 'reason')
    const command = Reflect.get(params, 'command')
    const itemId = Reflect.get(params, 'itemId') ?? Reflect.get(params, 'callId')
    if (typeof itemId !== 'string' || !itemId || itemId.length > 1024) {
      await connection.respondError(id, 'The native request did not provide its tool identity.')
      return
    }
    const item = items.get(JSON.stringify([threadId, turnId, itemId]))
    const nativeCommand =
      typeof command === 'string'
        ? command
        : Array.isArray(command) && command.every((part) => typeof part === 'string')
          ? command.map((part) => JSON.stringify(part)).join(' ')
          : stdin
            ? undefined
            : item?.command
    const cwd = Reflect.get(params, 'cwd')
    const legacyFiles = Reflect.get(params, 'fileChanges')
    let paths = item?.paths ?? []
    let targetsComplete = item?.complete === true
    if (legacyFiles && typeof legacyFiles === 'object') {
      const entries = Object.entries(legacyFiles)
      targetsComplete = entries.length > 0 && entries.length <= 256
      paths = []
      if (targetsComplete)
        for (const [path, value] of entries) {
          if (
            !value ||
            typeof value !== 'object' ||
            !['add', 'delete', 'update'].includes(String(Reflect.get(value, 'type')))
          ) {
            targetsComplete = false
            break
          }
          const destination =
            value && typeof value === 'object' ? Reflect.get(value, 'move_path') : undefined
          if (
            !path ||
            path.length > 4096 ||
            (destination != null &&
              (typeof destination !== 'string' || !destination || destination.length > 4096))
          ) {
            targetsComplete = false
            break
          }
          paths.push(path)
          if (typeof destination === 'string') paths.push(destination)
        }
      paths = targetsComplete ? [...new Set(paths)] : []
    }
    const profile = Reflect.get(params, permissions ? 'permissions' : 'additionalPermissions')
    const profileLines = profile != null ? nativeProfileLines(profile) : []
    if (!profileLines) {
      await connection.respondError(
        id,
        'The native permission profile could not be displayed completely. It was not approved.',
      )
      return
    }
    if (
      network != null &&
      (typeof network !== 'object' ||
        typeof Reflect.get(network, 'host') !== 'string' ||
        !['http', 'https', 'socks5Tcp', 'socks5Udp'].includes(
          String(Reflect.get(network, 'protocol')),
        ) ||
        Object.keys(network).some((field) => !['host', 'protocol'].includes(field)))
    ) {
      await connection.respondError(
        id,
        'The native network target or protocol cannot be displayed completely. No approval response was sent.',
      )
      return
    }
    const scope = permissions
      ? profileLines && exactNativeSessionScope(profileLines)
      : fileApproval && targetsComplete
        ? exactNativeSessionScope(paths.map((path) => `File changes: ${path}`))
        : network && typeof network === 'object'
          ? exactNativeSessionScope([
              `Host: ${Reflect.get(network, 'host')}`,
              `Protocol: ${Reflect.get(network, 'protocol')}`,
            ])
          : nativeCommand
            ? exactNativeSessionScope([
                `${stdin ? 'Terminal input' : 'Command'}: ${nativeCommand}`,
                ...(profileLines ?? []),
              ])
            : undefined
    const grantRoot = Reflect.get(params, 'grantRoot')
    let detailSource = [
      nativeCommand
        ? `${stdin ? 'Terminal input (native preview)' : 'Command'}: ${nativeCommand}`
        : undefined,
      network && typeof network === 'object'
        ? `Network host: ${Reflect.get(network, 'host')}\nProtocol: ${Reflect.get(network, 'protocol')}`
        : undefined,
      typeof cwd === 'string'
        ? `Working directory: ${cwd}`
        : item?.cwd
          ? `Working directory: ${item.cwd}`
          : undefined,
      ...paths.map((path) => `File: ${path}`),
      ...(profileLines ?? ['Native permission profile could not be displayed completely.']),
      typeof reason === 'string' ? `Reason: ${reason}` : undefined,
      typeof grantRoot === 'string'
        ? `Requested write root: ${grantRoot}\nThis native root grant has unconfirmed scope semantics. Pact cannot safely offer an approval for it.`
        : undefined,
      fileApproval && !paths.length
        ? 'The complete native file target list is unavailable. Approval is disabled.'
        : undefined,
      stdin && !nativeCommand
        ? 'The native request did not provide the terminal input to approve.'
        : undefined,
    ]
      .filter(Boolean)
      .join('\n')
    const displayComplete = nativeApprovalDisplayFits(detailSource)
    if (!displayComplete)
      detailSource =
        'The complete native approval targets exceed the display budget. Approval is disabled; you may decline or cancel this native request.'
    const detail = safeNativePermissionText(detailSource)
    let offered: ReturnType<typeof codexApprovalActions>
    try {
      offered = codexApprovalActions(
        params,
        permissions ? 'permissions' : fileApproval ? 'file' : 'command',
        legacy,
        scope,
        displayComplete &&
          (fileApproval
            ? targetsComplete
            : permissions ||
              Boolean(network) ||
              (nativeCommand != null && (typeof cwd === 'string' || item?.cwd != null))),
      )
      nativePermissionRequestSchema.parse({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        title,
        detail,
        actions: offered.actions,
      })
    } catch {
      await connection.respondError(
        id,
        'This native approval action or its complete scope cannot be displayed safely. No approval response was sent.',
      )
      return
    }
    const endWait = connection.beginPermissionWait()
    let decision: string
    try {
      decision = input.requestPermission
        ? await NativePermissionWait.decision(
            input.requestPermission({ title, detail, actions: offered.actions }, signal),
            signal,
          )
        : await Promise.reject(
            new Error('The native permission request has no current user response handler.'),
          )
    } catch {
      await connection.respondError(
        id,
        'The native permission request did not receive a current user decision.',
      )
      return
    } finally {
      endWait()
    }
    if (signal.aborted) return
    const response = offered.responses.get(decision)
    if (!response) {
      await connection.respondError(id, 'No current native approval action was selected.')
      return
    }
    await connection.respond(id, response)
  }

  private async ensureConnection(cwd: string): Promise<CodexAppServerConnection> {
    const storageRoot = resolvePath(
      cwd,
      this.nativeReadOptions.storageRoot ??
        process.env['CODEX_HOME'] ??
        resolvePath(homedir(), '.codex'),
    )
    const env = codexProcessEnvironment(storageRoot)
    // A bounded digest is retained, never the environment or its credential values.
    const key = createHash('sha256')
      .update(JSON.stringify({ executable: this.executablePath, cwd, env }))
      .digest('hex')
    if (this.connection?.isOpen && this.processCwd === cwd && this.processEnvironmentKey === key)
      return this.connection
    if (this.connectionStarting) {
      if (this.connectionStarting.key === key) return this.connectionStarting.task
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex is already starting with another native configuration. No new process was started.',
        false,
      )
    }
    const task = this.openConnection(cwd, storageRoot, env, key).finally(() => {
      if (this.connectionStarting?.task === task) this.connectionStarting = undefined
    })
    this.connectionStarting = { key, task }
    return task
  }

  private async openConnection(
    cwd: string,
    storageRoot: string,
    env: NodeJS.ProcessEnv,
    environmentKey: string,
  ): Promise<CodexAppServerConnection> {
    if (this.connection?.isOpen && this.hasActiveBackgroundWork())
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The native Codex connection still owns background work in its current directory.',
        false,
      )
    const previous = this.connection
    if (previous) this.detachConnection(previous)
    if (previous) await this.closeConnection(previous, new Error('Codex connection replaced.'))
    await this.closingConnection
    if (this.disposed)
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    this.processStorageRoot = storageRoot
    const owned = this.processFactory
      ? { child: this.processFactory(cwd), close: undefined }
      : await this.startProcess(cwd, this.processStorageRoot, env)
    const child = owned.child
    this.connectionProcess = child
    const connection = new CodexAppServerConnection(
      child,
      () => {
        this.detachConnection(connection)
        void this.closeConnection(connection, new Error('Codex connection closed.'))
      },
      owned.close,
      this.ipcTraffic,
    )
    connection.setSkillChangeListener(() => this.skillCatalogChanged?.())
    this.connection = connection
    this.latestExecutorId = connection.executorId
    this.processCwd = cwd
    this.processEnvironmentKey = environmentKey
    this.initialized = false
    this.retiredNativeTurns.clear()
    this.retiredNativeChildren.clear()
    this.loadedThreadIds.clear()
    this.loadedThreadConfigurations.clear()
    return connection
  }

  private async initializeConnection(
    connection: CodexAppServerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.initialized) return
    const response = await connection.request(
      'initialize',
      {
        clientInfo: { name: 'pact', title: 'Pact', version: '0.0.0' },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: CODEX_INITIALIZATION_TIMEOUT_MS, signal },
    )
    if (!Reflect.has(response, 'result')) {
      throw new AgentExecutionError('runtime_incompatible', 'Codex initialization failed.', false)
    }
    this.initialized = true
    await connection.notify('initialized', {})
  }

  private detachConnection(connection: CodexAppServerConnection): void {
    if (this.connection !== connection) return
    this.connection = undefined
    this.connectionProcess = undefined
    this.processStorageRoot = undefined
    this.processCwd = undefined
    this.processEnvironmentKey = undefined
    this.initialized = false
    this.loadedThreadIds.clear()
    this.loadedThreadConfigurations.clear()
    for (const receipt of this.nativeRebuildReceipts.values()) {
      if (receipt.executorId !== connection.executorId) continue
      // Actual transport release is not initialization completion evidence.
      receipt.pending = false
      receipt.release?.()
      receipt.observation?.abort()
      delete receipt.release
      delete receipt.observation
      delete receipt.interactions
    }
    for (const background of this.nativeBackground) {
      if (background.connection !== connection) continue
      background.unknown = true
      if (!background.rootTerminal && !background.rootNotStarted && background.primaryThreadId)
        background.input.recordNativeEvidence?.({
          kind: 'no_evidence',
          identity: this.runIdentity(
            background.input,
            background.primaryThreadId,
            background.primaryTurnId,
          ),
          reason: 'The native executor connection closed without a matching terminal receipt.',
        })
      background.release?.()
      void Promise.allSettled(background.recordings).then(() =>
        this.settleNativeBackground(background),
      )
    }
  }

  private closeConnection(connection: CodexAppServerConnection, error: Error): Promise<void> {
    if (this.closingConnection) return this.closingConnection
    // Defer close by one microtask: an internally initiated close invokes onClosed
    // before its shutdown Promise is installed.
    const closing = Promise.resolve().then(() => connection.close(error))
    this.closingConnection = closing
    void closing.then(
      () => {
        if (this.closingConnection === closing) this.closingConnection = undefined
        return undefined
      },
      () => undefined,
    )
    return closing
  }

  private scheduleIdleDisconnect(): void {
    if (!this.connection || this.disposed || this.hasActiveBackgroundWork()) return
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      const connection = this.connection
      if (connection)
        void this.closeConnection(
          connection,
          new Error('Codex connection closed after being idle.'),
        )
    }, IDLE_CONNECTION_TIMEOUT_MS)
  }

  private async interruptForegroundCommands(
    background: NativeBackground,
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    commands: Map<string, string | undefined>,
  ): Promise<void> {
    const deadline = new AbortController()
    const expiresAt = Date.now() + CODEX_STOP_TIMEOUT_MS
    const timer = setTimeout(() => deadline.abort(), CODEX_STOP_TIMEOUT_MS)
    const signal = AbortSignal.any([deadline.signal, background.observation.signal])
    const current = (): boolean =>
      !signal.aborted &&
      !this.disposed &&
      !background.closed &&
      this.connection === connection &&
      background.connection === connection &&
      connection.isOpen &&
      background.primaryThreadId === threadId &&
      background.primaryTurnId === turnId
    const request = async (method: string, params: object): Promise<object> => {
      if (!current()) throw new Error('Native interruption ownership is no longer current.')
      const response = await connection.request(method, params, {
        timeoutMs: Math.max(1, Math.min(2_000, expiresAt - Date.now())),
        signal,
        canDispatch: current,
      })
      if (!current() || Object.hasOwn(response, 'error'))
        throw new Error('Native interruption could not be confirmed.')
      return response
    }
    // Read all bounded pages before writes; termination must not shift cursors.
    const handles = new Map<string, string>()
    const processes = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined,
      bytes = 0,
      handleBytes = 0,
      cursorBytes = 0
    try {
      await request('turn/interrupt', { threadId, turnId })
      if (!commands.size) return
      for (let page = 0; ; page += 1) {
        if (page >= CODEX_STOP_COMMANDS)
          throw new Error('Native terminal discovery exceeded its page limit.')
        // oxlint-disable-next-line no-await-in-loop -- Native cursor pages are sequential and share one overall cancellation deadline.
        const response = await request('thread/backgroundTerminals/list', {
          threadId,
          limit: 1,
          ...(cursor ? { cursor } : {}),
        })
        const pageBytes = Buffer.byteLength(JSON.stringify(response))
        bytes += pageBytes
        if (pageBytes > CODEX_STOP_IDENTITY_BYTES || bytes > CODEX_STOP_DISCOVERY_BYTES)
          throw new Error('Native terminal discovery exceeded its byte limit.')
        const result = Reflect.get(response, 'result')
        const data = result && typeof result === 'object' ? Reflect.get(result, 'data') : undefined
        const next =
          result && typeof result === 'object' ? Reflect.get(result, 'nextCursor') : undefined
        if (!Array.isArray(data) || data.length > 1 || (next !== null && typeof next !== 'string'))
          throw new Error('Native terminal discovery returned an invalid page.')
        for (const entry of data) {
          const id = entry && typeof entry === 'object' ? Reflect.get(entry, 'itemId') : undefined
          const handle =
            entry && typeof entry === 'object' ? Reflect.get(entry, 'processId') : undefined
          if (
            typeof id !== 'string' ||
            !id ||
            Buffer.byteLength(id) > 1024 ||
            typeof handle !== 'string' ||
            !handle ||
            Buffer.byteLength(handle) > 1024
          )
            throw new Error('Native terminal discovery returned an invalid identity.')
          if (!commands.has(id)) continue
          if (
            handles.has(id) ||
            processes.has(handle) ||
            (commands.get(id) !== undefined && commands.get(id) !== handle)
          )
            throw new Error('Native terminal ownership did not match the stopped command.')
          handleBytes += Buffer.byteLength(JSON.stringify([id, handle]))
          if (handleBytes > CODEX_STOP_IDENTITY_BYTES)
            throw new Error('Native terminal handles exceeded their identity limit.')
          handles.set(id, handle)
          processes.add(handle)
        }
        if (next === null) break
        if (!next || Buffer.byteLength(next) > 1024 || cursors.has(next))
          throw new Error('Native terminal discovery returned an invalid cursor.')
        cursorBytes += Buffer.byteLength(next)
        if (cursorBytes > CODEX_STOP_IDENTITY_BYTES)
          throw new Error('Native terminal cursors exceeded their byte limit.')
        cursors.add(next)
        cursor = next
      }
      for (const id of commands.keys())
        if (!handles.has(id) && background.operations.has(JSON.stringify([threadId, turnId, id])))
          throw new Error('A stopped native command has no authoritative terminal handle.')
      for (const handle of handles.values()) {
        // One write per authoritative handle, no retries after unknown delivery.
        // oxlint-disable-next-line no-await-in-loop -- Native writes are deliberately serial, owned, and never retried after unknown delivery.
        const response = await request('thread/backgroundTerminals/terminate', {
          threadId,
          processId: handle,
        })
        const result = Reflect.get(response, 'result')
        if (
          !result ||
          typeof result !== 'object' ||
          typeof Reflect.get(result, 'terminated') !== 'boolean'
        )
          throw new Error('Native command termination returned an invalid acknowledgement.')
        // Only real item/turn receipts can release effects and record an ending.
      }
    } finally {
      clearTimeout(timer)
      deadline.abort()
      handles.clear()
      processes.clear()
      cursors.clear()
    }
  }

  private async startProcess(
    cwd: string,
    storageRoot?: string,
    env = codexProcessEnvironment(storageRoot),
  ): Promise<{ child: ChildProcessWithoutNullStreams; close: () => Promise<void> }> {
    const isWindowsCommand = process.platform === 'win32' && /\.cmd$/iu.test(this.executablePath)
    if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(this.executablePath)) {
      throw new AgentExecutionError('runtime_incompatible', 'Unsafe Codex executable path.', false)
    }
    const target = isWindowsCommand ? (process.env.ComSpec ?? 'cmd.exe') : this.executablePath
    // The probe and its actor see exactly the same executable, directory and env.
    const options = {
      cwd,
      shell: false as const,
      stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: isWindowsCommand,
      env,
    }
    const launch = (runtimeArgs: string[]): ChildProcessWithoutNullStreams =>
      spawn(
        target,
        isWindowsCommand
          ? ['/d', '/s', '/c', `""${this.executablePath}" ${runtimeArgs.join(' ')}"`]
          : runtimeArgs,
        options,
      )
    const runtimeArgs = await this.discoverInterruptArgs(launch)
    if (this.disposed)
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    const processGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
    const child = processGroup.spawn(
      target,
      isWindowsCommand
        ? ['/d', '/s', '/c', `""${this.executablePath}" ${runtimeArgs.join(' ')}"`]
        : runtimeArgs,
      { cwd, env, windowsHide: true, windowsVerbatimArguments: isWindowsCommand },
    )
    return { child, close: () => processGroup.close() }
  }

  private discoverInterruptArgs(
    launch: (args: string[]) => ChildProcessWithoutNullStreams,
  ): Promise<string[]> {
    if (this.featureProbe)
      return Promise.reject(
        new AgentExecutionError(
          'runtime_incompatible',
          'The previous Codex capability probe has not confirmed process exit.',
          false,
        ),
      )
    let child: ChildProcessWithoutNullStreams
    try {
      child = launch(['features', 'list'])
    } catch {
      return Promise.reject(
        codexCapabilityError('Codex native interruption capabilities could not be verified.'),
      )
    }
    let stop!: () => void
    const task = new Promise<string[]>((resolve, reject) => {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      let stdout = '',
        bytes = 0,
        failure: AgentExecutionError | undefined,
        finished = false
      let exitDeadline: ReturnType<typeof setTimeout> | undefined
      const fail = (error: AgentExecutionError): void => {
        if (failure || finished) return
        failure = error
        stdout = ''
        clearTimeout(deadline)
        try {
          // Only this zero-input capability process is terminated, never an executor.
          child.kill('SIGKILL')
        } catch {
          /* The close event remains the only process-release witness. */
        }
        exitDeadline = setTimeout(() => {
          finished = true
          child.stdout.off('data', captureOutput)
          child.stderr.off('data', captureError)
          child.stdout.destroy()
          child.stderr.destroy()
          child.stdin.destroy()
          reject(codexCapabilityError('The Codex capability probe did not confirm process exit.'))
          // Retain this one owner until its actual close; do not admit another probe.
        }, CODEX_FEATURE_PROBE_EXIT_MS)
      }
      stop = () => fail(codexCapabilityError('Codex capability discovery was cancelled.'))
      const capture = (chunk: Buffer, output: boolean): void => {
        if (failure || finished) return
        bytes += chunk.length
        if (bytes > CODEX_FEATURE_PROBE_BYTES) {
          fail(codexCapabilityError('Codex capability discovery exceeded its output limit.'))
          return
        }
        if (output) {
          try {
            stdout += decoder.decode(chunk, { stream: true })
          } catch {
            fail(codexCapabilityError('Codex returned an invalid capability inventory.'))
          }
        }
      }
      const captureOutput = (chunk: Buffer): void => capture(chunk, true)
      const captureError = (chunk: Buffer): void => capture(chunk, false)
      const processError = (): void =>
        fail(codexCapabilityError('Codex native interruption capabilities could not be verified.'))
      const inputError = (): void => {
        child.stdin.destroy()
      }
      const closed = (code: number | null, signal: NodeJS.Signals | null): void => {
        clearTimeout(deadline)
        clearTimeout(exitDeadline)
        child.stdout.off('data', captureOutput)
        child.stderr.off('data', captureError)
        child.off('error', processError)
        child.stdin.off('error', inputError)
        if (this.featureProbe?.task === task) this.featureProbe = undefined
        if (finished) return
        finished = true
        if (failure) reject(failure)
        else if (code !== 0 || signal)
          reject(
            codexCapabilityError('Codex native interruption capabilities could not be verified.'),
          )
        else {
          try {
            resolve(CodexAgentAdapter.interruptArgs(stdout + decoder.decode()))
          } catch {
            reject(
              codexCapabilityError(
                'Codex returned an unsupported native interruption capability inventory.',
              ),
            )
          }
        }
        stdout = ''
      }
      const deadline = setTimeout(
        () => fail(codexCapabilityError('Codex capability discovery exceeded its deadline.')),
        CODEX_FEATURE_PROBE_TIMEOUT_MS,
      )
      child.stdout.on('data', captureOutput)
      child.stderr.on('data', captureError)
      child.once('error', processError)
      child.stdin.once('error', inputError)
      child.once('close', closed)
      child.stdin.end()
    })
    this.featureProbe = { stop: () => stop(), task }
    return task
  }

  private static interruptArgs(inventory: string): string[] {
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

  private async pactToolConfig(
    connection: CodexAppServerConnection,
    url: string,
    cwd: string,
    signal: AbortSignal,
    mode: SessionPermissionMode = 'native',
  ): Promise<{ config: object; nativePolicy: object; settingsPolicy?: object | undefined }> {
    const response = await connection.request(
      'config/read',
      { cwd, includeLayers: false },
      { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal },
    )
    const result = Reflect.get(response, 'result')
    const config = result && typeof result === 'object' ? Reflect.get(result, 'config') : undefined
    if (!config || typeof config !== 'object' || Reflect.get(response, 'error'))
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex could not read its effective native configuration.',
        false,
      )
    const servers = Reflect.get(config, 'mcp_servers') ?? {}
    if (servers && typeof servers === 'object' && Object.hasOwn(servers, this.peerServerName))
      this.peerServerName = `pact_peer_${randomUUID().replaceAll('-', '')}`
    const approvalPolicy = Reflect.get(config, 'approval_policy')
    const sandbox = Reflect.get(config, 'sandbox_mode')
    const reviewer = Reflect.get(config, 'approvals_reviewer') ?? 'user'
    const profile = Reflect.get(config, 'default_permissions')
    const workspace = Reflect.get(config, 'sandbox_workspace_write')
    // An omitted legacy table selects the CLI's default workspace policy.
    // Keep the raw value for forwarding; only the comparison uses defaults.
    const workspacePolicy = workspace ?? {}
    const roots =
      workspacePolicy && typeof workspacePolicy === 'object'
        ? (Reflect.get(workspacePolicy, 'writable_roots') ?? [])
        : []
    const normalizedRoots =
      Array.isArray(roots) && roots.every((root) => typeof root === 'string')
        ? [...new Set(roots.map((root) => resolvePath(root)))]
            .filter((root) => root !== resolvePath(cwd))
            .toSorted()
        : undefined
    const policy =
      mode === 'native'
        ? sandbox === 'danger-full-access'
          ? { type: 'dangerFullAccess' }
          : sandbox === 'read-only'
            ? { type: 'readOnly', networkAccess: false }
            : sandbox === 'workspace-write' &&
                workspacePolicy &&
                typeof workspacePolicy === 'object' &&
                normalizedRoots
              ? {
                  type: 'workspaceWrite',
                  writableRoots: normalizedRoots,
                  networkAccess: Reflect.get(workspacePolicy, 'network_access') ?? false,
                  excludeTmpdirEnvVar:
                    Reflect.get(workspacePolicy, 'exclude_tmpdir_env_var') ?? false,
                  excludeSlashTmp: Reflect.get(workspacePolicy, 'exclude_slash_tmp') ?? false,
                }
              : undefined
        : mode === 'full'
          ? { type: 'dangerFullAccess' }
          : undefined
    const settingsPolicy =
      mode === 'native'
        ? approvalPolicy != null && (typeof profile === 'string' || policy)
          ? {
              approvalPolicy,
              approvalsReviewer: reviewer,
              ...(typeof profile === 'string'
                ? { permissions: profile }
                : { sandboxPolicy: policy }),
            }
          : undefined
        : {
            approvalPolicy: mode === 'full' ? 'never' : 'on-request',
            approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
            ...(mode === 'full' ? { sandboxPolicy: policy } : { permissions: ':workspace' }),
          }
    return {
      // Override this one fresh name only. Native feature/MCP settings remain untouched.
      config: {
        ...(Object.hasOwn(config, 'sandbox_workspace_write') && workspace != null
          ? { sandbox_workspace_write: workspace }
          : {}),
        [`mcp_servers.${this.peerServerName}`]: {
          url,
          startup_timeout_sec: 10,
          tool_timeout_sec: 10,
        },
      },
      // Native selection restores only known configuration. Explicit presets are user choices.
      // A loaded Thread applies settingsPolicy separately; resume overrides are not an ACK.
      nativePolicy:
        mode === 'native'
          ? {
              ...(approvalPolicy == null ? {} : { approvalPolicy }),
              approvalsReviewer: reviewer,
              ...(typeof profile === 'string'
                ? { permissions: profile }
                : sandbox == null
                  ? {}
                  : { sandbox }),
            }
          : {
              approvalPolicy: mode === 'full' ? 'never' : 'on-request',
              approvalsReviewer: mode === 'auto' ? 'auto_review' : 'user',
              ...(mode === 'full'
                ? { sandbox: 'danger-full-access' }
                : { permissions: ':workspace' }),
            },
      settingsPolicy,
    }
  }

  private static confirmPermissionMode(message: object, mode?: SessionPermissionMode): void {
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

  private async applyPermissionSettings(
    connection: CodexAppServerConnection,
    threadId: string,
    policy: object | undefined,
    signal: AbortSignal,
    resumed?: object,
  ): Promise<void> {
    if (signal.aborted)
      throw new AgentExecutionError(
        'user_stopped',
        'Permission update was cancelled. No task was submitted.',
        false,
      )
    if (!policy && process.platform === 'win32')
      policy = await this.readWindowsDefaultPermissionSettings(connection, threadId, signal)
    if (!policy)
      throw new PermissionModeRejectedError(
        'Native permission configuration is incomplete. Choose Ask for approval or configure a native permissions profile; no task was submitted.',
      )
    const current = resumed && Reflect.get(resumed, 'result')
    const currentThread =
      current && typeof current === 'object' ? Reflect.get(current, 'thread') : undefined
    if (
      current &&
      typeof current === 'object' &&
      !Array.isArray(current) &&
      currentThread &&
      typeof currentThread === 'object' &&
      !Array.isArray(currentThread) &&
      Reflect.get(currentThread, 'id') === threadId &&
      CodexAgentAdapter.samePermissionPolicy(
        {
          approvalPolicy: Reflect.get(current, 'approvalPolicy'),
          approvalsReviewer: Reflect.get(current, 'approvalsReviewer'),
          sandboxPolicy: Reflect.get(current, 'sandbox'),
          activePermissionProfile: Reflect.get(current, 'activePermissionProfile'),
        },
        policy,
      )
    )
      // This fresh native readback already proves the requested policy is in
      // force. Codex does not emit a settings notification for a no-op update.
      return
    const controller = new AbortController()
    const observedSignal = AbortSignal.any([signal, controller.signal])
    let settle!: (settings: object | undefined) => void
    const observed = new Promise<object | undefined>((resolve) => {
      settle = resolve
    })
    const aborted = () => settle(undefined)
    observedSignal.addEventListener('abort', aborted, { once: true })
    const deadline = setTimeout(() => controller.abort(), CODEX_THREAD_RPC_TIMEOUT_MS)
    let release: (() => void) | undefined
    try {
      release = connection.subscribeBackground((message) => {
        const params = Reflect.get(message, 'params')
        if (
          Reflect.get(message, 'method') !== 'thread/settings/updated' ||
          !params ||
          typeof params !== 'object' ||
          Array.isArray(params) ||
          Reflect.get(params, 'threadId') !== threadId
        )
          return false
        settle(Reflect.get(params, 'threadSettings'))
        return true
      })
      const response = await connection.request(
        'thread/settings/update',
        { threadId, ...policy },
        { timeoutMs: CODEX_THREAD_RPC_TIMEOUT_MS, signal: observedSignal },
      )
      if (Reflect.get(response, 'error'))
        throw classifyAgentError(new Error(JSON.stringify(Reflect.get(response, 'error'))))
      const actual = await observed
      if (observedSignal.aborted || !CodexAgentAdapter.samePermissionPolicy(actual, policy))
        throw new PermissionModeRejectedError(
          observedSignal.aborted
            ? 'Codex did not return a permission confirmation before the check ended. No task was submitted; the original native session was kept.'
            : 'Codex returned permissions that did not match the requested policy. No task was submitted; the original native session was kept.',
        )
    } finally {
      release?.()
      clearTimeout(deadline)
      observedSignal.removeEventListener('abort', aborted)
      settle(undefined)
    }
  }

  private static samePermissionPolicy(actual: unknown, expected: object): boolean {
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
      CodexAgentAdapter.sameSandboxPolicy(
        Reflect.get(actual, 'sandboxPolicy'),
        Reflect.get(expected, 'sandboxPolicy'),
      )
    )
  }

  private static sameSandboxPolicy(actual: unknown, expected: unknown): boolean {
    return isDeepStrictEqual(
      CodexAgentAdapter.normalizeSandboxPolicy(actual),
      CodexAgentAdapter.normalizeSandboxPolicy(expected),
    )
  }

  private static normalizeSandboxPolicy(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Reflect.get(value, 'type') !== 'workspaceWrite')
      return value
    const roots = Reflect.get(value, 'writableRoots')
    if (!Array.isArray(roots) || !roots.every((root) => typeof root === 'string')) return value
    return { ...value, writableRoots: [...new Set(roots)].toSorted() }
  }

  private static isPeerTool(item: object, serverName: string): boolean {
    return (
      Reflect.get(item, 'type') === 'mcpToolCall' &&
      Reflect.get(item, 'server') === serverName &&
      Reflect.get(item, 'tool') === 'request_peer_assistance'
    )
  }

  private static peerProposal(
    item: object,
    turnId: string,
    expectedReceipt: string,
    serverName: string,
  ): Extract<NormalizedAgentEvent, { type: 'peer.assistance.requested' }> | undefined {
    if (
      Reflect.get(item, 'status') !== 'completed' ||
      Reflect.get(item, 'error') !== null ||
      !CodexAgentAdapter.isPeerTool(item, serverName)
    )
      return undefined
    const input = Reflect.get(item, 'arguments')
    const parsed = peerRequestToolInputSchema.safeParse(input)
    if (!parsed.success || parsed.data.target !== 'claude') return undefined
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
      targetAgentId: 'claude',
      kind: parsed.data.kind,
      ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
    }
  }

  private static probeIdentity(input: AgentNativeProbeInput): NativeEvidenceIdentity {
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
      ...(input.answerFormat ? { answerFormat: input.answerFormat } : {}),
    }
  }

  private runIdentity(
    input: AgentRunInput,
    nativeSessionId: string,
    nativeTurnId?: string,
  ): NativeEvidenceIdentity {
    return {
      sessionId: input.sessionId,
      agentId: this.id,
      runId: input.runId,
      ...(input.answerFormat ? { answerFormat: input.answerFormat } : {}),
      requestId: input.runId,
      nativeSessionId,
      bindingGeneration: input.bindingGeneration ?? 1,
      executorId:
        [...this.nativeBackground].find(
          (owner) => owner.input.runId === input.runId && owner.primaryThreadId === nativeSessionId,
        )?.connection?.executorId ?? this.executorId,
      ...(nativeTurnId ? { nativeTurnId } : {}),
    }
  }

  private admitEvidenceCache(): void {
    const bytes = (): number =>
      [...this.terminalEvidence.values()].reduce(
        (sum, entry) => sum + freezeNativeJsonFrame(entry),
        0,
      )
    while (this.terminalEvidence.size > 8 || bytes() > 16 * 1024 * 1024)
      this.terminalEvidence.delete(this.terminalEvidence.keys().next().value!)
    for (;;) {
      try {
        this.evidenceCacheWork.resize(bytes())
        return
      } catch (error) {
        if (!(error instanceof AgentExecutionError) || !this.terminalEvidence.size) throw error
        // Cache pressure never discards the live durable Native evidence callback.
        this.terminalEvidence.delete(this.terminalEvidence.keys().next().value!)
      }
    }
  }

  private recordTerminal(
    input: AgentRunInput,
    nativeSessionId: string,
    nativeTurnId: string,
    outcome: 'completed' | 'failed' | 'interrupted',
    answer: Pick<AgentAnswerAssembler, 'outputId' | 'text'>,
    submittedReport?: ReturnType<typeof readSubmittedCollaborationReport>,
  ): void {
    const evidence: Extract<NativeProbeResult, { kind: 'ended' }> = {
      kind: 'ended',
      identity: this.runIdentity(input, nativeSessionId, nativeTurnId),
      source: 'live_terminal',
      outcome,
      ...(answer.text
        ? {
            output: {
              outputId: answer.outputId,
              text: answer.text,
              completeness: outcome === 'completed' ? ('complete' as const) : ('partial' as const),
              ...(submittedReport ? { submittedReport } : {}),
            },
          }
        : {}),
    }
    if (!this.disposed) {
      this.terminalEvidence.delete(input.runId)
      this.terminalEvidence.set(input.runId, evidence)
      this.admitEvidenceCache()
    }
    input.recordNativeEvidence?.(evidence)
  }

  private static matchingTurn(turns: unknown, input: AgentNativeProbeInput): object | undefined {
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

  private static historicalOutput(
    turns: unknown,
    input: AgentNativeProbeInput,
    terminalComplete = false,
  ): Extract<NativeProbeResult, { kind: 'no_evidence' }>['output'] {
    const turn = CodexAgentAdapter.matchingTurn(turns, input)
    if (!turn) return undefined
    const items = Reflect.get(turn, 'items')
    if (!Array.isArray(items)) return undefined
    using answer = new AgentAnswerAssembler(input.requestId)
    let full = terminalComplete && Reflect.get(turn, 'itemsView') === 'full'
    const ids = new Set<string>()
    const projectionItems: Array<{ id: string; text: string; phase?: unknown }> = []
    for (const item of items) {
      if (!item || typeof item !== 'object' || typeof Reflect.get(item, 'type') !== 'string') {
        full = false
        continue
      }
      if (Reflect.get(item, 'type') !== 'agentMessage') continue
      if (input.answerFormat) {
        const id = Reflect.get(item, 'id'),
          text = Reflect.get(item, 'text')
        if (typeof id !== 'string' || typeof text !== 'string' || ids.has(id)) full = false
        else {
          ids.add(id)
          answer.complete(id, text)
          projectionItems.push({ id, text, phase: Reflect.get(item, 'phase') })
        }
        continue
      }
      const id = Reflect.get(item, 'id'),
        text = Reflect.get(item, 'text')
      if (typeof id === 'string' && id.length > 0 && typeof text === 'string') {
        if (ids.has(id)) full = false
        answer.complete(id, text)
        ids.add(id)
      } else full = false
    }
    if (input.answerFormat)
      answer.replace(projectCollaborationAnswer(projectionItems, input.answerFormat))
    const submittedReport = readSubmittedCollaborationReport(
      readCollaborationEnvelopeText(
        projectionItems.findLast((item) => item.phase !== 'commentary')?.text ?? '',
      ),
      input.answerFormat,
    )
    return answer.text
      ? {
          outputId: answer.outputId,
          text: answer.text,
          completeness: full ? 'complete' : 'partial',
          ...(submittedReport ? { submittedReport } : {}),
        }
      : undefined
  }

  private static storedTurnOutcome(
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

  private static describeTool(
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
        const command = CodexAgentAdapter.stringValue(Reflect.get(item, 'command'))
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
        const tool = CodexAgentAdapter.stringValue(Reflect.get(item, 'tool')) || 'MCP tool'
        const server = CodexAgentAdapter.stringValue(Reflect.get(item, 'server'))
        return {
          toolCallId,
          toolName: tool.slice(0, 120),
          title: completed ? `Used ${tool}` : `Using ${tool}`,
          ...(server ? { detail: AgentActivityDetail.redact(server) } : {}),
        }
      }
      case 'dynamicToolCall': {
        const tool = CodexAgentAdapter.stringValue(Reflect.get(item, 'tool')) || 'tool'
        return {
          toolCallId,
          toolName: tool.slice(0, 120),
          title: completed ? `Used ${tool}` : `Using ${tool}`,
        }
      }
      case 'collabToolCall': {
        const tool = CodexAgentAdapter.stringValue(Reflect.get(item, 'tool')) || 'collaboration'
        return {
          toolCallId,
          toolName: tool.slice(0, 120),
          title: completed ? 'Finished collaboration step' : 'Coordinating with an Agent',
        }
      }
      case 'webSearch': {
        const query = CodexAgentAdapter.stringValue(Reflect.get(item, 'query'))
        return {
          toolCallId,
          toolName: 'webSearch',
          title: completed ? 'Searched the web' : 'Searching the web',
          ...(query ? { detail: AgentActivityDetail.redact(query) } : {}),
        }
      }
      case 'imageView': {
        const rawPath = CodexAgentAdapter.stringValue(Reflect.get(item, 'path'))
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

  private static reasoningSummary(item: object): string {
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

  private static toolFailed(item: object): boolean {
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

  private static stringValue(value: unknown): string {
    if (typeof value === 'string') return value
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
      return value.join(' ')
    }
    return ''
  }

  private static observeThreadTitle(
    thread: unknown,
    observe: ((nativeSessionId: string, logicalTitle?: string) => void) | undefined,
  ): void {
    if (!thread || typeof thread !== 'object') return
    const name = Reflect.get(thread, 'name'),
      id = Reflect.get(thread, 'id')
    if (typeof id === 'string' && typeof name === 'string' && name.trim())
      observe?.(id, CodexAgentAdapter.cleanTitle(name))
  }

  private static threadTitle(thread: unknown): string | undefined {
    return thread && typeof thread === 'object'
      ? CodexAgentAdapter.cleanTitle(Reflect.get(thread, 'name'))
      : undefined
  }

  private static cleanTitle(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const plain = value.trim()
    // Derived Native names are a display label, not another Agent-generated
    // Pact title. Check before the 120-character logical-title projection.
    if (plain.startsWith('[Pact] ')) return undefined
    const title = plain.slice(0, 120)
    return title || undefined
  }
}
