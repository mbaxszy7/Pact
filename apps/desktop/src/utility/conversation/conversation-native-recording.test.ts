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

import { agentEventJournal, PactDatabase } from '@pact/persistence'

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
  if (native.background.size + native.extraBackground >= 8)
    throw new NativeCapacityError(
      'All eight native background contexts are occupied; no native actor was created.',
    )
  native.actors += 1
  native.inputs.set(input.runId, input)
  input.recordExecutor?.(executorId)
  const nativeSessionId = input.nativeSessionId ?? `native:${input.sessionId}`
  input.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
  yield { type: 'session.started', agentId, nativeSessionId }
  input.recordDispatch?.('accepted', nativeSessionId, executorId)
  yield { type: 'turn.started', agentId, turnId: `turn:${input.runId}` }
  const path = `file-${native.actors}.ts`
  await writeFile(join(input.cwd, path), 'export const value = 1\n')
  await input.recordFileChange?.(
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
  yield { type: 'turn.completed', agentId, turnId: `turn:${input.runId}`, outcome: 'completed' }
  if (!native.background.has(input.runId))
    input.reportNativeEffects?.({
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
    hasActiveBackgroundWork(runId?: string) {
      return runId
        ? native.background.has(runId)
        : native.background.size + native.extraBackground > 0
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
  native.inspect.mockReset()
})

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
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
    for await (const chunk of repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      id,
    ))
      chunks.push(chunk)
    repo.freezeNativeRebuildSource(id, chunks)
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
    for await (const chunk of repo.nativeContextRebuildSource(
      f.sessionId,
      new AbortController().signal,
      id,
    ))
      chunks.push(chunk)
    repo.freezeNativeRebuildSource(id, chunks)
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
    { ...settings, primaryAgentId: agentId },
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
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
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
    input.reportNativeEffects?.({ runId, generation: input.nativeGeneration!, state: 'settled' })
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
      await input.recordFileChange!(
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
      await input.recordFileChange!(
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
