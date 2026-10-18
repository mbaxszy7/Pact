import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  CONVERSATION_PAGE_ITEMS,
  CONVERSATION_PAGE_BYTES,
  CONVERSATION_PATCH_BYTES,
  CONVERSATION_PATCH_TEXT_BYTES,
} from '@pact/contracts'

import { DEFAULT_APPEARANCE_SETTINGS, PactDatabase, pactSchemaMeta } from './index.js'
import { seedHistoricalAnswerAttempt } from './legacy-database.test-support.js'
import { conversationMessages } from './schema/index.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-persistence-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe('Pact database migrations', () => {
  it('applies all migrations to a fresh database', async () => {
    const database = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
    })

    await database.drizzle.insert(pactSchemaMeta).values({ key: 'status', value: 'ready' })
    const row = await database.drizzle.query.pactSchemaMeta.findFirst({
      where: eq(pactSchemaMeta.key, 'status'),
    })

    expect(row).toEqual({ key: 'status', value: 'ready' })
    database.close()
  })

  it('backs up and upgrades an existing version-zero database without losing data', async () => {
    const directory = await createTemporaryDirectory()
    const databaseFile = join(directory, 'pact.sqlite')
    const backupFile = join(directory, 'pact.before-migrate.sqlite')
    const legacy = new Database(databaseFile)
    const initial = readMigrationFiles({ migrationsFolder })[0]!
    legacy.exec(
      'CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY NOT NULL, hash TEXT NOT NULL, created_at NUMERIC)',
    )
    for (const statement of initial.sql) legacy.exec(statement)
    legacy
      .prepare('INSERT INTO pact_schema_meta (key, value) VALUES (?, ?)')
      .run('status', 'preserve-me')
    legacy
      .prepare('INSERT INTO __drizzle_migrations (id, hash, created_at) VALUES (?, ?, ?)')
      .run(1, initial.hash, initial.folderMillis)
    legacy.close()

    const database = await PactDatabase.open({
      filePath: databaseFile,
      migrationsFolder,
      backupFilePath: backupFile,
    })

    const upgraded = new Database(databaseFile, { readonly: true })
    const preserved = upgraded
      .prepare('SELECT value FROM pact_schema_meta WHERE key = ?')
      .get('status')
    const appearance = upgraded
      .prepare(
        'SELECT theme, window_material AS windowMaterial, material_opacity AS materialOpacity, revision FROM appearance_settings WHERE id = 1',
      )
      .get()
    upgraded.close()

    const backup = new Database(backupFile, { readonly: true })
    const backupPreserved = backup
      .prepare('SELECT value FROM pact_schema_meta WHERE key = ?')
      .get('status')
    const backupHasAppearanceSettings = backup
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appearance_settings'",
      )
      .get()
    backup.close()

    expect(preserved).toEqual({ value: 'preserve-me' })
    expect(appearance).toEqual({ ...DEFAULT_APPEARANCE_SETTINGS, revision: 0 })
    expect(backupPreserved).toEqual({ value: 'preserve-me' })
    expect(backupHasAppearanceSettings).toBeUndefined()
    database.close()
  })

  it('updates and resets the singleton with an atomic revision compare', async () => {
    const database = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
    })

    expect(database.appearanceSettingsRepository.read()).toEqual({
      ...DEFAULT_APPEARANCE_SETTINGS,
      revision: 0,
    })

    expect(
      database.appearanceSettingsRepository.update({
        expectedRevision: 0,
        theme: 'dark',
        materialOpacity: 92,
      }),
    ).toEqual({
      status: 'updated',
      settings: {
        theme: 'dark',
        windowMaterial: 'system',
        materialOpacity: 92,
        revision: 1,
      },
    })
    expect(
      database.appearanceSettingsRepository.update({
        expectedRevision: 0,
        windowMaterial: 'solid',
      }),
    ).toEqual({
      status: 'conflict',
      currentRevision: 1,
    })
    expect(database.appearanceSettingsRepository.reset({ expectedRevision: 1 })).toEqual({
      status: 'updated',
      settings: { ...DEFAULT_APPEARANCE_SETTINGS, revision: 2 },
    })
    database.close()
  })

  it('persists selected CLI paths without completing first-use setup', async () => {
    const directory = await createTemporaryDirectory()
    const databaseFile = join(directory, 'pact.sqlite')
    let database = await PactDatabase.open({ filePath: databaseFile, migrationsFolder })

    expect(database.runtimePreparationRepository.hasCompletedFirstUseSetup()).toBe(false)
    expect(
      database.runtimePreparationRepository.readSelectedExecutablePath('claude'),
    ).toBeUndefined()
    database.runtimePreparationRepository.saveSelectedExecutablePath(
      'claude',
      '/opt/pact-test/claude',
    )
    database.close()

    database = await PactDatabase.open({ filePath: databaseFile, migrationsFolder })
    expect(database.runtimePreparationRepository.readSelectedExecutablePath('claude')).toBe(
      '/opt/pact-test/claude',
    )
    expect(database.runtimePreparationRepository.hasCompletedFirstUseSetup()).toBe(false)
    database.close()
  })

  it('keeps Project paths unique and archives without deleting the Project', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const directoryPath = '/opt/pact-test/sample-project'
    const project = {
      id: randomUUID(),
      name: 'sample-project',
      directoryPath,
      kind: 'git' as const,
      createdAt: new Date().toISOString(),
    }

    expect(database.projectCatalogRepository.add(project).projects).toEqual([project])
    expect(
      database.projectCatalogRepository.add({ ...project, id: randomUUID() }).projects,
    ).toEqual([project])
    expect(database.projectCatalogRepository.archive(project.id)).toEqual({ projects: [] })
    expect(database.projectCatalogRepository.find(project.id)).toMatchObject({
      ...project,
      archivedAt: expect.any(String),
    })
    expect(database.projectCatalogRepository.restore(project.id)).toEqual({ projects: [project] })
    expect(database.projectCatalogRepository.archive(project.id)).toEqual({ projects: [] })
    expect(
      database.projectCatalogRepository.add({ ...project, id: randomUUID() }).projects,
    ).toEqual([project])

    database.close()
  })

  it('persists Session settings revisions across Archive and restore', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const project = {
      id: randomUUID(),
      name: 'sample-project',
      directoryPath: '/opt/pact-test/sample-project',
      kind: 'git' as const,
      createdAt: new Date().toISOString(),
    }
    const sessionId = randomUUID()
    const settings = {
      primaryAgentId: 'codex' as const,
      agents: {
        claude: { model: null, effort: null },
        codex: { model: null, effort: null },
      },
      maxDiscussionRounds: 6,
      runningMessagePolicy: 'immediate_safe_point' as const,
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    }
    database.projectCatalogRepository.add(project)

    expect(
      database.sessionRepository.create(
        {
          id: sessionId,
          projectId: project.id,
          title: 'New session',
          createdAt: project.createdAt,
        },
        settings,
      ).session,
    ).toEqual({
      id: sessionId,
      projectId: project.id,
      title: 'New session',
      titleSource: 'placeholder',
      status: 'draft',
      activity: { state: 'idle' },
      hasUnread: false,
      settings: {
        ...settings,
        agents: {
          claude: { ...settings.agents.claude, speed: 'native' },
          codex: { ...settings.agents.codex, speed: 'native' },
        },
        permissionModes: { claude: 'ask', codex: 'native' },
      },
      settingsRevision: 1,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    })

    const updatedSettings = { ...settings, maxDiscussionRounds: 4 }
    expect(database.sessionRepository.saveSettings(sessionId, updatedSettings)).toMatchObject({
      session: { id: sessionId, settings: updatedSettings, settingsRevision: 2 },
    })

    expect(database.sessionRepository.archive(sessionId).session).toMatchObject({
      id: sessionId,
      status: 'archived',
      archivedAt: expect.any(String),
      settings: updatedSettings,
      settingsRevision: 2,
    })
    expect(database.sessionRepository.restore(sessionId).session).toMatchObject({
      id: sessionId,
      status: 'draft',
      settings: updatedSettings,
      settingsRevision: 2,
    })

    database.close()
  })
})

