import { vi } from 'vitest'

import type {
  AgentRun,
  CollaborationSession,
  CollaborationTask,
  CollaborationTodo,
  CollaborationTodoDelta,
  ConversationPage,
} from '@pact/contracts'

import { collaborationTaskSchema } from '@pact/contracts'

const timestamp = '2026-10-10T01:00:00.000Z'

/** A settled v5 root Turn, with the host's current-plan reference kept separate from its report. */
export function collaborationFixture() {
  const sessionId = crypto.randomUUID()
  const run: AgentRun = {
    id: crypto.randomUUID(),
    sessionId,
    userMessageId: crypto.randomUUID(),
    agentId: 'codex',
    status: 'completed',
    attemptCount: 1,
    settingsRevision: 1,
    model: null,
    effort: null,
    dispatchPhase: 'ended',
    nativeOutcome: 'completed',
    nativeEffectsState: 'settled',
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  const planReference = {
    type: 'unchanged' as const,
    version: 2,
    sourceRunId: run.id,
    sha256: 'a'.repeat(64),
  }
  const task = collaborationTaskSchema.parse({
    id: crypto.randomUUID(),
    sessionId,
    runId: run.id,
    taskMessageId: run.userMessageId,
    kind: 'plan',
    revision: 3,
    primary: 'codex',
    drafter: 'codex',
    implementer: 'claude',
    reviewer: 'claude',
    task: 'Improve cancellation ownership.',
    stage: 'discuss',
    actor: 'codex',
    status: 'waiting',
    plan: 'The unique current plan is maintained in the context pane.',
    planReference,
    planVersion: 2,
    planAuthor: 'codex',
    discussionRounds: 1,
    discussionHalf: false,
    reviewCycles: 0,
    repairAttempts: 0,
    rereview: false,
    nextCycle: false,
    result: {
      submission: 'plan_submission',
      outcome: 'complete',
      summary: 'Cancellation ownership clarified.',
      plan: planReference,
      todoDeltas: [],
      inputResponses: [],
    },
  })
  run.collaboration = { taskId: task.id, kind: 'plan', stage: 'discuss' }
  const session: CollaborationSession = {
    id: sessionId,
    projectId: crypto.randomUUID(),
    title: 'Plan fixture',
    titleSource: 'local',
    status: 'idle',
    hasUnread: false,
    activity: { state: 'idle' },
    settingsRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    settings: {
      primaryAgentId: 'codex' as const,
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 6,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
      runningMessagePolicy: 'next_round' as const,
    },
  }
  const props = {
    session,
    run,
    latestRunId: run.id,
    disabled: false,
    onOpenProjectFile: vi.fn<() => void>(),
  }
  return { props, task, run, planReference }
}

export function reportPage(
  task: CollaborationTask,
  overrides: Partial<Extract<ConversationPage, { scope: 'collaboration' }>['view']> = {},
): Extract<ConversationPage, { scope: 'collaboration' }> {
  return {
    scope: 'collaboration',
    sessionId: task.sessionId,
    view: {
      task,
      actionable: true,
      accepted: true,
      reportAvailable: true,
      feedbackCount: task.result?.todoDeltas.length ?? 0,
      feedbackOffset: 0,
      documents: [],
      ...overrides,
    },
  }
}

export const todoDelta = (id: string): CollaborationTodoDelta => ({
  todoId: id,
  expectedRevision: 0,
  operation: 'create',
  kind: 'opinion',
  title: `Finding ${id}`,
  detail: `Impact for ${id}.`,
  recommendation: `Resolve ${id}.`,
  evidence: `Evidence for ${id}.`,
  question: null,
  resolutionKind: null,
  reason: 'Review found an unresolved issue.',
  mergeTargetId: null,
  userSourceIds: [],
  evidenceRefs: [],
})

export function todoFixture(
  task: CollaborationTask,
  id: string,
  overrides: Partial<CollaborationTodo> = {},
): CollaborationTodo {
  return {
    taskId: task.id,
    id,
    revision: 1,
    kind: 'opinion',
    status: 'open',
    title: `Finding ${id}`,
    author: 'claude',
    answerResolver: null,
    needsUserAnswer: false,
    question: null,
    resolutionKind: null,
    resolutionReasonPreview: '',
    document: { id: crypto.randomUUID(), sha256: 'b'.repeat(64), bytes: 1000, chars: 1000 },
    sourceRunId: task.runId,
    sourceMessageId: task.taskMessageId,
    ...overrides,
  }
}
