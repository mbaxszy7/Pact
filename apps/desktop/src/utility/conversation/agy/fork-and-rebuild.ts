import { randomUUID } from 'node:crypto'

import type {
  AgentNativeCheckContext,
  AgentNativeCheckOperation,
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
  AgentNativeForkBoundary,
  AgentNativeForkInput,
  AgentNativeForkInspection,
  AgentNativeForkResult,
  AgentNativeForkSourceInput,
  AgentNativeInitializedBindingProbeInput,
  AgentNativeInputProbeInput,
  AgentNativeProbeInput,
  AgentProbeResult,
  AgentPromptImage,
} from '@pact/agent-runtime'
import type {
  NativeContextRebuildChunk,
  NativeInitializationWitness,
  NativeProbeResult,
} from '@pact/contracts'

import { RUNTIME_MINIMUM_VERSIONS } from '@pact/contracts'

import type { AgyAdapterRuntime } from './adapter-runtime'

import { OwnedProcessGroup } from '../../owned-process-group'
import { AgentExecutionError } from '../agent-execution-error'
import { requireNativeImageReference } from '../native-image-content'
import { safeNativePermissionText } from '../native-permission-wait'
import {
  AGY_PROBE_MAX_BYTES,
  AGY_PROBE_TIMEOUT_MS,
  AGY_REBUILD_RECEIPT_LIMIT,
  compareSemver,
  type AgyRebuildSeedChunkRecord,
  type OwnedAgyProbeProcess,
} from './types'

/**
 * Deep lifecycle coordinator for Antigravity probe, cold storage status/input checks,
 * zero-turn Context Rebuild seeding, and cut-point native Fork.
 */
export class AgyLifecycleCoordinator {
  constructor(private readonly runtime: AgyAdapterRuntime) {}

  async probe(signal?: AbortSignal): Promise<AgentProbeResult> {
    const effectiveSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(AGY_PROBE_TIMEOUT_MS)
    if (effectiveSignal.aborted) {
      return { id: 'agy', available: false, reason: 'Antigravity version check was cancelled.' }
    }

    let owned: OwnedAgyProbeProcess | undefined
    try {
      const args = ['--version'] as const
      if (this.runtime.options.probeProcessFactory) {
        const supplied = this.runtime.options.probeProcessFactory(this.runtime.executablePath, args)
        owned = 'then' in supplied ? await supplied : supplied
      } else {
        const isWinCmd =
          process.platform === 'win32' && /\.cmd$/iu.test(this.runtime.executablePath)
        if (isWinCmd && /[&|<>^%!"\r\n]/u.test(this.runtime.executablePath)) {
          return { id: 'agy', available: false, reason: 'Unsafe Antigravity executable path.' }
        }
        const group = new OwnedProcessGroup()
        const target = isWinCmd ? (process.env.ComSpec ?? 'cmd.exe') : this.runtime.executablePath
        const spawnArgs = isWinCmd
          ? ['/d', '/s', '/c', `""${this.runtime.executablePath}" --version"`]
          : ['--version']
        const child = group.spawn(target, spawnArgs, {
          windowsHide: true,
          windowsVerbatimArguments: isWinCmd,
        })
        owned = { child, close: (deadline) => group.close(deadline) }
      }

      const output = await new Promise<{ code: number | null; text: string }>(
        (resolveOut, rejectOut) => {
          let settled = false
          let bytes = 0
          const chunks: Buffer[] = []
          const finish = (code: number | null, err?: Error): void => {
            if (settled) return
            settled = true
            effectiveSignal.removeEventListener('abort', onAbort)
            owned!.child.stdout.off('data', onData)
            owned!.child.stderr.off('data', onData)
            owned!.child.off('error', onError)
            owned!.child.off('close', onClose)
            if (err) rejectOut(err)
            else resolveOut({ code, text: Buffer.concat(chunks, bytes).toString('utf8') })
          }
          const onAbort = (): void => finish(null, new Error('Antigravity probe timed out.'))
          const onData = (chunk: Buffer): void => {
            const remaining = AGY_PROBE_MAX_BYTES - bytes
            if (remaining <= 0) return
            const slice = chunk.subarray(0, remaining)
            bytes += slice.length
            chunks.push(slice)
          }
          const onError = (err: Error): void => finish(null, err)
          const onClose = (code: number | null): void => finish(code)

          effectiveSignal.addEventListener('abort', onAbort, { once: true })
          owned!.child.stdout.on('data', onData)
          owned!.child.stderr.on('data', onData)
          owned!.child.once('error', onError)
          owned!.child.once('close', onClose)
          owned!.child.stdin.end()
        },
      )

      const versionMatch = /(\d+\.\d+\.\d+)/u.exec(output.text)
      const version = versionMatch?.[1]
      if (output.code !== 0 || !version) {
        return {
          id: 'agy',
          available: false,
          ...(version ? { version } : {}),
          reason: 'Antigravity CLI did not report a valid version.',
        }
      }
      const minVersion = RUNTIME_MINIMUM_VERSIONS.agy
      if (compareSemver(version, minVersion) < 0) {
        return {
          id: 'agy',
          available: false,
          version,
          reason: `Antigravity ${version} is older than required ${minVersion}.`,
        }
      }
      return { id: 'agy', available: true, version }
    } catch (error) {
      return {
        id: 'agy',
        available: false,
        reason: safeNativePermissionText(
          error instanceof Error ? error.message : 'Antigravity CLI is unavailable.',
          240,
        ),
      }
    } finally {
      if (owned?.close) {
        await owned.close(Date.now() + 1_000).catch(() => undefined)
      } else if (owned && owned.child.exitCode === null) {
        try {
          owned.child.kill('SIGKILL')
        } catch {
          // Ignore concurrent exit.
        }
      }
    }
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.runtime.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeStatus(input, checkSignal),
      context,
    )
  }

