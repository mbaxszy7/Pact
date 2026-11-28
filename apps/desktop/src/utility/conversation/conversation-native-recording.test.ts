import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type {
  AgentRunInput,
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
} from '@pact/agent-runtime'
import type {
  ConversationPatch,
  DefaultSessionSettings,
  NativeContextRebuildChunk,
  NormalizedAgentEvent,
  RuntimeAgentId,
} from '@pact/contracts'

import { isConversationBackgroundReport } from '@pact/contracts'
import {
  agentEventJournal,
  agentRuns,
  conversationMessages,
  nativeAgentContexts,
  PactDatabase,
} from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { WorkspaceChanges } from '../workspace-changes/workspace-changes.js'
import { NativeCapacityError } from './agent-execution-error.js'
import { Conversation } from './conversation.js'

const native = vi.hoisted(() => ({
  inputs: new Map<string, AgentRunInput>(),
  background: new Set<string>(),
  extraBackground: 0,
  actors: 0,
  disposed: 0,
  retainNext: false,
  terminalGate: undefined as Promise<void> | undefined,
  unavailableReport: false,
  customRun: undefined as
    | ((
        agentId: RuntimeAgentId,
        executorId: string,
        input: AgentRunInput,
        signal: AbortSignal,
      ) => AsyncIterable<NormalizedAgentEvent>)
    | undefined,
  inspect:
    vi.fn<
      (
        input: AgentNativeContextRebuildInput,
        source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
        signal: AbortSignal,
      ) => Promise<AgentNativeContextRebuildResult | undefined>
    >(),
}))

async function* scriptedRun(
  agentId: RuntimeAgentId,
  executorId: string,
  input: AgentRunInput,
  signal: AbortSignal,
): AsyncIterable<NormalizedAgentEvent> {
  if (native.customRun) {
    yield* native.customRun(agentId, executorId, input, signal)
    return
  }
  if (native.background.size + native.extraBackground >= 8)
    throw new NativeCapacityError(
      'All eight native background contexts are occupied; no native actor was created.',
    )
  native.actors += 1
  native.inputs.set(input.runId, input)
  input.host?.lifecycle?.recordExecutor?.(executorId)
  const nativeSessionId = input.nativeSessionId ?? `native:${input.sessionId}`
  input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
  yield { type: 'session.started', agentId, nativeSessionId }
  input.host?.lifecycle?.recordDispatch?.('accepted', nativeSessionId, executorId)
  yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
  const path = `file-${native.actors}.ts`
  await writeFile(join(input.cwd, path), 'export const value = 1\n')
  await input.host?.effects?.recordFileChange?.(
    {
      operationId: randomUUID(),
      path,
      kind: 'modified',
      before: 'export const value = 0\n',
      after: 'export const value = 1\n',
    },
    signal,
  )
  if (native.actors === 1 || native.retainNext) native.background.add(input.runId)
  yield {
    type: 'text.completed',
    agentId,
    turnId: `turn:${input.runId}`,
    outputId: 'answer',
    text: 'Changes are recorded. The development server may continue in the background.',
  }
  if (native.terminalGate) await native.terminalGate
  yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
  if (native.unavailableReport && agentId === 'claude')
    input.host?.effects?.recordBackgroundReportUnavailable?.({
      agentId,
      runId: input.runId,
      nativeSessionId,
      nativeTurnId: `turn:${input.runId}`,
      bindingGeneration: input.bindingGeneration!,
      executorId,
      frameId: randomUUID(),
      nativeMessageId: 'owned-unavailable-report',
    })
  if (!native.background.has(input.runId))
    input.host?.effects?.reportNativeEffects?.({
      runId: input.runId,
      generation: input.nativeGeneration!,
      state: 'settled',
    })
}

vi.mock('./codex-agent-adapter.js', () => ({
  CodexAgentAdapter: class {
    readonly id = 'codex' as const
    readonly executorId = randomUUID()
    inspectNativeRebuild = native.inspect
    beginNativeRebuildCheck(
      input: AgentNativeContextRebuildInput,
      source: AsyncIterable<NativeContextRebuildChunk>,
      signal: AbortSignal,
    ) {
      const result = this.inspectNativeRebuild(input, source, signal)
      return {
        result,
        physicalCompletion: result.then(
          () => undefined,
          () => undefined,
        ),
      }
    }
    hasActiveBackgroundWork(runId?: string) {
      return runId
        ? native.background.has(runId)
        : native.background.size + native.extraBackground > 0
    }
    backgroundWork(runId: string, executorId: string) {
      return executorId === this.executorId && native.background.has(runId)
        ? ('working' as const)
        : undefined
    }
    run(input: AgentRunInput, signal: AbortSignal) {
      return scriptedRun(this.id, this.executorId, input, signal)
    }
    async dispose() {
      native.disposed += 1
      native.background.clear()
    }
  },
}))
vi.mock('./claude-agent-adapter.js', () => ({
  ClaudeAgentAdapter: class {
    readonly id = 'claude' as const
    readonly executorId = randomUUID()
    hasActiveBackgroundWork(runId?: string) {
      return runId
        ? native.background.has(runId)
        : native.background.size + native.extraBackground > 0
    }
    backgroundWork(runId: string, executorId: string) {
      return executorId === this.executorId && native.background.has(runId)
        ? ('working' as const)
        : undefined
    }
    run(input: AgentRunInput, signal: AbortSignal) {
      return scriptedRun(this.id, this.executorId, input, signal)
    }
    async dispose() {
      native.disposed += 1
      native.background.clear()
    }
  },
}))

afterEach(() => {
  native.inputs.clear()
  native.background.clear()
  native.extraBackground = 0
  native.actors = 0
  native.disposed = 0
  native.retainNext = false
  native.terminalGate = undefined
  native.unavailableReport = false
  native.customRun = undefined
  native.inspect.mockReset()
})

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  secondaryAgentId: 'claude',
  agents: {
    codex: { model: null, effort: null },
    claude: { model: null, effort: null },
    agy: { model: null, effort: null },
  },
  maxDiscussionRounds: 3,

  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}

