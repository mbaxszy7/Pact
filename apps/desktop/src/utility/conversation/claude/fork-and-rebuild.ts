import type { query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'

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
  AgentNativeForkWitness,
  AgentNativeProbeInput,
} from '@pact/agent-runtime'
import type {
  NativeContextRebuildChunk,
  NativeEvidenceIdentity,
  NativeProbeResult,
  SkillBinding,
} from '@pact/contracts'

import {
  AgentExecutionError,
  classifyAgentError,
  NativeCapacityError,
} from '../agent-execution-error'
import {
  nativeImageBlock,
  nativeImagePreparationBytes,
  requireNativeImageReference,
  type NativeImageBlock,
} from '../native-image-content'
import { freezeNativeJsonFrame } from '../native-json-encoder'
import { NativePermissionWait, safeNativePermissionText } from '../native-permission-wait'
import { nativeSkillCatalog } from '../native-skill-catalog'
import { NativeWorkingMemory, type NativeMemoryReservation } from '../native-working-memory'
import {
  confirmAutoMode,
  drainStderr,
  elicitationHandler,
  explicitEffortOptions,
  isRequestUuid,
  parseClaudeEffort,
  permissionHandler,
  permissionOptions,
  withDeadline,
} from './permissions-and-settings'
import { ClaudeNativeWork, MAX_NATIVE_CLAUDE_QUERIES, type ClaudeAdapterRuntime } from './types'

/**
 * Deep lifecycle coordinator for Claude native Fork, Context Rebuild,
 * cold status probes, native skill catalog discovery, and title enrichment.
 */
export class ClaudeLifecycleCoordinator {
  constructor(private readonly runtime: ClaudeAdapterRuntime) {}

