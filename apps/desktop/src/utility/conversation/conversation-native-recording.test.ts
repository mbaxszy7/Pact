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
import {
  AgentExecutionError,
  NativeCapacityError,
  NativeInputWithheldError,
  PermissionModeRejectedError,
} from './agent-execution-error.js'
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

it('Carbon R2-A1 & R2-A3: lone-surrogate background report degrades with patch, unrecorded background error blocks settled/archive/quit/dispose, and >64 KiB archived answer drains before settleKnownNativeEnding', async () => {
  // 1. R2-A1 Branch A: Lone UTF-16 surrogate in background report publishes unavailable patch + contentRevision=1
  const f1 = await fixture('claude')
  try {
    let savedInput1: AgentRunInput | undefined
    let savedExec1 = ''
    let savedSid1 = ''
    native.customRun = async function* (agentId, executorId, input) {
      savedInput1 = input
      savedExec1 = executorId
      savedSid1 = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', savedSid1, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: savedSid1 }
      input.host?.lifecycle?.recordDispatch?.('accepted', savedSid1, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Root answer',
      }
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
    }
    const patches: Array<{ messages: Array<{ state: string; revision: number }> }> = []
    const unsub = f1.flow.subscribe((p) => {
      patches.push({
        messages: (p.messages ?? []).map((entry) => ({
          state: entry.message.state,
          revision: entry.message.contentRevision,
        })),
      })
    })
    try {
      const drafts = f1.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f1.sessionId,
      })
      if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
      const sent = await f1.flow.send({
        sessionId: f1.sessionId,
        clientMessageId: randomUUID(),
        content: 'Lone surrogate background report test',
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'claude' },
      })
      if (!sent.ok) throw new Error('Expected send to succeed')
      const runId = sent.value.runs[0]!.id
      await vi.waitFor(() => expect(f1.flow.diagnostics().activeExecutions).toBe(0))
      await savedInput1!.host!.effects!.recordBackgroundReport!({
        agentId: 'claude',
        runId,
        nativeSessionId: savedSid1,
        nativeTurnId: `turn:${runId}`,
        bindingGeneration: savedInput1!.bindingGeneration!,
        executorId: savedExec1,
        frameId: randomUUID(),
        nativeMessageId: 'bg-lone-surrogate',
        text: 'bad\uD800surrogate',
      })
      const unavail = f1.db.drizzle
        .select()
        .from(agentEventJournal)
        .where(eq(agentEventJournal.runId, runId))
        .all()
        .filter((e) => e.eventType === 'background.report_unavailable')
      expect(unavail).toHaveLength(1)
      const bgRow = f1.db.drizzle
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.sessionId, f1.sessionId))
        .all()
        .find(
          (m) =>
            m.runId === null &&
            m.role === 'assistant' &&
            m.state === 'incomplete' &&
            m.contentRevision >= 1,
        )
      expect(bgRow).toBeDefined()
      expect(
        patches.some((p) => p.messages.some((m) => m.state === 'incomplete' && m.revision >= 1)),
      ).toBe(true)
      native.background.delete(runId)
    } finally {
      unsub()
    }
  } finally {
    await f1.dispose()
  }

  // 2. R2-A1 Branch B: Unrecorded background report failure propagates, blocks settled/archive/quit/dispose
  const f2 = await fixture('claude')
  try {
    let savedInput2: AgentRunInput | undefined
    let savedExec2 = ''
    let savedSid2 = ''
    native.customRun = async function* (agentId, executorId, input) {
      savedInput2 = input
      savedExec2 = executorId
      savedSid2 = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', savedSid2, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: savedSid2 }
      input.host?.lifecycle?.recordDispatch?.('accepted', savedSid2, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      native.background.add(input.runId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Root done',
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
      content: 'Unrecorded background failure test',
      expectedCommentsRevision: drafts2.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent2.ok) throw new Error('Expected send to succeed')
    const runId2 = sent2.value.runs[0]!.id
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))
    const bgSpy = vi
      .spyOn(f2.db.conversationRepository, 'recordBackgroundReport')
      .mockRejectedValue(new Error('SQLITE_FULL: database or disk is full'))
    const unavailSpy = vi
      .spyOn(f2.db.conversationRepository, 'recordBackgroundReportUnavailable')
      .mockImplementation(() => {
        throw new Error('SQLITE_FULL: database or disk is full')
      })
    try {
      await expect(
        savedInput2!.host!.effects!.recordBackgroundReport!({
          agentId: 'claude',
          runId: runId2,
          nativeSessionId: savedSid2,
          nativeTurnId: `turn:${runId2}`,
          bindingGeneration: savedInput2!.bindingGeneration!,
          executorId: savedExec2,
          frameId: randomUUID(),
          nativeMessageId: 'bg-sqlite-full',
          text: 'Will fail to persist',
        }),
      ).rejects.toThrow(/SQLITE_FULL/u)
      native.background.delete(runId2)
      savedInput2!.host!.effects!.reportNativeEffects!({
        runId: runId2,
        generation: savedInput2!.nativeGeneration!,
        state: 'settled',
      })
      expect(f2.db.conversationRepository.findRun(runId2)?.nativeEffectsState).toBe('unknown')
      const preview = f2.flow.prepareWorkspaceArchive({
        operationId: randomUUID(),
        scope: { kind: 'session', sessionId: f2.sessionId },
      })
      expect(preview.ok && Boolean(preview.value.blockedReason)).toBe(true)
      const quitPrep = f2.flow.prepareNativeQuit({ operationId: randomUUID() })
      expect(quitPrep.ok && quitPrep.value.state).toBe('confirmation_required')
      await expect(f2.flow.dispose({ flushDeadlineAt: Date.now() + 2000 })).rejects.toThrow(
        /could not finish all output commits/u,
      )
    } finally {
      bgSpy.mockRestore()
      unavailSpy.mockRestore()
    }
  } finally {
    await f2.dispose().catch(() => undefined)
  }

  // 3. R2-A3: >64 KiB archived answer + foreground interrupt after ended(completed) drains before settleKnownNativeEnding
  // with zero pact.output_unavailable and no premature finishCollaboration(runId, false).
  const f3 = await fixture('codex')
  try {
    const largeAnswer = 'Archived authoritative answer body. '.repeat(2100) // > 70 KiB
    const finishSpy = vi.spyOn(f3.db.conversationRepository, 'finishCollaboration')
    native.customRun = async function* (agentId, executorId, input) {
      const nativeSid = `native:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSid, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: nativeSid }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSid, executorId)
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
          nativeSessionId: nativeSid,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      // Hand off >64 KiB complete answer + turn.completed via archive channel, then throw interrupted on foreground!
      input.host?.effects?.recordArchivedEvent?.({
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: largeAnswer,
      })
      input.host?.effects?.recordArchivedEvent?.({
        type: 'turn.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outcome: 'completed',
      })
      throw new DOMException('The user stopped foreground streaming.', 'AbortError')
    }
    const drafts3 = f3.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f3.sessionId,
    })
    if (drafts3.scope !== 'drafts') throw new Error('Missing drafts')
    const sent3 = await f3.flow.send({
      sessionId: f3.sessionId,
      clientMessageId: randomUUID(),
      content: 'Large archived snapshot after foreground interrupt',
      expectedCommentsRevision: drafts3.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    if (!sent3.ok) throw new Error('Expected send to succeed')
    const runId3 = sent3.value.runs[0]!.id
    await vi.waitFor(() => expect(f3.flow.diagnostics().activeExecutions).toBe(0))
    const finalRun = f3.db.conversationRepository.findRun(runId3)
    expect(finalRun?.status).toBe('completed')
    expect(finalRun?.failureKind).toBeUndefined()
    const unavailableOutput = f3.db.drizzle
      .select()
      .from(agentEventJournal)
      .where(eq(agentEventJournal.runId, runId3))
      .all()
      .filter((e) => e.eventType === 'pact.output_unavailable')
    expect(unavailableOutput).toHaveLength(0)
    // Must NEVER have invoked finishCollaboration(runId3, false, ...) prematurely!
    const prematureFalse = finishSpy.mock.calls.filter((call) => call[0] === runId3 && !call[1])
    expect(prematureFalse).toHaveLength(0)
    const page3 = f3.db.conversationRepository.readPage({
      scope: 'messages',
      sessionId: f3.sessionId,
    })
    expect(page3.scope).toBe('messages')
    if (page3.scope !== 'messages') throw new Error('expected messages page')
    const visibleAssistant = page3.messages.filter((m) => m.message.role === 'assistant')
    expect(visibleAssistant).toHaveLength(1)
    expect(visibleAssistant[0]?.message.state).toBe('complete')
    finishSpy.mockRestore()
  } finally {
    await f3.dispose()
  }
})

it('Clean User Stop Option 1: enforces stop-vs-completed ordering, freezes UI prefix and Work Log, and never masks real pre-dispatch failures', async () => {
  // 1. Stop BEFORE racing ended/completed: freezes visible text & Work Log, archives full body hidden, zero warning card.
  const f1 = await fixture('codex')
  try {
    const started = Promise.withResolvers<void>()
    const allowFinish = Promise.withResolvers<void>()
    native.customRun = async function* (agentId, executorId, input, signal) {
      const nativeSid = `native-stop-order:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSid, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: nativeSid }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSid, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      yield {
        type: 'text.delta',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Visible prefix before Stop.',
      }
      yield {
        type: 'tool.started',
        agentId,
        turnId: `turn:${input.runId}`,
        toolCallId: 'tool-before-stop',
        toolName: 'exec_command',
        title: 'Running before stop',
      }
      started.resolve()
      await new Promise<void>((done) => {
        if (signal.aborted) done()
        else signal.addEventListener('abort', () => done(), { once: true })
      })
      // Simulate racing post-Stop late delta, late tool, hidden full answer, and racing native completed!
      yield {
        type: 'text.delta',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: ' LATE_DELTA_MUST_NOT_APPEAR',
      }
      yield {
        type: 'tool.started',
        agentId,
        turnId: `turn:${input.runId}`,
        toolCallId: 'tool-after-stop',
        toolName: 'exec_command',
        title: 'Late tool must be suppressed',
      }
      input.host?.effects?.recordArchivedEvent?.({
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Visible prefix before Stop. Full archived native answer.',
      })
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId: nativeSid,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
      allowFinish.resolve()
    }
    const drafts1 = f1.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f1.sessionId,
    })
    if (drafts1.scope !== 'drafts') throw new Error('Missing drafts')
    const sent1 = await f1.flow.send({
      sessionId: f1.sessionId,
      clientMessageId: randomUUID(),
      content: 'Stop before native completion',
      expectedCommentsRevision: drafts1.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    if (!sent1.ok) throw new Error('Expected send to succeed')
    const runId1 = sent1.value.runs[0]!.id
    await started.promise
    await vi.waitFor(() => {
      const p = f1.db.conversationRepository.readPage({
        scope: 'messages',
        sessionId: f1.sessionId,
      })
      expect(
        p.scope === 'messages' &&
          p.messages.some(
            (m) => m.kind === 'complete' && m.message.content.includes('Visible prefix'),
          ),
      ).toBe(true)
    })
    const stopped = f1.flow.stop({ sessionId: f1.sessionId })
    expect(stopped.ok).toBe(true)
    await allowFinish.promise
    await vi.waitFor(() => expect(f1.flow.diagnostics().activeExecutions).toBe(0))

    const run1 = f1.db.conversationRepository.findRun(runId1)!
    expect(run1).toMatchObject({
      status: 'interrupted',
      failureKind: 'user_stopped',
      dispatchPhase: 'ended',
      nativeOutcome: 'completed',
    })
    const loaded1 = await f1.flow.load({ scope: 'messages', sessionId: f1.sessionId })
    if (!loaded1.ok || loaded1.value.scope !== 'messages') throw new Error('Missing messages page')
    const visible1 = loaded1.value.messages.find((m) => m.message.role === 'assistant')!
    if (visible1.kind !== 'complete') throw new Error('Expected complete visible message')
    expect(visible1.message.content).toBe('Visible prefix before Stop.')
    expect(visible1.message.state).toBe('incomplete')
    const hiddenRows = f1.db.drizzle
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.sessionId, f1.sessionId))
      .all()
      .filter((m) => m.role === 'assistant' && !m.isVisible)
    expect(hiddenRows.some((m) => m.content.includes('Full archived native answer.'))).toBe(true)
    const acts1 = f1.db.conversationRepository.readPage({
      scope: 'activities',
      sessionId: f1.sessionId,
      runId: runId1,
    })
    if (acts1.scope !== 'activities') throw new Error('Missing activities')
    expect(acts1.activities.map((a) => a.activity.title)).toEqual(['Running before stop'])
    expect(acts1.activities[0]?.activity.status).toBe('interrupted')
    expect(loaded1.value.header.sessionIssues?.agents ?? []).toEqual([])
    expect(loaded1.value.header.sessionIssues?.inputGate ?? 'open').toBe('open')
  } finally {
    await f1.dispose()
  }

  // 2. Verified ended/completed ALREADY committed BEFORE stop() -> preserves completed and full body.
  const f2 = await fixture('codex')
  try {
    const evidenceCommitted = Promise.withResolvers<void>()
    const releaseTail = Promise.withResolvers<void>()
    native.customRun = async function* (agentId, executorId, input) {
      const nativeSid = `native-done-first:${input.sessionId}`
      input.host?.lifecycle?.recordExecutor?.(executorId)
      input.host?.lifecycle?.recordDispatch?.('possibly_sent', nativeSid, executorId)
      yield { type: 'session.started', agentId, nativeSessionId: nativeSid }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSid, executorId)
      yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
      input.host?.lifecycle?.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId,
          runId: input.runId,
          requestId: input.runId,
          nativeSessionId: nativeSid,
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      evidenceCommitted.resolve()
      await releaseTail.promise
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Already completed before Stop.',
      }
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }
    const drafts2 = f2.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f2.sessionId,
    })
    if (drafts2.scope !== 'drafts') throw new Error('Missing drafts')
    const sent2 = await f2.flow.send({
      sessionId: f2.sessionId,
      clientMessageId: randomUUID(),
      content: 'Completed before Stop arrives',
      expectedCommentsRevision: drafts2.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'codex' },
    })
    if (!sent2.ok) throw new Error('Expected send to succeed')
    const runId2 = sent2.value.runs[0]!.id
    await evidenceCommitted.promise
    const stopResult2 = f2.flow.stop({ sessionId: f2.sessionId })
    expect(stopResult2.ok).toBe(true)
    releaseTail.resolve()
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))
    expect(f2.db.conversationRepository.findRun(runId2)).toMatchObject({
      status: 'completed',
      dispatchPhase: 'ended',
    })
    const page2 = f2.db.conversationRepository.readPage({
      scope: 'messages',
      sessionId: f2.sessionId,
    })
    if (page2.scope !== 'messages') throw new Error('Missing messages page')
    const visible2 = page2.messages.find((m) => m.message.role === 'assistant')
    if (visible2?.kind !== 'complete') throw new Error('Expected complete visible message')
    expect(visible2.message).toMatchObject({
      content: 'Already completed before Stop.',
      state: 'complete',
    })
  } finally {
    await f2.dispose()
  }

  // 3. Real pre-dispatch PermissionModeRejectedError racing with stop() -> stays failed (never masked as user_stopped).
  const f3 = await fixture('claude')
  try {
    const insideBootstrap = Promise.withResolvers<void>()
    native.customRun = (_agentId, _executorId, _input, signal) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          insideBootstrap.resolve()
          await new Promise<void>((done) => {
            if (signal.aborted) done()
            else signal.addEventListener('abort', () => done(), { once: true })
          })
          throw new PermissionModeRejectedError('Auto mode was rejected by policy.')
        },
      }),
    })
    const drafts3 = f3.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f3.sessionId,
    })
    if (drafts3.scope !== 'drafts') throw new Error('Missing drafts')
    const sent3 = await f3.flow.send({
      sessionId: f3.sessionId,
      clientMessageId: randomUUID(),
      content: 'Pre-dispatch rejection racing Stop',
      expectedCommentsRevision: drafts3.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent3.ok) throw new Error('Expected send to succeed')
    const runId3 = sent3.value.runs[0]!.id
    await insideBootstrap.promise
    f3.flow.stop({ sessionId: f3.sessionId })
    await vi.waitFor(() => expect(f3.flow.diagnostics().activeExecutions).toBe(0))
    expect(f3.db.conversationRepository.findRun(runId3)).toMatchObject({
      status: 'failed',
      failureKind: 'runtime_incompatible',
    })
  } finally {
    await f3.dispose()
  }

  // 4. R2-F1: Pre-dispatch Stop sentinel ('Claude Code was interrupted.') settles cleanly without red Failed or warning card.
  const f4 = await fixture('claude')
  try {
    const insideBootstrap4 = Promise.withResolvers<void>()
    native.customRun = (_agentId, _executorId, _input, signal) => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          insideBootstrap4.resolve()
          await new Promise<void>((done) => {
            if (signal.aborted) done()
            else signal.addEventListener('abort', () => done(), { once: true })
          })
          throw new AgentExecutionError(
            'agent_process_crash',
            'Claude Code was interrupted.',
            false,
          )
        },
      }),
    })
    const drafts4 = f4.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f4.sessionId,
    })
    if (drafts4.scope !== 'drafts') throw new Error('Missing drafts')
    const sent4 = await f4.flow.send({
      sessionId: f4.sessionId,
      clientMessageId: randomUUID(),
      content: 'Pre-dispatch Stop during Claude bootstrap',
      expectedCommentsRevision: drafts4.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent4.ok) throw new Error('Expected send to succeed')
    const runId4 = sent4.value.runs[0]!.id
    await insideBootstrap4.promise
    f4.flow.stop({ sessionId: f4.sessionId })
    await vi.waitFor(() => expect(f4.flow.diagnostics().activeExecutions).toBe(0))
    expect(f4.db.conversationRepository.findRun(runId4)).toMatchObject({
      status: 'interrupted',
      failureKind: 'user_stopped',
    })
    const loaded4 = await f4.flow.load({ scope: 'messages', sessionId: f4.sessionId })
    if (!loaded4.ok || loaded4.value.scope !== 'messages') throw new Error('Missing messages page')
    expect(loaded4.value.header.sessionIssues?.agents ?? []).toEqual([])
    expect(loaded4.value.header.sessionIssues?.inputGate ?? 'open').toBe('open')
  } finally {
    await f4.dispose()
  }

  // 5. Carbon F1 + Astra #6: Pre-dispatch Stop after `session.started` discards fresh 0-turn binding
  // so Run 2 starts fresh without `context_resume_failed`, and concurrent `send()` during Stop drain is rejected.
  const f5 = await fixture('claude')
  try {
    const started5 = Promise.withResolvers<void>()
    const releaseDrain5 = Promise.withResolvers<void>()
    let runCount5 = 0
    let secondRunNativeSid: string | undefined = 'sentinel'
    native.customRun = async function* (agentId, executorId, input, signal) {
      runCount5 += 1
      if (runCount5 === 1) {
        yield { type: 'session.started', agentId, nativeSessionId: 'fresh-0turn-sid' }
        input.host?.lifecycle?.recordDispatch?.('rejected', 'fresh-0turn-sid', executorId)
        started5.resolve()
        await new Promise<void>((done) => {
          if (signal.aborted) done()
          else signal.addEventListener('abort', () => done(), { once: true })
        })
        await releaseDrain5.promise
        input.host?.effects?.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
          reason: 'native_turn_not_started',
        })
        return
      }
      secondRunNativeSid = input.nativeSessionId
      yield { type: 'session.started', agentId, nativeSessionId: 'fresh-run2-sid' }
      input.host?.lifecycle?.recordDispatch?.('accepted', 'fresh-run2-sid', executorId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Run 2 started cleanly without stale 0-turn binding.',
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
          nativeSessionId: 'fresh-run2-sid',
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }
    const drafts5 = f5.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f5.sessionId,
    })
    if (drafts5.scope !== 'drafts') throw new Error('Missing drafts')
    const sent5a = await f5.flow.send({
      sessionId: f5.sessionId,
      clientMessageId: randomUUID(),
      content: 'Run 1 stopped pre-dispatch',
      expectedCommentsRevision: drafts5.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    if (!sent5a.ok) throw new Error('Expected run 1 send to succeed')
    await started5.promise
    f5.flow.stop({ sessionId: f5.sessionId })

    // Astra #6: While Stop is draining, concurrent second-window send MUST return CONFLICT!
    const concurrentSend = await f5.flow.send({
      sessionId: f5.sessionId,
      clientMessageId: randomUUID(),
      content: 'Concurrent send while stopping',
      expectedCommentsRevision: drafts5.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    expect(concurrentSend).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })

    releaseDrain5.resolve()
    await vi.waitFor(() => expect(f5.flow.diagnostics().activeExecutions).toBe(0))
    expect(f5.db.conversationRepository.nativeContext(f5.sessionId, 'claude')).toBeUndefined()

    // Run 2 starts fresh with no stale nativeSessionId and succeeds cleanly!
    const drafts5b = f5.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f5.sessionId,
    })
    if (drafts5b.scope !== 'drafts') throw new Error('Missing drafts')
    const sent5b = await f5.flow.send({
      sessionId: f5.sessionId,
      clientMessageId: randomUUID(),
      content: 'Run 2 after clean pre-dispatch stop',
      expectedCommentsRevision: drafts5b.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    expect(sent5b).toEqual({ ok: true, value: expect.anything() })
    await vi.waitFor(() => expect(f5.flow.diagnostics().activeExecutions).toBe(0))
    expect(secondRunNativeSid).toBeUndefined()
  } finally {
    await f5.dispose()
  }

  // 6. B4 (Astra #7): `@all` Stop during Secondary preparation cancels only continuationAbortController
  // without aborting an already-completed Primary signal.
  const f6 = await fixture('claude')
  try {
    let primarySignalAborted = false
    let secondaryStarted = false
    const secondaryPreparing = Promise.withResolvers<void>()
    native.customRun = async function* (agentId, executorId, input, signal) {
      if (agentId === 'claude') {
        signal.addEventListener('abort', () => {
          primarySignalAborted = true
        })
        yield { type: 'session.started', agentId, nativeSessionId: 'claude-all-primary' }
        input.host?.lifecycle?.recordDispatch?.('accepted', 'claude-all-primary', executorId)
        yield {
          type: 'text.completed',
          agentId,
          turnId: `turn:${input.runId}`,
          outputId: 'answer',
          text: 'Primary completed before @all Secondary prepared.',
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
            nativeSessionId: 'claude-all-primary',
            nativeTurnId: `turn:${input.runId}`,
            bindingGeneration: input.bindingGeneration!,
            executorId,
          },
        })
        yield {
          type: 'turn.completed',
          agentId,
          turnId: `turn:${input.runId}`,
          outcome: 'completed',
        }
        input.host?.effects?.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
        })
        return
      }
      secondaryStarted = true
    }
    Reflect.set(
      f6.flow['core'].collaboration,
      'beginPendingRoutedContinuation',
      async (_pending: unknown, _ctx: unknown, signal: AbortSignal) => {
        secondaryPreparing.resolve()
        await new Promise<void>((done) => {
          if (signal.aborted) done()
          else signal.addEventListener('abort', () => done(), { once: true })
        })
        return undefined
      },
    )
    const drafts6 = f6.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f6.sessionId,
    })
    if (drafts6.scope !== 'drafts') throw new Error('Missing drafts')
    const sent6 = await f6.flow.send({
      sessionId: f6.sessionId,
      clientMessageId: randomUUID(),
      content: 'Run both agents',
      expectedCommentsRevision: drafts6.commentsRevision,
      commentIds: [],
      route: { type: 'all' },
    })
    expect(sent6.ok).toBe(true)
    await secondaryPreparing.promise
    f6.flow.stop({ sessionId: f6.sessionId })
    await vi.waitFor(() => expect(f6.flow.diagnostics().activeExecutions).toBe(0))
    expect(primarySignalAborted).toBe(false)
    expect(secondaryStarted).toBe(false)
  } finally {
    await f6.dispose()
  }
})

