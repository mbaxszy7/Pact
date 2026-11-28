import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import {
  AGY_STORAGE_MAX_ERROR_BYTES,
  agyRebuildSeedResultSchema,
  agyStorageInitMessageSchema,
  agyStorageJobKeySchema,
  agyStoragePortCandidateCommittedMessageSchema,
  agyStoragePortCandidateMessageSchema,
  agyStoragePortErrorMessageSchema,
  agyStoragePortRequestMessageSchema,
  agyStoragePortResultAckMessageSchema,
  agyStoragePortResultMessageSchema,
  nativeForkWitnessSchema,
  type AgyStorageInitMessage,
  type AgyStorageJobKey,
  type AgyStoragePortRequestMessage,
  type AgyStorageRequestPayload,
  type AgyStorageResultByAction,
} from '@pact/contracts'

import { AgentExecutionError } from './conversation/agent-execution-error'
import {
  confirmAgyRebuildColdLoad,
  executeAgyFork,
  inspectAgyFork,
  inspectAgyTrajectory,
  prepareAgyFork,
  readAgyTrajectoryIdentityDetailed,
  resolveStorageRoot,
  verifyAgyRebuildSeed,
  withAgyTempStagingRoot,
  writeAgyRebuildSeed,
  type AgyForkOperationResult,
} from './conversation/agy-native-storage'
import { measureNativeWorkerReply } from './conversation/native-json-encoder'

const INIT_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 10_000
const RESULT_ACK_TIMEOUT_MS = 1_000
const EXIT_FLUSH_FALLBACK_MS = 100

interface ChildPort {
  onMessage(listener: (message: unknown) => void): void
  offMessage(listener: (message: unknown) => void): void
  postMessage(message: unknown): Promise<void>
  close(): void
}

function sameJobKey(left: AgyStorageJobKey, right: AgyStorageJobKey): boolean {
  return (
    left.version === right.version &&
    left.generation === right.generation &&
    left.requestId === right.requestId
  )
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    )
  }
  return value
}

function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(value)))
    .digest('hex')
}

function boundUtf8Message(raw: string, maxBytes: number): string {
  const normalized = raw.trim() || 'Antigravity isolated storage operation failed.'
  if (Buffer.byteLength(normalized, 'utf8') <= maxBytes) return normalized
  let end = Math.min(normalized.length, maxBytes)
  while (end > 1 && Buffer.byteLength(normalized.slice(0, end), 'utf8') > maxBytes) {
    end -= 1
  }
  const sliced = normalized.slice(0, end)
  return sliced.length > 0 ? sliced : 'Antigravity isolated storage operation failed.'
}

function buildForkCandidateWitness(
  request: Extract<AgyStorageRequestPayload, { action: 'fork' }>,
  candidate: AgyForkOperationResult,
) {
  return nativeForkWitnessSchema.parse({
    version: 'pact-native-fork-v1',
    provider: 'agy',
    nativeSessionId: candidate.nativeSessionId,
    sourceNativeSessionId: request.source.nativeSessionId,
    sourceCutId: request.source.nativeCutId,
    sourceTrajectoryId: candidate.sourceTrajectoryId ?? request.source.agyCut?.trajectoryId,
    candidateTrajectoryId: candidate.trajectoryId,
    cutStepIdx: candidate.cutStep,
    agyCut: candidate.agyCut,
    sourcePrefixHash: request.source.prefixHash,
    candidatePrefixHash: candidate.prefixHash,
    idMap: candidate.idMap,
    candidatePrefixRecords: candidate.rawRecords,
    ...(candidate.nativeStorageRoot ? { nativeStorageRoot: candidate.nativeStorageRoot } : {}),
    ...(candidate.nativePath ? { nativePath: candidate.nativePath } : {}),
    model: request.model ?? null,
    effort: request.effort ?? null,
    permissionMode: request.permissionMode ?? 'ask',
  })
}

async function sendPortMessage(
  port: ChildPort,
  payload: Record<string, unknown>,
  measure: boolean,
): Promise<void> {
  if (measure) {
    const ipcMeasurement = await measureNativeWorkerReply(payload)
    await port.postMessage({ ...payload, ipcMeasurement })
  } else {
    await port.postMessage(payload)
  }
}

