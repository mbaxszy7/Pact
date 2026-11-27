import { describe, expect, it } from 'vitest'

import {
  BoundedBackgroundTaskTable,
  BoundedRecordingQueue,
  DisposableScope,
  NATIVE_TERMINAL_FAILURE_MAX_CHARS,
  RUN_EFFECT_DISPOSITION,
  RunLifecycleInvariantError,
  RunLifecycleKernel,
  classifyBindingRejection,
  sanitizeNativeTerminalFailure,
  validateSourceGrant,
  validateWorkflowAuthorization,
  type NativeEffectsState,
  type RunEffectKind,
  type RunLifecyclePhase,
} from './index.js'

/** Seeded Mulberry32 PRNG for deterministic interleaving exploration with zero wall-clock waits. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PHASE_ORDER: Readonly<Record<RunLifecyclePhase, number>> = {
  PreLease: 0,
  BootstrappingSession: 1,
  ReadyToDispatch: 2,
  DispatchedStreaming: 3,
  AbortRequested: 4,
  TerminalObserved: 5,
  DrainingEffects: 6,
  Settled: 7,
}

const ALL_EFFECT_KINDS: readonly RunEffectKind[] = [
  'permission_request',
  'user_input_request',
  'in_turn_steer',
  'open_plan_publish',
  'peer_assistance_request',
  'mcp_tool_call',
  'session_title_sync',
  'stream_delta',
  'native_evidence',
  'input_consumption',
  'background_report',
  'archived_event',
  'file_change_record',
  'native_effects_settlement',
  'native_title_observation',
  'effective_settings_receipt',
]

const PROCESS_BOUND_EFFECTS: readonly RunEffectKind[] = ALL_EFFECT_KINDS.filter(
  (kind) => RUN_EFFECT_DISPOSITION[kind] === 'PROCESS_BOUND',
)

async function runInterleavingSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const dispatchedPhases: string[] = []
  const terminalFreezeEvents: string[] = []
  const effectReports: NativeEffectsState[] = []
  const cleanupOrder: number[] = []
  const pendingDeferreds: Array<{ resolve: () => void; reject: (err: Error) => void }> = []
  let maxObservedConcurrency = 0
  let currentConcurrency = 0

  const kernel = new RunLifecycleKernel<{ tag: string }>({
    agentId: seed % 3 === 0 ? 'agy' : seed % 3 === 1 ? 'codex' : 'claude',
    runId: `run-${seed}`,
    sessionId: `session-${seed}`,
    nativeGeneration: `gen-${seed}`,
    ledger: {
      tasks: { maxTasks: 8 },
      recordings: { maxConcurrency: 4, maxQueue: 8 },
    },
    callbacks: {
      onDispatchPhase: (phase) => dispatchedPhases.push(phase),
      onTerminalFrozen: (outcome) => terminalFreezeEvents.push(outcome),
      onReportNativeEffects: (report) => effectReports.push(report.state),
    },
  })

  kernel.disposables.register(() => {
    cleanupOrder.push(1)
  })
  kernel.disposables.register(() => {
    cleanupOrder.push(2)
    if (seed % 7 === 0) throw new Error('injected-cleanup-error')
  })
  kernel.disposables.register(() => {
    cleanupOrder.push(3)
  })

  let previousOrder = PHASE_ORDER[kernel.phase]
  const initialFence = kernel.snapshotFences()
  let fencedBumped = false

  const stepCount = 12 + Math.floor(rand() * 14)
  for (let step = 0; step < stepCount; step += 1) {
    const action = Math.floor(rand() * 12)
    switch (action) {
      case 0: {
        if (!kernel.executorId) {
          kernel.bindExecutor(`exec-${seed}`)
        }
        break
      }
      case 1: {
        if (kernel.phase === 'PreLease' || kernel.phase === 'BootstrappingSession') {
          kernel.markReadyToDispatch(`native-${seed}`)
        }
        break
      }
      case 2: {
        kernel.recordDispatch('possibly_sent', `native-${seed}`, `exec-${seed}`)
        break
      }
      case 3: {
        kernel.recordDispatch('accepted', `native-${seed}`, `exec-${seed}`)
        break
      }
      case 4: {
        kernel.recordDispatch('rejected', `native-${seed}`, `exec-${seed}`)
        break
      }
      case 5: {
        kernel.recordConfirmedUnsent(
          { kind: 'agy_root_frame_not_written' },
          {
            executorId: `exec-${seed}`,
            nativeSessionId: `native-${seed}`,
          },
        )
        break
      }
      case 6: {
        kernel.requestAbort()
        break
      }
      case 7: {
        const outcomes = ['completed', 'failed', 'interrupted'] as const
        const picked = outcomes[Math.floor(rand() * outcomes.length)]!
        kernel.recordTerminal(picked, `failure detail ${seed} Bearer secret_token_1234567890`)
        break
      }
      case 8: {
        const bumpKind = Math.floor(rand() * 3)
        if (bumpKind === 0) kernel.bumpSessionGen()
        else if (bumpKind === 1) kernel.bumpConnectionGen()
        else kernel.bumpOwnerGen()
        fencedBumped = true
        break
      }
      case 9: {
        const taskIdx = Math.floor(rand() * 12)
        if (rand() < 0.4) {
          kernel.ledger.tasks.registerProvisional(`prov-${taskIdx}`, { tag: 'p' })
        } else if (rand() < 0.75) {
          kernel.ledger.tasks.confirmTask(`task-${taskIdx}`, { tag: 'c' }, `prov-${taskIdx}`)
        } else {
          kernel.ledger.tasks.completeTask(`task-${taskIdx}`)
        }
        break
      }
      case 10: {
        kernel.ledger.recordings.enqueue(async () => {
          currentConcurrency += 1
          if (currentConcurrency > maxObservedConcurrency) {
            maxObservedConcurrency = currentConcurrency
          }
          try {
            await new Promise<void>((resolve, reject) => {
              pendingDeferreds.push({ resolve, reject })
            })
          } finally {
            currentConcurrency -= 1
          }
        })
        if (pendingDeferreds.length > 0 && rand() < 0.6) {
          const next = pendingDeferreds.shift()!
          if (rand() < 0.2) next.reject(new Error('injected-recording-error'))
          else next.resolve()
        }
        break
      }
      default: {
        const states: readonly NativeEffectsState[] = ['pending', 'settled', 'unknown']
        kernel.reportNativeEffects(states[Math.floor(rand() * states.length)]!)
        break
      }
    }

    // Invariant 1: Phase progression is monotonic (no backward transitions).
    const currentOrder = PHASE_ORDER[kernel.phase]
    expect(currentOrder).toBeGreaterThanOrEqual(previousOrder)
    previousOrder = currentOrder

    // Invariant 2: Generation-fenced stale snapshots are ALWAYS rejected once bumped.
    const staleRejected =
      !fencedBumped || ALL_EFFECT_KINDS.every((kind) => !kernel.canAdmitEffect(kind, initialFence))
    expect(staleRejected).toBe(true)

    // Invariant 3: PROCESS_BOUND effects are NEVER admitted after output freezes.
    const processBoundGated =
      !kernel.isForegroundOutputFrozen ||
      PROCESS_BOUND_EFFECTS.every((kind) => !kernel.canAdmitEffect(kind))
    expect(processBoundGated).toBe(true)

    // Invariant 4: Terminal outcome freezes at most once.
    expect(terminalFreezeEvents.length).toBeLessThanOrEqual(1)

    // Invariant 5: Dispatch never transitions accepted <-> rejected.
    expect(dispatchedPhases.includes('accepted') && dispatchedPhases.includes('rejected')).toBe(
      false,
    )

    // Invariant 6: Once `unknown` effects state is emitted, `settled` is never emitted after it.
    const unknownIdx = effectReports.indexOf('unknown')
    const settledAfterUnknown =
      unknownIdx !== -1 && effectReports.slice(unknownIdx + 1).includes('settled')
    expect(settledAfterUnknown).toBe(false)
  }

  const settlePromise = kernel.settle()
  while (
    pendingDeferreds.length > 0 ||
    kernel.ledger.recordings.activeCount > 0 ||
    kernel.ledger.recordings.queuedCount > 0
  ) {
    const deferred = pendingDeferreds.shift()
    deferred?.resolve()
    // oxlint-disable-next-line no-await-in-loop -- Deterministic microtask pump with zero wall-clock waits.
    await Promise.resolve()
  }
  const settled = await settlePromise

  expect(kernel.phase).toBe('Settled')
  expect(kernel.isForegroundOutputFrozen).toBe(true)
  expect(cleanupOrder).toEqual([3, 2, 1])
  expect(maxObservedConcurrency).toBeLessThanOrEqual(4)
  expect(settled.cleanupErrors.length).toBe(seed % 7 === 0 ? 1 : 0)
  expect(ALL_EFFECT_KINDS.every((kind) => !kernel.canAdmitEffect(kind))).toBe(true)
  const finalUnknownIdx = effectReports.indexOf('unknown')
  expect(
    finalUnknownIdx !== -1 && effectReports.slice(finalUnknownIdx + 1).includes('settled'),
  ).toBe(false)
}

describe('RunLifecycleKernel deterministic state machine and fault injection', () => {
  it('enforces all 6 lifecycle, fence, effect, and finality invariants across 1,500 seeded interleavings', async () => {
    const seeds = Array.from({ length: 1_500 }, (_, index) => index + 1)
    const results = await Promise.all(seeds.map((seed) => runInterleavingSeed(seed)))
    expect(results).toHaveLength(1_500)
  })

  it('throws RunLifecycleInvariantError on illegal FSM transitions and executor rebinding', () => {
    const kernel = new RunLifecycleKernel({
      agentId: 'codex',
      runId: 'run-illegal',
      sessionId: 'session-1',
      nativeGeneration: 'gen-1',
    })

    expect(() => kernel.transition('DispatchedStreaming')).toThrow(RunLifecycleInvariantError)
    kernel.bindExecutor('exec-1')
    expect(() => kernel.bindExecutor('exec-2')).toThrow(RunLifecycleInvariantError)
    kernel.transition('ReadyToDispatch')
    expect(() => kernel.transition('PreLease')).toThrow(RunLifecycleInvariantError)
  })

  it('prevents fabricating confirmed-unsent receipts after accepted dispatch or terminal', () => {
    const kernel = new RunLifecycleKernel({
      agentId: 'agy',
      runId: 'run-unsent',
      sessionId: 'session-1',
      nativeGeneration: 'gen-1',
    })
    kernel.bindExecutor('exec-1')
    kernel.markReadyToDispatch('native-1')
    expect(kernel.recordDispatch('possibly_sent')).toBe(true)
    expect(kernel.recordDispatch('accepted')).toBe(true)
    expect(
      kernel.recordConfirmedUnsent(
        { kind: 'agy_root_frame_not_written' },
        {
          executorId: 'exec-1',
          nativeSessionId: 'native-1',
        },
      ),
    ).toBe(false)
  })
})

describe('BoundedBackgroundTaskTable and BoundedRecordingQueue', () => {
  it('promotes provisional launches, handles out-of-order completion, excludes ambient tasks, and latches >64 overflow', () => {
    const overflows: string[] = []
    const table = new BoundedBackgroundTaskTable<{ kind: string }>({
      maxTasks: 64,
      onOverflow: (reason) => overflows.push(reason),
    })

    table.markAmbient('ambient-1')
    expect(table.registerProvisional('ambient-1', { kind: 'bg' })).toBe(false)
    expect(table.confirmTask('ambient-1', { kind: 'bg' })).toBe(false)
    expect(table.hasActiveTasks).toBe(false)

    expect(table.completeTask('early-task')).toBe(false)
    expect(table.confirmTask('early-task', { kind: 'bg' })).toBe(true)
    expect(table.hasActiveTasks).toBe(false)

    expect(table.registerProvisional('launch-1', { kind: 'subagent' })).toBe(true)
    expect(table.provisionalCount).toBe(1)
    expect(table.confirmTask('task-1', { kind: 'subagent' }, 'launch-1')).toBe(true)
    expect(table.provisionalCount).toBe(0)
    expect(table.confirmedCount).toBe(1)
    expect(table.completeTask('task-1')).toBe(true)
    expect(table.hasActiveTasks).toBe(false)

    for (let i = 0; i < 64; i += 1) {
      expect(table.confirmTask(`t-${i}`, { kind: 'bg' })).toBe(true)
    }
    expect(table.overflowed).toBe(false)
    expect(table.confirmTask('t-64', { kind: 'bg' })).toBe(false)
    expect(table.overflowed).toBe(true)
    expect(overflows.length).toBe(1)
  })

  it('enforces 8-concurrency and 64-FIFO queue bounds with fail-closed overflow', async () => {
    const overflows: string[] = []
    const queue = new BoundedRecordingQueue({
      maxConcurrency: 8,
      maxQueue: 64,
      onOverflow: (reason) => overflows.push(reason),
    })
    const gates: Array<() => void> = []
    let peak = 0
    let active = 0

    for (let i = 0; i < 72; i += 1) {
      const ok = queue.enqueue(async () => {
        active += 1
        if (active > peak) peak = active
        await new Promise<void>((resolve) => {
          gates.push(resolve)
        })
        active -= 1
      })
      expect(ok).toBe(true)
    }
    expect(queue.activeCount).toBe(8)
    expect(queue.queuedCount).toBe(64)
    expect(queue.enqueue(async () => {})).toBe(false)
    expect(queue.overflowed).toBe(true)
    expect(overflows.length).toBe(1)

    const draining = queue.drain()
    while (gates.length > 0 || queue.activeCount > 0 || queue.queuedCount > 0) {
      const release = gates.shift()
      release?.()
      // oxlint-disable-next-line no-await-in-loop -- Deterministic microtask pump.
      await Promise.resolve()
      // oxlint-disable-next-line no-await-in-loop -- Second microtask tick lets finally() pump next worker.
      await Promise.resolve()
    }
    const result = await draining
    expect(result.drained).toBe(true)
    expect(result.completedCount).toBe(72)
    expect(result.overflowed).toBe(true)
    expect(peak).toBe(8)
  })
})

describe('Shared runtime validators, binding taxonomy, sanitizer, and DisposableScope', () => {
  it('validates source grants and workflow authorization consistently across adapters', () => {
    expect(
      validateSourceGrant({
        runId: 'r1',
        nativeGeneration: 'g1',
        hasSourceReader: true,
        sourceGrant: { runId: 'r1', grant: 'g1' },
        readerIdentity: { runId: 'r1', grant: 'g1' },
      }).ok,
    ).toBe(true)

    expect(
      validateSourceGrant({
        runId: 'r1',
        nativeGeneration: 'g1',
        hasSourceReader: true,
        sourceGrant: { runId: 'r1', grant: 'wrong' },
      }).ok,
    ).toBe(false)

    expect(
      validateWorkflowAuthorization({
        adapterId: 'claude',
        runId: 'r1',
        sessionId: 's1',
        envelopeSessionId: 's1',
        collaboration: {
          protocol: 'native-workflow-v1',
          id: 'task-1',
          sessionId: 's1',
          kind: 'plan',
          revision: 2,
          owner: 'claude',
          reviewer: 'codex',
          task: 'Ship safely',
          taskMessageId: 'm1',
          stage: 'plan',
          actor: 'claude',
          status: 'running',
          automation: 'active',
          runId: 'r1',
          inputSequence: 3,
          handledInputSequence: 2,
          planVersion: 0,
          discussionRounds: 0,
          reviewCycles: 0,
          repairAttempts: 0,
        },
        authorization: {
          runId: 'r1',
          taskId: 'task-1',
          taskRevision: 2,
          actor: 'codex',
          stage: 'plan',
          inputSequence: 3,
        },
      }).ok,
    ).toBe(false)
  })

  it('sanitizes native terminal failure detail to <= 240 chars and redacts secrets', () => {
    const raw = `Error:\x00\n  Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload  ${'x'.repeat(400)}`
    const cleaned = sanitizeNativeTerminalFailure(raw)
    expect(cleaned.length).toBeLessThanOrEqual(NATIVE_TERMINAL_FAILURE_MAX_CHARS)
    expect(cleaned).not.toContain('secretpayload')
    expect(cleaned).toContain('[redacted]')
    let hasControlChars = false
    for (let i = 0; i < cleaned.length; i += 1) {
      const code = cleaned.charCodeAt(i)
      if (code < 32 || code === 127) hasControlChars = true
    }
    expect(hasControlChars).toBe(false)
  })

  it('classifies typed binding rejections deterministically', () => {
    expect(classifyBindingRejection({ message: 'no rollout found for thread id t-1' })).toBe(
      'confirmed_missing',
    )
    expect(classifyBindingRejection({ message: 'Session is archived' })).toBe('archived')
    expect(classifyBindingRejection({ message: 'Thread already active in another turn' })).toBe(
      'occupied',
    )
    expect(classifyBindingRejection({ message: 'Unexpected JSON-RPC parse error' })).toBe(
      'rpc_protocol_error',
    )
  })

  it('runs DisposableScope cleanups in strict LIFO order and isolates thrown errors', async () => {
    const order: string[] = []
    const scope = new DisposableScope()
    scope.register(() => {
      order.push('first')
    })
    const unregisterSecond = scope.register(() => {
      order.push('second-cancelled')
    })
    scope.register(() => {
      order.push('third')
      throw new Error('boom')
    })
    unregisterSecond()
    const errors = await scope.disposeAll()
    expect(order).toEqual(['third', 'first'])
    expect(errors).toHaveLength(1)
    expect(await scope.disposeAll()).toEqual([])
  })

  it('Wave 6A Shard 1 regressions: shares concurrent settle(), prevents false settled on recording failure/drop, defers disposeAll on timeout, avoids rejected recordDispatch mutation, and cleans aliases in both ambient orders', async () => {
    // 1. Rejected recordDispatch does not mutate executorId or nativeSessionId.
    const kernelRejected = new RunLifecycleKernel({
      agentId: 'codex',
      runId: 'run-reject-no-mutate',
      sessionId: 's-1',
      nativeGeneration: 'gen-1',
    })
    kernelRejected.bindExecutor('exec-real')
    expect(kernelRejected.recordDispatch('accepted', 'native-real', 'exec-real')).toBe(true)
    expect(kernelRejected.recordDispatch('possibly_sent', 'native-foreign', 'exec-foreign')).toBe(
      false,
    )
    expect(kernelRejected.recordDispatch('rejected', 'native-foreign', 'exec-foreign')).toBe(false)
    expect(kernelRejected.nativeSessionId).toBe('native-real')
    expect(kernelRejected.executorId).toBe('exec-real')

    // 2. Concurrent settle() shares one settlement promise and fails closed when a recording throws.
    const effectsLog: string[] = []
    const kernelConcurrent = new RunLifecycleKernel({
      agentId: 'agy',
      runId: 'run-concurrent-settle',
      sessionId: 's-2',
      nativeGeneration: 'gen-2',
      callbacks: {
        onReportNativeEffects: (report) => effectsLog.push(report.state),
      },
    })
    kernelConcurrent.bindExecutor('exec-2')
    kernelConcurrent.reportNativeEffects('pending')
    const recordingGate = Promise.withResolvers<void>()
    kernelConcurrent.ledger.recordings.enqueue(async () => {
      await recordingGate.promise
      throw new Error('sqlite-disk-full')
    })
    const settleA = kernelConcurrent.settle()
    const settleB = kernelConcurrent.settle()
    expect(settleA).toBe(settleB)
    expect(kernelConcurrent.phase).toBe('DrainingEffects')
    // New admissions during drain are rejected and tracked as dropped.
    expect(kernelConcurrent.ledger.recordings.enqueue(async () => {})).toBe(false)
    recordingGate.resolve()
    const [resA, resB] = await Promise.all([settleA, settleB])
    expect(resA).toEqual(resB)
    expect(resA.recordingsFailedCount).toBe(1)
    expect(resA.recordingsDroppedCount).toBe(1)
    expect(kernelConcurrent.phase).toBe('Settled')
    expect(kernelConcurrent.effectsState).toBe('unknown')
    expect(effectsLog).not.toContain('settled')

    // 3. Timed-out settle() aborts workers BEFORE deferred disposeAll() and runs disposeAll() once workers exit.
    const events: string[] = []
    const kernelTimeout = new RunLifecycleKernel({
      agentId: 'claude',
      runId: 'run-timeout-defer',
      sessionId: 's-3',
      nativeGeneration: 'gen-3',
    })
    kernelTimeout.bindExecutor('exec-3')
    kernelTimeout.reportNativeEffects('pending')
    const hungWorkerGate = Promise.withResolvers<void>()
    kernelTimeout.disposables.register(() => {
      events.push('disposed')
    })
    kernelTimeout.ledger.recordings.enqueue(async (workerSignal) => {
      workerSignal.addEventListener('abort', () => {
        events.push('worker-aborted')
      })
      await hungWorkerGate.promise
      events.push('worker-exited')
    })
    const drainAbort = new AbortController()
    drainAbort.abort()
    const timeoutRes = await kernelTimeout.settle({ drainSignal: drainAbort.signal })
    expect(timeoutRes.recordingsDrained).toBe(false)
    expect(timeoutRes.disposalsDeferred).toBe(true)
    expect(events).toEqual(['worker-aborted'])
    expect(kernelTimeout.effectsState).toBe('unknown')
    hungWorkerGate.resolve()
    await kernelTimeout.ledger.recordings.whenWorkersIdle()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['worker-aborted', 'worker-exited', 'disposed'])

    // 4. BoundedBackgroundTaskTable cleans aliases in BOTH ambient orders and on completeTask.
    const table = new BoundedBackgroundTaskTable<{ kind: string }>()
    // Order A: registerProvisional -> markAmbient(provisional) -> confirmTask(confirmed, provisional)
    expect(table.registerProvisional('prov-a', { kind: 'bg' })).toBe(true)
    table.markAmbient('prov-a')
    expect(table.confirmTask('conf-a', { kind: 'bg' }, 'prov-a')).toBe(false)
    expect(table.aliasCount).toBe(0)
    expect(table.hasActiveTasks).toBe(false)

    // Order B: registerProvisional -> confirmTask(confirmed, provisional) -> markAmbient(confirmed)
    expect(table.registerProvisional('prov-b', { kind: 'bg' })).toBe(true)
    expect(table.confirmTask('conf-b', { kind: 'bg' }, 'prov-b')).toBe(true)
    expect(table.aliasCount).toBe(1)
    table.markAmbient('conf-b')
    expect(table.aliasCount).toBe(0)
    expect(table.hasActiveTasks).toBe(false)

    // Order C: normal confirmTask -> completeTask cleans reverse alias
    expect(table.registerProvisional('prov-c', { kind: 'bg' })).toBe(true)
    expect(table.confirmTask('conf-c', { kind: 'bg' }, 'prov-c')).toBe(true)
    expect(table.aliasCount).toBe(1)
    expect(table.completeTask('conf-c')).toBe(true)
    expect(table.aliasCount).toBe(0)
  })

  it('Astra re-audit S1-F5/F7/F8 regressions: redacts Basic/quoted JSON secrets, reflects post-drain drops in settle() & reportNativeEffects, and prevents zombie tasks across out-of-order completion/confirmation', async () => {
    // S1-F5: Basic auth headers and quoted JSON secret fields are completely redacted.
    const fakeBasicHeader = ['Basic', 'ZmFrZTpwYXNz'].join(' ')
    const fakeApiKey = ['sk', 'fake', 'fixture99999'].join('-')
    const fakeToken = ['tok', 'fake12345'].join('_')
    const fakeBasicJson = ['Basic', 'YWJjOmRlZg=='].join(' ')
    const syntheticError = `HTTP 401 ${['Authoriz', 'ation'].join('')}: ${fakeBasicHeader} ${JSON.stringify(
      {
        [['api', 'key'].join('_')]: fakeApiKey,
        [['to', 'ken'].join('')]: fakeToken,
        [['authoriz', 'ation'].join('')]: fakeBasicJson,
      },
    )}`
    const basicAndJson = sanitizeNativeTerminalFailure(syntheticError)
    expect(basicAndJson).not.toContain('ZmFrZTpwYXNz')
    expect(basicAndJson).not.toContain(fakeApiKey)
    expect(basicAndJson).not.toContain(fakeToken)
    expect(basicAndJson).not.toContain('YWJjOmRlZg')
    expect(basicAndJson).toContain('HTTP 401')
    expect(basicAndJson).toContain('[redacted]')
    // Ordinary non-secret token phrasing remains readable.
    expect(sanitizeNativeTerminalFailure('Input exceeded model token limit')).toBe(
      'Input exceeded model token limit',
    )

    // S1-F7: Empty-queue settle() followed synchronously by enqueue() reports droppedCount=1 and effects=unknown.
    const reportedStates: string[] = []
    const kDrop = new RunLifecycleKernel({
      agentId: 'codex',
      runId: 'run-empty-settle-drop',
      sessionId: 's-drop',
      nativeGeneration: 'gen-drop',
      callbacks: {
        onReportNativeEffects: (report) => reportedStates.push(report.state),
      },
    })
    kDrop.bindExecutor('exec-drop')
    kDrop.reportNativeEffects('pending')
    const settlePromise = kDrop.settle()
    expect(kDrop.ledger.recordings.enqueue(async () => {})).toBe(false)
    const dropRes = await settlePromise
    expect(dropRes.recordingsDroppedCount).toBe(1)
    expect(kDrop.effectsState).toBe('unknown')
    expect(reportedStates).not.toContain('settled')

    // S1-F7b: Explicit reportNativeEffects('settled') while a recording is active or failed fails closed to 'unknown'.
    const kActive = new RunLifecycleKernel({
      agentId: 'codex',
      runId: 'run-active-settle-guard',
      sessionId: 's-act',
      nativeGeneration: 'gen-act',
    })
    kActive.bindExecutor('exec-act')
    kActive.reportNativeEffects('pending')
    const recGate = Promise.withResolvers<void>()
    kActive.ledger.recordings.enqueue(async () => {
      await recGate.promise
    })
    expect(kActive.reportNativeEffects('settled')).toBe(true)
    expect(kActive.effectsState).toBe('unknown')
    recGate.resolve()
    await kActive.settle()

    // S1-F8: Both out-of-order task completion/confirmation sequences leave activeCount=0 and aliasCount=0.
    const table1 = new BoundedBackgroundTaskTable<{ kind: string }>()
    expect(table1.registerProvisional('prov-1', { kind: 'bg' })).toBe(true)
    expect(table1.completeTask('prov-1')).toBe(true)
    expect(table1.confirmTask('conf-1', { kind: 'bg' }, 'prov-1')).toBe(true)
    expect(table1.activeCount).toBe(0)
    expect(table1.aliasCount).toBe(0)
    expect(table1.hasActiveTasks).toBe(false)

    const table2 = new BoundedBackgroundTaskTable<{ kind: string }>()
    expect(table2.confirmTask('conf-2', { kind: 'bg' })).toBe(true)
    expect(table2.completeTask('prov-2')).toBe(false)
    expect(table2.confirmTask('conf-2', { kind: 'bg' }, 'prov-2')).toBe(true)
    expect(table2.activeCount).toBe(0)
    expect(table2.aliasCount).toBe(0)
    expect(table2.hasActiveTasks).toBe(false)

    // A-F7: Multi-member Cookie / Set-Cookie and comma-separated Digest Authorization headers are stripped in full.
    const cookieHeader = [
      'HTTP 401',
      `${['Coo', 'kie'].join('')}: first=alpha1; sid=sentinel_two_987; theme=dark`,
      `${['Authoriz', 'ation'].join('')}: Digest username="u1", realm="r1", response="sentinel_digest_val"`,
      'Retry-After: 5',
    ].join('\n')
    const sanitizedMulti = sanitizeNativeTerminalFailure(cookieHeader)
    expect(sanitizedMulti).not.toContain('alpha1')
    expect(sanitizedMulti).not.toContain('sentinel_two_987')
    expect(sanitizedMulti).not.toContain('theme=dark')
    expect(sanitizedMulti).not.toContain('sentinel_digest_val')
    expect(sanitizedMulti).toContain('HTTP 401')
    expect(sanitizedMulti).toContain('Retry-After: 5')

    // A-F9: Explicit reportNativeEffects('settled') stays pending while confirmed/provisional tasks are active.
    const taskEffectsLog: string[] = []
    const kTask = new RunLifecycleKernel({
      agentId: 'agy',
      runId: 'run-active-task-gate',
      sessionId: 's-task',
      nativeGeneration: 'gen-task',
      callbacks: {
        onReportNativeEffects: (report) => taskEffectsLog.push(report.state),
      },
    })
    kTask.bindExecutor('exec-task')
    kTask.reportNativeEffects('pending')
    expect(kTask.ledger.tasks.confirmTask('daemon-active-1', undefined)).toBe(true)
    // Ambient tasks remain excluded, while active confirmed tasks block settled
    kTask.ledger.tasks.markAmbient('ambient-ignored')
    expect(kTask.reportNativeEffects('settled')).toBe(false)
    expect(kTask.effectsState).toBe('pending')
    expect(taskEffectsLog).toEqual(['pending'])
    await kTask.settle({ retainBackgroundObservation: true })
    expect(kTask.effectsState).toBe('pending')
    expect(taskEffectsLog).not.toContain('settled')
    expect(kTask.ledger.tasks.completeTask('daemon-active-1')).toBe(true)
    expect(kTask.reportNativeEffects('settled')).toBe(true)
    expect(kTask.effectsState).toBe('settled')

    // A-Advisory1: Conflicting confirmed IDs for one provisional launch preserve the original confirmed task and latch uncertainty.
    const conflictTable = new BoundedBackgroundTaskTable<{ kind: string }>()
    expect(conflictTable.registerProvisional('prov-conflict', { kind: 'bg' })).toBe(true)
    expect(conflictTable.confirmTask('conf-a', { kind: 'bg' }, 'prov-conflict')).toBe(true)
    expect(conflictTable.completeTask('conf-b')).toBe(false)
    expect(conflictTable.confirmTask('conf-b', { kind: 'bg' }, 'prov-conflict')).toBe(true)
    expect(conflictTable.overflowed).toBe(true)
    // conf-a MUST still remain active until its own completion arrives!
    expect(conflictTable.hasActiveTasks).toBe(true)
    expect(conflictTable.confirmedCount).toBe(1)
    expect(conflictTable.completeTask('conf-a')).toBe(true)
    expect(conflictTable.hasActiveTasks).toBe(false)
  })
})
