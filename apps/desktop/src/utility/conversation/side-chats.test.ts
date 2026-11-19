import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentNativeProbeInput,
  AgentRunInput,
  AgentTitleEnrichmentInput,
} from '@pact/agent-runtime'
import type {
  CollaborationSourceWireRead,
  DefaultSessionSettings,
  NativeProbeResult,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import { COLLABORATION_PAGE_BYTES } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { ConversationImages } from './conversation-images.js'
import { Conversation } from './conversation.js'
import { FrozenSourceReader } from './frozen-source-reader.js'
import { nativeSkillCatalog } from './native-skill-catalog.js'

type SkillRecord = Parameters<typeof nativeSkillCatalog>[3][number]

interface HeldRun {
  input: AgentRunInput
  agentId: RuntimeAgentId
  release: () => void
  permissionRequested?: Promise<void>
}

const mockState = vi.hoisted(() => ({
  skills: {
    codex: [] as SkillRecord[],
    claude: [] as SkillRecord[],
    agy: [] as SkillRecord[],
  },
  runs: [] as AgentRunInput[],
  holdSessions: new Set<string>(),
  heldRuns: new Map<string, HeldRun>(),
  requestPermissionSessions: new Set<string>(),
  reportedTitleBySession: new Map<string, string>(),
  enrichTitleBySession: new Map<string, string>(),
  disposedAdapters: [] as Array<{ agentId: RuntimeAgentId; sessionId: string | undefined }>,
  liveAdapters: 0,
}))

function createMockAdapter(agentId: RuntimeAgentId) {
  return class MockAgentAdapter {
    readonly id = agentId
    readonly executorId = randomUUID()
    private ownerSessionId: string | undefined

    constructor() {
      mockState.liveAdapters += 1
    }

    async probe() {
      return { id: agentId, available: true }
    }

    async discoverSkills(cwd: string, _signal: AbortSignal) {
      return nativeSkillCatalog(agentId, cwd, process.execPath, mockState.skills[agentId])
    }

    async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<NormalizedAgentEvent> {
      this.ownerSessionId = input.sessionId
      mockState.runs.push(input)
      input.recordExecutor?.(this.executorId)
      const nativeSessionId = input.nativeSessionId ?? `${agentId}:${input.sessionId}`
      input.recordDispatch?.('possibly_sent', nativeSessionId, this.executorId)
      yield { agentId, type: 'session.started', nativeSessionId }
      input.recordDispatch?.('accepted', nativeSessionId, this.executorId)
      yield { agentId, type: 'turn.started', turnId: input.runId }

      if (mockState.requestPermissionSessions.has(input.sessionId) && input.requestPermission) {
        const permPromise = input
          .requestPermission(
            {
              title: 'Run diagnostic command',
              detail: 'Side chat requests native takeover permission',
              actions: [
                { id: 'allow', label: 'Allow', kind: 'allow' },
                { id: 'decline', label: 'Decline', kind: 'decline' },
              ],
            },
            signal,
          )
          .catch(() => 'decline')
        const gate = Promise.withResolvers<void>()
        const held: HeldRun = {
          input,
          agentId,
          release: () => gate.resolve(),
          permissionRequested: permPromise.then(() => undefined),
        }
        mockState.heldRuns.set(input.sessionId, held)
        const onAbort = () => gate.resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await gate.promise
        } finally {
          signal.removeEventListener('abort', onAbort)
          mockState.heldRuns.delete(input.sessionId)
        }
      } else if (mockState.holdSessions.has(input.sessionId)) {
        const gate = Promise.withResolvers<void>()
        mockState.heldRuns.set(input.sessionId, {
          input,
          agentId,
          release: () => gate.resolve(),
        })
        const onAbort = () => gate.resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await gate.promise
        } finally {
          signal.removeEventListener('abort', onAbort)
          mockState.heldRuns.delete(input.sessionId)
        }
      }

      const reportedTitle = mockState.reportedTitleBySession.get(input.sessionId)
      if (input.promptEnvelope.requestSessionTitle && reportedTitle) {
        yield {
          agentId,
          type: 'session.title.updated',
          title: reportedTitle,
          origin: 'turn_result',
        }
      }

      yield {
        agentId,
        type: 'text.completed',
        turnId: input.runId,
        outputId: `${input.runId}:answer`,
        text: `Reply from ${agentId}`,
      }
      yield {
        agentId,
        type: 'turn.completed',
        turnId: input.runId,
        outcome: signal.aborted ? 'interrupted' : 'completed',
      }
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }

    async enrichTitle(input: AgentTitleEnrichmentInput): Promise<string | undefined> {
      return mockState.enrichTitleBySession.get(input.sessionId)
    }

    async probeNativeStatus(input: AgentNativeProbeInput): Promise<NativeProbeResult> {
      return {
        kind: 'ended',
        source: 'stored_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId: input.agentId,
          requestId: input.requestId,
          runId: input.runId,
          nativeSessionId: input.nativeSessionId,
          nativeTurnId: input.nativeTurnId,
          bindingGeneration: input.bindingGeneration,
          executorId: input.executorId,
        },
      }
    }

    beginNativeStatusCheck(input: AgentNativeProbeInput) {
      const result = this.probeNativeStatus(input)
      return {
        result,
        physicalCompletion: result.then(
          () => undefined,
          () => undefined,
        ),
      }
    }

    async dispose(): Promise<void> {
      mockState.liveAdapters -= 1
      mockState.disposedAdapters.push({ agentId, sessionId: this.ownerSessionId })
    }
  }
}

vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: createMockAdapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: createMockAdapter('claude') }))
vi.mock('./agy-agent-adapter.js', () => ({ AgyAgentAdapter: createMockAdapter('agy') }))

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const defaultSettings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  secondaryAgentId: 'claude',
  agents: {
    claude: { model: null, effort: null },
    codex: { model: null, effort: null },
    agy: { model: null, effort: null },
  },
  maxDiscussionRounds: 4,
  maxReviewCycles: 2,
  maxRepairAttempts: 2,
}

const cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  mockState.skills = { codex: [], claude: [], agy: [] }
  mockState.runs = []
  mockState.holdSessions.clear()
  mockState.heldRuns.clear()
  mockState.requestPermissionSessions.clear()
  mockState.reportedTitleBySession.clear()
  mockState.enrichTitleBySession.clear()
  mockState.disposedAdapters = []
  mockState.liveAdapters = 0
})

afterEach(async () => {
  for (const held of mockState.heldRuns.values()) held.release()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- Release resources in LIFO order.
    await cleanup()
  }
  vi.restoreAllMocks()
})

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'pact-side-chats-'))
  const projectDir = join(rootDir, 'project')
  const imageRoot = join(rootDir, 'storage')
  await mkdir(projectDir, { recursive: true })
  await mkdir(imageRoot, { recursive: true })

  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  const projectId = randomUUID()
  const parentSessionId = randomUUID()
  const now = new Date().toISOString()

  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Side Chat Fixture',
    directoryPath: projectDir,
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: parentSessionId, projectId, title: 'Main session', createdAt: now },
    defaultSettings,
  )

  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  const inspectReadiness = vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        { agentId: 'claude', state: 'ready', executablePath: process.execPath, checkedAt: now },
        { agentId: 'codex', state: 'ready', executablePath: process.execPath, checkedAt: now },
      ],
    },
  })
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)

  const images = new ConversationImages(db.conversationRepository, imageRoot)
  await images.initialize()

  const conversation = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
    undefined,
    images,
  )

  cleanups.push(async () => {
    for (const held of mockState.heldRuns.values()) held.release()
    await conversation.dispose()
    await images.dispose()
    db.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  const createMainSession = (title: string): string => {
    const id = randomUUID()
    db.sessionRepository.create(
      { id, projectId, title, createdAt: new Date().toISOString() },
      defaultSettings,
    )
    return id
  }

  const createSideChat = async (parentId: string = parentSessionId) => {
    const opId = randomUUID()
    const created = await conversation.createSideChat({
      origin: 'btw',
      operationId: opId,
      parentSessionId: parentId,
    })
    if (!created.ok) throw new Error(`Failed to create side chat: ${created.error.message}`)
    return created.value
  }

  const sendAndSettle = async (sessionId: string, content: string) => {
    const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Missing drafts page')
    const sent = await conversation.send({
      sessionId,
      clientMessageId: randomUUID(),
      content,
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
    })
    expect(sent.ok).toBe(true)
    await vi.waitFor(() => expect(conversation.diagnostics().activeExecutions).toBe(0), {
      interval: 5,
    })
    return sent
  }

  const seedImage = async (sessionId: string, ownerKey: string, bytes: Buffer) => {
    const imageId = randomUUID()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const began = db.conversationRepository.beginImage(sessionId, imageId, 'diagram.png', ownerKey)
    const storageObjectId = began.storageObjectId ?? imageId
    db.conversationRepository.advanceImage(imageId, sessionId, ownerKey, 0, bytes.length)
    await writeFile(join(imageRoot, 'images', `${storageObjectId}.png`), bytes)
    await writeFile(
      join(imageRoot, 'images', `${storageObjectId}.thumb.webp`),
      Buffer.from('thumb'),
    )
    db.conversationRepository.sealImage(
      imageId,
      sessionId,
      ownerKey,
      {
        id: imageId,
        name: 'diagram.png',
        mediaType: 'image/png',
        bytes: bytes.length,
        width: 16,
        height: 16,
        sha256,
      },
      5,
    )
    return {
      imageId,
      storageObjectId,
      filePath: join(imageRoot, 'images', `${storageObjectId}.png`),
    }
  }

  return {
    db,
    projectDir,
    imageRoot,
    projectId,
    parentSessionId,
    conversation,
    images,
    inspectReadiness,
    createMainSession,
    createSideChat,
    sendAndSettle,
    seedImage,
  }
}

describe('Side-chat runtime guards and Agent naming', () => {
  it('rejects /btw in ordinary Conversation.send without persisting messages or runs', async () => {
    const f = await createFixture()
    for (const content of ['/btw quick tangent', '  /btw   ', '/btw']) {
      // oxlint-disable-next-line no-await-in-loop -- Check each invalid /btw send sequentially.
      const result = await f.conversation.send({
        sessionId: f.parentSessionId,
        clientMessageId: randomUUID(),
        content,
        expectedCommentsRevision: 0,
        commentIds: [],
      })
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'CONFLICT', message: expect.stringMatching(/\/btw/u) },
      })
    }
    expect(mockState.runs).toHaveLength(0)
    expect(f.db.conversationRepository.read(f.parentSessionId).messages).toHaveLength(0)
  })

  it('forbids /plan, /build, /review, /btw, and Fork on side chats while allowing Agent naming from New side chat', async () => {
    const f = await createFixture()
    const firstSide = await f.createSideChat()
    const sideChatId = firstSide.sideChat.id

    expect(firstSide.sideChat.title).toBe('New side chat')
    expect(f.db.sessionRepository.find(sideChatId)?.titleSource).toBe('placeholder')

    for (const command of [
      '/plan write a plan',
      '/build implement it',
      '/review check this',
      '/btw nested tangent',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Verify each prohibited slash command sequentially.
      const denied = await f.conversation.send({
        sessionId: sideChatId,
        clientMessageId: randomUUID(),
        content: command,
        expectedCommentsRevision: 0,
        commentIds: [],
      })
      expect(denied).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    }
    expect(mockState.runs).toHaveLength(0)

    // Allow Agent naming via publish_session_title (turn_result) on first message.
    mockState.reportedTitleBySession.set(sideChatId, 'Cache invalidation deep dive')
    await f.sendAndSettle(sideChatId, 'Explain how cache invalidation works here')
    expect(mockState.runs).toHaveLength(1)
    expect(mockState.runs[0]!.promptEnvelope.requestSessionTitle).toBe(true)
    const renamedViaTool = f.db.sessionRepository.find(sideChatId)!
    expect(renamedViaTool.title).toBe('Cache invalidation deep dive')
    expect(renamedViaTool.titleSource).toBe('agent')

    // Fork must still be rejected on side chats even after messages exist.
    const sideMessage = f.db.conversationRepository.read(sideChatId).messages[0]!
    const forkDenied = await f.conversation.forkSession({
      action: 'prepare',
      sourceSessionId: sideChatId,
      messageId: sideMessage.id,
    })
    expect(forkDenied).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: 'Side chats cannot be forked.' },
    })

    // Allow Agent naming via enrichTitle fallback when turn_result title is not emitted.
    const secondSide = await f.createSideChat()
    const secondSideId = secondSide.sideChat.id
    expect(secondSide.sideChat.title).toBe('New side chat')
    mockState.enrichTitleBySession.set(secondSideId, 'Enriched side chat title')
    await f.sendAndSettle(secondSideId, 'Compare two lock strategies')
    await vi.waitFor(() => {
      const updated = f.db.sessionRepository.find(secondSideId)
      expect(updated?.title).toBe('Enriched side chat title')
      expect(updated?.titleSource).toBe('agent')
    })
  })
})