function saveOriginalTask(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  const repo = f.db.conversationRepository
  const started = repo.beginRun({
    sessionId: f.sessionId,
    clientMessageId: randomUUID(),
    content,
    expectedCommentsRevision: 0,
    commentIds: [],
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  const nativeSessionId = 'saved-original-context',
    nativeTurnId = 'saved-original-turn'
  repo.applyEvent(f.sessionId, started.run.id, {
    type: 'session.started',
    agentId: 'codex',
    nativeSessionId,
  })
  repo.applyEvent(f.sessionId, started.run.id, {
    type: 'turn.started',
    agentId: 'codex',
    turnId: nativeTurnId,
  })
  repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome: 'completed',
    identity: {
      sessionId: f.sessionId,
      agentId: 'codex',
      requestId: started.run.id,
      runId: started.run.id,
      nativeSessionId,
      nativeTurnId,
      bindingGeneration: 1,
    },
  })
  repo.applyEvent(f.sessionId, started.run.id, {
    type: 'turn.completed',
    agentId: 'codex',
    turnId: nativeTurnId,
    outcome: 'completed',
  })
  repo.recordNativeEffects(started.run.id, 'settled')
  return started
}

it('refuses Undo while native work continues without a recording reservation', async () => {
  const f = await fixture('codex')
  try {
    const firstId = await f.send()
    f.endBackground(firstId)
    await vi.waitFor(() => expect(f.workspace.summary(firstId)?.state).toBe('ready'), {
      timeout: 10_000,
    })
    vi.spyOn(f.workspace, 'start').mockResolvedValue('Recording preparation failed.')
    native.retainNext = true
    const secondId = await f.send()
    expect(f.db.conversationRepository.findRun(secondId)?.nativeEffectsState).toBe('pending')
    expect(f.workspace.summary(secondId)).toBeUndefined()
    const path = join(f.projectDirectory, 'file-1.ts')
    const original = await readFile(path, 'utf8')
    const result = await f.flow.undoWorkspaceChanges({ changeSetId: firstId })
    const current = await readFile(path, 'utf8')
    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_BUSY' } })
    expect(current).toBe(original)
  } finally {
    await f.dispose()
  }
}, 30_000)

it('offers a newly confirmed creation after an unconfirmed candidate cannot be verified', async () => {
  const f = await fixture('codex')
  try {
    const repo = f.db.conversationRepository
    const original = saveOriginalTask(f, 'Saved original task')
    const id = randomUUID()
    repo.beginNativeRebuild({
      id,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    const chunks: NativeContextRebuildChunk[] = []
    const sourceRevisions = new Map<string, number>()
    for await (const chunk of repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      id,
      sourceRevisions,
    ))
      chunks.push(chunk)
    repo.freezeNativeRebuildSource(id, chunks, sourceRevisions)
    const observed: import('@pact/contracts').NativeContextRebuildChunk[] = []
    native.inspect.mockImplementation(async (_input, source) => {
      for await (const chunk of source) observed.push(chunk)
      return undefined
    })
    repo.markNativeRebuildDispatched(id)
    repo.recordNativeRebuildIdentity(id, 'unconfirmed-candidate')
    repo.failNativeRebuild(id, 'Initialization reply lost.')
    vi.spyOn(f.preparation, 'findRecoveryExecutable').mockResolvedValue('/fixture/codex')
    const result = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'codex',
      intent: 'inspect',
      clientOperationId: id,
      expectedGeneration: 1,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' } })
    expect(native.inspect).toHaveBeenCalledTimes(1)
    expect(native.inspect.mock.calls[0]?.[0]).toMatchObject({
      rebuildId: id,
      nativeSessionId: 'unconfirmed-candidate',
      sourceHash: repo.nativeRebuildOperation(id)?.sourceHash,
    })
    expect(observed).toEqual(chunks)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      messageId: original.run.userMessageId,
      content: 'Saved original task',
      final: false,
    })
    expect(chunks[1]).toMatchObject({
      messageId: original.run.userMessageId,
      final: true,
      content: expect.stringContaining(repo.inputBatchForRun(original.run.id)!.id),
    })
    const batch = repo.readFrozenInputBatch(
      original.run.id,
      repo.inputBatchForRun(original.run.id)!.id,
    )
    expect(batch.batch.memberCount).toBe(0)
    expect(batch.body?.chars).toBe('Saved original task'.length)
    expect(
      repo.readPage({
        scope: 'collaboration-text',
        sessionId: f.sessionId,
        runId: original.run.id,
        document: batch.body!,
        offset: 0,
      }),
    ).toMatchObject({ text: 'Saved original task' })
    expect(native.actors).toBe(0)
    expect(repo.read(f.sessionId).runs).toHaveLength(1)
    const loaded = await f.flow.load({ scope: 'messages', sessionId: f.sessionId })
    expect(loaded).toMatchObject({
      ok: true,
      value: { header: { sessionIssues: { agents: [{ action: 'rebuild' }] } } },
    })
  } finally {
    await f.dispose()
  }
})

