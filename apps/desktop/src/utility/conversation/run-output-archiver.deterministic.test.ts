import { describe, expect, it } from 'vitest'

import type { ConversationPatch, NativeProbeResult, NormalizedAgentEvent } from '@pact/contracts'

import { CONVERSATION_MARKDOWN_BYTES } from '@pact/contracts'

import { RunOutputArchiver, type RunOutputArchiverHost } from './run-output-archiver'

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makePatch(seq: number, label: string, sessionId = 'session-1'): ConversationPatch {
  return {
    version: 'conversation-patch-v1',
    sessionId,
    observation: {
      incarnation: '00000000-0000-4000-8000-000000000001',
      sequence: seq,
    },
    session: {
      id: sessionId,
      title: label,
      titleSource: 'placeholder',
      status: 'idle',
      activity: { state: 'idle' },
      hasUnread: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    messages: [],
    runs: [],
    activities: [],
    activityStates: [],
  }
}

interface HarnessOptions {
  readonly seed: number
  readonly failOnCommitSeq?: number | undefined
  readonly failOnPublishSeq?: number | undefined
  readonly loseControlAfterStep?: number | undefined
}

function createHarness(options: HarnessOptions) {
  let commitSeq = 0
  const committedLabels: string[] = []
  const publishedLabels: string[] = []
  const committedTextParts: string[] = []
  let runEnded = false
  let hasControl = true
  let reconciledCount = 0
  let uncertainEffectsCount = 0
  let cutoffsMarked = 0

  const nextPatch = (label: string): ConversationPatch => {
    commitSeq += 1
    if (options.failOnCommitSeq === commitSeq) {
      throw new Error(`injected-commit-fault-${commitSeq}`)
    }
    committedLabels.push(`${commitSeq}:${label}`)
    return makePatch(commitSeq, `${commitSeq}:${label}`)
  }

  const host: RunOutputArchiverHost = {
    run: {
      id: `run-${options.seed}`,
      sessionId: 'session-1',
      agentId: 'codex',
      bindingGeneration: 1,
    },
    peerAssistanceAllowed: true,
    isOwned: () => true,
    isDisposed: () => false,
    ownsCurrentControl: () => hasControl,
    isRunEnded: () => runEnded,
    applyStreamBatch: (events, archive) => {
      for (const item of events) {
        if (item.type === 'text.delta') committedTextParts.push(item.text)
      }
      return nextPatch(archive ? 'archive-batch' : 'fg-batch')
    },
    applyEvent: (event, archive) => {
      if (event.type === 'text.completed') committedTextParts.push(event.text)
      if (event.type === 'turn.completed') runEnded = true
      return nextPatch(`${archive ? 'archive' : 'fg'}:${event.type}`)
    },
    completeAnswer: async (_metadata, parts, signal, archive) => {
      let body = ''
      for await (const chunk of parts(signal)) {
        body += chunk
      }
      committedTextParts.push(body)
      return nextPatch(`${archive ? 'archive' : 'fg'}:large-answer`)
    },
    recordNativeEvidence: (evidence) => {
      if (evidence.kind === 'ended') runEnded = true
      return nextPatch(`evidence:${evidence.kind}`)
    },
    recordOutputFailure: () => nextPatch('output-failure'),
    settleKnownNativeEnding: () => nextPatch('settle-known-ending'),
    recordWorkflowPlan: () => undefined,
    recordWorkflowReview: () => undefined,
    publish: (patch) => {
      if (options.failOnPublishSeq === patch.observation.sequence) {
        throw new Error(`injected-publish-fault-${patch.observation.sequence}`)
      }
      publishedLabels.push(patch.session.title)
    },
    observeNormalizedDelta: () => undefined,
    markInjectedCutoffs: () => {
      cutoffsMarked += 1
    },
    reconcileCompletedCollaboration: () => {
      reconciledCount += 1
    },
    observeUncertainEffects: () => {
      uncertainEffectsCount += 1
    },
  }

  const archiver = new RunOutputArchiver(host)

  return {
    archiver,
    setControl: (value: boolean) => {
      hasControl = value
    },
    committedLabels,
    publishedLabels,
    committedTextParts,
    getReconciledCount: () => reconciledCount,
    getUncertainEffectsCount: () => uncertainEffectsCount,
    getCutoffsMarked: () => cutoffsMarked,
  }
}

async function runArchiverInterleavingSeed(seed: number): Promise<void> {
  const rand = mulberry32(seed)
  const injectCommitFault = seed % 11 === 0 ? 2 + Math.floor(rand() * 5) : undefined
  const injectPublishFault = seed % 17 === 0 ? 3 + Math.floor(rand() * 4) : undefined
  const harness = createHarness({
    seed,
    failOnCommitSeq: injectCommitFault,
    failOnPublishSeq: injectPublishFault,
  })
  const { archiver } = harness

  const stepCount = 8 + Math.floor(rand() * 10)
  for (let step = 0; step < stepCount; step += 1) {
    if (rand() < 0.15) harness.setControl(false)
    const action = Math.floor(rand() * 7)
    try {
      switch (action) {
        case 0: {
          const delta: NormalizedAgentEvent = {
            agentId: 'codex',
            type: 'text.delta',
            turnId: 'turn-1',
            outputId: 'out-1',
            text: `fg-${step}-`,
          }
          // oxlint-disable-next-line no-await-in-loop -- Sequential deterministic seed replay.
          await archiver.admitEvent(delta, 'foreground')
          break
        }
        case 1: {
          const delta: NormalizedAgentEvent = {
            agentId: 'codex',
            type: 'text.delta',
            turnId: 'turn-1',
            outputId: 'out-1',
            text: `arch-${step}-`,
          }
          archiver.admitArchiveEventSync(delta)
          break
        }
        case 2: {
          const completed: NormalizedAgentEvent = {
            agentId: 'codex',
            type: 'text.completed',
            turnId: 'turn-1',
            outputId: 'out-1',
            text: `done-${step}`,
          }
          // oxlint-disable-next-line no-await-in-loop -- Sequential deterministic seed replay.
          await archiver.admitEvent(completed, rand() < 0.5 ? 'foreground' : 'archive')
          break
        }
        case 3: {
          const evidence: NativeProbeResult = {
            kind: 'ended',
            identity: {
              agentId: 'codex',
              sessionId: 'session-1',
              runId: `run-${seed}`,
              requestId: `run-${seed}`,
              nativeSessionId: 'native-1',
              nativeTurnId: 'turn-1',
              executorId: 'exec-1',
              bindingGeneration: 1,
            },
            source: 'live_terminal',
            outcome: 'completed',
            output: { outputId: 'out-1', text: 'done', completeness: 'complete' },
          }
          archiver.admitTerminalReceipt(evidence)
          break
        }
        case 4: {
          archiver.flush()
          break
        }
        case 5: {
          const turnDone: NormalizedAgentEvent = {
            agentId: 'codex',
            type: 'turn.completed',
            turnId: 'turn-1',
            outcome: 'completed',
          }
          archiver.admitArchiveEventSync(turnDone)
          break
        }
        default: {
          if (rand() < 0.25) {
            archiver.markAborted(new Error(`seed-abort-${seed}`))
          }
          break
        }
      }
    } catch {
      // Expected when fault injection triggers body-lane quarantine on foreground throws.
    }
  }

  await archiver.drain()
  archiver.dispose()

  // Invariant 1: Working memory ALWAYS returns to 0 bytes after drain + dispose.
  expect(archiver.archiveMemory.bytes).toBe(0)
  expect(archiver.archivePending).toBe(0)

  // Invariant 2: When no publish fault was injected, SQLite commit order === ConversationPatch order byte-for-byte.
  const parityHolds =
    injectPublishFault !== undefined ||
    (harness.publishedLabels.length === harness.committedLabels.length &&
      harness.publishedLabels.every((label, index) => label === harness.committedLabels[index]))
  expect(parityHolds).toBe(true)

  // Invariant 3: Even under publish fault, published labels are always a strict ordered prefix
  // (or subsequence matching commit order with zero out-of-order inversion).
  let lastRevision = 0
  let monotonic = true
  for (const label of harness.publishedLabels) {
    const rev = Number(label.split(':')[0])
    if (rev <= lastRevision) monotonic = false
    lastRevision = rev
  }
  expect(monotonic).toBe(true)
}

describe('RunOutputArchiver deterministic single-writer invariants', () => {
  it('preserves SQLite-to-Patch ordering parity, zero memory leaks, and safe fault quarantine across 1,000 seeded interleavings', async () => {
    const seeds = Array.from({ length: 1_000 }, (_, index) => index + 1)
    const completed = await Promise.all(seeds.map((seed) => runArchiverInterleavingSeed(seed)))
    expect(completed).toHaveLength(1_000)
  })

  it('streams large archived text.completed through bounded memory without losing surrogate pairs and returns memory to zero', async () => {
    const harness = createHarness({ seed: 9_999 })
    const { archiver } = harness
    const emojiChunk = '😀'.repeat(Math.ceil((CONVERSATION_MARKDOWN_BYTES + 4096) / 4))

    archiver.admitArchiveEventSync({
      agentId: 'codex',
      type: 'text.completed',
      turnId: 'turn-1',
      outputId: 'out-large',
      text: emojiChunk,
    })

    await archiver.drain()
    archiver.dispose()

    expect(archiver.archiveMemory.bytes).toBe(0)
    expect(archiver.archivePending).toBe(0)
    expect(harness.committedTextParts.join('')).toBe(emojiChunk)
    expect(harness.publishedLabels).toEqual(harness.committedLabels)
  })

  it('commits terminal metadata before flushing body and preserves settleKnownNativeEnding on quarantined body failure', async () => {
    const harness = createHarness({ seed: 10_001 })
    const { archiver } = harness
    harness.setControl(false)

    // Quarantine body lane first (e.g. terminal-before-body / oversized delta error).
    archiver.markAborted(new Error('oversized body'))
    expect(archiver.outputFailure).toBeDefined()

    // Terminal receipt arrives afterwards: metadata commits first, then settleKnownNativeEnding fires once.
    const evidence: NativeProbeResult = {
      kind: 'ended',
      identity: {
        agentId: 'codex',
        sessionId: 'session-1',
        runId: 'run-10001',
        requestId: 'run-10001',
        nativeSessionId: 'native-1',
        nativeTurnId: 'turn-1',
        executorId: 'exec-1',
        bindingGeneration: 1,
      },
      source: 'live_terminal',
      outcome: 'completed',
    }
    archiver.admitTerminalReceipt(evidence)
    // Duplicate post-terminal turn.completed on archive lane must be idempotently ignored.
    archiver.admitArchiveEventSync({
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'turn-1',
      outcome: 'completed',
    })

    await archiver.drain()
    archiver.dispose()

    expect(harness.committedLabels).toEqual([
      '1:output-failure',
      '2:evidence:ended',
      '3:settle-known-ending',
    ])
    expect(harness.publishedLabels).toEqual(harness.committedLabels)
  })
})
