import { randomUUID } from 'node:crypto'

import type { AgentRunInput } from '@pact/agent-runtime'

import {
  collaborationEnvelopeSchema,
  collaborationTaskSchema,
  type CollaborationTodoDelta,
  type CollaborationTurnAuthorization,
  type RuntimeAgentId,
} from '@pact/contracts'

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
    answerFormat: 'collaboration_envelope_v5',
    promptEnvelope: {
      version: 'pact-agent-prompt-v1',
      sessionId,
      message: { id: messageId, content: '/plan Verify complete plan delivery.' },
      comments: [],
      sourceGrant: { runId, grant: randomUUID() },
      collaborationAuthorization: authorization,
      collaboration: collaborationTaskSchema.parse({
        id: taskId,
        sessionId,
        runId,
        taskMessageId: messageId,
        task: 'Verify complete plan delivery.',
        kind: 'plan',
        revision: 0,
        primary: actor,
        drafter: actor,
        implementer: actor === 'codex' ? 'claude' : 'codex',
        reviewer: actor,
        actor,
        authorization,
        duty: 'plan_submission',
        stage: 'draft',
        status: 'running',
        planVersion: 0,
        discussionRounds: 0,
        discussionHalf: false,
        reviewCycles: 0,
        repairAttempts: 0,
        rereview: false,
        nextCycle: false,
      }),
    },
  }
}

export function planAuthorization(
  runId: string,
  taskId: string,
  actor: RuntimeAgentId,
): CollaborationTurnAuthorization {
  return {
    runId,
    taskId,
    actor,
    duty: 'plan_submission',
    basePlanRef: null,
    baseTodoRevision: 0,
    inputBatchId: null,
    inputWatermark: 0,
    inputSequence: 0,
    inputBatchRef: null,
    basis: null,
    requiredInputScopeRef: null,
    effectiveDecisionIndexRef: null,
    todoIdentityIndexRef: null,
    reviewScopeRef: null,
  }
}

export function planEnvelope(plan: string) {
  return collaborationEnvelopeSchema.parse({
    version: 'pact-collaboration-envelope-v5',
    answer: 'The complete plan is submitted separately.',
    result: {
      submission: 'plan_submission',
      outcome: 'complete',
      summary: 'Scope and evidence checked.',
      plan,
      reviewedPlan: null,
      verdict: null,
      todoDeltas: [],
      inputResponses: [],
    },
  })
}

export function opinionDelta(
  todoId: string,
  patch: Partial<CollaborationTodoDelta> = {},
): CollaborationTodoDelta {
  return {
    todoId,
    expectedRevision: 0,
    operation: 'create',
    kind: 'opinion',
    title: 'Ownership',
    detail: 'Keep disposal with the owner.',
    recommendation: 'Clarify ownership.',
    evidence: null,
    question: null,
    resolutionKind: null,
    reason: 'The reviewed scope needs explicit ownership.',
    mergeTargetId: null,
    userSourceIds: [],
    evidenceRefs: [],
    ...patch,
  }
}
