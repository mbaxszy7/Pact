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
})
