import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

import type { AgentShutdownSettlement } from '@pact/agent-runtime'
import type { RuntimeAgentId, SessionPermissionMode } from '@pact/contracts'

import { nativePermissionRequestSchema } from '@pact/contracts'

import { OwnedProcessGroup } from '../../owned-process-group'
import {
  AgentExecutionError,
  classifyAgentError,
  PermissionModeRejectedError,
} from '../agent-execution-error'
import {
  CodexAppServerConnection,
  type CodexConnectionDiagnostics,
} from '../codex-app-server-connection'
import { codexProcessEnvironment } from '../codex-process-environment'
import {
  exactNativeSessionScope,
  nativeApprovalDisplayFits,
  NativePermissionWait,
  safeNativePermissionText,
} from '../native-permission-wait'
import { codexQuestions, nativeElicitation } from '../native-user-input'
import {
  CODEX_FEATURE_PROBE_BYTES,
  CODEX_FEATURE_PROBE_EXIT_MS,
  CODEX_FEATURE_PROBE_TIMEOUT_MS,
  CODEX_INITIALIZATION_TIMEOUT_MS,
  CODEX_STOP_COMMANDS,
  CODEX_STOP_DISCOVERY_BYTES,
  CODEX_STOP_IDENTITY_BYTES,
  CODEX_STOP_TIMEOUT_MS,
  CODEX_THREAD_RPC_TIMEOUT_MS,
  IDLE_CONNECTION_TIMEOUT_MS,
  MAX_LOADED_THREAD_BYTES,
  MAX_LOADED_THREADS,
  codexApprovalActions,
  codexCapabilityError,
  interruptArgs,
  nativeProfileLines,
  normalizeSandboxPolicy,
  permissionReadback,
  samePermissionPolicy,
  type ApprovalItem,
  type CodexAdapterRuntime,
  type CodexConnectionManagerPort,
  type CodexRelayPermissionInput,
  type CodexRunConfiguration,
  type NativeBackground,
} from './types'

/**
 * Deep connection, process-group, permission-relay, and settings manager for Codex app-server.
 */
export class CodexConnectionManager implements CodexConnectionManagerPort {
  constructor(private readonly runtime: CodexAdapterRuntime) {}

  rememberThread(threadId: string, configuration?: CodexRunConfiguration): void {
    const value = configuration ?? this.runtime.loadedThreadConfigurations.get(threadId)
    this.runtime.loadedThreadIds.delete(threadId)
    this.runtime.loadedThreadConfigurations.delete(threadId)
    if (
      Buffer.byteLength(JSON.stringify({ threadId, configuration: value }), 'utf8') >
      MAX_LOADED_THREAD_BYTES
    )
      return
    this.runtime.loadedThreadIds.add(threadId)
    if (value) this.runtime.loadedThreadConfigurations.set(threadId, value)
    while (this.runtime.loadedThreadIds.size > MAX_LOADED_THREADS) {
      const oldest = this.runtime.loadedThreadIds.values().next().value
      if (!oldest) break
      this.runtime.loadedThreadIds.delete(oldest)
      this.runtime.loadedThreadConfigurations.delete(oldest)
    }
  }

