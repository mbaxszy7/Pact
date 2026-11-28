import type { AgentRun, ConversationPatch, SessionIssues } from '@pact/contracts'

import { AGENTS, agentDisplayName, resolveActiveAgentPair } from '@pact/contracts'
import { projectSessionIssues } from '@pact/persistence'

import type { ConversationRuntimeCore } from './conversation-runtime-core'
import type { NativeObservation } from './conversation-types'

import { isCodexArchivedSessionRejection } from './agent-execution-error'
import { safeNativePermissionText } from './native-permission-wait'
import { presentSessionIssues } from './session-issues'

/**
 * Single authoritative source of truth for Conversation admission, capacity,
 * background-work blocking, quit-sealing, and `sessionIssues` projection.
 *
 * Shared directly by `send`, `sessionIssues`, `actOnCollaboration`, `syncSideChatToMain`,
 * `forkSession`, `archive`, and `quit` so predicates never drift across callers.
 */
export class ConversationAdmissionGate {
  constructor(private readonly core: ConversationRuntimeCore) {}

  operationCount(): number {
    return (
      this.core.activeExecutions.size +
      this.core.preparingSends.size +
      this.core.preparingContinuations.size +
      this.core.routingOpenInputs.size +
      this.core.nativeRebuilds.size +
      this.core.nativeChecks.size +
      this.core.nativeForks.size +
      [...this.core.skillDiscoveries.values()].filter(
        (owner) => ![...owner.readers].some((reader) => reader.reserved),
      ).length
    )
  }

  hasSessionOperation(
    sessionId: string,
    includeBackground = false,
    ignoreFork?: object,
    allowUnresolvedArchive = false,
  ): boolean {
    return (
      this.core.conversations.archives.blocksSession(sessionId, allowUnresolvedArchive) ||
      [...this.core.nativeForks.values()].some(
        (owner) =>
          owner !== ignoreFork &&
          (owner.sessionId === sessionId || owner.sourceSessionId === sessionId),
      ) ||
      this.core.activeExecutions.has(sessionId) ||
      this.core.preparingContinuations.has(sessionId) ||
      this.core.routingOpenInputs.has(sessionId) ||
      this.core.nativeRebuilds.has(sessionId) ||
      (includeBackground &&
        [...this.core.adapters.entries()].some(
          ([key, entry]) =>
            key.startsWith(`${sessionId}:`) && Boolean(entry.adapter.hasActiveBackgroundWork?.()),
        )) ||
      [...this.core.preparingSends.values()].some((entry) => entry.input.sessionId === sessionId)
    )
  }

  isCurrentBackground(run: AgentRun): boolean {
    return (
      run.dispatchPhase === 'ended' &&
      ['pending', 'unknown'].includes(run.nativeEffectsState ?? '') &&
      this.core.conversations.isCurrentBackgroundCursor(run.id)
    )
  }

  /** All new execution admissions share this gate; confirmed work permits explicit Send. */
  hasBlockingBackgroundWork(sessionId: string): boolean {
    const activeExecution = this.core.activeExecutions.get(sessionId)
    if (activeExecution?.cancelledByUser) return true
    const contexts = this.core.conversations.nativeContexts(sessionId)
    const hasBlockedContext = contexts.some((binding) => {
      const latest = this.core.conversations.latestAgentRun(
        sessionId,
        binding.agentId,
        binding.bindingGeneration,
      )
      if (
        latest &&
        ['not_sent', 'rejected'].includes(latest.dispatchPhase ?? '') &&
        (['pending', 'unknown'].includes(latest.nativeEffectsState ?? '') ||
          Boolean(
            this.core.nativeObservations
              .get(latest.id)
              ?.adapter.hasActiveBackgroundWork?.(latest.id),
          ))
      ) {
        return true
      }
      const run = binding.lastRunId && this.core.conversations.findRun(binding.lastRunId)
      if (!run || !this.isCurrentBackground(run)) return false
      const owner = this.ownedBackground(run)
      return Boolean(
        !owner ||
        owner.backgroundStop ||
        owner.backgroundStopUnconfirmed ||
        run.nativeEffectsState === 'unknown' ||
        !owner.adapter.backgroundWork?.(run.id, run.executorId!),
      )
    })
    if (hasBlockedContext) return true
    return AGENTS.some((agentId) => {
      if (contexts.some((binding) => binding.agentId === agentId)) return false
      const latest =
        this.core.conversations.unacknowledgedNativeRun(sessionId, agentId) ??
        this.core.conversations.latestAgentRun(sessionId, agentId)
      if (!latest || latest.id === activeExecution?.run.id) return false
      return (
        ['pending', 'unknown'].includes(latest.nativeEffectsState ?? '') ||
        (['not_sent', 'rejected'].includes(latest.dispatchPhase ?? '') &&
          Boolean(
            this.core.nativeObservations
              .get(latest.id)
              ?.adapter.hasActiveBackgroundWork?.(latest.id),
          ))
      )
    })
  }

