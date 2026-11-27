import { createHash } from 'node:crypto'

import type {
  AgentNativeForkInput,
  AgentNativeForkWitness,
  AgentRunInput,
  NativePermissionRequester,
  NativeUserInputRequester,
} from '@pact/agent-runtime'
import type {
  NativeUserInputRequest,
  NormalizedAgentEvent,
  RunEffectiveExecutionSettings,
  SessionPermissionMode,
} from '@pact/contracts'

import { NATIVE_PERMISSION_REQUESTS } from '@pact/contracts'

import type {
  AgyAcpConnection,
  AgyIngress,
  AgyOrderedSessionStream,
  AgyPoolLease,
  AgySessionCloseFailureReason,
} from '../agy-acp-connection'
import type { AgyTrajectoryIdentityClientResult } from '../native-fork-files'
import type { AgyAdapterRuntime } from './adapter-runtime'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { AgentExecutionError, PermissionModeRejectedError } from '../agent-execution-error'
import {
  AGY_CONTROL_RPC_TIMEOUT_MS,
  AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
} from '../agy-acp-connection'
import { NativePermissionWait, safeNativePermissionText } from '../native-permission-wait'
import { validateAgyFrame } from './frame-validator'
import {
  agyElicitationRequest,
  buildAgyPermissionCard,
  findRejectOnceOptionId,
  parseAcpSessionDescriptor,
  parseConfigOptions,
} from './permission-and-elicitation'
import {
  AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
  AGY_SESSION_MODE_CACHE_LIMIT,
  asString,
  classifyAgyCloseFailureDiagnostic,
  classifyIdentityWorkerError,
  delayAbortable,
  identityStatusPriority,
  isPlainObject,
  type AcpConfigOptionEntry,
  type AcpSessionDescriptor,
  type SessionModeState,
} from './types'

/**
 * Deep session bootstrapper for Antigravity ACP sessions: zero-turn shell allocation,
 * session/load replay draining, mode/model/effort configuration & confirmation,
 * and host trajectory identity resolution.
 */
export class AgySessionBootstrapper {
  constructor(private readonly runtime: AgyAdapterRuntime) {}