describe('FrozenSourceReader authorizedCutoffIds enforcement and bounds', () => {
  it('enforces cutoff authorization, dynamic grant/revoke, strict target validation, and bounded pagination', async () => {
    const f = await createFixture()
    const repo = f.db.conversationRepository

    const draftsRevisionFor = (sessionId: string): number => {
      const page = repo.readPage({ scope: 'drafts', sessionId })
      if (page.scope !== 'drafts') throw new Error('Missing drafts page')
      return page.commentsRevision
    }

    // Populate >25 messages in parent plus a large multi-byte UTF-8 message and attached Comment.
    const largeUnicode = 'Frozen cutoff body αβ🤝🚀\n'.repeat(2500)
    const firstStarted = repo.beginRun({
      sessionId: f.parentSessionId,
      clientMessageId: randomUUID(),
      content: largeUnicode,
      expectedCommentsRevision: draftsRevisionFor(f.parentSessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    repo.applyEvent(f.parentSessionId, firstStarted.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 't0',
      outcome: 'completed',
    })

    for (let index = 0; index < 26; index += 1) {
      const started = repo.beginRun({
        sessionId: f.parentSessionId,
        clientMessageId: randomUUID(),
        content: `Parent message ${index}`,
        expectedCommentsRevision: draftsRevisionFor(f.parentSessionId),
        commentIds: [],
        agentId: 'codex',
        settingsRevision: 1,
        model: null,
        effort: null,
      })
      repo.applyEvent(f.parentSessionId, started.run.id, {
        agentId: 'codex',
        type: 'turn.completed',
        turnId: `t-${index}`,
        outcome: 'completed',
      })
    }

    const sideA = await f.createSideChat()
    const cutoffA = sideA.cutoffId

    // Add one post-cutoff message and capture a second cutoff B.
    const postCutoffStarted = repo.beginRun({
      sessionId: f.parentSessionId,
      clientMessageId: randomUUID(),
      content: 'Post-cutoff message outside cutoffA',
      expectedCommentsRevision: draftsRevisionFor(f.parentSessionId),
      commentIds: [],
      agentId: 'codex',
      settingsRevision: 1,
      model: null,
      effort: null,
    })
    repo.applyEvent(f.parentSessionId, postCutoffStarted.run.id, {
      agentId: 'codex',
      type: 'turn.completed',
      turnId: 't-post',
      outcome: 'completed',
    })
    const sideB = await f.createSideChat()
    const cutoffB = sideB.cutoffId

    const reader = new FrozenSourceReader(
      { runId: firstStarted.run.id, grant: randomUUID() },
      sideA.sideChat.id,
      repo,
      () => true,
      () => undefined,
      undefined,
      undefined,
      undefined,
      [cutoffA],
    )

    try {
      // Unauthorized cutoff B is rejected across all forms.
      for (const form of ['legacy', 'sourceReference', 'nativeRoot'] as const) {
        expect(() =>
          reader.navigation({ source: 'cutoff', cutoffId: cutoffB, part: 'catalog' }, form),
        ).toThrow(/outside this Run authorization|repository_scope/u)
      }
      expect(() =>
        reader.read({
          ...reader.identity,
          source: 'cutoff',
          cutoffId: cutoffB,
          part: 'catalog',
          offset: 0,
        }),
      ).toThrow(/outside this Run authorization/u)

      // Invalid target selections are rejected.
      expect(() =>
        reader.read({
          ...reader.identity,
          source: 'cutoff',
          cutoffId: cutoffA,
          part: 'catalog',
          messageId: firstStarted.run.userMessageId,
          offset: 0,
        }),
      ).toThrow(/.+/u)
      expect(() =>
        reader.read({
          ...reader.identity,
          source: 'cutoff',
          cutoffId: cutoffA,
          part: 'message',
          offset: 0,
        }),
      ).toThrow(/.+/u)

      // Post-cutoff message cannot be read through cutoff A.
      expect(() =>
        reader.read({
          ...reader.identity,
          source: 'cutoff',
          cutoffId: cutoffA,
          part: 'message',
          messageId: postCutoffStarted.run.userMessageId,
          offset: 0,
        }),
      ).toThrow(/does not exist inside this cutoff/u)

      // Paginate cutoff A catalog with bounded items (<= 24) and wire bytes (<= 48 KiB).
      const catalogItems: Array<{ messageId: string; messageRead: CollaborationSourceWireRead }> =
        []
      let catalogReq: unknown = reader.navigation(
        { source: 'cutoff', cutoffId: cutoffA, part: 'catalog' },
        'sourceReference',
      )
      let catalogPages = 0
      for (;;) {
        const result = reader.read(catalogReq)
        expect(Buffer.byteLength(JSON.stringify(result.page))).toBeLessThanOrEqual(
          COLLABORATION_PAGE_BYTES,
        )
        const parsed: {
          items: Array<{ messageId: string; messageRead: CollaborationSourceWireRead }>
        } = JSON.parse(result.page.text)
        expect(parsed.items.length).toBeLessThanOrEqual(24)
        catalogItems.push(...parsed.items)
        catalogPages += 1
        if (result.page.nextOffset === null) break
        expect(result.page.nextOffset).toBeGreaterThan(result.page.offset)
        catalogReq = result.page.nextRead!
      }
      expect(catalogPages).toBeGreaterThan(1)
      expect(catalogItems.some((item) => item.messageId === firstStarted.run.userMessageId)).toBe(
        true,
      )
      expect(
        catalogItems.some((item) => item.messageId === postCutoffStarted.run.userMessageId),
      ).toBe(false)

      // Reassemble the >48 KiB multi-byte UTF-8 message via bounded messageRead pagination.
      const largeItem = catalogItems.find(
        (item) => item.messageId === firstStarted.run.userMessageId,
      )!
      let msgReq: unknown = largeItem.messageRead
      let reassembled = ''
      let msgPages = 0
      for (;;) {
        const result = reader.read(msgReq)
        expect(Buffer.byteLength(JSON.stringify(result.page))).toBeLessThanOrEqual(
          COLLABORATION_PAGE_BYTES,
        )
        reassembled += result.page.text
        msgPages += 1
        if (result.page.nextOffset === null) break
        expect(result.page.nextOffset).toBeGreaterThan(result.page.offset)
        msgReq = result.page.nextRead!
      }
      expect(msgPages).toBeGreaterThan(1)
      expect(reassembled).toBe(largeUnicode)

      // Dynamic authorization and revocation.
      expect(reader.authorizeCutoffs([cutoffB])).toEqual([cutoffB])
      expect(reader.authorizeCutoffs([cutoffB])).toEqual([])
      const bCatalog = reader.read(
        reader.navigation({ source: 'cutoff', cutoffId: cutoffB, part: 'catalog' }, 'legacy'),
      )
      expect(bCatalog.page.source).toBe('cutoff')
      reader.revokeCutoffs([cutoffB])
      expect(() =>
        reader.navigation({ source: 'cutoff', cutoffId: cutoffB, part: 'catalog' }, 'legacy'),
      ).toThrow(/outside this Run authorization/u)

      // Enforce single active read (1 active / 0 queue) against re-entrant concurrent read.
      const spy = vi.spyOn(repo, 'readCutoffSource').mockImplementationOnce(() => {
        expect(() =>
          reader.read({
            ...reader.identity,
            source: 'cutoff',
            cutoffId: cutoffA,
            part: 'catalog',
            offset: 0,
          }),
        ).toThrow(/already active/u)
        return {
          source: 'cutoff',
          cutoffId: cutoffA,
          part: 'catalog',
          sourceSessionId: f.parentSessionId,
          maxMessageSequence: 0,
          offset: 0,
          nextOffset: null,
          text: JSON.stringify({
            cutoffId: cutoffA,
            sourceSessionId: f.parentSessionId,
            maxMessageSequence: 0,
            items: [],
          }),
          items: [],
        }
      })
      reader.read({
        ...reader.identity,
        source: 'cutoff',
        cutoffId: cutoffA,
        part: 'catalog',
        offset: 0,
      })
      expect(spy).toHaveBeenCalledOnce()
    } finally {
      reader.retire()
    }
  })
})

describe('syncSideChatToMain behavior', () => {
  it('bypasses side-chat busy state, strips @Main, routes originSideChat with live title, and queues when parent is busy', async () => {
    const f = await createFixture()
    const created = await f.createSideChat()
    const sideChatId = created.sideChat.id

    // Hold a run active on the side chat so the side chat is busy.
    mockState.holdSessions.add(sideChatId)
    const sideSend = await f.conversation.send({
      sessionId: sideChatId,
      clientMessageId: randomUUID(),
      content: 'Investigate deadlock',
      expectedCommentsRevision: 0,
      commentIds: [],
    })
    expect(sideSend.ok).toBe(true)
    await vi.waitFor(() => expect(mockState.heldRuns.has(sideChatId)).toBe(true), { interval: 5 })

    const commentsRevisionFor = (sessionId: string): number => {
      const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Missing drafts page')
      return drafts.commentsRevision
    }

    // Sync to main succeeds even while side chat is actively streaming!
    const syncOpId = randomUUID()
    const synced = await f.conversation.syncSideChatToMain({
      operationId: syncOpId,
      sideChatId,
      content: '@Main Use optimistic locking here',
      imageIds: [],
      commentIds: [],
      skills: [],
      expectedCommentsRevision: commentsRevisionFor(sideChatId),
    })
    expect(synced.ok).toBe(true)
    if (!synced.ok) throw new Error(synced.error.message)
    expect(synced.value).toMatchObject({
      operationId: syncOpId,
      sideChatId,
      parentSessionId: f.parentSessionId,
      disposition: 'sent',
      queuedOperationId: null,
    })
    expect(synced.value.mainMessageId).toBeTruthy()

    // Idempotent receipt read returns the exact same receipt.
    await expect(
      f.conversation.readSyncSideChatReceipt({ operationId: syncOpId }),
    ).resolves.toEqual(synced)

    // Wait for parent run to finish and check originSideChat metadata + stripped content.
    await vi.waitFor(
      () => expect(mockState.runs.some((r) => r.sessionId === f.parentSessionId)).toBe(true),
      { interval: 5 },
    )
    const parentRun = mockState.runs.find((r) => r.sessionId === f.parentSessionId)!
    expect(parentRun.promptEnvelope.message.content).toBe('Use optimistic locking here')
    expect(parentRun.collaborationSourceReader).toBeDefined()

    // Live title resolution updates originSideChat.sideChatTitle on read.
    f.db.sessionRepository.rename(sideChatId, 'Deadlock investigation')
    const parentPage = await f.conversation.load({
      scope: 'messages',
      sessionId: f.parentSessionId,
    })
    if (!parentPage.ok || parentPage.value.scope !== 'messages') {
      throw new Error('Expected messages page')
    }
    const syncedMsg = parentPage.value.messages.find(
      (entry) => entry.message.id === synced.value.mainMessageId,
    )
    expect(syncedMsg?.message.originSideChat).toEqual({
      sideChatId,
      cutoffId: synced.value.cutoffId,
      sideChatTitle: 'Deadlock investigation',
    })

    // Release side chat run, then hold a parent run so next sync queues cleanly.
    mockState.heldRuns.get(sideChatId)?.release()
    await vi.waitFor(() => expect(f.conversation.diagnostics().activeExecutions).toBe(0), {
      interval: 5,
    })

    mockState.holdSessions.add(f.parentSessionId)
    const parentBusySend = await f.conversation.send({
      sessionId: f.parentSessionId,
      clientMessageId: randomUUID(),
      content: 'Long parent task',
      expectedCommentsRevision: commentsRevisionFor(f.parentSessionId),
      commentIds: [],
    })
    expect(parentBusySend.ok).toBe(true)
    await vi.waitFor(() => expect(mockState.heldRuns.has(f.parentSessionId)).toBe(true), {
      interval: 5,
    })

    const queueSyncOpId = randomUUID()
    const queuedSync = await f.conversation.syncSideChatToMain({
      operationId: queueSyncOpId,
      sideChatId,
      content: '@Main Follow up once finished',
      imageIds: [],
      commentIds: [],
      skills: [],
      expectedCommentsRevision: commentsRevisionFor(sideChatId),
    })
    expect(queuedSync.ok).toBe(true)
    if (!queuedSync.ok) throw new Error(queuedSync.error.message)
    expect(queuedSync.value).toMatchObject({
      operationId: queueSyncOpId,
      sideChatId,
      parentSessionId: f.parentSessionId,
      disposition: 'queued',
      mainMessageId: null,
    })
    expect(queuedSync.value.queuedOperationId).toBeTruthy()

    // A second sync while one message is already queued on parent is refused.
    const secondQueued = await f.conversation.syncSideChatToMain({
      operationId: randomUUID(),
      sideChatId,
      content: '@Main Another queued message',
      imageIds: [],
      commentIds: [],
      skills: [],
      expectedCommentsRevision: commentsRevisionFor(sideChatId),
    })
    expect(secondQueued).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: expect.stringMatching(/already queued/u) },
    })

    mockState.heldRuns.get(f.parentSessionId)?.release()
  })

  it('refuses syncSideChatToMain on native takeover, recovery required, archived, archive-busy, quit-sealed, and disposed states', async () => {
    const f = await createFixture()
    const created = await f.createSideChat()
    const sideChatId = created.sideChat.id

    const trySync = () => {
      const drafts = f.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: sideChatId,
      })
      const rev = drafts.scope === 'drafts' ? drafts.commentsRevision : 0
      return f.conversation.syncSideChatToMain({
        operationId: randomUUID(),
        sideChatId,
        content: '@Main Takeaway',
        imageIds: [],
        commentIds: [],
        skills: [],
        expectedCommentsRevision: rev,
      })
    }

    // 1. Native takeover on side chat (pending native permission interaction).
    mockState.requestPermissionSessions.add(sideChatId)
    const permSend = await f.conversation.send({
      sessionId: sideChatId,
      clientMessageId: randomUUID(),
      content: 'Needs permission',
      expectedCommentsRevision: 0,
      commentIds: [],
    })
    expect(permSend.ok).toBe(true)
    await vi.waitFor(
      async () => {
        const page = await f.conversation.load({ scope: 'messages', sessionId: sideChatId })
        expect(
          page.ok &&
            page.value.scope === 'messages' &&
            (page.value.header.pendingNativeInteractions?.length ?? 0) > 0,
        ).toBe(true)
      },
      { interval: 5 },
    )
    expect(await trySync()).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: expect.stringMatching(/pending native permission/u) },
    })
    // Settle the takeover run cleanly by responding to the pending permission.
    mockState.requestPermissionSessions.delete(sideChatId)
    const pendingPage = await f.conversation.load({ scope: 'messages', sessionId: sideChatId })
    if (!pendingPage.ok || pendingPage.value.scope !== 'messages') {
      throw new Error('Expected messages page')
    }
    const pendingInteraction = pendingPage.value.header.pendingNativeInteractions![0]!
    const heldRun = mockState.heldRuns.get(sideChatId)!
    expect(
      f.conversation.respondNativePermission({
        operationId: heldRun.input.runId,
        permissionId: pendingInteraction.request.id,
        decision: 'allow',
      }).ok,
    ).toBe(true)
    mockState.heldRuns.get(sideChatId)?.release()
    await vi.waitFor(() => expect(f.conversation.diagnostics().activeExecutions).toBe(0), {
      interval: 5,
    })

    // 2. Recovery required on parent session (and on side chat).
    await f.sendAndSettle(f.parentSessionId, 'Establish parent native context')
    f.db.conversationRepository.setContinuation(f.parentSessionId, 'codex', 'recovery_required')
    expect(await trySync()).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
    })
    f.db.conversationRepository.setContinuation(f.parentSessionId, 'codex', 'ready')
    f.db.conversationRepository.setContinuation(sideChatId, 'codex', 'recovery_required')
    expect(await trySync()).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
    })
    f.db.conversationRepository.setContinuation(sideChatId, 'codex', 'ready')

    // 3. Archive operation actively stopping parent blocks side chat sync.
    const archiveOpId = randomUUID()
    const archiveOwner = randomUUID()
    const archiveContext = f.db.conversationRepository.archives.context({
      kind: 'session',
      sessionId: f.parentSessionId,
    })
    f.db.conversationRepository.archives.prepare(
      {
        operationId: archiveOpId,
        scope: { kind: 'session', sessionId: f.parentSessionId },
        ...archiveContext,
        tasks: [],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      archiveOwner,
    )
    f.db.conversationRepository.archives.claim(archiveOpId, archiveOwner, [], [], () => undefined)
    expect(f.db.conversationRepository.archives.blocksSession(sideChatId)).toBe(true)
    expect(await trySync()).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    })
    f.db.conversationRepository.archives.fail(
      archiveOpId,
      [],
      'Cancelled test archive block',
      false,
    )
    f.db.conversationRepository.archives.releaseResolved(archiveOpId)

    // 4. Archived side chat refuses sync.
    const archivedSide = await f.createSideChat()
    f.db.sessionRepository.archive(archivedSide.sideChat.id)
    expect(
      await f.conversation.syncSideChatToMain({
        operationId: randomUUID(),
        sideChatId: archivedSide.sideChat.id,
        content: '@Main Should fail',
        imageIds: [],
        commentIds: [],
        skills: [],
        expectedCommentsRevision: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })

    // 5. Quit-sealed (closing) state refuses sync.
    const quitOpId = randomUUID()
    const quitPrep = f.conversation.prepareNativeQuit({ operationId: quitOpId })
    expect(quitPrep.ok).toBe(true)
    expect(await trySync()).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    f.conversation.cancelNativeQuit({ operationId: quitOpId })

    // 6. Disposed (closing) state refuses sync.
    await f.conversation.dispose()
    expect(await trySync()).toMatchObject({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE' } })
  })

  it('validates Skills against the parent target Agent and rejects residual Pact/route directives', async () => {
    const f = await createFixture()
    const codexSkillPath = join(f.projectDir, 'codex-deploy.md')
    const claudeSkillPath = join(f.projectDir, 'claude-only.md')
    await writeFile(codexSkillPath, '# Deploy skill\n')
    await writeFile(claudeSkillPath, '# Claude-only skill\n')
    mockState.skills.codex = [
      { name: 'deploy', description: 'Deploy via codex', scope: 'user', path: codexSkillPath },
    ]
    mockState.skills.claude = [
      {
        name: 'claudeonly',
        description: 'Only available on claude',
        scope: 'user',
        path: claudeSkillPath,
      },
    ]

    const created = await f.createSideChat()
    const sideChatId = created.sideChat.id

    // Residual Pact commands or agent routes after @Main are rejected.
    for (const badContent of [
      '@Main /plan write plan',
      '@Main /build code it',
      '@Main /review review it',
      '@Main /btw nested',
      '@Main @claude ask claude',
      '@Main @all ask both',
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Validate each residual directive independently.
      const rejected = await f.conversation.syncSideChatToMain({
        operationId: randomUUID(),
        sideChatId,
        content: badContent,
        imageIds: [],
        commentIds: [],
        skills: [],
        expectedCommentsRevision: 0,
      })
      expect(rejected).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    }

    // Skill existing only on claude fails validation against parent target agent (codex).
    const claudeCatalog = await f.conversation.readSkillCatalog({
      sessionId: f.parentSessionId,
      agentId: 'claude',
      query: '',
      offset: 0,
      refresh: false,
    })
    if (!claudeCatalog.ok) throw new Error(claudeCatalog.error.message)
    const claudeEntry = claudeCatalog.value.skills[0]!

    const wrongAgentOpId = randomUUID()
    const wrongAgentResult = await f.conversation.syncSideChatToMain({
      operationId: wrongAgentOpId,
      sideChatId,
      content: '@Main /claudeonly do work',
      imageIds: [],
      commentIds: [],
      skills: [
        {
          id: claudeEntry.id,
          name: 'claudeonly',
          agentId: 'claude',
          start: 6,
          end: 17,
        },
      ],
      expectedCommentsRevision: 0,
    })
    expect(wrongAgentResult).toMatchObject({ ok: false })
    expect(await f.conversation.readSyncSideChatReceipt({ operationId: wrongAgentOpId })).toEqual({
      ok: true,
      value: null,
    })
    expect(f.db.conversationRepository.read(f.parentSessionId).messages).toHaveLength(0)

    // Skill valid on parent target agent (codex) succeeds with shifted offsets and frozen invocation.
    const codexCatalog = await f.conversation.readSkillCatalog({
      sessionId: f.parentSessionId,
      agentId: 'codex',
      query: '',
      offset: 0,
      refresh: false,
    })
    if (!codexCatalog.ok) throw new Error(codexCatalog.error.message)
    const codexEntry = codexCatalog.value.skills[0]!

    const validResult = await f.conversation.syncSideChatToMain({
      operationId: randomUUID(),
      sideChatId,
      content: '@Main /deploy staging',
      imageIds: [],
      commentIds: [],
      skills: [
        {
          id: codexEntry.id,
          name: 'deploy',
          agentId: 'codex',
          start: 6,
          end: 13,
        },
      ],
      expectedCommentsRevision: 0,
    })
    expect(validResult.ok).toBe(true)
    await vi.waitFor(() => expect(mockState.runs).toHaveLength(1), { interval: 5 })
    expect(mockState.runs[0]!.sessionId).toBe(f.parentSessionId)
    expect(mockState.runs[0]!.promptEnvelope.skillInvocation?.bindings).toEqual([
      expect.objectContaining({ agentId: 'codex', name: 'deploy', id: codexEntry.id }),
    ])
    expect(mockState.runs[0]!.promptEnvelope.skillInvocation?.arguments).toBe('staging')
  })

  it('shares images zero-copy via storageObjectId refcounts and deletes files only when all references drop', async () => {
    const f = await createFixture()
    const created = await f.createSideChat()
    const sideChatId = created.sideChat.id
    const ownerKey = randomUUID()
    const pngBytes = Buffer.from('fake-png-binary-payload-for-zero-copy-sync')

    const {
      imageId: sourceImageId,
      storageObjectId: sourceStorageObjectId,
      filePath,
    } = await f.seedImage(sideChatId, ownerKey, pngBytes)

    const synced = await f.conversation.syncSideChatToMain(
      {
        operationId: randomUUID(),
        sideChatId,
        content: '@Main See attached diagram',
        imageIds: [sourceImageId],
        commentIds: [],
        skills: [],
        expectedCommentsRevision: 0,
      },
      ownerKey,
    )
    expect(synced.ok).toBe(true)
    await vi.waitFor(() => expect(f.conversation.diagnostics().activeExecutions).toBe(0), {
      interval: 5,
    })

    // Parent message owns a distinct cloned image ID backed by the same storageObjectId.
    const parentPage = await f.conversation.load({
      scope: 'messages',
      sessionId: f.parentSessionId,
    })
    if (!parentPage.ok || parentPage.value.scope !== 'messages') {
      throw new Error('Expected messages page')
    }
    const parentMsg = parentPage.value.messages.find((entry) => entry.message.role === 'user')!
    expect(parentMsg.message.images).toHaveLength(1)
    const clonedImageId = parentMsg.message.images![0]!.id
    expect(clonedImageId).not.toBe(sourceImageId)
    expect(f.db.conversationRepository.imageStorageObjectId(clonedImageId)).toBe(
      sourceStorageObjectId,
    )

    // Releasing the temporary side-chat image must keep the shared backing file intact.
    await f.images.release(sideChatId, sourceImageId, ownerKey)
    expect(f.db.conversationRepository.imageRecord(sourceImageId)).toBeUndefined()
    await expect(access(filePath)).resolves.toBeUndefined()

    // Parent can still read the complete shared image bytes from disk.
    const readBack = await f.images.read(
      { sessionId: f.parentSessionId, imageId: clonedImageId, variant: 'original', offset: 0 },
      ownerKey,
    )
    expect(Buffer.from(readBack.data, 'base64').equals(pngBytes)).toBe(true)

    // When a sync fails and rolls back, releasing the temporary source image deletes the file (refcount = 0).
    const { imageId: orphanImageId, filePath: orphanPath } = await f.seedImage(
      sideChatId,
      ownerKey,
      Buffer.from('rollback-image-bytes'),
    )
    f.db.conversationRepository.setContinuation(f.parentSessionId, 'codex', 'recovery_required')
    const failedSync = await f.conversation.syncSideChatToMain(
      {
        operationId: randomUUID(),
        sideChatId,
        content: '@Main Should roll back image',
        imageIds: [orphanImageId],
        commentIds: [],
        skills: [],
        expectedCommentsRevision: 0,
      },
      ownerKey,
    )
    expect(failedSync).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
    })
    await f.images.release(sideChatId, orphanImageId, ownerKey)
    await expect(access(orphanPath)).rejects.toThrow(/ENOENT/u)
  })
})

