import { X } from 'lucide-react'
import { useState } from 'react'

import {
  agentDisplayName,
  resolveActiveAgentPair,
  type ActiveAgentPairInput,
  type CollaborationSession,
  type DefaultSessionSettings,
  type RuntimeAgentId,
  type RuntimePreparation,
  type SessionSettingsEditorState,
} from '@pact/contracts'

import type { ConversationViewProjection } from '../../conversation/conversation-window'

import {
  deriveAgentAvailability,
  resolveMergedSessionModelCatalogs,
  SessionSettingsFields,
  sessionSettingsEqual,
  useActivePairCatalogs,
  type SessionPairNotice,
} from './SessionSettingsFields'

interface SessionSettingsPanelProps {
  editorState?: SessionSettingsEditorState | undefined
  runtimePreparation?: RuntimePreparation | undefined
  conversation?: ConversationViewProjection | undefined
  loading: boolean
  saving: boolean
  error?: string | undefined
  onClose: () => void
  onRetry: () => void
  onSave: (settings: DefaultSessionSettings) => void
}

const UNAMBIGUOUS_COLLABORATION_STATUSES: ReadonlySet<CollaborationSession['status']> = new Set([
  'building',
  'discussing',
  'plan_ready',
  'reviewing',
])

const ACTIVE_REBUILD_STAGES = new Set(['preparing', 'creating', 'seeding', 'unconfirmed'])

function isAgentRetirementBlocked(
  retiredAgent: RuntimeAgentId,
  conversation?: ConversationViewProjection,
): boolean {
  if (!conversation) return false
  const hasUnsettledRun = conversation.runs.some(
    (run) =>
      !run.forkSourceRunId &&
      run.agentId === retiredAgent &&
      ((run.controlDisposition !== 'abandoned' &&
        ['starting', 'running', 'recovering'].includes(run.status)) ||
        run.nativeEffectsState === 'pending' ||
        run.nativeEffectsState === 'unknown' ||
        (run.controlDisposition !== 'abandoned' &&
          (run.dispatchPhase === 'possibly_sent' ||
            (run.dispatchPhase === 'accepted' && !run.nativeOutcome)))),
  )
  if (hasUnsettledRun) return true

  if (
    (conversation.pendingNativeInteractions ?? []).some((entry) => entry.agentId === retiredAgent)
  ) {
    return true
  }

  if (
    (conversation.rebuildOperations ?? []).some(
      (entry) => entry.agentId === retiredAgent && ACTIVE_REBUILD_STAGES.has(entry.operation.stage),
    )
  ) {
    return true
  }

  if (conversation.rebuildInputRecovery?.agentId === retiredAgent) {
    return true
  }

  if (
    (conversation.sessionIssues?.agents ?? []).some(
      (entry) =>
        entry.agentId === retiredAgent && entry.phase !== 'resolved' && entry.phase !== 'warning',
    )
  ) {
    return true
  }

  if (
    conversation.nativeContexts.some(
      (ctx) =>
        ctx.agentId === retiredAgent &&
        ((ctx.permissionRequests?.length ?? 0) > 0 ||
          ['responding', 'waiting_user', 'checking', 'rebuilding'].includes(
            ctx.continuationState ?? '',
          ) ||
          (ctx.continuationState === 'recovery_required' && ctx.recoveryAction === 'rebuild')),
    )
  ) {
    return true
  }

  return false
}

interface ThirdAgentReplacementRestriction {
  nonRetirableAgents: readonly RuntimeAgentId[]
  reason?: string | undefined
}

