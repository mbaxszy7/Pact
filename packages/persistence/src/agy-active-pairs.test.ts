import { and, eq, sql } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AGENTS,
  collaborationTaskSchema,
  defaultTaskStageRoles,
  type AgentNativeForkBoundary,
  type AgentNativeForkWitness,
  type ConversationSendInput,
  type DefaultSessionSettings,
  type FrozenExecutionEnvelope,
  type RuntimeAgentId,
} from '@pact/contracts'

import { RunOperationConflictError } from './conversation-repository.js'
import { nativeSessionIssueMetadata } from './native-presence-metadata.js'
import { PactDatabase } from './pact-database.js'
import {
  agentRuns,
  collaborationInputs,
  collaborationTasks,
  conversationBodyInputs,
  conversationInputBatches,
  conversationMessages,
  conversationRunSourceRefs,
  nativeAgentContexts,
  nativeRebuildOperations,
  sessions as sessionsTable,
} from './schema/index.js'
import { projectSessionIssues } from './session-issues.js'
import { SessionRepository, SessionSettingsConflictError } from './session-repository.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const databases: PactDatabase[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

async function* byteStream(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text)
}

function makeSettings(
  primaryAgentId: RuntimeAgentId,
  secondaryAgentId: RuntimeAgentId,
): DefaultSessionSettings {
  return {
    primaryAgentId,
    secondaryAgentId,
    agents: {
      claude: { model: 'claude-sonnet-4-5', effort: 'high' },
      codex: { model: 'gpt-5.4', effort: 'medium' },
      agy: { model: 'gemini-3.1-pro', effort: 'high' },
    },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
}

async function createFixture(
  primaryAgentId: RuntimeAgentId = 'claude',
  secondaryAgentId: RuntimeAgentId = 'codex',
) {
  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  databases.push(db)
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const createdAt = '2026-11-19T00:00:00.000Z'
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Active Pairs Fixture',
    directoryPath: '/fixture/active-pairs',
    kind: 'git',
    createdAt,
  })
  const initialSettings = makeSettings(primaryAgentId, secondaryAgentId)
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Main Session', createdAt },
    initialSettings,
  )
  return {
    db,
    repo: db.conversationRepository,
    sessions: db.sessionRepository,
    projectId,
    sessionId,
  }
}

function draftRevision(db: PactDatabase, sessionId: string): number {
  const page = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
  if (page.scope !== 'drafts') throw new Error('Expected drafts page')
  return page.commentsRevision
}

function enqueueInput(
  db: PactDatabase,
  sessionId: string,
  anchorRunId: string,
  actor: RuntimeAgentId,
  content: string,
  options: Pick<ConversationSendInput, 'route' | 'skills'> = {},
): string {
  const ownerKey = randomUUID()
  const clientMessageId = randomUUID()
  const body = db.conversationRepository.writeConversationInput(
    { type: 'begin', sessionId, clientMessageId },
    ownerKey,
  )
  if (content.length > 0) {
    db.conversationRepository.writeConversationInput(
      { type: 'append', sessionId, inputId: body.inputId, offset: 0, text: content },
      ownerKey,
    )
  }
  db.conversationRepository.writeConversationInput(
    { type: 'seal', sessionId, inputId: body.inputId },
    ownerKey,
  )
  db.conversationRepository.receiveQueuedInput(
    {
      sessionId,
      clientMessageId,
      content: '',
      inputId: body.inputId,
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      ...options,
    },
    body.inputId,
    actor,
    ownerKey,
    anchorRunId,
    true,
  )
  return clientMessageId
}

function runAndComplete(
  db: PactDatabase,
  sessionId: string,
  agentId: RuntimeAgentId,
  content: string,
  answer: string,
  options: { all?: boolean; nativeSessionId?: string } = {},
) {
  const session = db.sessionRepository.find(sessionId)!
  const started = db.conversationRepository.beginRun({
    sessionId,
    clientMessageId: randomUUID(),
    content,
    expectedCommentsRevision: draftRevision(db, sessionId),
    commentIds: [],
    agentId,
    settingsRevision: session.settingsRevision,
    model: null,
    effort: null,
    ...(options.all ? { route: { type: 'all' as const } } : {}),
  })
  const nativeSessionId = options.nativeSessionId ?? `${agentId}-native-${sessionId.slice(0, 8)}`
  const turnId = `${started.run.id}:turn`
  db.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId,
    type: 'session.started',
    nativeSessionId,
  })
  db.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId,
    type: 'turn.started',
    turnId,
  })
  db.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId,
    type: 'text.completed',
    turnId,
    outputId: `${started.run.id}:out`,
    text: answer,
  })
  db.conversationRepository.applyEvent(sessionId, started.run.id, {
    agentId,
    type: 'turn.completed',
    turnId,
    outcome: 'completed',
  })
  db.conversationRepository.recordNativeEffects(started.run.id, 'settled')
  return db.conversationRepository.findRun(started.run.id)!
}

