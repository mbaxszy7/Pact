import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  AgentNativeContextRebuildInput,
  AgentNativeContextRebuildResult,
  AgentRunInput,
} from '@pact/agent-runtime'
import type {
  ConversationSendInput,
  DefaultSessionSettings,
  NormalizedAgentEvent,
  NativeContextRebuildChunk,
  RpcResult,
  RuntimeAgentId,
  WorkspaceArchiveScope,
} from '@pact/contracts'

import { WORKSPACE_ARCHIVE_PREVIEW_MS, WORKSPACE_ARCHIVE_STOP_MS } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import type { WorkspaceReservation } from '../workspace-changes/workspace-changes.js'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { WorkspaceChangeError, WorkspaceChanges } from '../workspace-changes/workspace-changes.js'
import { Conversation } from './conversation.js'

type Ending = 'completed' | 'interrupted' | undefined
interface ControlledRun {
  input: AgentRunInput
  agentId: RuntimeAgentId
  executorId: string
  signal: AbortSignal
  aborts: number
  background: boolean
  error?: unknown
  ending: ReturnType<typeof Promise.withResolvers<Ending>>
  tail: ReturnType<typeof Promise.withResolvers<void>>
}

const native = vi.hoisted(() => ({
  runs: new Map<string, ControlledRun>(),
  disposals: 0,
  inspect:
    vi.fn<
      (
        input: AgentNativeContextRebuildInput,
        source: AsyncIterable<NativeContextRebuildChunk>,
        signal: AbortSignal,
      ) => Promise<AgentNativeContextRebuildResult | undefined>
    >(),
}))
const cleanupGates: Array<() => void> = []

// Controlled Adapter protocol evidence only: abort acknowledgement, a matching native
// ending, effects settlement and iterator completion are four separate fixture actions.
// Actual CLI/process-tree settlement is covered by the native/Electron lanes.
function adapter(agentId: RuntimeAgentId) {
  return class {
    readonly id = agentId
    readonly executorId = randomUUID()
    inspectNativeRebuild = native.inspect

    hasActiveBackgroundWork(runId?: string) {
      return [...native.runs.values()].some(
        (run) =>
          run.executorId === this.executorId &&
          run.background &&
          (!runId || run.input.runId === runId),
      )
    }

    async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<NormalizedAgentEvent> {
      const run: ControlledRun = {
        input,
        agentId,
        executorId: this.executorId,
        signal,
        aborts: 0,
        background: true,
        ending: Promise.withResolvers<Ending>(),
        tail: Promise.withResolvers<void>(),
      }
      native.runs.set(input.runId, run)
      const aborted = () => {
        run.aborts += 1
      }
      signal.addEventListener('abort', aborted, { once: true })
      try {
        input.recordExecutor?.(this.executorId)
        const nativeSessionId = input.nativeSessionId ?? `${agentId}:${input.sessionId}`
        input.recordDispatch?.('possibly_sent', nativeSessionId, this.executorId)
        yield { type: 'session.started', agentId, nativeSessionId }
        input.recordDispatch?.('accepted', nativeSessionId, this.executorId)
        yield { type: 'turn.started', agentId, turnId: input.runId }
        yield {
          type: 'text.delta',
          agentId,
          turnId: input.runId,
          outputId: 'answer',
          text: 'Saved before the archive Stop.',
        }
        const outcome = await run.ending.promise
        // Disposal merely releases our fixture iterator; it supplies no ending fact.
        if (!outcome) return
        input.recordNativeEvidence?.({
          kind: 'ended',
          source: 'live_terminal',
          outcome,
          identity: {
            sessionId: input.sessionId,
            agentId,
            runId: input.runId,
            requestId: input.runId,
            nativeSessionId,
            nativeTurnId: input.runId,
            bindingGeneration: input.bindingGeneration!,
            executorId: this.executorId,
          },
        })
        if (outcome === 'completed')
          yield {
            type: 'text.completed',
            agentId,
            turnId: input.runId,
            outputId: 'answer',
            text: 'The controlled task finished naturally.',
          }
        await run.tail.promise
        yield { type: 'turn.completed', agentId, turnId: input.runId, outcome }
      } catch (error) {
        run.error = error
        throw error
      } finally {
        signal.removeEventListener('abort', aborted)
      }
    }

    async dispose() {
      native.disposals += 1
      for (const run of native.runs.values()) {
        if (run.executorId !== this.executorId) continue
        run.background = false
        run.ending.resolve(undefined)
        run.tail.resolve()
      }
    }
  }
}

vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: adapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: adapter('claude') }))

const migrationsFolder = resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle')
const settings: DefaultSessionSettings = {
  primaryAgentId: 'codex',
  agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
  maxDiscussionRounds: 3,
  maxReviewCycles: 3,
  maxRepairAttempts: 3,
}
const owners: Array<{
  db: PactDatabase
  flow: Conversation
  directory: string
  workspace: WorkspaceChanges | undefined
  archives: Promise<unknown>[]
  workspaceCleanupFailed: boolean
}> = []

