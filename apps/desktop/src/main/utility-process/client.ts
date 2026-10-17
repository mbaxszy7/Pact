import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

import type {
  WorkspaceArchivePrepareInput,
  WorkspaceArchiveOperationInput,
  WorkspaceArchivePreview,
  WorkspaceArchiveReceipt,
  AppError,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  CommentSourceResolution,
  ConversationGetInput,
  ConversationInputWrite,
  ConversationInputState,
  ConversationPage,
  ConversationPatch,
  ConversationRetryInput,
  ConversationSendInput,
  ConversationStopInput,
  NativeContextRebuildInput,
  PeerProposalAcceptInput,
  PeerProposalDismissInput,
  DefaultSessionSettingsEditorState,
  DefaultSessionSettingsSaveInput,
  DefaultSessionSettingsState,
  ProjectArchiveInput,
  ProjectCatalogState,
  ProjectDirectoryAddInput,
  ProjectNameChange,
  ProjectContext,
  ProjectContextInput,
  ProjectFile,
  ProjectFileReadInput,
  RpcResult,
  RuntimeExecutablePathUpdate,
  RuntimeHealth,
  RuntimePreparation,
  SessionArchiveInput,
  SessionCatalogChange,
  SessionCatalogPage,
  SessionCatalogPageInput,
  SessionCreateInput,
  SessionForkInput,
  SessionForkResult,
  SessionCreationPrepareInput,
  SessionMarkReadInput,
  SessionRenameInput,
  SessionSettingsEditorState,
  SessionSettingsSaveResult,
  SessionSettingsInput,
  SessionSettingsSaveInput,
  SessionPermissionSaveInput,
  UtilityRequest,
  UtilityResponse,
  WorkspaceChangeFileReadInput,
  WorkspaceChangeFilePreview,
  WorkspaceChangesPage,
  WorkspaceChangesReadInput,
  WorkspaceChangesUndoInput,
} from '@pact/contracts'

import {
  rpcResultSchema,
  nativePresenceSnapshotSchema,
  nativeAttentionPageSchema,
  sessionCatalogChangeSchema,
  nativeSessionOpenedResultSchema,
  nativeJumpListSuppressionResultSchema,
  nativeQuitPreparationSchema,
  nativeQuitCancelledResultSchema,
  type NativePresenceSnapshot,
  type NativePresenceVersion,
  type NativeSessionRow,
  type NativeAttentionReadInput,
  type NativeAttentionPage,
  type NativeSessionResolveInput,
  type NativeSessionOpenInput,
  type NativeJumpListSuppressionInput,
  type NativeQuitOperationInput,
  type NativeQuitPreparation,
  type NativeResultSchema,
  NATIVE_METADATA_TIMEOUT_MS,
  utilityEventSchema,
  utilityResponseSchema,
  utilityRequestSchema,
  diagnosticPacketSchema,
  runtimeStartupFailureAckSchema,
  directoryFileOperationMessageSchema,
  workspaceStorageRootSchema,
  WORKSPACE_OPERATION_TIMEOUT_MS as WORKSPACE_UNDO_TIMEOUT_MS,
} from '@pact/contracts'

import type { DiagnosticLogs } from '../modules/diagnostics'

import {
  hasLogicalIpcFixtureNonce,
  LogicalIpcTrafficCollector,
  LogicalIpcWorkerTraffic,
  logicalIpcTrafficSnapshot,
} from '../../shared/logical-ipc-traffic'
import { DirectoryFileOperations } from './directory-file-operations'

const REQUEST_TIMEOUT_MS = 2_000
const STARTUP_TIMEOUT_MS = 10_000
const RUNTIME_PREPARATION_TIMEOUT_MS = 12_000
const DEFAULT_SESSION_SETTINGS_TIMEOUT_MS = 25_000
const WORKSPACE_OPERATION_TIMEOUT_MS = 5_000
const WORKSPACE_FILE_READ_TIMEOUT_MS = 15_000
const diagnosticUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(value)

const DIRECTORY_REQUEST_LIMIT = 20

export interface UtilityProcessStartOptions {
  traffic?: LogicalIpcWorkerTraffic
  databaseFile: string
  migrationsFolder: string
  workspaceStorageRoot?: string
  simulateAppearanceWriteFailure?: boolean
  onExit?: () => void
  diagnostics?: Pick<DiagnosticLogs, 'identity' | 'record' | 'attachUtility' | 'acceptUtility'>
  onStartupFailed?: (failure: import('@pact/contracts').RuntimeStartupFailure) => void
}

type WithoutRequestId<Request> = Request extends unknown ? Omit<Request, 'requestId'> : never

export type UtilityRequestPayload = WithoutRequestId<UtilityRequest>

export type UtilityTransportResult =
  | { kind: 'response'; response: UtilityResponse }
  | { kind: 'not-sent'; error: AppError }
  | { kind: 'unknown-delivery'; error: AppError }

export type NativeQuitPreparationAttempt =
  | { kind: 'not-sent'; error: AppError }
  | { kind: 'attempted'; result: RpcResult<NativeQuitPreparation> }