it('does not let an old candidate check alter a newer recovery operation', async () => {
  const f = await fixture('codex')
  const inspected = Promise.withResolvers<AgentNativeContextRebuildResult | undefined>()
  try {
    const repo = f.db.conversationRepository,
      id = randomUUID()
    const original = saveOriginalTask(f, 'Saved task')
    repo.beginNativeRebuild({
      id,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    const chunks: NativeContextRebuildChunk[] = []
    const sourceRevisions = new Map<string, number>()
    for await (const chunk of repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      id,
      sourceRevisions,
    ))
      chunks.push(chunk)
    repo.freezeNativeRebuildSource(id, chunks, sourceRevisions)
    repo.markNativeRebuildDispatched(id)
    repo.recordNativeRebuildIdentity(id, 'candidate')
    repo.failNativeRebuild(id, 'Reply lost')
    vi.spyOn(f.preparation, 'findRecoveryExecutable').mockResolvedValue('/fixture/codex')
    native.inspect.mockReturnValue(inspected.promise)
    const checking = f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'codex',
      intent: 'inspect',
      clientOperationId: id,
      expectedGeneration: 1,
    })
    await vi.waitFor(() => expect(native.inspect).toHaveBeenCalledOnce())
    expect(native.inspect.mock.calls[0]?.[0]).toMatchObject({
      rebuildId: id,
      nativeSessionId: 'candidate',
      sourceHash: repo.nativeRebuildOperation(id)?.sourceHash,
    })
    expect(await f.flow.load({ scope: 'messages', sessionId: f.sessionId })).toMatchObject({
      ok: true,
      value: { header: { sessionIssues: { agents: [{ phase: 'checking', action: 'none' }] } } },
    })
    const next = randomUUID()
    repo.beginNativeRebuild({
      id: next,
      sessionId: f.sessionId,
      agentId: 'codex',
      expectedGeneration: 1,
      abandon: false,
    })
    inspected.resolve(undefined)
    expect(await checking).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(repo.nativeRebuildOperation(next)?.stage).toBe('preparing')
    expect(repo.nativeRebuildOperation(id)?.stage).toBe('superseded')
    expect(repo.nativeRebuildOperation(id)?.provisionalNativeSessionId).toBe('candidate')
    expect(repo.nativeRebuildOperation(next)?.provisionalNativeSessionId).toBeUndefined()
    expect(repo.internalMessage(original.run.userMessageId, f.sessionId)?.content).toBe(
      'Saved task',
    )
    expect(native.actors).toBe(0)
    expect(repo.read(f.sessionId).runs).toHaveLength(1)
  } finally {
    inspected.resolve(undefined)
    await f.dispose()
  }
})

async function fixture(agentId: RuntimeAgentId) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pact-native-recording-')))
  const projectDirectory = join(directory, 'project')
  await mkdir(projectDirectory)
  await writeFile(join(projectDirectory, 'file-1.ts'), 'export const value = 0\n')
  await writeFile(join(projectDirectory, 'file-2.ts'), 'export const value = 0\n')
  await writeFile(join(projectDirectory, 'late.ts'), 'export const late = false\n')
  const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
  const projectId = randomUUID(),
    sessionId = randomUUID(),
    timestamp = new Date().toISOString()
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Native recording',
    directoryPath: projectDirectory,
    kind: 'directory',
    createdAt: timestamp,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Fixture', createdAt: timestamp },
    {
      ...settings,
      primaryAgentId: agentId,
      secondaryAgentId: agentId === 'claude' ? 'codex' : 'claude',
    },
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          state: 'ready',
          executablePath: '/fixture/codex',
          checkedAt: timestamp,
        },
        {
          agentId: 'claude',
          state: 'ready',
          executablePath: '/fixture/claude',
          checkedAt: timestamp,
        },
      ],
    },
  })
  const workspace = new WorkspaceChanges(
    db.workspaceChangesRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    join(directory, 'storage'),
    runDirectoryWorker,
  )
  await workspace.initialize()
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
    workspace,
  )
  const patches: ConversationPatch[] = []
  const unsubscribe = flow.subscribe((patch) => patches.push(patch))
  const send = async () => {
    const drafts = await flow.load({ scope: 'drafts', sessionId })
    if (!drafts.ok || drafts.value.scope !== 'drafts') throw new Error('Draft fixture missing')
    const sent = await flow.send({
      sessionId,
      clientMessageId: randomUUID(),
      content: 'Edit a file and preserve background work.',
      expectedCommentsRevision: drafts.value.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId },
    })
    if (!sent.ok) throw new Error(sent.error.message)
    const runId = sent.value.runs[0]?.id
    if (!runId) throw new Error('Run fixture missing')
    // This fixture awaits real directory Worker I/O, whose own deadline is 5 seconds.
    // Vitest's 1-second polling default is not a product latency requirement.
    await vi.waitFor(() => expect(flow.diagnostics().activeExecutions).toBe(0), {
      timeout: 10_000,
    })
    return runId
  }
  const endBackground = (runId: string) => {
    native.background.delete(runId)
    const input = native.inputs.get(runId)!
    input.host?.effects?.reportNativeEffects?.({
      runId,
      generation: input.nativeGeneration!,
      state: 'settled',
    })
  }
  return {
    db,
    flow,
    workspace,
    send,
    preparation,
    endBackground,
    sessionId,
    projectDirectory,
    patches,
    async dispose() {
      unsubscribe()
      try {
        await flow.dispose()
      } finally {
        try {
          await workspace.dispose()
        } finally {
          db.close()
          await rm(directory, { recursive: true, force: true })
        }
      }
    },
  }
}

