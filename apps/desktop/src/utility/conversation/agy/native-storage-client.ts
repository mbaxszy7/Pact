import type { AgentNativeForkBoundary, AgentPromptImage } from '@pact/agent-runtime'

import {
  agyRebuildInitializationWitnessSchema,
  type NativeContextRebuildChunk,
  type NativeProbeResult,
  type SessionPermissionMode,
} from '@pact/contracts'

import type {
  AgyTrajectoryIdentityClientResult,
  AgyTrajectoryIdentityWorkerResult,
  NativeForkFileResult,
} from '../native-fork-files'
import type { AgyCompletedPactPublishPlanCall, AgyNativeStorageClient } from './types'

import { resolveAgyAppDataDir } from '../agy-native-storage'
import { safeNativePermissionText } from '../native-permission-wait'

export function resolveEffectiveAgyAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveAgyAppDataDir(env)
}

export interface AgyColdLoadConfirmInput {
  cwd: string
  appDataDir?: string | undefined
  storageRoot?: string | undefined
  nativeSessionId: string
  sourceHash: string
  pbSha256: string
  pbBytes: number
  stepCount: 2
}

export interface AgyColdLoadStorageClient extends AgyNativeStorageClient {
  writeRebuildSeed(
    input: Parameters<NonNullable<AgyNativeStorageClient['writeRebuildSeed']>>[0],
    signal: AbortSignal,
  ): Promise<
    Awaited<ReturnType<NonNullable<AgyNativeStorageClient['writeRebuildSeed']>>> & {
      pbSha256: string
      pbBytes: number
    }
  >
  confirmRebuildColdLoad(
    input: AgyColdLoadConfirmInput,
    signal: AbortSignal,
  ): Promise<import('@pact/agent-runtime').AgyRebuildInitializationWitness>
  inspectRebuildSeed: NonNullable<AgyNativeStorageClient['inspectRebuildSeed']>
}

export function isVerifiedAgyRebuildWitness(
  value: unknown,
  expectedNativeSessionId: string,
  expectedSourceHash?: string,
): value is import('@pact/agent-runtime').AgyRebuildInitializationWitness {
  const parsed = agyRebuildInitializationWitnessSchema.safeParse(value)
  if (!parsed.success) return false
  if (parsed.data.nativeSessionId !== expectedNativeSessionId) return false
  if (expectedSourceHash !== undefined && parsed.data.sourceHash !== expectedSourceHash) {
    return false
  }
  return true
}