export interface UtilityProcessClient {
  getNativePresence(): Promise<RpcResult<NativePresenceSnapshot>>
  readNativeAttention(input: NativeAttentionReadInput): Promise<RpcResult<NativeAttentionPage>>
  resolveNativeSession(input: NativeSessionResolveInput): Promise<RpcResult<SessionCatalogChange>>
  recordNativeSessionOpened(input: NativeSessionOpenInput): Promise<RpcResult<{ recorded: true }>>
  updateNativeJumpListSuppression(
    input: NativeJumpListSuppressionInput,
  ): Promise<RpcResult<{ updated: true }>>
  prepareNativeQuit(input: NativeQuitOperationInput): Promise<NativeQuitPreparationAttempt>
  cancelNativeQuit(
    input: NativeQuitOperationInput,
  ): Promise<RpcResult<{ operationId: string; cancelled: true }>>
  subscribeNativePresence(listener: (version: NativePresenceVersion) => void): () => void
  subscribeNativeQuitRecent(
    listener: (version: NativePresenceVersion, sessions: NativeSessionRow[]) => void,
  ): () => void
  prepareWorkspaceArchive(
    input: WorkspaceArchivePrepareInput,
  ): Promise<RpcResult<WorkspaceArchivePreview>>
  readWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  cancelWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>>
  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>>
  saveSessionPermission(input: SessionPermissionSaveInput): Promise<RpcResult<SessionCatalogChange>>
  readNativeInput(
    input: import('@pact/contracts').NativeInputRead,
  ): Promise<RpcResult<import('@pact/contracts').NativeInteractionDetails>>
  respondNativeInput(
    input: import('@pact/contracts').NativeInputRespond,
  ): Promise<RpcResult<ConversationPatch>>
  confirmNativeInputURL(
    input: import('@pact/contracts').NativeInputRead,
  ): Promise<RpcResult<ConversationPatch>>
  respondNativePermission(
    input: import('@pact/contracts').NativePermissionRespondInput,
  ): Promise<RpcResult<ConversationPatch>>
  start(options: UtilityProcessStartOptions): void
  /** Wait for this child to install its request handler; never restarts it. */
  waitUntilReady(): Promise<RpcResult<{ ready: true }>>
  getHealth(): Promise<RpcResult<RuntimeHealth>>
  getRuntimePreparation(): Promise<RpcResult<RuntimePreparation>>
  updateRuntimeExecutablePath(
    input: RuntimeExecutablePathUpdate,
  ): Promise<RpcResult<RuntimePreparation>>
  getDefaultSessionSettingsEditorState(): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  saveDefaultSessionSettings(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>>
  getProjectCatalog(): Promise<RpcResult<ProjectCatalogState>>
  readProjectContext(input: ProjectContextInput): Promise<RpcResult<ProjectContext>>
  addProjectDirectory(input: ProjectDirectoryAddInput): Promise<RpcResult<ProjectCatalogState>>
  archiveProject(input: ProjectArchiveInput): Promise<RpcResult<ProjectCatalogState>>
  restoreProject(input: ProjectArchiveInput): Promise<RpcResult<ProjectCatalogState>>
  renameProject(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>>
  getSessionCatalog(input: SessionCatalogPageInput): Promise<RpcResult<SessionCatalogPage>>
  prepareSessionCreation(
    input: SessionCreationPrepareInput,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>>
  createSession(input: SessionCreateInput): Promise<RpcResult<SessionCatalogChange>>
  renameSession(input: SessionRenameInput): Promise<RpcResult<SessionCatalogChange>>
  markSessionRead(input: SessionMarkReadInput): Promise<RpcResult<SessionCatalogChange>>
  archiveSession(input: SessionArchiveInput): Promise<RpcResult<SessionCatalogChange>>
  restoreSession(input: SessionArchiveInput): Promise<RpcResult<SessionCatalogChange>>
  getSessionSettings(input: SessionSettingsInput): Promise<RpcResult<SessionSettingsEditorState>>
  saveSessionSettings(
    input: SessionSettingsSaveInput,
  ): Promise<RpcResult<SessionSettingsSaveResult>>
  cancelSkillCatalog(sessionId: string): Promise<RpcResult<{ ready: true }>>
  readSkillDocument(
    input: import('@pact/contracts').SkillDocumentRead,
  ): Promise<RpcResult<import('@pact/contracts').SkillDocument>>
  cancelSkillDocument(requestId: string): Promise<RpcResult<{ ready: true }>>
  readSkillCatalog(
    input: import('@pact/contracts').SkillCatalogRead,
  ): Promise<RpcResult<import('@pact/contracts').SkillCatalogPage>>
  actOnCollaboration(
    input: import('@pact/contracts').CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>>
  getConversation(input: ConversationGetInput): Promise<RpcResult<ConversationPage>>
  writeConversationImage(
    input: import('@pact/contracts').ImageWriteInput,
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ImageWriteState>>
  chooseConversationImages(
    sessionId: string,
    paths: string[],
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ConversationImage[]>>
  readConversationImage(
    input: import('@pact/contracts').ImageReadInput,
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ImageReadPart>>
  writeConversationInput(
    input: ConversationInputWrite,
    ownerKey: string,
  ): Promise<RpcResult<ConversationInputState>>
  releaseConversationInputs(ownerKey: string): Promise<RpcResult<{ ready: true }>>
  sendConversationMessage(
    input: ConversationSendInput,
    ownerKey?: string,
  ): Promise<RpcResult<ConversationPatch>>
  stopConversation(input: ConversationStopInput): Promise<RpcResult<ConversationPatch>>
  acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>>
  dismissPeerProposal(input: PeerProposalDismissInput): Promise<RpcResult<ConversationPatch>>
  saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>>
  removeCommentDraft(input: CommentDraftRemoveInput): Promise<RpcResult<ConversationPatch>>
  resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>>
  retryConversationRun(input: ConversationRetryInput): Promise<RpcResult<ConversationPatch>>
  rebuildNativeContext(input: NativeContextRebuildInput): Promise<RpcResult<ConversationPatch>>
  setConversationInterests(
    sessionIds: string[],
    timeoutMs?: number,
  ): Promise<RpcResult<{ ready: true }>>
  subscribeConversation(listener: (patch: ConversationPatch, progress: boolean) => void): () => void
  readProjectFile(input: ProjectFileReadInput): Promise<RpcResult<ProjectFile>>
  readWorkspaceChanges(input: WorkspaceChangesReadInput): Promise<RpcResult<WorkspaceChangesPage>>
  readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>>
  undoWorkspaceChanges(input: WorkspaceChangesUndoInput): Promise<RpcResult<ConversationPatch>>
  request(
    request: UtilityRequestPayload,
    expectedResponseType: UtilityResponse['type'],
    timeoutMs?: number,
  ): Promise<UtilityTransportResult>
  dispose(): void
  isRunning(): boolean
  shutdown(): Promise<RpcResult<{ flushed: true }>>
}

interface InFlightRequest {
  readonly child: UtilityProcess
  readonly expectedResponseType: UtilityResponse['type']
  readonly resolve: (result: UtilityTransportResult) => void
  readonly timeout: ReturnType<typeof setTimeout>
  sent: boolean
  startedAt: number
  diagnostic: import('@pact/contracts').DiagnosticEvent
}

class ElectronUtilityProcessClient implements UtilityProcessClient {
  async forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    const result = await this.request(
      { type: 'session.fork.request', input },
      'session.fork.response',
      input.action === 'prepare' ? 45_000 : 15_000,
    )
    if (result.kind !== 'response')
      return {
        ok: false,
        error: {
          ...result.error,
          ...(result.kind === 'unknown-delivery' ? { code: 'UNCERTAIN' as const } : {}),
        },
      }
    return result.response.type === 'session.fork.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected fork response.' } }
  }
  private readonly utilityScriptPath = join(__dirname, 'utility/index.js')
  private readonly directoryOperations = new DirectoryFileOperations(
    join(dirname(this.utilityScriptPath), 'workspace-directory-worker.js'),
  )
  private readonly directoryRequests = new Map<
    string,
    { child: UtilityProcess; controller: AbortController }
  >()
  private shutdownTask: Promise<RpcResult<{ flushed: true }>> | undefined
  private child: UtilityProcess | undefined
  private readyChild: UtilityProcess | undefined
  private startupDeadline: number | undefined
  private startupWait:
    | {
        child: UtilityProcess
        promise: Promise<RpcResult<{ ready: true }>>
        resolve: (result: RpcResult<{ ready: true }>) => void
        timeout: ReturnType<typeof setTimeout>
      }
    | undefined
  private terminatingChild: UtilityProcess | undefined
  private startupFailure: import('@pact/contracts').RuntimeStartupFailure | undefined
  private startupFailureCallback: UtilityProcessStartOptions['onStartupFailed']
  private diagnostics: UtilityProcessStartOptions['diagnostics']
  private traffic: LogicalIpcTrafficCollector | undefined
  private workerTraffic: LogicalIpcWorkerTraffic | undefined
  private readonly inFlightRequests = new Map<string, InFlightRequest>()
  private readonly conversationListeners = new Set<
    (patch: ConversationPatch, progress: boolean) => void
  >()
  private readonly nativePresenceListeners = new Set<(version: NativePresenceVersion) => void>()
  private readonly nativeQuitRecentListeners = new Set<
    (version: NativePresenceVersion, sessions: NativeSessionRow[]) => void
  >()

  getNativePresence(): Promise<RpcResult<NativePresenceSnapshot>> {
    return this.nativeRequest(
      { type: 'native-presence.read.request' },
      'native-presence.read.response',
      nativePresenceSnapshotSchema,
    )
  }

  readNativeAttention(input: NativeAttentionReadInput): Promise<RpcResult<NativeAttentionPage>> {
    return this.nativeRequest(
      { type: 'native-attention.read.request', input },
      'native-attention.read.response',
      nativeAttentionPageSchema,
    )
  }

  resolveNativeSession(input: NativeSessionResolveInput): Promise<RpcResult<SessionCatalogChange>> {
    return this.nativeRequest(
      { type: 'native-session.resolve.request', input },
      'native-session.resolve.response',
      sessionCatalogChangeSchema,
    )
  }

  recordNativeSessionOpened(input: NativeSessionOpenInput): Promise<RpcResult<{ recorded: true }>> {
    return this.nativeRequest(
      { type: 'native-session.opened.request', input },
      'native-session.opened.response',
      nativeSessionOpenedResultSchema,
    )
  }

  updateNativeJumpListSuppression(
    input: NativeJumpListSuppressionInput,
  ): Promise<RpcResult<{ updated: true }>> {
    return this.nativeRequest(
      { type: 'native-jump-list.suppression.request', input },
      'native-jump-list.suppression.response',
      nativeJumpListSuppressionResultSchema,
    )
  }

  async prepareNativeQuit(input: NativeQuitOperationInput): Promise<NativeQuitPreparationAttempt> {
    if (!this.child || this.readyChild !== this.child)
      return {
        kind: 'not-sent',
        error: ElectronUtilityProcessClient.unavailable(
          'Utility runtime is not ready to prepare exit.',
        ),
      }
    const result = await this.request(
      { type: 'native-quit.prepare.request', input },
      'native-quit.prepare.response',
      NATIVE_METADATA_TIMEOUT_MS,
    )
    return result.kind === 'not-sent'
      ? result
      : {
          kind: 'attempted',
          result: ElectronUtilityProcessClient.toNativeResult(
            result,
            'native-quit.prepare.response',
            nativeQuitPreparationSchema,
          ),
        }
  }

  cancelNativeQuit(
    input: NativeQuitOperationInput,
  ): Promise<RpcResult<{ operationId: string; cancelled: true }>> {
    return this.nativeRequest(
      { type: 'native-quit.cancel.request', input },
      'native-quit.cancel.response',
      nativeQuitCancelledResultSchema,
    )
  }

  subscribeNativePresence(listener: (version: NativePresenceVersion) => void): () => void {
    this.nativePresenceListeners.add(listener)
    return () => this.nativePresenceListeners.delete(listener)
  }

  subscribeNativeQuitRecent(
    listener: (version: NativePresenceVersion, sessions: NativeSessionRow[]) => void,
  ): () => void {
    this.nativeQuitRecentListeners.add(listener)
    return () => this.nativeQuitRecentListeners.delete(listener)
  }

  private async nativeRequest<Value>(
    payload: UtilityRequestPayload,
    responseType: UtilityResponse['type'],
    schema: NativeResultSchema<Value>,
  ): Promise<RpcResult<Value>> {
    const result = await this.request(payload, responseType, NATIVE_METADATA_TIMEOUT_MS)
    return ElectronUtilityProcessClient.toNativeResult(result, responseType, schema)
  }

  private static toNativeResult<Value>(
    result: UtilityTransportResult,
    responseType: UtilityResponse['type'],
    schema: NativeResultSchema<Value>,
  ): RpcResult<Value> {
    if (result.kind !== 'response')
      return {
        ok: false,
        error: {
          ...result.error,
          ...(result.kind === 'unknown-delivery' ? { code: 'UNCERTAIN' as const } : {}),
        },
      }
    if (result.response.type !== responseType || !('result' in result.response))
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Invalid native metadata response.' },
      }
    const parsed = rpcResultSchema(schema).safeParse(result.response.result)
    return parsed.success
      ? parsed.data
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid native metadata response.' } }
  }

  start(options: UtilityProcessStartOptions): void {
    if (this.child) return
    if (options.databaseFile !== ':memory:' && !isAbsolute(options.databaseFile)) {
      throw new TypeError('Runtime database path must be absolute or :memory:.')
    }
    if (!isAbsolute(options.migrationsFolder)) {
      throw new TypeError('Runtime migrations folder must be absolute.')
    }
    if (options.workspaceStorageRoot && !isAbsolute(options.workspaceStorageRoot))
      throw new TypeError('Workspace storage must be an absolute private path.')
    if (options.workspaceStorageRoot) workspaceStorageRootSchema.parse(options.workspaceStorageRoot)

    this.diagnostics = options.diagnostics
    this.shutdownTask = undefined
    this.terminatingChild = undefined
    this.readyChild = undefined
    this.startupDeadline = performance.now() + STARTUP_TIMEOUT_MS
    this.startupFailure = undefined
    this.startupFailureCallback = options.onStartupFailed
    const startedChild = utilityProcess.fork(
      this.utilityScriptPath,
      [
        options.databaseFile,
        options.migrationsFolder,
        options.simulateAppearanceWriteFailure ? '1' : '0',
        options.workspaceStorageRoot ?? '',
        options.diagnostics ? JSON.stringify(options.diagnostics.identity) : '',
      ],
      { serviceName: 'Pact Utility Process' },
    )
    if (options.traffic) {
      this.workerTraffic = options.traffic
      this.traffic = options.traffic.collector('main-utility')
      this.directoryOperations.configureTraffic(options.traffic.collector('main-directory'))
    }
    if (this.traffic) this.traffic.advanceTransportEpoch()
    else if (
      hasLogicalIpcFixtureNonce(process.env) &&
      process.env.PACT_E2E_ROOT &&
      options.databaseFile !== ':memory:'
    ) {
      try {
        if (realpathSync(dirname(options.databaseFile)) === realpathSync(process.env.PACT_E2E_ROOT))
          this.traffic = new LogicalIpcTrafficCollector('main-utility', randomUUID())
      } catch {
        // An unproved measurement root stays disabled; absence leaves instrumentation disabled.
      }
    }

    this.child = startedChild
    this.diagnostics?.attachUtility(startedChild)
    this.diagnostics?.record({
      operation: 'utility',
      phase: 'started',
      ...(startedChild.pid ? { pid: startedChild.pid } : {}),
    })
    startedChild.on('message', (message) => this.receiveResponse(startedChild, message))
    startedChild.on('exit', (code) => {
      this.diagnostics?.record({
        operation: 'utility',
        phase: 'closed',
        level: this.shutdownTask ? 'info' : 'error',
        exitCode: code,
      })
      this.cancelDirectoryRequests(startedChild)
      if (this.child !== startedChild) return
      this.child = undefined
      this.readyChild = undefined
      this.startupDeadline = undefined
      this.settleStartup(startedChild, {
        ok: false,
        error: ElectronUtilityProcessClient.unavailable(
          'Utility runtime exited before startup completed.',
        ),
      })
      this.failChildRequests(
        startedChild,
        this.startupFailureError() ??
          ElectronUtilityProcessClient.unavailable(`Utility runtime exited with code ${code}.`),
      )
      options.onExit?.()
    })
  }

  waitUntilReady(): Promise<RpcResult<{ ready: true }>> {
    const startupError = this.startupFailureError()
    if (startupError) return Promise.resolve({ ok: false, error: startupError })
    const target = this.child
    if (!target || this.terminatingChild || this.shutdownTask)
      return Promise.resolve({
        ok: false,
        error: ElectronUtilityProcessClient.unavailable(
          'Utility runtime is not available for startup.',
        ),
      })
    if (this.readyChild === target) return Promise.resolve({ ok: true, value: { ready: true } })
    if (this.startupWait?.child === target) return this.startupWait.promise

    // The first wait includes fork/module loading. Only an explicit caller retry
    // starts another bounded wait; timeout never releases or restarts the child.
    this.startupDeadline ??= performance.now() + STARTUP_TIMEOUT_MS
    const completion = Promise.withResolvers<RpcResult<{ ready: true }>>()
    const timeout = setTimeout(
      () => {
        this.startupDeadline = undefined
        this.settleStartup(target, {
          ok: false,
          error: { code: 'TIMEOUT', message: 'Pact local runtime startup timed out.' },
        })
      },
      Math.max(0, this.startupDeadline - performance.now()),
    )
    this.startupWait = {
      child: target,
      promise: completion.promise,
      resolve: completion.resolve,
      timeout,
    }
    return completion.promise
  }

  private settleStartup(target: UtilityProcess, result: RpcResult<{ ready: true }>): void {
    const waiting = this.startupWait
    if (waiting?.child !== target) return
    clearTimeout(waiting.timeout)
    this.startupWait = undefined
    waiting.resolve(result)
  }

  request(
    payload: UtilityRequestPayload,
    expectedResponseType: UtilityResponse['type'],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<UtilityTransportResult> {
    const startupError = this.startupFailureError()
    if (startupError) return Promise.resolve({ kind: 'not-sent', error: startupError })
    if (
      this.terminatingChild ||
      (this.shutdownTask && payload.type !== 'runtime.shutdown.request')
    ) {
      return Promise.resolve({
        kind: 'not-sent',
        error: ElectronUtilityProcessClient.unavailable('Utility runtime is shutting down.'),
      })
    }
    const target = this.child
    if (!target) {
      return Promise.resolve({
        kind: 'not-sent',
        error: ElectronUtilityProcessClient.unavailable('Utility runtime is not running.'),
      })
    }

    const requestId = randomUUID()
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const request = this.inFlightRequests.get(requestId)
        if (request) {
          this.finishRequest(
            requestId,
            ElectronUtilityProcessClient.requestFailure(
              request,
              ElectronUtilityProcessClient.timeoutError(),
            ),
          )
        }
      }, timeoutMs)
      const request: InFlightRequest = {
        child: target,
        expectedResponseType,
        resolve,
        timeout,
        sent: false,
        startedAt: Date.now(),
        diagnostic: this.requestDiagnostic(payload, requestId),
      }
      this.inFlightRequests.set(requestId, request)
      this.diagnostics?.record(request.diagnostic)

      try {
        const packet = { ...payload, requestId }
        target.postMessage(packet)
        request.sent = true
        const traffic = this.traffic
        if (traffic) {
          try {
            const observed = utilityRequestSchema.safeParse(packet)
            if (observed.success)
              traffic.record(
                'main-utility.request',
                payload.type === 'runtime.health.request' ||
                  payload.type === 'runtime.shutdown.request'
                  ? 'control'
                  : 'business',
                packet,
              )
            else traffic.invalidate('unvalidated_message')
          } catch {
            traffic.invalidate('unvalidated_message')
          }
        }
      } catch {
        this.traffic?.invalidate('transport_error')
        this.finishRequest(requestId, {
          kind: 'not-sent',
          error: ElectronUtilityProcessClient.unavailable(
            'Utility runtime could not receive the request.',
          ),
        })
      }
    })
  }