it.each(['codex', 'claude'] as const)(
  '%s publishes root-ended recording, permits another Send, and settles only on real background EOF',
  async (agentId) => {
    const f = await fixture(agentId)
    try {
      const firstId = await f.send()
      const first = f.db.conversationRepository.findRun(firstId)!
      expect(first).toMatchObject({
        dispatchPhase: 'ended',
        nativeOutcome: 'completed',
        nativeEffectsState: 'pending',
        workspaceChanges: { state: 'recording', fileCount: 1, finalizedAt: null },
      })
      expect(
        f.patches.some((patch) =>
          patch.runs.some(
            (run) => run.id === firstId && run.workspaceChanges?.state === 'recording',
          ),
        ),
      ).toBe(true)
      expect(
        f.db.conversationRepository.nativeContext(f.sessionId, agentId)?.continuationState,
      ).toBe('ready')
      expect(native.background.has(firstId)).toBe(true)
      expect(await f.flow.undoWorkspaceChanges({ changeSetId: firstId })).toMatchObject({
        ok: false,
        error: { code: 'WORKSPACE_BUSY' },
      })
      const secondId = await f.send()
      expect(secondId).not.toBe(firstId)
      expect(native.actors).toBe(2)
      expect(native.background.has(firstId)).toBe(true)
      const revision = f.workspace.summary(firstId)!.revision!
      const input = native.inputs.get(firstId)!
      await writeFile(join(f.projectDirectory, 'late.ts'), 'export const late = true\n')
      await input.host?.effects?.recordFileChange!(
        {
          operationId: randomUUID(),
          path: 'late.ts',
          kind: 'modified',
          before: 'export const late = false\n',
          after: 'export const late = true\n',
        },
        new AbortController().signal,
      )
      const recorded = f.db.conversationRepository.findRun(firstId)!.workspaceChanges!
      expect(recorded).toMatchObject({ state: 'recording', fileCount: 2, finalizedAt: null })
      expect(recorded.revision).toBeGreaterThan(revision)
      await writeFile(join(f.projectDirectory, 'file-1.ts'), 'export const value = 2\n')
      await input.host?.effects?.recordFileChange!(
        {
          operationId: randomUUID(),
          path: 'file-1.ts',
          kind: 'modified',
          before: 'export const value = 1\n',
          after: 'export const value = 2\n',
        },
        new AbortController().signal,
      )
      const sameCounts = f.db.conversationRepository.findRun(firstId)!.workspaceChanges!
      expect({
        files: sameCounts.fileCount,
        additions: sameCounts.additions,
        deletions: sameCounts.deletions,
      }).toEqual({
        files: recorded.fileCount,
        additions: recorded.additions,
        deletions: recorded.deletions,
      })
      expect(sameCounts.revision).toBeGreaterThan(recorded.revision!)
      const readable = f.flow.readWorkspaceChanges({ changeSetId: firstId })
      expect(readable).toMatchObject({
        ok: true,
        value: { changeSet: { revision: sameCounts.revision, fileCount: 2 } },
      })
      expect(await f.flow.undoWorkspaceChanges({ changeSetId: firstId })).toMatchObject({
        ok: false,
        error: { code: 'WORKSPACE_BUSY' },
      })
      const endingsBefore = f.db.drizzle
        .select()
        .from(agentEventJournal)
        .all()
        .filter((event) => event.eventType === 'turn.completed').length
      f.endBackground(firstId)
      await vi.waitFor(
        () =>
          expect(f.db.conversationRepository.findRun(firstId)?.workspaceChanges?.state).toBe(
            'ready',
          ),
        { timeout: 10_000 },
      )
      expect(f.db.conversationRepository.findRun(firstId)?.nativeEffectsState).toBe('settled')
      expect(
        f.db.drizzle
          .select()
          .from(agentEventJournal)
          .all()
          .filter((event) => event.eventType === 'turn.completed'),
      ).toHaveLength(endingsBefore)
      expect(
        f.db.conversationRepository.nativeContext(f.sessionId, agentId)?.continuationState,
      ).toBe('ready')
    } finally {
      await f.dispose()
    }
  },
  // Root ending and Composer admission are checked earlier; this wait covers
  // asynchronous immutable-file finalization after actual background EOF.
  30_000,
)

it('persists an attributed unavailable report without changing the completed root or work outcome', async () => {
  const f = await fixture('claude')
  native.unavailableReport = true
  try {
    const id = await f.send()
    const saved = f.db.conversationRepository.read(f.sessionId)
    const report = saved.messages.find(isConversationBackgroundReport)
    expect(report).toMatchObject({
      sourceMessageId: saved.runs[0]!.userMessageId,
      role: 'assistant',
      agentId: 'claude',
      state: 'incomplete',
      content: '',
    })
    const root = saved.messages.find(
      (message) => message.runId === id && message.role === 'assistant',
    )
    expect(root?.state).toBe('complete')
    expect(root?.content).toContain('Changes are recorded.')
    expect(saved.runs[0]).toMatchObject({
      nativeOutcome: 'completed',
      nativeEffectsState: 'pending',
    })
    f.endBackground(id)
    expect(f.db.conversationRepository.findRun(id)?.nativeEffectsState).toBe('settled')
    expect(native.actors).toBe(1)
  } finally {
    await f.dispose()
  }
})

it('pauses the original foreground queue when its retained observer later loses work evidence', async () => {
  const f = await fixture('codex')
  const terminal = Promise.withResolvers<void>()
  native.terminalGate = terminal.promise
  try {
    const first = f.send()
    await vi.waitFor(() => expect(native.inputs.size).toBe(1))
    const input = [...native.inputs.values()][0]!
    const queuedId = randomUUID()
    const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
    const accepted = await f.flow.send({
      sessionId: f.sessionId,
      clientMessageId: queuedId,
      content: 'Keep this queued source intact.',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    expect(accepted).toMatchObject({ ok: true })
    terminal.resolve()
    await first
    expect(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: queuedId,
      state: 'queued',
    })
    input.host?.effects?.reportNativeEffects!({
      runId: input.runId,
      generation: input.nativeGeneration!,
      state: 'unknown',
      reason: 'native_observation_lost',
    })
    expect(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: queuedId,
      state: 'paused',
    })
    expect(f.db.conversationRepository.readReceivedInput(f.sessionId)?.content).toBe(
      'Keep this queued source intact.',
    )
    expect(native.actors).toBe(1)
  } finally {
    terminal.resolve()
    await f.dispose()
  }
})

it('never auto-dispatches a peer-anchored queue while another current background owner is unknown', async () => {
  const f = await fixture('codex')
  const terminal = Promise.withResolvers<void>()
  try {
    await writeFile(join(f.projectDirectory, 'file-3.ts'), 'export const value = 0\n')
    const original = await f.send()
    const sendToClaude = async (content: string) => {
      const drafts = f.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f.sessionId,
      })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
      return f.flow.send({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content,
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'claude' },
      })
    }
    native.terminalGate = terminal.promise
    const peer = await sendToClaude('Complete the independent peer response.')
    expect(peer).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(native.actors).toBe(2))
    const queued = await sendToClaude('Keep this later peer input frozen.')
    expect(queued).toMatchObject({ ok: true })
    const queuedId = f.db.conversationRepository.queueState(f.sessionId).input!.id
    const input = native.inputs.get(original)!
    native.background.delete(original)
    input.host?.effects?.reportNativeEffects!({
      runId: original,
      generation: input.nativeGeneration!,
      state: 'unknown',
      reason: 'native_connection_lost',
    })
    terminal.resolve()
    await vi.waitFor(() => expect(f.flow.diagnostics().activeExecutions).toBe(0), {
      timeout: 10_000,
    })
    await vi.waitFor(() => {
      expect(
        native.actors > 2 ||
          f.db.conversationRepository.queueState(f.sessionId).input?.state === 'paused',
      ).toBe(true)
    })
    expect(native.actors).toBe(2)
    expect(f.db.conversationRepository.readReceivedInput(f.sessionId)?.content).toBe(
      'Keep this later peer input frozen.',
    )
    const state = f.db.conversationRepository.queueState(f.sessionId)
    expect(state.input).toMatchObject({ id: queuedId, state: 'paused' })
    // A direct/stale Resume must not bypass the shared execution-admission gate.
    f.flow.resumeConversationQueue({
      sessionId: f.sessionId,
      inputId: queuedId,
      operationId: randomUUID(),
      expectedRevision: state.revision,
    })
    await vi.waitFor(() => {
      expect(
        native.actors > 2 ||
          f.db.conversationRepository.queueState(f.sessionId).input?.state === 'paused',
      ).toBe(true)
    })
    expect(native.actors).toBe(2)
    expect(f.db.conversationRepository.queueState(f.sessionId).input).toMatchObject({
      id: queuedId,
      state: 'paused',
    })
    expect(f.db.conversationRepository.findRun(original)?.nativeEffectsState).toBe('unknown')
  } finally {
    terminal.resolve()
    await f.dispose()
  }
}, 30_000)