export interface AgyCapableForkFiles {
  execute(
    input: {
      provider: 'agy'
      action: 'prepare' | 'inspect'
      cwd: string
      nativeSessionId: string
      nativeTurnId?: string
      nativeInputIds?: readonly string[]
      responseHash?: string
      source?: AgentNativeForkBoundary
      witness?: import('@pact/agent-runtime').AgentNativeForkWitness
      lastDispatchedPhase?: 'fork' | 'initialize'
      storageRoot?: string
    },
    signal: AbortSignal,
  ): Promise<NativeForkFileResult>
  prepareAgyBoundary(
    input: Omit<import('@pact/agent-runtime').AgentNativeForkSourceInput, 'runId'> & {
      runId?: string
      storageRoot?: string
    },
    signal: AbortSignal,
  ): Promise<AgentNativeForkBoundary>
  exists(
    input: {
      cwd: string
      nativeSessionId: string
      provider?: 'claude' | 'agy'
      storageRoot?: string
    },
    signal: AbortSignal,
  ): Promise<boolean>
  forkAgy(
    input: {
      cwd: string
      storageRoot?: string
      candidateNativeSessionId: string
      source: AgentNativeForkBoundary
      model: string | null
      effort: string | null
      permissionMode: SessionPermissionMode
      onCandidate?: (
        nativeSessionId: string,
        witness: import('@pact/agent-runtime').AgentNativeForkWitness,
      ) => Promise<void>
    },
    signal: AbortSignal,
  ): Promise<{
    nativeSessionId: string
    witness: import('@pact/agent-runtime').AgentNativeForkWitness
    file: NativeForkFileResult
  }>
  rebuildAgySeed(
    input: {
      cwd: string
      storageRoot?: string
      nativeSessionId: string
      rebuildId: string
      sourceHash?: string
      chunks: readonly NativeContextRebuildChunk[]
      images?: readonly AgentPromptImage[]
    },
    signal: AbortSignal,
  ): Promise<{
    nativeSessionId: string
    seedHash: string
    chunkCount: number
    stepCount: number
    pbSha256?: string
    pbBytes?: number
    verifiedPrefixBytes: number
    verifiedPrefixSha256: string
    initializationWitness?: import('@pact/agent-runtime').AgyRebuildInitializationWitness
  }>
  verifyAgySeed(
    input: {
      cwd: string
      storageRoot?: string
      nativeSessionId: string
      rebuildId: string
      sourceHash?: string
      chunks: readonly NativeContextRebuildChunk[]
      rejectAdditionalWork?: boolean
    },
    signal: AbortSignal,
  ): Promise<{
    nativeSessionId: string
    seedHash: string
    chunkCount: number
    stepCount: number
    pbSha256?: string
    pbBytes?: number
    verifiedPrefixBytes: number
    verifiedPrefixSha256: string
    initializationWitness?: import('@pact/agent-runtime').AgyRebuildInitializationWitness
  }>
  confirmAgyRebuildColdLoad?(
    input: {
      cwd: string
      storageRoot?: string | undefined
      appDataDir?: string | undefined
      nativeSessionId: string
      sourceHash: string
      pbSha256: string
      pbBytes: number
      stepCount: 2
    },
    signal: AbortSignal,
  ): Promise<import('@pact/agent-runtime').AgyRebuildInitializationWitness>
  inspectAgyRun(
    input: {
      cwd: string
      storageRoot?: string
      nativeSessionId: string
      nativeTurnId?: string
      nativeInputIds?: readonly string[]
      includePlan?: boolean
    },
    signal: AbortSignal,
  ): Promise<{
    exists: boolean
    stepCount: number
    terminalState?:
      | {
          executionId: string
          status: 'completed' | 'failed' | 'canceled' | 'running'
          consumedInputStepIds: readonly string[]
          consumedInputs: ReadonlyArray<{
            stepIndex: number
            stepId?: string | undefined
            clientMessageId?: string | undefined
            pactMessageId?: string | undefined
            pactRunId?: string | undefined
            textSha256: string
          }>
          answer: string
          responseHash: string
          plan?: { nativeId: string; text: string } | undefined
          planUnavailable?: true | undefined
          hasCompletedPactPublishPlan?: boolean | undefined
          completedPactPublishPlanCalls?: readonly AgyCompletedPactPublishPlanCall[] | undefined
          completedPactPublishPlanTokens?: readonly string[] | undefined
        }
      | undefined
  }>
  readAgyTrajectoryIdentity?(
    input: {
      cwd: string
      storageRoot?: string
      nativeSessionId: string
    },
    signal: AbortSignal,
  ): Promise<AgyTrajectoryIdentityWorkerResult>
}

function classifyAgyTrajectoryIdentityError(
  error: unknown,
): Extract<AgyTrajectoryIdentityClientResult, { status: 'timeout' | 'worker_error' }> {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const reason = safeNativePermissionText(rawMessage.trim(), 512) || undefined
  const isTimeout =
    (error instanceof Error && error.name === 'TimeoutError') ||
    /\b(?:timeout|timed out|deadline|already active)\b/iu.test(rawMessage)
  return {
    status: isTimeout ? 'timeout' : 'worker_error',
    ...(reason !== undefined ? { reason } : {}),
  }
}

export type AgyColdOpenPlanResolver = (
  runId: string,
  terminalState: {
    executionId: string
    status: 'completed' | 'failed' | 'canceled' | 'running'
    hasCompletedPactPublishPlan?: boolean | undefined
    completedPactPublishPlanCalls?: readonly AgyCompletedPactPublishPlanCall[] | undefined
    completedPactPublishPlanTokens?: readonly string[] | undefined
  },
  nativeSessionId?: string,
) => { plan: { nativeId: string; text: string } } | { planUnavailable: true } | undefined