  async loadHostTrajectoryIdentity(params: {
    resolvedSessionId: string | undefined
    cwd: string
    observationSignal: AbortSignal
    callerSignal: AbortSignal
    loadSignal: AbortSignal
  }): Promise<AgyTrajectoryIdentityClientResult> {
    const { resolvedSessionId, cwd, observationSignal, callerSignal, loadSignal } = params
    if (!resolvedSessionId) return { status: 'missing' }
    let bestNonOk: Exclude<AgyTrajectoryIdentityClientResult, { status: 'ok' }> | undefined
    for (const appDataDir of this.runtime.appDataDirs) {
      if (this.runtime.disposed || observationSignal.aborted) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }
      loadSignal.throwIfAborted()
      let identity: AgyTrajectoryIdentityClientResult | undefined
      for (let busyAttempt = 0; busyAttempt < 4; busyAttempt += 1) {
        if (this.runtime.disposed || observationSignal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        try {
          if (this.runtime.options.storageClient?.readTrajectoryIdentity) {
            // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when shared fork worker is momentarily busy.
            identity = await this.runtime.options.storageClient.readTrajectoryIdentity(
              { appDataDir, cwd, nativeSessionId: resolvedSessionId },
              loadSignal,
            )
          } else {
            // oxlint-disable-next-line no-await-in-loop -- Bounded short retry when standalone adapter fork worker is momentarily busy.
            const workerRes = await this.runtime
              .getOwnedForkFiles()
              .readAgyTrajectoryIdentity(
                { cwd, storageRoot: appDataDir, nativeSessionId: resolvedSessionId },
                loadSignal,
              )
            identity =
              workerRes.status === 'ok'
                ? {
                    status: 'ok',
                    trajectoryId: workerRes.trajectoryId,
                    stepCount: workerRes.stepCount,
                  }
                : {
                    status: workerRes.status,
                    ...(workerRes.reason !== undefined ? { reason: workerRes.reason } : {}),
                  }
          }
          break
        } catch (error) {
          if (callerSignal.aborted) throw error
          if (this.runtime.disposed || observationSignal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          if (loadSignal.aborted) {
            return {
              status: 'timeout',
              reason: 'Antigravity trajectory identity inspection exceeded its deadline.',
            }
          }
          if (
            busyAttempt < 3 &&
            error instanceof Error &&
            error.message.includes('already active')
          ) {
            // oxlint-disable-next-line no-await-in-loop -- Bounded 15ms retry for active storage worker.
            await delayAbortable(15, loadSignal)
            continue
          }
          identity = classifyIdentityWorkerError(error)
          break
        }
      }
      const resolvedIdentity: AgyTrajectoryIdentityClientResult = identity ?? {
        status: 'timeout',
        reason: 'Antigravity trajectory identity worker remained busy.',
      }
      if (resolvedIdentity.status === 'ok') return resolvedIdentity
      if (resolvedIdentity.status === 'invalid' || resolvedIdentity.status === 'budget_exceeded') {
        return resolvedIdentity
      }
      if (
        !bestNonOk ||
        identityStatusPriority(resolvedIdentity.status) > identityStatusPriority(bestNonOk.status)
      ) {
        bestNonOk = resolvedIdentity
      }
    }
    return bestNonOk ?? { status: 'no_storage_root' }
  }

  async loadHostTrajectoryIdentityBeforePrompt(params: {
    resolvedSessionId: string | undefined
    cwd: string
    observationSignal: AbortSignal
    callerSignal: AbortSignal
    loadSignal: AbortSignal
  }): Promise<AgyTrajectoryIdentityClientResult> {
    const { observationSignal, callerSignal, loadSignal } = params
    const backoffMs = [25, 50, 100, 200]
    let latest: AgyTrajectoryIdentityClientResult = { status: 'no_storage_root' }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (callerSignal.aborted) callerSignal.throwIfAborted()
      if (this.runtime.disposed || observationSignal.aborted) {
        throw new AgentExecutionError('agent_process_crash', 'Antigravity is shutting down.', false)
      }
      if (loadSignal.aborted) {
        return {
          status: 'timeout',
          reason: 'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
        }
      }
      try {
        // oxlint-disable-next-line no-await-in-loop -- Bounded backoff retry strictly for transient WAL churn before prompt.
        latest = await this.loadHostTrajectoryIdentity(params)
      } catch (error) {
        if (callerSignal.aborted) throw error
        if (this.runtime.disposed || observationSignal.aborted) {
          throw new AgentExecutionError(
            'agent_process_crash',
            'Antigravity is shutting down.',
            false,
          )
        }
        if (loadSignal.aborted) {
          return {
            status: 'timeout',
            reason: 'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
          }
        }
        return classifyIdentityWorkerError(error)
      }
      if (latest.status !== 'transient_churn') return latest
      if (attempt < backoffMs.length) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- Bounded backoff delay before retrying transient WAL churn.
          await delayAbortable(backoffMs[attempt]!, loadSignal)
        } catch (error) {
          if (callerSignal.aborted) throw error
          if (this.runtime.disposed || observationSignal.aborted) {
            throw new AgentExecutionError(
              'agent_process_crash',
              'Antigravity is shutting down.',
              false,
            )
          }
          return loadSignal.aborted
            ? {
                status: 'timeout',
                reason:
                  'Antigravity trajectory identity inspection exceeded its pre-prompt deadline.',
              }
            : latest
        }
      }
    }
    return latest
  }

  async allocateZeroTurnSessionShell(
    lease: AgyPoolLease,
    signal: AbortSignal,
    options: {
      onSessionAllocated?: (sessionId: string) => void | Promise<void>
      onCreationDispatched?: () => void
      onCreationRejectedByServer?: () => void
    } = {},
  ): Promise<string> {
    let creationDispatched = false
    const newOp = lease.connection.requestOwned(
      'session/new',
      { cwd: lease.canonicalCwd, mcpServers: [] },
      {
        timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
        signal,
        canDispatch: () => !signal.aborted && !this.runtime.disposed,
        onDispatch: () => {
          creationDispatched = true
          options.onCreationDispatched?.()
        },
      },
    )
    let newResp: object
    try {
      newResp = await newOp.result
    } catch (error) {
      if (!creationDispatched) {
        const physical = await Promise.race([
          newOp.physicalOutcome,
          new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
        ])
        if (physical !== 'not_sent') {
          options.onCreationDispatched?.()
        }
      }
      throw error
    }
    const hasResultField = Object.hasOwn(newResp, 'result')
    const hasErrorField = Object.hasOwn(newResp, 'error')
    const newError = hasErrorField ? Reflect.get(newResp, 'error') : undefined
    const newResult = hasResultField ? Reflect.get(newResp, 'result') : undefined
    if (hasErrorField) {
      const isValidatedRejection =
        !hasResultField &&
        isPlainObject(newError) &&
        typeof newError.code === 'number' &&
        Number.isSafeInteger(newError.code) &&
        typeof newError.message === 'string'
      if (isValidatedRejection) {
        options.onCreationRejectedByServer?.()
      } else {
        options.onCreationDispatched?.()
      }
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    if (!isPlainObject(newResult)) {
      options.onCreationDispatched?.()
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity failed to allocate a zero-Turn session shell.',
        false,
      )
    }
    const descriptor = parseAcpSessionDescriptor(newResult)
    let callbackFailed = false
    let callbackError: unknown
    try {
      await options.onSessionAllocated?.(descriptor.sessionId)
    } catch (err) {
      callbackFailed = true
      callbackError = err
    }
    const callerAborted = signal.aborted
    const cleanupOnly = callbackFailed || callerAborted
    const closeRes = await lease.closeSession(descriptor.sessionId, {
      timeoutMs: cleanupOnly
        ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
        : AGY_CONTROL_RPC_TIMEOUT_MS,
    })
    if (closeRes.confirmed) {
      this.runtime.sessionModes.delete(descriptor.sessionId)
    } else {
      const closeDiag = classifyAgyCloseFailureDiagnostic(closeRes.reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
      if (!cleanupOnly) {
        throw new AgentExecutionError(
          'protocol_error',
          'Antigravity failed to close the zero-Turn session shell cleanly.',
          false,
        )
      }
    }
    if (callbackFailed) {
      throw callbackError
    }
    if (callerAborted) {
      signal.throwIfAborted()
    }
    return descriptor.sessionId
  }

  registerControlOperationServerRequests(params: {
    connection: AgyAcpConnection
    ownerId: string
    initialSessionId: string | undefined
    cwd: string
    permissionMode: SessionPermissionMode
    requestPermission: NativePermissionRequester | undefined
    requestUserInput: NativeUserInputRequester | undefined
    signal: AbortSignal
  }): {
    updateSessionId: (sessionId: string | undefined) => void
    handleServerRequest: (message: object) => boolean
    dispose: () => void
  } {
    const {
      connection,
      ownerId,
      initialSessionId,
      cwd,
      permissionMode,
      requestPermission,
      requestUserInput,
      signal,
    } = params
    let currentSessionId = initialSessionId
    let activePermissionRequests = 0
    let ownerDisposed = false
    const permissionWait = new NativePermissionWait()
    const interactionControllers = new Set<AbortController>()

    const isFenceCurrent = (): boolean =>
      !this.runtime.disposed && !ownerDisposed && !signal.aborted && connection.isOpen

    const handleServerRequest = (message: object, seq = 0): boolean => {
      const method = asString(Reflect.get(message, 'method'))
      const rpcId = Reflect.get(message, 'id')
      if (
        (typeof rpcId !== 'string' && typeof rpcId !== 'number') ||
        !method ||
        (method !== 'session/request_permission' && method !== 'elicitation/create') ||
        !isPlainObject(message)
      ) {
        return false
      }
      const rawParams = Reflect.get(message, 'params')
      const paramsObjectValid = isPlainObject(rawParams)
      const reqParams = paramsObjectValid ? rawParams : {}

      // Validate control-operation requests with the same frame identity validator against the
      // expected control session identity before reaching approval or elicitation callbacks!
      const validated = validateAgyFrame(
        {
          kind: 'server_request',
          seq,
          method,
          rpcId,
          message,
        },
        currentSessionId,
        undefined,
        undefined,
      )
      const controlIdentityInvalid =
        !paramsObjectValid ||
        !validated.isAttributableToCurrentSession ||
        validated.hasForeignOrInvalidSessionMeta ||
        validated.executionIdInvalid ||
        validated.rootEvidenceContradicted ||
        validated.tokens.hasInvalidToken ||
        validated.tokens.hasConflictingTokens

      if (method === 'session/request_permission') {
        const permFrameInvalid =
          controlIdentityInvalid ||
          validated.toolCallIdInvalid ||
          validated.argsEvidence.kind === 'invalid_or_conflict' ||
          (validated.statusPresent &&
            (validated.statusInvalid ||
              validated.status === 'completed' ||
              validated.status === 'failed' ||
              validated.status === 'cancelled'))
        void (async () => {
          if (permFrameInvalid || permissionMode === 'full') {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          if (!requestPermission || activePermissionRequests >= NATIVE_PERMISSION_REQUESTS) {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          let card: ReturnType<typeof buildAgyPermissionCard>
          try {
            card = buildAgyPermissionCard(reqParams, cwd)
          } catch {
            const rejectOnce = findRejectOnceOptionId(reqParams.options)
            await connection
              .respond(
                rpcId,
                rejectOnce
                  ? { outcome: { outcome: 'selected', optionId: rejectOnce } }
                  : { outcome: { outcome: 'cancelled' } },
              )
              .catch(() => undefined)
            return
          }
          activePermissionRequests += 1
          const endConnectionWait = connection.beginPermissionWait()
          const endLocalWait = permissionWait.begin()
          const interactionAbort = new AbortController()
          interactionControllers.add(interactionAbort)
          try {
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
            const permWork = requestPermission(card.request, combinedSignal)
            void permWork.catch(() => undefined)
            const decisionId = await NativePermissionWait.decision(permWork, combinedSignal)
            if (!isFenceCurrent()) {
              if (connection.isOpen) {
                await connection
                  .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                  .catch(() => undefined)
              }
              return
            }
            const mappedResponse = card.responses.get(decisionId) ?? {
              outcome: { outcome: 'cancelled' },
            }
            await connection.respond(rpcId, mappedResponse)
            if (decisionId === 'agy-cancel' && currentSessionId) {
              await connection
                .notify('session/cancel', { sessionId: currentSessionId }, {})
                .catch(() => undefined)
            }
          } catch {
            if (connection.isOpen) {
              await connection
                .respond(rpcId, { outcome: { outcome: 'cancelled' } })
                .catch(() => undefined)
            }
          } finally {
            interactionControllers.delete(interactionAbort)
            endLocalWait()
            endConnectionWait()
            activePermissionRequests = Math.max(0, activePermissionRequests - 1)
          }
        })()
        return true
      }

      void (async () => {
        if (controlIdentityInvalid) {
          await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          return
        }
        if (!requestUserInput) {
          await connection.respond(rpcId, { action: 'decline' }).catch(() => undefined)
          return
        }
        let uiRequest: NativeUserInputRequest
        try {
          uiRequest = agyElicitationRequest(reqParams)
        } catch (error) {
          await connection
            .respondError(
              rpcId,
              error instanceof Error
                ? error.message
                : 'Unsupported Antigravity elicitation schema.',
              -32_602,
            )
            .catch(() => undefined)
          return
        }
        const endConnectionWait = connection.beginPermissionWait()
        const endLocalWait = permissionWait.begin()
        const interactionAbort = new AbortController()
        interactionControllers.add(interactionAbort)
        try {
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          const combinedSignal = AbortSignal.any([signal, interactionAbort.signal])
          const userWork = requestUserInput(uiRequest, combinedSignal)
          void userWork.catch(() => undefined)
          const decision = await NativePermissionWait.decision(userWork, combinedSignal)
          if (!isFenceCurrent()) {
            if (connection.isOpen) {
              await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
            }
            return
          }
          if (decision.action === 'accept') {
            await connection.respond(
              rpcId,
              uiRequest.kind === 'url'
                ? { action: 'accept' }
                : { action: 'accept', content: decision.values ?? {} },
            )
          } else {
            await connection.respond(rpcId, { action: decision.action })
          }
        } catch {
          if (connection.isOpen) {
            await connection.respond(rpcId, { action: 'cancel' }).catch(() => undefined)
          }
        } finally {
          interactionControllers.delete(interactionAbort)
          endLocalWait()
          endConnectionWait()
        }
      })()
      return true
    }

    const ownerHandle = connection.registerServerRequestOwner({
      ownerId,
      knownSessionId: currentSessionId,
      handler: handleServerRequest,
    })

    return {
      updateSessionId: (sessionId) => {
        currentSessionId = sessionId
        ownerHandle.updateSessionId(sessionId)
      },
      handleServerRequest,
      dispose: () => {
        if (ownerDisposed) return
        ownerDisposed = true
        for (const ctrl of interactionControllers) ctrl.abort()
        interactionControllers.clear()
        ownerHandle.dispose()
      },
    }
  }

  async sealPostLoadForkWitness(
    input: AgentNativeForkInput,
    canonicalCwd: string,
    candidateSessionId: string,
    baseWitness: AgentNativeForkWitness,
    signal: AbortSignal,
  ): Promise<AgentNativeForkWitness> {
    const provisional: AgentNativeForkWitness = {
      ...baseWitness,
      initializedAt: baseWitness.initializedAt ?? new Date().toISOString(),
      initializedPrefixHash: baseWitness.initializedPrefixHash ?? baseWitness.candidatePrefixHash,
      ...(baseWitness.initializedPrefixBytes !== undefined
        ? { initializedPrefixBytes: baseWitness.initializedPrefixBytes }
        : {}),
      initializedPrefixRecords:
        baseWitness.initializedPrefixRecords ?? baseWitness.candidatePrefixRecords,
    }
    if (!this.runtime.options.storageClient?.inspectFork) {
      return provisional
    }
    const postLoad = await this.runtime.options.storageClient.inspectFork(
      {
        ...input,
        cwd: canonicalCwd,
        nativeSessionId: candidateSessionId,
        witness: provisional,
        appDataDir: this.runtime.primaryAppDataDir,
      },
      signal,
    )
    if (postLoad.kind !== 'verified') {
      throw new AgentExecutionError(
        'context_resume_failed',
        `Antigravity Fork failed post-load physical inspection: ${postLoad.reason}`,
        false,
      )
    }
    const mergedBase = postLoad.result.witness ?? provisional
    return {
      ...mergedBase,
      initializedAt: mergedBase.initializedAt ?? provisional.initializedAt!,
      initializedPrefixHash:
        postLoad.rawHash ?? mergedBase.initializedPrefixHash ?? mergedBase.candidatePrefixHash,
      ...(postLoad.rawBytes !== undefined
        ? { initializedPrefixBytes: postLoad.rawBytes }
        : mergedBase.initializedPrefixBytes !== undefined
          ? { initializedPrefixBytes: mergedBase.initializedPrefixBytes }
          : {}),
      initializedPrefixRecords:
        postLoad.rawRecords ??
        mergedBase.initializedPrefixRecords ??
        mergedBase.candidatePrefixRecords,
    }
  }

  async verifyZeroTurnSessionLoad(
    lease: AgyPoolLease,
    sessionId: string,
    signal: AbortSignal,
    options: {
      expectReplaySteps?: boolean
      forbidToolUpdates?: boolean
      onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void
    } = {},
  ): Promise<void> {
    const connection = lease.connection
    const canonicalCwd = lease.canonicalCwd
    const stream = connection.openSessionStream(sessionId, { ordered: true })
    let sawObservedReplay = false
    let sawUserChunk = false
    let sawAgentChunk = false
    let sawForbiddenExecutionUpdate = false

    const observeReplayItem = (item: object): void => {
      const method = asString(Reflect.get(item, 'method'))
      if (method !== 'session/update') return
      const params = Reflect.get(item, 'params')
      if (!isPlainObject(params)) return
      const sid = asString(params.sessionId ?? params.session_id)
      if (sid !== undefined && sid !== sessionId) return
      const update = params.update
      if (!isPlainObject(update)) return
      sawObservedReplay = true
      const kind = asString(update.sessionUpdate)
      if (kind === 'user_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawUserChunk = true
      } else if (kind === 'agent_message_chunk') {
        const content = isPlainObject(update.content) ? asString(update.content.text) : undefined
        if (content && content.length > 0) sawAgentChunk = true
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const status = asString(update.status)
        if (
          options.forbidToolUpdates ||
          status === 'pending' ||
          status === 'in_progress' ||
          status === 'running'
        ) {
          sawForbiddenExecutionUpdate = true
        }
      }
    }

    let sessionLoaded = false
    let loadPossiblyDispatched = false
    let loadRejectedByServer = false
    let sessionClosed = false

    const recordCloseFailureDiagnostic = (reason: AgySessionCloseFailureReason) => {
      const closeDiag = classifyAgyCloseFailureDiagnostic(reason)
      recordDiagnostic({
        operation: 'native_check',
        phase: 'failed',
        level: 'warn',
        scope: 'process',
        agentId: 'agy',
        executorId: lease.connection.executorId,
        nativeMethod: 'session/close',
        failureSource: closeDiag.failureSource,
        code: closeDiag.code,
      })
    }

    let loadOp: ReturnType<AgyAcpConnection['requestOwned']> | undefined
    try {
      loadOp = connection.requestOwned(
        'session/load',
        { sessionId, cwd: canonicalCwd, mcpServers: [] },
        {
          timeoutMs: AGY_SESSION_LIFECYCLE_RPC_TIMEOUT_MS,
          signal,
          replyTo: stream,
          canDispatch: () => !signal.aborted && !this.runtime.disposed,
          onDispatch: () => {
            loadPossiblyDispatched = true
          },
        },
      )
      const loadResp = await this.runWithConcurrentReplayDrain(
        loadOp.result,
        stream,
        observeReplayItem,
        undefined,
        loadOp.requestId,
        options.onServerRequest,
      )
      const hasLoadResult = Object.hasOwn(loadResp, 'result')
      const hasLoadError = Object.hasOwn(loadResp, 'error')
      const loadError = hasLoadError ? Reflect.get(loadResp, 'error') : undefined
      const loadResult = hasLoadResult ? Reflect.get(loadResp, 'result') : undefined
      if (hasLoadError || !isPlainObject(loadResult)) {
        if (
          hasLoadError &&
          !hasLoadResult &&
          isPlainObject(loadError) &&
          typeof loadError.code === 'number' &&
          Number.isSafeInteger(loadError.code) &&
          typeof loadError.message === 'string'
        ) {
          loadRejectedByServer = true
        }
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load verification failed.',
          false,
        )
      }
      sessionLoaded = true
      if (sawForbiddenExecutionUpdate) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load unexpectedly emitted live tool execution updates.',
          false,
        )
      }
      if (options.expectReplaySteps && (!sawUserChunk || !sawAgentChunk)) {
        throw new AgentExecutionError(
          'context_resume_failed',
          'Antigravity cold session/load did not replay the expected user and assistant chunks.',
          false,
        )
      }
      const callerAborted = signal.aborted
      sessionClosed = true
      const closeRes = await lease.closeSession(sessionId, {
        timeoutMs: callerAborted
          ? Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500)
          : AGY_CONTROL_RPC_TIMEOUT_MS,
      })
      if (closeRes.confirmed) {
        this.runtime.sessionModes.delete(sessionId)
      } else {
        recordCloseFailureDiagnostic(closeRes.reason)
        if (!callerAborted) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity failed to close verified cold session.',
            false,
          )
        }
      }
      if (callerAborted) {
        signal.throwIfAborted()
      }
    } finally {
      try {
        if (!loadPossiblyDispatched && loadOp && !loadRejectedByServer && !sawObservedReplay) {
          const physical = await Promise.race([
            loadOp.physicalOutcome,
            new Promise<'still_pending'>((r) => setTimeout(() => r('still_pending'), 0)),
          ])
          if (physical !== 'not_sent') {
            loadPossiblyDispatched = true
          }
        }
        const mayBeLoaded =
          sessionLoaded || sawObservedReplay || (loadPossiblyDispatched && !loadRejectedByServer)
        if (mayBeLoaded && !sessionClosed) {
          sessionClosed = true
          const cleanupClose = await lease.closeSession(sessionId, {
            timeoutMs: Math.min(AGY_CONTROL_RPC_TIMEOUT_MS, 1_500),
          })
          if (cleanupClose.confirmed) {
            this.runtime.sessionModes.delete(sessionId)
          } else {
            recordCloseFailureDiagnostic(cleanupClose.reason)
          }
        }
      } catch {
        // Preserve the original replay verification or cancellation error.
      } finally {
        stream.close()
      }
    }
  }

  async runWithConcurrentReplayDrain(
    requestPromise: Promise<object>,
    stream: AgyOrderedSessionStream,
    onNotification: (notification: object) => void,
    onReply?: (value: object) => void,
    requestId?: number,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
  ): Promise<object> {
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: object } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          try {
            onReply?.(item.message)
          } catch (error) {
            recordObserverFailure(error)
            throw error
          }
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const drainBuffered = (): void => {
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    const tracked = (async () => {
      try {
        const value = await requestPromise
        try {
          drainBuffered()
          if (!drainState.replyObserved && !drainState.observerFailed) {
            drainState.replyObserved = true
            onReply?.(value)
          }
        } catch (error) {
          recordObserverFailure(error)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: true, value }
          drainAbort.abort()
        }
      } catch (error) {
        try {
          drainBuffered()
        } catch (obsError) {
          recordObserverFailure(obsError)
        } finally {
          drainState.settled = true
          drainState.outcome = { ok: false, error }
          drainAbort.abort()
        }
      }
    })()

    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break
        let nextItem: AgyIngress | undefined
        try {
          // oxlint-disable-next-line no-await-in-loop -- Continuous O(1) ordered drain while RPC is in flight.
          nextItem = await stream.nextIngress(undefined, drainAbort.signal)
        } catch (waitError) {
          if (drainAbort.signal.aborted) {
            break
          }
          throw waitError
        }
        if (nextItem !== undefined) {
          handleIngressItem(nextItem)
        }
        drainBuffered()
      }
      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
      }
    } finally {
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Session load ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  async *awaitControlRpcWithConcurrentDrain<TResult>(params: {
    requestPromise: Promise<TResult>
    requestId?: number | undefined
    stream: AgyOrderedSessionStream | undefined
    shiftPendingEvent: () => NormalizedAgentEvent | undefined
    setWakeup: (fn: (() => void) | undefined) => void
    onNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
  }): AsyncGenerator<NormalizedAgentEvent, TResult, void> {
    const {
      requestPromise,
      requestId,
      stream,
      shiftPendingEvent,
      setWakeup,
      onNotification,
      onServerRequest,
    } = params
    const drainAbort = new AbortController()
    const drainState: {
      settled: boolean
      outcome: { ok: true; value: TResult } | { ok: false; error: unknown } | undefined
      replyObserved: boolean
      streamEnded: boolean
      observerFailed: boolean
      observerError: unknown
    } = {
      settled: false,
      outcome: undefined,
      replyObserved: false,
      streamEnded: false,
      observerFailed: false,
      observerError: undefined,
    }
    let wakeLocal: (() => void) | undefined

    const triggerWake = (): void => {
      const fn = wakeLocal
      wakeLocal = undefined
      fn?.()
    }

    const recordObserverFailure = (error: unknown): void => {
      if (!drainState.observerFailed) {
        drainState.observerFailed = true
        drainState.observerError = error
      }
      drainState.settled = true
      drainAbort.abort()
      triggerWake()
    }

    const handleIngressItem = (item: AgyIngress): boolean => {
      if (drainState.observerFailed) return false
      if (item.kind === 'notification') {
        try {
          onNotification(item.message)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'server_request') {
        try {
          onServerRequest?.(item)
        } catch (error) {
          recordObserverFailure(error)
          throw error
        }
        return true
      }
      if (item.kind === 'reply') {
        if (requestId === undefined || item.requestId === requestId) {
          drainState.replyObserved = true
          return false
        }
        return true
      }
      drainState.streamEnded = true
      return false
    }

    const tracked = requestPromise.then(
      (value) => {
        drainState.settled = true
        drainState.outcome = { ok: true, value }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
      (error: unknown) => {
        drainState.settled = true
        drainState.outcome = { ok: false, error }
        drainAbort.abort()
        triggerWake()
        return undefined
      },
    )

    const drainBuffered = (): void => {
      if (!stream) return
      while (!drainState.observerFailed && !drainState.replyObserved && !drainState.streamEnded) {
        const item = stream.shift()
        if (!item) break
        if (!handleIngressItem(item)) break
      }
    }

    let pendingStreamNext: Promise<void> | undefined
    try {
      while (!drainState.settled && !drainState.observerFailed && !drainState.streamEnded) {
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
        if (drainState.settled || drainState.observerFailed || drainState.streamEnded) break

        const wakePromise = new Promise<void>((resolveWake) => {
          wakeLocal = resolveWake
          setWakeup(() => {
            setWakeup(undefined)
            triggerWake()
          })
        })

        if (stream && !pendingStreamNext) {
          const created = stream
            .nextIngress(undefined, drainAbort.signal)
            .then(
              (item) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                handleIngressItem(item)
                return undefined
              },
              (waitError: unknown) => {
                if (pendingStreamNext === created) pendingStreamNext = undefined
                if (!drainAbort.signal.aborted) {
                  recordObserverFailure(waitError)
                }
                return undefined
              },
            )
            .catch((obsError: unknown) => {
              recordObserverFailure(obsError)
            })
          pendingStreamNext = created
        }

        // oxlint-disable-next-line no-await-in-loop -- Concurrent init-event yield and ordered replay drain.
        await Promise.race(pendingStreamNext ? [wakePromise, pendingStreamNext] : [wakePromise])
      }

      if (!drainState.observerFailed) {
        await tracked
        await Promise.resolve()
        drainBuffered()
        let nextEvent = shiftPendingEvent()
        while (nextEvent !== undefined) {
          yield nextEvent
          nextEvent = shiftPendingEvent()
        }
      }
    } finally {
      setWakeup(undefined)
      drainAbort.abort()
    }

    if (drainState.observerFailed) {
      throw drainState.observerError
    }
    if (!drainState.outcome) {
      throw new AgentExecutionError('protocol_error', 'Control RPC ended unexpectedly.', false)
    }
    if (!drainState.outcome.ok) {
      throw drainState.outcome.error
    }
    return drainState.outcome.value
  }

  rememberSessionModeState(
    sessionId: string,
    reportedModeId: string | undefined,
  ): SessionModeState {
    const existing = this.runtime.sessionModes.get(sessionId)
    if (existing) {
      if (reportedModeId) existing.currentModeId = reportedModeId
      this.runtime.sessionModes.delete(sessionId)
      this.runtime.sessionModes.set(sessionId, existing)
      return existing
    }
    if (this.runtime.sessionModes.size >= AGY_SESSION_MODE_CACHE_LIMIT) {
      const oldestKey = this.runtime.sessionModes.keys().next().value
      if (oldestKey !== undefined) this.runtime.sessionModes.delete(oldestKey)
    }
    const currentModeId = reportedModeId ?? 'default'
    const initialNonPlanModeId = currentModeId !== 'plan' ? currentModeId : 'default'
    const state: SessionModeState = {
      initialNonPlanModeId,
      currentModeId,
      enteredPlanModeByPact: false,
    }
    this.runtime.sessionModes.set(sessionId, state)
    return state
  }

  async setAndConfirmSessionMode(
    connection: AgyAcpConnection,
    sessionId: string,
    modeId: string,
    signal: AbortSignal,
    options?: {
      sessionStream?: AgyOrderedSessionStream | undefined
      onMetadataNotification?: ((notification: object) => void) | undefined
      onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    },
  ): Promise<void> {
    const sessionStream = options?.sessionStream
    const op = connection.requestOwned(
      'session/set_mode',
      { sessionId, modeId },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          op.result,
          sessionStream,
          (note) => options?.onMetadataNotification?.(note),
          undefined,
          op.requestId,
          options?.onServerRequest,
        )
      : await op.result
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new PermissionModeRejectedError(
        `Antigravity rejected permission mode "${modeId}"${
          error ? `: ${safeNativePermissionText(JSON.stringify(error), 200)}` : '.'
        }`,
      )
    }
  }

  async configureSessionModeBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionState: SessionModeState
    sessionStream?: AgyOrderedSessionStream | undefined
    onMetadataNotification?: ((notification: object) => void) | undefined
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    readOnlyStage: boolean
    permissionMode: SessionPermissionMode
    signal: AbortSignal
  }): Promise<void> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionState,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      readOnlyStage,
      permissionMode,
      signal,
    } = params
    const drainOptions = { sessionStream, onMetadataNotification, onServerRequest }

    if (readOnlyStage) {
      if (descriptor.availableModes && !descriptor.availableModes.includes('plan')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not advertise native Plan mode required for read-only collaboration stages.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'plan', signal, drainOptions)
      sessionState.currentModeId = 'plan'
      sessionState.enteredPlanModeByPact = true
      return
    }

    // Non-read-only stage: ALWAYS retire stale `plan` mode explicitly before any prompt!
    const needsPlanRetirement =
      sessionState.enteredPlanModeByPact ||
      sessionState.currentModeId === 'plan' ||
      descriptor.currentModeId === 'plan'

    if (permissionMode === 'ask') {
      await this.setAndConfirmSessionMode(connection, sessionId, 'default', signal, drainOptions)
      sessionState.currentModeId = 'default'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'auto') {
      if (descriptor.availableModes && !descriptor.availableModes.includes('auto')) {
        throw new PermissionModeRejectedError(
          'Antigravity does not offer Auto permission mode for this session.',
        )
      }
      await this.setAndConfirmSessionMode(connection, sessionId, 'auto', signal, drainOptions)
      sessionState.currentModeId = 'auto'
      sessionState.enteredPlanModeByPact = false
      return
    }

    if (permissionMode === 'native' || permissionMode === 'full') {
      if (needsPlanRetirement) {
        const restoreMode = sessionState.initialNonPlanModeId || 'default'
        await this.setAndConfirmSessionMode(
          connection,
          sessionId,
          restoreMode,
          signal,
          drainOptions,
        )
        sessionState.currentModeId = restoreMode
        sessionState.enteredPlanModeByPact = false
      }
    }
  }

  async configureModelAndEffortBeforePrompt(params: {
    connection: AgyAcpConnection
    sessionId: string
    descriptor: AcpSessionDescriptor
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    requestedModel: string | null
    requestedEffort: string | null
    signal: AbortSignal
  }): Promise<{ model: string; effort: string | null; effortKnown: boolean }> {
    const {
      connection,
      sessionId,
      descriptor,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      requestedModel,
      requestedEffort,
      signal,
    } = params
    let configOptions = descriptor.configOptions
    let currentModelId = descriptor.currentModelId

    const drainNotifiedConfigOptions = async (
      accept?: (options: AcpConfigOptionEntry[]) => boolean,
    ): Promise<AcpConfigOptionEntry[] | undefined> => {
      if (!sessionStream) return undefined
      await Promise.resolve()
      let latest: AcpConfigOptionEntry[] | undefined
      while (true) {
        const item = sessionStream.shift()
        if (!item) break
        if (item.kind === 'server_request') {
          onServerRequest?.(item)
          continue
        }
        if (item.kind !== 'notification') continue
        onMetadataNotification(item.message)
        const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
        if (parsed && (!accept || accept(parsed))) latest = parsed
      }
      return latest
    }

    const findOption = (id: string): AcpConfigOptionEntry | undefined =>
      configOptions.find((entry) => entry.id === id)

    const initialModelOption = findOption('model')
    const declaredModelFamilies = initialModelOption?.options?.map((opt) => opt.value)
    const concreteModelMatches = (actualModelId: string): boolean => {
      if (requestedModel === null) return true
      return actualModelId === requestedModel
    }
    const isFamilyPrefixOf = (family: string, concrete: string): boolean =>
      declaredModelFamilies !== undefined &&
      declaredModelFamilies.length > 0 &&
      declaredModelFamilies.includes(family) &&
      concrete.startsWith(`${family}-`)
    const configFamilyMatchesRequested = (actualValue: string): boolean => {
      if (requestedModel === null) return true
      if (actualValue === requestedModel) return true
      return isFamilyPrefixOf(actualValue, requestedModel)
    }
    const priorModelId = descriptor.currentModelId ?? initialModelOption?.currentValue
    const didSwitchModel = requestedModel !== null && priorModelId !== requestedModel
    const isAmbiguousSharedFamilyUpdate = (notifiedModel: string): boolean =>
      didSwitchModel &&
      requestedModel !== null &&
      priorModelId !== undefined &&
      notifiedModel !== requestedModel &&
      isFamilyPrefixOf(notifiedModel, requestedModel) &&
      isFamilyPrefixOf(notifiedModel, priorModelId)
    const modelAttribution = {
      didSwitchModel,
      requestedModel,
      priorModelId,
      declaredModelFamilies,
      configFamilyMatchesRequested,
      isAmbiguousSharedFamilyUpdate,
    }

    let derivedEffortFromModelVariant: string | undefined

    if (requestedModel !== null) {
      const modelOption = initialModelOption
      const matchesConfigFamily =
        modelOption?.options?.some((opt) => opt.value === requestedModel) ?? false

      if (
        matchesConfigFamily ||
        (modelOption && !descriptor.availableModels?.includes(requestedModel))
      ) {
        let targetFamily = requestedModel
        if (
          modelOption?.options &&
          !modelOption.options.some((opt) => opt.value === requestedModel)
        ) {
          // Check whether `requestedModel` is a `<family>-<thought_level>` composite ID from `models.availableModels`.
          const matchedFamily = modelOption.options
            .map((opt) => opt.value)
            .toSorted((a, b) => b.length - a.length)
            .find((family) => requestedModel.startsWith(`${family}-`))
          if (!matchedFamily) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity does not offer model "${requestedModel}".`,
              false,
            )
          }
          targetFamily = matchedFamily
          derivedEffortFromModelVariant = requestedModel.slice(matchedFamily.length + 1)
        }
        if (modelOption?.currentValue !== targetFamily) {
          // Invalidate stale model-dependent `configOptions` BEFORE applying new model.
          configOptions = []
          configOptions = await this.setConfigOptionAndConfirm({
            connection,
            sessionId,
            configId: 'model',
            value: targetFamily,
            sessionStream,
            onMetadataNotification,
            onServerRequest,
            modelAttribution,
            signal,
          })
        }
        currentModelId = requestedModel
      } else if (descriptor.availableModels?.includes(requestedModel)) {
        const classifySetModelOptions = (
          options: AcpConfigOptionEntry[],
        ): 'match' | 'stale_prior' | 'unattributed_during_switch' | 'conflict' => {
          const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
          if (notifiedModel === undefined) {
            if (didSwitchModel) {
              return 'unattributed_during_switch'
            }
            return 'match'
          }
          if (isAmbiguousSharedFamilyUpdate(notifiedModel)) {
            return 'unattributed_during_switch'
          }
          if (configFamilyMatchesRequested(notifiedModel)) {
            return 'match'
          }
          if (
            priorModelId !== undefined &&
            (notifiedModel === priorModelId || isFamilyPrefixOf(notifiedModel, priorModelId))
          ) {
            return 'stale_prior'
          }
          return 'conflict'
        }
        if (
          didSwitchModel ||
          (modelOption?.currentValue !== undefined &&
            !configFamilyMatchesRequested(modelOption.currentValue))
        ) {
          // Invalidate stale `configOptions` from the prior model immediately on model change.
          configOptions = []
        }
        await drainNotifiedConfigOptions()
        const setModelOp = connection.requestOwned(
          'session/set_model',
          { sessionId, modelId: requestedModel },
          {
            timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
            signal,
            ...(sessionStream ? { replyTo: sessionStream } : {}),
          },
        )
        const setModelReq = setModelOp.result
        const setModelTrack: {
          matched: AcpConfigOptionEntry[] | undefined
          conflictModel: string | undefined
          replyError: AgentExecutionError | undefined
          replyHadOptions: boolean
        } = {
          matched: undefined,
          conflictModel: undefined,
          replyError: undefined,
          replyHadOptions: false,
        }
        const recordSetModelOptions = (parsed: AcpConfigOptionEntry[]): void => {
          const verdict = classifySetModelOptions(parsed)
          if (verdict === 'match') {
            setModelTrack.matched = parsed
            setModelTrack.conflictModel = undefined
          } else if (verdict === 'conflict') {
            setModelTrack.matched = undefined
            setModelTrack.conflictModel =
              parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
          }
        }
        const observeSetModelReply = (resp: object): void => {
          const rErr = Reflect.get(resp, 'error')
          const rRes = Reflect.get(resp, 'result')
          if (rErr || !isPlainObject(rRes)) return
          if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
          const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
          setModelTrack.replyHadOptions = true
          const replyOptModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
          if (replyOptModel !== undefined && !configFamilyMatchesRequested(replyOptModel)) {
            setModelTrack.replyError = new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${replyOptModel}" for requested "${requestedModel}".`,
              false,
            )
            return
          }
          setModelTrack.matched = parsedReply
          setModelTrack.conflictModel = undefined
        }
        const setModelResp = sessionStream
          ? await this.runWithConcurrentReplayDrain(
              setModelReq,
              sessionStream,
              (note) => {
                onMetadataNotification(note)
                const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
                if (parsed) recordSetModelOptions(parsed)
              },
              observeSetModelReply,
              setModelOp.requestId,
              onServerRequest,
            )
          : await setModelReq
        const err = Reflect.get(setModelResp, 'error')
        const res = Reflect.get(setModelResp, 'result')
        if (err || !isPlainObject(res)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity rejected model "${requestedModel}".`,
            false,
          )
        }
        if (!sessionStream) {
          observeSetModelReply(setModelResp)
        }
        const replyReportedModel = asString(
          Reflect.get(res, 'modelId') ?? Reflect.get(res, 'currentModelId'),
        )
        if (replyReportedModel !== undefined && !concreteModelMatches(replyReportedModel)) {
          throw new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyReportedModel}" for requested "${requestedModel}".`,
            false,
          )
        }
        if (setModelTrack.replyError) {
          throw setModelTrack.replyError
        }
        const throwIfSetModelConflict = (): void => {
          if (setModelTrack.conflictModel !== undefined) {
            throw new AgentExecutionError(
              'runtime_incompatible',
              `Antigravity silently substituted model="${setModelTrack.conflictModel}" for requested "${requestedModel}".`,
              false,
            )
          }
        }
        throwIfSetModelConflict()
        if (sessionStream) {
          await Promise.resolve()
          while (true) {
            const item = sessionStream.shift()
            if (!item) break
            if (item.kind === 'server_request') {
              onServerRequest?.(item)
              continue
            }
            if (item.kind !== 'notification') continue
            onMetadataNotification(item.message)
            const parsed = this.extractConfigOptionsFromNotification(item.message, sessionId)
            if (parsed) recordSetModelOptions(parsed)
          }
        }
        throwIfSetModelConflict()
        if (setModelTrack.replyHadOptions) {
          configOptions = setModelTrack.matched ?? []
        } else {
          let confirmedUpdated = setModelTrack.matched
          if (confirmedUpdated === undefined && sessionStream) {
            const awaited = await this.awaitPostReplyConfigOptionUpdate(
              sessionStream,
              onMetadataNotification,
              signal,
              AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
              (opts) => {
                const verdict = classifySetModelOptions(opts)
                return verdict === 'match' || verdict === 'conflict'
              },
              onServerRequest,
              sessionId,
            )
            if (awaited !== undefined) {
              if (classifySetModelOptions(awaited) === 'conflict') {
                const actualModel =
                  awaited.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
                throw new AgentExecutionError(
                  'runtime_incompatible',
                  `Antigravity silently substituted model="${actualModel}" for requested "${requestedModel}".`,
                  false,
                )
              }
              confirmedUpdated = awaited
            }
          }
          if (confirmedUpdated !== undefined) {
            configOptions = confirmedUpdated
          }
        }
        currentModelId = requestedModel
      } else if (!modelOption && !descriptor.availableModels) {
        configOptions = []
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'model',
          value: requestedModel,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
        currentModelId = requestedModel
      } else {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity does not offer model "${requestedModel}".`,
          false,
        )
      }
    }

    const trailingBeforeEffort = await drainNotifiedConfigOptions((options) => {
      const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
      if (notifiedModel === undefined) {
        if (didSwitchModel) return false
        return !(
          requestedModel !== null &&
          initialModelOption !== undefined &&
          configOptions.length === 0
        )
      }
      if (requestedModel !== null) {
        if (isAmbiguousSharedFamilyUpdate(notifiedModel)) return false
        if (configFamilyMatchesRequested(notifiedModel)) return true
        const currentFamily = findOption('model')?.currentValue
        if (
          priorModelId !== undefined &&
          (notifiedModel === priorModelId ||
            (declaredModelFamilies !== undefined &&
              declaredModelFamilies.length > 0 &&
              declaredModelFamilies.includes(notifiedModel) &&
              priorModelId.startsWith(`${notifiedModel}-`))) &&
          currentFamily !== priorModelId
        ) {
          return false
        }
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${notifiedModel}" for requested "${requestedModel}".`,
          false,
        )
      }
      return true
    })
    if (trailingBeforeEffort !== undefined) {
      configOptions = trailingBeforeEffort
    }

    const effectiveRequestedEffort = requestedEffort ?? derivedEffortFromModelVariant ?? null
    if (effectiveRequestedEffort !== null) {
      const thoughtOption = findOption('thought_level')
      if (configOptions.length > 0 && !thoughtOption) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model "${requestedModel ?? currentModelId ?? 'default'}" does not expose thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (
        thoughtOption?.options &&
        !thoughtOption.options.some((opt) => opt.value === effectiveRequestedEffort)
      ) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity model does not support thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
      if (!thoughtOption || thoughtOption.currentValue !== effectiveRequestedEffort) {
        configOptions = await this.setConfigOptionAndConfirm({
          connection,
          sessionId,
          configId: 'thought_level',
          value: effectiveRequestedEffort,
          sessionStream,
          onMetadataNotification,
          onServerRequest,
          modelAttribution,
          signal,
        })
      }
      const confirmedThought = findOption('thought_level')
      if (!confirmedThought || confirmedThought.currentValue !== effectiveRequestedEffort) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity did not confirm thought_level "${effectiveRequestedEffort}".`,
          false,
        )
      }
    }

    const finalModelOption = findOption('model')
    if (
      requestedModel !== null &&
      finalModelOption?.currentValue !== undefined &&
      !configFamilyMatchesRequested(finalModelOption.currentValue)
    ) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${finalModelOption.currentValue}" for requested "${requestedModel}".`,
        false,
      )
    }
    const finalThoughtOption = findOption('thought_level')
    const modelKnown =
      requestedModel !== null ||
      finalModelOption?.currentValue !== undefined ||
      currentModelId !== undefined
    const effortKnown =
      effectiveRequestedEffort !== null ||
      (configOptions.length > 0 &&
        (finalThoughtOption?.currentValue !== undefined || !finalThoughtOption))
    const resolvedModel =
      requestedModel ?? finalModelOption?.currentValue ?? currentModelId ?? 'agy-default'
    const resolvedEffort =
      effectiveRequestedEffort !== null
        ? effectiveRequestedEffort
        : (finalThoughtOption?.currentValue ?? null)

    return { model: resolvedModel, effort: resolvedEffort, effortKnown: modelKnown && effortKnown }
  }

  async awaitPostReplyConfigOptionUpdate(
    sessionStream: AgyOrderedSessionStream,
    onMetadataNotification: (notification: object) => void,
    signal: AbortSignal,
    windowMs = AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS,
    matches?: (options: AcpConfigOptionEntry[]) => boolean,
    onServerRequest?: (req: Extract<AgyIngress, { kind: 'server_request' }>) => void,
    sessionId?: string,
  ): Promise<AcpConfigOptionEntry[] | undefined> {
    const deadlineAt = Date.now() + windowMs
    let latest: AcpConfigOptionEntry[] | undefined
    while (true) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind === 'end') return matches ? undefined : latest
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) {
          latest = parsed
          if (!matches || matches(parsed)) return parsed
        }
      }
      if (latest !== undefined && !matches) return latest
      const remainingMs = deadlineAt - Date.now()
      if (remainingMs <= 0) return matches ? undefined : latest
      // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
      const nextItem = await sessionStream.nextIngress(remainingMs, signal).catch(() => undefined)
      if (!nextItem) {
        signal.throwIfAborted()
        return matches ? undefined : latest
      }
      if (nextItem.kind === 'server_request') {
        onServerRequest?.(nextItem)
        continue
      }
      if (nextItem.kind === 'end') return matches ? undefined : latest
      if (nextItem.kind !== 'notification') continue
      onMetadataNotification(nextItem.message)
      const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
      if (parsed) {
        latest = parsed
        if (!matches || matches(parsed)) return parsed
      }
    }
  }

  async setConfigOptionAndConfirm(params: {
    connection: AgyAcpConnection
    sessionId: string
    configId: 'model' | 'thought_level'
    value: string
    sessionStream: AgyOrderedSessionStream | undefined
    onMetadataNotification: (notification: object) => void
    onServerRequest?: ((req: Extract<AgyIngress, { kind: 'server_request' }>) => void) | undefined
    modelAttribution?: {
      didSwitchModel: boolean
      requestedModel: string | null
      priorModelId: string | undefined
      declaredModelFamilies: readonly string[] | undefined
      configFamilyMatchesRequested: (actualValue: string) => boolean
      isAmbiguousSharedFamilyUpdate: (notifiedModel: string) => boolean
    }
    signal: AbortSignal
  }): Promise<AcpConfigOptionEntry[]> {
    const {
      connection,
      sessionId,
      configId,
      value,
      sessionStream,
      onMetadataNotification,
      onServerRequest,
      modelAttribution,
      signal,
    } = params
    if (sessionStream) {
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
      }
    }
    const isStalePriorModel = (notifiedModel: string): boolean => {
      if (!modelAttribution?.priorModelId) return false
      return (
        notifiedModel === modelAttribution.priorModelId ||
        (modelAttribution.declaredModelFamilies !== undefined &&
          modelAttribution.declaredModelFamilies.length > 0 &&
          modelAttribution.declaredModelFamilies.includes(notifiedModel) &&
          modelAttribution.priorModelId.startsWith(`${notifiedModel}-`))
      )
    }
    const classifyAsyncOptions = (
      options: AcpConfigOptionEntry[],
    ): 'match' | 'other_attributed' | 'ignore' | 'conflict' => {
      if (modelAttribution) {
        const notifiedModel = options.find((opt) => opt.id === 'model')?.currentValue
        if (notifiedModel === undefined) {
          if (modelAttribution.didSwitchModel || configId === 'model') {
            return 'ignore'
          }
        } else if (modelAttribution.isAmbiguousSharedFamilyUpdate(notifiedModel)) {
          // Same-family variant switch: family-only async notifications cannot confirm either
          // `model` OR model-dependent `thought_level`!
          return 'ignore'
        } else if (
          modelAttribution.requestedModel !== null &&
          !modelAttribution.configFamilyMatchesRequested(notifiedModel)
        ) {
          return isStalePriorModel(notifiedModel) ? 'ignore' : 'conflict'
        }
      }
      return options.find((opt) => opt.id === configId)?.currentValue === value
        ? 'match'
        : 'other_attributed'
    }
    const setOptionOp = connection.requestOwned(
      'session/set_config_option',
      { sessionId, configId, value },
      {
        timeoutMs: AGY_CONTROL_RPC_TIMEOUT_MS,
        signal,
        ...(sessionStream ? { replyTo: sessionStream } : {}),
      },
    )
    const requestPromise = setOptionOp.result
    let latestAttributedOptions: AcpConfigOptionEntry[] | undefined
    let latestAttributedMatched = false
    let conflictModelDuringSet: string | undefined
    let replyError: AgentExecutionError | undefined
    let replyHadOptions = false
    const observeAsyncConfigOptions = (parsed: AcpConfigOptionEntry[]): void => {
      const verdict = classifyAsyncOptions(parsed)
      if (verdict === 'conflict') {
        conflictModelDuringSet = parsed.find((opt) => opt.id === 'model')?.currentValue ?? 'unknown'
        latestAttributedOptions = undefined
        latestAttributedMatched = false
      } else if (verdict === 'match') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = true
      } else if (verdict === 'other_attributed') {
        conflictModelDuringSet = undefined
        latestAttributedOptions = parsed
        latestAttributedMatched = false
      }
    }
    const observeReplyOptions = (resp: object): void => {
      const rErr = Reflect.get(resp, 'error')
      const rRes = Reflect.get(resp, 'result')
      if (rErr || !isPlainObject(rRes)) return
      if (!Array.isArray(Reflect.get(rRes, 'configOptions'))) return
      const parsedReply = parseConfigOptions(Reflect.get(rRes, 'configOptions'))
      replyHadOptions = true
      if (modelAttribution && modelAttribution.requestedModel !== null) {
        const replyModel = parsedReply.find((opt) => opt.id === 'model')?.currentValue
        if (
          replyModel !== undefined &&
          !modelAttribution.configFamilyMatchesRequested(replyModel)
        ) {
          replyError = new AgentExecutionError(
            'runtime_incompatible',
            `Antigravity silently substituted model="${replyModel}" for requested "${modelAttribution.requestedModel}".`,
            false,
          )
          return
        }
      }
      conflictModelDuringSet = undefined
      latestAttributedOptions = parsedReply
      latestAttributedMatched =
        parsedReply.find((opt) => opt.id === configId)?.currentValue === value
    }
    const response = sessionStream
      ? await this.runWithConcurrentReplayDrain(
          requestPromise,
          sessionStream,
          (note) => {
            onMetadataNotification(note)
            const parsed = this.extractConfigOptionsFromNotification(note, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          },
          observeReplyOptions,
          setOptionOp.requestId,
          onServerRequest,
        )
      : await requestPromise
    const error = Reflect.get(response, 'error')
    const result = Reflect.get(response, 'result')
    if (error || !isPlainObject(result)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity rejected ${configId}="${value}".`,
        false,
      )
    }
    if (!sessionStream) {
      observeReplyOptions(response)
    }
    if (replyError) {
      throw replyError
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    if (sessionStream) {
      await Promise.resolve()
      while (true) {
        const buffered = sessionStream.shift()
        if (!buffered) break
        if (buffered.kind === 'server_request') {
          onServerRequest?.(buffered)
          continue
        }
        if (buffered.kind !== 'notification') continue
        onMetadataNotification(buffered.message)
        const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
        if (parsed) observeAsyncConfigOptions(parsed)
      }
    }
    if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
        false,
      )
    }
    let updated: AcpConfigOptionEntry[]
    if (replyHadOptions) {
      updated = latestAttributedOptions ?? []
    } else {
      if (!latestAttributedMatched && sessionStream) {
        const deadlineAt = Date.now() + AGY_CONFIG_OPTION_POST_REPLY_WINDOW_MS
        while (true) {
          let sawEnd = false
          while (true) {
            const buffered = sessionStream.shift()
            if (!buffered) break
            if (buffered.kind === 'server_request') {
              onServerRequest?.(buffered)
              continue
            }
            if (buffered.kind === 'end') {
              sawEnd = true
              break
            }
            if (buffered.kind !== 'notification') continue
            onMetadataNotification(buffered.message)
            const parsed = this.extractConfigOptionsFromNotification(buffered.message, sessionId)
            if (parsed) observeAsyncConfigOptions(parsed)
          }
          if (sawEnd || conflictModelDuringSet !== undefined || latestAttributedMatched) break
          const remainingMs = deadlineAt - Date.now()
          if (remainingMs <= 0) break
          // oxlint-disable-next-line no-await-in-loop -- Bounded short wait for post-reply `config_option_update`.
          const nextItem = await sessionStream
            .nextIngress(remainingMs, signal)
            .catch(() => undefined)
          if (!nextItem) {
            signal.throwIfAborted()
            break
          }
          if (nextItem.kind === 'server_request') {
            onServerRequest?.(nextItem)
            continue
          }
          if (nextItem.kind === 'end') break
          if (nextItem.kind !== 'notification') continue
          onMetadataNotification(nextItem.message)
          const parsed = this.extractConfigOptionsFromNotification(nextItem.message, sessionId)
          if (parsed) observeAsyncConfigOptions(parsed)
        }
      }
      if (conflictModelDuringSet !== undefined && modelAttribution?.requestedModel !== null) {
        throw new AgentExecutionError(
          'runtime_incompatible',
          `Antigravity silently substituted model="${conflictModelDuringSet}" for requested "${modelAttribution?.requestedModel ?? 'unknown'}".`,
          false,
        )
      }
      updated = latestAttributedOptions ?? []
    }
    const confirmed = updated.find((opt) => opt.id === configId)
    if (confirmed && confirmed.currentValue !== undefined && confirmed.currentValue !== value) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity silently substituted ${configId}="${confirmed.currentValue}" for requested "${value}".`,
        false,
      )
    }
    if (configId === 'thought_level' && (!confirmed || confirmed.currentValue !== value)) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        `Antigravity did not confirm thought_level="${value}".`,
        false,
      )
    }
    return updated
  }

  buildEffectiveExecutionSettings(
    model: string,
    effort: string | null,
    effortKnown: boolean,
    permissionMode: SessionPermissionMode,
  ): RunEffectiveExecutionSettings | undefined {
    if (!effortKnown) {
      return undefined
    }
    const configurationSha256 = createHash('sha256')
      .update(
        JSON.stringify({
          provider: 'agy',
          model,
          effort,
          speed: 'native',
          permissionMode,
        }),
      )
      .digest('hex')

    return {
      version: 1,
      provider: 'agy',
      model,
      effort: { known: true, value: effort },
      speed: 'native',
      permissionMode,
      configurationSha256,
      provenance: 'agy_applied_settings',
    }
  }

  extractConfigOptionsFromNotification(
    notification: object,
    expectedSessionId?: string,
  ): AcpConfigOptionEntry[] | undefined {
    if (!isPlainObject(notification)) return undefined
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return undefined
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      expectedSessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'config_option_update' ||
      !validated.payload
    ) {
      return undefined
    }
    const raw = validated.payload.configOptions ?? validated.payload.options
    if (!Array.isArray(raw)) return undefined
    return parseConfigOptions(raw)
  }

  observeSessionTitleFromNotification(
    notification: object,
    sessionId: string,
    input: Pick<AgentRunInput, 'host'>,
  ): void {
    if (!isPlainObject(notification)) return
    const method = asString(Reflect.get(notification, 'method'))
    if (method !== 'session/update') return
    const validated = validateAgyFrame(
      {
        kind: 'notification',
        seq: 0,
        message: notification,
      },
      sessionId,
      undefined,
      undefined,
    )
    if (
      !validated.isAttributableToCurrentSession ||
      validated.hasForeignOrInvalidSessionMeta ||
      validated.executionIdInvalid ||
      validated.rootEvidenceContradicted ||
      validated.sessionUpdate !== 'session_info_update' ||
      !validated.payload
    ) {
      return
    }
    const title = asString(validated.payload.title)?.trim()
    if (title && title.length <= 120) {
      input.host?.lifecycle?.observeNativeTitle?.(sessionId, title)
    }
  }
}