it('keeps unknown current background work visible and blocks Send after a newer unsent refusal', async () => {
  const f = await fixture('codex')
  try {
    const original = await f.send()
    native.extraBackground = 7
    const refused = await f.send()
    expect(f.db.conversationRepository.findRun(refused)?.dispatchPhase).toBe('not_sent')
    native.extraBackground = 0
    const input = native.inputs.get(original)!
    input.host?.effects?.reportNativeEffects!({
      runId: original,
      generation: input.nativeGeneration!,
      state: 'unknown',
      reason: 'native_observation_lost',
    })
    const page = await f.flow.load({ scope: 'messages', sessionId: f.sessionId })
    if (!page.ok || page.value.scope !== 'messages') throw new Error('Missing message view')
    expect(page.value.header.sessionIssues).toMatchObject({
      inputGate: 'send_blocked',
      agents: [expect.objectContaining({ runId: original, phase: 'background_check' })],
    })
    const drafts = f.db.conversationRepository.readPage({ scope: 'drafts', sessionId: f.sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
    const sent = await f.flow.send({
      sessionId: f.sessionId,
      clientMessageId: randomUUID(),
      content: 'This must remain unsent until recovery.',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    expect(sent).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('background work') },
    })
    expect(native.actors).toBe(1)
    expect(f.db.conversationRepository.findRun(original)?.nativeEffectsState).toBe('unknown')
  } finally {
    native.extraBackground = 0
    await f.dispose()
  }
})

it.each([
  ['interrupted', 'incomplete', undefined],
  ['interrupted', 'complete', undefined],
  ['failed', 'incomplete', undefined],
  ['failed', 'complete', undefined],
  ['failed', 'complete', 'response_too_large'],
] as const)(
  'keeps %s roots with %s output and unknown work behind the same recovery gate',
  async (status, bodyState, failureKind) => {
    const f = await fixture('codex')
    try {
      const original = await f.send()
      const repo = f.db.conversationRepository
      const response = repo
        .read(f.sessionId)
        .messages.find((message) => message.runId === original && message.role === 'assistant')!
      f.db.drizzle
        .update(agentRuns)
        .set({ status, nativeOutcome: status, ...(failureKind ? { failureKind } : {}) })
        .where(eq(agentRuns.id, original))
        .run()
      f.db.drizzle
        .update(conversationMessages)
        .set({ state: bodyState })
        .where(eq(conversationMessages.id, response.id))
        .run()
      native.background.delete(original)
      repo.recordNativeEffects(original, 'unknown', 'pact_restarted')
      for (const action of ['retry_check', 'rebuild'] as const) {
        if (action === 'rebuild')
          repo.recordNativeEffects(original, 'unknown', 'background_check_unconfirmed')
        // oxlint-disable-next-line eslint/no-await-in-loop -- Observe this exact cursor before and after its ordered recovery fact.
        const page = await f.flow.load({ scope: 'messages', sessionId: f.sessionId })
        if (!page.ok || page.value.scope !== 'messages') throw new Error('Missing message view')
        expect(page.value.header.sessionIssues).toMatchObject({
          inputGate: 'send_blocked',
          agents: [expect.objectContaining({ runId: original, phase: 'background_check', action })],
        })
      }
      const drafts = repo.readPage({ scope: 'drafts', sessionId: f.sessionId })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
      const sent = await f.flow.send({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Keep this draft until native work is confirmed.',
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
      })
      expect(sent).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
      expect(repo.read(f.sessionId).runs).toHaveLength(1)
      expect(native.actors).toBe(1)
    } finally {
      await f.dispose()
    }
  },
)

it.each(['missing', 'changed'] as const)(
  'keeps a current background cursor blocked when executor authority is %s',
  async (authority) => {
    const f = await fixture('codex')
    try {
      const original = await f.send()
      // A pre-executor stored cursor has native identity but no process-control receipt.
      if (authority === 'missing')
        f.db.drizzle
          .update(agentRuns)
          .set({ executorId: null })
          .where(eq(agentRuns.id, original))
          .run()
      f.db.drizzle
        .update(nativeAgentContexts)
        .set({ executorId: authority === 'missing' ? null : randomUUID() })
        .where(eq(nativeAgentContexts.sessionId, f.sessionId))
        .run()
      const page = await f.flow.load({ scope: 'messages', sessionId: f.sessionId })
      if (!page.ok || page.value.scope !== 'messages') throw new Error('Missing message view')
      expect(page.value.header.sessionIssues).toMatchObject({
        inputGate: 'send_blocked',
        agents: [expect.objectContaining({ runId: original, phase: 'background_check' })],
      })
      expect(page.value.header.sessionIssues?.agents[0]?.backgroundStop).toBeUndefined()
      const drafts = f.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f.sessionId,
      })
      if (drafts.scope !== 'drafts') throw new Error('Missing draft revision')
      const sent = await f.flow.send({
        sessionId: f.sessionId,
        clientMessageId: randomUUID(),
        content: 'Do not bypass unclassified native work.',
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
      })
      expect(sent).toMatchObject({
        ok: false,
        error: { message: expect.stringContaining('background work') },
      })
      expect(native.actors).toBe(1)
      expect(f.db.conversationRepository.findRun(original)?.nativeEffectsState).toBe('pending')
    } finally {
      await f.dispose()
    }
  },
)

