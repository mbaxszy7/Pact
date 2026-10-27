import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentNativeProbeInput,
  AgentNativeContextRebuildInput,
  AgentNativeTitleInput,
  AgentRunInput,
  AgentTitleEnrichmentInput,
} from '@pact/agent-runtime'
import type {
  DefaultSessionSettings as Settings,
  NormalizedAgentEvent,
  NativeContextRebuildChunk,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { DefaultSessionSettings } from '../default-session-settings/default-session-settings.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { SessionWorkspace } from '../session-workspace/session-workspace.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  runTitle: undefined as string | undefined,
  reportedTitle: undefined as string | undefined,
  titleRequests: [] as boolean[],
  enrichTitle: 'Codex generated title' as string | undefined,
  probeTitle: undefined as string | undefined,
  enrichment: undefined as
    | ((input: AgentTitleEnrichmentInput, signal: AbortSignal) => Promise<string | undefined>)
    | undefined,
  names: new Map<string, string>(),
  writes: [] as AgentNativeTitleInput[],
  pending: [] as { input: AgentNativeTitleInput; release: () => void }[],
  hold: false,
  runs: 0,
  created: 0,
  disposed: 0,
  naming: 0,
  highWater: 0,
  disposedWhileNaming: 0,
  beforeFirstTitleWrites: [] as number[],
}))

class NativeFixture {
  readonly executorId = randomUUID()
  private naming = 0
  constructor(readonly id: 'codex' | 'claude') {
    native.created += 1
  }
  async *run(input: AgentRunInput): AsyncIterable<NormalizedAgentEvent> {
    native.runs += 1
    input.recordExecutor?.(this.executorId)
    const nativeSessionId = input.nativeSessionId ?? `${this.id}:${input.sessionId}`
    yield { agentId: this.id, type: 'session.started', nativeSessionId }
    if (this.id === 'codex') native.beforeFirstTitleWrites.push(native.writes.length)
    const title =
      this.id === 'claude'
        ? 'Claude generated title'
        : (native.names.get(nativeSessionId) ?? native.runTitle)
    if (title) {
      const logical = title.startsWith('[Pact] ') ? undefined : title
      input.observeNativeTitle?.(nativeSessionId, logical)
      if (logical) yield { agentId: this.id, type: 'session.title.updated', title: logical }
    }
    yield { agentId: this.id, type: 'turn.started', turnId: input.runId }
    native.titleRequests.push(Boolean(input.promptEnvelope.requestSessionTitle))
    if (input.promptEnvelope.requestSessionTitle && native.reportedTitle)
      yield {
        agentId: this.id,
        type: 'session.title.updated',
        title: native.reportedTitle,
        origin: 'turn_result',
      }
    yield {
      agentId: this.id,
      type: 'text.completed',
      turnId: input.runId,
      outputId: `${input.runId}:answer`,
      text: 'Fixture reply',
    }
    yield { agentId: this.id, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
  }
  async enrichTitle(input: AgentTitleEnrichmentInput, signal: AbortSignal) {
    if (this.id !== 'codex') return undefined
    if (native.enrichment) return native.enrichment(input, signal)
    const title = native.names.get(input.nativeSessionId) ?? native.enrichTitle
    const logical = title?.startsWith('[Pact] ') ? undefined : title
    if (title) input.observeNativeTitle?.(input.nativeSessionId, logical)
    return logical
  }
  async probeNativeStatus(input: AgentNativeProbeInput) {
    const title = native.probeTitle ?? native.names.get(input.nativeSessionId)
    if (title)
      input.observeNativeTitle?.(
        input.nativeSessionId,
        title.startsWith('[Pact] ') ? undefined : title,
      )
    return {
      kind: 'ended' as const,
      source: 'stored_terminal' as const,
      outcome: 'completed' as const,
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
  async setNativeTitle(input: AgentNativeTitleInput, signal: AbortSignal) {
    native.writes.push(input)
    native.naming += 1
    this.naming += 1
    native.highWater = Math.max(native.highWater, native.naming)
    try {
      if (native.hold)
        await new Promise<void>((settle) => {
          const finish = () => {
            signal.removeEventListener('abort', finish)
            native.pending = native.pending.filter((item) => item !== pending)
            settle()
          }
          const pending = { input, release: finish }
          native.pending.push(pending)
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish()
        })
      if (signal.aborted || !input.isCurrent()) return 'unavailable' as const
      native.names.set(input.nativeSessionId, input.title)
      return 'synchronized' as const
    } finally {
      native.naming -= 1
      this.naming -= 1
    }
  }
  async rebuildNativeContext(
    input: AgentNativeContextRebuildInput,
    source: AsyncIterable<NativeContextRebuildChunk>,
  ) {
    for await (const chunk of source) void chunk
    await input.onNativeCreationDispatched?.(this.executorId)
    const nativeSessionId = `${this.id}:rebuilt:${input.sessionId}`
    await input.onNativeSessionCreated?.(nativeSessionId)
    input.reportNativeWork?.({ executorId: this.executorId, nativeSessionId, state: 'settled' })
    return {
      nativeSessionId,
      initializationWitness: {
        kind: 'codex_rollout_v1' as const,
        nativeSessionId,
        verifiedPrefixBytes: 1,
        verifiedPrefixSha256: 'a'.repeat(64),
        recordCount: 1,
      },
    }
  }
  async dispose() {
    if (this.naming) native.disposedWhileNaming += 1
    native.disposed += 1
  }
}

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: function CodexFixture() {
    return new NativeFixture('codex')
  },
}))
vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: function ClaudeFixture() {
    return new NativeFixture('claude')
  },
}))

