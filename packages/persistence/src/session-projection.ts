import type {
  RuntimeAgentId,
  SessionActivity,
  SessionStatus,
  SessionTitleSource,
} from '@pact/contracts'

const PACT_PROMPT_ENVELOPE_MARKER = '"version":"pact-agent-prompt-v1"'

export interface LatestRunActivity {
  agentId: RuntimeAgentId
  status: 'starting' | 'running' | 'recovering' | 'completed' | 'failed' | 'interrupted'
  attemptCount: number
}

export function projectSessionTitle(
  title: string,
  source: SessionTitleSource,
): { title: string; titleSource: SessionTitleSource } {
  return source === 'agent' && title.includes(PACT_PROMPT_ENVELOPE_MARKER)
    ? { title: 'New session', titleSource: 'placeholder' }
    : { title, titleSource: source }
}

export function deriveSessionActivity(
  sessionStatus: SessionStatus,
  latestRun?: LatestRunActivity,
): SessionActivity {
  if (sessionStatus === 'draft' || sessionStatus === 'idle' || sessionStatus === 'archived') {
    return { state: 'idle' }
  }

  if (sessionStatus === 'waiting_for_user' || sessionStatus === 'plan_ready') {
    return {
      state: 'waiting_for_user',
      ...(latestRun ? { agentId: latestRun.agentId } : {}),
    }
  }

  if (latestRun?.status === 'recovering') {
    return {
      state: 'recovering',
      agentId: latestRun.agentId,
      attemptCount: latestRun.attemptCount,
    }
  }
  if (latestRun?.status === 'starting' || latestRun?.status === 'running') {
    return { state: 'agent_working', agentId: latestRun.agentId }
  }
  if (latestRun?.status === 'failed') {
    return { state: 'error', agentId: latestRun.agentId }
  }
  if (latestRun?.status === 'interrupted') {
    return { state: 'interrupted', agentId: latestRun.agentId }
  }

  switch (sessionStatus) {
    case 'discussing':
    case 'building':
    case 'reviewing':
      // A workflow can remain in this phase while waiting for the next explicit action.
      // Only an active Run above is evidence that an Agent is executing.
      return { state: 'idle' }
    case 'completed':
      return { state: 'completed' }
    case 'paused':
      return { state: 'paused' }
    default:
      return { state: 'idle' }
  }
}

export function hasUnreadSessionMessage(
  lastSeenMessageSequence: number | null,
  latestCompleteAssistantSequence?: number,
): boolean {
  return (
    lastSeenMessageSequence !== null &&
    latestCompleteAssistantSequence !== undefined &&
    latestCompleteAssistantSequence > lastSeenMessageSequence
  )
}