it.each(['codex', 'claude'] as const)(
  '%s keeps the ready binding and old background work after an eight-context pre-start refusal; a newly sent task starts once',
  async (agentId) => {
    const f = await fixture(agentId)
    try {
      const firstId = await f.send()
      const binding = f.db.conversationRepository.nativeContext(f.sessionId, agentId)!
      native.extraBackground = 7
      const refusedId = await f.send()
      expect(native.actors).toBe(1)
      expect(native.inputs.has(refusedId)).toBe(false)
      expect(native.disposed).toBe(0)
      expect(native.background.has(firstId)).toBe(true)
      expect(f.db.conversationRepository.findRun(refusedId)).toMatchObject({
        status: 'failed',
        dispatchPhase: 'not_sent',
        nativeEffectsState: 'not_dispatched',
      })
      expect(f.db.conversationRepository.findRun(refusedId)?.executorId).toBeUndefined()
      expect(f.db.conversationRepository.nativeContext(f.sessionId, agentId)).toMatchObject({
        nativeSessionId: binding.nativeSessionId,
        bindingGeneration: binding.bindingGeneration,
        continuationState: 'ready',
      })
      native.extraBackground = 6
      const newRunId = await f.send()
      expect(newRunId).not.toBe(refusedId)
      expect(native.actors).toBe(2)
      expect(f.db.conversationRepository.findRun(refusedId)?.dispatchPhase).toBe('not_sent')
      expect(native.background.has(firstId)).toBe(true)
      native.extraBackground = 0
      f.endBackground(firstId)
      await vi.waitFor(() => expect(f.workspace.summary(firstId)?.state).toBe('ready'))
    } finally {
      await f.dispose()
    }
  },
)

it.each(['codex', 'claude'] as const)(
  '%s continues native execution when recording startup returns an unavailable reason, without a fake zero-file card',
  async (agentId) => {
    const f = await fixture(agentId)
    const reason =
      'File change recording could not verify this project. Native work continues; these edits cannot be undone in Pact.'
    vi.spyOn(f.workspace, 'start').mockResolvedValue(reason)
    try {
      const runId = await f.send()
      expect(native.actors).toBe(1)
      expect(f.db.conversationRepository.findRun(runId)).toMatchObject({
        status: 'completed',
        nativeOutcome: 'completed',
        dispatchPhase: 'ended',
        workspaceRecordingUnavailableReason: reason,
      })
      expect(f.db.conversationRepository.findRun(runId)?.workspaceChanges).toBeUndefined()
      expect(
        f.patches.some((patch) =>
          patch.runs.some(
            (run) => run.id === runId && run.workspaceRecordingUnavailableReason === reason,
          ),
        ),
      ).toBe(true)
      expect(
        f.db.conversationRepository.nativeContext(f.sessionId, agentId)?.continuationState,
      ).toBe('ready')
      const page = await f.flow.load({ scope: 'messages', sessionId: f.sessionId })
      expect(page).toMatchObject({ ok: true, value: { runArtifacts: [{ latestRunId: runId }] } })
      f.endBackground(runId)
      expect(native.actors).toBe(1)
    } finally {
      await f.dispose()
    }
  },
)

it('S1-F2 & S1-F3: retains observer until foreground exits after Stop+settled and delivers independent background reports after root body failure', async () => {
  // 1. S1-F2: Stop after verified ended evidence, adapter synchronously reports settled BEFORE yielding final text.completed & turn.completed.
  const f1 = await fixture('codex')
  try {
    const pauseBeforeSettled = Promise.withResolvers<void>()
    const reachedPause = Promise.withResolvers<void>()
    native.customRun = async function* (agentId, executorId, input) {
      native.actors += 1
      native.inputs.set(input.runId, input)
      input.host?.lifecycle?.recordExecutor?.(executorId)
      const nativeSessionId = `native:${input.sessionId}`
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
      yield { type: 'session.started', agentId, nativeSessionId }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSessionId, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      yield {
        type: 'text.delta',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Prefix ',
      }
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      reachedPause.resolve()
      await pauseBeforeSettled.promise
      // Adapter synchronously settles effects BEFORE yielding final text.completed & turn.completed
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
        reason: 'native_work_drained',
      })
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Prefix and full verified body.',
      }
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
    }

    const drafts = f1.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f1.sessionId,
    })
    if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
    const sent = await f1.flow.send({
      sessionId: f1.sessionId,
      clientMessageId: randomUUID(),
      content: 'Run stop-before-yield test',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    if (!sent.ok) throw new Error('Expected send to succeed')
    const runId = sent.value.runs[0]!.id
    await reachedPause.promise
    expect(f1.flow.stop({ sessionId: f1.sessionId }).ok).toBe(true)
    pauseBeforeSettled.resolve()
    await vi.waitFor(() =>
      expect(f1.flow.diagnostics()).toMatchObject({
        activeExecutions: 0,
        preparingExecutions: 0,
      }),
    )
    expect(f1.db.conversationRepository.findRun(runId)).toMatchObject({
      nativeOutcome: 'completed',
      nativeEffectsState: 'settled',
    })
    const allMessages = f1.db.conversationRepository.read(f1.sessionId).messages
    expect(allMessages.some((m) => m.content.includes('Prefix and full verified body.'))).toBe(true)
  } finally {
    await f1.dispose()
  }

  // 2. S1-F3: Root body output failure aborts archiveController, yet independent background report still persists.
  const f2 = await fixture('claude')
  try {
    const releaseBg = Promise.withResolvers<void>()
    let savedInput: AgentRunInput | undefined
    let savedExecutorId = ''
    let savedNativeSessionId = ''
    native.customRun = async function* (agentId, executorId, input) {
      native.actors += 1
      native.inputs.set(input.runId, input)
      savedInput = input
      savedExecutorId = executorId
      savedNativeSessionId = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', savedNativeSessionId, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: savedNativeSessionId }
      input.host?.lifecycle?.recordDispatch?.('accepted', savedNativeSessionId, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      // Commit verified terminal receipt first, then corrupt root body archive lane to abort archiveController.
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId: savedNativeSessionId,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      input.host?.effects?.recordArchivedEvent?.({
        type: 'text.delta',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: '',
        text: 'bad-metadata-triggers-root-body-failure',
      })
      await releaseBg.promise
    }
    const drafts2 = f2.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f2.sessionId,
    })
    if (drafts2.scope !== 'drafts') throw new Error('Missing drafts')
    const sent2 = await f2.flow.send({
      sessionId: f2.sessionId,
      clientMessageId: randomUUID(),
      content: 'Run root-body-fail then background report',
      expectedCommentsRevision: drafts2.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent2.ok) throw new Error('Expected send to succeed')
    const runId2 = sent2.value.runs[0]!.id
    await vi.waitFor(() => expect(savedInput).toBeDefined())
    // Deliver independent background report AFTER root body lane failed and aborted archiveController!
    await savedInput!.host!.effects!.recordBackgroundReport!({
      agentId: 'claude',
      runId: runId2,
      nativeSessionId: savedNativeSessionId,
      nativeTurnId: `turn:${runId2}`,
      bindingGeneration: savedInput!.bindingGeneration!,
      executorId: savedExecutorId,
      frameId: randomUUID(),
      nativeMessageId: 'bg-report-after-root-body-fail',
      text: 'Independent background report survived root body failure.',
    })
    releaseBg.resolve()
    native.background.delete(runId2)
    savedInput!.host!.effects!.reportNativeEffects!({
      runId: runId2,
      generation: savedInput!.nativeGeneration!,
      state: 'settled',
    })
    await vi.waitFor(() =>
      expect(f2.flow.diagnostics()).toMatchObject({
        activeExecutions: 0,
        preparingExecutions: 0,
      }),
    )
    const messages2 = f2.db.conversationRepository.read(f2.sessionId).messages
    const reportMsg = messages2.find((m) => isConversationBackgroundReport(m))
    expect(reportMsg).toMatchObject({
      content: 'Independent background report survived root body failure.',
      state: 'complete',
    })
  } finally {
    await f2.dispose()
  }
})

