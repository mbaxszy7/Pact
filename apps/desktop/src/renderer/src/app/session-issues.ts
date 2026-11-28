import type {
  CollaborationSession,
  RuntimeAgentId,
  SessionIssue,
  SessionIssues,
} from '@pact/contracts'

import { resolveActiveAgentPair } from '@pact/contracts'

export function isBlockingSessionIssuePhase(phase: SessionIssue['phase']): boolean {
  return phase !== 'resolved' && phase !== 'warning'
}

export function isRequiredSessionIssue(issue: SessionIssue): boolean {
  return isBlockingSessionIssuePhase(issue.phase) || issue.abandon
}

export function requiredAgentsForSession(
  session: CollaborationSession,
  issues?: SessionIssues,
): RuntimeAgentId[] {
  const required = new Set<RuntimeAgentId>(resolveActiveAgentPair(session.settings))
  for (const agentIssue of issues?.agents ?? []) {
    if (isRequiredSessionIssue(agentIssue)) {
      required.add(agentIssue.agentId)
    }
  }
  return [...required]
}