  async prepareNativeFork(
    input: AgentNativeForkSourceInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary> {
    const prefix = await this.runtime.nativeForkFiles.execute(
      { provider: 'claude', action: 'prepare', ...input },
      signal,
    )
    return {
      nativeSessionId: input.nativeSessionId,
      nativeTurnId: input.nativeTurnId,
      nativeCutId: prefix.nativeCutId,
      bindingGeneration: input.bindingGeneration,
      throughSequence: input.throughSequence,
      deliveryCursor: input.deliveryCursor,
      prefixHash: prefix.prefixHash,
      prefixRecords: prefix.prefixRecords,
      prefixBytes: prefix.prefixBytes,
    }
  }

  async forkNativeContext(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    if (input.nativeSessionId) return this.initializeNativeFork(input, signal)
    signal.throwIfAborted()
    if (
      this.runtime.disposed ||
      this.runtime.backgroundRuns.size + this.runtime.forkInitializing.size >=
        MAX_NATIVE_CLAUDE_QUERIES
    )
      throw new NativeCapacityError(
        'Claude native context capacity is unavailable; no Fork was created.',
      )
    const executorId = randomUUID()
    await input.onDispatched(executorId)
    this.runtime.latestExecutorId = executorId
    input.reportNativeWork({ executorId, state: 'unknown' })
    const prefix = await this.runtime.nativeForkFiles.execute(
      {
        provider: 'claude',
        action: 'fork',
        cwd: input.cwd,
        nativeSessionId: input.source.nativeSessionId,
        nativeTurnId: input.source.nativeTurnId,
        source: input.source,
      },
      signal,
      async (candidate) => {
        const witness: AgentNativeForkWitness = {
          version: 'pact-native-fork-v1',
          nativeSessionId: candidate.nativeSessionId,
          sourceNativeSessionId: input.source.nativeSessionId,
          sourceCutId: input.source.nativeCutId,
          sourcePrefixHash: input.source.prefixHash,
          candidatePrefixHash: candidate.prefixHash,
          idMap: candidate.idMap,
          candidatePrefixRecords: candidate.rawRecords,
          ...(candidate.nativeProjectKey ? { nativeProjectKey: candidate.nativeProjectKey } : {}),
          ...(candidate.nativeProjectDevice
            ? { nativeProjectDevice: candidate.nativeProjectDevice }
            : {}),
          ...(candidate.nativeProjectInode
            ? { nativeProjectInode: candidate.nativeProjectInode }
            : {}),
          ...(candidate.nativeStorageRoot
            ? { nativeStorageRoot: candidate.nativeStorageRoot }
            : {}),
          ...(candidate.nativePath ? { nativePath: candidate.nativePath } : {}),
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
        }
        await input.onCandidate(candidate.nativeSessionId, witness)
      },
    )
    const witness: AgentNativeForkWitness = {
      version: 'pact-native-fork-v1',
      nativeSessionId: prefix.nativeSessionId,
      sourceNativeSessionId: input.source.nativeSessionId,
      sourceCutId: input.source.nativeCutId,
      sourcePrefixHash: input.source.prefixHash,
      candidatePrefixHash: prefix.prefixHash,
      idMap: prefix.idMap,
      candidatePrefixRecords: prefix.rawRecords,
      ...(prefix.nativeProjectKey ? { nativeProjectKey: prefix.nativeProjectKey } : {}),
      ...(prefix.nativeProjectDevice ? { nativeProjectDevice: prefix.nativeProjectDevice } : {}),
      ...(prefix.nativeProjectInode ? { nativeProjectInode: prefix.nativeProjectInode } : {}),
      ...(prefix.nativeStorageRoot ? { nativeStorageRoot: prefix.nativeStorageRoot } : {}),
      ...(prefix.nativePath ? { nativePath: prefix.nativePath } : {}),
      model: input.model,
      effort: input.effort,
      permissionMode: input.permissionMode,
    }
    input.reportNativeWork({ executorId, state: 'settled' })
    return { nativeSessionId: prefix.nativeSessionId, witness }
  }

  async inspectNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkInspection> {
    if (!input.nativeSessionId || !input.witness)
      return {
        kind: 'unconfirmed',
        reason: 'The native Fork candidate identity or witness was not acknowledged.',
      }
    if (
      input.witness.sourceNativeSessionId !== input.source.nativeSessionId ||
      input.witness.sourceCutId !== input.source.nativeCutId ||
      input.witness.sourcePrefixHash !== input.source.prefixHash
    )
      return {
        kind: 'unconfirmed',
        reason: 'The native Fork witness belongs to another source or settings revision.',
      }
    try {
      const prefix = await this.runtime.nativeForkFiles.execute(
        {
          provider: 'claude',
          action: 'inspect',
          source: input.source,
          ...(input.lastDispatchedPhase ? { lastDispatchedPhase: input.lastDispatchedPhase } : {}),
          cwd: input.cwd,
          nativeSessionId: input.nativeSessionId,
          witness: input.witness,
        },
        signal,
      )
      return {
        kind: 'verified',
        result: { nativeSessionId: input.nativeSessionId, witness: input.witness },
        ready:
          Boolean(prefix.initializedVerified) &&
          input.witness.model === input.model &&
          input.witness.effort === input.effort &&
          input.witness.permissionMode === input.permissionMode,
        workSettled:
          Boolean(prefix.initializedVerified) ||
          (input.lastDispatchedPhase === 'fork' &&
            !this.runtime.backgroundRuns.has(input.operationId)),
      }
    } catch (error) {
      return {
        kind:
          error instanceof Error &&
          Reflect.get(error, 'code') === 'native_file_fork_candidate_missing'
            ? 'missing'
            : 'unconfirmed',
        reason: error instanceof Error ? error.message : 'Native Fork inspection failed.',
      }
    }
  }

  async initializeNativeFork(
    input: AgentNativeForkInput,
    signal: AbortSignal,
  ): Promise<AgentNativeForkResult> {
    const inspected = await this.inspectNativeFork(input, signal)
    if (inspected.kind !== 'verified')
      throw new AgentExecutionError('runtime_incompatible', inspected.reason, false)
    if (inspected.ready) return inspected.result
    if (
      this.runtime.backgroundRuns.has(input.operationId) ||
      this.runtime.forkInitializing.has(input.operationId)
    )
      throw new NativeCapacityError(
        'The same Claude Fork still owns initialization work; no new Query was started.',
      )
    if (
      this.runtime.disposed ||
      this.runtime.backgroundRuns.size + this.runtime.forkInitializing.size >=
        MAX_NATIVE_CLAUDE_QUERIES
    )
      throw new NativeCapacityError(
        'Claude native context capacity is unavailable; the Fork candidate was preserved.',
      )
    const {
      initializedAt: _initializedAt,
      initializedPrefixHash: _initializedPrefixHash,
      initializedPrefixBytes: _initializedPrefixBytes,
      initializedPrefixRecords: _initializedPrefixRecords,
      ...originalWitness
    } = inspected.result.witness
    const candidate: AgentNativeForkResult = {
      nativeSessionId: inspected.result.nativeSessionId,
      witness: {
        ...originalWitness,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
      },
    }
    this.runtime.forkInitializing.add(input.operationId)
    try {
      await input.onCandidate(candidate.nativeSessionId, candidate.witness)
    } catch (error) {
      this.runtime.forkInitializing.delete(input.operationId)
      throw error
    }
    const controller = new AbortController(),
      observation = new AbortController(),
      permissionWait = new NativePermissionWait(),
      nativeWork = new ClaudeNativeWork()
    const executorId = randomUUID()
    try {
      await input.onDispatched(executorId)
    } catch (error) {
      this.runtime.forkInitializing.delete(input.operationId)
      throw error
    }
    this.runtime.latestExecutorId = executorId
    input.reportNativeWork({ executorId, state: 'unknown' })
    this.runtime.activeControllers.add(controller)
    let endInput: (() => void) | undefined
    const inputEnded = new Promise<void>((resolve) => {
      endInput = resolve
    })
    let resolveExit: (() => void) | undefined,
      exitCode: number | null | undefined,
      exitSignal: NodeJS.Signals | null | undefined,
      spawnFailed = false
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    let child: ReturnType<typeof spawn> | undefined,
      rawPending = '',
      rawUnconfirmed = false,
      settingsResolve: ((settings: object) => void) | undefined,
      settingsReject: ((error: Error) => void) | undefined
    const rawDecoder = new StringDecoder('utf8')
    const settingsRequestId = `pact-fork-settings-${randomUUID()}`
    const settings = new Promise<object>((resolve, reject) => {
      settingsResolve = resolve
      settingsReject = reject
    })
    void settings.catch(() => undefined)
    const onStdout = (data: Buffer): void => {
      rawPending += rawDecoder.write(data)
      if (Buffer.byteLength(rawPending) > 8 * 1024 * 1024) {
        rawUnconfirmed = true
        rawPending = ''
        return
      }
      for (;;) {
        const newline = rawPending.indexOf('\n')
        if (newline < 0) break
        const line = rawPending.slice(0, newline)
        rawPending = rawPending.slice(newline + 1)
        try {
          const message = JSON.parse(line)
          if (
            message.type === 'control_response' &&
            message.response?.request_id === settingsRequestId &&
            message.response?.subtype === 'error'
          )
            settingsReject?.(new Error('Claude native settings control was rejected.'))
          if (
            message.type === 'control_response' &&
            message.response?.request_id === settingsRequestId &&
            message.response?.subtype === 'success' &&
            message.response.response &&
            typeof message.response.response === 'object'
          )
            settingsResolve?.(message.response.response)
        } catch {
          rawUnconfirmed = true
        }
      }
    }
    let session: ReturnType<typeof query> | undefined
    try {
      session = this.runtime.dependencies.query({
        // oxlint-disable-next-line require-yield -- Closing this empty input initializes without submitting any model prompt.
        prompt: (async function* (): AsyncIterable<SDKUserMessage> {
          await inputEnded
        })(),
        options: {
          cwd: input.cwd,
          resume: candidate.nativeSessionId,
          persistSession: true,
          abortController: controller,
          pathToClaudeCodeExecutable: this.runtime.executablePath,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          includeHookEvents: true,
          ...permissionOptions(input.permissionMode),
          ...(input.model ? { model: input.model } : {}),
          ...explicitEffortOptions(input.effort),
          canUseTool: permissionHandler(input, controller.signal, permissionWait),
          onElicitation: elicitationHandler(input, controller.signal, permissionWait),
          spawnClaudeCodeProcess: (specification) => {
            const spawned = (this.runtime.dependencies.spawn ?? spawn)(
              specification.command,
              specification.args,
              {
                cwd: specification.cwd,
                env: specification.env,
                signal: specification.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
              },
            )

            child = spawned
            const stderr = spawned.stderr
            if (stderr) {
              const ignoreStderrError = (): void => {
                stderr.resume()
              }
              stderr.on('error', ignoreStderrError)
              stderr.resume()
              spawned.once('close', () => {
                stderr.pause()
                stderr.off('error', ignoreStderrError)
              })
            }
            child.stdout?.on('data', onStdout)
            child.once('exit', (code, nativeSignal) => {
              exitCode = code
              exitSignal = nativeSignal
              settingsReject?.(
                new Error('Claude native settings control ended without an acknowledgement.'),
              )
              resolveExit?.()
            })
            child.once('error', () => {
              spawnFailed = spawned.pid === undefined
              if (spawnFailed) input.reportNativeWork({ executorId, state: 'settled' })
              rawUnconfirmed = true
              settingsReject?.(new Error('Claude native settings transport failed.'))
              resolveExit?.()
            })
            return spawned
          },
        },
      })
      this.runtime.activeSessions.add(session)
      this.runtime.forkInitializing.delete(input.operationId)
      this.runtime.backgroundRuns.set(input.operationId, {
        observation,
        recordings: new Set(),
        executorId,
      })
      const owned = session
      const work = (async (): Promise<AgentNativeForkResult> => {
        const consume = (async () => {
          for await (const message of owned) {
            if (message.session_id !== candidate.nativeSessionId)
              throw new Error('Claude Fork initialization changed its native identity.')
            nativeWork.observe(message)
          }
        })()
        let controlFailure: unknown
        try {
          const initialization = await owned.initializationResult()
          if (input.permissionMode === 'auto') await confirmAutoMode(owned, observation.signal)
          else if (input.permissionMode !== 'native')
            await owned.setPermissionMode(
              input.permissionMode === 'full' ? 'bypassPermissions' : 'default',
            )
          else if (typeof Reflect.get(initialization, 'current_permission_mode') !== 'string')
            throw new Error('Claude did not acknowledge its native permission mode.')
          if (input.effort)
            await owned.applyFlagSettings({ effortLevel: parseClaudeEffort(input.effort)! })
          // This provider control protocol has no public SDK wrapper. It is an exact,
          // bounded read-only request on our owned subprocess, never a model prompt.
          if (!child?.stdin) throw new Error('Claude Fork has no owned control transport.')
          child.stdin.write(
            JSON.stringify({
              type: 'control_request',
              request_id: settingsRequestId,
              request: { subtype: 'get_settings' },
            }) + '\n',
          )
          const applied = Reflect.get(await settings, 'applied')
          const effectiveModel =
            applied && typeof applied === 'object' ? Reflect.get(applied, 'model') : undefined
          const effectiveEffort =
            applied && typeof applied === 'object' ? Reflect.get(applied, 'effort') : undefined
          const modelRow = initialization.models.find((model) => model.value === input.model)
          const wireModel = modelRow && Reflect.get(modelRow, 'resolvedModel')
          if (
            typeof effectiveModel !== 'string' ||
            (input.model && effectiveModel !== input.model && effectiveModel !== wireModel) ||
            (input.effort && effectiveEffort !== input.effort)
          )
            throw new Error(
              'Claude did not confirm the requested model and effort without a fallback.',
            )
        } catch (error) {
          controlFailure = error
        } finally {
          endInput?.()
        }
        await consume
        await exited
        if (
          exitCode !== 0 ||
          exitSignal != null ||
          controller.signal.aborted ||
          this.runtime.disposed ||
          nativeWork.pending ||
          permissionWait.waiting ||
          rawUnconfirmed
        )
          throw new Error(
            'Claude Fork initialization is not confirmed naturally settled; its candidate was preserved.',
          )
        input.reportNativeWork({ executorId, state: 'settled' })
        if (controlFailure) throw controlFailure
        const prefix = await this.runtime.nativeForkFiles.execute(
          {
            provider: 'claude',
            action: 'inspect',
            cwd: input.cwd,
            nativeSessionId: candidate.nativeSessionId,
            witness: candidate.witness,
          },
          observation.signal,
        )
        const witness = {
          ...candidate.witness,
          initializedAt: new Date().toISOString(),
          initializedPrefixHash: prefix.rawHash,
          initializedPrefixBytes: prefix.rawBytes,
          initializedPrefixRecords: prefix.rawRecords,
        }
        await input.onCandidate(candidate.nativeSessionId, witness)
        return { nativeSessionId: candidate.nativeSessionId, witness }
      })()
      const settled = work.finally(() => {
        child?.stdout?.removeListener('data', onStdout)
        if (exitCode !== undefined || spawnFailed) {
          this.runtime.activeSessions.delete(owned)
          this.runtime.activeControllers.delete(controller)
          this.runtime.backgroundRuns.delete(input.operationId)
          observation.abort()
        }
      })
      const retained = settled.then(
        () => undefined,
        () => undefined,
      )
      this.runtime.backgroundDrains.add(retained)
      void retained.finally(() => this.runtime.backgroundDrains.delete(retained))
      return await withDeadline(settled, 10_000, signal)
    } catch (error) {
      this.runtime.forkInitializing.delete(input.operationId)
      endInput?.()
      if (!session) {
        this.runtime.activeControllers.delete(controller)
        observation.abort()
      }
      throw classifyAgentError(error)
    }
  }

  probeNativeStatus(input: AgentNativeProbeInput, signal: AbortSignal): Promise<NativeProbeResult> {
    return this.beginNativeStatusCheck(input, signal).result
  }

  beginNativeStatusCheck(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<NativeProbeResult> {
    return this.runtime.nativeCheck.begin(
      signal,
      (checkSignal) => this.readNativeStatus(input, checkSignal),
      context,
    )
  }

  private async readNativeStatus(
    input: AgentNativeProbeInput,
    signal: AbortSignal,
  ): Promise<NativeProbeResult> {
    if (input.target === 'initialized_binding') {
      const identity: NativeEvidenceIdentity = {
        sessionId: input.sessionId,
        agentId: input.agentId,
        requestId: input.requestId,
        nativeSessionId: input.nativeSessionId,
        bindingGeneration: input.bindingGeneration,
      }
      try {
        if (
          [...this.runtime.nativeEvidence.values()].some(
            (value) =>
              value.identity.nativeSessionId === input.nativeSessionId &&
              ['running', 'waiting_user'].includes(value.kind),
          ) ||
          [...this.runtime.nativeRebuildReceipts.values()].some(
            (value) => value.nativeSessionId === input.nativeSessionId && !value.seedHash,
          )
        )
          throw new Error('The native binding has unsettled owned work.')
        const { expected } = await ClaudeLifecycleCoordinator.prepareNativeSeed(
          {
            rebuildId: input.confirmedInitialization.rebuildId,
            sessionId: input.sessionId,
            cwd: input.cwd,
            model: input.model,
            effort: input.effort,
            sourceHash: input.confirmedInitialization.sourceHash,
          },
          input.source,
          signal,
          false,
        )
        await this.verifyNativeSeed(input.nativeSessionId, input.cwd, expected, signal, true)
        return {
          kind: 'binding_ready',
          source: 'completed_initialization_readback',
          identity,
          rebuildId: input.confirmedInitialization.rebuildId,
          sourceHash: input.confirmedInitialization.sourceHash,
        }
      } catch (error) {
        return {
          kind: 'no_evidence',
          identity,
          reason: safeNativePermissionText(
            `Native initialization readback failed: ${error instanceof Error ? error.message : 'No reliable response.'}`,
            240,
          ),
        }
      }
    }
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
    const identity: NativeEvidenceIdentity = {
      sessionId,
      agentId,
      requestId,
      nativeSessionId,
      bindingGeneration,
      ...(runId ? { runId } : {}),
      ...(nativeTurnId ? { nativeTurnId } : {}),
      ...(executorId ? { executorId } : {}),
    }
    const cached = this.runtime.nativeEvidence.get(requestId)
    const known = cached
    if (known) {
      this.runtime.nativeEvidence.delete(requestId)
      this.runtime.nativeEvidence.set(requestId, known)
    }
    if (
      !input.inspectMissingPlan &&
      known &&
      known.identity.nativeSessionId === nativeSessionId &&
      known.identity.bindingGeneration === bindingGeneration &&
      executorId === this.runtime.backgroundRuns.get(requestId)?.executorId &&
      this.runtime.backgroundRuns.has(requestId) &&
      (known.kind !== 'ended' || known.output?.completeness === 'complete')
    )
      return {
        ...known,
        identity: {
          ...known.identity,
          ...identity,
          ...(known.identity.executorId ? { executorId: known.identity.executorId } : {}),
        },
      }
    const persisted = input.confirmedTerminal
    const terminal =
      known?.kind === 'ended'
        ? known
        : persisted?.kind === 'ended' &&
            persisted.source === 'stored_terminal' &&
            persisted.identity.agentId === this.runtime.id &&
            persisted.identity.sessionId === sessionId &&
            persisted.identity.runId === runId &&
            runId !== undefined &&
            persisted.identity.requestId === requestId &&
            persisted.identity.nativeSessionId === nativeSessionId &&
            persisted.identity.bindingGeneration === bindingGeneration &&
            persisted.identity.nativeTurnId === nativeTurnId &&
            persisted.identity.executorId === executorId
          ? persisted
          : undefined
    const verifiedTerminal =
      terminal &&
      terminal.identity.nativeSessionId === nativeSessionId &&
      terminal.identity.bindingGeneration === bindingGeneration
        ? {
            ...terminal,
            source: 'stored_terminal' as const,
            identity: {
              ...terminal.identity,
              ...identity,
              ...(terminal.identity.executorId ? { executorId: terminal.identity.executorId } : {}),
            },
          }
        : undefined
    try {
      if (nativeTurnId) {
        const recovered = await this.runtime.nativeForkFiles.readAnswer(
          {
            cwd: input.cwd,
            nativeSessionId,
            nativeTurnId,
            includePlan: Boolean(input.planSource || input.inspectMissingPlan),
            ...(input.planSource || input.inspectMissingPlan
              ? { planCheckpoint: input.planCheckpoint }
              : {}),
            ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
          },
          signal,
        )
        const output =
          recovered.answer !== undefined ||
          recovered.plan ||
          recovered.retainedPlan ||
          recovered.planUnavailable ||
          recovered.reviewResult
            ? {
                outputId: `${requestId}:assistant`,
                text: recovered.answer ?? '',
                ...(recovered.plan ? { plan: recovered.plan } : {}),
                ...(recovered.retainedPlan ? { retainedPlan: recovered.retainedPlan } : {}),
                ...(recovered.planUnavailable ? { planUnavailable: true as const } : {}),
                ...(recovered.reviewResult ? { reviewResult: recovered.reviewResult } : {}),
                completeness:
                  verifiedTerminal?.outcome === 'completed'
                    ? ('complete' as const)
                    : ('partial' as const),
              }
            : undefined
        if (verifiedTerminal) {
          const result = { ...verifiedTerminal, ...(output ? { output } : {}) }
          // A fresh, authenticated source supersedes an earlier hook capture failure.
          if (!recovered.planUnavailable && (recovered.plan || recovered.retainedPlan))
            delete result.planUnavailable
          return result
        }
        return {
          kind: 'no_evidence',
          identity,
          reason: 'The stored answer does not prove a native ending.',
          ...(output ? { output } : {}),
        }
      }

      return {
        kind: 'no_evidence',
        identity,
        reason:
          'The exact native root input identity is unavailable. No transcript fallback was opened.',
      }
    } catch (error) {
      if (verifiedTerminal && !signal.aborted) {
        try {
          if (
            await this.runtime.nativeForkFiles.exists({ cwd: input.cwd, nativeSessionId }, signal)
          ) {
            if (input.inspectMissingPlan) {
              const output = verifiedTerminal.output
              return {
                ...verifiedTerminal,
                planUnavailable: true,
                ...(output
                  ? {
                      output: {
                        outputId: output.outputId,
                        text: output.text,
                        completeness: output.completeness,
                        ...(output.reviewResult ? { reviewResult: output.reviewResult } : {}),
                      },
                    }
                  : {}),
              }
            }
            return verifiedTerminal
          }
        } catch {
          /* A missing, unsafe or unconfirmed source cannot reconfirm this binding. */
        }
      }
      return {
        kind: 'no_evidence',
        identity,
        reason: safeNativePermissionText(
          `Native status check failed: ${error instanceof Error ? error.message : 'No reliable response.'}`,
          240,
        ),
      }
    }
  }

  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult> {
    if (this.runtime.disposed || signal.aborted)
      throw new AgentExecutionError(
        'agent_process_crash',
        'Claude Code rebuild was cancelled before creation.',
        false,
      )
    if (
      this.runtime.backgroundRuns.size + this.runtime.forkInitializing.size >=
      MAX_NATIVE_CLAUDE_QUERIES
    )
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Claude Code has too many owned native queries. No new query was started.',
        false,
      )
    if (!input.nativeSessionId || !isRequestUuid(input.nativeSessionId))
      throw new AgentExecutionError(
        'protocol_error',
        'A persisted candidate Native Session identity is required before rebuilding.',
        false,
      )
    const nativeSessionId = input.nativeSessionId
    const { seeds, expected, seedHash, reservation } =
      await ClaudeLifecycleCoordinator.prepareNativeSeed(input, source, signal)
    const controller = new AbortController()
    const observation = new AbortController()
    const recordings = new Set<Promise<void>>()
    const permissionWait = new NativePermissionWait()
    const accepted = new Set<string>()
    const nativeWork = new ClaudeNativeWork()
    let runtimeUnconfirmed = false
    let initializationUnconfirmed = false
    let modelActive = false
    let modelRequestId: string | undefined
    let initialized = false
    let created = false
    let exitCode: number | null | undefined
    let exitSignal: NodeJS.Signals | null | undefined
    let resolveExit: (() => void) | undefined
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    const nativeExecutorId = randomUUID()
    try {
      await input.onNativeCreationDispatched?.(nativeExecutorId)
    } catch (error) {
      reservation?.release()
      throw error
    }
    this.runtime.latestExecutorId = nativeExecutorId
    this.runtime.activeControllers.add(controller)
    let session: ReturnType<typeof query> | undefined
    let workFinished = false
    let spawnFailed = false
    let confirmPermissionInput: ((confirmed: boolean) => void) | undefined
    const permissionInput =
      input.permissionMode === 'auto'
        ? new Promise<boolean>((resolve) => {
            confirmPermissionInput = resolve
          })
        : undefined
    const releaseSettledResources = (): void => {
      if (!workFinished || !session || (exitCode === undefined && !spawnFailed)) return
      reservation?.release()
      this.runtime.activeSessions.delete(session)
      this.runtime.activeControllers.delete(controller)
      this.runtime.backgroundRuns.delete(input.rebuildId)
      observation.abort()
    }
    try {
      session = this.runtime.dependencies.query({
        prompt: (async function* (): AsyncIterable<SDKUserMessage> {
          if (permissionInput && !(await permissionInput)) return
          for (const seed of seeds)
            yield {
              type: 'user',
              uuid: seed.uuid,
              session_id: nativeSessionId,
              parent_tool_use_id: null,
              shouldQuery: false,
              message: { role: 'user', content: seed.content },
            }
        })(),
        options: {
          abortController: controller,
          cwd: input.cwd,
          sessionId: nativeSessionId,
          persistSession: true,
          settingSources: ['user', 'project', 'local'],
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          pathToClaudeCodeExecutable: this.runtime.executablePath,
          ...permissionOptions(input.permissionMode),
          includeHookEvents: true,
          canUseTool: permissionHandler(input, controller.signal, permissionWait),
          onElicitation: elicitationHandler(input, controller.signal, permissionWait),
          ...(input.model ? { model: input.model } : {}),
          ...explicitEffortOptions(input.effort),
          // Pass through SDK-selected executable, arguments, environment and its
          // graceful-close signal. No sandbox/permission/feature override.
          spawnClaudeCodeProcess: (specification) => {
            const child = (this.runtime.dependencies.spawn ?? spawn)(
              specification.command,
              specification.args,
              {
                cwd: specification.cwd,
                env: specification.env,
                signal: specification.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
              },
            )

            const stderr = child.stderr
            if (stderr) {
              const ignoreStderrError = (): void => {
                stderr.resume()
              }
              stderr.on('error', ignoreStderrError)
              stderr.resume()
              child.once('close', () => {
                stderr.pause()
                stderr.off('error', ignoreStderrError)
              })
            }
            child.once('exit', (code, nativeSignal) => {
              exitCode = code
              exitSignal = nativeSignal
              resolveExit?.()
              releaseSettledResources()
            })
            child.once('error', () => {
              runtimeUnconfirmed = true
              spawnFailed = child.pid === undefined
              resolveExit?.()
              releaseSettledResources()
            })
            return child
          },
        },
      })
      this.runtime.activeSessions.add(session)
      this.runtime.backgroundRuns.set(input.rebuildId, {
        observation,
        recordings,
        executorId: nativeExecutorId,
      })
      const ownedSession = session
      const work = (async (): Promise<AgentNativeContextRebuildResult> => {
        for await (const message of ownedSession) {
          if (message.session_id !== nativeSessionId)
            throw new AgentExecutionError(
              'protocol_error',
              'Claude Code rebuild returned a different Native Session identity.',
              false,
            )
          nativeWork.observe(message)
          if (message.type === 'system') {
            if (message.subtype === 'init') {
              initialized = true
              if (!created) {
                created = true
                await input.onNativeSessionCreated?.(nativeSessionId)
              }
            } else if (message.subtype === 'session_state_changed')
              modelActive = message.state !== 'idle'
          }
          if (message.type === 'assistant' || message.type === 'stream_event') {
            modelActive = true
            const echoed = Reflect.get(message, 'user_message_uuid')
            if (typeof echoed === 'string') modelRequestId = echoed
          }
          if (message.type === 'result') {
            const ids =
              message.user_message_uuids ??
              (message.user_message_uuid ? [message.user_message_uuid] : [])
            const exact = ids.length > 0 && ids.length <= 64 && ids.every((id) => expected.has(id))
            // Statistics may include other native Hook activity. The guarantee
            // is our false-only input plus exact append receipts, full durable
            // content readback and this creating Query's actual natural end.
            const appendAccepted = message.subtype === 'success' && !message.is_error
            if (exact) {
              if (!appendAccepted) initializationUnconfirmed = true
              else for (const id of ids) accepted.add(id)
            }
            // A raw result in this newly created Query can settle its own Hook
            // Turn, but is never an old Run receipt or an expected seed ACK.
            if (!exact && modelRequestId && ids.includes(modelRequestId)) modelActive = false
          }
        }
        // Natural iterator EOF is not enough on its own: also observe this
        // exact CLI's natural successful exit, without close/abort/kill.
        await exited
        // Successful natural shutdown of this creating CLI can settle its own
        // initialization activity, never an older executor's task. Seed-only
        // ACKs above cannot clear another Hook's running model state.
        if (exitCode === 0 && exitSignal == null) modelActive = false
        const workSettled =
          !this.runtime.disposed &&
          !controller.signal.aborted &&
          exitCode === 0 &&
          exitSignal == null &&
          !runtimeUnconfirmed &&
          !modelActive &&
          !nativeWork.pending &&
          !permissionWait.waiting
        if (workSettled)
          input.reportNativeWork?.({
            executorId: nativeExecutorId,
            nativeSessionId,
            state: 'settled',
          })
        if (
          !workSettled ||
          !initialized ||
          !created ||
          initializationUnconfirmed ||
          accepted.size !== expected.size
        )
          throw new AgentExecutionError(
            'runtime_incompatible',
            'Claude Code initialization did not provide complete, settled transcript-only receipts. Its Native Session was preserved.',
            false,
          )
        await this.verifyNativeSeed(nativeSessionId, input.cwd, expected, observation.signal)
        this.rememberNativeRebuild(input.rebuildId, {
          nativeSessionId,
          ...(input.sourceHash ? { sourceHash: input.sourceHash } : {}),
          seedHash,
          cwd: input.cwd,
          executorId: nativeExecutorId,
        })
        return { nativeSessionId }
      })()
      const settled = work.finally(() => {
        // A validated natural EOF/exit releases resources. On a lost stream
        // without actual exit, retain the slot until explicit disposal.
        workFinished = true
        releaseSettledResources()
      })
      const retained = settled.then(
        () => undefined,
        () => undefined,
      )
      this.runtime.backgroundDrains.add(retained)
      void retained.finally(() => this.runtime.backgroundDrains.delete(retained))
      if (permissionInput) {
        await confirmAutoMode(session, signal)
        confirmPermissionInput?.(true)
      }
      // This deadline only bounds this Pact operation. The native Query stays
      // owned and continues on timeout/cancellation; it is never timed out/killed.
      return await withDeadline(settled, 10_000, signal)
    } catch (error) {
      // End empty input naturally; never abort startup Hooks on a mode refusal.
      confirmPermissionInput?.(false)
      if (!session) {
        reservation?.release()
        this.runtime.activeControllers.delete(controller)
        observation.abort()
      }
      throw classifyAgentError(error)
    }
  }

  inspectNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    return this.beginNativeRebuildCheck(input, source, signal).result
  }