  async probeNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    signal.throwIfAborted()
    if (input.target === 'initialized_binding') {
      return this.probeInitializedBinding(input, signal)
    }

    const identity = this.runtime.toEvidenceIdentity(input)
    if (input.runId) {
      const live = this.runtime.activeRuns.get(input.runId)
      const cached = this.runtime.nativeEvidence.get(
        this.runtime.evidenceKey(input.runId, input.nativeSessionId),
      )
      if (
        live &&
        live.nativeSessionId === input.nativeSessionId &&
        (!input.executorId || live.executorId === input.executorId) &&
        !live.rootTerminal
      ) {
        if (cached && (cached.kind === 'running' || cached.kind === 'waiting_user')) {
          return {
            ...cached,
            identity: {
              ...cached.identity,
              requestId: input.requestId,
            },
          }
        }
        return {
          kind: 'running',
          identity: {
            ...identity,
            executorId: live.executorId,
            nativeTurnId: live.nativeTurnId,
          },
          source: 'live_runtime',
        }
      }
      if (
        cached &&
        cached.kind === 'ended' &&
        (!input.executorId || cached.identity.executorId === input.executorId) &&
        !(input.inspectMissingPlan && !cached.output?.plan)
      ) {
        return {
          ...cached,
          identity: {
            ...cached.identity,
            requestId: input.requestId,
          },
        }
      }
    }

    if (input.confirmedTerminal && !input.inspectMissingPlan) {
      return {
        ...input.confirmedTerminal,
        identity: {
          ...input.confirmedTerminal.identity,
          requestId: input.requestId,
        },
      }
    }

    if (this.runtime.options.storageClient?.probeSessionStatus) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const probed = await this.runtime.options.storageClient.probeSessionStatus(
        {
          ...input,
          appDataDir: this.runtime.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      return {
        ...probed,
        identity: {
          ...probed.identity,
          ...identity,
          ...((identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId)
            ? {
                nativeTurnId:
                  identity.nativeTurnId ?? effectiveTurnId ?? probed.identity.nativeTurnId,
              }
            : {}),
        },
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Cold Antigravity SQLite trajectory inspection is not configured on this Adapter.',
    }
  }

  private async probeInitializedBinding(
    input: AgentNativeInitializedBindingProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    const identity = this.runtime.toEvidenceIdentity(input)
    if (this.runtime.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.runtime.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.runtime.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId,
          sourceHash: input.confirmedInitialization.sourceHash,
          chunks: input.source,
        },
        signal,
      )
      if (inspected.verified && inspected.initializationWitness) {
        return {
          kind: 'binding_ready',
          identity,
          source: 'completed_initialization_readback',
          rebuildId: input.confirmedInitialization.rebuildId,
          sourceHash: input.confirmedInitialization.sourceHash,
          witness: inspected.initializationWitness,
        }
      }
      this.runtime.nativeRebuildReceipts.delete(input.confirmedInitialization.rebuildId)
      return {
        kind: 'no_evidence',
        identity,
        reason: 'Antigravity rebuild binding could not be verified from cold readback.',
      }
    }