function bindValidatedPrivateTempDir(tempStagingDir: string | undefined): void {
  if (tempStagingDir === undefined) return
  const candidate = tempStagingDir.trim()
  if (candidate.length === 0 || !isAbsolute(candidate)) {
    delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
    throw new Error('Antigravity storage tempStagingDir must be an absolute path.')
  }
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(candidate)
  } catch {
    delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
    throw new Error('Antigravity storage tempStagingDir is inaccessible.')
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
    throw new Error('Antigravity storage tempStagingDir must be an ordinary directory.')
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0) {
      delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
      throw new Error('Antigravity storage tempStagingDir must have private 0o700 permissions.')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      delete process.env['PACT_AGY_PRIVATE_TEMP_DIR']
      throw new Error('Antigravity storage tempStagingDir must be owned by the current user.')
    }
  }
  process.env['PACT_AGY_PRIVATE_TEMP_DIR'] = candidate
}

async function executeAction(
  request: AgyStoragePortRequestMessage,
  port: ChildPort,
  signal: AbortSignal,
): Promise<AgyStorageResultByAction[AgyStorageRequestPayload['action']]> {
  const { input, deadlineAt, jobKey } = request
  const measure = request.measure === true

  bindValidatedPrivateTempDir(input.tempStagingDir)

  return withAgyTempStagingRoot(input.tempStagingDir, async () => {
    if (input.action === 'read-agy-trajectory-identity') {
      const storageRoot = resolveStorageRoot(input.storageRoot)
      const identity = readAgyTrajectoryIdentityDetailed({
        appDataDir: storageRoot,
        nativeSessionId: input.nativeSessionId,
        signal,
        deadlineAt,
      })
      return { nativeSessionId: input.nativeSessionId, ...identity }
    }

    if (input.action === 'exists') {
      const inspected = inspectAgyTrajectory({
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        signal,
        deadlineAt,
      })
      return { nativeSessionId: input.nativeSessionId, exists: inspected.exists }
    }

    if (input.action === 'inspect-agy-run') {
      return inspectAgyTrajectory({
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
        ...(input.includePlan !== undefined ? { includePlan: input.includePlan } : {}),
        signal,
        deadlineAt,
      })
    }

    if (input.action === 'rebuild_seed') {
      const rebuildInput: Parameters<typeof writeAgyRebuildSeed>[0] & {
        stagingLeafName?: string
      } = {
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        rebuildId: input.rebuildId,
        ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
        chunks: input.rebuildChunks,
        ...(input.rebuildImages ? { images: input.rebuildImages } : {}),
        ...(input.stagingLeafName ? { stagingLeafName: input.stagingLeafName } : {}),
        signal,
        deadlineAt,
      }
      return agyRebuildSeedResultSchema.parse(writeAgyRebuildSeed(rebuildInput))
    }

    if (input.action === 'verify-agy-seed') {
      return agyRebuildSeedResultSchema.parse(
        verifyAgyRebuildSeed({
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId,
          ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
          rebuildId: input.rebuildId,
          ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
          chunks: input.rebuildChunks,
          ...(input.rebuildImages ? { images: input.rebuildImages } : {}),
          ...(input.expectedSeedHash ? { expectedSeedHash: input.expectedSeedHash } : {}),
          ...(input.expectedTrajectoryId
            ? { expectedTrajectoryId: input.expectedTrajectoryId }
            : {}),
          ...(input.expectedPbSha256 ? { expectedPbSha256: input.expectedPbSha256 } : {}),
          ...(input.expectedPbBytes !== undefined
            ? { expectedPbBytes: input.expectedPbBytes }
            : {}),
          ...(input.expectedVerifiedPrefixSha256
            ? { expectedVerifiedPrefixSha256: input.expectedVerifiedPrefixSha256 }
            : {}),
          ...(input.expectedVerifiedPrefixBytes !== undefined
            ? { expectedVerifiedPrefixBytes: input.expectedVerifiedPrefixBytes }
            : {}),
          ...(input.expectedRecordCount !== undefined
            ? { expectedRecordCount: input.expectedRecordCount }
            : {}),
          ...(input.rejectAdditionalWork !== undefined
            ? { rejectAdditionalWork: input.rejectAdditionalWork }
            : {}),
          signal,
          deadlineAt,
        }),
      )
    }

    if (input.action === 'confirm-agy-rebuild-cold-load') {
      return confirmAgyRebuildColdLoad({
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        ...(input.appDataDir ? { appDataDir: input.appDataDir } : {}),
        sourceHash: input.sourceHash,
        pbSha256: input.pbSha256,
        pbBytes: input.pbBytes,
        stepCount: 2,
        signal,
        deadlineAt,
      })
    }

    if (input.action === 'prepare') {
      return prepareAgyFork({
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
        ...(input.responseHash ? { responseHash: input.responseHash } : {}),
        ...(input.lastDispatchedPhase ? { lastDispatchedPhase: input.lastDispatchedPhase } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        signal,
        deadlineAt,
      })
    }

    if (input.action === 'inspect') {
      return inspectAgyFork({
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
        ...(input.responseHash ? { responseHash: input.responseHash } : {}),
        ...(input.lastDispatchedPhase ? { lastDispatchedPhase: input.lastDispatchedPhase } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.witness ? { witness: input.witness } : {}),
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        signal,
        deadlineAt,
      })
    }

    if (input.action === 'read') {
      const forkInput = {
        cwd: input.cwd,
        nativeSessionId: input.nativeSessionId,
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
        ...(input.responseHash ? { responseHash: input.responseHash } : {}),
        ...(input.lastDispatchedPhase ? { lastDispatchedPhase: input.lastDispatchedPhase } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.witness ? { witness: input.witness } : {}),
        ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
        signal,
        deadlineAt,
      }
      return input.witness ? inspectAgyFork(forkInput) : prepareAgyFork(forkInput)
    }

    // input.action === 'fork'
    const forkInput: Parameters<typeof executeAgyFork>[0] & { stagingLeafName?: string } = {
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId,
      candidateNativeSessionId: input.candidateNativeSessionId,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
      ...(input.responseHash ? { responseHash: input.responseHash } : {}),
      ...(input.lastDispatchedPhase ? { lastDispatchedPhase: input.lastDispatchedPhase } : {}),
      source: input.source,
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      ...(input.stagingLeafName ? { stagingLeafName: input.stagingLeafName } : {}),
      signal,
      deadlineAt,
    }
    return executeAgyFork(
      forkInput,
      input.awaitCandidateCommit
        ? async (candidate) => {
            if (signal.aborted || Date.now() >= deadlineAt) {
              throw new Error('Antigravity Fork candidate commit was cancelled before publish.')
            }
            const witness = buildForkCandidateWitness(input, candidate)
            const witnessDigest = sha256CanonicalJson(witness)
            const candidateMsg = agyStoragePortCandidateMessageSchema.parse({
              type: 'candidate',
              jobKey,
              candidateNativeSessionId: candidate.nativeSessionId,
              witnessDigest,
              witness,
              candidate,
            })

            const ackPromise = new Promise<void>((resolve, reject) => {
              let settled = false
              const cleanup = (): void => {
                port.offMessage(onMessage)
                signal.removeEventListener('abort', onAbort)
                clearTimeout(timer)
              }
              const finish = (err?: Error): void => {
                if (settled) return
                settled = true
                cleanup()
                if (err) reject(err)
                else resolve()
              }
              const onAbort = (): void =>
                finish(new Error('Antigravity Fork candidate commit was cancelled.'))
              const onMessage = (message: unknown): void => {
                const parsed = agyStoragePortCandidateCommittedMessageSchema.safeParse(message)
                if (!parsed.success) {
                  finish(new Error('Invalid Fork candidate_committed acknowledgement.'))
                  return
                }
                if (
                  !sameJobKey(parsed.data.jobKey, jobKey) ||
                  parsed.data.candidateNativeSessionId !== candidate.nativeSessionId ||
                  parsed.data.witnessDigest !== witnessDigest
                ) {
                  finish(new Error('Mismatched Fork candidate_committed acknowledgement.'))
                  return
                }
                if (!parsed.data.committed) {
                  finish(new Error('Candidate persistence was rejected before atomic publish.'))
                  return
                }
                finish()
              }
              const remainingMs = Math.max(0, deadlineAt - Date.now())
              const timer = setTimeout(
                () => finish(new Error('Antigravity Fork candidate commit timed out.')),
                remainingMs,
              )
              signal.addEventListener('abort', onAbort, { once: true })
              port.onMessage(onMessage)
            })

            await sendPortMessage(port, candidateMsg, measure)
            await ackPromise
          }
        : undefined,
    )
  })
}

async function sendTerminalAndAwaitAck(
  port: ChildPort,
  expectedJobKey: AgyStorageJobKey,
  payload: Record<string, unknown>,
  measure: boolean,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted || timeoutMs <= 0) {
    await sendPortMessage(port, payload, measure)
    return
  }
  let cleanupAck: (() => void) | undefined
  const ackPromise = new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      port.offMessage(onAck)
      signal.removeEventListener('abort', done)
      process.off('disconnect', done)
      clearTimeout(timer)
      resolve()
    }
    cleanupAck = done
    const onAck = (raw: unknown): void => {
      const parsed = agyStoragePortResultAckMessageSchema.safeParse(raw)
      if (parsed.success && sameJobKey(parsed.data.jobKey, expectedJobKey)) {
        done()
      }
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    signal.addEventListener('abort', done, { once: true })
    process.once('disconnect', done)
    port.onMessage(onAck)
  })
  try {
    await sendPortMessage(port, payload, measure)
  } catch (error) {
    cleanupAck?.()
    throw error
  }
  await ackPromise
}