const owned: Array<{ db: PactDatabase; flow: Conversation }> = []
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async ({ db, flow }) => {
      await flow.dispose()
      db.close()
    }),
  )
  native.runTitle = undefined
  native.reportedTitle = undefined
  native.titleRequests = []
  native.enrichTitle = 'Codex generated title'
  native.probeTitle = undefined
  native.enrichment = undefined
  native.names.clear()
  native.writes = []
  native.pending = []
  native.hold = false
  native.runs = 0
  native.created = 0
  native.disposed = 0
  native.naming = 0
  native.highWater = 0
  native.disposedWhileNaming = 0
  native.beforeFirstTitleWrites = []
  vi.restoreAllMocks()
})

const settings: Settings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 3,

  maxReviewCycles: 2,
  maxRepairAttempts: 2,
}

async function fixture() {
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    now = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Project',
    directoryPath: '/fixture',
    kind: 'directory',
    createdAt: now,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'New Session', createdAt: now },
    settings,
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        { agentId: 'claude', state: 'ready', executablePath: '/fixture/claude', checkedAt: now },
        { agentId: 'codex', state: 'ready', executablePath: '/fixture/codex', checkedAt: now },
      ],
    },
  })
  vi.spyOn(preparation, 'findRecoveryExecutable').mockImplementation(
    async (agentId) => `/fixture/${agentId}`,
  )
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  owned.push({ db, flow })
  const workspace = new SessionWorkspace(
    db.projectCatalogRepository,
    db.sessionRepository,
    new DefaultSessionSettings(preparation, db.defaultSessionSettingsRepository),
    (id) => flow.sessionTitleChanged(id),
  )
  const send = async (agentId: 'codex' | 'claude' = 'codex', targetSessionId = sessionId) => {
    const drafts = db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: targetSessionId,
    })
    if (drafts.scope !== 'drafts') throw new Error('Missing draft page')
    const result = await flow.send({
      sessionId: targetSessionId,
      clientMessageId: randomUUID(),
      content: 'Hello',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId },
    })
    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(flow.diagnostics().activeExecutions).toBe(0), { interval: 1 })
    return db.conversationRepository.latestAgentRun(targetSessionId, agentId)!
  }
  return {
    db,
    flow,
    workspace,
    preparation,
    sessionId,
    projectId,
    send,
    title: () => db.sessionRepository.find(sessionId)!.title,
  }
}