  beginNativeRebuildCheck(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    context?: AgentNativeCheckContext,
  ): AgentNativeCheckOperation<AgentNativeContextRebuildResult | undefined> {
    return this.runtime.nativeCheck.begin(
      signal,
      (checkSignal) => this.readNativeRebuild(input, source, checkSignal),
      context,
    )
  }

  private async readNativeRebuild(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
  ): Promise<AgentNativeContextRebuildResult | undefined> {
    if (this.runtime.disposed || signal.aborted || !input.nativeSessionId) return undefined
    const { expected, seedHash } = await ClaudeLifecycleCoordinator.prepareNativeSeed(
      input,
      source,
      signal,
      false,
    )
    try {
      // Always perform the available pure native readback; existence alone
      // cannot establish another Query's initialization state.
      await this.verifyNativeSeed(input.nativeSessionId, input.cwd, expected, signal)
      const receipt = this.runtime.nativeRebuildReceipts.get(input.rebuildId)
      if (
        !receipt ||
        receipt.nativeSessionId !== input.nativeSessionId ||
        receipt.cwd !== input.cwd ||
        receipt.sourceHash !== input.sourceHash ||
        receipt.seedHash !== seedHash
      )
        return undefined
      return { nativeSessionId: input.nativeSessionId }
    } catch {
      return undefined
    }
  }