  ownedBackground(run: AgentRun): NativeObservation | undefined {
    const owner = this.core.nativeObservations.get(run.id)
    return owner?.adapter.hasActiveBackgroundWork?.(run.id) &&
      this.isCurrentBackground(run) &&
      this.core.conversations.ownsBackgroundControl(run.id)
      ? owner
      : undefined
  }

  forkBlocked(sessionId: string): boolean {
    return (
      this.hasSessionOperation(sessionId, true) ||
      this.core.conversations.sessionHasNativeWork(sessionId) ||
      this.core.conversations.sourceHasPendingFork(sessionId) ||
      this.core.conversations.forkOperation(sessionId)?.ready === false
    )
  }

  isQuitSealed(): boolean {
    return this.nativeQuitSealed()
  }

  isTerminalQuitSealed(): boolean {
    return (
      this.core.disposed ||
      Boolean(this.core.nativeQuitPreparation && !this.core.nativeQuitPreparation.expired)
    )
  }

  nativeQuitSealed(): boolean {
    return this.core.nativeQuitPreparation?.sealed === true
  }

  projectHasNativeWork(projectId: string): boolean {
    if (this.core.conversations.projectHasNativeWork(projectId)) return true
    const belongs = (sessionId: string): boolean =>
      this.core.sessions.find(sessionId)?.projectId === projectId
    return (
      [...this.core.preparingSends.values()].some((entry) => belongs(entry.input.sessionId)) ||
      [...this.core.preparingContinuations.values()].some((entry) => belongs(entry.sessionId)) ||
      [...this.core.activeExecutions.values()].some((entry) => belongs(entry.run.sessionId)) ||
      [...this.core.nativeRebuilds.keys()].some(belongs) ||
      [...this.core.adapters.values()].some(
        (entry) => belongs(entry.sessionId) && entry.adapter.hasActiveBackgroundWork?.(),
      )
    )
  }

  nativeLogicalPreparation(sessionId: string): boolean {
    return (
      [...this.core.preparingSends.values()].some((owner) => owner.input.sessionId === sessionId) ||
      this.core.preparingContinuations.has(sessionId) ||
      this.core.routingOpenInputs.has(sessionId) ||
      this.core.nativeRebuilds.has(sessionId) ||
      [...this.core.nativeChecks.keys()].some((key) => key.startsWith(`${sessionId}:`)) ||
      this.core.forkPreparations.has(sessionId) ||
      [...this.core.nativeForks.values()].some(
        (owner) => (owner.sessionId ?? owner.sourceSessionId) === sessionId,
      )
    )
  }

  /** Presentation only: use real app-wide owners, never the truncated tray groups. */
  canPresentUpdateNotice(): boolean {
    if (
      this.core.disposed ||
      !this.core.sessions.nativeInitialized() ||
      this.core.nativeQuitPreparation?.sealed ||
      this.core.activeExecutions.size ||
      this.core.preparingSends.size ||
      this.core.preparingContinuations.size ||
      this.core.routingOpenInputs.size ||
      this.core.nativeRebuilds.size ||
      this.core.nativeChecks.size ||
      this.core.forkPreparations.size ||
      this.core.nativeForks.size ||
      this.core.titleEnrichments.size ||
      this.core.nativeTitleSyncs.size ||
      this.core.skillDiscoveries.size ||
      this.core.workspaceChanges?.pendingSessionIds().length
    ) {
      return false
    }
    try {
      const live = this.core.archiveAndQuit.liveNativeRows()
      return (
        live.running.length === 0 &&
        live.attention.length === 0 &&
        this.core.conversations.pendingRoutedContinuations().length === 0 &&
        this.core.conversations.pendingCollaborationInputs().length === 0 &&
        this.core.conversations.nativeQuitUnsettled([]).count === 0
      )
    } catch {
      return false
    }
  }