  diagnostics(): CodexConnectionDiagnostics {
    return (
      this.runtime.connection?.diagnostics() ?? {
        pendingRequests: 0,
        pendingPhysicalRequests: 0,
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

  async closeAdapter(shutdown?: AgentShutdownSettlement): Promise<void> {
    let failure: { error: unknown } | undefined
    const attempt = async (work: () => void | Promise<unknown>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        failure ??= { error }
      }
    }
    this.runtime.skillCatalogChanged = undefined
    this.runtime.nativeCheck.cancel()
    const reader = this.runtime.nativeInspection
    reader?.controller.abort()
    const probe = this.runtime.featureProbe
    probe?.stop()
    let foregroundClosing: Promise<void> | undefined
    if (shutdown) {
      if (shutdown.foregroundSettlement) await attempt(() => shutdown.foregroundSettlement!)
      this.runtime.disposed = true
      const foreground = this.runtime.connection
      if (foreground) {
        this.detachConnection(foreground)
        foregroundClosing = this.closeConnection(foreground, new Error('Codex connection closed.'))
        // Physical closing starts at proof/cutoff, independently of reader/probe cleanup.
        void foregroundClosing.catch(() => undefined)
      }
    } else this.runtime.disposed = true
    await probe?.task.catch(() => undefined)
    await this.runtime.connectionStarting?.task.catch(() => undefined)
    if (reader) {
      await reader.task.catch(() => undefined)
      await attempt(() =>
        reader.connection?.close(new Error('Native history reader is shutting down.')),
      )
    }
    this.runtime.terminalEvidence.clear()
    this.runtime.evidenceCacheWork.release()
    for (const receipt of this.runtime.nativeRebuildReceipts.values()) {
      receipt.release?.()
      receipt.observation?.abort()
    }
    this.runtime.nativeRebuildReceipts.clear()
    await attempt(() => this.runtime.nativeForkFiles.dispose())
    for (const owner of this.runtime.nativeForkOwners.values()) owner.release()
    this.runtime.nativeForkOwners.clear()
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = undefined
    const connection = this.runtime.connection
    if (connection) this.detachConnection(connection)
    const closing = connection
      ? this.closeConnection(connection, new Error('Codex connection closed.'))
      : (foregroundClosing ?? this.runtime.closingConnection)
    if (closing) await attempt(() => closing)
    for (const background of this.runtime.nativeBackground) {
      background.unknown = true
      this.runtime.settleNativeBackground(background)
    }
    await attempt(() => this.runtime.peerToolServer.dispose())
    if (this.runtime.featureProbe)
      failure ??= {
        error: new AgentExecutionError(
          'runtime_incompatible',
          'The Codex capability probe did not confirm process exit.',
          false,
        ),
      }
    if (!failure) await attempt(() => this.runtime.nativeCheck.join())
    if (failure) throw failure.error
  }

  async relayPermission(
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
    if (input.permissionMode === 'full') {
      await connection.respondError(
        id,
        'This operation was blocked by native policy or this task’s scope. Full access does not grant additional permissions, and no tool approval was requested.',
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

  async ensureConnection(
    cwd: string,
    peerTargetAgentId?: RuntimeAgentId,
    nativeSessionId?: string,
  ): Promise<CodexAppServerConnection> {
    if (this.runtime.disposed || this.runtime.disposal)
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    const storageRoot = resolvePath(
      cwd,
      this.runtime.nativeReadOptions.storageRoot ??
        process.env['CODEX_HOME'] ??
        resolvePath(homedir(), '.codex'),
    )
    const env = codexProcessEnvironment(storageRoot)
    // A bounded digest is retained, never the environment or its credential values.
    const key = createHash('sha256')
      .update(JSON.stringify({ executable: this.runtime.executablePath, cwd, env }))
      .digest('hex')
    const loadedThreadPeer =
      nativeSessionId !== undefined
        ? this.runtime.loadedThreadConfigurations.get(nativeSessionId)?.peerTargetAgentId
        : undefined
    const loadedPeerMismatch =
      peerTargetAgentId !== undefined &&
      ((this.runtime.connectionPeerTarget !== undefined &&
        this.runtime.connectionPeerTarget !== peerTargetAgentId) ||
        (loadedThreadPeer !== undefined && loadedThreadPeer !== peerTargetAgentId))
    if (
      this.runtime.connection?.isOpen &&
      this.runtime.processCwd === cwd &&
      this.runtime.processEnvironmentKey === key &&
      !loadedPeerMismatch
    ) {
      if (peerTargetAgentId !== undefined && this.runtime.connectionPeerTarget === undefined) {
        this.runtime.connectionPeerTarget = peerTargetAgentId
      }
      return this.runtime.connection
    }
    const startingKey = peerTargetAgentId !== undefined ? `${key}:${peerTargetAgentId}` : key
    if (this.runtime.connectionStarting) {
      if (
        this.runtime.connectionStarting.key === startingKey ||
        this.runtime.connectionStarting.key === key
      ) {
        return this.runtime.connectionStarting.task
      }
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Codex is already starting with another native configuration. No new process was started.',
        false,
      )
    }
    const task = this.openConnection(cwd, storageRoot, env, key, peerTargetAgentId).finally(() => {
      if (this.runtime.connectionStarting?.task === task)
        this.runtime.connectionStarting = undefined
    })
    this.runtime.connectionStarting = { key: startingKey, task }
    return task
  }

  private async openConnection(
    cwd: string,
    storageRoot: string,
    env: NodeJS.ProcessEnv,
    environmentKey: string,
    peerTargetAgentId?: RuntimeAgentId,
  ): Promise<CodexAppServerConnection> {
    if (this.runtime.connection?.isOpen && this.runtime.hasActiveBackgroundWork())
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The native Codex connection still owns background work in its current directory.',
        false,
      )
    const previous = this.runtime.connection
    if (previous) {
      this.detachConnection(previous)
      this.runtime.peerServerName = `pact_peer_${randomUUID().replaceAll('-', '')}`
    }
    if (previous) await this.closeConnection(previous, new Error('Codex connection replaced.'))
    await this.runtime.closingConnection
    if (this.runtime.disposed)
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    this.runtime.processStorageRoot = storageRoot
    const owned = this.runtime.processFactory
      ? await this.injectedProcess(cwd)
      : await this.startProcess(cwd, this.runtime.processStorageRoot, env)
    if (this.runtime.disposed) {
      const closing = owned.close
        ? Promise.resolve().then(() => owned.close!(this.runtime.shutdownDeadlineAt))
        : Promise.resolve().then(() => {
            const connection = new CodexAppServerConnection(
              owned.child,
              undefined,
              undefined,
              this.runtime.ipcTraffic,
            )
            if (this.runtime.shutdownDeadlineAt !== undefined)
              connection.capShutdownDeadline(this.runtime.shutdownDeadlineAt)
            return connection.close(new Error('Injected Codex process arrived during disposal.'))
          })
      this.runtime.closingConnection = closing
      await closing
      if (this.runtime.closingConnection === closing) this.runtime.closingConnection = undefined
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    }
    const child = owned.child
    this.runtime.connectionProcess = child
    const connection = new CodexAppServerConnection(
      child,
      () => {
        this.detachConnection(connection)
        void this.closeConnection(connection, new Error('Codex connection closed.'))
      },
      owned.close,
      this.runtime.ipcTraffic,
      () => !this.runtime.disposed,
      undefined,
      (signal, physicalCompletion) =>
        this.runtime.nativeCheck.observeRequest(signal, physicalCompletion),
    )
    connection.setSkillChangeListener(() => this.runtime.skillCatalogChanged?.())
    this.runtime.connection = connection
    this.runtime.latestExecutorId = connection.executorId
    this.runtime.processCwd = cwd
    this.runtime.processEnvironmentKey = environmentKey
    this.runtime.initialized = false
    this.runtime.turnSpeedOverrideSupported = false
    this.runtime.nativeSourceContextSupported = false
    this.runtime.retiredNativeTurns.clear()
    this.runtime.retiredNativeChildren.clear()
    this.runtime.loadedThreadIds.clear()
    this.runtime.loadedThreadConfigurations.clear()
    this.runtime.connectionPeerTarget = peerTargetAgentId
    return connection
  }

  async resolveTurnSpeed(
    connection: CodexAppServerConnection,
    speed: 'native' | 'standard' | 'fast',
    model: string | undefined,
    signal: AbortSignal,
    acceptanceDeadline: number,
  ): Promise<{ serviceTier?: 'default' | 'priority'; detail?: string }> {
    if (speed === 'native') return {}
    if (!this.runtime.turnSpeedOverrideSupported)
      return {
        detail:
          'This Codex version cannot safely override speed for one execution. Native speed is unchanged; update Codex to select Standard or Fast.',
      }
    if (speed === 'standard') return { serviceTier: 'default' }
    if (!model)
      return {
        serviceTier: 'default',
        detail:
          'The native model could not be confirmed for Fast. Continuing at standard speed with the same model and effort.',
      }
    const controller = new AbortController()
    const observed = AbortSignal.any([signal, controller.signal])
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(10_000, acceptanceDeadline - Date.now())),
    )
    let cursor: string | undefined
    let items = 0
    let bytes = 0
    try {
      do {
        // Uncached ordered pages, owned by this Run's existing connection. The
        // catalog is capability evidence, never proof of provider entitlement.
        // oxlint-disable-next-line no-await-in-loop
        const page = await connection.request(
          'model/list',
          { limit: 25, includeHidden: true, ...(cursor ? { cursor } : {}) },
          { timeoutMs: Math.max(1, acceptanceDeadline - Date.now()), signal: observed },
        )
        const result = Reflect.get(page, 'result')
        const data = result && typeof result === 'object' ? Reflect.get(result, 'data') : null
        const next = result && typeof result === 'object' ? Reflect.get(result, 'nextCursor') : null
        if (
          Reflect.get(page, 'error') ||
          !Array.isArray(data) ||
          data.length > 25 ||
          (next != null && (typeof next !== 'string' || next.length > 8192 || next === cursor))
        )
          throw new Error('Codex did not provide a bounded service-tier catalog.')
        for (const entry of data) {
          bytes += Buffer.byteLength(JSON.stringify(entry))
          if (++items > 200 || bytes > 256 * 1024 || !entry || typeof entry !== 'object')
            throw new Error('Codex service-tier catalog exceeded its bounded read.')
          if (Reflect.get(entry, 'model') !== model && Reflect.get(entry, 'id') !== model) continue
          const tiers = Reflect.get(entry, 'serviceTiers')
          const supported =
            Array.isArray(tiers) &&
            tiers.length <= 16 &&
            tiers.some(
              (tier) =>
                tier &&
                typeof tier === 'object' &&
                Reflect.get(tier, 'id') === 'priority' &&
                Reflect.get(tier, 'name') === 'Fast',
            )
          return supported
            ? { serviceTier: 'priority' }
            : {
                serviceTier: 'default',
                detail:
                  'This model does not advertise a native Fast service tier. Continuing at standard speed with the same model and effort.',
              }
        }
        cursor = next ?? undefined
      } while (cursor)
      return {
        serviceTier: 'default',
        detail:
          'The native model catalog could not confirm Fast compatibility. Continuing at standard speed.',
      }
    } catch {
      signal.throwIfAborted()
      return {
        serviceTier: 'default',
        detail:
          'Native Fast availability could not be checked before dispatch. Continuing at standard speed.',
      }
    } finally {
      clearTimeout(timeout)
      controller.abort()
    }
  }

  async initializeConnection(
    connection: CodexAppServerConnection,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.runtime.initialized) return
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
    try {
      if (signal.aborted || this.runtime.disposed || this.runtime.connection !== connection)
        throw new AgentExecutionError(
          'agent_process_crash',
          'Codex initialization was cancelled before acknowledgement.',
          false,
        )
      await connection.notify('initialized', {}, { signal })
      const userAgent = Reflect.get(Reflect.get(response, 'result') ?? {}, 'userAgent')
      // 0.159.2 is the first installed version whose stable generated schema
      // proves serviceTierForTurn. Older/unknown actors keep their native tier;
      // using serviceTier instead would silently change subsequent Native runs.
      // Our child-only originator override also changes this prefix to "pact".
      const version =
        typeof userAgent === 'string'
          ? /^(?:pact|Codex [^/\r\n]{1,64}|codex_cli_rs)\/(\d+)\.(\d+)\.(\d+)(?:\s|$|\+)/u.exec(
              userAgent,
            )
          : null
      this.runtime.turnSpeedOverrideSupported = Boolean(
        version &&
        (Number(version[1]) > 0 ||
          Number(version[2]) > 159 ||
          (Number(version[2]) === 159 && Number(version[3]) >= 2)),
      )
      // Only an observed Native generation proves immutable request-level Thread/Turn
      // metadata. 0.167.0 retains that contract; keep the list exact rather than a range.
      // Unknown versions select legacy before dispatch; a refused new request is never retried.
      this.runtime.nativeSourceContextSupported = Boolean(
        version &&
        version[1] === '0' &&
        ((version[2] === '163' && version[3] === '0') ||
          (version[2] === '167' && version[3] === '0')),
      )
      this.runtime.initialized = true
    } catch (error) {
      // A cancelled acknowledgement cannot leave a half-initialized actor reusable.
      await this.closeConnection(
        connection,
        error instanceof Error ? error : new Error('Codex initialization acknowledgement failed.'),
      )
      throw error
    }
  }