  private static async prepareNativeSeed(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
    signal: AbortSignal,
    includeImages = true,
  ) {
    // Source manifests retain the existing text/metadata budget; pixels are separate Native blocks.
    const chunks: NativeContextRebuildChunk[] = []
    let sourceBytes = 0
    for await (const chunk of source) {
      if (signal.aborted)
        throw new AgentExecutionError(
          'agent_process_crash',
          'Claude Code rebuild preparation was cancelled.',
          false,
        )
      sourceBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (chunks.length >= 4096 || sourceBytes > 8 * 1024 * 1024)
        throw new AgentExecutionError(
          'response_too_large',
          'The full native rebuild source exceeds Pact’s technical source budget; it was not truncated.',
          false,
        )
      chunks.push(chunk)
    }
    const images = chunks.filter((chunk) => chunk.kind === 'image')
    const format = images.length ? 'pact-native-context-v2' : 'pact-native-context-v1'
    const manifest = JSON.stringify({
      pactContext: true,
      formatVersion: format,
      pactRebuildId: input.rebuildId,
      pactSourceHash: input.sourceHash,
      chunks,
    })
    const digest = createHash('sha256')
      .update(input.rebuildId)
      .update(images.length ? ':context:v2' : ':context:v1')
      .digest('hex')
    const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
    if (!isRequestUuid(uuid)) throw new Error('Invalid seed identity.')
    if (Buffer.byteLength(manifest, 'utf8') > 8 * 1024 * 1024)
      throw new AgentExecutionError(
        'response_too_large',
        'The complete native context exceeds its technical source budget; no history was truncated.',
        false,
      )
    const hash = createHash('sha256').update(manifest).digest('hex')
    let content: SDKUserMessage['message']['content'] = manifest
    let reservation: NativeMemoryReservation | undefined
    if (includeImages && images.length) {
      if (!input.resolveImage)
        throw new AgentExecutionError(
          'protocol_error',
          'The Pact image source is unavailable.',
          false,
        )
      const resolved = []
      for (const chunk of images) {
        // oxlint-disable-next-line no-await-in-loop -- Resolve immutable sources in manifest order.
        const image = await input.resolveImage(chunk.image.id, signal)
        requireNativeImageReference(image, chunk.image)
        resolved.push(image)
      }
      reservation = new NativeWorkingMemory().reserve(
        freezeNativeJsonFrame(chunks) +
          manifest.length * 12 +
          nativeImagePreparationBytes(resolved) +
          256 * 1024,
      )
      try {
        const blocks: Array<{ type: 'text'; text: string } | NativeImageBlock> = [
          { type: 'text', text: manifest },
        ]
        for (const image of resolved) {
          // oxlint-disable-next-line no-await-in-loop -- Keep one image read buffer and exact source order.
          blocks.push(await nativeImageBlock(image, signal))
        }
        content = blocks
      } catch (error) {
        reservation.release()
        throw error
      }
    }
    const message: SDKUserMessage = {
      type: 'user',
      uuid,
      session_id: input.nativeSessionId ?? '00000000-0000-0000-0000-000000000000',
      parent_tool_use_id: null,
      shouldQuery: false,
      message: { role: 'user', content },
    }
    try {
      if (
        !images.length &&
        Buffer.byteLength(`${JSON.stringify(message)}\n`, 'utf8') > 8 * 1024 * 1024
      )
        throw new AgentExecutionError(
          'response_too_large',
          'The encoded native input exceeds its technical source budget; no history was truncated.',
          false,
        )
      const seeds = [{ uuid, content, hash }]
      return {
        seeds,
        expected: new Map<string, { hash: string; images: number }>([
          [uuid, { hash, images: images.length }],
        ]),
        seedHash: hash,
        reservation,
      }
    } catch (error) {
      reservation?.release()
      throw error
    }
  }

