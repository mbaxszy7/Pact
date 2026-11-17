import type {
  ConversationPatch,
  SessionNotificationCategory,
  SessionNotificationEvent,
} from '@pact/contracts'

interface SessionNotificationState {
  initialized: boolean
  status: ConversationPatch['session']['status'] | undefined
  activity: ConversationPatch['session']['activity']['state'] | undefined
  pendingInteractionIds: Set<string>
  runStates: Map<string, ConversationPatch['runs'][number]['status']>
  userStoppedRunId: string | undefined
  collaborationNeedsId: string | undefined
  collaborationFailureId: string | undefined
  collaborationCompletedId: string | undefined
  collaborationCompletedRunId: string | undefined
  needsId: string | undefined
  relayId: string | undefined
  lastSeenAt: number
}

const MAX_TRACKED_SESSIONS = 256
const MAX_TRACKED_BYTES = 512 * 1024
const MAX_TRACKED_RUNS = 64
const TRACKED_SESSION_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_STATUSES = new Set<ConversationPatch['session']['status']>([
  'draft',
  'idle',
  'completed',
  'paused',
  'archived',
])

const COLLABORATION_WORKING_STATUSES = new Set<ConversationPatch['session']['status']>([
  'discussing',
  'building',
  'reviewing',
])

const NEEDS_STATUSES = new Set<ConversationPatch['session']['status']>([
  'plan_ready',
  'waiting_for_user',
])

function latestRun(patch: ConversationPatch) {
  if (patch.latestRunId) return patch.runs.find((run) => run.id === patch.latestRunId)
  return patch.runs.at(-1)
}

function isRunCompletionSettled(run: ConversationPatch['runs'][number]): boolean {
  return (
    run.status === 'completed' &&
    run.outputSnapshots?.settled !== false &&
    run.nativeEffectsState !== 'pending' &&
    run.nativeEffectsState !== 'unknown'
  )
}

function isAbnormalRunStatus(
  status: ConversationPatch['runs'][number]['status'] | undefined,
): boolean {
  return status === 'failed' || status === 'interrupted'
}

function isRunAbnormalFailure(run: ConversationPatch['runs'][number]): boolean {
  return isAbnormalRunStatus(run.status) && run.failureKind !== 'user_stopped'
}

function isAbnormalActivity(
  activity: ConversationPatch['session']['activity']['state'] | undefined,
): boolean {
  return activity === 'error' || activity === 'interrupted'
}

function hasRoutedContinuation(patch: ConversationPatch): boolean {
  if (patch.pendingRoutedContinuation !== undefined) return patch.pendingRoutedContinuation
  return patch.messages.some(
    (change) => change.message.role === 'user' && Boolean(change.message.pendingAgentId),
  )
}

function priority(category: SessionNotificationCategory): number {
  return category === 'needs_input' ? 3 : category === 'failure' ? 2 : 1
}

function notificationTitle(patch: ConversationPatch): string {
  return patch.session.title.slice(0, 120) || 'Session'
}

function relayNotificationId(patch: ConversationPatch): string | undefined {
  const relay = patch.relaySchedulingDecision
  return relay ? `relay:${patch.sessionId}:${relay.decisionId}:${relay.revision}` : undefined
}

function collaborationNeedsId(
  notification: NonNullable<ConversationPatch['collaborationNotification']>,
): string {
  return `collab-needs:${notification.taskId}:${notification.revision}`
}

function collaborationFailureId(
  notification: NonNullable<ConversationPatch['collaborationNotification']>,
  sessionId: string,
): string {
  // Match the ordinary Run failure identity so the same terminal fact can only
  // produce one notification even if both projections arrive in separate Patches.
  return `failure:${sessionId}:${notification.runId}`
}

function collaborationCompletedId(
  notification: NonNullable<ConversationPatch['collaborationNotification']>,
): string {
  return `collab-completed:${notification.taskId}:${notification.runId}`
}