describe('Module 1 persistence: Antigravity (agy) and 2-of-3 active Agent pairs', () => {
  it('persists all 6 (primaryAgentId, secondaryAgentId) permutations and rejects identical pairs', async () => {
    const { db, projectId } = await createFixture()
    const createdAt = '2026-11-19T01:00:00.000Z'

    for (const primary of AGENTS) {
      expect(() =>
        db.defaultSessionSettingsRepository.save({
          ...makeSettings(primary, primary),
        }),
      ).toThrow(/distinct/i)
      for (const secondary of AGENTS) {
        if (primary === secondary) continue
        const savedDefaults = db.defaultSessionSettingsRepository.save(
          makeSettings(primary, secondary),
        )
        expect(savedDefaults.settings.primaryAgentId).toBe(primary)
        expect(savedDefaults.settings.secondaryAgentId).toBe(secondary)
        expect(savedDefaults.settings.agents.agy.speed).toBe('native')

        const id = randomUUID()
        const created = db.sessionRepository.create(
          { id, projectId, title: `${primary}-${secondary}`, createdAt },
          makeSettings(primary, secondary),
        )
        expect(created.session.settings.primaryAgentId).toBe(primary)
        expect(created.session.settings.secondaryAgentId).toBe(secondary)
        expect(created.session.settings.permissionModes).toEqual({
          claude: 'ask',
          codex: 'native',
          agy: 'ask',
        })
      }
    }
  })

  it('rejects settings/permission/speed mutations on Side Chats and inactive 3rd-agent permission/speed mutations', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'agy')
    const completed = runAndComplete(
      db,
      sessionId,
      'claude',
      'Parent prompt',
      'Parent answer with anchor text.',
    )
    const sideReceipt = repo.createSideChat({
      origin: 'selection',
      operationId: randomUUID(),
      parentSessionId: sessionId,
      messageId: completed.responseMessageId!,
      quote: 'Parent answer',
      startOffset: 0,
      endOffset: 'Parent answer'.length,
    })
    const sideChatId = sideReceipt.sideChat.id

    // Side Chat settings are immutable
    expect(() => sessions.saveSettings(sideChatId, makeSettings('agy', 'claude'))).toThrow(
      SessionSettingsConflictError,
    )
    expect(() =>
      sessions.savePermission({
        sessionId: sideChatId,
        agentId: 'claude',
        mode: 'auto',
        expectedRevision: 1,
        confirmedFullAccess: false,
      }),
    ).toThrow(SessionSettingsConflictError)
    expect(() =>
      sessions.saveSpeed({
        sessionId: sideChatId,
        agentId: 'claude',
        speed: 'fast',
        expectedRevision: 1,
      }),
    ).toThrow(SessionSettingsConflictError)

    // Inactive 3rd Agent ('codex' in a (claude, agy) session) cannot mutate permission or speed
    const current = sessions.find(sessionId)!
    expect(() =>
      sessions.savePermission({
        sessionId,
        agentId: 'codex',
        mode: 'auto',
        expectedRevision: current.settingsRevision,
        confirmedFullAccess: false,
      }),
    ).toThrow(SessionSettingsConflictError)
    expect(() =>
      sessions.saveSpeed({
        sessionId,
        agentId: 'codex',
        speed: 'fast',
        expectedRevision: current.settingsRevision,
      }),
    ).toThrow(SessionSettingsConflictError)

    // Active member 'agy' can update permission mode cleanly
    const updated = sessions.savePermission({
      sessionId,
      agentId: 'agy',
      mode: 'full',
      expectedRevision: current.settingsRevision,
      confirmedFullAccess: true,
    })
    expect(updated.session.settings.permissionModes?.agy).toBe('full')
  })

  it('enforces all atomic transaction gates when swapping in the 3rd Agent and resets retiring full access without mutating child Side Chats', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')

    // Grant 'full' permission to codex and create a child Side Chat before swapping
    let main = sessions.find(sessionId)!
    sessions.savePermission({
      sessionId,
      agentId: 'codex',
      mode: 'full',
      expectedRevision: main.settingsRevision,
      confirmedFullAccess: true,
    })
    const firstTurn = runAndComplete(
      db,
      sessionId,
      'codex',
      'Initial codex work',
      'Codex completed initial answer.',
    )
    const sideReceipt = repo.createSideChat({
      origin: 'selection',
      operationId: randomUUID(),
      parentSessionId: sessionId,
      messageId: firstTurn.responseMessageId!,
      quote: 'Codex completed',
      startOffset: 0,
      endOffset: 'Codex completed'.length,
    })

    // Same-pair primary/secondary flip (claude, codex) -> (codex, claude) is always allowed when idle
    main = sessions.find(sessionId)!
    sessions.saveSettings(sessionId, {
      ...main.settings,
      primaryAgentId: 'codex',
      secondaryAgentId: 'claude',
    })
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    })

    // Gate 1: Active running Run blocks 3rd-agent replacement
    main = sessions.find(sessionId)!
    const activeRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'In-flight codex turn',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: main.settingsRevision,
      model: null,
      effort: null,
    }).run
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/Wait until the current Agent turn finishes/)

    // Gate 4 (while activeRun is running): Queued collaboration_inputs blocks 3rd-agent replacement even after activeRun settles!
    const codexNativeId = firstTurn.nativeSessionId!
    repo.applyEvent(sessionId, activeRun.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: codexNativeId,
    })
    const queuedId = enqueueInput(db, sessionId, activeRun.id, 'claude', 'Queued follow-up')

    // Settle activeRun with quota_or_rate_limit failure, then test Gate 2: unsettled nativeEffectsState
    db.drizzle.delete(collaborationInputs).where(eq(collaborationInputs.id, queuedId)).run()
    repo.recordNativeEffects(activeRun.id, 'unknown')
    repo.failRun(activeRun.id, 'quota_or_rate_limit', 'Codex rate limit reached.', false)
    repo.setContinuation(sessionId, 'codex', 'ready')
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/background effects and turn status to settle/)

    // Settle nativeEffectsState, then test Gate 3: checking / pending approval blocks, while settled quota recovery_required allows replacement
    repo.recordNativeEffects(activeRun.id, 'settled')
    repo.setContinuation(sessionId, 'codex', 'checking')
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/pending approval, question, or recovery check/)
    repo.setContinuation(sessionId, 'codex', 'ready')

    // Re-verify Gate 4: Queued collaboration_inputs row alone blocks 3rd-agent replacement
    const inFlightClaude = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Claude turn for queue anchor',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: main.settingsRevision,
      model: null,
      effort: null,
    }).run
    repo.applyEvent(sessionId, inFlightClaude.id, {
      agentId: 'claude',
      type: 'session.started',
      nativeSessionId: 'claude-native',
    })
    const queuedId2 = enqueueInput(db, sessionId, inFlightClaude.id, 'claude', 'Queued message 2')
    const tClaude = `${inFlightClaude.id}:turn`
    repo.applyEvent(sessionId, inFlightClaude.id, {
      agentId: 'claude',
      type: 'turn.started',
      turnId: tClaude,
    })
    repo.applyEvent(sessionId, inFlightClaude.id, {
      agentId: 'claude',
      type: 'text.completed',
      turnId: tClaude,
      outputId: 'out-claude',
      text: 'Claude finished.',
    })
    repo.applyEvent(sessionId, inFlightClaude.id, {
      agentId: 'claude',
      type: 'turn.completed',
      turnId: tClaude,
      outcome: 'completed',
    })
    repo.recordNativeEffects(inFlightClaude.id, 'settled')
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/queued message/)
    db.drizzle.delete(collaborationInputs).where(eq(collaborationInputs.id, queuedId2)).run()

    // Gate 5: Pending @all second-leg routePendingAgentId blocks 3rd-agent replacement
    const allFirst = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: '@all check status',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: main.settingsRevision,
      model: null,
      effort: null,
      route: { type: 'all' },
    }).run
    const allTurn = `${allFirst.id}:turn`
    repo.applyEvent(sessionId, allFirst.id, {
      agentId: 'claude',
      type: 'session.started',
      nativeSessionId: 'claude-native',
    })
    repo.applyEvent(sessionId, allFirst.id, {
      agentId: 'claude',
      type: 'turn.started',
      turnId: allTurn,
    })
    repo.applyEvent(sessionId, allFirst.id, {
      agentId: 'claude',
      type: 'text.completed',
      turnId: allTurn,
      outputId: 'out-all',
      text: 'Claude leg done.',
    })
    repo.applyEvent(sessionId, allFirst.id, {
      agentId: 'claude',
      type: 'turn.completed',
      turnId: allTurn,
      outcome: 'completed',
    })
    repo.recordNativeEffects(allFirst.id, 'settled')
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/@all message sequence/)
    db.drizzle
      .update(conversationMessages)
      .set({ routePendingAgentId: null })
      .where(eq(conversationMessages.id, allFirst.userMessageId))
      .run()

    // Gate 6: Active unfinished collaboration task blocks 3rd-agent replacement
    const taskId = randomUUID()
    const activeTask = collaborationTaskSchema.parse({
      protocol: 'native-workflow-v1',
      id: taskId,
      sessionId,
      kind: 'plan',
      revision: 0,
      owner: 'claude',
      reviewer: 'codex',
      rolePolicy: 'split-stages-v1',
      stageRoles: defaultTaskStageRoles('claude', 'codex'),
      task: 'Unfinished plan task',
      taskMessageId: allFirst.userMessageId,
      stage: 'plan',
      actor: 'claude',
      status: 'waiting',
      automation: 'paused',
      pauseReason: 'user',
      runId: allFirst.id,
      inputSequence: 0,
      handledInputSequence: 0,
      planVersion: 0,
      discussionRounds: 0,
      reviewCycles: 0,
      repairAttempts: 0,
    })
    db.drizzle
      .insert(collaborationTasks)
      .values({
        id: taskId,
        sessionId,
        stateJson: JSON.stringify(activeTask),
        updatedAt: '2026-11-19T02:00:00.000Z',
      })
      .run()
    expect(() =>
      sessions.saveSettings(sessionId, {
        ...main.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      }),
    ).toThrow(/current collaboration task/)
    db.drizzle.delete(collaborationTasks).where(eq(collaborationTasks.id, taskId)).run()

    // Re-trigger a settled quota_or_rate_limit failure on codex as its latest run, then swap cleanly to (claude, agy)
    const quotaRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'One more codex prompt',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
    }).run
    repo.applyEvent(sessionId, quotaRun.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: codexNativeId,
    })
    repo.recordNativeEffects(quotaRun.id, 'settled')
    repo.failRun(quotaRun.id, 'quota_or_rate_limit', 'Codex quota exhausted.', false)
    repo.setContinuation(sessionId, 'codex', 'ready')

    // Before swap, codex's quota issue is visible on the (claude, codex) session
    expect(repo.nativeIssueMetadata(sessionId).agents.map((a) => a.agentId)).toContain('codex')

    const swapped = sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    expect(swapped.session.settings.primaryAgentId).toBe('claude')
    expect(swapped.session.settings.secondaryAgentId).toBe('agy')
    // Retiring codex's 'full' permission was reset to 'ask'
    expect(swapped.session.settings.permissionModes?.codex).toBe('ask')

    // Child Side Chat's locked settings revision was NOT mutated
    const childSideChat = sessions.find(sideReceipt.sideChat.id)!
    expect(childSideChat.settings.primaryAgentId).toBe('claude')
    expect(childSideChat.settings.secondaryAgentId).toBe('codex')
    expect(childSideChat.settings.permissionModes?.codex).toBe('full')

    // Retired codex's settled quota warning is suppressed on the (claude, agy) session
    expect(repo.nativeIssueMetadata(sessionId).agents.map((a) => a.agentId)).not.toContain('codex')

    // Yet if a historical 3rd member ever has unsettled 'unknown' native effects, projectSessionIssues still surfaces it!
    repo.recordNativeEffects(quotaRun.id, 'unknown')
    expect(repo.nativeIssueMetadata(sessionId).agents.map((a) => a.agentId)).toContain('codex')
  })

  it('rejects @mention, @gemini, or skills targeting the inactive 3rd Agent and freezes ordered @all routes', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'agy')
    const settingsRevision = sessions.find(sessionId)!.settingsRevision

    // Reject inactive @codex, @gemini, and codex-bound skill in beginRun without creating Message or Run
    for (const invalid of [
      { content: '@codex inspect file', agentId: 'codex' as const },
      { content: '@gemini inspect file', agentId: 'agy' as const },
    ]) {
      expect(() =>
        repo.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: invalid.content,
          expectedCommentsRevision: draftRevision(db, sessionId),
          commentIds: [],
          agentId: invalid.agentId,
          settingsRevision,
          model: null,
          effort: null,
        }),
      ).toThrow(RunOperationConflictError)
    }
    expect(() =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: '/codex-skill inspect file',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'claude',
        settingsRevision,
        model: null,
        effort: null,
        skillInvocation: {
          version: 'pact-skills-v1',
          arguments: 'inspect file',
          selections: [
            { id: 'a'.repeat(64), agentId: 'codex', name: 'codex-skill', start: 0, end: 12 },
          ],
          bindings: [
            {
              id: 'a'.repeat(64),
              agentId: 'codex',
              name: 'codex-skill',
              description: '',
              argumentHint: '',
              source: 'user',
            },
          ],
        },
      }),
    ).toThrow(RunOperationConflictError)

    expect(
      db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.sessionId, sessionId))
        .all(),
    ).toHaveLength(0)
    expect(
      db.drizzle.select().from(agentRuns).where(eq(agentRuns.sessionId, sessionId)).all(),
    ).toHaveLength(0)

    // @all in beginRun freezes ordered (claude -> agy) routePendingAgentId = 'agy' and routeAgentsJson = ['claude', 'agy']
    const allStarted = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: '@all review architecture',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision,
      model: null,
      effort: null,
      route: { type: 'all' },
    })
    repo.applyEvent(sessionId, allStarted.run.id, {
      agentId: 'claude',
      type: 'session.started',
      nativeSessionId: 'claude-native-all',
    })
    const userRow = db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.id, allStarted.run.userMessageId))
      .get()!
    expect(userRow.routeKind).toBe('all')
    expect(userRow.routePendingAgentId).toBe('agy')
    expect(JSON.parse(userRow.routeAgentsJson!)).toEqual(['claude', 'agy'])

    // Reject inactive @codex and @gemini in receiveQueuedInput without creating queued input
    expect(() =>
      enqueueInput(db, sessionId, allStarted.run.id, 'codex', '@codex queued message', {
        route: { type: 'agent', agentId: 'codex' },
      }),
    ).toThrow(RunOperationConflictError)
    expect(() =>
      enqueueInput(db, sessionId, allStarted.run.id, 'claude', '@gemini queued message'),
    ).toThrow(RunOperationConflictError)
    expect(
      db.drizzle
        .select()
        .from(collaborationInputs)
        .where(eq(collaborationInputs.sessionId, sessionId))
        .all(),
    ).toHaveLength(0)

    // @all in receiveQueuedInput freezes ordered { type: 'all', firstAgentId: 'claude', secondAgentId: 'agy' }
    const queuedAllId = enqueueInput(
      db,
      sessionId,
      allStarted.run.id,
      'claude',
      '@all follow-up check',
      { route: { type: 'all' } },
    )
    const savedQueueRow = db.drizzle
      .select()
      .from(collaborationInputs)
      .where(eq(collaborationInputs.id, queuedAllId))
      .get()!
    const parsedQueueMetadata: unknown = JSON.parse(savedQueueRow.metadataJson)
    expect(parsedQueueMetadata).toMatchObject({
      route: {
        type: 'all',
        firstAgentId: 'claude',
        secondAgentId: 'agy',
      },
    })
  })

  it('tracks incremental Handoff across A -> B -> C -> B swaps and resets non-forked 3rd-agent cursor on child Forks', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')

    // Turn 1: A (claude), Turn 2: B (codex)
    runAndComplete(db, sessionId, 'claude', 'Turn 1 prompt to Claude', 'Turn 1 answer from Claude')
    const bFirst = runAndComplete(
      db,
      sessionId,
      'codex',
      'Turn 2 prompt to Codex',
      'Turn 2 answer from Codex',
    )
    const bFirstUserMsg = repo.internalMessage(bFirst.userMessageId, sessionId)!

    // Swap to (claude, agy) and run C (agy): C has never run, so afterSequence === -1
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    const cRange = repo.handoffRange(sessionId, 'agy')
    expect(cRange.afterSequence).toBe(-1)
    expect(
      repo
        .readHandoffPage(sessionId, 'agy', cRange.afterSequence, cRange.throughSequence)
        .messages.map((m) => m.content),
    ).toEqual([
      'Turn 1 prompt to Claude',
      'Turn 1 answer from Claude',
      'Turn 2 prompt to Codex',
      'Turn 2 answer from Codex',
    ])

    const cRun = runAndComplete(
      db,
      sessionId,
      'agy',
      'Turn 3 prompt to Antigravity',
      'Turn 3 answer from Antigravity',
    )

    // Swap to (codex, agy) and check B (codex) handoffRange: ONLY Turn 3 (after B's lastAccepted) is handed off!
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
    })
    const bIncremental = repo.handoffRange(sessionId, 'codex')
    expect(bIncremental.afterSequence).toBe(bFirstUserMsg.sequence)
    expect(
      repo
        .readHandoffPage(
          sessionId,
          'codex',
          bIncremental.afterSequence,
          bIncremental.throughSequence,
        )
        .messages.map((m) => m.content),
    ).toEqual(['Turn 3 prompt to Antigravity', 'Turn 3 answer from Antigravity'])

    // Swap parent to (claude, codex), run both claude & codex so both active members have ready native bindings,
    // and fork a child session at (claude, codex) — copying cRun ('agy') with forkSourceRunId IS NOT NULL and NO child agy context!
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    })
    runAndComplete(db, sessionId, 'claude', 'Turn 4 prompt to Claude', 'Turn 4 answer from Claude')
    const bLatest = runAndComplete(
      db,
      sessionId,
      'codex',
      'Turn 5 prompt to Codex',
      'Turn 5 answer from Codex',
    )

    const parentSession = sessions.find(sessionId)!
    const selection = repo.selectForkSource(
      sessionId,
      bLatest.responseMessageId!,
      parentSession.settings,
      parentSession.settingsRevision,
    )
    const makeBoundary = (agentId: 'claude' | 'codex'): AgentNativeForkBoundary => {
      const sourceRun = selection.runs[agentId]!
      const prefix = repo.forkResponse(sourceRun.id, selection.prepared.sequence)
      return {
        provider: agentId,
        nativeSessionId: sourceRun.nativeSessionId!,
        nativeCutId: sourceRun.nativeTurnId!,
        nativeTurnId: sourceRun.nativeTurnId!,
        bindingGeneration: sourceRun.bindingGeneration,
        throughSequence: prefix.sequence,
        deliveryCursor: prefix.deliveryCursor,
        prefixHash: createHash('sha256').update(`${agentId}:fork`).digest('hex'),
        prefixRecords: 2,
        prefixBytes: 128,
      }
    }
    const boundaries = {
      claude: makeBoundary('claude'),
      codex: makeBoundary('codex'),
    }
    const forkOp = repo.commitFork(randomUUID(), selection, boundaries, [])
    for (const agentId of ['claude', 'codex'] as const) {
      const b = boundaries[agentId]
      const childNativeId = `child-${agentId}-native`
      const evidence: AgentNativeForkWitness = {
        version: 'pact-native-fork-v1',
        provider: agentId,
        sourceNativeSessionId: b.nativeSessionId,
        nativeSessionId: childNativeId,
        sourceCutId: b.nativeCutId,
        sourcePrefixHash: b.prefixHash,
        candidatePrefixHash: b.prefixHash,
        idMap: [[b.nativeTurnId, b.nativeTurnId]],
        model: parentSession.settings.agents[agentId].model,
        effort: parentSession.settings.agents[agentId].effort,
        permissionMode: parentSession.settings.permissionModes?.[agentId] ?? 'ask',
        initializedAt: '2026-11-19T03:00:00.000Z',
        initializedPrefixHash: createHash('sha256').update(`init:${agentId}`).digest('hex'),
        initializedPrefixBytes: 128,
        initializedPrefixRecords: 2,
      }
      repo.updateForkIntent(forkOp.sessionId, forkOp.id, agentId, {
        nativeSessionId: childNativeId,
        witnessJson: JSON.stringify(evidence),
        nativeWorkState: 'settled',
      })
      repo.completeForkSide(forkOp.sessionId, forkOp.id, agentId, childNativeId, evidence)
    }

    // Verify child inherited cRun ('agy') with forkSourceRunId = cRun.id and has NO 'agy' row in native_agent_contexts
    const childId = forkOp.sessionId
    const inheritedAgyRun = db.drizzle
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.sessionId, childId), eq(agentRuns.agentId, 'agy')))
      .get()!
    expect(inheritedAgyRun.forkSourceRunId).toBe(cRun.id)
    expect(repo.nativeContext(childId, 'agy')).toBeUndefined()

    // Child swaps settings to (claude, agy): handoffRange(childId, 'agy') MUST start from -1 (full history)!
    sessions.saveSettings(childId, {
      ...sessions.find(childId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    const childAgyRange = repo.handoffRange(childId, 'agy')
    expect(childAgyRange.afterSequence).toBe(-1)
  })

  it('supports agy completeNativeRebuild source inheritance and agy confirmed-unsent replacement while rejecting cross-provider proofs', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('agy', 'claude')

    const prior = runAndComplete(
      db,
      sessionId,
      'agy',
      'Original agy request',
      'Saved agy answer for rebuild inheritance.',
    )
    repo.markNativeContextsMissing(sessionId, ['agy'])
    const rebuildId = randomUUID()
    repo.beginNativeRebuild({
      id: rebuildId,
      sessionId,
      agentId: 'agy',
      expectedGeneration: 1,
      abandon: false,
    })
    const sourceRevisions = new Map<string, number>()
    const chunks = []
    for await (const chunk of repo.nativeContextRebuildSource(
      sessionId,
      new AbortController().signal,
      rebuildId,
      sourceRevisions,
    )) {
      chunks.push(chunk)
    }
    repo.freezeNativeRebuildSource(rebuildId, chunks, sourceRevisions)
    repo.markNativeRebuildDispatched(rebuildId, randomUUID())
    const rebuiltNativeId = randomUUID()
    repo.recordNativeRebuildIdentity(rebuildId, rebuiltNativeId)

    // Missing initializationWitness for 'agy' is rejected
    expect(() => repo.completeNativeRebuild(rebuildId, rebuiltNativeId)).toThrow(
      /durable readback witness/i,
    )

    const frozenRebuildOp = repo.nativeRebuildOperation(rebuildId)!
    expect(frozenRebuildOp.sourceHash).toBeDefined()

    // Reject wrong kind, mismatched sourceHash, missing sourceHash, wrong stepCount, and missing coldLoadVerifiedAt
    expect(() =>
      repo.completeNativeRebuild(rebuildId, rebuiltNativeId, undefined, {
        kind: 'codex_rollout_v1',
        nativeSessionId: rebuiltNativeId,
        verifiedPrefixBytes: 512,
        verifiedPrefixSha256: 'a'.repeat(64),
        recordCount: 2,
      }),
    ).toThrow(RunOperationConflictError)
    expect(() =>
      repo.completeNativeRebuild(rebuildId, rebuiltNativeId, undefined, {
        kind: 'agy_rebuild_v1',
        nativeSessionId: rebuiltNativeId,
        pbSha256: 'a'.repeat(64),
        pbBytes: 512,
        stepCount: 2,
        sourceHash: 'f'.repeat(64),
        coldLoadVerifiedAt: '2026-11-19T04:00:00.000Z',
      }),
    ).toThrow(RunOperationConflictError)
    for (const invalidWitness of [
      {
        kind: 'agy_rebuild_v1',
        nativeSessionId: rebuiltNativeId,
        pbSha256: 'a'.repeat(64),
        pbBytes: 512,
        stepCount: 3,
        sourceHash: frozenRebuildOp.sourceHash!,
        coldLoadVerifiedAt: '2026-11-19T04:00:00.000Z',
      },
      {
        kind: 'agy_rebuild_v1',
        nativeSessionId: rebuiltNativeId,
        pbSha256: 'a'.repeat(64),
        pbBytes: 512,
        stepCount: 2,
        coldLoadVerifiedAt: '2026-11-19T04:00:00.000Z',
      },
      {
        kind: 'agy_rebuild_v1',
        nativeSessionId: rebuiltNativeId,
        pbSha256: 'a'.repeat(64),
        pbBytes: 512,
        stepCount: 2,
        sourceHash: frozenRebuildOp.sourceHash!,
      },
    ]) {
      expect(() =>
        // @ts-expect-error -- Intentional malformed runtime witness check
        repo.completeNativeRebuild(rebuildId, rebuiltNativeId, undefined, invalidWitness),
      ).toThrow(RunOperationConflictError)
    }

    repo.completeNativeRebuild(rebuildId, rebuiltNativeId, undefined, {
      kind: 'agy_rebuild_v1',
      nativeSessionId: rebuiltNativeId,
      pbSha256: 'a'.repeat(64),
      pbBytes: 512,
      stepCount: 2,
      sourceHash: frozenRebuildOp.sourceHash!,
      coldLoadVerifiedAt: '2026-11-19T04:00:00.000Z',
    })
    expect(repo.confirmedNativeInitialization(sessionId, 'agy')?.sourceHash).toBe(
      frozenRebuildOp.sourceHash,
    )

    // Next agy run inherits conversation_run_source_refs from the rebuilt generation
    const nextRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Follow-up after agy rebuild',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
    }).run
    const inheritedRefs = db.drizzle
      .select()
      .from(conversationRunSourceRefs)
      .where(eq(conversationRunSourceRefs.runId, nextRun.id))
      .all()
    expect(inheritedRefs.some((ref) => ref.sourceMessageId === prior.responseMessageId)).toBe(true)

    // Confirmed-unsent proof for 'agy' rejects codex boundary and accepts agy_root_frame_not_written
    const scheduling = repo.schedulingSettings()
    repo.saveSchedulingSettings({ expectedRevision: scheduling.revision, enabled: true })
    repo.beginSchedulingRecoveryEpoch(randomUUID())
    const nativeGeneration = randomUUID()
    const executorId = randomUUID()
    repo.recordExecutor(nextRun.id, executorId)
    repo.applyEvent(sessionId, nextRun.id, {
      agentId: 'agy',
      type: 'session.started',
      nativeSessionId: rebuiltNativeId,
    })
    repo.setContinuation(sessionId, 'agy', 'ready')
    const inputBatchRef = repo.inputBatchForRun(nextRun.id)
    const envelope: FrozenExecutionEnvelope = {
      version: 'pact-agent-prompt-v1',
      sessionId,
      targetAgentId: 'agy',
      message: { id: nextRun.userMessageId, content: 'Follow-up after agy rebuild' },
      comments: [],
      ...(inputBatchRef ? { inputBatchRef } : {}),
    }
    await repo.captureExecutionInput({
      runId: nextRun.id,
      nativeGeneration,
      requested: {
        provider: 'agy',
        model: 'gemini-3.1-pro',
        effort: 'high',
        speed: 'native',
        permissionMode: 'ask',
      },
      source: byteStream(JSON.stringify(envelope)),
      signal: new AbortController().signal,
    })
    repo.recordEffectiveExecutionSettings(
      nextRun.id,
      nativeGeneration,
      {
        version: 1,
        provider: 'agy',
        model: 'gemini-3.1-pro',
        effort: { known: true, value: 'high' },
        speed: 'native',
        permissionMode: 'ask',
        configurationSha256: 'c'.repeat(64),
        provenance: 'agy_applied_settings',
      },
      { executorId, nativeSessionId: rebuiltNativeId },
    )
    repo.recordDispatch(nextRun.id, 'rejected', rebuiltNativeId, executorId)

    // Cross-provider boundary is ignored fail-closed
    repo.recordConfirmedUnsent(
      nextRun.id,
      nativeGeneration,
      { kind: 'codex_root_frame_not_written', requestId: 1 },
      { executorId, nativeSessionId: rebuiltNativeId },
    )
    // Matching agy_root_frame_not_written boundary records proof and admits replacement
    repo.recordConfirmedUnsent(
      nextRun.id,
      nativeGeneration,
      { kind: 'agy_root_frame_not_written', requestId: 'rpc-7' },
      { executorId, nativeSessionId: rebuiltNativeId },
    )
    repo.failRun(nextRun.id, 'transient_transport', 'ACP prompt frame not written.')
    repo.armSchedulingRecoveryFaults(sessionId)
    const fault = repo
      .takeSchedulingRecoveryFaults()
      .find((entry) => entry.fault.runId === nextRun.id)!
    expect(fault).toBeDefined()
    const replacement = repo.beginConfirmedUnsentReexecution({
      operationId: randomUUID(),
      faultId: fault.fault.id,
      handoff: repo.recoveryHandoff({ kind: 'run', id: nextRun.id }),
    }).run
    expect(replacement.agentId).toBe('agy')
    expect(replacement.reexecutedFromRunId).toBe(nextRun.id)
  })

  it('uses indexed query plans without full table or session-history scans for exact SessionRepository replacement gate queries over hundreds of runs and queue inputs', async () => {
    const { db, sessions, sessionId } = await createFixture('claude', 'codex')
    runAndComplete(db, sessionId, 'claude', 'Seed turn 1', 'Seed answer 1')
    runAndComplete(db, sessionId, 'codex', 'Seed turn 2', 'Seed answer 2')

    // Populate representative history: 300 completed runs, 600 messages, 200 consumed queue inputs & batches, 20 completed rebuilds
    db.drizzle.transaction((tx) => {
      for (let i = 0; i < 300; i += 1) {
        const agentId: RuntimeAgentId = i % 2 === 0 ? 'claude' : 'codex'
        const runId = randomUUID()
        const userMsgId = randomUUID()
        const assistantMsgId = randomUUID()
        const createdAt = new Date(Date.UTC(2026, 10, 19, 1, 0, i)).toISOString()
        const baseSeq = 100 + i * 2
        tx.insert(conversationMessages)
          .values([
            {
              id: userMsgId,
              sessionId,
              runId,
              role: 'user',
              routeKind: 'primary',
              routeAgentsJson: JSON.stringify([agentId]),
              content: `Historical user prompt ${i}`,
              state: 'complete',
              sequence: baseSeq,
              createdAt,
              updatedAt: createdAt,
            },
            {
              id: assistantMsgId,
              sessionId,
              runId,
              agentId,
              replyToMessageId: userMsgId,
              role: 'assistant',
              content: `Historical assistant answer ${i}`,
              state: 'complete',
              sequence: baseSeq + 1,
              createdAt,
              updatedAt: createdAt,
            },
          ])
          .run()
        tx.insert(agentRuns)
          .values({
            id: runId,
            sessionId,
            userMessageId: userMsgId,
            agentId,
            status: 'completed',
            attemptCount: 1,
            settingsRevision: 1,
            permissionMode: agentId === 'codex' ? 'native' : 'ask',
            model: null,
            effort: null,
            speed: 'native',
            nativeSessionId: `${agentId}-native-${sessionId.slice(0, 8)}`,
            nativeTurnId: `${runId}:turn`,
            bindingGeneration: 1,
            dispatchPhase: 'ended',
            nativeOutcome: 'completed',
            nativeEffectsState: 'settled',
            createdAt,
            updatedAt: createdAt,
          })
          .run()
        if (i < 200) {
          const bodyId = randomUUID()
          const inputId = randomUUID()
          const digest = createHash('sha256').update(`queued-${i}`).digest('hex')
          tx.insert(conversationBodyInputs)
            .values({
              id: bodyId,
              sessionId,
              ownerKey: 'hist-owner',
              clientMessageId: inputId,
              purpose: 'input',
              bytes: 12,
              chars: 12,
              sealed: true,
              hash: digest,
              createdAt,
              updatedAt: createdAt,
            })
            .run()
          tx.insert(collaborationInputs)
            .values({
              id: inputId,
              sessionId,
              anchorRunId: runId,
              inputId: bodyId,
              metadataJson: JSON.stringify({
                workflowCommand: false,
                skills: [],
                imageIds: [],
                commentIds: [],
                batchId: inputId,
                freezeDrafts: true,
              }),
              digest,
              actor: agentId,
              policy: 'next_round',
              state: i % 2 === 0 ? 'materialized' : 'cancelled',
              materializedRunId: i % 2 === 0 ? runId : null,
              createdAt,
              deadline: createdAt,
              queueState: i % 2 === 0 ? 'delivered' : 'returned',
              preview: `queued-${i}`,
            })
            .run()
          tx.insert(conversationInputBatches)
            .values({
              id: randomUUID(),
              sessionId,
              sequence: 100 + i,
              clientMessageId: userMsgId,
              commentsRevision: 0,
              actor: agentId,
              runId,
              messageId: userMsgId,
              dispatchState: 'dispatched',
              inputId: bodyId,
              memberCount: 0,
              bodyState: 'resolved',
              state: 'closed',
              createdAt,
              closedAt: createdAt,
            })
            .run()
        }
        if (i < 20) {
          tx.insert(nativeRebuildOperations)
            .values({
              id: randomUUID(),
              sessionId,
              agentId: 'codex',
              oldGeneration: i + 1,
              oldNativeSessionId: `old-${i}`,
              abandon: false,
              stage: 'completed',
              provisionalNativeSessionId: `rebuilt-${i}`,
              sourceHash: 'a'.repeat(64),
              sourceChunksJson: '[]',
              nativeWorkState: 'settled',
              createdAt,
              updatedAt: createdAt,
            })
            .run()
        }
      }
    })

    const dialect = new SQLiteSyncDialect()
    const explainDetails = (query: ReturnType<typeof sql>) => {
      const compiled = dialect.sqlToQuery(query)
      expect(compiled.params.length).toBeGreaterThan(0)
      return db.drizzle
        .all(sql`EXPLAIN QUERY PLAN ${query}`)
        .map((row) =>
          typeof row === 'object' && row !== null ? String(Reflect.get(row, 'detail')) : '',
        )
        .join('\n')
    }

    const gateQueries = SessionRepository.replacementGateQueries(sessionId, ['codex'])
    const topLevelEntries = [
      ['activeRun', gateQueries.activeRun],
      ['unreadyFork', gateQueries.unreadyFork],
      ['queuedInput', gateQueries.queuedInput],
      ['pendingRoute', gateQueries.pendingRoute],
      ['pendingPreparedBatch', gateQueries.pendingPreparedBatch],
      ['pendingPausedBatch', gateQueries.pendingPausedBatch],
      ['unansweredDecision', gateQueries.unansweredDecision],
      ['activeTask', gateQueries.activeTask],
      ['retired.unsettledRun', gateQueries.retired[0]!.unsettledRun],
      ['retired.pendingRebuildStage', gateQueries.retired[0]!.pendingRebuildStage],
      ['retired.pendingRebuildWork', gateQueries.retired[0]!.pendingRebuildWork],
      ['retired.context', gateQueries.retired[0]!.context],
    ] as const

    for (const [label, query] of topLevelEntries) {
      const plan = explainDetails(query)
      expect(plan, `${label} plan`).toContain('INDEX')
      expect(plan, `${label} must not full-scan table`).not.toMatch(
        /\bSCAN (?:agent_runs|conversation_messages|collaboration_inputs|conversation_input_batches|native_rebuild_operations|native_agent_contexts|relay_decisions|collaboration_tasks|session_fork_operations)\b/,
      )
      expect(plan, `${label} must not scan full session history`).not.toMatch(
        /\b(?:agent_runs_session_created_idx|agent_runs_session_agent_generation_idx|conversation_messages_session_visible_sequence_idx|collaboration_inputs_session_created|conversation_input_batches_nonce_idx|native_rebuild_operations_binding_idx)\b/,
      )
    }

    const handoffLastAcceptedPlan = explainDetails(sql`
      SELECT conversation_messages.sequence
      FROM agent_runs
      INNER JOIN conversation_messages ON conversation_messages.id = agent_runs.user_message_id
      WHERE agent_runs.session_id = ${sessionId}
        AND agent_runs.agent_id = 'codex'
        AND agent_runs.fork_source_run_id IS NULL
        AND agent_runs.native_session_id = ${`codex-native-${sessionId.slice(0, 8)}`}
        AND agent_runs.binding_generation = 1
        AND agent_runs.native_turn_id IS NOT NULL
        AND (agent_runs.failure_kind IS NULL OR agent_runs.failure_kind NOT IN ('context_limit', 'unknown_delivery'))
      ORDER BY agent_runs.created_at DESC, conversation_messages.sequence DESC
      LIMIT 1
    `)
    expect(handoffLastAcceptedPlan).toContain('INDEX')
    expect(handoffLastAcceptedPlan).not.toContain('SCAN agent_runs')
    expect(handoffLastAcceptedPlan).not.toContain('SCAN conversation_messages')

    // Production replacement check executes cleanly over the populated 300-run / 200-queue-input history
    const replaced = sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    expect(replaced.session.settings.secondaryAgentId).toBe('agy')
  })

  it('prevents stale settingsRevision and retired Full access bypass on ordinary Send and accepted peer proposals while preserving frozen continuations', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')
    // Grant Full access to claude and codex at rev 2 & 3
    sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'claude',
      mode: 'full',
      confirmedFullAccess: true,
    })
    const fullRev = sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'codex',
      mode: 'full',
      confirmedFullAccess: true,
    }).session.settingsRevision

    // Create a completed codex run with a pending peer proposal targeting claude (and another targeting codex)
    const proposerRun = runAndComplete(
      db,
      sessionId,
      'codex',
      'Analyze module',
      'I propose a peer follow-up.',
    )
    const proposalToClaudeId = randomUUID()
    db.drizzle
      .update(agentRuns)
      .set({
        peerProposalId: proposalToClaudeId,
        peerProposalTargetAgentId: 'claude',
        peerProposalKind: 'review',
        peerProposalReason: 'Review changes',
        peerProposalState: 'pending',
      })
      .where(eq(agentRuns.id, proposerRun.id))
      .run()

    // Now revoke codex Full -> ask AND retire claude -> agy!
    sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'codex',
      mode: 'ask',
      confirmedFullAccess: false,
    })
    const afterSwap = sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    }).session

    // 1. Ordinary Send with stale settingsRevision (fullRev) is rejected even for active member codex
    expect(() =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Stale ordinary send',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: fullRev,
        model: null,
        effort: null,
      }),
    ).toThrow(/Session settings changed during workflow preparation/)

    // 2. Accepted peer proposal (sourceProposalId + sourceMessageId, matching real acceptPeerProposal)
    // with stale settingsRevision is rejected AND preserves the pending proposal!
    expect(() =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Accepted peer proposal with stale rev',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'claude',
        settingsRevision: fullRev,
        sourceProposalId: proposalToClaudeId,
        sourceMessageId: proposerRun.responseMessageId!,
        model: null,
        effort: null,
      }),
    ).toThrow(/Session settings changed during workflow preparation/)
    expect(repo.findRun(proposerRun.id)?.peerProposal?.state).toBe('pending')

    // 3. Accepted peer proposal (sourceProposalId + sourceMessageId) with current settingsRevision
    // targeting retired claude is rejected as inactive AND preserves the pending proposal!
    expect(() =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Accepted peer proposal to retired claude',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'claude',
        settingsRevision: afterSwap.settingsRevision,
        sourceProposalId: proposalToClaudeId,
        sourceMessageId: proposerRun.responseMessageId!,
        model: null,
        effort: null,
      }),
    ).toThrow(/Claude Code is not an active Agent/)
    expect(repo.findRun(proposerRun.id)?.peerProposal?.state).toBe('pending')

    // 3b. Active-member peer proposal (sourceProposalId + sourceMessageId) after Full -> ask downgrade:
    // stale revision rejects (preserving pending), current revision admits with 'ask' (never 'full')!
    const codexFullAgainRev = sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'codex',
      mode: 'full',
      confirmedFullAccess: true,
    }).session.settingsRevision
    const agyProposerRun = runAndComplete(
      db,
      sessionId,
      'agy',
      'Inspect codex follow-up',
      'Proposing codex review.',
    )
    const proposalToCodexId = randomUUID()
    db.drizzle
      .update(agentRuns)
      .set({
        peerProposalId: proposalToCodexId,
        peerProposalTargetAgentId: 'codex',
        peerProposalKind: 'review',
        peerProposalReason: 'Review implementation',
        peerProposalState: 'pending',
      })
      .where(eq(agentRuns.id, agyProposerRun.id))
      .run()
    const codexDowngradedRev = sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'codex',
      mode: 'ask',
      confirmedFullAccess: false,
    }).session.settingsRevision

    expect(() =>
      repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Accept codex proposal with stale full rev',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: codexFullAgainRev,
        sourceProposalId: proposalToCodexId,
        sourceMessageId: agyProposerRun.responseMessageId!,
        model: null,
        effort: null,
      }),
    ).toThrow(/Session settings changed during workflow preparation/)
    expect(repo.findRun(agyProposerRun.id)?.peerProposal?.state).toBe('pending')

    const acceptedProposalRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Accept codex proposal at current ask rev',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: codexDowngradedRev,
      sourceProposalId: proposalToCodexId,
      sourceMessageId: agyProposerRun.responseMessageId!,
      model: null,
      effort: null,
    }).run
    expect(acceptedProposalRun.permissionMode).toBe('ask')
    expect(acceptedProposalRun.settingsRevision).toBe(codexDowngradedRev)
    expect(repo.findRun(agyProposerRun.id)?.peerProposal?.state).toBe('accepted')
    const proposalTurnId = `${acceptedProposalRun.id}:turn`
    repo.applyEvent(sessionId, acceptedProposalRun.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: `codex-native-${sessionId.slice(0, 8)}`,
    })
    repo.applyEvent(sessionId, acceptedProposalRun.id, {
      agentId: 'codex',
      type: 'turn.started',
      turnId: proposalTurnId,
    })
    repo.applyEvent(sessionId, acceptedProposalRun.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId: proposalTurnId,
      outputId: `${acceptedProposalRun.id}:out`,
      text: 'Proposal handled.',
    })
    repo.applyEvent(sessionId, acceptedProposalRun.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: proposalTurnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(acceptedProposalRun.id, 'settled')

    // 4. Ordinary Send at current revision uses current 'ask' permission, never old 'full'
    const freshCodexRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Fresh send after permission downgrade',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: codexDowngradedRev,
      model: null,
      effort: null,
    }).run
    expect(freshCodexRun.permissionMode).toBe('ask')
    expect(freshCodexRun.settingsRevision).toBe(codexDowngradedRev)

    // 5. Queued input (receivedInputId) reads LIVE admission settingsRevision permissions/model/effort
    // (never inheriting revoked 'full' from queue time!), while preserving idempotent readback!
    const turnId = `${freshCodexRun.id}:turn`
    repo.applyEvent(sessionId, freshCodexRun.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: `codex-native-${sessionId.slice(0, 8)}`,
    })
    const authorizedQueueRevision = sessions.savePermission({
      sessionId,
      expectedRevision: sessions.find(sessionId)!.settingsRevision,
      agentId: 'agy',
      mode: 'full',
      confirmedFullAccess: true,
    }).session.settingsRevision
    const queuedId = enqueueInput(db, sessionId, freshCodexRun.id, 'agy', 'Queued agy turn')
    repo.applyEvent(sessionId, freshCodexRun.id, {
      agentId: 'codex',
      type: 'turn.started',
      turnId,
    })
    repo.applyEvent(sessionId, freshCodexRun.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId,
      outputId: `${freshCodexRun.id}:out`,
      text: 'Done.',
    })
    repo.applyEvent(sessionId, freshCodexRun.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(freshCodexRun.id, 'settled')

    // Revoke agy Full -> ask AND update agy effort while queuedId is waiting before admission!
    sessions.savePermission({
      sessionId,
      expectedRevision: authorizedQueueRevision,
      agentId: 'agy',
      mode: 'ask',
      confirmedFullAccess: false,
    })
    const currentBeforeAdmission = sessions.find(sessionId)!
    const liveAdmissionRev = sessions.saveSettings(sessionId, {
      ...currentBeforeAdmission.settings,
      agents: {
        ...currentBeforeAdmission.settings.agents,
        agy: {
          ...currentBeforeAdmission.settings.agents.agy,
          effort: 'low',
        },
      },
    }).session.settingsRevision

    const materializedQueuedResult = repo.beginRun({
      sessionId,
      clientMessageId: queuedId,
      content: 'Queued agy turn',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: authorizedQueueRevision,
      receivedInputId: queuedId,
      preserveDraftComments: true,
      model: 'gemini-3.1-pro',
      effort: 'high',
    })
    expect(materializedQueuedResult.created).toBe(true)
    expect(materializedQueuedResult.run.settingsRevision).toBe(liveAdmissionRev)
    expect(materializedQueuedResult.run.permissionMode).toBe('ask')
    expect(materializedQueuedResult.run.effort).toBe('low')

    // Subsequent settings bump does not break idempotent readback of the already-created run
    sessions.saveSpeed({
      sessionId,
      expectedRevision: liveAdmissionRev,
      agentId: 'codex',
      speed: 'fast',
    })
    const replayedQueuedResult = repo.beginRun({
      sessionId,
      clientMessageId: queuedId,
      content: 'Queued agy turn',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: authorizedQueueRevision,
      receivedInputId: queuedId,
      preserveDraftComments: true,
      model: 'gemini-3.1-pro',
      effort: 'high',
    })
    expect(replayedQueuedResult.created).toBe(false)
    expect(replayedQueuedResult.run.id).toBe(materializedQueuedResult.run.id)
    expect(replayedQueuedResult.run.settingsRevision).toBe(liveAdmissionRev)
  })

  it('guards nested Fork against ancestor-only 3rd agent C until C establishes a child native run, and validates agy Fork witnesses strictly', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('agy', 'claude')

    // Parent: agy (C) runs Turn 1, claude (A) runs Turn 2, then swap to (claude, codex) and codex (B) runs Turn 3
    runAndComplete(db, sessionId, 'agy', 'Parent agy prompt', 'Parent agy answer')
    const claudeParent = runAndComplete(
      db,
      sessionId,
      'claude',
      'Parent claude prompt',
      'Parent claude answer',
    )
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    })
    const codexParent = runAndComplete(
      db,
      sessionId,
      'codex',
      'Parent codex prompt',
      'Parent codex answer',
    )

    const parentSession = sessions.find(sessionId)!
    const selection = repo.selectForkSource(
      sessionId,
      codexParent.responseMessageId!,
      parentSession.settings,
      parentSession.settingsRevision,
    )
    const makeLegacyBoundary = (
      agentId: 'claude' | 'codex',
      omitProvider = false,
    ): AgentNativeForkBoundary => {
      const sourceRun = selection.runs[agentId]!
      const prefix = repo.forkResponse(sourceRun.id, selection.prepared.sequence)
      return {
        ...(omitProvider ? {} : { provider: agentId }),
        nativeSessionId: sourceRun.nativeSessionId!,
        nativeCutId: sourceRun.nativeTurnId!,
        nativeTurnId: sourceRun.nativeTurnId!,
        bindingGeneration: sourceRun.bindingGeneration,
        throughSequence: prefix.sequence,
        deliveryCursor: prefix.deliveryCursor,
        prefixHash: createHash('sha256').update(`${agentId}:fork`).digest('hex'),
        prefixRecords: 2,
        prefixBytes: 128,
      }
    }

    // Provider mismatch on commitFork is rejected
    expect(() =>
      repo.commitFork(
        randomUUID(),
        selection,
        {
          claude: { ...makeLegacyBoundary('claude'), provider: 'codex' },
          codex: makeLegacyBoundary('codex'),
        },
        [],
      ),
    ).toThrow(/provider does not match/)

    // Legacy provider === undefined remains compatible for claude/codex
    const forkOp = repo.commitFork(
      randomUUID(),
      selection,
      {
        claude: makeLegacyBoundary('claude', true),
        codex: makeLegacyBoundary('codex'),
      },
      [],
    )
    for (const agentId of ['claude', 'codex'] as const) {
      const b = makeLegacyBoundary(agentId, agentId === 'claude')
      const childNativeId = `child-${agentId}-sid`
      const legacyWitness: AgentNativeForkWitness = {
        version: 'pact-native-fork-v1',
        ...(agentId === 'claude' ? {} : { provider: agentId }),
        sourceNativeSessionId: b.nativeSessionId,
        nativeSessionId: childNativeId,
        sourceCutId: b.nativeCutId,
        sourcePrefixHash: b.prefixHash,
        candidatePrefixHash: b.prefixHash,
        idMap: [[b.nativeTurnId, b.nativeTurnId]],
        model: null,
        effort: null,
        permissionMode: agentId === 'codex' ? 'native' : 'ask',
        initializedAt: '2026-11-19T05:00:00.000Z',
      }
      // Reject provider: 'agy' on claude/codex side
      expect(() =>
        repo.updateForkIntent(forkOp.sessionId, forkOp.id, agentId, {
          nativeSessionId: childNativeId,
          witnessJson: JSON.stringify({
            ...legacyWitness,
            provider: 'agy',
            sourceTrajectoryId: 'traj-src',
            candidateTrajectoryId: 'traj-dst',
            cutStepIdx: 2,
            agyCut: {
              version: 'pact-agy-fork-cut-v1',
              trajectoryId: 'traj-dst',
              executionId: b.nativeTurnId,
              cutStepIdx: 2,
            },
          }),
          nativeWorkState: 'settled',
        }),
      ).toThrow(/provider does not match/)

      repo.updateForkIntent(forkOp.sessionId, forkOp.id, agentId, {
        nativeSessionId: childNativeId,
        witnessJson: JSON.stringify(legacyWitness),
        nativeWorkState: 'settled',
      })
      repo.completeForkSide(forkOp.sessionId, forkOp.id, agentId, childNativeId, legacyWitness)
    }

    const childId = forkOp.sessionId
    const childMessages = repo.read(childId).messages
    const inheritedCodexMsg = childMessages.find((m) => m.content === 'Parent codex answer')!
    expect(claudeParent.responseMessageId).toBeDefined()

    // Swap child active pair to (claude, agy)
    sessions.saveSettings(childId, {
      ...sessions.find(childId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })

    // Nested Fork BEFORE agy establishes its own child native run MUST be rejected (ancestor-only C run ignored)
    const childBeforeAgy = sessions.find(childId)!
    expect(() =>
      repo.selectForkSource(
        childId,
        inheritedCodexMsg.id,
        childBeforeAgy.settings,
        childBeforeAgy.settingsRevision,
      ),
    ).toThrow(/Antigravity has no confirmed native history at this message/)

    // Now agy establishes its own child native run!
    const childAgyRun = runAndComplete(db, childId, 'agy', 'Child agy prompt', 'Child agy answer', {
      nativeSessionId: 'child-agy-fresh-sid',
    })
    const childAfterAgy = sessions.find(childId)!

    // Nested Fork at the EARLIER inherited message (before childAgyRun) MUST STILL be rejected!
    expect(() =>
      repo.selectForkSource(
        childId,
        inheritedCodexMsg.id,
        childAfterAgy.settings,
        childAfterAgy.settingsRevision,
      ),
    ).toThrow(/Antigravity has no confirmed native history at this message/)

    // Nested Fork AT childAgyRun's completed message SUCCEEDS and validates agy boundary & witness!
    const nestedSelection = repo.selectForkSource(
      childId,
      childAgyRun.responseMessageId!,
      childAfterAgy.settings,
      childAfterAgy.settingsRevision,
    )
    expect(nestedSelection.runs.agy?.id).toBe(childAgyRun.id)

    const claudeNestedSource = nestedSelection.runs.claude!
    const claudeNestedPrefix = repo.forkResponse(
      claudeNestedSource.id,
      nestedSelection.prepared.sequence,
    )
    const agyNestedPrefix = repo.forkResponse(childAgyRun.id, nestedSelection.prepared.sequence)
    const agyTurnId = childAgyRun.nativeTurnId!
    const validAgyBoundary: AgentNativeForkBoundary = {
      provider: 'agy',
      nativeSessionId: 'child-agy-fresh-sid',
      nativeCutId: agyTurnId,
      nativeTurnId: agyTurnId,
      agyCut: {
        version: 'pact-agy-fork-cut-v1',
        trajectoryId: 'traj-parent-agy',
        executionId: agyTurnId,
        cutStepIdx: 2,
      },
      bindingGeneration: 1,
      throughSequence: agyNestedPrefix.sequence,
      deliveryCursor: agyNestedPrefix.deliveryCursor,
      prefixHash: 'd'.repeat(64),
      prefixRecords: 3,
      prefixBytes: 256,
    }
    const claudeNestedBoundary: AgentNativeForkBoundary = {
      provider: 'claude',
      nativeSessionId: claudeNestedSource.nativeSessionId!,
      nativeCutId: claudeNestedSource.nativeTurnId!,
      nativeTurnId: claudeNestedSource.nativeTurnId!,
      bindingGeneration: claudeNestedSource.bindingGeneration,
      throughSequence: claudeNestedPrefix.sequence,
      deliveryCursor: claudeNestedPrefix.deliveryCursor,
      prefixHash: 'e'.repeat(64),
      prefixRecords: 2,
      prefixBytes: 128,
    }

    // Reject provider: 'codex' boundary for agy
    expect(() =>
      repo.commitFork(
        randomUUID(),
        nestedSelection,
        {
          claude: claudeNestedBoundary,
          agy: {
            ...validAgyBoundary,
            provider: 'codex',
            agyCut: undefined,
          },
        },
        [],
      ),
    ).toThrow(/Antigravity Fork boundaries require provider "agy"/)

    // Reject agy boundary whose agyCut.executionId disagrees with boundary.nativeCutId
    expect(() =>
      repo.commitFork(
        randomUUID(),
        nestedSelection,
        {
          claude: claudeNestedBoundary,
          agy: {
            ...validAgyBoundary,
            agyCut: {
              ...validAgyBoundary.agyCut!,
              executionId: 'mismatched-cut-exec-id',
            },
          },
        },
        [],
      ),
    ).toThrow(/matching agyCut execution metadata/)

    const nestedForkOp = repo.commitFork(
      randomUUID(),
      nestedSelection,
      { claude: claudeNestedBoundary, agy: validAgyBoundary },
      [],
    )
    const grandchildAgySid = 'grandchild-agy-sid'
    const validAgyWitness: AgentNativeForkWitness = {
      version: 'pact-native-fork-v1',
      provider: 'agy',
      sourceNativeSessionId: validAgyBoundary.nativeSessionId,
      nativeSessionId: grandchildAgySid,
      sourceCutId: validAgyBoundary.nativeCutId,
      sourceTrajectoryId: 'traj-parent-agy',
      candidateTrajectoryId: 'traj-grandchild-agy',
      cutStepIdx: 2,
      agyCut: {
        version: 'pact-agy-fork-cut-v1',
        trajectoryId: 'traj-grandchild-agy',
        executionId: agyTurnId,
        cutStepIdx: 2,
      },
      sourcePrefixHash: validAgyBoundary.prefixHash,
      candidatePrefixHash: validAgyBoundary.prefixHash,
      candidatePrefixRecords: 3,
      idMap: [[agyTurnId, agyTurnId]],
      model: 'gemini-3.1-pro',
      effort: 'high',
      permissionMode: 'ask',
      initializedAt: '2026-11-19T05:30:00.000Z',
      initializedPrefixHash: 'f'.repeat(64),
      initializedPrefixRecords: 3,
      initializedPrefixBytes: 256,
    }

    repo.updateForkIntent(nestedForkOp.sessionId, nestedForkOp.id, 'agy', {
      nativeSessionId: grandchildAgySid,
      nativeWorkState: 'settled',
    })

    // Reject provider: 'codex' witness on 'agy' intent
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        provider: 'codex',
        sourceTrajectoryId: undefined,
        candidateTrajectoryId: undefined,
        cutStepIdx: undefined,
        agyCut: undefined,
      }),
    ).toThrow(/Antigravity Fork witness/)

    // Reject mismatched executionId on agyCut
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        agyCut: {
          ...validAgyWitness.agyCut!,
          executionId: 'wrong-exec-id',
        },
      }),
    ).toThrow(/Antigravity Fork witness/)

    // Reject mismatched sourceTrajectoryId vs boundary.agyCut.trajectoryId
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        sourceTrajectoryId: 'wrong-source-trajectory-id',
      }),
    ).toThrow(/Antigravity Fork witness/)

    // Reject candidatePrefixHash !== boundary.prefixHash
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        candidatePrefixHash: 'a'.repeat(64),
      }),
    ).toThrow(/does not belong to this source cutoff/)

    // Reject missing physical initialization fields (initializedAt / initializedPrefixHash) before marking ready
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        initializedAt: undefined,
      }),
    ).toThrow(/initialization or settlement has not been confirmed/)
    expect(() =>
      repo.completeForkSide(nestedForkOp.sessionId, nestedForkOp.id, 'agy', grandchildAgySid, {
        ...validAgyWitness,
        initializedPrefixHash: undefined,
      }),
    ).toThrow(/Antigravity Fork witness/)
    expect(() =>
      repo.updateForkIntent(nestedForkOp.sessionId, nestedForkOp.id, 'agy', {
        state: 'ready',
        witnessJson: JSON.stringify({
          ...validAgyWitness,
          initializedPrefixHash: undefined,
        }),
      }),
    ).toThrow(/Antigravity Fork witness/)

    // Valid agy witness completes cleanly
    const completedNested = repo.completeForkSide(
      nestedForkOp.sessionId,
      nestedForkOp.id,
      'agy',
      grandchildAgySid,
      validAgyWitness,
    )
    expect(completedNested.forkOperation?.sides.find((s) => s.agentId === 'agy')?.state).toBe(
      'ready',
    )

    // Pre-Rebuild forked child history remains Fork-eligible after claude rebuilds its native binding in childId
    db.drizzle
      .update(nativeAgentContexts)
      .set({
        nativeSessionId: 'rebuilt-child-claude-sid',
        bindingGeneration: 2,
      })
      .where(
        and(eq(nativeAgentContexts.sessionId, childId), eq(nativeAgentContexts.agentId, 'claude')),
      )
      .run()
    const postRebuildSelection = repo.selectForkSource(
      childId,
      childAgyRun.responseMessageId!,
      childAfterAgy.settings,
      childAfterAgy.settingsRevision,
    )
    expect(postRebuildSelection.runs.claude?.id).toBe(claudeNestedSource.id)
    expect(postRebuildSelection.runs.claude?.nativeSessionId).toBe('child-claude-sid')
    expect(postRebuildSelection.runs.agy?.id).toBe(childAgyRun.id)
    // Ancestor-only 'agy' message before childAgyRun STILL remains excluded after claude's rebuild
    expect(() =>
      repo.selectForkSource(
        childId,
        inheritedCodexMsg.id,
        childAfterAgy.settings,
        childAfterAgy.settingsRevision,
      ),
    ).toThrow(/Antigravity has no confirmed native history at this message/)
  })

  it('includes inherited ancestor messages of newly swapped-in C in first forked-child Handoff and populates ordered unique handoffSourceAgents', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('agy', 'claude')

    // Parent turns: agy -> claude -> swap to (claude, codex) -> codex
    runAndComplete(db, sessionId, 'agy', 'Ancestor prompt to agy', 'Ancestor answer from agy')
    runAndComplete(
      db,
      sessionId,
      'claude',
      'Ancestor prompt to claude',
      'Ancestor answer from claude',
    )
    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    })
    const codexParent = runAndComplete(
      db,
      sessionId,
      'codex',
      'Ancestor prompt to codex',
      'Ancestor answer from codex',
    )

    const parentSession = sessions.find(sessionId)!
    const selection = repo.selectForkSource(
      sessionId,
      codexParent.responseMessageId!,
      parentSession.settings,
      parentSession.settingsRevision,
    )
    const makeBoundary = (agentId: 'claude' | 'codex'): AgentNativeForkBoundary => {
      const sourceRun = selection.runs[agentId]!
      const prefix = repo.forkResponse(sourceRun.id, selection.prepared.sequence)
      return {
        provider: agentId,
        nativeSessionId: sourceRun.nativeSessionId!,
        nativeCutId: sourceRun.nativeTurnId!,
        nativeTurnId: sourceRun.nativeTurnId!,
        bindingGeneration: sourceRun.bindingGeneration,
        throughSequence: prefix.sequence,
        deliveryCursor: prefix.deliveryCursor,
        prefixHash: createHash('sha256').update(`${agentId}:h`).digest('hex'),
        prefixRecords: 2,
        prefixBytes: 128,
      }
    }
    const forkOp = repo.commitFork(
      randomUUID(),
      selection,
      { claude: makeBoundary('claude'), codex: makeBoundary('codex') },
      [],
    )
    for (const agentId of ['claude', 'codex'] as const) {
      const b = makeBoundary(agentId)
      const childSid = `forked-${agentId}-sid`
      const w: AgentNativeForkWitness = {
        version: 'pact-native-fork-v1',
        provider: agentId,
        sourceNativeSessionId: b.nativeSessionId,
        nativeSessionId: childSid,
        sourceCutId: b.nativeCutId,
        sourcePrefixHash: b.prefixHash,
        candidatePrefixHash: b.prefixHash,
        idMap: [[b.nativeTurnId, b.nativeTurnId]],
        model: null,
        effort: null,
        permissionMode: agentId === 'codex' ? 'native' : 'ask',
        initializedAt: '2026-11-19T06:00:00.000Z',
      }
      repo.updateForkIntent(forkOp.sessionId, forkOp.id, agentId, {
        nativeSessionId: childSid,
        witnessJson: JSON.stringify(w),
        nativeWorkState: 'settled',
      })
      repo.completeForkSide(forkOp.sessionId, forkOp.id, agentId, childSid, w)
    }

    const childId = forkOp.sessionId

    // Forked member 'claude' already has its own inherited turn covered by its child native binding:
    // handoff to 'claude' excludes claude's covered assistant turn!
    const claudeRange = repo.handoffRange(childId, 'claude')
    const claudePage = repo.readHandoffPage(
      childId,
      'claude',
      claudeRange.afterSequence,
      claudeRange.throughSequence,
    )
    expect(claudePage.messages.some((m) => m.content === 'Ancestor answer from claude')).toBe(false)
    expect(claudePage.messages.some((m) => m.content === 'Ancestor answer from codex')).toBe(true)

    // Swap child to (claude, agy): first Handoff to newly swapped-in 'agy' MUST include inherited agy, claude, AND codex messages!
    sessions.saveSettings(childId, {
      ...sessions.find(childId)!.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    const agyRange = repo.handoffRange(childId, 'agy')
    expect(agyRange.afterSequence).toBe(-1)

    const agyPage = repo.readHandoffPage(
      childId,
      'agy',
      agyRange.afterSequence,
      agyRange.throughSequence,
    )
    expect(agyPage.messages.map((m) => m.content)).toEqual([
      'Ancestor prompt to agy',
      'Ancestor answer from agy',
      'Ancestor prompt to claude',
      'Ancestor answer from claude',
      'Ancestor prompt to codex',
      'Ancestor answer from codex',
    ])

    const streamedSources = []
    for await (const item of repo.readHandoffSources(
      childId,
      'agy',
      agyRange.afterSequence,
      agyRange.throughSequence,
      new AbortController().signal,
    )) {
      streamedSources.push(item)
    }
    expect(streamedSources.map((m) => m.content)).toEqual(agyPage.messages.map((m) => m.content))

    // Freeze handoffSourceRefs onto the new agy Run and verify ordered unique handoffSourceAgents
    const childSession = sessions.find(childId)!
    const newAgyRun = repo.beginRun({
      sessionId: childId,
      clientMessageId: randomUUID(),
      content: 'First child turn to agy with full 3-agent handoff',
      expectedCommentsRevision: draftRevision(db, childId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: childSession.settingsRevision,
      model: null,
      effort: null,
      handoffSourceRefs: streamedSources.map((item) => ({
        id: item.messageId,
        revision: item.contentRevision,
        digest: item.digest,
      })),
    }).run
    expect(newAgyRun.handoffMessageCount).toBe(6)
    expect(newAgyRun.handoffSourceAgents).toEqual(['agy', 'claude', 'codex'])
    expect(repo.findRun(newAgyRun.id)?.handoffSourceAgents).toEqual(['agy', 'claude', 'codex'])

    // Streaming batches (applyStreamBatch -> commitEvents -> findRun) preserve handoffSourceAgents
    // in O(1) via bounded LRU cache without per-batch json_each history joins!
    const agyStreamTurnId = `${newAgyRun.id}:turn`
    repo.applyEvent(childId, newAgyRun.id, {
      agentId: 'agy',
      type: 'session.started',
      nativeSessionId: 'child-agy-handoff-sid',
    })
    repo.applyEvent(childId, newAgyRun.id, {
      agentId: 'agy',
      type: 'turn.started',
      turnId: agyStreamTurnId,
    })
    const batch1 = repo.applyStreamBatch(childId, newAgyRun.id, [
      {
        agentId: 'agy',
        type: 'text.delta',
        turnId: agyStreamTurnId,
        outputId: `${newAgyRun.id}:out`,
        text: 'Streaming ',
      },
    ])
    const batch2 = repo.applyStreamBatch(childId, newAgyRun.id, [
      {
        agentId: 'agy',
        type: 'text.delta',
        turnId: agyStreamTurnId,
        outputId: `${newAgyRun.id}:out`,
        text: 'chunk two.',
      },
    ])
    expect(batch1.runs[0]?.handoffSourceAgents).toEqual(['agy', 'claude', 'codex'])
    expect(batch2.runs[0]?.handoffSourceAgents).toEqual(['agy', 'claude', 'codex'])
  })

  it('attributes handoffSourceAgents across accepted user + assistant refs and omits attribution when any frozen ref lacks peer attribution', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')

    // 1. claude accepts a user turn natively (turn.started sets nativeTurnId) then interrupts before an assistant reply
    const claudeAcceptedOnly = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Accepted user prompt to claude',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
    }).run
    repo.applyEvent(sessionId, claudeAcceptedOnly.id, {
      agentId: 'claude',
      type: 'session.started',
      nativeSessionId: 'claude-accepted-only-sid',
    })
    repo.applyEvent(sessionId, claudeAcceptedOnly.id, {
      agentId: 'claude',
      type: 'turn.started',
      turnId: `${claudeAcceptedOnly.id}:turn`,
    })
    repo.applyEvent(sessionId, claudeAcceptedOnly.id, {
      agentId: 'claude',
      type: 'turn.completed',
      turnId: `${claudeAcceptedOnly.id}:turn`,
      outcome: 'interrupted',
    })
    repo.recordNativeEffects(claudeAcceptedOnly.id, 'settled')

    // User-only accepted turn handed off to codex attributes cleanly to ['claude']!
    const codexRange1 = repo.handoffRange(sessionId, 'codex')
    const codexPage1 = repo.readHandoffPage(
      sessionId,
      'codex',
      codexRange1.afterSequence,
      codexRange1.throughSequence,
    )
    expect(codexPage1.messages.map((m) => m.content)).toEqual(['Accepted user prompt to claude'])
    const codexRunWithAcceptedUserRef = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Codex follow-up with accepted claude user ref',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
      handoffSourceRefs: codexPage1.messages.map((m) => ({
        id: m.messageId,
        revision: m.contentRevision,
        digest: m.digest,
      })),
    }).run
    expect(codexRunWithAcceptedUserRef.handoffMessageCount).toBe(1)
    expect(codexRunWithAcceptedUserRef.handoffSourceAgents).toEqual(['claude'])
    const codexTurnId = `${codexRunWithAcceptedUserRef.id}:turn`
    repo.applyEvent(sessionId, codexRunWithAcceptedUserRef.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: 'codex-handoff-sid',
    })
    repo.applyEvent(sessionId, codexRunWithAcceptedUserRef.id, {
      agentId: 'codex',
      type: 'turn.started',
      turnId: codexTurnId,
    })
    repo.applyEvent(sessionId, codexRunWithAcceptedUserRef.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId: codexTurnId,
      outputId: `${codexRunWithAcceptedUserRef.id}:out`,
      text: 'Codex completed.',
    })
    repo.applyEvent(sessionId, codexRunWithAcceptedUserRef.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: codexTurnId,
      outcome: 'completed',
    })
    repo.recordNativeEffects(codexRunWithAcceptedUserRef.id, 'settled')

    // 2. Unaccounted user message (not_sent failure -> nativeTurnId is null, no assistant reply)
    // mixed with accounted codex assistant message leaves handoffSourceAgents undefined (neutral UI fallback)!
    const unacceptedClaudeRun = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Unaccepted prompt before provider rejection',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
    }).run
    repo.recordDispatch(unacceptedClaudeRun.id, 'rejected')
    repo.recordNativeEffects(unacceptedClaudeRun.id, 'settled')
    repo.failRun(unacceptedClaudeRun.id, 'quota_or_rate_limit', 'Quota exceeded', false)

    sessions.saveSettings(sessionId, {
      ...sessions.find(sessionId)!.settings,
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
    })
    const agySession = sessions.find(sessionId)!
    const codexAssistantMsgId = repo.findRun(codexRunWithAcceptedUserRef.id)!.responseMessageId!
    const unacceptedMsgRev = db.drizzle
      .select({ contentRevision: conversationMessages.contentRevision })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, unacceptedClaudeRun.userMessageId))
      .get()!.contentRevision
    const codexAssistantMsgRev = db.drizzle
      .select({ contentRevision: conversationMessages.contentRevision })
      .from(conversationMessages)
      .where(eq(conversationMessages.id, codexAssistantMsgId))
      .get()!.contentRevision
    const agyRunWithUnaccountedRef = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Agy turn with mixed accounted + unaccounted refs',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: agySession.settingsRevision,
      model: null,
      effort: null,
      handoffSourceRefs: [
        {
          id: unacceptedClaudeRun.userMessageId,
          revision: unacceptedMsgRev,
          digest: 'a'.repeat(64),
        },
        {
          id: codexAssistantMsgId,
          revision: codexAssistantMsgRev,
          digest: 'b'.repeat(64),
        },
      ],
    }).run
    expect(agyRunWithUnaccountedRef.handoffMessageCount).toBe(2)
    expect(agyRunWithUnaccountedRef.handoffSourceAgents).toBeUndefined()
    expect(repo.findRun(agyRunWithUnaccountedRef.id)?.handoffSourceAgents).toBeUndefined()
  })

  it.each([
    'quota_or_rate_limit',
    'authentication_required',
    'permission_blocked',
    'runtime_incompatible',
  ] as const)(
    'allows immediate 3rd-agent replacement after settled %s rejection while blocking pending effects, possibly_sent, check action, and pending permissions',
    async (settledFailureKind) => {
      const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')
      runAndComplete(db, sessionId, 'codex', 'Initial codex turn', 'Initial codex answer')

      const failing = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: `Trigger ${settledFailureKind}`,
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: sessions.find(sessionId)!.settingsRevision,
        model: null,
        effort: null,
      }).run
      const codexSid = `codex-native-${sessionId.slice(0, 8)}`
      repo.recordDispatch(failing.id, 'rejected', codexSid)
      repo.recordNativeEffects(failing.id, 'settled')
      repo.failRun(
        failing.id,
        settledFailureKind,
        `Provider rejected: ${settledFailureKind}`,
        false,
      )
      repo.setContinuation(sessionId, 'codex', 'recovery_required', 'Provider rejected turn', 1, {
        kind: settledFailureKind,
        message: `Provider rejected: ${settledFailureKind}`,
        action: 'retry',
      })

      // Block if permissionRequestsJson is non-empty
      db.drizzle
        .update(nativeAgentContexts)
        .set({
          permissionRequestsJson: JSON.stringify([
            {
              id: 'perm-1',
              kind: 'command',
              title: 'Run command',
            },
          ]),
        })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, 'codex'),
          ),
        )
        .run()
      expect(() =>
        sessions.saveSettings(sessionId, {
          ...sessions.find(sessionId)!.settings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        }),
      ).toThrow(/pending approval, question, or recovery check/)
      db.drizzle
        .update(nativeAgentContexts)
        .set({ permissionRequestsJson: null })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, 'codex'),
          ),
        )
        .run()

      // Block if dispatchPhase is 'possibly_sent' (uncertain delivery)
      db.drizzle
        .update(agentRuns)
        .set({ dispatchPhase: 'possibly_sent', nativeOutcome: null })
        .where(eq(agentRuns.id, failing.id))
        .run()
      expect(() =>
        sessions.saveSettings(sessionId, {
          ...sessions.find(sessionId)!.settings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        }),
      ).toThrow(/background effects and turn status to settle/)
      db.drizzle
        .update(agentRuns)
        .set({ dispatchPhase: 'rejected' })
        .where(eq(agentRuns.id, failing.id))
        .run()

      // Block if recovery_action is 'check'
      db.drizzle.run(
        sql`UPDATE native_agent_contexts SET recovery_action = 'check' WHERE session_id = ${sessionId} AND agent_id = 'codex'`,
      )
      expect(() =>
        sessions.saveSettings(sessionId, {
          ...sessions.find(sessionId)!.settings,
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        }),
      ).toThrow(/pending approval, question, or recovery check/)
      db.drizzle
        .update(nativeAgentContexts)
        .set({ recoveryAction: 'retry' })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, 'codex'),
          ),
        )
        .run()

      // Settled quota/auth/provider rejection with recovery_required & recoveryAction !== 'check' ALLOWS immediate replacement!
      const swapped = sessions.saveSettings(sessionId, {
        ...sessions.find(sessionId)!.settings,
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      })
      expect(swapped.session.settings.secondaryAgentId).toBe('agy')
      expect(
        db.drizzle
          .select({ needsAttention: sessionsTable.needsAttention })
          .from(sessionsTable)
          .where(eq(sessionsTable.id, sessionId))
          .get()?.needsAttention,
      ).toBe(false)

      // Retired member's settled recovery_required MUST NOT block the new active pair from sending!
      expect(repo.nativeRecoveryBlocksInput(sessionId)).toBe(false)
      expect(nativeSessionIssueMetadata(db.drizzle, sessionId).issues.inputGate).toBe('open')
      const projectedAfterSwap = projectSessionIssues(
        sessionId,
        repo.nativeContexts(sessionId),
        (['claude', 'codex', 'agy'] as const).map((id) => repo.latestAgentRun(sessionId, id)),
        [],
        [],
        repo.rebuildOperations(sessionId),
        { activeAgents: ['claude', 'agy'] },
      )
      expect(projectedAfterSwap.inputGate).toBe('open')

      // New active pair sends and completes turns cleanly!
      const newPairAgyRun = runAndComplete(
        db,
        sessionId,
        'agy',
        'Send on new pair after settled retirement',
        'Agy reply on new pair',
      )
      expect(newPairAgyRun.status).toBe('completed')

      // Whereas unknown_delivery or check action on retired codex STILL blocks inputGate & nativeRecoveryBlocksInput!
      db.drizzle
        .update(nativeAgentContexts)
        .set({ recoveryFailureKind: 'unknown_delivery' })
        .where(
          and(
            eq(nativeAgentContexts.sessionId, sessionId),
            eq(nativeAgentContexts.agentId, 'codex'),
          ),
        )
        .run()
      expect(repo.nativeRecoveryBlocksInput(sessionId)).toBe(true)
      expect(nativeSessionIssueMetadata(db.drizzle, sessionId).issues.inputGate).not.toBe('open')
    },
  )

  it('preserves queued @all retry idempotency in receivedInputReceipt while rejecting genuine route or recipient changes', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'agy')
    const anchor = repo.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'In-flight anchor turn',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'claude',
      settingsRevision: sessions.find(sessionId)!.settingsRevision,
      model: null,
      effort: null,
    }).run

    // Case A: Queued with explicit route: { type: 'all' }
    const ownerKeyA = randomUUID()
    const messageIdA = randomUUID()
    const textA = 'Broadcast via route object'
    const bodyA = repo.writeConversationInput(
      { type: 'begin', sessionId, clientMessageId: messageIdA },
      ownerKeyA,
    )
    repo.writeConversationInput(
      { type: 'append', sessionId, inputId: bodyA.inputId, offset: 0, text: textA },
      ownerKeyA,
    )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: bodyA.inputId }, ownerKeyA)
    const sendA: ConversationSendInput = {
      sessionId,
      clientMessageId: messageIdA,
      content: '',
      inputId: bodyA.inputId,
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      route: { type: 'all' },
    }
    repo.receiveQueuedInput(sendA, bodyA.inputId, 'claude', ownerKeyA, anchor.id, true)

    // Idempotent retry via receivedInputReceipt and receiveQueuedInput with { type: 'all' } succeeds!
    expect(repo.receivedInputReceipt(sessionId, messageIdA, sendA, true)?.receivedInputIds).toEqual(
      [messageIdA],
    )
    expect(
      repo.receiveQueuedInput(sendA, bodyA.inputId, 'claude', ownerKeyA, anchor.id, true)
        .receivedInputIds,
    ).toEqual([messageIdA])

    // Reject genuine route/recipient changes on retry!
    expect(() =>
      repo.receivedInputReceipt(sessionId, messageIdA, {
        ...sendA,
        route: { type: 'agent', agentId: 'claude' },
      }),
    ).toThrow(/different input/)
    expect(() =>
      repo.receivedInputReceipt(sessionId, messageIdA, {
        ...sendA,
        route: undefined,
      }),
    ).toThrow(/different input/)
    expect(() =>
      repo.receiveQueuedInput(sendA, bodyA.inputId, 'agy', ownerKeyA, anchor.id, true),
    ).toThrow(/different input/)

    // Remove A and test Case B: public IPC sealed-body shape (inputId + content: '', no structured route)
    // where sealed multi-part body starts with '@all '
    repo.removeQueuedConversationMessage({
      sessionId,
      inputId: messageIdA,
      operationId: randomUUID(),
      expectedRevision: repo.queueState(sessionId).revision,
    })

    const ownerKeyB = randomUUID()
    const messageIdB = randomUUID()
    const partB0 = '@a'
    const partB1 = 'll inspect all active pair targets'
    const bodyB = repo.writeConversationInput(
      { type: 'begin', sessionId, clientMessageId: messageIdB },
      ownerKeyB,
    )
    repo.writeConversationInput(
      { type: 'append', sessionId, inputId: bodyB.inputId, offset: 0, text: partB0 },
      ownerKeyB,
    )
    repo.writeConversationInput(
      {
        type: 'append',
        sessionId,
        inputId: bodyB.inputId,
        offset: partB0.length,
        text: partB1,
      },
      ownerKeyB,
    )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: bodyB.inputId }, ownerKeyB)
    const sendB: ConversationSendInput = {
      sessionId,
      clientMessageId: messageIdB,
      content: '',
      inputId: bodyB.inputId,
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
    }
    repo.receiveQueuedInput(sendB, bodyB.inputId, 'claude', ownerKeyB, anchor.id, true)

    const queuedSourceB = repo.readQueuedInputSource({
      scope: 'queued-input',
      source: 'queued',
      sessionId,
      inputId: messageIdB,
      offset: 0,
    })
    expect(queuedSourceB.route).toEqual({
      type: 'all',
      firstAgentId: 'claude',
      secondAgentId: 'agy',
    })

    // Idempotent retry with exact public IPC sealed-body shape (inputId + content: '', route: undefined)
    // AND with { type: 'all' } both match!
    expect(repo.receivedInputReceipt(sessionId, messageIdB, sendB, true)?.receivedInputIds).toEqual(
      [messageIdB],
    )
    expect(
      repo.receiveQueuedInput(sendB, bodyB.inputId, 'claude', ownerKeyB, anchor.id, true)
        .receivedInputIds,
    ).toEqual([messageIdB])
    expect(
      repo.receivedInputReceipt(sessionId, messageIdB, { ...sendB, route: { type: 'all' } }, true)
        ?.receivedInputIds,
    ).toEqual([messageIdB])
    // Conflicting single-agent route is rejected
    expect(() =>
      repo.receivedInputReceipt(sessionId, messageIdB, {
        ...sendB,
        route: { type: 'agent', agentId: 'agy' },
      }),
    ).toThrow(/different input/)
  })

  it.each(['claude', 'codex'] as const)(
    'reads legacy 0106 @all returned-input routes from historical %s actor without throwing or mutating recipients after swapping in agy',
    async (legacyActor) => {
      const { db, repo, sessions, sessionId } = await createFixture('claude', 'codex')
      const anchor = repo.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Legacy anchor turn',
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
        agentId: 'claude',
        settingsRevision: sessions.find(sessionId)!.settingsRevision,
        model: null,
        effort: null,
      }).run

      const queuedId = enqueueInput(
        db,
        sessionId,
        anchor.id,
        legacyActor,
        '@all legacy 0106 item',
        {
          route: { type: 'all' },
        },
      )
      // Simulate pre-0107 (0106) metadataJson where route was stored as bare { type: 'all' } without firstAgentId/secondAgentId
      const storedRow = db.drizzle
        .select()
        .from(collaborationInputs)
        .where(eq(collaborationInputs.id, queuedId))
        .get()!
      const parsedMeta: unknown = JSON.parse(storedRow.metadataJson)
      if (typeof parsedMeta !== 'object' || parsedMeta === null) {
        throw new Error('Expected stored metadata object')
      }
      db.drizzle
        .update(collaborationInputs)
        .set({ metadataJson: JSON.stringify({ ...parsedMeta, route: { type: 'all' } }) })
        .where(eq(collaborationInputs.id, queuedId))
        .run()

      // Return the queued message and settle anchor run so active pair can be swapped to include agy
      const returnOpId = randomUUID()
      repo.returnQueuedConversationMessage({
        sessionId,
        inputId: queuedId,
        operationId: returnOpId,
        expectedRevision: repo.queueState(sessionId).revision,
        phase: 'return',
      })
      const turnId = `${anchor.id}:turn`
      repo.applyEvent(sessionId, anchor.id, {
        agentId: 'claude',
        type: 'session.started',
        nativeSessionId: 'claude-legacy-sid',
      })
      repo.applyEvent(sessionId, anchor.id, { agentId: 'claude', type: 'turn.started', turnId })
      repo.applyEvent(sessionId, anchor.id, {
        agentId: 'claude',
        type: 'text.completed',
        turnId,
        outputId: 'out-1',
        text: 'Done.',
      })
      repo.applyEvent(sessionId, anchor.id, {
        agentId: 'claude',
        type: 'turn.completed',
        turnId,
        outcome: 'completed',
      })
      repo.recordNativeEffects(anchor.id, 'settled')

      // Swap out legacyActor AND swap in agy (e.g. legacyActor='claude' -> new pair ('codex', 'agy'))!
      const remainingLegacy = legacyActor === 'claude' ? 'codex' : 'claude'
      sessions.saveSettings(sessionId, {
        ...sessions.find(sessionId)!.settings,
        primaryAgentId: remainingLegacy,
        secondaryAgentId: 'agy',
      })

      const page = repo.readPage({
        scope: 'queued-input',
        source: 'returned',
        sessionId,
        inputId: queuedId,
        operationId: returnOpId,
        offset: 0,
      })
      if (page.scope !== 'queued-input') {
        throw new Error('Expected queued-input page')
      }
      expect(page.route).toEqual({
        type: 'all',
        firstAgentId: legacyActor,
        secondAgentId: remainingLegacy,
      })
    },
  )

  it('formats Open Mode Relay decisionInput objective dynamically from supplied active-pair candidates', async () => {
    const { db, repo, sessions, sessionId } = await createFixture('claude', 'agy')
    const session = sessions.find(sessionId)!
    const roles = defaultTaskStageRoles('claude', 'agy')
    const taskId = randomUUID()
    const msgId = randomUUID()

    const started = repo.beginRun({
      sessionId,
      clientMessageId: msgId,
      content: '/build implement feature with agy',
      expectedCommentsRevision: draftRevision(db, sessionId),
      commentIds: [],
      agentId: 'agy',
      settingsRevision: session.settingsRevision,
      model: null,
      effort: null,
      collaboration: collaborationTaskSchema.parse({
        protocol: 'native-workflow-v1',
        id: taskId,
        sessionId,
        kind: 'build',
        revision: 0,
        owner: 'claude',
        reviewer: 'agy',
        rolePolicy: 'split-stages-v1',
        stageRoles: roles,
        task: 'implement feature with agy',
        taskMessageId: msgId,
        stage: 'implement',
        actor: 'agy',
        status: 'running',
        automation: 'active',
        runId: randomUUID(),
        inputSequence: 0,
        handledInputSequence: 0,
        planVersion: 0,
        discussionRounds: 0,
        reviewCycles: 0,
        repairAttempts: 0,
        openMode: true,
      }),
    }).run

    const ownerKey = randomUUID()
    const followUpId = randomUUID()
    const body = repo.writeConversationInput(
      { type: 'begin', sessionId, clientMessageId: followUpId },
      ownerKey,
    )
    repo.writeConversationInput(
      {
        type: 'append',
        sessionId,
        inputId: body.inputId,
        offset: 0,
        text: 'Please review and refine the implementation',
      },
      ownerKey,
    )
    repo.writeConversationInput({ type: 'seal', sessionId, inputId: body.inputId }, ownerKey)
    repo.receiveQueuedInput(
      {
        sessionId,
        clientMessageId: followUpId,
        content: 'Please review and refine the implementation',
        inputId: body.inputId,
        expectedCommentsRevision: draftRevision(db, sessionId),
        commentIds: [],
      },
      body.inputId,
      'agy',
      ownerKey,
      started.id,
      true,
    )

    const currentTask = repo.collaboration(sessionId)!
    const routing = await repo.readOpenModeRoutingSources(
      sessionId,
      currentTask,
      followUpId,
      [
        { id: 'route_claude', description: 'Route to Claude Code.' },
        { id: 'route_agy', description: 'Route to Antigravity.' },
      ],
      { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 },
    )
    expect(routing.input.objective).toContain(
      'Select one supplied recipient (route_claude or route_agy)',
    )
    expect(routing.input.objective).not.toContain('route_codex')
  })
})