function value<T>(result: RpcResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function effectsSettled(run: ControlledRun) {
  run.background = false
  run.input.reportNativeEffects?.({
    runId: run.input.runId,
    generation: run.input.nativeGeneration!,
    state: 'settled',
  })
}

async function end(run: ControlledRun, outcome: Exclude<Ending, undefined> = 'interrupted') {
  run.ending.resolve(outcome)
  await flush()
  effectsSettled(run)
  run.tail.resolve()
  await flush()
}

async function flush() {
  await new Promise<void>((done) => setImmediate(done))
}

afterEach(async () => {
  vi.useRealTimers()
  for (const release of cleanupGates.splice(0)) release()
  await Promise.all([...native.runs.values()].map((run) => end(run)))
  await Promise.all(
    owners.splice(0).map(async (owner) => {
      try {
        await owner.flow.dispose()
        await Promise.allSettled(owner.archives)
        if (owner.workspaceCleanupFailed) {
          let failure: unknown
          try {
            await owner.workspace!.dispose()
          } catch (error) {
            failure = error
          }
          if (
            !(failure instanceof WorkspaceChangeError) ||
            failure.code !== 'WORKSPACE_RECOVERY_REQUIRED'
          )
            throw failure ?? new Error('Expected the retained recording owner to reject disposal.')
        } else await owner.workspace?.dispose()
      } finally {
        owner.db.close()
        await rm(owner.directory, { recursive: true, force: true })
      }
    }),
  )
  vi.restoreAllMocks()
  native.runs.clear()
  native.disposals = 0
  native.inspect.mockReset()
})

async function fixture(withWorkspace = false) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pact-archive-conversation-')))
  const db = await PactDatabase.open({
    filePath: join(directory, 'fixture.sqlite'),
    migrationsFolder,
  })
  const createdAt = new Date().toISOString()
  const projectDirectory = join(directory, 'project')
  await mkdir(projectDirectory)
  const projectId = randomUUID()
  db.projectCatalogRepository.add({
    id: projectId,
    directoryPath: projectDirectory,
    name: 'Archive fixture',
    kind: 'directory',
    createdAt,
  })
  const sessionIds = [randomUUID(), randomUUID(), randomUUID()] as const
  sessionIds.forEach((id, index) =>
    db.sessionRepository.create(
      { id, projectId, title: `Session ${index + 1}`, createdAt },
      settings,
    ),
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
          executablePath: process.execPath,
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          state: 'ready',
          executablePath: process.execPath,
          checkedAt: createdAt,
        },
      ],
    },
  })
  const workspace = withWorkspace
    ? new WorkspaceChanges(
        db.workspaceChangesRepository,
        db.sessionRepository,
        db.projectCatalogRepository,
        join(directory, 'storage'),
        runDirectoryWorker,
      )
    : undefined
  await workspace?.initialize()
  const open = () =>
    new Conversation(
      db.conversationRepository,
      db.sessionRepository,
      db.projectCatalogRepository,
      preparation,
      new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
      workspace,
    )
  const owner = {
    db,
    flow: open(),
    directory,
    workspace,
    archives: [] as Promise<unknown>[],
    workspaceCleanupFailed: false,
  }
  owners.push(owner)
  const input = (sessionId: string, content = 'Keep this task active.'): ConversationSendInput => {
    const drafts = db.conversationRepository.readPage({ scope: 'drafts', sessionId })
    if (drafts.scope !== 'drafts') throw new Error('Missing fixture drafts')
    return {
      sessionId,
      clientMessageId: randomUUID(),
      content,
      expectedCommentsRevision: drafts.commentsRevision,
      commentIds: [],
    }
  }
  const start = async (sessionId: string = sessionIds[0], content?: string) => {
    const sent = value(await owner.flow.send(input(sessionId, content)))
    const runId = sent.runs[0]!.id
    await vi.waitFor(() => expect(native.runs.has(runId)).toBe(true))
    await vi.waitFor(() =>
      expect(db.conversationRepository.findRun(runId)?.dispatchPhase).toBe('accepted'),
    )
    await flush()
    return native.runs.get(runId)!
  }
  const prepare = (scope: WorkspaceArchiveScope) =>
    value(owner.flow.prepareWorkspaceArchive({ scope, operationId: randomUUID() }))
  const commit = vi.fn<(scope: WorkspaceArchiveScope, operationId: string) => RpcResult<unknown>>(
    (scope, operationId) => ({
      ok: true,
      value:
        scope.kind === 'session'
          ? db.sessionRepository.archive(scope.sessionId, operationId)
          : db.projectCatalogRepository.archive(scope.projectId, operationId),
    }),
  )
  const readCommitted = vi.fn<(scope: WorkspaceArchiveScope) => RpcResult<unknown>>((scope) => ({
    ok: true,
    value:
      scope.kind === 'session'
        ? db.sessionRepository.change(scope.sessionId)
        : db.projectCatalogRepository.read(),
  }))
  const archive = (scope: WorkspaceArchiveScope, operationId?: string) => {
    const task = owner.flow.archiveWorkspace(
      scope,
      operationId,
      (id) => commit(scope, id),
      () => readCommitted(scope),
    )
    owner.archives.push(task)
    return task
  }
  const receipt = (operationId: string) => value(owner.flow.readWorkspaceArchive(operationId))
  return {
    owner,
    db,
    projectId,
    projectDirectory,
    sessionIds,
    start,
    prepare,
    archive,
    receipt,
    commit,
    readCommitted,
    input,
    open,
    preparation,
  }
}

async function settledUnconfirmedCandidate(f: Awaited<ReturnType<typeof fixture>>) {
  const repo = f.db.conversationRepository
  const sessionId = f.sessionIds[0]
  const original = repo.beginRun({
    ...f.input(sessionId, 'Saved source for the old Claude binding.'),
    agentId: 'claude',
    settingsRevision: 1,
    model: null,
    effort: null,
  })
  const oldNativeSessionId = 'old-claude-before-archive'
  for (const event of [
    { type: 'session.started', agentId: 'claude', nativeSessionId: oldNativeSessionId },
    { type: 'turn.started', agentId: 'claude', turnId: original.run.id },
    {
      type: 'text.completed',
      agentId: 'claude',
      turnId: original.run.id,
      outputId: 'source-answer',
      text: 'A completed saved answer.',
    },
  ] as const)
    repo.applyEvent(sessionId, original.run.id, event)
  repo.recordNativeEvidence({
    kind: 'ended',
    source: 'stored_terminal',
    outcome: 'completed',
    identity: {
      sessionId,
      agentId: 'claude',
      runId: original.run.id,
      requestId: original.run.id,
      nativeSessionId: oldNativeSessionId,
      nativeTurnId: original.run.id,
      bindingGeneration: 1,
    },
  })
  repo.applyEvent(sessionId, original.run.id, {
    type: 'turn.completed',
    agentId: 'claude',
    turnId: original.run.id,
    outcome: 'completed',
  })
  repo.recordNativeEffects(original.run.id, 'settled')
  const rebuildId = randomUUID()
  repo.beginNativeRebuild({
    id: rebuildId,
    sessionId,
    agentId: 'claude',
    expectedGeneration: 1,
    abandon: false,
  })
  const chunks: NativeContextRebuildChunk[] = []
  for await (const chunk of repo.nativeContextRebuildSource(
    sessionId,
    new AbortController().signal,
    rebuildId,
  ))
    chunks.push(chunk)
  repo.freezeNativeRebuildSource(rebuildId, chunks)
  const creatingExecutorId = randomUUID()
  const candidateNativeSessionId = 'settled-unconfirmed-claude'
  repo.markNativeRebuildDispatched(rebuildId, creatingExecutorId)
  repo.recordNativeRebuildIdentity(rebuildId, candidateNativeSessionId)
  repo.recordNativeRebuildWork(rebuildId, creatingExecutorId, candidateNativeSessionId, 'settled')
  repo.failNativeRebuild(rebuildId, 'The initialization reply was not confirmed.')
  vi.spyOn(f.preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)
  native.inspect.mockImplementation(async (input, source) => {
    const observed: NativeContextRebuildChunk[] = []
    for await (const chunk of source) observed.push(chunk)
    expect(observed).toEqual(chunks)
    return { nativeSessionId: input.nativeSessionId! }
  })
  return { sessionId, rebuildId, oldNativeSessionId, candidateNativeSessionId, chunks }
}