function raise(
  patch: ConversationPatch,
  id: string,
  category: SessionNotificationCategory,
  agentId: ConversationPatch['session']['activity']['agentId'],
): SessionNotificationEvent {
  return {
    kind: 'raise',
    id,
    sessionId: patch.sessionId,
    sessionTitle: notificationTitle(patch),
    ...(agentId ? { agentId } : {}),
    category,
    priority: priority(category),
    createdAt: new Date().toISOString(),
  }
}

/**
 * Projects durable Conversation transitions into compact notification events.
 * It intentionally observes only non-progress Patches and suppresses the first
 * observation of a Session, so startup, history reads and re-subscriptions do
 * not replay old completions.
 */
export class SessionNotificationProjector {
  private readonly sessions = new Map<string, SessionNotificationState>()

  observe(patch: ConversationPatch, progress: boolean): SessionNotificationEvent[] {
    if (progress) return []
    this.pruneSessions()
    const previous = this.sessions.get(patch.sessionId)
    if (!previous) {
      this.makeRoom()
      const pendingInteractionIds = new Set(
        (patch.pendingNativeInteractions ?? []).map((interaction) => interaction.request.id),
      )
      const relayId = relayNotificationId(patch)
      const collaboration = patch.collaborationNotification
      const collaborationNeeds = collaboration?.state === 'needs_user'
      const collaborationFailure = collaboration?.state === 'failure'
      const collaborationContinues =
        collaboration?.state === 'working' || collaboration?.state === 'auto_continue'
      const sessionNeedsPrompt =
        NEEDS_STATUSES.has(patch.session.status) ||
        patch.session.activity.state === 'waiting_for_user'
      const needsId =
        sessionNeedsPrompt &&
        !relayId &&
        !collaborationNeeds &&
        !collaborationFailure &&
        !collaborationContinues
          ? `needs:${patch.sessionId}:${patch.session.updatedAt}`
          : undefined
      const userStoppedRun = patch.runs.findLast((run) => run.failureKind === 'user_stopped')
      const events: SessionNotificationEvent[] = []
      // On first observation of a Session, only live native/Relay prompts raise immediately;
      // historical settled failure, completion and plan-ready states are recorded as baseline.
      for (const interaction of patch.pendingNativeInteractions ?? []) {
        events.push({
          kind: 'raise',
          id: `native:${patch.sessionId}:${interaction.request.id}`,
          sessionId: patch.sessionId,
          sessionTitle: notificationTitle(patch),
          ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
          category: 'needs_input',
          priority: 3,
          createdAt: new Date().toISOString(),
        })
      }
      if (relayId) events.push(raise(patch, relayId, 'needs_input', patch.session.activity.agentId))
      const collaborationNeedsEventId =
        collaboration?.state === 'needs_user' ? collaborationNeedsId(collaboration) : undefined
      const collaborationFailureEventId =
        collaboration?.state === 'failure'
          ? collaborationFailureId(collaboration, patch.sessionId)
          : undefined
      this.sessions.set(patch.sessionId, {
        initialized: true,
        status: patch.session.status,
        activity: patch.session.activity.state,
        pendingInteractionIds,
        runStates: new Map(
          patch.runs.map(
            (run) =>
              [
                run.id,
                run.status === 'completed' && !isRunCompletionSettled(run) ? 'running' : run.status,
              ] as const,
          ),
        ),
        userStoppedRunId: userStoppedRun?.id,
        collaborationNeedsId: collaborationNeedsEventId,
        collaborationFailureId: collaborationFailureEventId,
        collaborationCompletedId:
          collaboration?.state === 'complete' ? collaborationCompletedId(collaboration) : undefined,
        collaborationCompletedRunId:
          collaboration?.state === 'complete' ? collaboration.runId : undefined,
        needsId,
        relayId,
        lastSeenAt: Date.now(),
      })
      this.enforceBudget()
      return events
    }

    const events: SessionNotificationEvent[] = []
    const nextPending = new Set(
      (patch.pendingNativeInteractions ?? []).map((interaction) => interaction.request.id),
    )
    if (patch.pendingNativeInteractions) {
      for (const id of previous.pendingInteractionIds) {
        if (nextPending.has(id)) continue
        events.push({
          kind: 'revoke',
          id: `native:${patch.sessionId}:${id}`,
          sessionId: patch.sessionId,
        })
      }
      for (const interaction of patch.pendingNativeInteractions) {
        const id = interaction.request.id
        if (previous.pendingInteractionIds.has(id)) continue
        events.push({
          kind: 'raise',
          id: `native:${patch.sessionId}:${id}`,
          sessionId: patch.sessionId,
          sessionTitle: notificationTitle(patch),
          ...(interaction.agentId ? { agentId: interaction.agentId } : {}),
          category: 'needs_input',
          priority: 3,
          createdAt: new Date().toISOString(),
        })
      }
    }

    const collaboration = patch.collaborationNotification
    const collaborationNeeds = collaboration?.state === 'needs_user'
    const collaborationFailure = collaboration?.state === 'failure'
    const collaborationComplete = collaboration?.state === 'complete'
    const collaborationContinues =
      collaboration?.state === 'working' || collaboration?.state === 'auto_continue'
    let emittedCollaborationFailure = false
    if (collaborationNeeds && collaboration) {
      const id = collaborationNeedsId(collaboration)
      if (previous.collaborationNeedsId !== id) {
        if (previous.collaborationNeedsId)
          events.push({
            kind: 'revoke',
            id: previous.collaborationNeedsId,
            sessionId: patch.sessionId,
          })
        events.push(
          raise(patch, id, 'needs_input', collaboration.agentId ?? patch.session.activity.agentId),
        )
        previous.collaborationNeedsId = id
      }
    } else if (previous.collaborationNeedsId) {
      events.push({
        kind: 'revoke',
        id: previous.collaborationNeedsId,
        sessionId: patch.sessionId,
      })
      previous.collaborationNeedsId = undefined
    }
    if (collaborationFailure && collaboration) {
      const id = collaborationFailureId(collaboration, patch.sessionId)
      if (previous.collaborationFailureId !== id) {
        events.push(
          raise(patch, id, 'failure', collaboration.agentId ?? patch.session.activity.agentId),
        )
        previous.collaborationFailureId = id
      }
      emittedCollaborationFailure = true
    }
    if (collaborationComplete && collaboration) {
      const id = collaborationCompletedId(collaboration)
      if (previous.collaborationCompletedId !== id) {
        events.push(
          raise(patch, id, 'completed', collaboration.agentId ?? patch.session.activity.agentId),
        )
        previous.collaborationCompletedId = id
      }
      previous.collaborationCompletedRunId = collaboration.runId
    }

    const status = patch.session.status
    const activity = patch.session.activity.state
    const run = latestRun(patch)
    const sessionNeedsPrompt = NEEDS_STATUSES.has(status) || activity === 'waiting_for_user'
    let emittedNeeds = false
    const relayId = relayNotificationId(patch)
    let relayRaised = false
    if (relayId !== previous.relayId) {
      if (previous.relayId)
        events.push({ kind: 'revoke', id: previous.relayId, sessionId: patch.sessionId })
      if (relayId) {
        events.push(raise(patch, relayId, 'needs_input', patch.session.activity.agentId))
        relayRaised = true
      }
      previous.relayId = relayId
    }

    if (collaborationNeeds) {
      if (previous.needsId) {
        events.push({ kind: 'revoke', id: previous.needsId, sessionId: patch.sessionId })
        previous.needsId = undefined
      }
      emittedNeeds = true
    } else if (collaborationFailure || collaborationContinues || collaborationComplete) {
      if (previous.needsId) {
        events.push({ kind: 'revoke', id: previous.needsId, sessionId: patch.sessionId })
        previous.needsId = undefined
      }
    } else if (
      sessionNeedsPrompt &&
      !relayRaised &&
      (previous.status !== status || previous.activity !== activity)
    ) {
      const id = `needs:${patch.sessionId}:${patch.session.updatedAt}`
      if (previous.needsId && previous.needsId !== id)
        events.push({ kind: 'revoke', id: previous.needsId, sessionId: patch.sessionId })
      events.push(raise(patch, id, 'needs_input', patch.session.activity.agentId))
      previous.needsId = id
      emittedNeeds = true
    } else if (!sessionNeedsPrompt && previous.needsId) {
      events.push({ kind: 'revoke', id: previous.needsId, sessionId: patch.sessionId })
      previous.needsId = undefined
    }

    const stoppedRunInPatch = patch.runs.findLast(
      (changedRun) => changedRun.failureKind === 'user_stopped',
    )
    if (stoppedRunInPatch) {
      previous.userStoppedRunId = stoppedRunInPatch.id
    } else if (patch.latestRunId && patch.latestRunId !== previous.userStoppedRunId) {
      previous.userStoppedRunId = undefined
    }
    const awaitingUser =
      sessionNeedsPrompt || nextPending.size > 0 || Boolean(relayId) || collaborationNeeds
    const routedPending = hasRoutedContinuation(patch)
    const userStopped =
      Boolean(stoppedRunInPatch) ||
      (run !== undefined && run.id === previous.userStoppedRunId) ||
      (patch.latestRunId !== undefined && patch.latestRunId === previous.userStoppedRunId)
    const working =
      activity === 'agent_working' ||
      activity === 'recovering' ||
      patch.runs.some(
        (changedRun) =>
          changedRun.status === 'starting' ||
          changedRun.status === 'running' ||
          changedRun.status === 'recovering',
      )

    let emittedFailure = emittedCollaborationFailure
    if (!emittedFailure && !awaitingUser && !userStopped && !working) {
      for (const changedRun of patch.runs) {
        const failureId = `failure:${patch.sessionId}:${changedRun.id}`
        if (
          !isRunAbnormalFailure(changedRun) ||
          isAbnormalRunStatus(previous.runStates.get(changedRun.id)) ||
          previous.collaborationFailureId === failureId
        ) {
          continue
        }
        events.push(raise(patch, failureId, 'failure', changedRun.agentId))
        emittedFailure = true
      }
      if (
        !emittedFailure &&
        patch.runs.length === 0 &&
        isAbnormalActivity(activity) &&
        !isAbnormalActivity(previous.activity)
      ) {
        const fallbackRunId = patch.latestRunId ?? patch.session.updatedAt
        const failureId = `failure:${patch.sessionId}:${fallbackRunId}`
        if (previous.collaborationFailureId !== failureId) {
          events.push(raise(patch, failureId, 'failure', patch.session.activity.agentId))
          emittedFailure = true
        }
      }
    }

    const canEmitCompletion =
      !awaitingUser &&
      !working &&
      !collaborationFailure &&
      !collaborationContinues &&
      !routedPending &&
      !isAbnormalActivity(activity) &&
      status !== 'archived' &&
      !COLLABORATION_WORKING_STATUSES.has(status)

    let emittedCompleted = false
    if (canEmitCompletion) {
      for (const changedRun of patch.runs) {
        if (
          !isRunCompletionSettled(changedRun) ||
          changedRun.id === previous.collaborationCompletedRunId ||
          previous.runStates.get(changedRun.id) === 'completed'
        )
          continue
        events.push(
          raise(
            patch,
            `completed:${patch.sessionId}:${changedRun.id}`,
            'completed',
            changedRun.agentId,
          ),
        )
        emittedCompleted = true
      }
    }
    if (
      !emittedCompleted &&
      !emittedNeeds &&
      !relayRaised &&
      canEmitCompletion &&
      patch.runs.length === 0 &&
      (!collaborationComplete ||
        (patch.latestRunId !== undefined &&
          patch.latestRunId !== previous.collaborationCompletedRunId)) &&
      ((activity === 'completed' && previous.activity !== 'completed') ||
        (status === 'completed' && previous.status !== 'completed'))
    ) {
      events.push(
        raise(
          patch,
          `completed:${patch.sessionId}:${patch.latestRunId ?? patch.session.updatedAt}`,
          'completed',
          patch.session.activity.agentId,
        ),
      )
      emittedCompleted = true
    }

    previous.status = status
    previous.activity = activity
    previous.pendingInteractionIds = nextPending
    previous.lastSeenAt = Date.now()
    for (const changedRun of patch.runs) {
      const nextStatus =
        changedRun.status === 'completed' &&
        (!isRunCompletionSettled(changedRun) ||
          (!canEmitCompletion &&
            !collaborationContinues &&
            !routedPending &&
            changedRun.id !== previous.collaborationCompletedRunId))
          ? 'running'
          : isRunAbnormalFailure(changedRun) && !emittedFailure && (awaitingUser || working)
            ? 'running'
            : changedRun.status
      const existed = previous.runStates.has(changedRun.id)
      previous.runStates.delete(changedRun.id)
      previous.runStates.set(changedRun.id, nextStatus)
      if (!existed) this.trimRunStates(previous)
    }
    this.trimRunStates(previous)
    this.enforceBudget()
    return events
  }