  sessionIssues(
    sessionId: string,
    contexts: NonNullable<ConversationPatch['nativeContexts']>,
  ): SessionIssues {
    if (this.core.conversations.forkOperation(sessionId)?.ready === false) {
      return { sessionId, inputGate: 'read_only', agents: [] }
    }
    if (
      [...this.core.nativeForks.values()].some(
        (owner) => owner.sourceSessionId === sessionId && owner.sessionId !== sessionId,
      )
    ) {
      return { sessionId, inputGate: 'send_blocked', agents: [] }
    }
    const runs = AGENTS.map((agentId) => {
      const context = contexts.find((item) => item.agentId === agentId)
      return (
        (!context
          ? this.core.conversations.unacknowledgedNativeRun(sessionId, agentId)
          : undefined) ??
        this.core.conversations.latestAgentRun(sessionId, agentId, context?.bindingGeneration)
      )
    })
    const cursors = contexts.map((context) =>
      context.lastRunId ? this.core.conversations.findRun(context.lastRunId) : undefined,
    )
    const incomplete = [...runs, ...cursors].flatMap((run) => {
      if (run?.dispatchPhase !== 'ended') return []
      if (run.status === 'interrupted' && run.failureKind === 'user_stopped') {
        return this.core.conversations.hasOutputUnavailable(run.id) ? [run.id] : []
      }
      return !this.core.conversations.hasCompleteResponse(run.id) ? [run.id] : []
    })
    const session = this.core.sessions.find(sessionId)
    const activeAgents = session ? resolveActiveAgentPair(session.settings) : undefined
    const rebuildOperations = this.core.conversations.rebuildOperations(sessionId)
    const activeExecution = this.core.activeExecutions.get(sessionId)
    const stoppingRunId = activeExecution?.cancelledByUser ? activeExecution.run.id : undefined
    const projection = activeAgents
      ? projectSessionIssues(sessionId, contexts, runs, cursors, incomplete, rebuildOperations, {
          isArchivedRejection: isCodexArchivedSessionRejection,
          sanitize: safeNativePermissionText,
          activeAgents,
          ...(stoppingRunId ? { stoppingRunId } : {}),
        })
      : presentSessionIssues(
          sessionId,
          contexts,
          runs,
          cursors,
          incomplete,
          rebuildOperations,
          stoppingRunId,
        )
    for (const issue of projection.agents) {
      const run = [...runs, ...cursors].find((candidate) => candidate?.id === issue.runId)
      const currentBackground = run && this.isCurrentBackground(run)
      const owner = currentBackground ? this.ownedBackground(run) : undefined
      if (issue.phase === 'background_check' && owner && run?.executorId && run.nativeSessionId) {
        const work = owner.adapter.backgroundWork?.(run.id, run.executorId)
        if (owner.backgroundStop) {
          issue.phase = 'background_stopping'
          issue.title = 'Stopping…'
          issue.reason = ''
          issue.action = 'none'
        } else if (owner.backgroundStopUnconfirmed && issue.action !== 'rebuild') {
          issue.title = 'Stop not confirmed'
          issue.reason = work
            ? 'Stop was not confirmed. The native session still reports background work.'
            : 'Pact could not confirm that Stop ended the background work.'
        } else if (run.nativeEffectsState === 'pending' && work && issue.action !== 'rebuild') {
          issue.phase = 'background_working'
          issue.title =
            issue.resultDisposition === 'incomplete'
              ? 'Response incomplete. Background work continues.'
              : 'Working in background…'
          issue.reason = ''
          issue.action = 'none'
          if (work === 'stoppable' && owner.adapter.stopBackgroundWork) {
            issue.backgroundStop = {
              runId: run.id,
              executorId: run.executorId,
              nativeSessionId: run.nativeSessionId,
              bindingGeneration: run.bindingGeneration ?? 1,
            }
          } else {
            issue.reason = 'The provider has not exposed a Stop target for this work.'
            issue.action = 'retry_check'
          }
        }
      }
      if (this.core.nativeChecks.has(`${sessionId}:${issue.agentId}:rebuild`)) {
        issue.phase = 'checking'
        issue.action = 'none'
        issue.title = `Checking ${agentDisplayName(issue.agentId)} session`
        issue.reason = ''
      }
      issue.abandon ||= this.core.conversations.bindingHasUnsettledWork(
        sessionId,
        issue.agentId,
        issue.generation,
      )
    }
    if (activeExecution?.cancelledByUser) {
      if (projection.inputGate === 'open') projection.inputGate = 'send_blocked'
      projection.stoppingAgentId = activeExecution.run.agentId
    } else if (projection.inputGate === 'open' && this.hasBlockingBackgroundWork(sessionId)) {
      projection.inputGate = 'send_blocked'
    }
    return projection
  }
}
