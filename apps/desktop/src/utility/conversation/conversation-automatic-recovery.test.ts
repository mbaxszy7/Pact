/* oxlint-disable vitest/no-conditional-expect, no-await-in-loop -- Each Off/On target has distinct mandatory native assertions and shares the one serial physical owner. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentNativeProbeInput,
  AgentNativeInputProbeInput,
  AgentNativeContextRebuildInput,
  AgentRunInput,
} from '@pact/agent-runtime'
import type {
  DecisionCapability,
  NativeProbeResult,
  NormalizedAgentEvent,
  NativeContextRebuildChunk,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation'
import { AgentExecutionError } from './agent-execution-error'
import { Conversation } from './conversation'

const native = vi.hoisted(() => ({
  runs: [] as AgentRunInput[],
  checks: [] as AgentNativeProbeInput[],
  signal: undefined as AbortSignal | undefined,
  physical: undefined as ReturnType<typeof Promise.withResolvers<void>> | undefined,
  mode: 'unknown' as 'unknown' | 'unsent',
  fences: [] as boolean[],
  probes: 0,
  receipts: [] as AgentNativeInputProbeInput[],
  candidates: [] as AgentNativeContextRebuildInput[],
  candidateSources: [] as NativeContextRebuildChunk[][],
  rootEnded: false,
}))

// The controlled adapter is the process trust seam; these cases do not claim real native compatibility.
vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex'
    readonly executorId = randomUUID()
    readonly nativeSessionId = randomUUID()
    async *run(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
      native.runs.push(input)
      if (native.mode === 'unsent') {
        const session = input.nativeSessionId ?? this.nativeSessionId
        input.recordExecutor?.(this.executorId)
        yield { type: 'session.started', agentId: 'codex', nativeSessionId: session }
        input.recovery?.recordEffectiveSettings(
          {
            version: 1,
            provider: 'codex',
            model: 'original-native-model',
            effort: { known: true, value: null },
            speed: 'standard',
            permissionMode: 'native',
            configurationSha256: 'd'.repeat(64),
            provenance: 'codex_thread_configuration',
          },
          { executorId: this.executorId, nativeSessionId: session },
        )
        if (!input.recovery?.expected) {
          input.recordDispatch?.('rejected', session, this.executorId)
          input.recovery?.recordConfirmedUnsent(
            { kind: 'codex_root_frame_not_written', requestId: 42 },
            { executorId: this.executorId, nativeSessionId: session },
          )
          input.reportNativeEffects?.({
            runId: input.runId,
            generation: input.nativeGeneration!,
            state: 'settled',
            reason: 'native_turn_not_started',
          })
          throw new AgentExecutionError(
            'transient_transport',
            'The original root frame was not written.',
            true,
          )
        }
        const admitted = input.recovery.canDispatch?.() === true
        native.fences.push(admitted)
        if (!admitted) throw new Error('The replacement was withheld at its actual write boundary.')
        const turnId = randomUUID()
        input.recordDispatch?.('possibly_sent', session, this.executorId)
        input.recordDispatch?.('accepted', session, this.executorId)
        yield { type: 'turn.started', agentId: 'codex', turnId }
        yield {
          type: 'text.completed',
          agentId: 'codex',
          turnId,
          outputId: randomUUID(),
          text: 'Complete original task response.',
        }
        input.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
        })
        yield { type: 'turn.completed', agentId: 'codex', turnId, outcome: 'completed' }
        return
      }
      const session = randomUUID(),
        executor = randomUUID()
      input.recordExecutor?.(executor)
      input.recordDispatch?.('possibly_sent', session, executor)
      yield { type: 'session.started', agentId: 'codex', nativeSessionId: session }
      input.recordDispatch?.('accepted', session, executor)
      yield { type: 'turn.started', agentId: 'codex', turnId: randomUUID() }
      throw new AgentExecutionError(
        'transient_transport',
        'Original native delivery lost observation.',
        true,
      )
    }
    beginNativeStatusCheck(input: AgentNativeProbeInput, signal: AbortSignal) {
      native.checks.push(input)
      native.signal = signal
      const identity = {
        sessionId: input.sessionId,
        agentId: input.agentId,
        requestId: input.requestId,
        nativeSessionId: input.nativeSessionId,
        bindingGeneration: input.bindingGeneration,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
      }
      const result: NativeProbeResult = native.rootEnded
        ? {
            kind: 'ended',
            source: 'stored_terminal',
            outcome: 'completed',
            identity,
          }
        : {
            kind: 'no_evidence',
            identity,
            reason: 'Controlled readback remains unconfirmed.',
          }
      return { result: Promise.resolve(result), physicalCompletion: native.physical!.promise }
    }
    beginNativeInputsCheck(input: AgentNativeInputProbeInput) {
      native.receipts.push(input)
      return { result: Promise.resolve(), physicalCompletion: native.physical!.promise }
    }
    beginNativeRebuildCheck(
      input: AgentNativeContextRebuildInput,
      source: AsyncIterable<NativeContextRebuildChunk>,
    ) {
      native.candidates.push(input)
      const chunks: NativeContextRebuildChunk[] = []
      native.candidateSources.push(chunks)
      const result = (async () => {
        for await (const chunk of source) chunks.push(chunk)
        return undefined
      })()
      return { result, physicalCompletion: native.physical!.promise }
    }
    hasActiveBackgroundWork() {
      return false
    }
    async dispose() {}
  },
}))
vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: class {
    async dispose() {}
  },
}))
vi.mock('./codex-decision-runtime.js', () => ({
  CodexDecisionRuntime: class {
    async probeAdmission(): Promise<DecisionCapability> {
      native.probes++
      return {
        provider: 'codex',
        modelId: 'gpt-6-luna',
        status: 'supported',
        supported: true,
        reason: 'supported',
        configurationFingerprint: 'a'.repeat(64),
        checkedAt: new Date().toISOString(),
        physicalReleased: true,
      }
    }
    async settlement() {
      return true
    }
    async dispose() {
      return true
    }
  },
}))

const fixtures: Array<{ db: PactDatabase; flow: Conversation; directory: string }> = []
afterEach(async () => {
  native.physical?.resolve()
  vi.useRealTimers()
  await Promise.all(
    fixtures.splice(0).map(async (f) => {
      await f.flow.dispose()
      f.db.close()
      await rm(f.directory, { recursive: true, force: true })
    }),
  )
  native.runs = []
  native.checks = []
  native.signal = undefined
  native.physical = undefined
  native.mode = 'unknown'
  native.fences = []
  native.probes = 0
  native.receipts = []
  native.candidates = []
  native.candidateSources = []
  native.rootEnded = false
  vi.restoreAllMocks()
})

async function fixture(enabled = true, warmContext = true) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-automatic-recovery-'))
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    createdAt = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Recovery',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Recovery', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  db.conversationRepository.saveSchedulingSettings({
    expectedRevision: 0,
    enabled,
    selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
  })
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue('/controlled/codex')
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          state: 'ready',
          executablePath: '/controlled/codex',
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          state: 'ready',
          executablePath: '/controlled/claude',
          checkedAt: createdAt,
        },
      ],
    },
  })
  native.physical = Promise.withResolvers<void>()
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  fixtures.push({ db, flow, directory })
  if (warmContext) {
    const refreshed = await flow.refreshSchedulingState({ sessionId })
    if (!refreshed.ok || refreshed.value.context?.observation.status !== 'supported')
      throw Error('The recovery fixture requires supported native compatibility.')
  }
  return {
    db,
    repo: db.conversationRepository,
    flow,
    preparation,
    sessionId,
    send: () =>
      flow.send({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Original task, preserved through the failed delivery.',
        commentIds: [],
        expectedCommentsRevision: 0,
        route: { type: 'agent', agentId: 'codex' },
      }),
  }
}

function seedRecoveryTarget(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'run' | 'queue' | 'rebuild',
) {
  const repo = f.repo,
    sessionId = f.sessionId,
    executorId = randomUUID(),
    nativeSessionId = randomUUID(),
    turnId = randomUUID()
  const run = repo.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content: 'Original controlled recovery source.',
    commentIds: [],
    expectedCommentsRevision: 0,
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  }).run
  repo.recordExecutor(run.id, executorId)
  repo.applyEvent(sessionId, run.id, { type: 'session.started', agentId: 'codex', nativeSessionId })
  repo.recordDispatch(run.id, 'accepted', nativeSessionId, executorId)
  repo.applyEvent(sessionId, run.id, { type: 'turn.started', agentId: 'codex', turnId })
  let queueOperation: string | undefined
  if (kind === 'queue') {
    const owner = randomUUID(),
      clientMessageId = randomUUID(),
      content = 'Preserved supplemental input.'
    const body = repo.writeConversationInput({ type: 'begin', sessionId, clientMessageId }, owner)
    repo.writeConversationInput(
      { type: 'append', sessionId, inputId: body.inputId, offset: 0, text: content },
      owner,
    )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, owner)
    const draft = repo.readPage({ scope: 'drafts', sessionId })
    if (draft.scope !== 'drafts') throw Error('Missing complete queue source revision')
    repo.receiveQueuedInput(
      {
        sessionId,
        clientMessageId,
        inputId: body.inputId,
        content: '',
        commentIds: [],
        expectedCommentsRevision: draft.commentsRevision,
        route: { type: 'agent', agentId: 'codex' },
      },
      body.inputId,
      'codex',
      owner,
      run.id,
    )
    const queue = repo.queueState(sessionId)
    queueOperation = randomUUID()
    repo.prepareQueuedSteer(
      {
        sessionId,
        inputId: queue.input!.id,
        expectedRevision: queue.revision,
        operationId: queueOperation,
      },
      { runId: run.id, bindingGeneration: 1, nativeTurnId: turnId, executorId },
    )
    repo.markQueuedSteerPossiblySent(queueOperation)
  }
  if (kind === 'run') {
    repo.failRun(run.id, 'transient_transport', 'Original root observation remains uncertain.')
    repo.recordNativeEffects(run.id, 'unknown')
  } else {
    repo.applyEvent(sessionId, run.id, {
      type: 'text.completed',
      agentId: 'codex',
      turnId,
      outputId: run.id,
      text: 'Complete original root response.',
    })
    repo.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: 'codex',
        requestId: run.id,
        runId: run.id,
        nativeSessionId,
        nativeTurnId: turnId,
        bindingGeneration: 1,
        executorId,
      },
    })
    repo.recordNativeEffects(run.id, 'settled')
    repo.applyEvent(sessionId, run.id, {
      type: 'turn.completed',
      agentId: 'codex',
      turnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(run.id, 'settled')
  }
  if (queueOperation) repo.markQueuedSteerUnknown(queueOperation)
  let rebuildId: string | undefined, candidateId: string | undefined, sourceHash: string | undefined
  if (kind === 'rebuild') {
    rebuildId = randomUUID()
    candidateId = randomUUID()
    repo.beginNativeRebuild({
      id: rebuildId,
      sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    const messages = repo.read(sessionId).messages
    const chunks: NativeContextRebuildChunk[] = messages.map((message) => ({
      kind: 'message',
      messageId: message.id,
      sequence: message.sequence,
      speaker: message.role === 'user' ? 'user' : 'codex',
      state: 'complete',
      part: 0,
      final: true,
      content: message.content,
    }))
    sourceHash = repo.freezeNativeRebuildSource(rebuildId, chunks)
    repo.markNativeRebuildDispatched(rebuildId, executorId)
    repo.recordNativeRebuildIdentity(rebuildId, candidateId)
    repo.recordNativeRebuildWork(rebuildId, executorId, candidateId, 'settled')
    repo.failNativeRebuild(rebuildId, 'Candidate initialization receipt remains uncertain.')
  }
  // This is the same public Repository transition used by Conversation publication.
  repo.armSchedulingRecoveryFaults(sessionId)
  return { run, nativeSessionId, turnId, queueOperation, rebuildId, candidateId, sourceHash }
}

describe('automatic recovery through Conversation', () => {
  it.each(['run', 'queue', 'rebuild'] as const)(
    'compares Off/On %s readback through the same primary owners without replay [controlled native seam]',
    async (kind) => {
      const metrics: Array<{
        enabled: boolean
        manualChecks: number
        nativeReads: number
        businessDispatches: number
      }> = []
      for (const enabled of [false, true]) {
        const f = await fixture(enabled, false)
        const starts = {
          status: native.checks.length,
          receipts: native.receipts.length,
          candidates: native.candidates.length,
        }
        const target = seedRecoveryTarget(f, kind)
        native.rootEnded = kind !== 'run'
        let manualChecks = 0
        let manual: Promise<unknown> | undefined
        if (!enabled) {
          expect(native.checks).toHaveLength(starts.status)
          expect(native.receipts).toHaveLength(starts.receipts)
          expect(native.candidates).toHaveLength(starts.candidates)
          manualChecks++
          manual =
            kind === 'rebuild'
              ? f.flow.rebuildNativeContext({
                  sessionId: f.sessionId,
                  agentId: 'codex',
                  intent: 'inspect',
                })
              : f.flow.retry({ sessionId: f.sessionId, runId: target.run.id })
        }
        await vi.waitFor(() =>
          expect(
            kind === 'run'
              ? native.checks.length - starts.status
              : kind === 'queue'
                ? native.receipts.length - starts.receipts
                : native.candidates.length - starts.candidates,
          ).toBe(1),
        )
        if (enabled)
          expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
            kind: 'check',
            active: true,
          })
        if (kind === 'run')
          expect(native.checks[starts.status]).toMatchObject({
            runId: target.run.id,
            nativeSessionId: target.nativeSessionId,
            bindingGeneration: 1,
          })
        if (kind === 'queue')
          expect(native.receipts[starts.receipts]).toMatchObject({
            runId: target.run.id,
            nativeSessionId: target.nativeSessionId,
            nativeTurnId: target.turnId,
          })
        if (kind === 'rebuild')
          expect(native.candidates[starts.candidates]).toMatchObject({
            rebuildId: target.rebuildId,
            nativeSessionId: target.candidateId,
            sourceHash: target.sourceHash,
          })
        native.physical!.resolve()
        await manual
        await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
        if (kind === 'queue') expect(f.repo.queueState(f.sessionId).input?.state).toBe('unknown')
        if (kind === 'rebuild')
          expect(f.repo.nativeRebuildOperation(target.rebuildId!)?.provisionalNativeSessionId).toBe(
            target.candidateId,
          )
        expect(f.repo.nativeContext(f.sessionId, 'codex')?.nativeSessionId).toBe(
          target.nativeSessionId,
        )
        expect(f.repo.latestAgentRun(f.sessionId, 'codex')?.id).toBe(target.run.id)
        expect(native.runs).toEqual([])
        metrics.push({
          enabled,
          manualChecks,
          nativeReads:
            native.checks.length -
            starts.status +
            native.receipts.length -
            starts.receipts +
            native.candidates.length -
            starts.candidates,
          businessDispatches: native.runs.length,
        })
      }
      expect(metrics.map((row) => row.manualChecks)).toEqual([1, 0])
      expect(metrics.map((row) => row.nativeReads)).toEqual(kind === 'queue' ? [2, 1] : [1, 1])
      expect(metrics.every((row) => row.businessDispatches === 0)).toBe(true)
      process.stdout.write(
        '[pact-relay-recovery-comparison] ' +
          JSON.stringify({
            kind,
            trustSeam: 'controlled native adapter; actual CLI protocol evidence separate',
            metrics,
          }) +
          '\n',
      )
    },
  )
  it('checks a new Session fault without first opening its Relay settings', async () => {
    const f = await fixture(true, false)
    expect(native.probes).toBe(0)
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() => expect(native.checks).toHaveLength(1))
    expect(native.probes).toBe(1)
    expect(native.runs).toHaveLength(1)
  })
  it('refreshes expired native compatibility once before checking a later fault', async () => {
    const f = await fixture()
    const state = f.flow.getSchedulingState({ sessionId: f.sessionId })
    expect(state.ok).toBe(true)
    if (!state.ok) throw Error('Relay state unavailable')
    const expiry = state.value.context!.observation.expiresAt!
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiry) + 1)
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() => expect(native.checks).toHaveLength(1))
    expect(native.probes).toBe(2)
    expect(native.runs).toHaveLength(1)
    now.mockRestore()
  })
  it('does not reopen a Relay recovery action when stopped readback physically finishes later', async () => {
    const f = await fixture()
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() => expect(native.checks).toHaveLength(1))
    expect(f.flow.stop({ sessionId: f.sessionId }).ok).toBe(true)
    native.physical!.resolve()
    await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
    expect(f.repo.relaySchedulingDecision(f.sessionId)).toBeNull()
    expect(native.runs).toHaveLength(1)
  })
  it('admits no automatic native read after expiry even when the due timer has not dispatched', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const preparation = Promise.withResolvers<string | undefined>()
    vi.spyOn(f.preparation, 'findRecoveryExecutable').mockReturnValue(preparation.promise)
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() =>
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({ kind: 'check' }),
    )
    const owner = f.repo.activeSchedulingRuntimeOwner()!
    const deadline = Date.parse(f.repo.schedulingRecoveryAttempt(owner.id)!.deadline)
    vi.setSystemTime(deadline + 1)
    preparation.resolve('/controlled/codex')
    await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
    expect(native.checks).toEqual([])
    expect(native.runs).toHaveLength(1)
  })
  it('charges delayed preparation to the original automatic deadline instead of renewing its native-read budget', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    const preparation = Promise.withResolvers<string | undefined>()
    vi.spyOn(f.preparation, 'findRecoveryExecutable').mockReturnValue(preparation.promise)
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() =>
      expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({ kind: 'check' }),
    )
    const owner = f.repo.activeSchedulingRuntimeOwner()!
    const deadline = Date.parse(f.repo.schedulingRecoveryAttempt(owner.id)!.deadline)
    await vi.advanceTimersByTimeAsync(9000)
    expect(native.checks).toEqual([])
    preparation.resolve('/controlled/codex')
    await vi.waitFor(() => expect(native.checks).toHaveLength(1))
    const remaining = deadline - Date.now()
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(1000)
    await vi.advanceTimersByTimeAsync(remaining - 1)
    expect(native.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(native.signal?.aborted).toBe(true)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: owner.id,
      phase: 'cleanup_unconfirmed',
    })
    native.physical!.resolve()
    await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
    expect(native.checks).toHaveLength(1)
    expect(native.runs).toHaveLength(1)
  })
  it('dispatches one independent exact-input replacement only after a positive original unsent receipt', async () => {
    native.mode = 'unsent'
    const f = await fixture()
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() =>
      expect(f.repo.executionInput(native.runs[0]!.runId)?.proof).toBeDefined(),
    )
    expect(f.repo.nativeContext(f.sessionId, 'codex')).toMatchObject({ continuationState: 'ready' })
    await vi.waitFor(() => expect(native.runs).toHaveLength(2))
    await vi.waitFor(() =>
      expect(f.repo.latestAgentRun(f.sessionId, 'codex')?.status).toBe('completed'),
    )
    const [original, replacement] = native.runs
    expect(replacement!.runId).not.toBe(original!.runId)
    expect(replacement!.promptEnvelope.message).toEqual(original!.promptEnvelope.message)
    expect(replacement!.promptEnvelope.comments).toEqual(original!.promptEnvelope.comments)
    expect(replacement!.recovery?.expected).toMatchObject({
      executorId: f.repo.executionInput(original!.runId)!.proof!.executorId,
      settings: {
        model: 'original-native-model',
        effort: { known: true, value: null },
        speed: 'standard',
      },
    })
    const run = f.repo.latestAgentRun(f.sessionId, 'codex')!
    expect(run.reexecutedFromRunId).toBe(original!.runId)
    expect(run.userMessageId).toBe(f.repo.findRun(original!.runId)!.userMessageId)
    expect(f.repo.schedulingBudget(`input:${run.userMessageId}`)?.automaticResends).toBe(1)
    expect(native.checks).toEqual([])
    expect(native.fences).toEqual([true])
  })
  it('starts one readback for a new qualified fault, holds its lease after timeout and never resends the task', async () => {
    const f = await fixture()
    vi.useFakeTimers()
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() => expect(native.checks).toHaveLength(1))
    const owner = f.repo.activeSchedulingRuntimeOwner()!
    expect(owner).toMatchObject({ kind: 'check', sessionId: f.sessionId, phase: 'running' })
    const run = f.repo.latestAgentRun(f.sessionId, 'codex')!
    expect(native.checks[0]).toMatchObject({
      runId: run.id,
      nativeSessionId: run.nativeSessionId,
      bindingGeneration: run.bindingGeneration,
    })
    const state = f.flow.getSchedulingState({ sessionId: f.sessionId })
    expect(state.ok && state.value.activity.check).toMatchObject({
      status: 'checking',
      sessionId: f.sessionId,
      operationId: owner.id,
    })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(native.signal?.aborted).toBe(true)
    expect(f.repo.activeSchedulingRuntimeOwner()).toMatchObject({
      id: owner.id,
      active: true,
      phase: 'cleanup_unconfirmed',
    })
    expect(native.runs).toHaveLength(1)
    expect(native.checks).toHaveLength(1)
    native.physical!.resolve()
    await vi.waitFor(() => expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined())
    expect(f.repo.schedulingRecoveryAttempt(owner.id)).toMatchObject({
      started: true,
      physicalReleased: true,
      result: 'failed',
    })
    expect(native.runs).toHaveLength(1)
    expect(native.checks).toHaveLength(1)
  })

  it('keeps Relay Off on the complete original manual recovery path with no automatic readback', async () => {
    const f = await fixture(false)
    expect((await f.send()).ok).toBe(true)
    await vi.waitFor(() =>
      expect(f.repo.latestAgentRun(f.sessionId, 'codex')?.status).toBe('interrupted'),
    )
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0))
    expect(native.checks).toEqual([])
    expect(f.repo.activeSchedulingRuntimeOwner()).toBeUndefined()
    expect(f.repo.nativeIssueMetadata(f.sessionId).inputGate).toBe('read_only')
  })
})