  private async verifyNativeSeed(
    nativeSessionId: string,
    cwd: string,
    expected: Map<string, { hash: string; images: number }>,
    signal: AbortSignal,
    rejectAdditionalWork = false,
  ): Promise<void> {
    await this.runtime.nativeForkFiles.verifySeed(
      { cwd, nativeSessionId, expected, rejectAdditionalWork },
      signal,
    )
  }

  private rememberNativeRebuild(
    id: string,
    value: {
      nativeSessionId: string
      sourceHash?: string
      seedHash: string
      cwd: string
      executorId: string
    },
  ): void {
    if (this.runtime.disposed) return
    this.runtime.nativeRebuildReceipts.delete(id)
    this.runtime.nativeRebuildReceipts.set(id, value)
    while (
      this.runtime.nativeRebuildReceipts.size > 8 ||
      Buffer.byteLength(JSON.stringify([...this.runtime.nativeRebuildReceipts]), 'utf8') > 64 * 1024
    )
      this.runtime.nativeRebuildReceipts.delete(
        this.runtime.nativeRebuildReceipts.keys().next().value!,
      )
  }

  async discoverSkills(cwd: string, signal: AbortSignal): Promise<SkillBinding[]> {
    if (this.runtime.hasActiveBackgroundWork())
      throw new Error(
        'Claude Code is busy. Its native Skill catalog can be refreshed when current work settles.',
      )
    signal.throwIfAborted()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 10_000)
    this.runtime.activeControllers.add(controller)
    let session: ReturnType<typeof query> | undefined
    const actorClosed: Promise<void>[] = []
    let zeroQueryResult = false
    try {
      session = this.runtime.dependencies.query({
        prompt: (async function* () {
          // A non-command, zero-query metadata input supplies the authoritative Skill-only init list.
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content: 'Pact native Skill metadata.' },
            parent_tool_use_id: null,
            session_id: '',
            uuid: randomUUID(),
            shouldQuery: false,
          }
        })(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: this.runtime.executablePath,
          abortController: controller,
          settingSources: ['user', 'project', 'local'],
          persistSession: false,
          spawnClaudeCodeProcess: (options) => {
            const child = (this.runtime.dependencies.spawn ?? spawn)(
              options.command,
              options.args,
              {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: false,
              },
            )

            drainStderr(child)
            actorClosed.push(new Promise<void>((resolve) => child.once('close', () => resolve())))
            let lineBytes = 0
            child.stdout.on('data', (chunk: Buffer) => {
              for (const byte of chunk) {
                if (byte === 10) lineBytes = 0
                else if (++lineBytes > 1_024 * 1_024) {
                  controller.abort()
                  child.kill()
                  break
                }
              }
            })
            return child
          },
        },
      })
      this.runtime.activeSessions.add(session)
      const commands = await session.supportedCommands()
      let skills: string[] | undefined
      for await (const message of session) {
        controller.signal.throwIfAborted()
        if (message.type === 'system' && message.subtype === 'commands_changed') {
          this.runtime.skillCatalogChanged?.()
          throw new Error('The native Skill catalog changed during discovery.')
        }
        if (message.type === 'system' && message.subtype === 'init') skills = message.skills
        if (message.type === 'result') {
          if (message.is_error || message.num_turns !== 0)
            throw new Error(
              'Claude Skill discovery did not settle as a zero-query metadata operation.',
            )
          zeroQueryResult = true
        }
      }
      await Promise.all(actorClosed)
      if (!zeroQueryResult)
        throw new Error('Native Skill metadata did not reach a settled zero-query EOF.')
      if (!skills) throw new Error('Claude Code did not provide an authoritative Skill list.')
      const names = new Set(skills)
      return nativeSkillCatalog(
        'claude',
        cwd,
        this.runtime.executablePath,
        commands.filter((entry) => names.has(entry.name)),
      )
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      controller.abort()
      if (session) {
        await session[Symbol.asyncDispose]()
        await Promise.all(actorClosed)
        this.runtime.activeSessions.delete(session)
      }
      this.runtime.activeControllers.delete(controller)
    }
  }

  async sessionTitle(sessionId: string, cwd: string): Promise<string | undefined> {
    try {
      const session = await this.runtime.dependencies.getSessionInfo(sessionId, { dir: cwd })
      const title = session?.summary.trim().slice(0, 120)
      return title && !title.includes('"version":"pact-agent-prompt-v1"') ? title : undefined
    } catch {
      return undefined
    }
  }
}
