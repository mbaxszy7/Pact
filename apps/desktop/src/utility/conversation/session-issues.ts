import type {
  AgentRun,
  NativeAgentContext,
  NativeRebuildOperation,
  RuntimeAgentId,
  SessionIssues,
} from '@pact/contracts'

import { projectSessionIssues } from '@pact/persistence'

import { isCodexArchivedSessionRejection } from './agent-execution-error'
import { safeNativePermissionText } from './native-permission-wait'

export function presentSessionIssues(
  sessionId: string,
  contexts: NativeAgentContext[],
  runs: Array<AgentRun | undefined>,
  cursors: Array<AgentRun | undefined> = [],
  incompleteResults: string[] = [],
  operations: Array<{ agentId: RuntimeAgentId; operation: NativeRebuildOperation }> = [],
): SessionIssues {
  return projectSessionIssues(sessionId, contexts, runs, cursors, incompleteResults, operations, {
    isArchivedRejection: isCodexArchivedSessionRejection,
    sanitize: safeNativePermissionText,
  })
}