describe('Conversation Native display title ownership', () => {
  it('adopts same-Turn metadata without a Native name and retains it through stale native readback and resume', async () => {
    native.enrichTitle = undefined
    native.reportedTitle = 'Metadata from the first task'
    const f = await fixture()
    const first = await f.send()
    expect(f.title()).toBe('Metadata from the first task')
    expect(native.runs).toBe(1)
    expect(native.titleRequests).toEqual([true])
    f.db.conversationRepository.applyEvent(f.sessionId, first.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: 'Stale Native first message',
    })
    expect(f.title()).toBe('Metadata from the first task')
    native.names.set(first.nativeSessionId!, 'Stale Native first message')
    await f.send()
    expect(f.title()).toBe('Metadata from the first task')
    expect(native.titleRequests).toEqual([true, false])
    expect(native.runs).toBe(2)
  })

  it('does not treat an archived or rejected same-name report as an adopted metadata title', async () => {
    native.runTitle = 'Existing native title'
    const f = await fixture()
    const run = await f.send()
    f.db.conversationRepository.applyArchivedEvent(f.sessionId, run.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: f.title(),
      origin: 'turn_result',
    })
    f.db.conversationRepository.applyEvent(f.sessionId, run.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: f.title(),
      origin: 'turn_result',
    })
    f.db.conversationRepository.applyEvent(f.sessionId, run.id, {
      agentId: 'codex',
      type: 'session.title.updated',
      title: 'Later legitimate native title',
    })
    expect(f.title()).toBe('Later legitimate native title')
  })

  it('keeps the substantive answer when optional title persistence fails', async () => {
    native.enrichTitle = undefined
    native.reportedTitle = 'Optional metadata'
    const f = await fixture()
    const apply = f.db.conversationRepository.applyEvent.bind(f.db.conversationRepository)
    vi.spyOn(f.db.conversationRepository, 'applyEvent').mockImplementation((sid, rid, event) => {
      if (event.type === 'session.title.updated' && event.origin === 'turn_result')
        throw new Error('Metadata save failure')
      return apply(sid, rid, event)
    })
    const run = await f.send()
    expect(run.status).toBe('completed')
    expect(
      f.db.conversationRepository
        .read(f.sessionId)
        .messages.some((message) => message.content === 'Fixture reply'),
    ).toBe(true)
    expect(f.db.sessionRepository.find(f.sessionId)?.titleSource).toBe('local')
    expect(native.runs).toBe(1)
  })

  it('does not request a title after a user rename', async () => {
    native.reportedTitle = 'Unwanted metadata'
    const f = await fixture()
    f.workspace.rename({ sessionId: f.sessionId, title: 'My title' })
    await f.send()
    expect(f.title()).toBe('My title')
    expect(native.titleRequests).toEqual([false])
  })
  it('never writes a stale name into the retired binding after Rebuild', async () => {
    const f = await fixture()
    const original = await f.send()
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    native.hold = true
    f.workspace.rename({ sessionId: f.sessionId, title: 'New generation title' })
    const stale = native.pending[0]!
    const rebuilt = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'codex',
      intent: 'create',
      abandon: true,
      clientOperationId: randomUUID(),
      expectedGeneration: 1,
      expectedNativeSessionId: original.nativeSessionId!,
    })
    if (!rebuilt.ok) throw new Error(JSON.stringify(rebuilt.error))
    await vi.waitFor(() =>
      expect(
        f.db.conversationRepository.nativeContext(f.sessionId, 'codex')?.bindingGeneration,
      ).toBe(2),
    )
    expect(stale.input.isCurrent()).toBe(false)
    stale.release()
    const binding = f.db.conversationRepository.nativeContext(f.sessionId, 'codex')!
    await vi.waitFor(() =>
      expect(native.pending[0]?.input.nativeSessionId).toBe(binding.nativeSessionId),
    )
    native.pending[0]!.release()
    await vi.waitFor(() => expect(native.naming).toBe(0))
    expect(native.names.get(original.nativeSessionId!)).toBe(
      '[Pact] Project · Codex generated title',
    )
    expect(native.names.get(binding.nativeSessionId)).toBe('[Pact] Project · New generation title')
    expect(native.runs).toBe(1)
  })

  it('does not unlock naming when a clean title read is cancelled before persistence', async () => {
    const f = await fixture()
    await f.send('claude')
    let observed:
      | { input: AgentTitleEnrichmentInput; signal: AbortSignal; resolve: (title: string) => void }
      | undefined
    native.enrichment = (input, signal) =>
      new Promise<string>((settle) => {
        observed = { input, signal, resolve: settle }
      })
    await f.send()
    await vi.waitFor(() => expect(observed).toBeDefined())
    observed!.input.observeNativeTitle?.(
      observed!.input.nativeSessionId,
      'Unsaved late Native title',
    )
    native.enrichment = async () => undefined
    const next = f.send('claude')
    await vi.waitFor(() => expect(observed!.signal.aborted).toBe(true))
    observed!.resolve('Unsaved late Native title')
    await next
    expect(native.writes).toHaveLength(0)
    expect(f.title()).toBe('Claude generated title')
  })

  it('cancels an old executable owner before replacement and reconciles the persisted manual title', async () => {
    const f = await fixture()
    await f.send()
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    native.hold = true
    f.workspace.rename({ sessionId: f.sessionId, title: 'Latest saved title' })
    const previous = native.pending[0]!
    vi.spyOn(f.preparation, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            state: 'ready',
            executablePath: '/fixture/claude',
            checkedAt: new Date().toISOString(),
          },
          {
            agentId: 'codex',
            state: 'ready',
            executablePath: '/fixture/codex-new',
            checkedAt: new Date().toISOString(),
          },
        ],
      },
    })
    await f.send()
    expect(previous.input.isCurrent()).toBe(false)
    expect(native.disposed).toBe(1)
    expect(native.disposedWhileNaming).toBe(0)
    await vi.waitFor(() => expect(native.pending).toHaveLength(1))
    native.pending[0]!.release()
    await vi.waitFor(() => expect(native.naming).toBe(0))
    expect(native.names.get(`codex:${f.sessionId}`)).toBe('[Pact] Project · Latest saved title')
    expect(f.title()).toBe('Latest saved title')
  })

  it('bounds metadata owners and drains them before Adapter eviction and shutdown', async () => {
    const f = await fixture()
    native.hold = true
    for (let index = 0; index < 12; index += 1) {
      const sessionId = randomUUID()
      f.db.sessionRepository.create(
        {
          id: sessionId,
          projectId: f.projectId,
          title: 'Fixture',
          createdAt: new Date().toISOString(),
        },
        settings,
      )
      // oxlint-disable-next-line no-await-in-loop -- Serialize real Adapter slot admission and eviction.
      await f.send('codex', sessionId)
      expect(f.flow.diagnostics().adapterSlots).toBeLessThanOrEqual(5)
      expect(native.naming).toBeLessThanOrEqual(5)
    }
    await f.flow.dispose()
    expect(native.highWater).toBeLessThanOrEqual(5)
    expect(native.naming).toBe(0)
    expect(native.pending).toHaveLength(0)
    expect(native.created).toBe(native.disposed)
    expect(native.disposedWhileNaming).toBe(0)
  })

  it('preserves Claude-first and terminal-late Codex auto titles before decorating', async () => {
    const f = await fixture()
    await f.send('claude')
    expect(f.title()).toBe('Claude generated title')
    await f.send()
    await vi.waitFor(() =>
      expect(native.names.get(`codex:${f.sessionId}`)).toBe(
        '[Pact] Project · Codex generated title',
      ),
    )
    expect(native.beforeFirstTitleWrites).toEqual([0])
    expect(f.title()).toBe('Codex generated title')
    expect(native.runs).toBe(2)
  })

  it('persists a late first native title read by Check before deriving its label', async () => {
    const f = await fixture()
    await f.send('claude')
    native.enrichTitle = undefined
    const run = await f.send()
    expect(native.writes).toHaveLength(0)
    native.probeTitle = 'Late native title'
    expect((await f.flow.retry({ runId: run.id })).ok).toBe(true)
    await vi.waitFor(() =>
      expect(native.names.get(run.nativeSessionId!)).toBe('[Pact] Project · Late native title'),
    )
    expect(f.title()).toBe('Late native title')
    expect(native.runs).toBe(2)
  })

  it('does not decorate an unsaved first title after persistence failure', async () => {
    const f = await fixture()
    await f.send('claude')
    const save = f.db.conversationRepository.applyEvent.bind(f.db.conversationRepository)
    const apply = vi
      .spyOn(f.db.conversationRepository, 'applyEvent')
      .mockImplementation((sid, rid, event) => {
        if (event.type === 'session.title.updated' && event.agentId === 'codex')
          throw new Error('Fixture title save failed')
        return save(sid, rid, event)
      })
    const run = await f.send()
    await new Promise<void>((done) => setImmediate(done))
    expect(native.writes).toHaveLength(0)
    expect(f.title()).toBe('Claude generated title')
    apply.mockImplementation(save)
    native.probeTitle = 'Codex generated title'
    expect((await f.flow.retry({ runId: run.id })).ok).toBe(true)
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    expect(f.title()).toBe('Codex generated title')
  })

  it('ACKs manual rename immediately, coalesces more than three revisions and retains user priority', async () => {
    const f = await fixture()
    await f.send()
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    native.hold = true
    expect(f.workspace.rename({ sessionId: f.sessionId, title: 'Alpha' }).ok).toBe(true)
    for (const title of ['Beta', 'Gamma', 'Delta', 'Final']) {
      const previous = native.pending[0]!
      expect(f.workspace.rename({ sessionId: f.sessionId, title }).ok).toBe(true)
      expect(f.title()).toBe(title)
      expect(previous.input.isCurrent()).toBe(false)
      previous.release()
      // oxlint-disable-next-line no-await-in-loop -- Release one transport phase before the next title is committed.
      await vi.waitFor(() =>
        expect(native.pending[0]?.input.title).toBe(`[Pact] Project · ${title}`),
      )
    }
    native.pending[0]!.release()
    await vi.waitFor(() => expect(native.naming).toBe(0))
    expect(native.names.get(`codex:${f.sessionId}`)).toBe('[Pact] Project · Final')
    expect(native.highWater).toBe(1)
    native.hold = false
    native.probeTitle = 'Late agent suggestion'
    const run = f.db.conversationRepository.latestAgentRun(f.sessionId, 'codex')!
    expect((await f.flow.retry({ runId: run.id })).ok).toBe(true)
    expect(f.title()).toBe('Final')
    expect(native.runs).toBe(1)
  })

  it('fences a stale pending rename and aborts metadata before disposing its Adapter', async () => {
    const f = await fixture()
    await f.send()
    await vi.waitFor(() => expect(native.writes).toHaveLength(1))
    native.hold = true
    expect(f.workspace.rename({ sessionId: f.sessionId, title: 'Old pending' }).ok).toBe(true)
    const old = native.pending[0]!
    expect(f.workspace.rename({ sessionId: f.sessionId, title: 'Newest saved' }).ok).toBe(true)
    expect(old.input.isCurrent()).toBe(false)
    old.release()
    await vi.waitFor(() =>
      expect(native.pending[0]?.input.title).toBe('[Pact] Project · Newest saved'),
    )
    await f.flow.dispose()
    expect(f.title()).toBe('Newest saved')
    expect(native.pending).toHaveLength(0)
    expect(native.naming).toBe(0)
    expect(native.disposedWhileNaming).toBe(0)
    expect(f.flow.diagnostics().adapterSlots).toBe(0)
  })

  it('saves a manual title without Native creation, then reconciles on the first normal Run', async () => {
    const f = await fixture()
    expect(f.workspace.rename({ sessionId: f.sessionId, title: 'Before Native' }).ok).toBe(true)
    expect(native.created).toBe(0)
    expect(native.writes).toHaveLength(0)
    await f.send()
    await vi.waitFor(() =>
      expect(native.names.get(`codex:${f.sessionId}`)).toBe('[Pact] Project · Before Native'),
    )
    expect(f.title()).toBe('Before Native')
    expect(native.runs).toBe(1)
  })
})