describe('ConversationRepository', () => {
  it('accepts an empty first streaming delta without crashing the Utility path', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const started = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Start an answer.',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })

    expect(() =>
      database.conversationRepository.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'text.delta',
        turnId: 'empty-delta-turn',
        outputId: 'empty-delta-output',
        text: '',
      }),
    ).not.toThrow()
    database.close()
  })

  it('emits bounded ordered Patches without complete Session reads on the streaming path', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const started = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Stream a bounded answer.',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    const first = database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'turn-patch',
      outputId: 'output-patch',
      text: 'First ',
    })
    const second = database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'turn-patch',
      outputId: 'output-patch',
      text: 'second',
    })
    const steadyPatches = Array.from({ length: 100 }, (_, index) =>
      database.conversationRepository.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'text.delta',
        turnId: 'turn-patch',
        outputId: 'output-patch',
        text: `-${index}`,
      }),
    )
    const oversizedDelta = database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.delta',
      turnId: 'turn-patch',
      outputId: 'output-patch',
      text: 'x'.repeat(CONVERSATION_PATCH_TEXT_BYTES + 1),
    })
    const textCompleted = database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'text.completed',
      turnId: 'turn-patch',
      outputId: 'output-patch',
      text: 'First second',
    })
    const completed = database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'turn-patch',
      outcome: 'completed',
    })

    expect(first.messages).toMatchObject([{ mode: 'replace', text: 'First ' }])
    expect(second.messages).toMatchObject([{ mode: 'append', text: 'second', previousRevision: 0 }])
    expect(
      Math.max(...steadyPatches.map((patch) => Buffer.byteLength(JSON.stringify(patch), 'utf8'))),
    ).toBeLessThanOrEqual(CONVERSATION_PATCH_TEXT_BYTES)
    expect(steadyPatches[0]?.observation.sequence).toBe(second.observation.sequence + 1)
    expect(steadyPatches.at(-1)?.observation.sequence).toBe(
      second.observation.sequence + steadyPatches.length,
    )
    expect(oversizedDelta.messages).toMatchObject([{ mode: 'advance', previousRevision: 101 }])
    expect(completed.messages).toMatchObject([{ mode: 'metadata', message: { state: 'complete' } }])
    expect(textCompleted.messages).toMatchObject([{ mode: 'replace', text: 'First second' }])
    for (const patch of [
      started.patch,
      first,
      second,
      ...steadyPatches,
      oversizedDelta,
      textCompleted,
      completed,
    ]) {
      expect(Buffer.byteLength(JSON.stringify(patch), 'utf8')).toBeLessThanOrEqual(
        CONVERSATION_PATCH_BYTES,
      )
    }
    expect(database.conversationRepository.diagnostics()).toEqual({
      completeReads: 0,
      pageReads: 0,
      patches: 106,
      observedSessions: 1,
      eventTransactions: 105,
      streamLookups: {
        text: { queries: 104, returnedRows: 103 },
        activity: { queries: 0, returnedRows: 0 },
      },
    })

    const plan = database.drizzle.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM conversation_messages
      WHERE run_id = ${started.run.id} AND role = 'assistant'
      LIMIT 1
    `)
    expect(plan.some((row) => row.detail.includes('conversation_messages_run_role_idx'))).toBe(true)
    expect(plan.some((row) => row.detail.includes('SCAN conversation_messages'))).toBe(false)
    database.close()
  })

  it('uses the sent-Message index for bounded Comment pages', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const commentId = randomUUID()
    const messageId = randomUUID()
    database.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId,
      expectedCommentsRevision: 0,
      body: 'Indexed Comment',
      anchor: messageAnchor(randomUUID(), 'Indexed quote'),
    })
    database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: messageId,
      content: 'Send the indexed Comment.',
      expectedCommentsRevision: 1,
      commentIds: [commentId],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })

    expect(
      database.conversationRepository.readPage({
        scope: 'comments',
        sessionId,
        messageIds: [messageId],
      }),
    ).toMatchObject({
      scope: 'comments',
      comments: [{ id: commentId, sentWithMessageId: messageId }],
      hasMore: false,
    })
    const plan = database.drizzle.all<{ detail: string }>(sql`
      EXPLAIN QUERY PLAN
      SELECT id, position
      FROM anchored_comments
      WHERE session_id = ${sessionId}
        AND sent_with_message_id IN (${messageId})
      ORDER BY position ASC
      LIMIT 26
    `)
    expect(
      plan.some((row) => row.detail.includes('anchored_comments_sent_message_position_idx')),
    ).toBe(true)
    expect(plan.some((row) => row.detail.includes('SCAN anchored_comments'))).toBe(false)

    database.close()
  })

  it('persists every draft beyond one bounded projection page', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const { sessionId } = createConversationSession(database)
      const expected: string[] = []
      for (let index = 0; index < 30; index++) {
        const id = randomUUID()
        expected.push(id)
        database.conversationRepository.saveCommentDraft({
          mode: 'create',
          sessionId,
          commentId: id,
          expectedCommentsRevision: index,
          body: `Comment ${index + 1}`,
          anchor: messageAnchor(randomUUID(), `Quote ${index + 1}`),
        })
      }
      const first = database.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (first.scope !== 'drafts') throw new Error('Missing drafts')
      expect(first.commentsRevision).toBe(30)
      expect(first.comments.length).toBeLessThanOrEqual(CONVERSATION_PAGE_ITEMS)
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES)
      const ids = first.comments.map((comment) => comment.id)
      let afterPosition = first.hasMore ? first.comments.at(-1)?.position : undefined
      while (afterPosition !== undefined) {
        const next = database.conversationRepository.readPage({
          scope: 'drafts',
          sessionId,
          afterPosition,
          expectedRevision: 30,
        })
        if (next.scope !== 'drafts') throw new Error('Missing next drafts')
        expect(next.comments.length).toBeLessThanOrEqual(CONVERSATION_PAGE_ITEMS)
        expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(CONVERSATION_PAGE_BYTES)
        ids.push(...next.comments.map((comment) => comment.id))
        afterPosition = next.hasMore ? next.comments.at(-1)?.position : undefined
      }
      expect(ids).toEqual(expected)
    } finally {
      database.close()
    }
  })

  it('uses the Comment draft revision as a compare-and-swap token', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const commentId = randomUUID()

    const saved = database.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId,
      expectedCommentsRevision: 0,
      body: 'Please verify this claim.',
      anchor: messageAnchor(randomUUID(), 'Visible claim'),
    })

    expect(saved.comments).toMatchObject({
      revision: 1,
      upserts: [{ id: commentId, status: 'draft', position: 0 }],
    })
    expect(() =>
      database.conversationRepository.saveCommentDraft({
        mode: 'edit',
        sessionId,
        commentId,
        expectedCommentsRevision: 0,
        body: 'A stale editor must not overwrite this Comment.',
      }),
    ).toThrow('Comment drafts changed')
    expect(database.conversationRepository.read(sessionId)).toMatchObject({
      commentsRevision: 1,
      comments: [{ id: commentId, body: 'Please verify this claim.', status: 'draft' }],
    })

    database.close()
  })

  it('atomically sends every draft Comment with one idempotent Message and model snapshot', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const firstCommentId = randomUUID()
    const secondCommentId = randomUUID()
    const messageId = randomUUID()
    database.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId: firstCommentId,
      expectedCommentsRevision: 0,
      body: 'Check the premise.',
      anchor: messageAnchor(randomUUID(), 'premise'),
    })
    database.conversationRepository.saveCommentDraft({
      mode: 'create',
      sessionId,
      commentId: secondCommentId,
      expectedCommentsRevision: 1,
      body: 'Check the conclusion.',
      anchor: messageAnchor(randomUUID(), 'conclusion'),
    })
    const input = {
      sessionId,
      clientMessageId: messageId,
      content: 'Does the conclusion follow?',
      expectedCommentsRevision: 2,
      commentIds: [firstCommentId, secondCommentId],
      agentId: 'codex' as const,
      settingsRevision: 1,
      model: 'gpt-5.6-sol',
      effort: 'high',
      suggestedTitle: 'Conclusion review',
    }

    expect(() =>
      database.conversationRepository.beginRun({ ...input, expectedCommentsRevision: 1 }),
    ).toThrow('Comment drafts changed')
    expect(database.conversationRepository.read(sessionId)).toMatchObject({
      messages: [],
      runs: [],
      comments: [
        { id: firstCommentId, status: 'draft' },
        { id: secondCommentId, status: 'draft' },
      ],
    })

    const created = database.conversationRepository.beginRun(input)
    expect(created.created).toBe(true)
    expect(created.run).toMatchObject({
      userMessageId: messageId,
      agentId: 'codex',
      status: 'starting',
      model: 'gpt-5.6-sol',
      effort: 'high',
    })
    expect(database.conversationRepository.read(sessionId)).toMatchObject({
      session: { status: 'discussing', title: 'Conclusion review', titleSource: 'local' },
      messages: [{ id: messageId, content: input.content, role: 'user', state: 'complete' }],
      comments: [
        { id: firstCommentId, status: 'sent', sentWithMessageId: messageId },
        { id: secondCommentId, status: 'sent', sentWithMessageId: messageId },
      ],
      runs: [
        {
          id: created.run.id,
          userMessageId: messageId,
          model: 'gpt-5.6-sol',
          effort: 'high',
        },
      ],
    })

    const retriedDelivery = database.conversationRepository.beginRun(input)
    expect(retriedDelivery).toMatchObject({ created: false, run: { id: created.run.id } })
    expect(() =>
      database.conversationRepository.beginRun({ ...input, content: 'Different content.' }),
    ).toThrow('already associated with different content')

    database.conversationRepository.applyEvent(sessionId, created.run.id, {
      agentId: 'codex',
      type: 'run.model.resolved',
      model: 'gpt-5.6-sol-actual',
    })
    expect(database.conversationRepository.findRun(created.run.id)).toMatchObject({
      model: 'gpt-5.6-sol-actual',
      effort: 'high',
    })
    database.conversationRepository.failRun(
      created.run.id,
      'transient_transport',
      'A retryable transport error.',
    )
    const retry = seedHistoricalAnswerAttempt(database, created.run.id)
    expect(retry).toMatchObject({
      run: { model: 'gpt-5.6-sol-actual', effort: 'high', status: 'starting' },
      message: { id: messageId, content: input.content },
      comments: [
        { id: firstCommentId, status: 'sent' },
        { id: secondCommentId, status: 'sent' },
      ],
    })

    database.close()
  })

  it('does not let late title enrichment overwrite a newer Run generation', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const first = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'First question',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      suggestedTitle: 'First question',
    })
    database.conversationRepository.applyEvent(sessionId, first.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 'turn-1',
      outcome: 'completed',
    })
    const second = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Second question',
      expectedCommentsRevision: first.patch.comments?.revision ?? 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
      suggestedTitle: 'Second question',
    })

    database.conversationRepository.applyEvent(sessionId, first.run.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: 'Stale title',
    })
    expect(database.conversationRepository.read(sessionId).session.title).toBe('Second question')

    database.conversationRepository.applyEvent(sessionId, second.run.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: 'Current title',
    })
    expect(database.conversationRepository.read(sessionId).session.title).toBe('Current title')
    database.close()
  })

  it('preserves unknown-delivery reconciliation across restart without creating a retry Run', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    const { sessionId } = createConversationSession(database)
    const started = database.conversationRepository.beginRun({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Was this delivered?',
      expectedCommentsRevision: 0,
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    database.conversationRepository.applyEvent(sessionId, started.run.id, {
      agentId: 'codex',
      type: 'session.started',
      nativeSessionId: 'thread-recovery',
    })
    database.conversationRepository.failRun(
      started.run.id,
      'unknown_delivery',
      'Delivery is unknown.',
    )

    database.conversationRepository.recordDispatch(
      started.run.id,
      'possibly_sent',
      'thread-recovery',
    )
    expect(
      database.conversationRepository.setContinuation(sessionId, 'codex', 'checking'),
    ).toMatchObject({
      nativeContexts: [{ continuationState: 'checking' }],
    })
    expect(database.conversationRepository.findRun(started.run.id)).toMatchObject({
      status: 'failed',
    })
    database.conversationRepository.recoverInterruptedRuns()
    expect(database.conversationRepository.read(sessionId)).toMatchObject({
      runs: [
        {
          id: started.run.id,
          status: 'failed',
          failureKind: 'unknown_delivery',
        },
      ],
    })
    expect(database.conversationRepository.read(sessionId).runs).toHaveLength(1)
    database.conversationRepository.recordNativeEvidence({
      kind: 'ended',
      source: 'stored_terminal',
      outcome: 'completed',
      identity: {
        sessionId,
        agentId: 'codex',
        bindingGeneration: 1,
        runId: started.run.id,
        requestId: started.run.id,
        nativeSessionId: 'thread-recovery',
        nativeTurnId: 'turn-recovered',
      },
    })
    database.conversationRepository.recordNativeOutput(started.run.id, {
      outputId: 'message-recovered',
      text: 'Recovered response',
      completeness: 'complete',
    })
    database.conversationRepository.settleKnownNativeEnding(started.run.id)
    expect(database.conversationRepository.findRun(started.run.id)).toEqual(
      expect.objectContaining({
        status: 'completed',
        nativeTurnId: 'turn-recovered',
      }),
    )
    expect(database.conversationRepository.findRun(started.run.id)).not.toHaveProperty(
      'failureKind',
    )
    database.close()
  })
})

describe('Bounded original native rebuild source', () => {
  it('publishes a replacement when tool completion clears its durable detail', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const { sessionId } = createConversationSession(database)
      const started = database.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Run tool',
        expectedCommentsRevision: 0,
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      database.conversationRepository.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'tool.started',
        turnId: 'tool-turn',
        toolCallId: 'tool',
        title: 'Tool',
        toolName: 'test',
        detail: 'Old detail',
      })
      const patch = database.conversationRepository.applyEvent(sessionId, started.run.id, {
        agentId: 'codex',
        type: 'tool.completed',
        turnId: 'tool-turn',
        toolCallId: 'tool',
        title: 'Tool',
        toolName: 'test',
        outcome: 'completed',
      })
      expect(patch.activities[0]).toMatchObject({ mode: 'replace', detail: '' })
      const page = database.conversationRepository.readPage({
        scope: 'activities',
        sessionId,
        runId: started.run.id,
      })
      if (page.scope !== 'activities') throw new Error('Unexpected Activity page')
      expect(page.activities[0]?.activity).not.toHaveProperty('detail')
    } finally {
      database.close()
    }
  })
  it('streams every original Message and batched sent Comment without a full Session read', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const { sessionId } = createConversationSession(database)
      const createdAt = new Date().toISOString()
      const rows = Array.from({ length: 999 }, (_, sequence) => ({
        id: randomUUID(),
        sessionId,
        role: 'user' as const,
        content: `Original ${sequence}`,
        state: 'complete' as const,
        sequence,
        createdAt,
        updatedAt: createdAt,
      }))
      database.drizzle.transaction((transaction) => {
        for (let offset = 0; offset < rows.length; offset += 50) {
          transaction
            .insert(conversationMessages)
            .values(rows.slice(offset, offset + 50))
            .run()
        }
      })
      const commentId = randomUUID()
      database.conversationRepository.saveCommentDraft({
        mode: 'create',
        sessionId,
        commentId,
        expectedCommentsRevision: 0,
        body: 'Whole original Comment',
        anchor: messageAnchor(rows[998]!.id, 'Original'),
      })
      const started = database.conversationRepository.beginRun({
        sessionId,
        clientMessageId: randomUUID(),
        content: 'Original 999',
        expectedCommentsRevision: 1,
        commentIds: [commentId],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      const before = database.conversationRepository.diagnostics().completeReads
      const context = []
      for await (const chunk of database.conversationRepository.nativeContextRebuildSource(
        sessionId,
        new AbortController().signal,
      ))
        context.push(chunk)
      expect(
        new Set(context.filter((chunk) => chunk.kind === 'message').map((chunk) => chunk.messageId))
          .size,
      ).toBe(1000)
      expect(context.filter((chunk) => chunk.kind === 'message')).toHaveLength(1001)
      expect(context[0]).toMatchObject({ content: 'Original 0' })
      expect(context.at(-2)).toMatchObject({ content: 'Original 999' })
      expect(context.at(-1)).toMatchObject({ messageId: started.run.userMessageId, final: true })
      expect(context.at(-1)).toHaveProperty(
        'content',
        expect.stringContaining(
          database.conversationRepository.inputBatchForRun(started.run.id)!.id,
        ),
      )
      expect(context.filter((chunk) => chunk.kind === 'comment')).toEqual([])
      const batch = database.conversationRepository.readFrozenInputBatch(
        started.run.id,
        database.conversationRepository.inputBatchForRun(started.run.id)!.id,
      )
      expect(batch.members).toMatchObject([{ commentId }])
      expect(
        database.conversationRepository.readPage({
          scope: 'collaboration-text',
          sessionId,
          runId: started.run.id,
          document: batch.members[0]!.body,
          offset: 0,
        }),
      ).toMatchObject({ text: 'Whole original Comment' })
      expect(context.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) <= 32 * 1024)).toBe(
        true,
      )
      expect(database.conversationRepository.diagnostics().completeReads).toBe(before)
    } finally {
      database.close()
    }
  })

  it('segments large original UTF-8 text without dropping history and supports cancellation', async () => {
    const database = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      const { sessionId } = createConversationSession(database)
      const createdAt = new Date().toISOString()
      const id = randomUUID()
      const original = '段落\n\n'.repeat(3_000)
      const latestMessageId = randomUUID()
      database.drizzle
        .insert(conversationMessages)
        .values({
          id,
          sessionId,
          role: 'assistant',
          agentId: 'codex',
          content: original,
          state: 'complete',
          sequence: 0,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      database.drizzle
        .insert(conversationMessages)
        .values({
          id: latestMessageId,
          sessionId,
          role: 'user',
          content: 'Retry',
          state: 'complete',
          sequence: 1,
          createdAt,
          updatedAt: createdAt,
        })
        .run()
      const read = async () => {
        const chunks = []
        for await (const chunk of database.conversationRepository.nativeContextRebuildSource(
          sessionId,
          new AbortController().signal,
        ))
          if (chunk.kind === 'message' && chunk.messageId === id) chunks.push(chunk)
        return chunks
      }
      expect((await read()).map((chunk) => chunk.content).join('')).toBe(original)
      database.drizzle
        .update(conversationMessages)
        .set({ content: '字'.repeat(100_000) })
        .where(eq(conversationMessages.id, id))
        .run()
      const large = await read()
      expect(large.map((chunk) => chunk.content).join('')).toBe('字'.repeat(100_000))
      expect(large.length).toBeGreaterThan(1)
      expect(large.every((chunk) => chunk.content.length <= 64 * 1024)).toBe(true)
      expect(large.every((chunk) => Buffer.byteLength(JSON.stringify(chunk)) <= 256 * 1024)).toBe(
        true,
      )
      const abort = new AbortController()
      abort.abort()
      const source = database.conversationRepository.nativeContextRebuildSource(
        sessionId,
        abort.signal,
      )
      await expect(source[Symbol.asyncIterator]().next()).rejects.toThrow('cancelled')
    } finally {
      database.close()
    }
  })
})

function createConversationSession(database: PactDatabase): { sessionId: string } {
  const projectId = randomUUID()
  const sessionId = randomUUID()
  const createdAt = new Date().toISOString()
  database.projectCatalogRepository.add({
    id: projectId,
    name: 'conversation-project',
    directoryPath: `/opt/pact-test/conversation-${projectId}`,
    kind: 'git',
    createdAt,
  })
  database.sessionRepository.create(
    { id: sessionId, projectId, title: 'New session', createdAt },
    {
      primaryAgentId: 'codex',
      agents: {
        claude: { model: null, effort: null },
        codex: { model: 'gpt-5.6-sol', effort: 'high' },
      },
      maxDiscussionRounds: 6,
      runningMessagePolicy: 'immediate_safe_point',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  return { sessionId }
}

function messageAnchor(messageId: string, quote: string) {
  return {
    type: 'message' as const,
    messageId,
    contentHash: 'a'.repeat(64),
    textBasis: 'markdown-visible-v2' as const,
    startOffset: 0,
    endOffset: quote.length,
    quote,
  }
}