function resolveThirdAgentReplacementRestriction(
  session: CollaborationSession,
  currentPair: readonly [RuntimeAgentId, RuntimeAgentId],
  conversation?: ConversationViewProjection,
): ThirdAgentReplacementRestriction {
  const liveSession = conversation?.session ?? session
  const hasActiveRun =
    liveSession.activity.state === 'agent_working' ||
    liveSession.activity.state === 'recovering' ||
    Boolean(
      conversation?.runs.some(
        (run) =>
          !run.forkSourceRunId &&
          run.controlDisposition !== 'abandoned' &&
          ['starting', 'running', 'recovering'].includes(run.status),
      ),
    ) ||
    conversation?.forkOperation?.ready === false ||
    Boolean(
      conversation?.messages.some((msg) => msg.role === 'user' && Boolean(msg.pendingAgentId)),
    )
  if (hasActiveRun) {
    return {
      nonRetirableAgents: currentPair,
      reason:
        'Primary and Secondary can swap anytime. Wait for active or recovering agent work to finish before bringing in the third agent.',
    }
  }

  const hasQueuedWork =
    Boolean(conversation?.queue?.input) ||
    conversation?.queue?.returnedInput?.state === 'pending' ||
    Boolean(conversation?.preparedInputContinuation) ||
    Boolean(conversation?.relaySchedulingDecision)
  if (hasQueuedWork) {
    return {
      nonRetirableAgents: currentPair,
      reason:
        'Primary and Secondary can swap anytime. Clear or finish queued messages before bringing in the third agent.',
    }
  }

  const hasUnfinishedCollaboration =
    conversation?.collaborationTask !== undefined
      ? conversation.collaborationTask !== null &&
        conversation.collaborationTask.status !== 'complete' &&
        !conversation.collaborationTask.ending
      : UNAMBIGUOUS_COLLABORATION_STATUSES.has(liveSession.status)
  if (hasUnfinishedCollaboration) {
    return {
      nonRetirableAgents: currentPair,
      reason:
        'Primary and Secondary can swap anytime. Finish or stop the current /plan task before bringing in the third agent.',
    }
  }

  const unsettledMembers = currentPair.filter((agentId) =>
    isAgentRetirementBlocked(agentId, conversation),
  )
  if (unsettledMembers.length === currentPair.length) {
    return {
      nonRetirableAgents: currentPair,
      reason:
        'Primary and Secondary can swap anytime. Resolve pending agent approvals or recovery before bringing in the third agent.',
    }
  }
  if (unsettledMembers.length === 1) {
    const blockedName = agentDisplayName(unsettledMembers[0]!)
    return {
      nonRetirableAgents: unsettledMembers,
      reason: `Primary and Secondary can swap anytime. Resolve ${blockedName}’s pending approvals or recovery before replacing ${blockedName}.`,
    }
  }

  return { nonRetirableAgents: [] }
}