  detachConnection(connection: CodexAppServerConnection): void {
    if (this.runtime.connection !== connection) return
    this.runtime.connection = undefined
    this.runtime.connectionProcess = undefined
    this.runtime.processStorageRoot = undefined
    this.runtime.processCwd = undefined
    this.runtime.processEnvironmentKey = undefined
    this.runtime.initialized = false
    this.runtime.turnSpeedOverrideSupported = false
    this.runtime.nativeSourceContextSupported = false
    this.runtime.loadedThreadIds.clear()
    this.runtime.loadedThreadConfigurations.clear()
    this.runtime.connectionPeerTarget = undefined
    for (const receipt of this.runtime.nativeRebuildReceipts.values()) {
      if (receipt.executorId !== connection.executorId) continue
      // Actual transport release is not initialization completion evidence.
      receipt.pending = false
      receipt.release?.()
      receipt.observation?.abort()
      delete receipt.release
      delete receipt.observation
      delete receipt.interactions
    }
    for (const background of this.runtime.nativeBackground) {
      if (background.connection !== connection) continue
      background.unknown = true
      if (!background.rootTerminal && !background.rootNotStarted && background.primaryThreadId)
        background.input.host?.lifecycle?.recordNativeEvidence?.({
          kind: 'no_evidence',
          identity: this.runtime.runIdentity(
            background.input,
            background.primaryThreadId,
            background.primaryTurnId,
          ),
          reason: 'The native executor connection closed without a matching terminal receipt.',
        })
      background.release?.()
      void Promise.allSettled(background.recordings).then(() =>
        this.runtime.settleNativeBackground(background),
      )
    }
  }

