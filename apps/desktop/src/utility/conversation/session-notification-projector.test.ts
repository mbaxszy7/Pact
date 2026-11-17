import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ConversationPatch } from '@pact/contracts'

import { SessionNotificationProjector } from './session-notification-projector.js'

const BASE_TIME = '2026-11-16T10:00:00.000Z'

function makePatch(overrides: {
  sessionId?: string
  title?: string
  status?: ConversationPatch['session']['status']
  activity?: ConversationPatch['session']['activity']
  updatedAt?: string
  runs?: ConversationPatch['runs']
  latestRunId?: string
  messages?: ConversationPatch['messages']
  pendingNativeInteractions?: ConversationPatch['pendingNativeInteractions']
  relaySchedulingDecision?: ConversationPatch['relaySchedulingDecision']
  collaborationNotification?: ConversationPatch['collaborationNotification']
  pendingRoutedContinuation?: boolean
}): ConversationPatch {
  const sessionId = overrides.sessionId ?? randomUUID()
  return {
    version: 'conversation-patch-v1',
    sessionId,
    observation: { incarnation: randomUUID(), sequence: 1 },
    session: {
      id: sessionId,
      title: overrides.title ?? 'Auth fix',
      titleSource: 'local',
      status: overrides.status ?? 'idle',
      activity: overrides.activity ?? { state: 'idle' },
      hasUnread: false,
      updatedAt: overrides.updatedAt ?? BASE_TIME,
    },
    messages: overrides.messages ?? [],
    runs: overrides.runs ?? [],
    ...(overrides.latestRunId ? { latestRunId: overrides.latestRunId } : {}),
    activities: [],
    activityStates: [],
    ...(overrides.pendingNativeInteractions !== undefined
      ? { pendingNativeInteractions: overrides.pendingNativeInteractions }
      : {}),
    ...(overrides.relaySchedulingDecision !== undefined
      ? { relaySchedulingDecision: overrides.relaySchedulingDecision }
      : {}),
    ...(overrides.collaborationNotification !== undefined
      ? { collaborationNotification: overrides.collaborationNotification }
      : {}),
    ...(overrides.pendingRoutedContinuation !== undefined
      ? { pendingRoutedContinuation: overrides.pendingRoutedContinuation }
      : {}),
  }
}

function makeRun(
  sessionId: string,
  overrides: Partial<ConversationPatch['runs'][number]> = {},
): ConversationPatch['runs'][number] {
  return {
    id: overrides.id ?? randomUUID(),
    sessionId,
    userMessageId: overrides.userMessageId ?? randomUUID(),
    agentId: overrides.agentId ?? 'codex',
    status: overrides.status ?? 'running',
    attemptCount: overrides.attemptCount ?? 1,
    settingsRevision: overrides.settingsRevision ?? 1,
    model: null,
    effort: null,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    ...overrides,
  }
}

function makePendingInteraction(
  requestId: string,
  agentId: 'codex' | 'claude' = 'codex',
): NonNullable<ConversationPatch['pendingNativeInteractions']>[number] {
  return {
    agentId,
    bindingGeneration: 1,
    request: {
      id: requestId,
      kind: 'approval',
      title: 'Approve command',
      detail: 'Run pnpm test',
      createdAt: BASE_TIME,
    },
  }
}