  private trackedBytes(): number {
    let bytes = 0
    for (const state of this.sessions.values()) {
      bytes +=
        512 +
        state.pendingInteractionIds.size * 40 +
        (state.userStoppedRunId ? 40 : 0) +
        (state.collaborationNeedsId ? 80 : 0) +
        (state.collaborationFailureId ? 80 : 0) +
        (state.collaborationCompletedId ? 80 : 0) +
        (state.collaborationCompletedRunId ? 80 : 0) +
        state.runStates.size * 40
    }
    return bytes
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [sessionId, state] of this.sessions) {
      if (now - state.lastSeenAt > TRACKED_SESSION_TTL_MS) this.sessions.delete(sessionId)
    }
  }

  private makeRoom(): void {
    while (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const candidate = [...this.sessions.entries()]
        .filter(([, state]) => (state.status ? TERMINAL_STATUSES.has(state.status) : false))
        .toSorted((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)[0]
      if (!candidate) {
        const oldest = [...this.sessions.entries()].toSorted(
          (left, right) => left[1].lastSeenAt - right[1].lastSeenAt,
        )[0]
        if (!oldest) return
        this.sessions.delete(oldest[0])
        continue
      }
      this.sessions.delete(candidate[0])
    }
  }

  /**
   * Run history, not revocation or first-event state, is the first budget casualty.
   * Trimming the oldest run facts preserves pending interaction and route identities.
   */
  private enforceBudget(): void {
    while (this.sessions.size > 0 && this.trackedBytes() > MAX_TRACKED_BYTES) {
      const largest = [...this.sessions.entries()]
        .filter(([, state]) => state.runStates.size > 0)
        .toSorted((left, right) => right[1].runStates.size - left[1].runStates.size)[0]
      if (largest) {
        const oldest = largest[1].runStates.keys().next().value
        if (oldest !== undefined) {
          largest[1].runStates.delete(oldest)
          continue
        }
      }
      const oldest = [...this.sessions.entries()].toSorted(
        (left, right) => left[1].lastSeenAt - right[1].lastSeenAt,
      )[0]
      if (!oldest) return
      this.sessions.delete(oldest[0])
    }
  }

  private trimRunStates(state: SessionNotificationState): void {
    while (state.runStates.size > MAX_TRACKED_RUNS) {
      const oldest = state.runStates.keys().next().value
      if (oldest === undefined) return
      state.runStates.delete(oldest)
    }
  }

  dispose(): void {
    this.sessions.clear()
  }
}