function dividers(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  const page = f.db.conversationRepository.readPage({ scope: 'messages', sessionId })
  if (page.scope !== 'messages') throw new Error('Missing fixture messages')
  return page.messages
    .filter(({ message }) => message.role === 'system')
    .map(({ message }) => message.id)
}

function recordingRun(f: Awaited<ReturnType<typeof fixture>>, index: number) {
  const sessionId = randomUUID()
  f.db.sessionRepository.create(
    {
      id: sessionId,
      projectId: f.projectId,
      title: `Recording ${index}`,
      createdAt: new Date().toISOString(),
    },
    settings,
  )
  return f.db.conversationRepository.beginRun({
    ...f.input(sessionId, `Record physical file ${index}.`),
    agentId: 'codex',
    settingsRevision: 1,
    model: null,
    effort: null,
  }).run
}

async function startRecordedRun(f: Awaited<ReturnType<typeof fixture>>, index: number) {
  const run = recordingRun(f, index)
  const signal = new AbortController().signal
  const path = `recording-${index}.txt`
  await writeFile(join(f.projectDirectory, path), 'Before\n')
  expect(await f.owner.workspace!.start(run, signal)).toBeUndefined()
  await writeFile(join(f.projectDirectory, path), 'After\n')
  await f.owner.workspace!.record(
    run.id,
    {
      operationId: randomUUID(),
      path,
      kind: 'modified',
      before: 'Before\n',
      after: 'After\n',
    },
    signal,
  )
  expect(f.owner.workspace!.summary(run.id)?.fileCount).toBe(1)
  return run
}