function makeRelayDecision(
  sessionId: string,
  decisionId: string,
  revision = 1,
): NonNullable<ConversationPatch['relaySchedulingDecision']> {
  return {
    version: 'relay-decision-v2',
    sessionId,
    decisionId,
    revision,
    handoffId: 'a'.repeat(64),
    title: 'Choose reviewer',
    reason: 'Needs input before continuing.',
    consequence: 'Holds turn until confirmed.',
    sources: [{ id: 'src-1', label: 'Session' }],
    request: {
      category: 'arrangement_change',
      operation: {
        kind: 'rebuild_native_context',
        agentId: 'codex',
        expectedGeneration: 1,
        expectedNativeSessionId: null,
        expectedRunId: null,
        expectedRebuildId: null,
        abandonOldWork: false,
      },
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SessionNotificationProjector', () => {
  it('ignores progress patches and suppresses historical states on first observation except live native/Relay prompts', () => {
    const projector = new SessionNotificationProjector()
    const sessionA = randomUUID()
    const runA = randomUUID()

    // Progress patches never project notifications or establish baseline.
    expect(
      projector.observe(
        makePatch({
          sessionId: sessionA,
          status: 'completed',
          activity: { state: 'completed', agentId: 'codex' },
          runs: [
            makeRun(sessionA, {
              id: runA,
              status: 'completed',
              nativeEffectsState: 'settled',
              outputSnapshots: {
                count: 1,
                lastInputMessageId: randomUUID(),
                lastInputSequence: 1,
                settled: true,
              },
            }),
          ],
        }),
        true,
      ),
    ).toEqual([])

    // First non-progress observation records historical settled completion/failure/plan_ready silently.
    expect(
      projector.observe(
        makePatch({
          sessionId: sessionA,
          status: 'plan_ready',
          activity: { state: 'completed', agentId: 'codex' },
          runs: [
            makeRun(sessionA, {
              id: runA,
              status: 'completed',
              nativeEffectsState: 'settled',
              outputSnapshots: {
                count: 1,
                lastInputMessageId: randomUUID(),
                lastInputSequence: 1,
                settled: true,
              },
            }),
          ],
        }),
        false,
      ),
    ).toEqual([])

    // Live native interaction and Relay decision on first observation raise immediately.
    const sessionB = randomUUID()
    const requestId = randomUUID()
    const decisionId = randomUUID()
    const events = projector.observe(
      makePatch({
        sessionId: sessionB,
        status: 'waiting_for_user',
        activity: { state: 'waiting_for_user', agentId: 'claude' },
        pendingNativeInteractions: [makePendingInteraction(requestId, 'claude')],
        relaySchedulingDecision: makeRelayDecision(sessionB, decisionId, 2),
      }),
      false,
    )
    expect(events).toHaveLength(2)
    expect(events.map((event) => ({ kind: event.kind, id: event.id }))).toEqual([
      { kind: 'raise', id: `native:${sessionB}:${requestId}` },
      { kind: 'raise', id: `relay:${sessionB}:${decisionId}:2` },
    ])
  })

  it('raises and revokes needs_input for native interactions, Relay decisions, collaboration needs, and waiting_for_user/plan_ready', () => {
    const projector = new SessionNotificationProjector()
    const sessionId = randomUUID()
    const requestId = randomUUID()
    const decisionId = randomUUID()
    const taskId = randomUUID()
    const runId = randomUUID()

    expect(projector.observe(makePatch({ sessionId }), false)).toEqual([])

    // 1. Native permission / question raise -> revoke (while activity stays agent_working)
    const nativeRaised = projector.observe(
      makePatch({
        sessionId,
        status: 'discussing',
        activity: { state: 'agent_working', agentId: 'codex' },
        pendingNativeInteractions: [makePendingInteraction(requestId, 'codex')],
      }),
      false,
    )
    expect(nativeRaised).toMatchObject([
      {
        kind: 'raise',
        id: `native:${sessionId}:${requestId}`,
        category: 'needs_input',
        priority: 3,
        agentId: 'codex',
      },
    ])

    const nativeRevoked = projector.observe(
      makePatch({
        sessionId,
        status: 'discussing',
        activity: { state: 'agent_working', agentId: 'codex' },
        pendingNativeInteractions: [],
      }),
      false,
    )
    expect(nativeRevoked).toEqual([
      { kind: 'revoke', id: `native:${sessionId}:${requestId}`, sessionId },
    ])

    // 2. Relay decision raise -> revoke
    const relayRaised = projector.observe(
      makePatch({
        sessionId,
        status: 'waiting_for_user',
        activity: { state: 'waiting_for_user', agentId: 'claude' },
        relaySchedulingDecision: makeRelayDecision(sessionId, decisionId, 1),
      }),
      false,
    )
    expect(relayRaised).toMatchObject([
      {
        kind: 'raise',
        id: `relay:${sessionId}:${decisionId}:1`,
        category: 'needs_input',
        priority: 3,
      },
    ])

    const relayRevoked = projector.observe(
      makePatch({
        sessionId,
        status: 'idle',
        activity: { state: 'idle' },
        relaySchedulingDecision: null,
      }),
      false,
    )
    expect(relayRevoked).toEqual([
      { kind: 'revoke', id: `relay:${sessionId}:${decisionId}:1`, sessionId },
    ])

    // 3. Collaboration needs_user -> revoke
    const collabRaised = projector.observe(
      makePatch({
        sessionId,
        status: 'waiting_for_user',
        collaborationNotification: {
          taskId,
          revision: 3,
          runId,
          state: 'needs_user',
          agentId: 'claude',
        },
      }),
      false,
    )
    expect(collabRaised).toMatchObject([
      {
        kind: 'raise',
        id: `collab-needs:${taskId}:3`,
        category: 'needs_input',
        priority: 3,
        agentId: 'claude',
      },
    ])

    const collabRevoked = projector.observe(
      makePatch({
        sessionId,
        status: 'building',
        activity: { state: 'agent_working', agentId: 'claude' },
        collaborationNotification: {
          taskId,
          revision: 4,
          runId,
          state: 'working',
          agentId: 'claude',
        },
      }),
      false,
    )
    expect(collabRevoked).toEqual([{ kind: 'revoke', id: `collab-needs:${taskId}:3`, sessionId }])

    // 4. Plan ready / waiting_for_user status -> revoke
    const planRaised = projector.observe(
      makePatch({
        sessionId,
        status: 'plan_ready',
        updatedAt: '2026-11-16T10:01:00.000Z',
        activity: { state: 'waiting_for_user', agentId: 'codex' },
      }),
      false,
    )
    expect(planRaised).toMatchObject([
      {
        kind: 'raise',
        id: `needs:${sessionId}:2026-11-16T10:01:00.000Z`,
        category: 'needs_input',
        priority: 3,
      },
    ])

    const planRevoked = projector.observe(
      makePatch({
        sessionId,
        status: 'idle',
        updatedAt: '2026-11-16T10:02:00.000Z',
        activity: { state: 'idle' },
      }),
      false,
    )
    expect(planRevoked).toEqual([
      { kind: 'revoke', id: `needs:${sessionId}:2026-11-16T10:01:00.000Z`, sessionId },
    ])
  })

  it('raises failure for failed and abnormal interrupted runs/activities while keeping user_stopped silent', () => {
    const projector = new SessionNotificationProjector()
    const sessionId = randomUUID()
    expect(projector.observe(makePatch({ sessionId }), false)).toEqual([])

    // Abnormal interrupted run (non-user_stopped) emits failure once.
    const interruptedRunId = randomUUID()
    const interruptedPatch = makePatch({
      sessionId,
      status: 'paused',
      activity: { state: 'interrupted', agentId: 'codex' },
      latestRunId: interruptedRunId,
      runs: [
        makeRun(sessionId, {
          id: interruptedRunId,
          agentId: 'codex',
          status: 'interrupted',
          failureKind: 'agent_process_crash',
        }),
      ],
    })
    expect(projector.observe(interruptedPatch, false)).toMatchObject([
      {
        kind: 'raise',
        id: `failure:${sessionId}:${interruptedRunId}`,
        category: 'failure',
        priority: 2,
        agentId: 'codex',
      },
    ])
    // Duplicate patch for same interrupted run does not re-emit.
    expect(projector.observe(interruptedPatch, false)).toEqual([])

    // Explicit failed run emits failure once.
    const failedRunId = randomUUID()
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'paused',
          activity: { state: 'error', agentId: 'claude' },
          latestRunId: failedRunId,
          runs: [
            makeRun(sessionId, {
              id: failedRunId,
              agentId: 'claude',
              status: 'failed',
              failureKind: 'context_limit',
            }),
          ],
        }),
        false,
      ),
    ).toMatchObject([
      {
        kind: 'raise',
        id: `failure:${sessionId}:${failedRunId}`,
        category: 'failure',
        priority: 2,
        agentId: 'claude',
      },
    ])

    // Reset to idle, then user_stopped interrupted run MUST stay silent even across follow-up patches.
    expect(
      projector.observe(
        makePatch({ sessionId, status: 'idle', activity: { state: 'idle' } }),
        false,
      ),
    ).toEqual([])
    const stoppedRunId = randomUUID()
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'paused',
          activity: { state: 'interrupted', agentId: 'codex' },
          latestRunId: stoppedRunId,
          runs: [
            makeRun(sessionId, {
              id: stoppedRunId,
              agentId: 'codex',
              status: 'interrupted',
              failureKind: 'user_stopped',
            }),
          ],
        }),
        false,
      ),
    ).toEqual([])
    // Follow-up patch referencing latestRunId === stoppedRunId with empty runs also stays silent.
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'idle',
          activity: { state: 'interrupted', agentId: 'codex' },
          latestRunId: stoppedRunId,
          runs: [],
          updatedAt: '2026-11-16T10:05:00.000Z',
        }),
        false,
      ),
    ).toEqual([])

    // New run clears userStoppedRunId and empty-run abnormal activity fallback notifies once.
    const newRunId = randomUUID()
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'idle',
          activity: { state: 'idle' },
          latestRunId: newRunId,
          runs: [],
        }),
        false,
      ),
    ).toEqual([])
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'paused',
          activity: { state: 'interrupted', agentId: 'claude' },
          latestRunId: newRunId,
          runs: [],
          updatedAt: '2026-11-16T10:06:00.000Z',
        }),
        false,
      ),
    ).toMatchObject([
      {
        kind: 'raise',
        id: `failure:${sessionId}:${newRunId}`,
        category: 'failure',
        priority: 2,
        agentId: 'claude',
      },
    ])
  })

  it('deduplicates collaboration failure against run failure and waits for settled completion', () => {
    const projector = new SessionNotificationProjector()
    const sessionId = randomUUID()
    const taskId = randomUUID()
    const failRunId = randomUUID()
    const completeRunId = randomUUID()

    expect(projector.observe(makePatch({ sessionId }), false)).toEqual([])

    // Collaboration failure emits failure:<sessionId>:<runId> once even when run patch follows.
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'paused',
          collaborationNotification: {
            taskId,
            revision: 1,
            runId: failRunId,
            state: 'failure',
            agentId: 'codex',
          },
          runs: [makeRun(sessionId, { id: failRunId, status: 'failed' })],
        }),
        false,
      ),
    ).toMatchObject([
      { kind: 'raise', id: `failure:${sessionId}:${failRunId}`, category: 'failure' },
    ])
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'paused',
          runs: [makeRun(sessionId, { id: failRunId, status: 'failed' })],
        }),
        false,
      ),
    ).toEqual([])

    // Unsettled completion (pending nativeEffects or unsettled outputSnapshots) waits until settled.
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'completed',
          activity: { state: 'completed', agentId: 'claude' },
          runs: [
            makeRun(sessionId, {
              id: completeRunId,
              agentId: 'claude',
              status: 'completed',
              nativeEffectsState: 'pending',
              outputSnapshots: {
                count: 1,
                lastInputMessageId: randomUUID(),
                lastInputSequence: 1,
                settled: false,
              },
            }),
          ],
        }),
        false,
      ),
    ).toEqual([])

    // Routed continuation holds off completion for the first agent's run;
    // the continued run emits completion once routed continuation clears.
    const routedRunId = randomUUID()
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'discussing',
          pendingRoutedContinuation: true,
          runs: [
            makeRun(sessionId, {
              id: routedRunId,
              agentId: 'codex',
              status: 'completed',
              nativeEffectsState: 'settled',
              outputSnapshots: {
                count: 1,
                lastInputMessageId: randomUUID(),
                lastInputSequence: 1,
                settled: true,
              },
            }),
          ],
        }),
        false,
      ),
    ).toEqual([])

    // Once settled and no routed continuation, the final run emits completed exactly once.
    const completedEvents = projector.observe(
      makePatch({
        sessionId,
        status: 'completed',
        activity: { state: 'completed', agentId: 'claude' },
        pendingRoutedContinuation: false,
        runs: [
          makeRun(sessionId, {
            id: completeRunId,
            agentId: 'claude',
            status: 'completed',
            nativeEffectsState: 'settled',
            outputSnapshots: {
              count: 1,
              lastInputMessageId: randomUUID(),
              lastInputSequence: 1,
              settled: true,
            },
          }),
        ],
      }),
      false,
    )
    expect(completedEvents).toMatchObject([
      {
        kind: 'raise',
        id: `completed:${sessionId}:${completeRunId}`,
        category: 'completed',
        priority: 1,
        agentId: 'claude',
      },
    ])

    // Collaboration complete deduplicates against matching run completion.
    const collabCompleteRun = randomUUID()
    expect(
      projector.observe(
        makePatch({
          sessionId,
          status: 'completed',
          activity: { state: 'completed', agentId: 'codex' },
          collaborationNotification: {
            taskId,
            revision: 2,
            runId: collabCompleteRun,
            state: 'complete',
            agentId: 'codex',
          },
          runs: [
            makeRun(sessionId, {
              id: collabCompleteRun,
              agentId: 'codex',
              status: 'completed',
              nativeEffectsState: 'settled',
            }),
          ],
        }),
        false,
      ),
    ).toMatchObject([
      {
        kind: 'raise',
        id: `collab-completed:${taskId}:${collabCompleteRun}`,
        category: 'completed',
      },
    ])
  })

  it('bounds tracked sessions and clears state on dispose', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(BASE_TIME))
    const projector = new SessionNotificationProjector()

    const firstSessionId = randomUUID()
    projector.observe(makePatch({ sessionId: firstSessionId, status: 'completed' }), false)
    for (let index = 0; index < 260; index += 1) {
      vi.advanceTimersByTime(10)
      projector.observe(makePatch({ sessionId: randomUUID(), status: 'idle' }), false)
    }
    // First session was evicted due to 256-session cap, so re-observing treats it as fresh baseline.
    expect(
      projector.observe(
        makePatch({
          sessionId: firstSessionId,
          status: 'completed',
          activity: { state: 'completed', agentId: 'codex' },
        }),
        false,
      ),
    ).toEqual([])

    projector.dispose()
    // After dispose, observing a session treats it as a fresh baseline again.
    expect(
      projector.observe(
        makePatch({
          sessionId: firstSessionId,
          status: 'completed',
          activity: { state: 'completed', agentId: 'codex' },
        }),
        false,
      ),
    ).toEqual([])
  })
})