function runWithPort(init: AgyStorageInitMessage, port: ChildPort): void {
  const { jobKey: expectedJobKey, action: expectedAction, deadlineAt: expectedDeadlineAt } = init
  let handledRequest = false
  let finished = false
  const abortController = new AbortController()
  let requestTimer: ReturnType<typeof setTimeout> | undefined
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined

  const finishAndExit = (exitCode: number): void => {
    if (finished) return
    finished = true
    if (requestTimer !== undefined) {
      clearTimeout(requestTimer)
      requestTimer = undefined
    }
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer)
      deadlineTimer = undefined
    }
    port.offMessage(onMessage)
    setImmediate(() => {
      port.close()
      process.exitCode = exitCode
      const fallback = setTimeout(() => process.exit(exitCode), EXIT_FLUSH_FALLBACK_MS)
      fallback.unref()
    })
  }

  requestTimer = setTimeout(() => {
    abortController.abort()
    finishAndExit(1)
  }, REQUEST_TIMEOUT_MS)

  const onMessage = (raw: unknown): void => {
    if (finished) return
    if (typeof raw === 'object' && raw !== null && Reflect.get(raw, 'type') === 'cancel') {
      const key = agyStorageJobKeySchema.safeParse(Reflect.get(raw, 'jobKey'))
      if (key.success && sameJobKey(key.data, expectedJobKey)) {
        abortController.abort()
      }
      return
    }
    if (handledRequest) return
    if (typeof raw !== 'object' || raw === null || Reflect.get(raw, 'type') !== 'request') {
      return
    }
    handledRequest = true
    if (requestTimer !== undefined) {
      clearTimeout(requestTimer)
      requestTimer = undefined
    }

    const parsed = agyStoragePortRequestMessageSchema.safeParse(raw)
    if (
      !parsed.success ||
      !sameJobKey(parsed.data.jobKey, expectedJobKey) ||
      parsed.data.input.action !== expectedAction ||
      parsed.data.deadlineAt !== expectedDeadlineAt
    ) {
      const errorPacket = agyStoragePortErrorMessageSchema.parse({
        type: 'error',
        jobKey: expectedJobKey,
        message: 'Invalid or mismatched Antigravity isolated storage request.',
        code: 'INVALID_REQUEST',
      })
      void sendPortMessage(port, errorPacket, false)
        .catch(() => undefined)
        .finally(() => finishAndExit(1))
      return
    }

    const request = parsed.data
    const measure = request.measure === true
    const remainingMs = request.deadlineAt - Date.now()
    if (remainingMs <= 0) {
      abortController.abort()
      const timeoutPacket = agyStoragePortErrorMessageSchema.parse({
        type: 'error',
        jobKey: expectedJobKey,
        message: 'Antigravity storage operation exceeded its deadline.',
        code: 'TIMEOUT',
      })
      void sendPortMessage(port, timeoutPacket, measure)
        .catch(() => undefined)
        .finally(() => finishAndExit(0))
      return
    }
    deadlineTimer = setTimeout(() => {
      abortController.abort()
    }, remainingMs)

    void executeAction(request, port, abortController.signal)
      .then(async (result) => {
        const resultPacket = agyStoragePortResultMessageSchema.parse({
          type: 'result',
          jobKey: expectedJobKey,
          action: request.input.action,
          result,
        })
        const ackWaitMs = Math.min(
          RESULT_ACK_TIMEOUT_MS,
          Math.max(100, request.deadlineAt - Date.now()),
        )
        await sendTerminalAndAwaitAck(
          port,
          expectedJobKey,
          resultPacket,
          measure,
          abortController.signal,
          ackWaitMs,
        )
        finishAndExit(0)
        return undefined
      })
      .catch(async (error: unknown) => {
        const rawMessage =
          error instanceof Error ? error.message : 'Antigravity isolated storage operation failed.'
        const rawCode = error instanceof Error ? Reflect.get(error, 'code') : undefined
        const code =
          typeof rawCode === 'string' && rawCode.length > 0 && rawCode.length <= 128
            ? rawCode
            : undefined
        const errorKind =
          error instanceof AgentExecutionError && error.kind.length > 0 && error.kind.length <= 128
            ? error.kind
            : undefined
        const errorPacket = agyStoragePortErrorMessageSchema.parse({
          type: 'error',
          jobKey: expectedJobKey,
          message: boundUtf8Message(rawMessage, AGY_STORAGE_MAX_ERROR_BYTES),
          ...(code !== undefined ? { code } : {}),
          ...(errorKind !== undefined ? { errorKind } : {}),
        })
        try {
          const ackWaitMs = Math.min(
            RESULT_ACK_TIMEOUT_MS,
            Math.max(100, request.deadlineAt - Date.now()),
          )
          await sendTerminalAndAwaitAck(
            port,
            expectedJobKey,
            errorPacket,
            measure,
            abortController.signal,
            ackWaitMs,
          )
        } catch {
          /* Parent port may already have closed on cancel/timeout. */
        }
        finishAndExit(0)
      })
  }

  port.onMessage(onMessage)
}