it('A-F6 & A-Advisory2: preserves pending/complete background report on shutdown behind archiveTail, surfaces post-foreground failureRecordingError on close, and keeps cross-Run session sequence strictly ascending', async () => {
  // 1. A-F6a: Background report queued while archiveTail is busy still persists (complete or incomplete) across shutdown.
  const f1 = await fixture('claude')
  try {
    const holdRootBody = Promise.withResolvers<void>()
    let savedInput: AgentRunInput | undefined
    let savedExecutorId = ''
    let savedNativeSessionId = ''
    native.customRun = async function* (agentId, executorId, input) {
      native.actors += 1
      native.inputs.set(input.runId, input)
      savedInput = input
      savedExecutorId = executorId
      savedNativeSessionId = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', savedNativeSessionId, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: savedNativeSessionId }
      input.host?.lifecycle?.recordDispatch?.('accepted', savedNativeSessionId, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId: savedNativeSessionId,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      // Queue a genuinely large (>64 KiB) archived answer so archiveTail is actively running
      input.host?.effects?.recordArchivedEvent?.({
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Root answer body. '.repeat(4500),
      })
      await holdRootBody.promise
    }
    const drafts = f1.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f1.sessionId,
    })
    if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
    const sent = await f1.flow.send({
      sessionId: f1.sessionId,
      clientMessageId: randomUUID(),
      content: 'Shutdown with queued background report',
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent.ok) throw new Error('Expected send to succeed')
    const runId = sent.value.runs[0]!.id
    await vi.waitFor(() => expect(savedInput).toBeDefined())
    const reportPayload = {
      agentId: 'claude' as const,
      runId,
      nativeSessionId: savedNativeSessionId,
      nativeTurnId: `turn:${runId}`,
      bindingGeneration: savedInput!.bindingGeneration!,
      executorId: savedExecutorId,
      frameId: randomUUID(),
      nativeMessageId: 'bg-report-shutdown-behind-archive-tail',
      text: 'Background update during shutdown.',
    }
    // Carbon A-3: Fire two concurrent identical recordBackgroundReport calls while >64 KiB archiveTail runs!
    const reportCallA = savedInput!.host!.effects!.recordBackgroundReport!(reportPayload)
    const reportCallB = savedInput!.host!.effects!.recordBackgroundReport!(reportPayload)
    holdRootBody.resolve()
    await f1.flow.dispose({ flushDeadlineAt: Date.now() + 2000 })
    await Promise.all([reportCallA, reportCallB])
    const messages1 = f1.db.conversationRepository.read(f1.sessionId).messages
    const rootMsg = messages1.find(
      (m) => m.role === 'assistant' && !isConversationBackgroundReport(m),
    )
    const persisted = messages1.find((m) => isConversationBackgroundReport(m))
    expect(rootMsg).toBeDefined()
    expect(persisted).toBeDefined()
    expect(persisted?.state).toBe('complete')
    // Carbon A-3 #1: Background report MUST strictly follow the large root answer in session timeline!
    expect(rootMsg!.sequence).toBeLessThan(persisted!.sequence)
    // Carbon A-3 #2: Concurrent duplicate report must NOT emit fake background.report_unavailable!
    const unavailableEvents = f1.db.drizzle
      .select()
      .from(agentEventJournal)
      .where(eq(agentEventJournal.runId, runId))
      .all()
      .filter((e) => e.eventType === 'background.report_unavailable')
    expect(unavailableEvents).toHaveLength(0)
  } finally {
    await f1.dispose()
  }

  // 2. A-F6b: Post-foreground archive failure whose failure-receipt write also fails still surfaces on close().
  const f2 = await fixture('codex')
  try {
    let savedInput2: AgentRunInput | undefined
    native.customRun = async function* (agentId, executorId, input) {
      native.actors += 1
      native.inputs.set(input.runId, input)
      savedInput2 = input
      const nativeSessionId = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
      yield { type: 'session.started', agentId, nativeSessionId }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSessionId, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Done',
      }
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
    }
    const drafts2 = f2.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f2.sessionId,
    })
    if (drafts2.scope !== 'drafts') throw new Error('Missing drafts')
    const sent2 = await f2.flow.send({
      sessionId: f2.sessionId,
      clientMessageId: randomUUID(),
      content: 'Post-foreground archive failure propagation',
      expectedCommentsRevision: drafts2.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    if (!sent2.ok) throw new Error('Expected send to succeed')
    const runId2 = sent2.value.runs[0]!.id
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))
    const failSpy = vi
      .spyOn(f2.db.conversationRepository, 'recordOutputFailure')
      .mockImplementation(() => {
        throw new Error('Injected SQLite failure-receipt write error')
      })
    try {
      savedInput2!.host!.effects!.recordArchivedEvent!({
        type: 'text.delta',
        agentId: 'codex',
        turnId: `turn:${runId2}`,
        outputId: '',
        text: 'corrupt-late-archive-event',
      })
      native.background.delete(runId2)
      savedInput2!.host!.effects!.reportNativeEffects!({
        runId: runId2,
        generation: savedInput2!.nativeGeneration!,
        state: 'settled',
      })
      await vi.waitFor(() => expect(failSpy).toHaveBeenCalled())
      // Carbon A-4: SQLite MUST record `unknown` (never `settled`) after output archive failure,
      // and archive preview MUST block even before shutdown!
      expect(f2.db.conversationRepository.findRun(runId2)?.nativeEffectsState).toBe('unknown')
      const preview2 = f2.flow.prepareWorkspaceArchive({
        operationId: randomUUID(),
        scope: { kind: 'session', sessionId: f2.sessionId },
      })
      expect(preview2.ok && Boolean(preview2.value.blockedReason)).toBe(true)
      const quitPrep2 = f2.flow.prepareNativeQuit({ operationId: randomUUID() })
      expect(quitPrep2.ok && quitPrep2.value.state).toBe('confirmation_required')
      await expect(f2.flow.dispose({ flushDeadlineAt: Date.now() + 2000 })).rejects.toThrow(
        /could not finish all output commits/u,
      )
    } finally {
      failSpy.mockRestore()
    }
  } finally {
    await f2.dispose().catch(() => undefined)
  }

  // 3. A-Advisory2: Real ConversationRuntimeCore.subscribe sees strictly ascending sequence across old-Run archive & new-Run foreground.
  const f3 = await fixture('codex')
  try {
    const observedSequences: number[] = []
    const unsubscribe = f3.flow.subscribe((patch) => {
      if (patch.sessionId === f3.sessionId) observedSequences.push(patch.observation.sequence)
    })
    try {
      const run1Id = await f3.send()
      const input1 = native.inputs.get(run1Id)!
      // Emit a late archived event from run1 while run2 is running foreground in the same session
      input1.host?.effects?.recordArchivedEvent?.({
        type: 'text.delta',
        agentId: 'codex',
        turnId: `turn:${run1Id}`,
        outputId: 'answer',
        text: ' late-archive-tail',
      })
      f3.endBackground(run1Id)
      await f3.send()
      for (let i = 1; i < observedSequences.length; i += 1) {
        expect(observedSequences[i]!).toBeGreaterThanOrEqual(observedSequences[i - 1]!)
      }
      expect(observedSequences.length).toBeGreaterThan(2)
    } finally {
      unsubscribe()
    }
  } finally {
    await f3.dispose()
  }

  // 4. Carbon A-2 / B-1: Through real RunExecutor + settleKnownNativeEnding, a truncated visible prefix
  // with verified `ended(completed)` + `turn.completed(failed)` keeps `status='failed'` and
  // `nativeOutcome='completed'` while still allowing valid background reports.
  const f4 = await fixture('claude')
  try {
    let savedInput4: AgentRunInput | undefined
    let savedExecutor4 = ''
    let savedNativeSession4 = ''
    native.customRun = async function* (agentId, executorId, input) {
      native.actors += 1
      native.inputs.set(input.runId, input)
      savedInput4 = input
      savedExecutor4 = executorId
      savedNativeSession4 = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', savedNativeSession4, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: savedNativeSession4 }
      input.host?.lifecycle?.recordDispatch?.('accepted', savedNativeSession4, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      yield {
        type: 'text.delta',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Truncated prefix before stop',
      }
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId: savedNativeSession4,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'failed' }
    }
    const drafts4 = f4.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f4.sessionId,
    })
    if (drafts4.scope !== 'drafts') throw new Error('Missing drafts')
    const sent4 = await f4.flow.send({
      sessionId: f4.sessionId,
      clientMessageId: randomUUID(),
      content: 'Truncated stop through real RunExecutor',
      expectedCommentsRevision: drafts4.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent4.ok) throw new Error('Expected send to succeed')
    const runId4 = sent4.value.runs[0]!.id
    await vi.waitFor(() => expect(f4.flow.diagnostics().activeExecutions).toBe(0))
    const settledRun4 = f4.db.conversationRepository.findRun(runId4)
    expect(settledRun4?.status).toBe('failed')
    expect(settledRun4?.nativeOutcome).toBe('completed')
    const assistantMsg4 = f4.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.runId, runId4))
      .all()
      .find((m) => m.role === 'assistant')
    expect(assistantMsg4?.state).toBe('incomplete')
    // Background report still succeeds under monotonic nativeOutcome === 'completed'!
    await savedInput4!.host!.effects!.recordBackgroundReport!({
      agentId: 'claude',
      runId: runId4,
      nativeSessionId: savedNativeSession4,
      nativeTurnId: `turn:${runId4}`,
      bindingGeneration: savedInput4!.bindingGeneration!,
      executorId: savedExecutor4,
      frameId: randomUUID(),
      nativeMessageId: 'bg-report-after-truncated-stop',
      text: 'Late report after truncated stop.',
    })
    const bgMsg4 = f4.db.conversationRepository
      .read(f4.sessionId)
      .messages.find((m) => isConversationBackgroundReport(m))
    expect(bgMsg4?.state).toBe('complete')
    expect(bgMsg4?.content).toContain('Late report after truncated stop.')
    native.background.delete(runId4)
  } finally {
    await f4.dispose()
  }
})
