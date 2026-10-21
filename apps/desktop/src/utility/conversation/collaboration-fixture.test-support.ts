import { randomUUID } from 'node:crypto'

import type { AgentRunInput } from '@pact/agent-runtime'

import {
  collaborationTaskSchema,
  type CollaborationTurnAuthorization,
  type RuntimeAgentId,
} from '@pact/contracts'

export function planAuthorization(
  runId: string,
  taskId: string,
  actor: RuntimeAgentId,
): CollaborationTurnAuthorization {
  return { runId, taskId, actor, taskRevision: 0, stage: 'plan', inputSequence: 0 }
}

export function planRunInput(actor: RuntimeAgentId): AgentRunInput {
  const sessionId = randomUUID(),
    runId = randomUUID(),
    messageId = randomUUID(),
    taskId = randomUUID()
  const authorization = planAuthorization(runId, taskId, actor)
  return {
    sessionId,
    runId,
    cwd: '/project',
    model: null,
    effort: null,
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId,
      message: { id: messageId, content: '/plan Verify complete plan delivery.' },
      comments: [],
      sourceGrant: { runId, grant: randomUUID() },
      collaborationAuthorization: authorization,
      collaboration: collaborationTaskSchema.parse({
        protocol: 'native-workflow-v1',
        id: taskId,
        sessionId,
        runId,
        taskMessageId: messageId,
        task: 'Verify complete plan delivery.',
        kind: 'plan',
        revision: 0,
        owner: actor,
        reviewer: actor === 'codex' ? 'claude' : 'codex',
        actor,
        authorization,
        stage: 'plan',
        status: 'running',
        automation: 'active',
        inputSequence: 0,
        handledInputSequence: 0,
        planVersion: 0,
        discussionRounds: 0,
        reviewCycles: 0,
        repairAttempts: 0,
      }),
    },
  }
}