it('Carbon Final Finding 2: restores 0-turn and ready bindings across sync and async NativeInputWithheldError settlement', async () => {
  // 1. Fresh 0-turn session (schedulingSettings.enabled = false):
  //    generator throws NativeInputWithheldError BEFORE delayed reportNativeEffects('settled', 'workflow_input_withheld')
  //    arrives (simulating Claude child close after throw). The 0-turn binding MUST be discarded cleanly,
  //    sessionIssues must stay empty, and the next send() must start fresh.
  const f1 = await fixture('claude')
  try {
    let run1Input: AgentRunInput | undefined
    let run2NativeSessionId: string | undefined = 'sentinel'
    let callNum = 0
    native.customRun = async function* (agentId, executorId, input) {
      callNum += 1
      native.actors += 1
      native.inputs.set(input.runId, input)
      input.host?.lifecycle?.recordExecutor?.(executorId)
      if (callNum === 1) {
        run1Input = input
        native.background.add(input.runId)
        yield { type: 'session.started', agentId, nativeSessionId: 'claude-0turn-withheld' }
        input.host?.lifecycle?.recordDispatch?.('rejected', 'claude-0turn-withheld', executorId)
        throw new NativeInputWithheldError('Workflow paused before first byte.')
      }
      run2NativeSessionId = input.nativeSessionId
      yield { type: 'session.started', agentId, nativeSessionId: 'claude-fresh-run2' }
      input.host?.lifecycle?.recordDispatch?.('accepted', 'claude-fresh-run2', executorId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Fresh Claude turn succeeded.',
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
          nativeSessionId: 'claude-fresh-run2',
          nativeTurnId: `turn:${input.runId}`,
          bindingGeneration: input.bindingGeneration!,
          executorId,
        },
      })
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }

    const drafts1 = f1.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f1.sessionId,
    })
    if (drafts1.scope !== 'drafts') throw new Error('Missing drafts')
    const sent1 = await f1.flow.send({
      sessionId: f1.sessionId,
      clientMessageId: randomUUID(),
      content: 'Fresh run withheld before first byte',
      expectedCommentsRevision: drafts1.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    expect(sent1.ok).toBe(true)
    await vi.waitFor(() => expect(f1.flow.diagnostics().activeExecutions).toBe(0))
    expect(run1Input).toBeDefined()

    // Delayed child close now settles native effects AFTER RunExecutor catch completed.
    native.background.delete(run1Input!.runId)
    run1Input!.host?.effects?.reportNativeEffects?.({
      runId: run1Input!.runId,
      generation: run1Input!.nativeGeneration!,
      state: 'settled',
      reason: 'workflow_input_withheld',
    })

    expect(f1.db.conversationRepository.nativeContext(f1.sessionId, 'claude')).toBeUndefined()
    const loaded1 = await f1.flow.load({ scope: 'messages', sessionId: f1.sessionId })
    if (!loaded1.ok || loaded1.value.scope !== 'messages') throw new Error('Expected messages page')
    expect(loaded1.value.header.sessionIssues?.agents ?? []).toEqual([])
    expect(loaded1.value.header.sessionIssues?.inputGate ?? 'open').toBe('open')

    const drafts1b = f1.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: f1.sessionId,
    })
    if (drafts1b.scope !== 'drafts') throw new Error('Missing drafts')
    const sent1b = await f1.flow.send({
      sessionId: f1.sessionId,
      clientMessageId: randomUUID(),
      content: 'Next turn starts fresh',
      expectedCommentsRevision: drafts1b.commentsRevision,
      commentIds: [],
      route: { type: 'agent', agentId: 'claude' },
    })
    expect(sent1b.ok).toBe(true)
    await vi.waitFor(() => expect(f1.flow.diagnostics().activeExecutions).toBe(0))
    expect(run2NativeSessionId).toBeUndefined()
  } finally {
    await f1.dispose()
  }

  // 2. Established 'ready' binding (Turn 1 completed; schedulingSettings.enabled = false):
  //    Turn 2 yields session.started, synchronously reports settled('workflow_input_withheld') BEFORE
  //    throwing NativeInputWithheldError. Binding MUST remain { state: 'active', continuationState: 'ready' },
  //    inputGate MUST remain 'open' with zero SessionWarningCard, and Turn 3 reuses the binding.
  const f2 = await fixture('codex')
  try {
    let callNum = 0
    let turn3NativeSessionId: string | undefined
    native.customRun = async function* (agentId, executorId, input) {
      callNum += 1
      native.actors += 1
      native.inputs.set(input.runId, input)
      input.host?.lifecycle?.recordExecutor?.(executorId)
      const nativeSessionId = 'codex-established-sid'
      if (callNum === 1) {
        yield { type: 'session.started', agentId, nativeSessionId }
        input.host?.lifecycle?.recordDispatch?.('accepted', nativeSessionId, executorId)
        yield {
          type: 'text.completed',
          agentId,
          turnId: `turn:${input.runId}`,
          outputId: 'answer',
          text: 'Turn 1 complete.',
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
        yield {
          type: 'turn.completed',
          agentId,
          turnId: `turn:${input.runId}`,
          outcome: 'completed',
        }
        input.host?.effects?.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
        })
        return
      }
      if (callNum === 2) {
        yield { type: 'session.started', agentId, nativeSessionId }
        input.host?.lifecycle?.recordDispatch?.('rejected', nativeSessionId, executorId)
        input.host?.effects?.reportNativeEffects?.({
          runId: input.runId,
          generation: input.nativeGeneration!,
          state: 'settled',
          reason: 'workflow_input_withheld',
        })
        throw new NativeInputWithheldError('Workflow paused before Turn 2 first byte.')
      }
      turn3NativeSessionId = input.nativeSessionId
      yield { type: 'session.started', agentId, nativeSessionId }
      input.host?.lifecycle?.recordDispatch?.('accepted', nativeSessionId, executorId)
      yield {
        type: 'text.completed',
        agentId,
        turnId: `turn:${input.runId}`,
        outputId: 'answer',
        text: 'Turn 3 reused healthy binding.',
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
      yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
      input.host?.effects?.reportNativeEffects?.({
        runId: input.runId,
        generation: input.nativeGeneration!,
        state: 'settled',
      })
    }

    const sendTurn = async (content: string) => {
      const drafts = f2.db.conversationRepository.readPage({
        scope: 'drafts',
        sessionId: f2.sessionId,
      })
      if (drafts.scope !== 'drafts') throw new Error('Missing drafts')
      return f2.flow.send({
        sessionId: f2.sessionId,
        clientMessageId: randomUUID(),
        content,
        expectedCommentsRevision: drafts.commentsRevision,
        commentIds: [],
        route: { type: 'agent', agentId: 'codex' },
      })
    }

    expect((await sendTurn('Turn 1')).ok).toBe(true)
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))
    expect(f2.db.conversationRepository.nativeContext(f2.sessionId, 'codex')).toMatchObject({
      nativeSessionId: 'codex-established-sid',
      state: 'active',
      continuationState: 'ready',
    })

    expect((await sendTurn('Turn 2 withheld')).ok).toBe(true)
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))

    expect(f2.db.conversationRepository.nativeContext(f2.sessionId, 'codex')).toMatchObject({
      nativeSessionId: 'codex-established-sid',
      state: 'active',
      continuationState: 'ready',
    })
    expect(
      f2.db.conversationRepository.nativeContext(f2.sessionId, 'codex')?.recoveryFailureKind,
    ).toBeUndefined()
    const loaded2 = await f2.flow.load({ scope: 'messages', sessionId: f2.sessionId })
    if (!loaded2.ok || loaded2.value.scope !== 'messages') throw new Error('Expected messages page')
    expect(loaded2.value.header.sessionIssues?.agents ?? []).toEqual([])
    expect(loaded2.value.header.sessionIssues?.inputGate ?? 'open').toBe('open')

    expect((await sendTurn('Turn 3')).ok).toBe(true)
    await vi.waitFor(() => expect(f2.flow.diagnostics().activeExecutions).toBe(0))
    expect(turn3NativeSessionId).toBe('codex-established-sid')
  } finally {
    await f2.dispose()
  }
})
