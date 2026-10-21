import { vi } from 'vitest'

import type {
  AgentRun,
  CollaborationSession,
  CollaborationTask,
  ConversationPage,
} from '@pact/contracts'

import { collaborationTaskSchema } from '@pact/contracts'

const timestamp = '2026-10-10T01:00:00.000Z'

/** A settled native workflow Turn with an immutable current-plan reference. */
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
    version: 2,
    sourceRunId: run.id,
    sourceMessageId: run.userMessageId,
    document: { id: crypto.randomUUID(), sha256: 'a'.repeat(64), bytes: 100, chars: 100 },
  }
  const task = collaborationTaskSchema.parse({
    protocol: 'native-workflow-v1',
    id: crypto.randomUUID(),
    sessionId,
    runId: run.id,
    taskMessageId: run.userMessageId,
    kind: 'plan',
    revision: 3,
    owner: 'codex',
    reviewer: 'claude',
    task: 'Improve cancellation ownership.',
    stage: 'plan',
    actor: 'codex',
    status: 'waiting',
    automation: 'paused',
    inputSequence: 0,
    handledInputSequence: 0,
    planReference,
    planVersion: 2,
    discussionRounds: 1,
    reviewCycles: 0,
    repairAttempts: 0,
  })
  run.collaboration = { taskId: task.id, kind: 'plan', stage: 'plan', planVersion: 2 }
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
      availableActions: ['resume'],
      documents: [],
      ...overrides,
    },
  }
}

export function markdownPage(
  task: CollaborationTask,
  text: string,
  source = task.review?.document ?? task.planReference!.document,
): Extract<ConversationPage, { scope: 'collaboration-markdown' }> {
  return {
    scope: 'collaboration-markdown',
    sessionId: task.sessionId,
    document: source,
    basis: 'markdown-visible-v2',
    visibleStart: 0,
    visibleEnd: text.length,
    offset: 0,
    previousOffset: null,
    nextOffset: null,
    tree: {
      type: 'root',
      children: [
        {
          type: 'element',
          tagName: 'p',
          children: [
            {
              type: 'element',
              tagName: 'span',
              properties: {
                'data-pact-projection-start': 0,
                'data-pact-projection-end': text.length,
              },
              children: [{ type: 'text', value: text }],
            },
          ],
        },
      ],
    },
  }
}