export function stripCallKeyPrefix(callKey: string): string {
  return callKey.startsWith('call:')
    ? callKey.slice('call:'.length)
    : callKey.startsWith('token:')
      ? callKey.slice('token:'.length)
      : callKey
}

/**
 * Typed bridge from `AgyAgentAdapter`'s `AgyNativeStorageClient` seam onto `NativeForkFiles`
 * (`agy-native-storage.ts` / `native-fork-worker.ts`).
 */
export function createAgyNativeStorageClient(
  capable: AgyCapableForkFiles,
  defaultAppDataDir?: string,
  resolveColdOpenPlanIntent?: AgyColdOpenPlanResolver,
): AgyColdLoadStorageClient {
  return {
    async inspectRun(input, signal) {
      const storageRoot = input.appDataDir || defaultAppDataDir
      return capable.inspectAgyRun(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.nativeSessionId,
          ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
          ...(input.includePlan !== undefined ? { includePlan: input.includePlan } : {}),
        },
        signal,
      )
    },
    ...(capable.readAgyTrajectoryIdentity
      ? {
          async readTrajectoryIdentity(input, signal): Promise<AgyTrajectoryIdentityClientResult> {
            const storageRoot = input.appDataDir || defaultAppDataDir
            for (let busyAttempt = 0; busyAttempt < 4; busyAttempt += 1) {
              try {
                // oxlint-disable-next-line no-await-in-loop -- Bounded short retry strictly when shared fork worker is momentarily busy.
                const res = await capable.readAgyTrajectoryIdentity!(
                  {
                    cwd: input.cwd,
                    ...(storageRoot ? { storageRoot } : {}),
                    nativeSessionId: input.nativeSessionId,
                  },
                  signal,
                )
                if (res.status === 'ok') {
                  return {
                    status: 'ok',
                    trajectoryId: res.trajectoryId,
                    stepCount: res.stepCount,
                  }
                }
                return {
                  status: res.status,
                  ...(res.reason !== undefined ? { reason: res.reason } : {}),
                }
              } catch (error) {
                if (signal.aborted) throw error
                if (
                  busyAttempt < 3 &&
                  error instanceof Error &&
                  error.message.includes('already active')
                ) {
                  // oxlint-disable-next-line no-await-in-loop -- Bounded 15ms retry for active storage worker.
                  await new Promise<void>((resolveDelay, rejectDelay) => {
                    const onAbort = (): void => {
                      clearTimeout(timer)
                      rejectDelay(
                        signal.reason instanceof Error
                          ? signal.reason
                          : new Error('Operation was cancelled.'),
                      )
                    }
                    const timer = setTimeout(() => {
                      signal.removeEventListener('abort', onAbort)
                      resolveDelay()
                    }, 15)
                    timer.unref?.()
                    signal.addEventListener('abort', onAbort, { once: true })
                  })
                  continue
                }
                return classifyAgyTrajectoryIdentityError(error)
              }
            }
            return {
              status: 'timeout',
              reason: 'Antigravity trajectory identity worker remained busy.',
            }
          },
        }
      : {}),
    async probeSessionStatus(input, signal): Promise<NativeProbeResult> {
      const storageRoot = input.appDataDir ?? defaultAppDataDir
      const nativeTurnId = input.nativeTurnId ?? input.runId
      const isPhase1PlanMode = Boolean(input.planSource)
      const inspected = await capable.inspectAgyRun(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.nativeSessionId,
          ...(nativeTurnId ? { nativeTurnId } : {}),
          ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
          // Route Plan recovery strictly from frozen authorization: Phase 1 inspects Brain artifacts;
          // Open Mode uses journaled `publish_plan` final intents ONLY (never shadowed by Brain artifacts).
          includePlan: isPhase1PlanMode,
        },
        signal,
      )
      const identity = {
        sessionId: input.sessionId,
        agentId: 'agy' as const,
        requestId: input.requestId,
        nativeSessionId: input.nativeSessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
        bindingGeneration: input.bindingGeneration,
        ...(input.executorId ? { executorId: input.executorId } : {}),
      }
      if (!inspected.exists) return { kind: 'missing', identity, source: 'native_error' }
      if (!inspected.terminalState) {
        return {
          kind: 'no_evidence',
          identity,
          reason: 'No matching Antigravity execution steps found in cold SQLite trajectory.',
        }
      }
      if (inspected.terminalState.status === 'running') {
        const runningPlan = isPhase1PlanMode ? inspected.terminalState.plan : undefined
        const runningPlanUnavailable = isPhase1PlanMode
          ? inspected.terminalState.planUnavailable
          : undefined
        const hasPartialOutput = Boolean(
          inspected.terminalState.answer || runningPlan || runningPlanUnavailable,
        )
        return {
          kind: 'no_evidence',
          identity,
          reason:
            'Cold SQLite trajectory has no terminal step; live execution cannot be inferred without an active executor.',
          ...(hasPartialOutput
            ? {
                output: {
                  outputId: inspected.terminalState.executionId,
                  text: inspected.terminalState.answer,
                  completeness: 'partial' as const,
                  ...(runningPlan ? { plan: runningPlan } : {}),
                  ...(runningPlanUnavailable ? { planUnavailable: true } : {}),
                },
              }
            : {}),
        }
      }
      const outcome =
        inspected.terminalState.status === 'completed'
          ? 'completed'
          : inspected.terminalState.status === 'canceled'
            ? 'interrupted'
            : 'failed'
      let resolvedPlan = isPhase1PlanMode ? inspected.terminalState.plan : undefined
      let resolvedPlanUnavailable = isPhase1PlanMode
        ? inspected.terminalState.planUnavailable
        : undefined
      if (
        !isPhase1PlanMode &&
        outcome === 'completed' &&
        input.runId &&
        resolveColdOpenPlanIntent !== undefined
      ) {
        const openPlan = resolveColdOpenPlanIntent(
          input.runId,
          inspected.terminalState,
          input.nativeSessionId,
        )
        if (openPlan && 'plan' in openPlan) {
          resolvedPlan = openPlan.plan
          resolvedPlanUnavailable = undefined
        } else if (openPlan && 'planUnavailable' in openPlan) {
          resolvedPlanUnavailable = true
        }
      }
      const hasOutput = Boolean(
        inspected.terminalState.answer || resolvedPlan || resolvedPlanUnavailable,
      )
      return {
        kind: 'ended',
        identity,
        source: 'stored_terminal',
        outcome,
        ...(resolvedPlanUnavailable ? { planUnavailable: true } : {}),
        ...(hasOutput
          ? {
              output: {
                outputId: inspected.terminalState.executionId,
                text: inspected.terminalState.answer,
                completeness: outcome === 'completed' ? 'complete' : 'partial',
                ...(resolvedPlan ? { plan: resolvedPlan } : {}),
                ...(resolvedPlanUnavailable ? { planUnavailable: true } : {}),
              },
            }
          : {}),
      }
    },

    async probeInputReceipts(input, signal): Promise<readonly string[]> {
      const candidateIds = input.nativeInputIds ?? input.unresolvedInputIds
      const storageRoot = input.appDataDir ?? defaultAppDataDir
      const inspected = await capable.inspectAgyRun(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.nativeSessionId,
          ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
          nativeInputIds: candidateIds,
        },
        signal,
      )
      if (!inspected.exists || !inspected.terminalState) return []
      const matched = new Set<string>(inspected.terminalState.consumedInputStepIds)
      for (const entry of inspected.terminalState.consumedInputs) {
        if (entry.pactMessageId) matched.add(entry.pactMessageId)
        if (entry.clientMessageId) matched.add(entry.clientMessageId)
        if (entry.stepId) matched.add(entry.stepId)
        if (entry.pactRunId) matched.add(entry.pactRunId)
      }
      return input.unresolvedInputIds.filter((id) => matched.has(id))
    },

    async verifySteerConsumption(input, signal) {
      const storageRoot = input.appDataDir || defaultAppDataDir
      const verifyTurnId = input.executionId ?? input.nativeTurnId
      const inspected = await capable.inspectAgyRun(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.nativeSessionId,
          ...(verifyTurnId ? { nativeTurnId: verifyTurnId } : {}),
          nativeInputIds: [input.inputId],
        },
        signal,
      )
      const minStep = input.minStepIdx ?? 0
      const hit = inspected.terminalState?.consumedInputs.find(
        (entry) =>
          entry.stepIndex >= minStep &&
          (entry.pactMessageId === input.inputId ||
            entry.clientMessageId === input.inputId ||
            entry.stepId === input.inputId),
      )
      return {
        consumed: Boolean(hit),
        ...(hit ? { stepIdx: hit.stepIndex } : {}),
        ...(inspected.terminalState?.executionId
          ? { executionId: inspected.terminalState.executionId }
          : {}),
      }
    },

    async writeRebuildSeed(input, signal) {
      const chunks: NativeContextRebuildChunk[] = []
      const images: AgentPromptImage[] = []
      for await (const record of input.chunks) {
        signal.throwIfAborted()
        chunks.push(record.chunk)
        if (record.resolvedImages) {
          for (const image of record.resolvedImages.values()) images.push(image)
        }
      }
      const storageRoot = input.appDataDir || defaultAppDataDir
      const written = await capable.rebuildAgySeed(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.candidateSessionId,
          rebuildId: input.candidateSessionId,
          ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
          chunks,
          ...(images.length ? { images } : {}),
        },
        signal,
      )
      const seedResult = {
        seedHash: written.seedHash,
        pbSha256: written.pbSha256 ?? written.verifiedPrefixSha256,
        pbBytes: written.pbBytes ?? written.verifiedPrefixBytes,
        chunkCount: written.chunkCount,
        stepCount: written.stepCount,
        verifiedPrefixBytes: written.verifiedPrefixBytes,
        verifiedPrefixSha256: written.verifiedPrefixSha256,
      }
      return seedResult
    },

    async confirmRebuildColdLoad(input, signal) {
      signal.throwIfAborted()
      if (!capable.confirmAgyRebuildColdLoad) {
        throw new Error('Antigravity rebuild cold-load confirmation is unavailable.')
      }
      const storageRoot = input.appDataDir || input.storageRoot || defaultAppDataDir
      const witness = await capable.confirmAgyRebuildColdLoad(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          ...(input.appDataDir ? { appDataDir: input.appDataDir } : {}),
          nativeSessionId: input.nativeSessionId,
          sourceHash: input.sourceHash,
          pbSha256: input.pbSha256,
          pbBytes: input.pbBytes,
          stepCount: input.stepCount,
        },
        signal,
      )
      if (!isVerifiedAgyRebuildWitness(witness, input.nativeSessionId, input.sourceHash)) {
        throw new Error(
          'Antigravity rebuild cold-load witness did not satisfy schema or sourceHash verification.',
        )
      }
      return witness
    },

    async inspectRebuildSeed(input, signal) {
      const chunks: NativeContextRebuildChunk[] = []
      for await (const chunk of input.chunks) {
        signal.throwIfAborted()
        chunks.push(chunk)
      }
      const storageRoot = input.appDataDir || defaultAppDataDir
      try {
        const verified = await capable.verifyAgySeed(
          {
            cwd: input.cwd,
            ...(storageRoot ? { storageRoot } : {}),
            nativeSessionId: input.nativeSessionId,
            rebuildId: input.nativeSessionId,
            ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
            chunks,
            rejectAdditionalWork: true,
          },
          signal,
        )
        if (
          !isVerifiedAgyRebuildWitness(
            verified.initializationWitness,
            input.nativeSessionId,
            input.sourceHash,
          )
        ) {
          return {
            verified: false,
            seedHash: '',
            stepCount: 0,
          }
        }
        return {
          verified: true,
          seedHash: verified.seedHash,
          stepCount: verified.stepCount,
          initializationWitness: verified.initializationWitness,
        }
      } catch (error) {
        if (signal.aborted) throw error
        return {
          verified: false,
          seedHash: '',
          stepCount: 0,
        }
      }
    },

    async prepareFork(input, signal) {
      const storageRoot = input.appDataDir || defaultAppDataDir
      return capable.prepareAgyBoundary(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          nativeSessionId: input.nativeSessionId,
          nativeTurnId: input.nativeTurnId,
          runId: input.runId,
          ...(input.nativeInputIds ? { nativeInputIds: input.nativeInputIds } : {}),
          bindingGeneration: input.bindingGeneration,
          throughSequence: input.throughSequence,
          deliveryCursor: input.deliveryCursor,
          responseHash: input.responseHash,
        },
        signal,
      )
    },

    async writeFork(input, signal) {
      const storageRoot = input.appDataDir || defaultAppDataDir
      const forked = await capable.forkAgy(
        {
          cwd: input.cwd,
          ...(storageRoot ? { storageRoot } : {}),
          candidateNativeSessionId: input.candidateSessionId,
          source: input.source,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          ...(input.onCandidate ? { onCandidate: input.onCandidate } : {}),
        },
        signal,
      )
      return forked.witness
    },

    async inspectFork(input, signal) {
      if (!input.nativeSessionId) {
        return {
          kind: 'unconfirmed',
          reason: 'The Antigravity Fork candidate identity was not acknowledged.',
        }
      }
      const storageRoot = input.appDataDir || defaultAppDataDir
      if (!input.witness) {
        try {
          const candidateExists = await capable.exists(
            {
              cwd: input.cwd,
              nativeSessionId: input.nativeSessionId,
              provider: 'agy',
              ...(storageRoot ? { storageRoot } : {}),
            },
            signal,
          )
          if (!candidateExists) {
            const currentBoundary = await capable.execute(
              {
                provider: 'agy',
                action: 'prepare',
                cwd: input.cwd,
                nativeSessionId: input.source.nativeSessionId,
                nativeTurnId: input.source.nativeTurnId,
                ...(input.source.nativeInputIds
                  ? { nativeInputIds: input.source.nativeInputIds }
                  : {}),
                source: input.source,
                ...(storageRoot ? { storageRoot } : {}),
              },
              signal,
            )
            if (
              currentBoundary.nativeCutId === input.source.nativeCutId &&
              currentBoundary.prefixHash === input.source.prefixHash
            ) {
              return {
                kind: 'missing',
                reason:
                  'The Antigravity Fork candidate SQLite file is absent while the source cut remains intact.',
              }
            }
          }
        } catch (error) {
          if (signal.aborted) throw error
        }
        return {
          kind: 'unconfirmed',
          reason:
            'The Antigravity Fork candidate witness was not persisted; keeping the candidate unconfirmed.',
        }
      }
      if (
        input.witness.sourceNativeSessionId !== input.source.nativeSessionId ||
        input.witness.sourceCutId !== input.source.nativeCutId ||
        input.witness.sourcePrefixHash !== input.source.prefixHash
      ) {
        return {
          kind: 'unconfirmed',
          reason: 'The Antigravity Fork witness belongs to another source cut.',
        }
      }
      try {
        const file = await capable.execute(
          {
            provider: 'agy',
            action: 'inspect',
            cwd: input.cwd,
            nativeSessionId: input.nativeSessionId,
            source: input.source,
            witness: input.witness,
            ...(input.lastDispatchedPhase
              ? { lastDispatchedPhase: input.lastDispatchedPhase }
              : {}),
            ...(storageRoot ? { storageRoot } : {}),
          },
          signal,
        )
        return {
          kind: 'verified',
          result: {
            nativeSessionId: input.nativeSessionId,
            witness: input.witness,
          },
          ready:
            Boolean(file.initializedVerified) &&
            input.witness.model === input.model &&
            input.witness.effort === input.effort &&
            input.witness.permissionMode === input.permissionMode,
          workSettled: Boolean(file.initializedVerified) || input.lastDispatchedPhase === 'fork',
          rawHash: file.rawHash,
          rawBytes: file.rawBytes,
          rawRecords: file.rawRecords,
        }
      } catch (error) {
        if (signal.aborted) throw error
        return {
          kind:
            error instanceof Error &&
            Reflect.get(error, 'code') === 'native_file_fork_candidate_missing'
              ? 'missing'
              : 'unconfirmed',
          reason: error instanceof Error ? error.message : 'Native Fork inspection failed.',
        }
      }
    },
  }
}