    const receipt = this.runtime.nativeRebuildReceipts.get(input.confirmedInitialization.rebuildId)
    if (
      receipt &&
      receipt.nativeSessionId === input.nativeSessionId &&
      Boolean(receipt.initializationWitness) &&
      (!receipt.sourceHash || receipt.sourceHash === input.confirmedInitialization.sourceHash)
    ) {
      return {
        kind: 'binding_ready',
        identity,
        source: 'completed_initialization_readback',
        rebuildId: input.confirmedInitialization.rebuildId,
        sourceHash: input.confirmedInitialization.sourceHash,
        witness: receipt.initializationWitness!,
      }
    }

    return {
      kind: 'no_evidence',
      identity,
      reason: 'Antigravity rebuild binding could not be verified from cold readback.',
    }
  }

  beginNativeInputsCheck(
    input: AgentNativeInputProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<void> {
    return this.runtime.nativeChecks.begin(
      signal,
      (checkSignal) => this.probeNativeInputs(input, checkSignal),
      context,
    )
  }

  async probeNativeInputs(input: AgentNativeInputProbeInput, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (input.unresolvedInputIds.length === 0) return
    if (input.unresolvedInputIds.length > 64) {
      throw new AgentExecutionError(
        'protocol_error',
        'Too many unresolved Antigravity steer input candidates.',
        false,
      )
    }
    if (input.runId) {
      const live = this.runtime.activeRuns.get(input.runId)
      if (live) {
        for (const id of input.unresolvedInputIds) {
          if (live.steeredInputs.get(id)?.consumed) {
            input.recordConsumption(id)
          }
        }
      }
    }
    if (this.runtime.options.storageClient?.probeInputReceipts) {
      const effectiveTurnId = input.nativeTurnId ?? input.runId
      const consumed = await this.runtime.options.storageClient.probeInputReceipts(
        {
          ...input,
          appDataDir: this.runtime.primaryAppDataDir,
          ...(effectiveTurnId ? { nativeTurnId: effectiveTurnId } : {}),
        },
        signal,
      )
      const allowed = new Set(input.unresolvedInputIds)
      for (const id of consumed) {
        if (allowed.has(id)) input.recordConsumption(id)
      }
    }
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.runtime.nativeChecks.begin(
      signal,
      (checkSignal) => this.inspectNativeRebuild(input, source, checkSignal),
      context,
    )
  }

  async inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    signal.throwIfAborted()
    const receipt = this.runtime.nativeRebuildReceipts.get(input.rebuildId)
    const targetSessionId = input.nativeSessionId ?? receipt?.nativeSessionId
    if (targetSessionId && this.runtime.options.storageClient?.inspectRebuildSeed) {
      const inspected = await this.runtime.options.storageClient.inspectRebuildSeed(
        {
          appDataDir: this.runtime.primaryAppDataDir,
          cwd: input.cwd,
          nativeSessionId: targetSessionId,
          sourceHash: input.sourceHash,
          chunks: source,
        },
        signal,
      )
      if (inspected.verified && (!input.sourceHash || Boolean(inspected.initializationWitness))) {
        return {
          nativeSessionId: targetSessionId,
          ...(inspected.initializationWitness
            ? { initializationWitness: inspected.initializationWitness }
            : {}),
        }
      }
      this.runtime.nativeRebuildReceipts.delete(input.rebuildId)
      return undefined
    }
    if (
      receipt &&
      (!input.nativeSessionId || receipt.nativeSessionId === input.nativeSessionId) &&
      (!input.sourceHash ||
        (receipt.sourceHash === input.sourceHash && Boolean(receipt.initializationWitness)))
    ) {
      return {
        nativeSessionId: receipt.nativeSessionId,
        ...(receipt.initializationWitness
          ? { initializationWitness: receipt.initializationWitness }
          : {}),
      }
    }
    return undefined
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    signal.throwIfAborted()
    if (!this.runtime.options.storageClient?.writeRebuildSeed) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity zero-Turn Rebuild storage writer is not configured.',
        false,
      )
    }

    const lease = await this.runtime.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode ?? 'ask',
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner:
      | ReturnType<typeof this.runtime.bootstrap.registerControlOperationServerRequests>
      | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.runtime.bootstrap.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `rebuild:${input.rebuildId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode ?? 'ask',
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      if (!candidateSessionId) {
        await input.onNativeCreationDispatched?.(executorId)
        candidateSessionId = await this.runtime.bootstrap.allocateZeroTurnSessionShell(
          lease,
          signal,
          {
            onCreationDispatched: () => {
              creationPossiblyDelivered = true
            },
            onCreationRejectedByServer: () => {
              creationPossiblyDelivered = false
            },
            onSessionAllocated: async (allocatedId) => {
              candidateSessionId = allocatedId
              controlOwner?.updateSessionId(allocatedId)
              await input.onNativeSessionCreated?.(allocatedId)
            },
          },
        )
      }

      const resolveImage = input.resolveImage
      const bufferedChunks: NativeContextRebuildChunk[] = []
      const resolvedRecords: AgyRebuildSeedChunkRecord[] = []
      for await (const chunk of source) {
        signal.throwIfAborted()
        bufferedChunks.push(chunk)
        const resolvedImages = new Map<string, AgentPromptImage>()
        if (resolveImage && chunk.kind === 'image') {
          const resolved = await resolveImage(chunk.image.id, signal)
          requireNativeImageReference(resolved, chunk.image)
          resolvedImages.set(chunk.image.id, resolved)
        }
        resolvedRecords.push({ chunk, resolvedImages })
      }

      const written = await this.runtime.options.storageClient.writeRebuildSeed(
        {
          appDataDir: this.runtime.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
          chunks: (async function* () {
            yield* resolvedRecords
          })(),
        },
        signal,
      )

      // Cold `session/load` + `session/close` verification (0 model invocations!).
      await this.runtime.bootstrap.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: written.stepCount > 0,
        forbidToolUpdates: true,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      // Seal cold-load verification receipt ONLY AFTER zero-Turn `session/load` + `session/close` succeeds!
      let finalWitness: NativeInitializationWitness | undefined
      if (this.runtime.options.storageClient.confirmRebuildColdLoad) {
        if (!input.sourceHash) {
          throw new AgentExecutionError(
            'protocol_error',
            'Antigravity zero-Turn Rebuild cold-load confirmation requires a sourceHash.',
            false,
          )
        }
        const pbSha256 = written.pbSha256 ?? written.verifiedPrefixSha256
        const pbBytes = written.pbBytes ?? written.verifiedPrefixBytes
        if (written.stepCount !== 2 || !pbSha256 || pbBytes <= 0) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity zero-Turn Rebuild seed did not produce a valid 2-step payload.',
            false,
          )
        }
        finalWitness = await this.runtime.options.storageClient.confirmRebuildColdLoad(
          {
            cwd: lease.canonicalCwd,
            appDataDir: this.runtime.primaryAppDataDir,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            pbSha256,
            pbBytes,
            stepCount: 2,
          },
          signal,
        )
      }

      if (this.runtime.options.storageClient.inspectRebuildSeed) {
        const postLoad = await this.runtime.options.storageClient.inspectRebuildSeed(
          {
            appDataDir: this.runtime.primaryAppDataDir,
            cwd: lease.canonicalCwd,
            nativeSessionId: candidateSessionId,
            sourceHash: input.sourceHash,
            chunks: (async function* () {
              yield* bufferedChunks
            })(),
          },
          signal,
        )
        if (!postLoad.verified) {
          throw new AgentExecutionError(
            'context_resume_failed',
            'Antigravity rebuild seed failed post-load cold verification.',
            false,
          )
        }
        finalWitness = postLoad.initializationWitness ?? finalWitness
      }

      this.rememberRebuildReceipt(input.rebuildId, {
        nativeSessionId: candidateSessionId,
        sourceHash: input.sourceHash,
        seedHash: written.seedHash,
        cwd: lease.canonicalCwd,
        executorId,
        initializationWitness: finalWitness,
      })
      input.reportNativeWork?.({
        executorId,
        nativeSessionId: candidateSessionId,
        state: 'settled',
      })
      return {
        nativeSessionId: candidateSessionId,
        ...(finalWitness ? { initializationWitness: finalWitness } : {}),
      }
    } catch (error) {
      input.reportNativeWork?.({
        executorId,
        ...(candidateSessionId ? { nativeSessionId: candidateSessionId } : {}),
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    signal.throwIfAborted()
    if (!this.runtime.options.storageClient?.prepareFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    return this.runtime.options.storageClient.prepareFork(
      { ...input, appDataDir: this.runtime.primaryAppDataDir },
      signal,
    )
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    signal.throwIfAborted()
    if (!this.runtime.options.storageClient?.inspectFork) {
      return {
        kind: 'missing',
        reason: 'Antigravity native Fork storage engine is not configured.',
      }
    }
    return this.runtime.options.storageClient.inspectFork(
      { ...input, appDataDir: this.runtime.primaryAppDataDir },
      signal,
    )
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!this.runtime.options.storageClient?.writeFork) {
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Antigravity native Fork storage engine is not configured.',
        false,
      )
    }
    const lease = await this.runtime.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let candidateSessionId = input.nativeSessionId
    let creationPossiblyDelivered = Boolean(candidateSessionId)
    let controlOwner:
      | ReturnType<typeof this.runtime.bootstrap.registerControlOperationServerRequests>
      | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.runtime.bootstrap.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork:${input.operationId}:${randomUUID()}`,
        initialSessionId: candidateSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      if (!candidateSessionId) {
        candidateSessionId = await this.runtime.bootstrap.allocateZeroTurnSessionShell(
          lease,
          signal,
          {
            onCreationDispatched: () => {
              creationPossiblyDelivered = true
            },
            onCreationRejectedByServer: () => {
              creationPossiblyDelivered = false
            },
            onSessionAllocated: async (allocatedId) => {
              candidateSessionId = allocatedId
              controlOwner?.updateSessionId(allocatedId)
              await input.onCandidate(allocatedId)
            },
          },
        )
      }
      const witness = await this.runtime.options.storageClient.writeFork(
        {
          appDataDir: this.runtime.primaryAppDataDir,
          cwd: lease.canonicalCwd,
          candidateSessionId,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          source: input.source,
          onCandidate: input.onCandidate,
        },
        signal,
      )
      await input.onCandidate(candidateSessionId, witness)

      // Cold `session/load` + `session/close` verification with zero model input.
      await this.runtime.bootstrap.verifyZeroTurnSessionLoad(lease, candidateSessionId, signal, {
        expectReplaySteps: (witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.runtime.bootstrap.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        candidateSessionId,
        witness,
        signal,
      )
      await input.onCandidate(candidateSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: candidateSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({
        executorId,
        state: candidateSessionId || creationPossiblyDelivered ? 'unknown' : 'settled',
      })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    signal.throwIfAborted()
    if (!input.nativeSessionId || !input.witness) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity Fork initialization requires an existing verified candidate and witness.',
        false,
      )
    }
    const lease = await this.runtime.pool.acquire({
      cwd: input.cwd,
      permissionScope: 'standard',
      permissionMode: input.permissionMode,
      readOnly: true,
      sessionId: input.sessionId,
      signal,
    })
    const executorId = lease.connection.executorId
    let controlOwner:
      | ReturnType<typeof this.runtime.bootstrap.registerControlOperationServerRequests>
      | undefined
    try {
      await lease.ensureInitialized(signal)
      controlOwner = this.runtime.bootstrap.registerControlOperationServerRequests({
        connection: lease.connection,
        ownerId: `fork-init:${input.operationId}:${randomUUID()}`,
        initialSessionId: input.nativeSessionId,
        cwd: lease.canonicalCwd,
        permissionMode: input.permissionMode,
        requestPermission: input.requestPermission,
        requestUserInput: input.requestUserInput,
        signal,
      })
      await input.onDispatched(executorId)
      await this.runtime.bootstrap.verifyZeroTurnSessionLoad(lease, input.nativeSessionId, signal, {
        expectReplaySteps: (input.witness.candidatePrefixRecords ?? input.source.prefixRecords) > 0,
        forbidToolUpdates: false,
        onServerRequest: (req) => {
          controlOwner?.handleServerRequest(req.message)
        },
      })
      controlOwner.dispose()
      await lease.disposeIfIdle()

      const initializedWitness = await this.runtime.bootstrap.sealPostLoadForkWitness(
        input,
        lease.canonicalCwd,
        input.nativeSessionId,
        input.witness,
        signal,
      )
      await input.onCandidate(input.nativeSessionId, initializedWitness)
      input.reportNativeWork({ executorId, state: 'settled' })
      return { nativeSessionId: input.nativeSessionId, witness: initializedWitness }
    } catch (error) {
      input.reportNativeWork({ executorId, state: 'unknown' })
      throw error
    } finally {
      controlOwner?.dispose()
      lease.release()
    }
  }

  rememberRebuildReceipt(
    rebuildId: string,
    receipt: {
      nativeSessionId: string
      sourceHash?: string | undefined
      seedHash: string
      cwd: string
      executorId: string
      initializationWitness?: NativeInitializationWitness | undefined
    },
  ): void {
    this.runtime.nativeRebuildReceipts.delete(rebuildId)
    if (this.runtime.nativeRebuildReceipts.size >= AGY_REBUILD_RECEIPT_LIMIT) {
      const oldest = this.runtime.nativeRebuildReceipts.keys().next().value
      if (oldest !== undefined) this.runtime.nativeRebuildReceipts.delete(oldest)
    }
    this.runtime.nativeRebuildReceipts.set(rebuildId, receipt)
  }
}