describe('discardEmptySideChat guards and nativeMetadataChanged emission', () => {
  it('blocks when archive-blocked, when a session operation is active, or when a live adapter slot exists; succeeds and notifies when empty', async () => {
    const f = await createFixture()
    const created = await f.createSideChat()
    const sideChatId = created.sideChat.id

    const presenceRevisions: number[] = []
    const unsubscribe = f.conversation.subscribeNativePresence((version) => {
      presenceRevisions.push(version.revision)
    })

    try {
      // 1. Archive blocked guard (claimed stopping archive operation blocks side chat).
      const archiveOpId = randomUUID()
      const archiveOwner = randomUUID()
      const archiveContext = f.db.conversationRepository.archives.context({
        kind: 'session',
        sessionId: f.parentSessionId,
      })
      f.db.conversationRepository.archives.prepare(
        {
          operationId: archiveOpId,
          scope: { kind: 'session', sessionId: f.parentSessionId },
          ...archiveContext,
          tasks: [],
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        archiveOwner,
      )
      f.db.conversationRepository.archives.claim(archiveOpId, archiveOwner, [], [], () => undefined)
      expect(f.db.conversationRepository.archives.blocksSession(sideChatId)).toBe(true)
      const countBeforeArchiveDiscard = presenceRevisions.length
      expect(await f.conversation.discardEmptySideChat({ sideChatId })).toEqual({
        ok: true,
        value: { discarded: false },
      })
      expect(presenceRevisions).toHaveLength(countBeforeArchiveDiscard)
      expect(f.db.sessionRepository.find(sideChatId)).toBeDefined()
      f.db.conversationRepository.archives.fail(
        archiveOpId,
        [],
        'Cancelled test archive block',
        false,
      )
      f.db.conversationRepository.archives.releaseResolved(archiveOpId)

      // 2. Active session operation guard (in-flight preparingSend before any DB write or adapter acquisition).
      const readinessGate = Promise.withResolvers<void>()
      f.inspectReadiness.mockImplementationOnce(async () => {
        await readinessGate.promise
        return {
          ok: false,
          error: { code: 'RUNTIME_UNAVAILABLE', message: 'Cancelled readiness check' },
        }
      })
      const pendingSend = f.conversation.send({
        sessionId: sideChatId,
        clientMessageId: randomUUID(),
        content: 'Will fail before write',
        expectedCommentsRevision: 0,
        commentIds: [],
      })
      await vi.waitFor(() => expect(f.conversation.diagnostics().preparingExecutions).toBe(1), {
        interval: 5,
      })
      expect(f.conversation.diagnostics().adapterSlots).toBe(0)
      const countBeforeOpDiscard = presenceRevisions.length
      expect(await f.conversation.discardEmptySideChat({ sideChatId })).toEqual({
        ok: true,
        value: { discarded: false },
      })
      expect(presenceRevisions).toHaveLength(countBeforeOpDiscard)
      readinessGate.resolve()
      expect((await pendingSend).ok).toBe(false)
      await vi.waitFor(() => expect(f.conversation.diagnostics().preparingExecutions).toBe(0), {
        interval: 5,
      })

      // 3. Live adapter slot guard (readSkillCatalog acquires an idle adapter slot with empty DB).
      const catalog = await f.conversation.readSkillCatalog({
        sessionId: sideChatId,
        agentId: 'codex',
        query: '',
        offset: 0,
        refresh: false,
      })
      expect(catalog.ok).toBe(true)
      expect(f.conversation.diagnostics().adapterSlots).toBe(1)
      const countBeforeSlotDiscard = presenceRevisions.length
      expect(await f.conversation.discardEmptySideChat({ sideChatId })).toEqual({
        ok: true,
        value: { discarded: false },
      })
      expect(presenceRevisions).toHaveLength(countBeforeSlotDiscard)
      expect(f.db.sessionRepository.find(sideChatId)).toBeDefined()

      // 4. Clean empty discard succeeds and emits nativeMetadataChanged.
      const cleanSide = await f.createSideChat()
      const cleanId = cleanSide.sideChat.id
      const countBeforeClean = presenceRevisions.length
      expect(await f.conversation.discardEmptySideChat({ sideChatId: cleanId })).toEqual({
        ok: true,
        value: { discarded: true },
      })
      expect(presenceRevisions.length).toBeGreaterThan(countBeforeClean)
      expect(f.db.sessionRepository.find(cleanId)).toBeUndefined()
      expect(f.db.conversationRepository.sideChatAnchorCutoff(cleanId)).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })
})

describe('Priority-scored MAX_ADAPTER_SLOTS = 5 idle eviction', () => {
  it('evicts uninterested side chats (0) before uninterested main (1), interested side chat (2), and interested/parent main (3)', async () => {
    const f = await createFixture()

    const mainInterested = f.createMainSession('Main interested')
    const mainParent = f.parentSessionId
    const mainUninterested = f.createMainSession('Main uninterested')
    const sideInterested = (await f.createSideChat(mainInterested)).sideChat.id
    const sideUninterested = (await f.createSideChat(mainUninterested)).sideChat.id

    // Warm 5 idle adapter slots in REVERSE eviction priority order so FIFO would fail.
    for (const id of [
      mainInterested,
      mainParent,
      sideInterested,
      mainUninterested,
      sideUninterested,
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- Establish exact Map insertion order.
      await f.sendAndSettle(id, `Warm slot for ${id}`)
    }
    expect(f.conversation.diagnostics().adapterSlots).toBe(5)
    expect(mockState.disposedAdapters).toHaveLength(0)

    // Mark mainInterested and sideInterested as visible/interested (2 active sessions).
    // mainParent is NOT in interestedSessionIds, so it is protected ONLY as acquiringParentId (score 3).
    f.conversation.setInterests([mainInterested, sideInterested])

    // Create 4 new side chats under mainParent and hold each run active so newly acquired slots stay busy.
    const children = [
      (await f.createSideChat(mainParent)).sideChat.id,
      (await f.createSideChat(mainParent)).sideChat.id,
      (await f.createSideChat(mainParent)).sideChat.id,
      (await f.createSideChat(mainParent)).sideChat.id,
    ]

    const acquireAndHold = async (sessionId: string) => {
      mockState.holdSessions.add(sessionId)
      const res = await f.conversation.send({
        sessionId,
        clientMessageId: randomUUID(),
        content: `Acquire slot ${sessionId}`,
        expectedCommentsRevision: 0,
        commentIds: [],
      })
      expect(res.ok).toBe(true)
      await vi.waitFor(() => expect(mockState.heldRuns.has(sessionId)).toBe(true), { interval: 5 })
    }

    // Eviction 1: must evict score 0 (uninterested side chat).
    await acquireAndHold(children[0]!)
    expect(mockState.disposedAdapters.map((d) => d.sessionId)).toEqual([sideUninterested])

    // Eviction 2: must evict score 1 (uninterested main session), NOT mainParent (score 3).
    await acquireAndHold(children[1]!)
    expect(mockState.disposedAdapters.map((d) => d.sessionId)).toEqual([
      sideUninterested,
      mainUninterested,
    ])

    // Eviction 3: must evict score 2 (interested side chat), NOT mainInterested or mainParent (score 3).
    await acquireAndHold(children[2]!)
    expect(mockState.disposedAdapters.map((d) => d.sessionId)).toEqual([
      sideUninterested,
      mainUninterested,
      sideInterested,
    ])

    // Eviction 4: only score-3 slots (mainInterested, mainParent) remain idle; first score-3 slot evicts, mainParent survives.
    await acquireAndHold(children[3]!)
    expect(mockState.disposedAdapters.map((d) => d.sessionId)).toEqual([
      sideUninterested,
      mainUninterested,
      sideInterested,
      mainInterested,
    ])
    expect(f.conversation.diagnostics().adapterSlots).toBe(5)

    for (const id of children) mockState.heldRuns.get(id)?.release()
    await vi.waitFor(() => expect(f.conversation.diagnostics().activeExecutions).toBe(0), {
      interval: 5,
    })
  })
})