export function SessionSettingsPanel({
  editorState,
  runtimePreparation,
  conversation,
  loading,
  saving,
  error,
  onClose,
  onRetry,
  onSave,
}: SessionSettingsPanelProps): React.JSX.Element {
  const [settings, setSettings] = useState<DefaultSessionSettings | undefined>(
    editorState?.session.settings,
  )
  const hasChanges = Boolean(
    editorState && settings && !sessionSettingsEqual(settings, editorState.session.settings),
  )
  const agentAvailability = deriveAgentAvailability(runtimePreparation)
  const currentPair = editorState ? resolveActiveAgentPair(editorState.session.settings) : undefined
  const replacementRestriction =
    editorState && currentPair
      ? resolveThirdAgentReplacementRestriction(editorState.session, currentPair, conversation)
      : undefined
  const nonRetirableAgents = replacementRestriction?.nonRetirableAgents ?? []
  const nextPair = settings ? resolveActiveAgentPair(settings) : undefined
  const retiredDisallowed = Boolean(
    nextPair && nonRetirableAgents.some((agentId) => !nextPair.includes(agentId)),
  )
  const bridgeLoader =
    typeof window !== 'undefined' &&
    editorState &&
    typeof window.pact?.getSessionSettings === 'function'
      ? (pair: ActiveAgentPairInput) => window.pact.getSessionSettings(editorState.session.id, pair)
      : undefined
  const { fetchedCatalogs, sameSource, pairCatalogLoading, refreshCatalogs } =
    useActivePairCatalogs({
      editorState,
      baseCatalogs: editorState?.modelCatalogs,
      activePair: nextPair,
      agentAvailability,
      enabled: Boolean(editorState && settings),
      loadForPair: bridgeLoader,
      onFallbackRefresh: onRetry,
    })
  const mergedCatalogs = editorState
    ? resolveMergedSessionModelCatalogs(editorState.modelCatalogs, fetchedCatalogs, sameSource)
    : undefined
  const retiredFullAccessAgent =
    editorState && currentPair && nextPair && !retiredDisallowed
      ? currentPair.find(
          (agentId) =>
            !nextPair.includes(agentId) &&
            editorState.session.settings.permissionModes?.[agentId] === 'full',
        )
      : undefined
  const pairNotice: SessionPairNotice | undefined =
    nonRetirableAgents.length === 2 && replacementRestriction?.reason
      ? { tone: 'info', text: replacementRestriction.reason }
      : retiredFullAccessAgent
        ? {
            tone: 'warning',
            text: `${agentDisplayName(retiredFullAccessAgent)} Full access resets to Ask when removed from this session’s active pair.`,
          }
        : replacementRestriction?.reason
          ? { tone: 'info', text: replacementRestriction.reason }
          : undefined

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-surface-raised"
      aria-labelledby="session-settings-title"
    >
      <header className="flex shrink-0 items-start justify-between gap-group border-b border-border p-section">
        <div>
          <h2 id="session-settings-title" className="text-subtitle font-medium tracking-[-0.015em]">
            Session settings
          </h2>
          <p className="mt-1 text-caption text-secondary">
            Applies to new turns in this session; active responses keep their current settings.
          </p>
        </div>
        <button
          className="grid size-8 place-items-center rounded-control border border-border bg-surface-raised text-primary hover:bg-surface-muted"
          type="button"
          aria-label="Close Session settings"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto px-section">
        {loading && !editorState ? (
          <div className="space-y-group py-section" aria-busy="true">
            <div className="h-28 animate-pulse rounded-card bg-surface-muted" />
            <div className="h-40 animate-pulse rounded-card bg-surface-muted" />
          </div>
        ) : null}

        {error ? (
          <div
            className="my-section rounded-card bg-danger-muted p-group text-caption text-danger"
            role="alert"
          >
            <p>{error}</p>
            <button
              className="mt-2 font-medium underline underline-offset-4"
              type="button"
              onClick={onRetry}
            >
              Try again
            </button>
          </div>
        ) : null}

        {editorState && settings && mergedCatalogs ? (
          <SessionSettingsFields
            idPrefix={`session-${editorState.session.id}`}
            settings={settings}
            modelCatalogs={mergedCatalogs}
            agentAvailability={agentAvailability}
            existingPair={currentPair}
            lockedPair={nonRetirableAgents.length === 2 ? currentPair : undefined}
            nonRetirableAgents={nonRetirableAgents.length > 0 ? nonRetirableAgents : undefined}
            pairNotice={pairNotice}
            disabled={saving}
            refreshing={loading || pairCatalogLoading}
            showRefresh
            compact
            onChange={setSettings}
            onRefresh={refreshCatalogs}
          />
        ) : null}
      </div>

      {editorState && settings ? (
        <footer className="flex shrink-0 items-center justify-end gap-group border-t border-border bg-surface-raised p-group">
          <button
            className="primary-action-button"
            type="button"
            disabled={saving || loading || pairCatalogLoading || !hasChanges || retiredDisallowed}
            data-busy={saving}
            aria-busy={saving}
            onClick={() => onSave(settings)}
          >
            {saving ? <span className="primary-action-spinner" aria-hidden="true" /> : null}
            {saving ? 'Saving' : 'Save changes'}
          </button>
        </footer>
      ) : null}
    </section>
  )
}