describe('Conversation workspace archive', () => {
  it('archives an idle Session directly and Undo restores visibility without starting a Run', async () => {
    const f = await fixture()
    const scope = { kind: 'session', sessionId: f.sessionIds[0] } as const
    expect(await f.archive(scope)).toMatchObject({ ok: true })
    expect(f.db.sessionRepository.find(scope.sessionId)?.status).toBe('archived')
    expect(f.db.sessionRepository.find(f.sessionIds[1])?.archivedAt).toBeUndefined()
    f.db.sessionRepository.restore(scope.sessionId)
    expect(f.db.sessionRepository.find(scope.sessionId)?.status).toBe('draft')
    expect(native.runs.size).toBe(0)
    expect(f.commit).toHaveBeenCalledTimes(1)
  })

  it('archives an idle Project without cascading Session archive state', async () => {
    const f = await fixture()
    const scope = { kind: 'project', projectId: f.projectId } as const
    expect(await f.archive(scope)).toMatchObject({ ok: true })
    expect(f.db.projectCatalogRepository.read().projects).toEqual([])
    for (const sessionId of f.sessionIds)
      expect(f.db.sessionRepository.find(sessionId)?.status).toBe('draft')
    f.db.projectCatalogRepository.restore(f.projectId)
    expect(f.db.projectCatalogRepository.read().projects).toHaveLength(1)
    expect(native.runs.size).toBe(0)
  })

  it('requires confirmation for active work and Cancel does not abort or Stop', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    expect(await f.archive(scope)).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    const preview = f.prepare(scope)
    expect(preview.tasks).toMatchObject([{ sessionId: scope.sessionId, state: 'running' }])
    expect(value(f.owner.flow.cancelWorkspaceArchive(preview.operationId)).state).toBe('cancelled')
    expect(run.aborts).toBe(0)
    expect(run.signal.aborted).toBe(false)
    expect(f.commit).not.toHaveBeenCalled()
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
    expect(run.aborts).toBe(0)
  })

  it('waits separately for native ending, native effects and Run completion after Stop ACK', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    expect(run.aborts).toBe(1)
    expect(f.receipt(preview.operationId).state).toBe('stopping')
    expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBeUndefined()
    expect(f.commit).not.toHaveBeenCalled()
    run.ending.resolve('interrupted')
    await vi.waitFor(() =>
      expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBe(
        'interrupted',
      ),
    )
    expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeEffectsState).toBe('pending')
    expect(f.commit).not.toHaveBeenCalled()
    effectsSettled(run)
    await flush()
    expect(f.commit).not.toHaveBeenCalled()
    expect(run.error).toBeUndefined()
    expect(f.owner.flow.diagnostics().activeExecutions).toBe(1)
    run.tail.resolve()
    expect(await archived).toMatchObject({ ok: true })
    expect(f.receipt(preview.operationId)).toMatchObject({
      state: 'archived',
      tasks: [{ sessionId: scope.sessionId, outcome: 'stopped' }],
    })
    expect(f.db.conversationRepository.findRun(run.input.runId)).toMatchObject({
      nativeOutcome: 'interrupted',
      nativeEffectsState: 'settled',
    })
    const page = f.db.conversationRepository.readPage({
      scope: 'messages',
      sessionId: scope.sessionId,
    })
    if (page.scope !== 'messages') throw new Error('Missing fixture messages')
    expect(
      page.messages.some(
        ({ message }) => 'content' in message && message.content.includes('Saved before'),
      ),
    ).toBe(true)
    expect(native.disposals).toBe(0)
  })

  it('joins Changes finalization before committing archive', async () => {
    const f = await fixture(true)
    const file = join(f.projectDirectory, 'recorded.txt')
    await writeFile(file, 'Before\n')
    const workspace = f.owner.workspace!
    const gate = Promise.withResolvers<void>()
    cleanupGates.push(() => gate.resolve())
    const finished = workspace.finish.bind(workspace)
    const finalization = vi.spyOn(workspace, 'finish').mockImplementation(async (runId) => {
      await gate.promise
      return finished(runId)
    })
    const run = await f.start()
    await writeFile(file, 'After\n')
    await run.input.recordFileChange?.(
      {
        operationId: randomUUID(),
        path: 'recorded.txt',
        kind: 'modified',
        before: 'Before\n',
        after: 'After\n',
      },
      run.signal,
    )
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await end(run)
    await vi.waitFor(() => expect(finalization).toHaveBeenCalled())
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.db.sessionRepository.find(scope.sessionId)?.archivedAt).toBeUndefined()
    gate.resolve()
    expect(await archived).toMatchObject({ ok: true })
    expect(workspace.summary(run.input.runId)?.undoUnavailableReason).toBeNull()
    expect(workspace.summary(run.input.runId)).toMatchObject({ state: 'ready' })
  })

  it('rejects a new Project task before stopping any previously reviewed Run', async () => {
    const f = await fixture()
    const first = await f.start(f.sessionIds[0])
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    const second = await f.start(f.sessionIds[1])
    expect(await f.archive(scope, preview.operationId)).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', message: expect.stringContaining('tasks changed') },
    })
    expect(first.aborts).toBe(0)
    expect(second.aborts).toBe(0)
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.receipt(preview.operationId).state).toBe('prepared')
  })

  it('rejects a replacement Run in the same Session without stopping it', async () => {
    const f = await fixture()
    const first = await f.start()
    const scope = { kind: 'session', sessionId: first.input.sessionId } as const
    const preview = f.prepare(scope)
    await end(first, 'completed')
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    const second = await f.start(scope.sessionId)
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
    expect(first.aborts).toBe(0)
    expect(second.aborts).toBe(0)
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('accepts a naturally finished captured task without issuing another Stop', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    await end(run, 'completed')
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: true })
    expect(run.aborts).toBe(0)
    expect(f.receipt(preview.operationId).tasks).toEqual([
      { sessionId: scope.sessionId, outcome: 'finished' },
    ])
  })

  it('stops every captured Project task and commits only after all settle', async () => {
    const f = await fixture()
    const first = await f.start(f.sessionIds[0])
    const second = await f.start(f.sessionIds[1])
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    expect([first.aborts, second.aborts]).toEqual([1, 1])
    await end(first)
    expect(f.commit).not.toHaveBeenCalled()
    await end(second)
    expect(await archived).toMatchObject({ ok: true })
    expect(f.db.projectCatalogRepository.read().projects).toEqual([])
    expect(f.receipt(preview.operationId).tasks).toEqual(
      expect.arrayContaining([
        { sessionId: first.input.sessionId, outcome: 'stopped' },
        { sessionId: second.input.sessionId, outcome: 'stopped' },
      ]),
    )
    expect(f.db.sessionRepository.find(first.input.sessionId)?.status).not.toBe('archived')
  })

  it('keeps a Project visible after a Stop failure even when every native task later settles', async () => {
    const f = await fixture()
    const first = await f.start(f.sessionIds[0])
    const second = await f.start(f.sessionIds[1])
    // A failed non-progress publication is a real caller error after the existing
    // Stop has aborted the Adapter. It cannot be turned into archive success.
    const unsubscribe = f.owner.flow.subscribe((patch) => {
      if (
        patch.sessionId === second.input.sessionId &&
        patch.runs.some((run) => run.failureKind === 'user_stopped')
      )
        throw new Error('Controlled Stop publication failure.')
    })
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    unsubscribe()
    expect([first.aborts, second.aborts]).toEqual([1, 1])
    await Promise.all([end(first), end(second)])
    expect(await archived).toMatchObject({ ok: false })
    expect(f.db.projectCatalogRepository.read().projects).toHaveLength(1)
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.receipt(preview.operationId)).toMatchObject({
      state: 'not_archived',
      tasks: expect.arrayContaining([
        { sessionId: first.input.sessionId, outcome: 'stopped' },
        { sessionId: second.input.sessionId, outcome: 'failed' },
      ]),
    })
  })

  it('times out at the absolute deadline, preserves uncertainty and checks without another Stop', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const archived = f.archive(scope, preview.operationId)
    await flush()
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_STOP_MS - 100)
    expect(f.receipt(preview.operationId).state).toBe('stopping')
    expect(f.commit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(100)
    expect(await archived).toMatchObject({ ok: false })
    expect(f.receipt(preview.operationId)).toMatchObject({
      state: 'unresolved',
      tasks: [{ sessionId: scope.sessionId, outcome: 'unresolved' }],
    })
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    expect(run.aborts).toBe(1)
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
    expect(run.aborts).toBe(1)
    expect(f.commit).not.toHaveBeenCalled()
    vi.useRealTimers()
    await end(run)
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    expect(f.receipt(preview.operationId).state).toBe('not_archived')
    expect(f.db.sessionRepository.find(scope.sessionId)?.archivedAt).toBeUndefined()
  })

  it('releases an old resolved fence on a fresh prepare without replaying its Stop or commit', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const original = f.prepare(scope)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const first = f.archive(scope, original.operationId)
    await flush()
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_STOP_MS)
    expect(await first).toMatchObject({ ok: false })
    vi.useRealTimers()
    await end(run)
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    const fresh = f.prepare(scope)
    expect(fresh.operationId).not.toBe(original.operationId)
    expect(fresh.tasks).toEqual([])
    expect(f.db.conversationRepository.archives.read(original.operationId)?.state).toBe(
      'not_archived',
    )
    expect(f.commit).not.toHaveBeenCalled()
    expect(run.aborts).toBe(1)
    expect(await f.archive(scope, fresh.operationId)).toMatchObject({ ok: true })
    expect(f.commit).toHaveBeenCalledTimes(1)
  })

  it('never treats disposal as a native ending and restart does not replay archive', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    await f.owner.flow.dispose()
    expect(await archived).toMatchObject({ ok: false })
    expect(f.db.conversationRepository.archives.read(preview.operationId)?.state).toBe('unresolved')
    expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBeUndefined()
    expect(f.db.sessionRepository.find(scope.sessionId)?.archivedAt).toBeUndefined()
    f.owner.flow = f.open()
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    expect(f.commit).not.toHaveBeenCalled()
    expect(native.runs.size).toBe(1)
    expect(run.aborts).toBe(1)
  })

  it('returns same-nonce successful readback without a second Stop or archive commit', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const first = f.archive(scope, preview.operationId)
    await end(run)
    expect(await first).toMatchObject({ ok: true })
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: true })
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.readCommitted).toHaveBeenCalledTimes(1)
    expect(run.aborts).toBe(1)
    expect(f.receipt(preview.operationId).state).toBe('archived')
  })

  it('fences only the captured Session, permits a sibling Run and refuses an overlapping archive', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const first = f.archive(scope, preview.operationId)
    await flush()
    expect(await f.owner.flow.send(f.input(scope.sessionId))).toMatchObject({ ok: false })
    const sibling = await f.start(f.sessionIds[1])
    const overlap = f.prepare({ kind: 'project', projectId: f.projectId })
    expect(await f.archive(overlap.scope, overlap.operationId)).toMatchObject({ ok: false })
    expect(sibling.aborts).toBe(0)
    expect(run.aborts).toBe(1)
    await end(run)
    expect(await first).toMatchObject({ ok: true })
    expect(f.db.sessionRepository.find(sibling.input.sessionId)?.archivedAt).toBeUndefined()
    expect(f.db.conversationRepository.findRun(sibling.input.runId)?.status).toBe('running')
  })

  it('retires pending @all stages before Stop and never dispatches the second Agent after archive', async () => {
    const f = await fixture()
    const sessionId = f.sessionIds[0]
    const sent = value(await f.owner.flow.send({ ...f.input(sessionId), route: { type: 'all' } }))
    const runId = sent.runs[0]!.id
    await vi.waitFor(() => expect(native.runs.has(runId)).toBe(true))
    await flush()
    const run = native.runs.get(runId)!
    const scope = { kind: 'session', sessionId } as const
    const preview = f.prepare(scope)
    const stop = f.owner.flow.stop.bind(f.owner.flow)
    vi.spyOn(f.owner.flow, 'stop').mockImplementation((input) => {
      expect(f.db.conversationRepository.archives.read(preview.operationId)?.state).toBe('stopping')
      expect(f.db.conversationRepository.pendingRoutedContinuations(scope)).toEqual([])
      return stop(input)
    })
    const archived = f.archive(scope, preview.operationId)
    await end(run)
    value(await archived)
    await flush()
    expect([...native.runs.values()].map((entry) => entry.agentId)).toEqual(['codex'])
    expect(f.db.conversationRepository.pendingRoutedContinuations(scope)).toEqual([])
  })

  it('retires received collaboration input and pauses the task before Stop', async () => {
    const f = await fixture()
    const run = await f.start(f.sessionIds[0], '/plan Keep this task active.')
    const sessionId = run.input.sessionId
    const feedback = f.input(sessionId, 'Preserve this received feedback.')
    expect(await f.owner.flow.send(feedback)).toMatchObject({
      ok: true,
      value: { receivedInputIds: [feedback.clientMessageId] },
    })
    const scope = { kind: 'session', sessionId } as const
    const preview = f.prepare(scope)
    const stop = f.owner.flow.stop.bind(f.owner.flow)
    let stopResult: unknown
    let observed: unknown
    const stopCheck = vi.spyOn(f.owner.flow, 'stop').mockImplementation((input) => {
      observed = {
        receipt: f.db.conversationRepository.archives.read(preview.operationId)?.state,
        input: f.db.conversationRepository.receivedCollaborationInput(sessionId),
        cancelled: f.db.conversationRepository.receivedCollaborationInput(sessionId, true)?.state,
        collaboration: f.db.conversationRepository.collaboration(sessionId)?.automation,
      }
      const result = stop(input)
      stopResult = result
      return result
    })
    const archived = f.archive(scope, preview.operationId)
    expect(observed).toEqual({
      receipt: 'stopping',
      input: undefined,
      cancelled: 'cancelled',
      collaboration: 'paused',
    })
    expect(stopResult).toMatchObject({ ok: true })
    // Re-reading an already accepted nonce remains a pure idempotent receipt read;
    // it must not reauthorize the input retired by the archive claim.
    expect(await f.owner.flow.send(feedback)).toMatchObject({
      ok: true,
      value: { receivedInputIds: [feedback.clientMessageId] },
    })
    expect(f.db.conversationRepository.receivedCollaborationInput(sessionId, true)?.state).toBe(
      'cancelled',
    )
    expect(f.db.conversationRepository.archives.pendingInputs(scope)).toEqual([])
    expect(stopCheck).toHaveBeenCalledTimes(1)
    await end(run)
    const result = await archived
    expect(run.error).toBeUndefined()
    expect(result).toMatchObject({ ok: true })
    await flush()
    expect(native.runs.size).toBe(1)
    expect(f.db.conversationRepository.receivedCollaborationInput(sessionId)).toBeUndefined()
  })

  it('refuses a new received input while archive owns a natively ended collaboration task', async () => {
    const f = await fixture()
    const run = await f.start(f.sessionIds[0], '/plan Keep this task active.')
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    run.ending.resolve('interrupted')
    await vi.waitFor(() =>
      expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBe(
        'interrupted',
      ),
    )
    effectsSettled(run)
    await flush()
    expect(f.receipt(preview.operationId).state).toBe('stopping')
    const lateInput = f.input(scope.sessionId, 'Do not enqueue during archive.')
    expect(await f.owner.flow.send(lateInput)).toMatchObject({ ok: false })
    expect(f.db.conversationRepository.receivedCollaborationInput(scope.sessionId)).toBeUndefined()
    run.tail.resolve()
    expect(await archived).toMatchObject({ ok: true })
    expect(native.runs.size).toBe(1)
  })

  it('keeps archive unresolved when Changes finalization misses the deadline and never commits late', async () => {
    const f = await fixture(true)
    const workspace = f.owner.workspace!
    const gate = Promise.withResolvers<void>()
    cleanupGates.push(() => gate.resolve())
    const finished = workspace.finish.bind(workspace)
    const finalization = vi.spyOn(workspace, 'finish').mockImplementation(async (runId) => {
      await gate.promise
      return finished(runId)
    })
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const archived = f.archive(scope, preview.operationId)
    await end(run)
    expect(finalization).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_STOP_MS)
    expect(await archived).toMatchObject({ ok: false })
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    expect(f.commit).not.toHaveBeenCalled()
    vi.useRealTimers()
    gate.resolve()
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    expect(f.receipt(preview.operationId).state).toBe('not_archived')
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.db.sessionRepository.find(scope.sessionId)?.archivedAt).toBeUndefined()
  })

  it('does not equate an ended iterator with native effects settlement', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    run.ending.resolve('interrupted')
    await vi.waitFor(() =>
      expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBe(
        'interrupted',
      ),
    )
    // The Adapter no longer has an active handle, but it supplied no effect report.
    run.background = false
    run.tail.resolve()
    expect(await archived).toMatchObject({ ok: false })
    expect(['pending', 'unknown']).toContain(
      f.db.conversationRepository.findRun(run.input.runId)?.nativeEffectsState,
    )
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    expect(f.commit).not.toHaveBeenCalled()
    const fresh = f.prepare(scope)
    expect(fresh.blockedReason).toContain('unconfirmed ending')
    expect(run.aborts).toBe(1)
  })

  it('refuses ended foreground work with detached native effects before stopping anything', async () => {
    const f = await fixture()
    const run = await f.start()
    run.ending.resolve('completed')
    await vi.waitFor(() =>
      expect(f.db.conversationRepository.findRun(run.input.runId)?.nativeOutcome).toBe('completed'),
    )
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    expect(preview.blockedReason).toContain('background')
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
    expect(run.aborts).toBe(0)
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('expires the captured confirmation without stopping its still-current Run', async () => {
    const f = await fixture()
    const run = await f.start()
    const scope = { kind: 'session', sessionId: run.input.sessionId } as const
    const preview = f.prepare(scope)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + WORKSPACE_ARCHIVE_PREVIEW_MS)
    expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
    expect(run.aborts).toBe(0)
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('cancels an admitted preparation and a late readiness result cannot create a native Run', async () => {
    const f = await fixture()
    const gate =
      Promise.withResolvers<
        ReturnType<typeof f.preparation.inspectReadiness> extends Promise<infer T> ? T : never
      >()
    let preparationSignal: AbortSignal | undefined
    const readiness = value(await f.preparation.inspectReadiness())
    vi.spyOn(f.preparation, 'inspectReadiness').mockImplementation((signal) => {
      preparationSignal = signal
      return gate.promise
    })
    const scope = { kind: 'session', sessionId: f.sessionIds[0] } as const
    const sending = f.owner.flow.send(f.input(scope.sessionId))
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().preparingExecutions).toBe(1))
    const first = f.prepare(scope)
    expect(first.tasks[0]?.state).toBe('preparing')
    f.owner.flow.cancelWorkspaceArchive(first.operationId)
    expect(preparationSignal?.aborted).toBe(false)
    const second = f.prepare(scope)
    const archived = f.archive(scope, second.operationId)
    await flush()
    expect(preparationSignal?.aborted).toBe(true)
    expect(await archived).toMatchObject({ ok: true })
    gate.resolve({ ok: true, value: readiness })
    expect(await sending).toMatchObject({ ok: false })
    expect(native.runs.size).toBe(0)
  })

  it('refuses inspecting an unconfirmed Rebuild candidate inside a claimed Project archive scope', async () => {
    const f = await fixture()
    const candidate = await settledUnconfirmedCandidate(f)
    const active = await f.start(f.sessionIds[1])
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    expect(preview.blockedReason).toBeUndefined()
    expect(
      f.db.drizzle.get<{ stage: string; nativeWorkState: string }>(
        sql`SELECT stage, native_work_state AS nativeWorkState FROM native_rebuild_operations WHERE id=${candidate.rebuildId}`,
      ),
    ).toEqual({ stage: 'unconfirmed', nativeWorkState: 'settled' })
    const prior = f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')
    const priorDividers = dividers(f, candidate.sessionId)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    expect(f.receipt(preview.operationId).state).toBe('stopping')
    const result = await f.owner.flow.rebuildNativeContext({
      sessionId: candidate.sessionId,
      agentId: 'claude',
      intent: 'inspect',
      clientOperationId: candidate.rebuildId,
      expectedGeneration: 1,
    })
    const after = f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')
    const observations = {
      result,
      adapterCalls: native.inspect.mock.calls.length,
      bindingGeneration: after?.bindingGeneration,
      nativeSessionId: after?.nativeSessionId,
      dividerIds: dividers(f, candidate.sessionId),
      archiveState: f.receipt(preview.operationId).state,
    }
    await end(active)
    await archived
    expect(observations).toMatchObject({
      result: { ok: false, error: { code: 'CONFLICT' } },
      adapterCalls: 0,
      bindingGeneration: prior?.bindingGeneration,
      nativeSessionId: prior?.nativeSessionId,
      dividerIds: priorDividers,
      archiveState: 'stopping',
    })
  })

  it('permits a completed old Rebuild nonce receipt read inside a claimed archive without another probe', async () => {
    const f = await fixture()
    const candidate = await settledUnconfirmedCandidate(f)
    const input = {
      sessionId: candidate.sessionId,
      agentId: 'claude',
      intent: 'inspect',
      clientOperationId: candidate.rebuildId,
      expectedGeneration: 1,
    } as const
    expect(await f.owner.flow.rebuildNativeContext(input)).toMatchObject({ ok: true })
    expect(native.inspect).toHaveBeenCalledTimes(1)
    const prior = f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')
    const priorDividers = dividers(f, candidate.sessionId)
    const active = await f.start(f.sessionIds[1])
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    const archived = f.archive(scope, preview.operationId)
    await flush()
    expect(f.receipt(preview.operationId).state).toBe('stopping')
    expect(await f.owner.flow.rebuildNativeContext(input)).toMatchObject({ ok: true })
    expect(native.inspect).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')).toEqual(prior)
    expect(dividers(f, candidate.sessionId)).toEqual(priorDividers)
    await end(active)
    expect(await archived).toMatchObject({ ok: true })
  })

  it.each([-60_000, 60_000])(
    'enforces the elapsed archive deadline after a %i ms wall-clock change and never commits late',
    async (wallChange) => {
      const f = await fixture()
      const run = await f.start()
      const scope = { kind: 'session', sessionId: run.input.sessionId } as const
      const preview = f.prepare(scope)
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
      const wallStarted = Date.now()
      const monotonicStarted = performance.now()
      let reported: RpcResult<unknown> | undefined
      const archived = f.archive(scope, preview.operationId)
      void archived.then((result) => {
        reported = result
        return undefined
      })
      await flush()
      vi.setSystemTime(Date.now() + wallChange)
      await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_STOP_MS - 100)
      expect(reported).toBeUndefined()
      expect(f.receipt(preview.operationId).state).toBe('stopping')
      await vi.advanceTimersByTimeAsync(100)
      const atDeadline = {
        wallDelta: Date.now() - wallStarted,
        monotonicDelta: performance.now() - monotonicStarted,
        reported: Boolean(reported),
        state: f.receipt(preview.operationId).state,
        commits: f.commit.mock.calls.length,
      }
      await end(run)
      await vi.advanceTimersByTimeAsync(100)
      const result = await archived
      const afterLateEnding = {
        wallDelta: Date.now() - wallStarted,
        monotonicDelta: performance.now() - monotonicStarted,
        result,
        state: f.receipt(preview.operationId).state,
        commits: f.commit.mock.calls.length,
      }
      expect({ atDeadline, afterLateEnding }).toMatchObject({
        atDeadline: {
          wallDelta: wallChange + WORKSPACE_ARCHIVE_STOP_MS,
          monotonicDelta: WORKSPACE_ARCHIVE_STOP_MS,
          reported: true,
          state: 'unresolved',
          commits: 0,
        },
        afterLateEnding: {
          wallDelta: wallChange + WORKSPACE_ARCHIVE_STOP_MS + 100,
          monotonicDelta: WORKSPACE_ARCHIVE_STOP_MS + 100,
          result: { ok: false },
          state: 'not_archived',
          commits: 0,
        },
      })
    },
  )

  it('permits unresolved candidate inspection but activates it only after the archive barrier is resolved and explicitly checked again', async () => {
    const f = await fixture()
    const candidate = await settledUnconfirmedCandidate(f)
    const active = await f.start(f.sessionIds[1])
    const scope = { kind: 'project', projectId: f.projectId } as const
    const preview = f.prepare(scope)
    const prior = f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')
    const priorDividers = dividers(f, candidate.sessionId)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'performance'] })
    const archived = f.archive(scope, preview.operationId)
    await flush()
    await vi.advanceTimersByTimeAsync(WORKSPACE_ARCHIVE_STOP_MS)
    expect(await archived).toMatchObject({ ok: false })
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    vi.useRealTimers()
    const input = {
      sessionId: candidate.sessionId,
      agentId: 'claude',
      intent: 'inspect',
      clientOperationId: candidate.rebuildId,
      expectedGeneration: 1,
    } as const
    expect(await f.owner.flow.rebuildNativeContext(input)).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT' },
    })
    expect(native.inspect).toHaveBeenCalledTimes(1)
    expect(f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')).toEqual(prior)
    expect(dividers(f, candidate.sessionId)).toEqual(priorDividers)
    expect(f.db.conversationRepository.nativeRebuildOperation(candidate.rebuildId)?.stage).toBe(
      'unconfirmed',
    )
    expect(f.receipt(preview.operationId).state).toBe('unresolved')
    expect(f.commit).not.toHaveBeenCalled()
    await end(active)
    await vi.waitFor(() => expect(f.owner.flow.diagnostics().activeExecutions).toBe(0))
    expect(f.receipt(preview.operationId).state).toBe('not_archived')
    expect(await f.owner.flow.rebuildNativeContext(input)).toMatchObject({ ok: true })
    expect(native.inspect).toHaveBeenCalledTimes(2)
    expect(f.db.conversationRepository.nativeContext(candidate.sessionId, 'claude')).toMatchObject({
      bindingGeneration: 2,
      nativeSessionId: candidate.candidateNativeSessionId,
    })
    expect(dividers(f, candidate.sessionId)).toHaveLength(priorDividers.length + 1)
    expect(await f.owner.flow.rebuildNativeContext(input)).toMatchObject({ ok: true })
    expect(native.inspect).toHaveBeenCalledTimes(2)
    expect(dividers(f, candidate.sessionId)).toHaveLength(priorDividers.length + 1)
    expect(f.commit).not.toHaveBeenCalled()
  })

  it('keeps the physical release promise shared and dispose pending until the directory handle closes', async () => {
    const f = await fixture(true)
    const workspace = f.owner.workspace!
    const run = await startRecordedRun(f, 1)
    const entered = Promise.withResolvers<WorkspaceReservation>()
    const gate = Promise.withResolvers<void>()
    cleanupGates.push(() => gate.resolve())
    const originalRelease = workspace.release.bind(workspace)
    const release = vi.spyOn(workspace, 'release').mockImplementation(async (reservation) => {
      entered.resolve(reservation)
      await gate.promise
      await originalRelease(reservation)
    })
    const first = workspace.finish(run.id)
    const reservation = await entered.promise
    const handleOpen = (await reservation.handle.stat()).isDirectory()
    const second = workspace.finish(run.id)
    const scope = { kind: 'session', sessionId: run.sessionId } as const
    let disposed = false
    const disposing = workspace.dispose().then(() => {
      disposed = true
      return undefined
    })
    await flush()
    const beforeRelease = {
      sameFinishPromise: first === second,
      pendingFinalization: workspace.hasPendingFinalization(scope),
      disposeResolved: disposed,
      releaseCalls: release.mock.calls.length,
      directoryHandleStillOpen: handleOpen,
    }
    gate.resolve()
    const results = await Promise.all([first, second, disposing])
    expect(results[0]).toMatchObject({ state: 'ready', fileCount: 1 })
    expect(workspace.hasPendingFinalization(scope)).toBe(false)
    await expect(reservation.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
    expect(beforeRelease).toEqual({
      sameFinishPromise: true,
      pendingFinalization: true,
      disposeResolved: false,
      releaseCalls: 1,
      directoryHandleStillOpen: true,
    })
  })

  it('counts five finishing Runs until their physical releases before admitting another recording', async () => {
    const f = await fixture(true)
    const workspace = f.owner.workspace!
    const runs = []
    for (let index = 0; index < 5; index += 1)
      // oxlint-disable-next-line no-await-in-loop -- Five deterministic fixture captures, before concurrently finalizing their real owners.
      runs.push(await startRecordedRun(f, index))
    const gate = Promise.withResolvers<void>()
    cleanupGates.push(() => gate.resolve())
    const reservations: WorkspaceReservation[] = []
    const entered = Promise.withResolvers<void>()
    const originalRelease = workspace.release.bind(workspace)
    vi.spyOn(workspace, 'release').mockImplementation(async (reservation) => {
      reservations.push(reservation)
      if (reservations.length === runs.length) entered.resolve()
      await gate.promise
      await originalRelease(reservation)
    })
    const finishing = runs.map((run) => workspace.finish(run.id))
    // Actual directory Workers own their deadlines; release-entry readiness is
    // a physical seam, not Vitest's default one-second polling expectation.
    await entered.promise
    const handlesOpen = await Promise.all(
      reservations.map(async (reservation) => (await reservation.handle.stat()).isDirectory()),
    )
    const sixth = recordingRun(f, 6)
    const sixthStart = await workspace.start(sixth, new AbortController().signal)
    const beforeRelease = {
      releaseCount: reservations.length,
      openDirectoryHandleCount: handlesOpen.filter(Boolean).length,
      pendingFinalizationCount: runs.filter((run) =>
        workspace.hasPendingFinalization({ kind: 'session', sessionId: run.sessionId }),
      ).length,
      sharedFinishCount: runs.filter((run, index) => workspace.finish(run.id) === finishing[index])
        .length,
      sixthStart,
    }
    gate.resolve()
    const results = await Promise.all(finishing)
    expect(results.every((result) => result?.state === 'ready')).toBe(true)
    await workspace.finish(sixth.id)
    await Promise.all(
      reservations.map(async (reservation) => {
        await expect(reservation.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
      }),
    )
    expect(beforeRelease).toMatchObject({
      releaseCount: 5,
      openDirectoryHandleCount: 5,
      pendingFinalizationCount: 5,
      sharedFinishCount: 5,
      sixthStart: expect.stringContaining('recording slots'),
    })
  })

  it.each([false, true])(
    'does not archive or reclaim recording capacity when directory close rejects after physical close=%s',
    async (physicallyClosed) => {
      const f = await fixture(true)
      const workspace = f.owner.workspace!
      const failedCloses = new Map<
        string,
        {
          reservation: WorkspaceReservation
          close: () => Promise<void>
          restore: () => void
          calls: () => number
        }
      >()
      const originalRelease = workspace.release.bind(workspace)
      vi.spyOn(workspace, 'release').mockImplementation(async (reservation) => {
        if (!failedCloses.has(reservation.ownerId)) {
          const originalClose = reservation.handle.close.bind(reservation.handle)
          const close = vi.spyOn(reservation.handle, 'close').mockImplementationOnce(async () => {
            if (physicallyClosed) await originalClose()
            throw new Error('Controlled directory close rejection.')
          })
          f.owner.workspaceCleanupFailed = true
          failedCloses.set(reservation.ownerId, {
            reservation,
            close: originalClose,
            restore: () => close.mockRestore(),
            calls: () => close.mock.calls.length,
          })
        }
        await originalRelease(reservation)
      })
      try {
        const nativeFile = join(f.projectDirectory, 'native-recorded.txt')
        await writeFile(nativeFile, 'Before\n')
        const active = await f.start()
        await writeFile(nativeFile, 'After\n')
        await active.input.recordFileChange?.(
          {
            operationId: randomUUID(),
            path: 'native-recorded.txt',
            kind: 'modified',
            before: 'Before\n',
            after: 'After\n',
          },
          active.signal,
        )
        const supportedRuns = []
        for (let index = 1; index < 5; index += 1)
          // oxlint-disable-next-line no-await-in-loop -- Fill the existing five recording slots with genuine fixtures before observing failed cleanup.
          supportedRuns.push(await startRecordedRun(f, index))
        const supportFinishes = await Promise.allSettled(
          supportedRuns.map((run) => workspace.finish(run.id)),
        )
        const scope = { kind: 'session', sessionId: active.input.sessionId } as const
        const preview = f.prepare(scope)
        const archived = f.archive(scope, preview.operationId)
        await end(active)
        const result = await archived
        const directoryHandles = await Promise.all(
          [...failedCloses.values()].map(async (failure) =>
            failure.reservation.handle.stat().then(
              (identity) => ({ open: identity.isDirectory(), fd: failure.reservation.handle.fd }),
              (error: unknown) => ({
                open: false,
                fd: failure.reservation.handle.fd,
                code: error instanceof Error && 'code' in error ? error.code : undefined,
              }),
            ),
          ),
        )
        const descriptor = expect.any(Number)
        expect(directoryHandles).toEqual(
          Array.from({ length: 5 }, () =>
            physicallyClosed
              ? { open: false, fd: -1, code: 'EBADF' }
              : { open: true, fd: descriptor },
          ),
        )
        const sixth = recordingRun(f, 6)
        const sixthStart = await workspace.start(sixth, new AbortController().signal)
        const observations = {
          result,
          receiptState: f.receipt(preview.operationId).state,
          archivedAt: f.db.sessionRepository.find(scope.sessionId)?.archivedAt,
          pendingFinalization: workspace.hasPendingFinalization(scope),
          pendingSupportCount: supportedRuns.filter((run) =>
            workspace.hasPendingFinalization({ kind: 'session', sessionId: run.sessionId }),
          ).length,
          nativeAborts: active.aborts,
          failedCloseCount: failedCloses.size,
          closeCallCounts: [...failedCloses.values()].map((failure) => failure.calls()),
          openDirectoryHandleCount: directoryHandles.filter((handle) => handle.open).length,
          supportFinishStatuses: supportFinishes.map((finish) => finish.status),
          sixthStart,
          commits: f.commit.mock.calls.length,
        }
        const firstFinish = workspace.finish(active.input.runId)
        const repeatedFinish = workspace.finish(active.input.runId)
        expect(firstFinish).toBe(repeatedFinish)
        await expect(firstFinish).rejects.toMatchObject({ code: 'WORKSPACE_RECOVERY_REQUIRED' })
        await expect(workspace.awaitFinalization(scope)).rejects.toMatchObject({
          code: 'WORKSPACE_RECOVERY_REQUIRED',
        })
        expect(f.receipt(preview.operationId).state).toBe('unresolved')
        expect(f.receipt(preview.operationId).state).toBe('unresolved')
        expect(await f.archive(scope, preview.operationId)).toMatchObject({ ok: false })
        expect(active.aborts).toBe(1)
        expect(f.commit).not.toHaveBeenCalled()
        expect([...failedCloses.values()].map((failure) => failure.calls())).toEqual([
          1, 1, 1, 1, 1,
        ])
        await expect(workspace.dispose()).rejects.toMatchObject({
          code: 'WORKSPACE_RECOVERY_REQUIRED',
        })
        expect(workspace.hasPendingFinalization(scope)).toBe(true)
        expect(
          supportedRuns.filter((run) =>
            workspace.hasPendingFinalization({ kind: 'session', sessionId: run.sessionId }),
          ),
        ).toHaveLength(4)
        expect([...failedCloses.values()].map((failure) => failure.calls())).toEqual([
          1, 1, 1, 1, 1,
        ])
        // Restore and really close the descriptors before exposing any failed assertion.
        for (const failure of failedCloses.values()) failure.restore()
        await Promise.all(
          [...failedCloses.values()].map(async (failure) => {
            await failure.close()
            await expect(failure.reservation.handle.stat()).rejects.toMatchObject({ code: 'EBADF' })
          }),
        )
        expect(workspace.hasPendingFinalization(scope)).toBe(true)
        expect(f.receipt(preview.operationId).state).toBe('unresolved')
        await expect(workspace.dispose()).rejects.toMatchObject({
          code: 'WORKSPACE_RECOVERY_REQUIRED',
        })
        await workspace.finish(sixth.id)
        expect(observations).toMatchObject({
          result: { ok: false },
          receiptState: 'unresolved',
          archivedAt: undefined,
          pendingFinalization: true,
          pendingSupportCount: 4,
          nativeAborts: 1,
          failedCloseCount: 5,
          closeCallCounts: [1, 1, 1, 1, 1],
          openDirectoryHandleCount: physicallyClosed ? 0 : 5,
          supportFinishStatuses: ['rejected', 'rejected', 'rejected', 'rejected'],
          sixthStart: expect.stringContaining('recording slots'),
          commits: 0,
        })
      } finally {
        for (const failure of failedCloses.values()) failure.restore()
        await Promise.all([...failedCloses.values()].map((failure) => failure.close()))
      }
    },
  )
})