  closeConnection(connection: CodexAppServerConnection, error: Error): Promise<void> {
    if (this.runtime.closingConnection) return this.runtime.closingConnection
    // Defer close by one microtask: an internally initiated close invokes onClosed
    // before its shutdown Promise is installed.
    const closing = Promise.resolve().then(() => connection.close(error))
    this.runtime.closingConnection = closing
    void closing.then(
      () => {
        if (this.runtime.closingConnection === closing) this.runtime.closingConnection = undefined
        return undefined
      },
      () => undefined,
    )
    return closing
  }

  scheduleIdleDisconnect(): void {
    if (!this.runtime.connection || this.runtime.disposed || this.runtime.hasActiveBackgroundWork())
      return
    clearTimeout(this.runtime.idleTimer)
    this.runtime.idleTimer = setTimeout(() => {
      this.runtime.idleTimer = undefined
      const connection = this.runtime.connection
      if (connection)
        void this.closeConnection(
          connection,
          new Error('Codex connection closed after being idle.'),
        )
    }, IDLE_CONNECTION_TIMEOUT_MS)
  }

  async interruptForegroundCommands(
    background: NativeBackground,
    connection: CodexAppServerConnection,
    threadId: string,
    turnId: string,
    commands: Map<string, string | undefined>,
    stopSignal?: AbortSignal,
    terminalsOnly = false,
  ): Promise<void> {
    const interruptingChild =
      threadId !== background.primaryThreadId ? { threadId, turnId, terminal: false } : undefined
    if (interruptingChild && background.interruptingChild)
      throw new Error('An exact Codex child interruption is already pending.')
    if (interruptingChild) background.interruptingChild = interruptingChild
    const deadline = new AbortController()
    const expiresAt = Date.now() + CODEX_STOP_TIMEOUT_MS
    const timer = setTimeout(() => deadline.abort(), CODEX_STOP_TIMEOUT_MS)
    const signal = AbortSignal.any([
      deadline.signal,
      background.observation.signal,
      ...(stopSignal ? [stopSignal] : []),
    ])
    const current = (): boolean =>
      !signal.aborted &&
      !this.runtime.disposed &&
      !background.closed &&
      this.runtime.connection === connection &&
      background.connection === connection &&
      connection.isOpen &&
      ((background.primaryThreadId === threadId && background.primaryTurnId === turnId) ||
        (background.threads.has(threadId) && background.turns.get(threadId) === turnId))
    const childEnded = (): boolean =>
      Boolean(interruptingChild?.terminal) &&
      background.interruptingChild === interruptingChild &&
      background.turns.get(threadId) === turnId &&
      !deadline.signal.aborted &&
      !stopSignal?.aborted &&
      !this.runtime.disposed &&
      this.runtime.connection === connection &&
      background.connection === connection &&
      connection.isOpen
    const request = async (method: string, params: object): Promise<object | undefined> => {
      if (!current()) throw new Error('Native interruption ownership is no longer current.')
      let response: object
      try {
        response = await connection.request(method, params, {
          timeoutMs: Math.max(1, Math.min(2_000, expiresAt - Date.now())),
          signal,
          canDispatch: current,
        })
      } catch (error) {
        // The last exact child terminal closes its observation before the ACK.
        // This is independent ending evidence, not a fabricated acknowledgement.
        if (method === 'turn/interrupt' && background.observation.signal.aborted && childEnded())
          return undefined
        throw error
      }
      if (
        Object.hasOwn(response, 'error') ||
        (!current() && !(method === 'turn/interrupt' && childEnded()))
      )
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
      if (!terminalsOnly) await request('turn/interrupt', { threadId, turnId })
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
        if (!response) throw new Error('Native terminal discovery returned no acknowledgement.')
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
        const result = response && Reflect.get(response, 'result')
        if (
          !result ||
          typeof result !== 'object' ||
          typeof Reflect.get(result, 'terminated') !== 'boolean'
        )
          throw new Error('Native command termination returned an invalid acknowledgement.')
        // Only real item/turn receipts can release effects and record an ending.
      }
    } finally {
      if (background.interruptingChild === interruptingChild)
        background.interruptingChild = undefined
      clearTimeout(timer)
      deadline.abort()
      handles.clear()
      processes.clear()
      cursors.clear()
    }
  }

  async injectedProcess(cwd: string): Promise<{
    child: ChildProcessWithoutNullStreams
    close: ((deadlineAt?: number) => Promise<void>) | undefined
    physicalWitness?: (
      ownerId: string,
    ) => Promise<import('@pact/contracts').DecisionPhysicalWitness>
  }> {
    const supplied = await this.runtime.processFactory!(cwd)
    return 'child' in supplied ? supplied : { child: supplied, close: undefined }
  }

  async startProcess(
    cwd: string,
    storageRoot?: string,
    env = codexProcessEnvironment(storageRoot),
  ): Promise<{
    child: ChildProcessWithoutNullStreams
    close: (deadlineAt?: number) => Promise<void>
    physicalWitness: (ownerId: string) => Promise<import('@pact/contracts').DecisionPhysicalWitness>
  }> {
    const isWindowsCommand =
      process.platform === 'win32' && /\.cmd$/iu.test(this.runtime.executablePath)
    if (isWindowsCommand && /[&|<>^%!"\r\n]/u.test(this.runtime.executablePath)) {
      throw new AgentExecutionError('runtime_incompatible', 'Unsafe Codex executable path.', false)
    }
    const target = isWindowsCommand
      ? (process.env.ComSpec ?? 'cmd.exe')
      : this.runtime.executablePath
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
          ? ['/d', '/s', '/c', `""${this.runtime.executablePath}" ${runtimeArgs.join(' ')}"`]
          : runtimeArgs,
        options,
      )
    const runtimeArgs = await this.discoverInterruptArgs(launch)
    if (this.runtime.disposed)
      throw new AgentExecutionError('agent_process_crash', 'Codex is shutting down.', false)
    const processGroup = new OwnedProcessGroup({ startupObservationMs: 2_000 })
    const child = processGroup.spawn(
      target,
      isWindowsCommand
        ? ['/d', '/s', '/c', `""${this.runtime.executablePath}" ${runtimeArgs.join(' ')}"`]
        : runtimeArgs,
      { cwd, env, windowsHide: true, windowsVerbatimArguments: isWindowsCommand },
    )
    return {
      child,
      close: (deadlineAt) => processGroup.close(deadlineAt),
      physicalWitness: (ownerId) => processGroup.physicalWitness(ownerId),
    }
  }

  private discoverInterruptArgs(
    launch: (args: string[]) => ChildProcessWithoutNullStreams,
  ): Promise<string[]> {
    if (this.runtime.featureProbe)
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
        if (this.runtime.featureProbe?.task === task) this.runtime.featureProbe = undefined
        if (finished) return
        finished = true
        if (failure) reject(failure)
        else if (code !== 0 || signal)
          reject(
            codexCapabilityError('Codex native interruption capabilities could not be verified.'),
          )
        else {
          try {
            resolve(interruptArgs(stdout + decoder.decode()))
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
    this.runtime.featureProbe = { stop: () => stop(), task }
    return task
  }

  async pactToolConfig(
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
    if (
      servers &&
      typeof servers === 'object' &&
      Object.hasOwn(servers, this.runtime.peerServerName)
    )
      this.runtime.peerServerName = `pact_peer_${randomUUID().replaceAll('-', '')}`
    this.runtime.connectionPeerTarget = this.runtime.currentPeerTarget
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
        [`mcp_servers.${this.runtime.peerServerName}`]: {
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

  async applyPermissionSettings(
    connection: CodexAppServerConnection,
    threadId: string,
    policy: object | undefined,
    signal: AbortSignal,
    resumed?: object,
  ): Promise<object> {
    if (signal.aborted)
      throw new AgentExecutionError(
        'user_stopped',
        'Permission update was cancelled. No task was submitted.',
        false,
      )
    if (!policy && process.platform === 'win32')
      policy = await this.runtime.lifecycle.readWindowsDefaultPermissionSettings(
        connection,
        threadId,
        signal,
      )
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
      samePermissionPolicy(
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
      return permissionReadback(resumed)
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
      if (observedSignal.aborted || !samePermissionPolicy(actual, policy))
        throw new PermissionModeRejectedError(
          observedSignal.aborted
            ? 'Codex did not return a permission confirmation before the check ended. No task was submitted; the original native session was kept.'
            : 'Codex returned permissions that did not match the requested policy. No task was submitted; the original native session was kept.',
        )
      return {
        approvalPolicy: Reflect.get(actual!, 'approvalPolicy'),
        approvalsReviewer: Reflect.get(actual!, 'approvalsReviewer'),
        sandboxPolicy: normalizeSandboxPolicy(Reflect.get(actual!, 'sandboxPolicy')),
        permissionProfile:
          Reflect.get(Reflect.get(actual!, 'activePermissionProfile') ?? {}, 'id') ?? null,
      }
    } finally {
      release?.()
      clearTimeout(deadline)
      observedSignal.removeEventListener('abort', aborted)
      settle(undefined)
    }
  }
}