  async getHealth(): Promise<RpcResult<RuntimeHealth>> {
    const result = ElectronUtilityProcessClient.toHealthResult(
      await this.request({ type: 'runtime.health.request' }, 'runtime.health.response'),
    )
    return result.ok && this.traffic
      ? {
          ok: true,
          value: {
            ...result.value,
            ipcTraffic: logicalIpcTrafficSnapshot(this.traffic.snapshot(), [
              ...(this.workerTraffic
                ?.snapshots()
                .filter((owner) => owner.owner !== 'main-utility') ?? []),
              ...(result.value.ipcTraffic?.owners.filter((owner) =>
                [
                  'utility-markdown',
                  'utility-image',
                  'utility-native-json',
                  'utility-native-fork',
                ].includes(owner.owner),
              ) ?? []),
            ]),
          },
        }
      : result
  }

  async getRuntimePreparation(): Promise<RpcResult<RuntimePreparation>> {
    return ElectronUtilityProcessClient.toRuntimePreparationResult(
      await this.request(
        { type: 'runtime-preparation.get.request' },
        'runtime-preparation.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async updateRuntimeExecutablePath(
    input: RuntimeExecutablePathUpdate,
  ): Promise<RpcResult<RuntimePreparation>> {
    return ElectronUtilityProcessClient.toRuntimePreparationResult(
      await this.request(
        { type: 'runtime-preparation.path.update.request', input },
        'runtime-preparation.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async getDefaultSessionSettingsEditorState(): Promise<
    RpcResult<DefaultSessionSettingsEditorState>
  > {
    return ElectronUtilityProcessClient.toDefaultSessionSettingsEditorStateResult(
      await this.request(
        { type: 'default-session-settings.get.request' },
        'default-session-settings.get.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async saveDefaultSessionSettings(
    input: DefaultSessionSettingsSaveInput,
  ): Promise<RpcResult<DefaultSessionSettingsState>> {
    return ElectronUtilityProcessClient.toDefaultSessionSaveResult(
      await this.request(
        { type: 'default-session-settings.save.request', input },
        'default-session-settings.save.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async prepareWorkspaceArchive(
    input: WorkspaceArchivePrepareInput,
  ): Promise<RpcResult<WorkspaceArchivePreview>> {
    const result = await this.request(
      { type: 'workspace-archive.prepare.request', input },
      'workspace-archive.prepare.response',
      5_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'workspace-archive.prepare.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid archive preview response.' } }
  }

  async readWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>> {
    const result = await this.request(
      { type: 'workspace-archive.read.request', input },
      'workspace-archive.receipt.response',
      5_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'workspace-archive.receipt.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid archive receipt.' } }
  }

  async cancelWorkspaceArchive(
    input: WorkspaceArchiveOperationInput,
  ): Promise<RpcResult<WorkspaceArchiveReceipt>> {
    const result = await this.request(
      { type: 'workspace-archive.cancel.request', input },
      'workspace-archive.receipt.response',
      5_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'workspace-archive.receipt.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid archive cancellation receipt.' } }
  }

  async getProjectCatalog(): Promise<RpcResult<ProjectCatalogState>> {
    return ElectronUtilityProcessClient.toProjectCatalogResult(
      await this.request(
        { type: 'project-catalog.get.request' },
        'project-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async readProjectContext(input: ProjectContextInput): Promise<RpcResult<ProjectContext>> {
    const result = await this.request(
      { type: 'project-context.read.request', input },
      'project-context.read.response',
      5_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'project-context.read.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Invalid project context response.' } }
  }

  async addProjectDirectory(
    input: ProjectDirectoryAddInput,
  ): Promise<RpcResult<ProjectCatalogState>> {
    return ElectronUtilityProcessClient.toProjectCatalogResult(
      await this.request(
        { type: 'project-catalog.add.request', input },
        'project-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async archiveProject(input: ProjectArchiveInput): Promise<RpcResult<ProjectCatalogState>> {
    const result = await this.request(
      { type: 'project-catalog.archive.request', input },
      'project-catalog.response',
      20_000,
    )
    if (result.kind === 'unknown-delivery')
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'The archive result is unconfirmed. Check this operation before trying again.',
        },
      }
    return ElectronUtilityProcessClient.toProjectCatalogResult(result)
  }

  async restoreProject(input: ProjectArchiveInput): Promise<RpcResult<ProjectCatalogState>> {
    return ElectronUtilityProcessClient.toProjectCatalogResult(
      await this.request(
        { type: 'project-catalog.restore.request', input },
        'project-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async renameProject(input: ProjectNameChange): Promise<RpcResult<ProjectNameChange>> {
    const result = await this.request(
      { type: 'project-catalog.rename.request', input },
      'project-catalog.rename.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind === 'unknown-delivery') {
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Reload Projects to check whether the name was saved.',
        },
      }
    }
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'project-catalog.rename.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Project rename response.' } }
  }

  async getSessionCatalog(input: SessionCatalogPageInput): Promise<RpcResult<SessionCatalogPage>> {
    return ElectronUtilityProcessClient.toSessionCatalogPageResult(
      await this.request(
        { type: 'session-catalog.get.request', input },
        'session-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async prepareSessionCreation(
    input: SessionCreationPrepareInput,
  ): Promise<RpcResult<DefaultSessionSettingsEditorState>> {
    return ElectronUtilityProcessClient.toSessionCreationResult(
      await this.request(
        { type: 'session-creation.prepare.request', input },
        'session-creation.prepare.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async createSession(input: SessionCreateInput): Promise<RpcResult<SessionCatalogChange>> {
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(
      await this.request(
        { type: 'session.create.request', input },
        'session-catalog.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async renameSession(input: SessionRenameInput): Promise<RpcResult<SessionCatalogChange>> {
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(
      await this.request(
        { type: 'session.rename.request', input },
        'session-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async markSessionRead(input: SessionMarkReadInput): Promise<RpcResult<SessionCatalogChange>> {
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(
      await this.request(
        { type: 'session.mark-read.request', input },
        'session-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async archiveSession(input: SessionArchiveInput): Promise<RpcResult<SessionCatalogChange>> {
    const result = await this.request(
      { type: 'session.archive.request', input },
      'session-catalog.response',
      20_000,
    )
    if (result.kind === 'unknown-delivery')
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'The archive result is unconfirmed. Check this operation before trying again.',
        },
      }
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(result)
  }

  async restoreSession(input: SessionArchiveInput): Promise<RpcResult<SessionCatalogChange>> {
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(
      await this.request(
        { type: 'session.restore.request', input },
        'session-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async getSessionSettings(
    input: SessionSettingsInput,
  ): Promise<RpcResult<SessionSettingsEditorState>> {
    return ElectronUtilityProcessClient.toSessionSettingsResult(
      await this.request(
        { type: 'session-settings.get.request', input },
        'session-settings.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async saveSessionSettings(
    input: SessionSettingsSaveInput,
  ): Promise<RpcResult<SessionSettingsSaveResult>> {
    return ElectronUtilityProcessClient.toSessionSettingsSaveResult(
      await this.request(
        { type: 'session-settings.save.request', input },
        'session-settings.save.response',
        DEFAULT_SESSION_SETTINGS_TIMEOUT_MS,
      ),
    )
  }

  async saveSessionPermission(
    input: SessionPermissionSaveInput,
  ): Promise<RpcResult<SessionCatalogChange>> {
    return ElectronUtilityProcessClient.toSessionCatalogChangeResult(
      await this.request(
        { type: 'session-permission.save.request', input },
        'session-catalog.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async cancelSkillCatalog(sessionId: string): Promise<RpcResult<{ ready: true }>> {
    const result = await this.request(
      { type: 'skills.cancel.request', input: { sessionId } },
      'conversation.interests.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.interests.response'
      ? result.response.result
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Unexpected Skill cancellation receipt.' },
        }
  }

  async readSkillCatalog(
    input: import('@pact/contracts').SkillCatalogRead,
  ): Promise<RpcResult<import('@pact/contracts').SkillCatalogPage>> {
    const result = await this.request(
      { type: 'skills.read.request', input },
      'skills.page.response',
      RUNTIME_PREPARATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'skills.page.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Skill catalog reply.' } }
  }

  async readSkillDocument(
    input: import('@pact/contracts').SkillDocumentRead,
  ): Promise<RpcResult<import('@pact/contracts').SkillDocument>> {
    const result = await this.request(
      { type: 'skill-document.read.request', input },
      'skill-document.read.response',
      12_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'skill-document.read.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Skill document reply.' } }
  }

  async cancelSkillDocument(requestId: string): Promise<RpcResult<{ ready: true }>> {
    const result = await this.request(
      { type: 'skill-document.cancel.request', input: { requestId } },
      'skill-document.cancel.response',
      12_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'skill-document.cancel.response'
      ? result.response.result
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Unexpected Skill document cancellation.' },
        }
  }

  async actOnCollaboration(
    input: import('@pact/contracts').CollaborationActionInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'collaboration.action.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async getConversation(input: ConversationGetInput): Promise<RpcResult<ConversationPage>> {
    return ElectronUtilityProcessClient.toConversationPageResult(
      await this.request(
        { type: 'conversation.get.request', input },
        'conversation.page.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async writeConversationImage(
    input: import('@pact/contracts').ImageWriteInput,
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ImageWriteState>> {
    const result = await this.request(
      { type: 'conversation.image.write.request', input, ownerKey },
      'conversation.image.write.response',
      12_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.image.write.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected image upload reply.' } }
  }
  async chooseConversationImages(
    sessionId: string,
    paths: string[],
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ConversationImage[]>> {
    const result = await this.request(
      { type: 'conversation.image.choose.request', sessionId, paths, ownerKey },
      'conversation.image.choose.response',
      30_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.image.choose.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected image selection reply.' } }
  }
  async readConversationImage(
    input: import('@pact/contracts').ImageReadInput,
    ownerKey: string,
  ): Promise<RpcResult<import('@pact/contracts').ImageReadPart>> {
    const result = await this.request(
      { type: 'conversation.image.read.request', input, ownerKey },
      'conversation.image.read.response',
      12_000,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.image.read.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected image read reply.' } }
  }
  async writeConversationInput(
    input: ConversationInputWrite,
    ownerKey: string,
  ): Promise<RpcResult<ConversationInputState>> {
    const result = await this.request(
      { type: 'conversation.input.request', input, ownerKey },
      'conversation.input.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.input.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected input write response.' } }
  }

  async releaseConversationInputs(ownerKey: string): Promise<RpcResult<{ ready: true }>> {
    const result = await this.request(
      { type: 'conversation.input.release-owner.request', ownerKey },
      'conversation.input.release-owner.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.input.release-owner.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected input release response.' } }
  }

  async sendConversationMessage(
    input: ConversationSendInput,
    ownerKey?: string,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'conversation.send.request', input, ...(ownerKey ? { ownerKey } : {}) },
        'conversation.patch.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async stopConversation(input: ConversationStopInput): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'conversation.stop.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async acceptPeerProposal(input: PeerProposalAcceptInput): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'peer-proposal.accept.request', input },
        'conversation.patch.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async dismissPeerProposal(
    input: PeerProposalDismissInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'peer-proposal.dismiss.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async respondNativePermission(
    input: import('@pact/contracts').NativePermissionRespondInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'native-permission.respond.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async readNativeInput(
    input: import('@pact/contracts').NativeInputRead,
  ): Promise<RpcResult<import('@pact/contracts').NativeInteractionDetails>> {
    const response = await this.request(
      { type: 'native-input.read.request', input },
      'native-input.read.response',
      5000,
    )
    if (response.kind !== 'response') return { ok: false, error: response.error }
    return response.response.type === 'native-input.read.response'
      ? response.response.result
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'The native input response was invalid.' },
        }
  }

  async respondNativeInput(
    input: import('@pact/contracts').NativeInputRespond,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'native-input.respond.request', input },
        'conversation.patch.response',
        5000,
      ),
    )
  }

  async confirmNativeInputURL(
    input: import('@pact/contracts').NativeInputRead,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'native-input.opened.request', input },
        'conversation.patch.response',
        5000,
      ),
    )
  }

  async retryConversationRun(input: ConversationRetryInput): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'conversation.retry.request', input },
        'conversation.patch.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async rebuildNativeContext(
    input: NativeContextRebuildInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'native-context.rebuild.request', input },
        'conversation.patch.response',
        RUNTIME_PREPARATION_TIMEOUT_MS,
      ),
    )
  }

  async saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'comment-draft.save.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async removeCommentDraft(input: CommentDraftRemoveInput): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'comment-draft.remove.request', input },
        'conversation.patch.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>> {
    const result = await this.request(
      { type: 'comment-source.resolve.request', sessionId, commentId },
      'comment-source.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'comment-source.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Comment response.' } }
  }

  async setConversationInterests(
    sessionIds: string[],
    timeoutMs = WORKSPACE_OPERATION_TIMEOUT_MS,
  ): Promise<RpcResult<{ ready: true }>> {
    const result = await this.request(
      { type: 'conversation.interests.request', input: { sessionIds } },
      'conversation.interests.response',
      Math.min(timeoutMs, WORKSPACE_OPERATION_TIMEOUT_MS),
    )
    return result.kind === 'response' && result.response.type === 'conversation.interests.response'
      ? result.response.result
      : {
          ok: false,
          error:
            result.kind === 'response'
              ? { code: 'INTERNAL', message: 'Unexpected interest acknowledgement.' }
              : result.error,
        }
  }

  subscribeConversation(
    listener: (patch: ConversationPatch, progress: boolean) => void,
  ): () => void {
    this.conversationListeners.add(listener)
    return () => this.conversationListeners.delete(listener)
  }

  async readProjectFile(input: ProjectFileReadInput): Promise<RpcResult<ProjectFile>> {
    return ElectronUtilityProcessClient.toProjectFileResult(
      await this.request(
        { type: 'project-file.read.request', input },
        'project-file.response',
        WORKSPACE_OPERATION_TIMEOUT_MS,
      ),
    )
  }

  async readWorkspaceChanges(
    input: WorkspaceChangesReadInput,
  ): Promise<RpcResult<WorkspaceChangesPage>> {
    const result = await this.request(
      { type: 'workspace-changes.read.request', input },
      'workspace-changes.response',
      WORKSPACE_OPERATION_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'workspace-changes.response'
      ? result.response.result
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Unexpected workspace changes response.' },
        }
  }

  async readWorkspaceChangeFile(
    input: WorkspaceChangeFileReadInput,
  ): Promise<RpcResult<WorkspaceChangeFilePreview>> {
    const result = await this.request(
      { type: 'workspace-changes.file-read.request', input },
      'workspace-changes.file-response',
      WORKSPACE_FILE_READ_TIMEOUT_MS,
    )
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'workspace-changes.file-response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected saved preview response.' } }
  }

  async undoWorkspaceChanges(
    input: WorkspaceChangesUndoInput,
  ): Promise<RpcResult<ConversationPatch>> {
    return ElectronUtilityProcessClient.toConversationPatchResult(
      await this.request(
        { type: 'workspace-changes.undo.request', input },
        'conversation.patch.response',
        WORKSPACE_UNDO_TIMEOUT_MS,
      ),
    )
  }

  shutdown(): Promise<RpcResult<{ flushed: true }>> {
    const target = this.child
    if (target)
      this.settleStartup(target, {
        ok: false,
        error: ElectronUtilityProcessClient.unavailable('Utility runtime is shutting down.'),
      })
    const deadline = performance.now() + WORKSPACE_OPERATION_TIMEOUT_MS
    this.shutdownTask ??= this.request(
      { type: 'runtime.shutdown.request' },
      'runtime.shutdown.response',
      WORKSPACE_OPERATION_TIMEOUT_MS - 1_000,
    ).then(async (result): Promise<RpcResult<{ flushed: true }>> => {
      const acknowledged: RpcResult<{ flushed: true }> =
        result.kind !== 'response'
          ? { ok: false, error: result.error }
          : result.response.type === 'runtime.shutdown.response'
            ? result.response.result
            : {
                ok: false,
                error: { code: 'INTERNAL', message: 'Unexpected shutdown acknowledgement.' },
              }
      this.dispose()
      if (target && !(await this.waitForExit(target, deadline)))
        return {
          ok: false,
          error: {
            code: 'UNCERTAIN',
            message: 'Utility runtime exit could not be confirmed. Its ownership is retained.',
          },
        }
      return acknowledged
    })
    return this.shutdownTask
  }

  isRunning(): boolean {
    return this.child !== undefined
  }

  private waitForExit(target: UtilityProcess, deadline: number): Promise<boolean> {
    if (this.child !== target) return Promise.resolve(true)
    return new Promise((resolve) => {
      const completed = (exited: boolean): void => {
        clearTimeout(timeout)
        target.removeListener('exit', exitedHandler)
        resolve(exited)
      }
      const exitedHandler = (): void => completed(true)
      const timeout = setTimeout(() => completed(false), Math.max(0, deadline - performance.now()))
      target.on('exit', exitedHandler)
    })
  }

  dispose(): void {
    // Main's measurement lives through child shutdown and diagnostic-log close. Its fixed
    // counters survive late deliveries/restarts; disposing this client must not reset them.
    this.conversationListeners.clear()
    this.nativePresenceListeners.clear()
    this.nativeQuitRecentListeners.clear()
    const target = this.child
    this.readyChild = undefined
    this.startupDeadline = undefined
    if (target)
      this.settleStartup(target, {
        ok: false,
        error: ElectronUtilityProcessClient.unavailable('Utility runtime is shutting down.'),
      })
    for (const request of this.directoryRequests.values()) request.controller.abort()
    void this.directoryOperations.dispose().catch(() => undefined)
    if (!target || this.terminatingChild === target) return
    this.terminatingChild = target
    this.failChildRequests(
      target,
      ElectronUtilityProcessClient.unavailable('Utility runtime is shutting down.'),
    )
    try {
      target.kill()
    } catch {
      // A failed kill request does not release the child or its profile ownership.
    }
  }

  private static unavailable(message: string): AppError {
    return { code: 'RUNTIME_UNAVAILABLE', message }
  }

  private static timeoutError(): AppError {
    return { code: 'TIMEOUT', message: 'Utility runtime request timed out.' }
  }

  private static requestFailure(request: InFlightRequest, error: AppError): UtilityTransportResult {
    return request.sent ? { kind: 'unknown-delivery', error } : { kind: 'not-sent', error }
  }

  private static toHealthResult(result: UtilityTransportResult): RpcResult<RuntimeHealth> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    if (result.response.type !== 'runtime.health.response') {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'Utility runtime returned an unexpected health response.',
        },
      }
    }
    return { ok: true, value: result.response.health }
  }

  private static toRuntimePreparationResult(
    result: UtilityTransportResult,
  ): RpcResult<RuntimePreparation> {
    if (result.kind !== 'response')
      return {
        ok: false,
        error:
          result.error.code === 'RUNTIME_UNAVAILABLE'
            ? {
                ...result.error,
                message: 'Pact cannot reach its local runtime. Restart Pact and try again.',
              }
            : result.error,
      }
    if (result.response.type !== 'runtime-preparation.response') {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Utility runtime returned an unexpected response.' },
      }
    }
    return result.response.result
  }

  private static toDefaultSessionSettingsEditorStateResult(
    result: UtilityTransportResult,
  ): RpcResult<DefaultSessionSettingsEditorState> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'default-session-settings.get.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected settings response.' } }
  }

  private static toDefaultSessionSaveResult(
    result: UtilityTransportResult,
  ): RpcResult<DefaultSessionSettingsState> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'default-session-settings.save.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected save response.' } }
  }

  private static toProjectCatalogResult(
    result: UtilityTransportResult,
  ): RpcResult<ProjectCatalogState> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'project-catalog.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected project response.' } }
  }

  private static toSessionCatalogPageResult(
    result: UtilityTransportResult,
  ): RpcResult<SessionCatalogPage> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    if (result.response.type === 'session-catalog.response') {
      const reply = result.response.result
      if (!reply.ok) return reply
      if (reply.value.kind === 'page') return { ok: true, value: reply.value }
    }
    return { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Session page.' } }
  }

  private static toSessionCatalogChangeResult(
    result: UtilityTransportResult,
  ): RpcResult<SessionCatalogChange> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    if (result.response.type === 'session-catalog.response') {
      const reply = result.response.result
      if (!reply.ok) return reply
      if (reply.value.kind === 'change') return { ok: true, value: reply.value }
    }
    return { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Session change.' } }
  }

  private static toSessionCreationResult(
    result: UtilityTransportResult,
  ): RpcResult<DefaultSessionSettingsEditorState> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'session-creation.prepare.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Session response.' } }
  }

  private static toSessionSettingsResult(
    result: UtilityTransportResult,
  ): RpcResult<SessionSettingsEditorState> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'session-settings.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Session response.' } }
  }

  private static toSessionSettingsSaveResult(
    result: UtilityTransportResult,
  ): RpcResult<SessionSettingsSaveResult> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'session-settings.save.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Session response.' } }
  }

  private static toConversationPatchResult(
    result: UtilityTransportResult,
  ): RpcResult<ConversationPatch> {
    if (result.kind === 'unknown-delivery') {
      return { ok: false, error: { code: 'UNCERTAIN', message: result.error.message } }
    }
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.patch.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Conversation Patch.' } }
  }

  private static toConversationPageResult(
    result: UtilityTransportResult,
  ): RpcResult<ConversationPage> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'conversation.page.response'
      ? result.response.result
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Unexpected Conversation page response.' },
        }
  }

  private static toProjectFileResult(result: UtilityTransportResult): RpcResult<ProjectFile> {
    if (result.kind !== 'response') return { ok: false, error: result.error }
    return result.response.type === 'project-file.response'
      ? result.response.result
      : { ok: false, error: { code: 'INTERNAL', message: 'Unexpected Project file response.' } }
  }

  private finishRequest(requestId: string, result: UtilityTransportResult): void {
    const request = this.inFlightRequests.get(requestId)
    if (!request) return
    clearTimeout(request.timeout)
    const resultBody =
      result.kind === 'response' ? Reflect.get(result.response, 'result') : undefined
    const failed = result.kind !== 'response' || resultBody?.ok === false
    const candidateCode = result.kind !== 'response' ? result.error.code : resultBody?.error?.code
    this.diagnostics?.record({
      ...request.diagnostic,
      phase:
        result.kind === 'unknown-delivery' ? 'unknown_delivery' : failed ? 'failed' : 'completed',
      level: failed ? 'warn' : request.diagnostic.level,
      durationMs: Date.now() - request.startedAt,
      ...(candidateCode ? { code: candidateCode } : {}),
    })
    this.inFlightRequests.delete(requestId)
    request.resolve(result)
  }

  private failChildRequests(target: UtilityProcess, error: AppError): void {
    for (const [requestId, request] of this.inFlightRequests) {
      if (request.child !== target) continue
      this.finishRequest(requestId, ElectronUtilityProcessClient.requestFailure(request, error))
    }
  }

  private receiveResponse(source: UtilityProcess, message: unknown): void {
    let diagnosticAccepted = false
    if (this.traffic) {
      const diagnostic = diagnosticPacketSchema.safeParse(message)
      if (diagnostic.success) {
        this.traffic.record('utility-main.control', 'control', message)
        diagnosticAccepted = true
      }
    }
    if (this.diagnostics?.acceptUtility(source, message)) return
    const directory = directoryFileOperationMessageSchema.safeParse(message)
    if (directory.success) {
      this.traffic?.record('utility-main.control', 'business', message)
      if (source !== this.child) return
      if (directory.data.type === 'workspace.directory.cancel') {
        const pending = this.directoryRequests.get(directory.data.requestId)
        if (pending?.child === source) pending.controller.abort()
      } else if (directory.data.type === 'workspace.directory.request') {
        const { requestId, input } = directory.data
        if (this.directoryRequests.has(requestId)) return
        if (this.directoryRequests.size >= DIRECTORY_REQUEST_LIMIT) {
          try {
            const packet = directoryFileOperationMessageSchema.parse({
              type: 'workspace.directory.response',
              requestId,
              result: {
                ok: false,
                code: 'TOO_LARGE',
                message: 'The directory request capacity is full.',
              },
            })
            source.postMessage(packet)
            this.traffic?.record('main-utility.control', 'business', packet)
          } catch {
            this.traffic?.invalidate('transport_error')
            /* The requesting core has exited. */
          }
          return
        }
        const controller = new AbortController()
        const pending = { child: source, controller }
        this.directoryRequests.set(requestId, pending)
        void this.directoryOperations
          .execute(input, controller.signal)
          .then((result) => {
            if (this.child === source) {
              try {
                const packet = directoryFileOperationMessageSchema.parse({
                  type: 'workspace.directory.response',
                  requestId,
                  result,
                })
                source.postMessage(packet)
                this.traffic?.record('main-utility.control', 'business', packet)
              } catch {
                this.traffic?.invalidate('transport_error')
                /* A departed core cannot receive a result; its request is never forwarded to a replacement. */
              }
            }
            return undefined
          })
          .finally(() => {
            if (this.directoryRequests.get(requestId) === pending)
              this.directoryRequests.delete(requestId)
          })
      }
      return
    }
    const event = utilityEventSchema.safeParse(message)
    if (event.success) {
      this.traffic?.record(
        'utility-main.event',
        event.data.type === 'runtime.startup-failed.event' ||
          event.data.type === 'runtime.ready.event'
          ? 'control'
          : 'business',
        message,
      )
      if (this.child !== source) return
      if (event.data.type === 'runtime.startup-failed.event') {
        if (this.startupFailure) return
        this.startupFailure = event.data
        const error = this.startupFailureError()!
        this.settleStartup(source, { ok: false, error })
        for (const [requestId, request] of this.inFlightRequests) {
          if (request.child !== source) continue
          this.finishRequest(
            requestId,
            event.data.stage === 'persistence'
              ? { kind: 'not-sent', error }
              : ElectronUtilityProcessClient.requestFailure(request, error),
          )
        }
        try {
          const packet = runtimeStartupFailureAckSchema.parse({
            type: 'runtime.startup-failed.ack',
            failureId: event.data.failureId,
          })
          source.postMessage(packet)
          this.traffic?.record('main-utility.control', 'control', packet)
        } catch {
          this.traffic?.invalidate('transport_error')
          /* The retained failure remains available even when the failed child has exited. */
        }
        try {
          this.startupFailureCallback?.(event.data)
        } catch {
          this.diagnostics?.record({
            operation: 'utility',
            phase: 'failed',
            level: 'error',
            code: 'STARTUP_FAILURE_DISPLAY_FAILED',
          })
        }
        return
      }
      if (event.data.type === 'runtime.ready.event') {
        if (this.shutdownTask || this.terminatingChild) return
        this.readyChild = source
        this.startupDeadline = undefined
        this.settleStartup(source, { ok: true, value: { ready: true } })
      }
      if (event.data.type === 'native-presence.quit-recent.event') {
        for (const listener of this.nativeQuitRecentListeners)
          listener(event.data.version, event.data.sessions)
      }
      if (event.data.type === 'native-presence.changed.event') {
        for (const listener of this.nativePresenceListeners) listener(event.data.version)
      }
      if (event.data.type === 'conversation.patch.event') {
        for (const listener of this.conversationListeners)
          listener(event.data.patch, event.data.progress)
      }
      return
    }
    const parsed = utilityResponseSchema.safeParse(message)
    if (!parsed.success) {
      if (!diagnosticAccepted) this.traffic?.invalidate('unvalidated_message')
      return
    }
    this.traffic?.record(
      'utility-main.reply',
      parsed.data.type === 'runtime.health.response' ||
        parsed.data.type === 'runtime.shutdown.response'
        ? 'control'
        : 'business',
      message,
    )
    if (this.child !== source) return

    const request = this.inFlightRequests.get(parsed.data.requestId)
    if (!request || request.child !== source || request.expectedResponseType !== parsed.data.type)
      return
    this.finishRequest(parsed.data.requestId, { kind: 'response', response: parsed.data })
  }

  private startupFailureError(): AppError | undefined {
    if (!this.startupFailure) return undefined
    return {
      code: this.startupFailure.code,
      message: `Pact stopped opening its data: ${this.startupFailure.reason}. Existing data and recovery files are preserved.`,
    }
  }

  private requestDiagnostic(
    payload: UtilityRequestPayload,
    operationId: string,
  ): import('@pact/contracts').DiagnosticEvent {
    const type = payload.type
    const operation =
      type === 'conversation.send.request'
        ? 'send'
        : type === 'conversation.stop.request'
          ? 'stop'
          : type === 'conversation.retry.request'
            ? 'native_check'
            : type === 'session.fork.request'
              ? 'fork'
              : type.includes('rebuild')
                ? 'native_rebuild'
                : type.includes('undo')
                  ? 'undo'
                  : type.includes('runtime-preparation')
                    ? 'readiness'
                    : 'ipc'
    const input = 'input' in payload ? payload.input : undefined
    const sessionId =
      input && typeof input === 'object'
        ? Reflect.get(input, 'sessionId')
        : 'sessionId' in payload
          ? payload.sessionId
          : undefined
    const runId = input && typeof input === 'object' ? Reflect.get(input, 'runId') : undefined
    return {
      operation,
      operationId,
      requestType: type,
      phase: 'started',
      scope: 'request',
      level: operation === 'ipc' ? 'debug' : 'info',
      ...(diagnosticUuid(sessionId) ? { sessionId } : {}),
      ...(diagnosticUuid(runId) ? { runId } : {}),
    }
  }

  private cancelDirectoryRequests(source: UtilityProcess): void {
    for (const request of this.directoryRequests.values())
      if (request.child === source) request.controller.abort()
  }
}

export function createUtilityProcessClient(): UtilityProcessClient {
  return new ElectronUtilityProcessClient()
}