function wrapElectronMessagePort(port: Electron.MessagePortMain): ChildPort {
  const listenerMap = new Map<(message: unknown) => void, (event: Electron.MessageEvent) => void>()
  port.start()
  return {
    onMessage(listener) {
      const wrapped = (event: Electron.MessageEvent): void => listener(event.data)
      listenerMap.set(listener, wrapped)
      port.on('message', wrapped)
    },
    offMessage(listener) {
      const wrapped = listenerMap.get(listener)
      if (!wrapped) return
      listenerMap.delete(listener)
      port.removeListener('message', wrapped)
    },
    postMessage(message) {
      port.postMessage(message)
      return Promise.resolve()
    },
    close() {
      try {
        port.close()
      } catch {
        /* Best-effort port close. */
      }
    },
  }
}

function wrapNodeProcessIpc(): ChildPort {
  return {
    onMessage(listener) {
      process.on('message', listener)
    },
    offMessage(listener) {
      process.off('message', listener)
    },
    postMessage(message) {
      return new Promise<void>((resolve, reject) => {
        if (typeof process.send !== 'function' || !process.connected) {
          reject(new Error('Node IPC parent channel is closed.'))
          return
        }
        process.send(message, undefined, undefined, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    close() {
      try {
        if (process.connected) process.disconnect()
      } catch {
        /* Best-effort IPC disconnect. */
      }
    },
  }
}

function bootstrap(): void {
  let initialized = false
  const initWatchdog = setTimeout(() => {
    if (!initialized) process.exit(1)
  }, INIT_TIMEOUT_MS)

  const acceptInit = (data: unknown, port: ChildPort): void => {
    if (initialized) return
    if (typeof data !== 'object' || data === null || Reflect.get(data, 'type') !== 'init') {
      return
    }
    const parsedInit = agyStorageInitMessageSchema.safeParse(data)
    if (!parsedInit.success) {
      clearTimeout(initWatchdog)
      port.close()
      process.exit(1)
      return
    }
    initialized = true
    clearTimeout(initWatchdog)
    runWithPort(parsedInit.data, port)
  }

  if (process.parentPort) {
    const parentPort = process.parentPort
    const onParentMessage = (event: Electron.MessageEvent): void => {
      const transferredPort = event.ports?.[0]
      if (!transferredPort) return
      parentPort.removeListener('message', onParentMessage)
      acceptInit(event.data, wrapElectronMessagePort(transferredPort))
    }
    parentPort.on('message', onParentMessage)
    return
  }

  if (typeof process.send === 'function') {
    const nodePort = wrapNodeProcessIpc()
    const onNodeInit = (message: unknown): void => {
      if (
        typeof message !== 'object' ||
        message === null ||
        Reflect.get(message, 'type') !== 'init'
      ) {
        return
      }
      process.off('message', onNodeInit)
      acceptInit(message, nodePort)
    }
    process.on('message', onNodeInit)
    process.once('disconnect', () => {
      if (!initialized) {
        clearTimeout(initWatchdog)
        process.exit(1)
      }
    })
    return
  }

  clearTimeout(initWatchdog)
  throw new Error(
    'Pact Antigravity storage child requires an Electron parentPort or Node IPC channel.',
  )
}

bootstrap()
