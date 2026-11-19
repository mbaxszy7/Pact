import Database from 'better-sqlite3'
import { build } from 'electron-vite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AgentNativeForkWitness, AgentRunInput } from '@pact/agent-runtime'
import type {
  DefaultSessionSettings,
  NormalizedAgentEvent,
  PeerRequestKind,
  RuntimeAgentId,
} from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { AgyAcpConnectionPool } from './agy-acp-connection.js'
import {
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
  encodeAgyPlannerResponseStep,
  encodeAgyUserInputStep,
  encodeBytesField,
  encodeCortexStepMetadata,
  encodeExecutorMetadata,
  encodeProtobufFields,
  encodeStringField,
  encodeVarintField,
} from './agy-native-storage.js'
import {
  Conversation,
  createAgyNativeStorageClient,
  resolveEffectiveAgyAppDataDir,
} from './conversation.js'
import { NativeForkFiles } from './native-fork-files.js'

const forkWorkerBundle = vi.hoisted(() => ({ path: '' }))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        const redirected =
          typeof filename === 'string' &&
          filename.endsWith('native-fork-worker.js') &&
          forkWorkerBundle.path
            ? forkWorkerBundle.path
            : filename
        super(redirected, options)
      }
    },
  }
})

let workerBundleDir = ''
beforeAll(async () => {
  workerBundleDir = await mkdtemp(join(tmpdir(), 'pact-m5-fork-worker-'))
  const desktopRoot = resolve(import.meta.dirname, '../../..')
  const require = createRequire(join(desktopRoot, 'package.json'))
  const configFile = join(workerBundleDir, 'worker.config.mjs')
  const betterSqliteEntry = pathToFileURL(require.resolve('better-sqlite3')).href
  await writeFile(
    configFile,
    `import {externalizeDepsPlugin} from ${JSON.stringify(pathToFileURL(require.resolve('electron-vite')).href)}; export default {main:{plugins:[externalizeDepsPlugin({exclude:['@pact/contracts']})],resolve:{alias:{'better-sqlite3':${JSON.stringify(betterSqliteEntry)}}},build:{outDir:${JSON.stringify(join(workerBundleDir, 'bundle'))},rollupOptions:{external:[${JSON.stringify(betterSqliteEntry)}],input:{'native-fork-worker':${JSON.stringify(join(import.meta.dirname, 'native-fork-worker.ts'))}}}}}};`,
  )
  await build({ root: desktopRoot, configFile, ignoreConfigWarning: true, logLevel: 'silent' })
  forkWorkerBundle.path = join(workerBundleDir, 'bundle', 'native-fork-worker.js')
}, 20_000)

afterAll(async () => {
  if (workerBundleDir) await rm(workerBundleDir, { recursive: true, force: true })
})

const harness = vi.hoisted(() => ({
  constructed: [] as Array<{
    agentId: RuntimeAgentId
    executablePath: string
    peerTargetAgentId?: RuntimeAgentId | undefined
  }>,
  agyOptions: [] as Array<unknown>,
  runs: [] as Array<{ agentId: RuntimeAgentId; input: AgentRunInput }>,
  retiredFullAccess: [] as Array<{ cwd?: string | undefined; sessionId?: string | undefined }>,
  emitTitleByAgent: new Map<RuntimeAgentId, string>(),
  emitPeerProposal: undefined as
    | { from: RuntimeAgentId; target: RuntimeAgentId; kind: PeerRequestKind }
    | undefined,
  waitOnAgent: undefined as RuntimeAgentId | undefined,
  releaseWait: undefined as (() => void) | undefined,
  nextRunBehavior: undefined as
    | ((agentId: RuntimeAgentId, input: AgentRunInput) => Promise<void> | void)
    | undefined,
  rebuildHandler: undefined as
    | ((
        input: import('@pact/agent-runtime').AgentNativeContextRebuildInput,
        source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
        signal: AbortSignal,
      ) => Promise<import('@pact/agent-runtime').AgentNativeContextRebuildResult>)
    | undefined,
  rebuildCheckHandler: undefined as
    | ((
        input: import('@pact/agent-runtime').AgentNativeContextRebuildInput,
        source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
        signal: AbortSignal,
      ) => Promise<import('@pact/agent-runtime').AgentNativeContextRebuildResult | undefined>)
    | undefined,
}))

function createMockAdapter(agentId: RuntimeAgentId) {
  const executorUuid =
    agentId === 'agy'
      ? '00000000-0000-4000-8000-0000000000a1'
      : agentId === 'codex'
        ? '00000000-0000-4000-8000-0000000000c2'
        : '00000000-0000-4000-8000-0000000000c3'
  return class {
    readonly id = agentId
    readonly executorId = executorUuid

    constructor(...args: unknown[]) {
      if (agentId === 'agy') {
        const raw = args[0]
        if (typeof raw === 'object' && raw !== null) {
          harness.agyOptions.push(raw)
        }
        const execPath =
          typeof raw === 'object' &&
          raw !== null &&
          typeof Reflect.get(raw, 'executablePath') === 'string'
            ? String(Reflect.get(raw, 'executablePath'))
            : ''
        const peerRaw =
          typeof raw === 'object' && raw !== null
            ? Reflect.get(raw, 'peerTargetAgentId')
            : undefined
        const peerTargetAgentId =
          peerRaw === 'claude' || peerRaw === 'codex' || peerRaw === 'agy' ? peerRaw : undefined
        harness.constructed.push({
          agentId,
          executablePath: execPath,
          peerTargetAgentId,
        })
      } else {
        const execPath = typeof args[0] === 'string' ? args[0] : ''
        harness.constructed.push({ agentId, executablePath: execPath })
      }
    }

    async retireFullAccess(options?: { cwd?: string; sessionId?: string }): Promise<void> {
      harness.retiredFullAccess.push({ cwd: options?.cwd, sessionId: options?.sessionId })
    }

    async rebuildNativeContext(
      input: import('@pact/agent-runtime').AgentNativeContextRebuildInput,
      source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
      signal: AbortSignal,
    ) {
      if (harness.rebuildHandler) {
        return harness.rebuildHandler(input, source, signal)
      }
      throw new Error('Unexpected rebuildNativeContext call')
    }

    beginNativeRebuildCheck(
      input: import('@pact/agent-runtime').AgentNativeContextRebuildInput,
      source: AsyncIterable<import('@pact/contracts').NativeContextRebuildChunk>,
      signal: AbortSignal,
    ) {
      const result = Promise.resolve().then(() =>
        harness.rebuildCheckHandler
          ? harness.rebuildCheckHandler(input, source, signal)
          : Promise.resolve(undefined),
      )
      return {
        result,
        physicalCompletion: result.then(
          () => undefined,
          () => undefined,
        ),
      }
    }

    async *run(input: AgentRunInput, signal: AbortSignal): AsyncGenerator<NormalizedAgentEvent> {
      harness.runs.push({ agentId, input })
      if (harness.nextRunBehavior) {
        const custom = harness.nextRunBehavior
        harness.nextRunBehavior = undefined
        await custom(agentId, input)
        return
      }
      const nativeSessionId =
        input.nativeSessionId ?? `${agentId}-sid-${input.sessionId.slice(0, 8)}`
      input.recordDispatch?.('possibly_sent', nativeSessionId)
      yield { agentId, type: 'session.started', nativeSessionId }
      input.recordDispatch?.('accepted', nativeSessionId)
      yield { agentId, type: 'turn.started', turnId: input.runId }

      if (harness.waitOnAgent === agentId) {
        await new Promise<void>((done) => {
          harness.releaseWait = done
          signal.addEventListener('abort', () => done(), { once: true })
          if (signal.aborted) done()
        })
        harness.waitOnAgent = undefined
        harness.releaseWait = undefined
        signal.throwIfAborted()
      }

      const customTitle = harness.emitTitleByAgent.get(agentId)
      if (customTitle && input.promptEnvelope.requestSessionTitle) {
        yield {
          agentId,
          type: 'session.title.updated',
          title: customTitle,
        }
      }

      if (harness.emitPeerProposal?.from === agentId) {
        yield {
          agentId,
          type: 'peer.assistance.requested',
          turnId: input.runId,
          proposalId: randomUUID(),
          targetAgentId: harness.emitPeerProposal.target,
          kind: harness.emitPeerProposal.kind,
          reason: 'Verify boundary assumptions.',
        }
      }

      yield {
        agentId,
        type: 'text.completed',
        turnId: input.runId,
        outputId: `${agentId}-out`,
        text: `${agentId} response to ${input.promptEnvelope.message.content}`,
      }
      yield { agentId, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: String(input.nativeGeneration ?? 1),
        state: 'settled',
      })
    }

    async dispose(): Promise<void> {}
  }
}

vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: createMockAdapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: createMockAdapter('claude') }))
vi.mock('./agy-agent-adapter.js', () => ({ AgyAgentAdapter: createMockAdapter('agy') }))

const owners: Array<{ db: PactDatabase; flow?: Conversation | undefined; directory: string }> = []

afterEach(async () => {
  harness.releaseWait?.()
  await Promise.all(
    owners.splice(0).map(async (owner) => {
      await owner.flow?.dispose()
      owner.db.close()
      await rm(owner.directory, { recursive: true, force: true })
    }),
  )
  harness.constructed = []
  harness.agyOptions = []
  harness.runs = []
  harness.retiredFullAccess = []
  harness.emitTitleByAgent.clear()
  harness.emitPeerProposal = undefined
  harness.waitOnAgent = undefined
  harness.releaseWait = undefined
  harness.nextRunBehavior = undefined
  harness.rebuildHandler = undefined
  harness.rebuildCheckHandler = undefined
  vi.restoreAllMocks()
})

async function createOrchestrationFixture(options: {
  primaryAgentId: RuntimeAgentId
  secondaryAgentId: RuntimeAgentId
  readyAgents?: ReadonlyArray<{ agentId: RuntimeAgentId; path: string }>
  permissionModes?: Partial<Record<RuntimeAgentId, 'native' | 'ask' | 'auto' | 'full'>>
}) {
  const directory = await mkdtemp(join(tmpdir(), 'pact-agy-orch-'))
  const filePath = join(directory, 'fixture.sqlite')
  const migrationsFolder = resolve(
    import.meta.dirname,
    '../../../../../packages/persistence/drizzle',
  )
  const db = await PactDatabase.open({ filePath, migrationsFolder })
  const owner: (typeof owners)[number] = { db, directory }
  owners.push(owner)

  const projectId = randomUUID()
  const sessionId = randomUUID()
  const createdAt = '2026-11-19T10:00:00.000Z'
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'AgyOrchestration',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  const settings: DefaultSessionSettings = {
    primaryAgentId: options.primaryAgentId,
    secondaryAgentId: options.secondaryAgentId,
    agents: {
      claude: { model: null, effort: null },
      codex: { model: null, effort: null },
      agy: { model: null, effort: null },
    },
    ...(options.permissionModes
      ? {
          permissionModes: {
            claude: 'native',
            codex: 'native',
            agy: 'native',
            ...options.permissionModes,
          },
        }
      : {}),
    maxDiscussionRounds: 3,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'New session', createdAt },
    settings,
  )

  const readyMap = new Map(
    (
      options.readyAgents ?? [
        { agentId: 'claude', path: '/mock/bin/claude' },
        { agentId: 'codex', path: '/mock/bin/codex' },
        { agentId: 'agy', path: '/mock/bin/agy' },
      ]
    ).map((entry) => [entry.agentId, entry.path]),
  )

  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockImplementation(
    async (agentId: RuntimeAgentId) => readyMap.get(agentId),
  )
  vi.spyOn(preparation, 'inspectReadiness').mockImplementation(async () => ({
    ok: true as const,
    value: {
      firstUse: false,
      agents: (['claude', 'codex', 'agy'] as const).map((agentId) => {
        const execPath = readyMap.get(agentId)
        return execPath
          ? { agentId, executablePath: execPath, state: 'ready' as const, checkedAt: createdAt }
          : { agentId, state: 'missing' as const, checkedAt: createdAt }
      }),
    },
  }))

  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
  )
  owner.flow = flow

  const sendMessage = async (
    targetSessionId: string,
    content: string,
    extra: Partial<Parameters<Conversation['send']>[0]> = {},
  ) => {
    const drafts = db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: targetSessionId,
    })
    if (drafts.scope !== 'drafts') throw new Error('Expected drafts scope')
    return flow.send({
      sessionId: targetSessionId,
      clientMessageId: randomUUID(),
      content,
      commentIds: [],
      expectedCommentsRevision: drafts.commentsRevision,
      ...extra,
    })
  }

  const waitForIdle = async () => {
    await vi.waitFor(() => expect(flow.diagnostics().activeExecutions).toBe(0))
  }

  return { db, flow, sessionId, projectId, readyMap, sendMessage, waitForIdle }
}

describe('Module 5 Conversation 3-Agent & Antigravity Orchestration', () => {
  it('succeeds when unselected 3rd CLI is unready, never clobbers codex executable path with agy, and fails when an active-pair CLI is missing', async () => {
    // Active pair is (codex, agy), while claude is NOT installed ('missing')!
    const f = await createOrchestrationFixture({
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
      readyAgents: [
        { agentId: 'codex', path: '/opt/codex-bin/codex' },
        { agentId: 'agy', path: '/opt/antigravity/agy' },
      ],
    })

    const sent = await f.sendMessage(f.sessionId, '@all Verify distinct executables', {
      route: { type: 'all' },
    })
    expect(sent.ok).toBe(true)
    await f.waitForIdle()

    expect(harness.runs.map((r) => r.agentId)).toEqual(['codex', 'agy'])
    expect(harness.constructed).toEqual([
      { agentId: 'codex', executablePath: '/opt/codex-bin/codex' },
      {
        agentId: 'agy',
        executablePath: '/opt/antigravity/agy',
        peerTargetAgentId: 'codex',
      },
    ])

    // If active-pair member 'agy' becomes missing, send fails with RUNTIME_UNAVAILABLE!
    f.readyMap.delete('agy')
    const blocked = await f.sendMessage(f.sessionId, 'Hello again')
    expect(blocked).toEqual({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE', message: 'Both Agents must be ready.' },
    })
  })

  it('rejects @inactiveAgent and /inactiveSkill before creating any Message or Run, and preserves A -> B -> C -> B handoff across idle 3rd-agent replacement', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
    })

    // 1. Explicit @claude on (codex, agy) MUST be rejected before creating any Message/Run!
    const rejectedMention = await f.sendMessage(f.sessionId, '@claude Try inactive agent', {
      route: { type: 'agent', agentId: 'claude' },
    })
    expect(rejectedMention).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: expect.stringMatching(/Claude Code[\s\S]*Your draft was preserved\./),
      },
    })

    // 2. Explicit /skill belonging to inactive 'claude' MUST be rejected before creating any Message/Run!
    const rejectedSkill = await f.sendMessage(f.sessionId, '/audit Run inactive skill', {
      skills: [{ id: 'a'.repeat(64), agentId: 'claude', name: 'audit', start: 0, end: 6 }],
    })
    expect(rejectedSkill).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: expect.stringMatching(/Claude Code[\s\S]*Your draft was preserved\./),
      },
    })
    expect(f.db.conversationRepository.read(f.sessionId).messages).toHaveLength(0)
    expect(f.db.conversationRepository.read(f.sessionId).runs).toHaveLength(0)

    // 3. A (codex) -> B (agy) -> idle swap to (claude, agy) -> C (claude) -> B (agy) handoff!
    expect((await f.sendMessage(f.sessionId, 'Step A for codex')).ok).toBe(true)
    await f.waitForIdle()
    expect((await f.sendMessage(f.sessionId, '@agy Step B1 for agy')).ok).toBe(true)
    await f.waitForIdle()

    // Swap active pair from (codex, agy) -> (claude, agy) while idle!
    const current = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...current.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'agy',
    })
    await f.flow.reconcileSessionSettingsChanged(f.sessionId)

    expect((await f.sendMessage(f.sessionId, 'Step C for claude')).ok).toBe(true)
    await f.waitForIdle()

    expect((await f.sendMessage(f.sessionId, '@agy Summarize after swap')).ok).toBe(true)
    await f.waitForIdle()

    const finalAgyRun = harness.runs.at(-1)!
    expect(finalAgyRun.agentId).toBe('agy')
    // B (agy) receives C (claude)'s turn in handoffContext, and peerTargetAgentId updated to 'claude'!
    expect(finalAgyRun.input.promptEnvelope.handoffContext?.map((h) => h.speaker)).toContain(
      'claude',
    )
    expect(harness.constructed.findLast((c) => c.agentId === 'agy')?.peerTargetAgentId).toBe(
      'claude',
    )
  })

  it('publishes Antigravity titles on Main & Side Chats, resolves @Main queue anchor when parent only ran agy, and routes cross-pair @Main', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    // 1. Main session title adopted from agy's session.title.updated!
    harness.emitTitleByAgent.set('agy', 'Antigravity Main Investigation')
    expect((await f.sendMessage(f.sessionId, 'Investigate ACP framing')).ok).toBe(true)
    await f.waitForIdle()
    expect(f.db.sessionRepository.find(f.sessionId)?.title).toBe('Antigravity Main Investigation')
    expect(f.db.sessionRepository.find(f.sessionId)?.titleSource).toBe('agent')

    // 2. Create Side Chat, emit Side Chat title via agy's publish_session_title!
    const createdSide = await f.flow.createSideChat({
      parentSessionId: f.sessionId,
      operationId: randomUUID(),
      origin: 'btw',
    })
    expect(createdSide.ok).toBe(true)
    if (!createdSide.ok) return
    const sideChatId = createdSide.value.sideChat.id
    expect(f.db.sessionRepository.find(sideChatId)?.title).toBe('New side chat')

    harness.emitTitleByAgent.set('agy', 'Focused ACP Side Branch')
    expect((await f.sendMessage(sideChatId, 'Check framing edge case')).ok).toBe(true)
    await f.waitForIdle()
    expect(f.db.sessionRepository.find(sideChatId)?.title).toBe('Focused ACP Side Branch')
    expect(f.db.sessionRepository.find(sideChatId)?.titleSource).toBe('agent')

    // 3. Start a slow agy run on Parent (where parent's ONLY runs are 'agy'), enable queue, and sync @Main from Side Chat!
    f.flow.setConversationQueueEnabled({
      sessionId: f.sessionId,
      enabled: true,
      expectedRevision: 0,
      operationId: randomUUID(),
    })
    harness.waitOnAgent = 'agy'
    expect((await f.sendMessage(f.sessionId, 'Long running parent agy turn')).ok).toBe(true)
    await vi.waitFor(() => expect(harness.releaseWait).toBeTypeOf('function'))

    const sideDrafts = f.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: sideChatId,
    })
    if (sideDrafts.scope !== 'drafts') throw new Error('Expected side drafts')
    const syncedWhileBusy = await f.flow.syncSideChatToMain({
      sideChatId,
      operationId: randomUUID(),
      content: '@Main Bring back side-chat finding while agy runs',
      imageIds: [],
      commentIds: [],
      skills: [],
      expectedCommentsRevision: sideDrafts.commentsRevision,
    })
    expect(syncedWhileBusy.ok).toBe(true)
    harness.releaseWait?.()
    await f.waitForIdle()

    // 4. Swap Parent to (claude, codex) while Side Chat stays locked to (agy, codex), and verify cross-pair @Main routes to Parent's primary ('claude')!
    const latestParent = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...latestParent.settings,
      primaryAgentId: 'claude',
      secondaryAgentId: 'codex',
    })
    const sideDrafts2 = f.db.conversationRepository.readPage({
      scope: 'drafts',
      sessionId: sideChatId,
    })
    if (sideDrafts2.scope !== 'drafts') throw new Error('Expected side drafts')
    const crossPairSync = await f.flow.syncSideChatToMain({
      sideChatId,
      operationId: randomUUID(),
      content: '@Main Apply side-chat conclusion to Claude main pair',
      imageIds: [],
      commentIds: [],
      skills: [],
      expectedCommentsRevision: sideDrafts2.commentsRevision,
    })
    expect(crossPairSync.ok).toBe(true)
    await f.waitForIdle()
    expect(harness.runs.at(-1)?.agentId).toBe('claude')
  })

  it('routes dynamic Peer Assistance to agy, blocks acceptPeerProposal when swapped out, and retires Full access on settings change', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
      permissionModes: { agy: 'full', codex: 'native' },
    })

    // First run agy once so AgyAgentAdapter is cached in Full access, then run codex proposing peer assistance from 'agy'!
    expect((await f.sendMessage(f.sessionId, '@agy Initial full-access check')).ok).toBe(true)
    await f.waitForIdle()

    harness.emitPeerProposal = { from: 'codex', target: 'agy', kind: 'review' }
    expect((await f.sendMessage(f.sessionId, 'Draft implementation in codex')).ok).toBe(true)
    await f.waitForIdle()
    harness.emitPeerProposal = undefined

    const codexRun = f.db.conversationRepository
      .read(f.sessionId)
      .runs.find((r) => r.agentId === 'codex')!
    expect(codexRun.peerProposal?.targetAgentId).toBe('agy')

    const accepted = await f.flow.acceptPeerProposal({
      sessionId: f.sessionId,
      proposalId: codexRun.peerProposal!.id,
      clientMessageId: randomUUID(),
    })
    expect(accepted.ok).toBe(true)
    await f.waitForIdle()
    expect(harness.runs.at(-1)?.agentId).toBe('agy')
    expect(harness.runs.at(-1)?.input.promptEnvelope.message.content).toContain(
      '@agy Review Codex’s previous response.',
    )

    // Emit a second peer proposal targeting 'agy', then swap 'agy' out of active pair (leaving Full access)!
    harness.emitPeerProposal = { from: 'codex', target: 'agy', kind: 'challenge' }
    expect((await f.sendMessage(f.sessionId, 'Second codex turn')).ok).toBe(true)
    await f.waitForIdle()
    const secondCodexRun = f.db.conversationRepository
      .read(f.sessionId)
      .runs.findLast((r) => r.agentId === 'codex')!

    const current = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.saveSettings(f.sessionId, {
      ...current.settings,
      primaryAgentId: 'codex',
      secondaryAgentId: 'claude',
      permissionModes: {
        claude: 'native',
        codex: 'native',
        ...current.settings.permissionModes,
        agy: 'ask',
      },
    })
    await f.flow.reconcileSessionSettingsChanged(f.sessionId)
    expect(harness.retiredFullAccess).toHaveLength(1)
    expect(harness.retiredFullAccess[0]?.sessionId).toBe(f.sessionId)

    const staleAccept = await f.flow.acceptPeerProposal({
      sessionId: f.sessionId,
      proposalId: secondCodexRun.peerProposal!.id,
      clientMessageId: randomUUID(),
    })
    expect(staleAccept).toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('Antigravity'),
      },
    })
  })

  it('bridges AgyNativeStorageClient cleanly onto NativeForkFiles cold inspection, rebuild seed, and fork methods', async () => {
    const runId = randomUUID()
    const steerId = randomUUID()
    const sessionId = randomUUID()
    const requestId = randomUUID()
    const answerText = 'Recovered cold SQLite answer.'
    const answerHash = createHash('sha256').update(answerText).digest('hex')

    let coldStatus: 'completed' | 'running' = 'completed'
    let coldLoadConfirmedWitness:
      | import('@pact/agent-runtime').AgyRebuildInitializationWitness
      | undefined
    const mockForkFiles: Parameters<typeof createAgyNativeStorageClient>[0] = {
      async inspectAgyRun() {
        return {
          exists: true,
          stepCount: 4,
          terminalState: {
            executionId: 'exec-cold-1',
            status: coldStatus,
            consumedInputStepIds: ['step-0'],
            consumedInputs: [
              {
                stepIndex: 0,
                stepId: 'step-0',
                pactRunId: runId,
                textSha256: 'a'.repeat(64),
              },
              {
                stepIndex: 2,
                stepId: 'step-2',
                pactMessageId: steerId,
                textSha256: 'b'.repeat(64),
              },
            ],
            answer: answerText,
            responseHash: answerHash,
            plan: { nativeId: 'implementation_plan.md', text: '# Cold Plan\n' },
          },
        }
      },
      async rebuildAgySeed(input) {
        return {
          nativeSessionId: input.nativeSessionId,
          seedHash: 'c'.repeat(64),
          chunkCount: input.chunks.length,
          stepCount: 2,
          pbSha256: 'd'.repeat(64),
          pbBytes: 512,
          verifiedPrefixBytes: 512,
          verifiedPrefixSha256: 'd'.repeat(64),
        }
      },
      async confirmAgyRebuildColdLoad(input) {
        coldLoadConfirmedWitness = {
          kind: 'agy_rebuild_v1',
          nativeSessionId: input.nativeSessionId,
          pbSha256: input.pbSha256,
          pbBytes: input.pbBytes,
          stepCount: input.stepCount,
          sourceHash: input.sourceHash,
          coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
        }
        return coldLoadConfirmedWitness
      },
      async verifyAgySeed(input) {
        return {
          nativeSessionId: input.nativeSessionId,
          seedHash: 'c'.repeat(64),
          chunkCount: input.chunks.length,
          stepCount: 2,
          pbSha256: 'd'.repeat(64),
          pbBytes: 512,
          verifiedPrefixBytes: 512,
          verifiedPrefixSha256: 'd'.repeat(64),
          ...(coldLoadConfirmedWitness ? { initializationWitness: coldLoadConfirmedWitness } : {}),
        }
      },
      async execute(input) {
        return {
          nativeSessionId: input.nativeSessionId,
          nativeCutId: 'exec-cold-1',
          prefixHash: 'e'.repeat(64),
          prefixBytes: 1024,
          prefixRecords: 4,
          idMap: [[runId, randomUUID()]],
          rawHash: 'f'.repeat(64),
          rawBytes: 2048,
          rawRecords: 4,
          initializedVerified: true,
        }
      },
      async prepareAgyBoundary(input) {
        return {
          provider: 'agy',
          nativeSessionId: input.nativeSessionId,
          nativeTurnId: input.nativeTurnId,
          nativeCutId: 'exec-cold-1',
          agyCut: {
            version: 'pact-agy-fork-cut-v1',
            trajectoryId: 'traj-cold-1',
            executionId: 'exec-cold-1',
            cutStepIdx: 3,
          },
          bindingGeneration: input.bindingGeneration,
          throughSequence: input.throughSequence,
          deliveryCursor: input.deliveryCursor,
          prefixHash: 'e'.repeat(64),
          prefixBytes: 1024,
          prefixRecords: 4,
        }
      },
      async exists() {
        return true
      },
      async forkAgy(input) {
        return {
          nativeSessionId: input.candidateNativeSessionId,
          witness: {
            version: 'pact-native-fork-v1',
            nativeSessionId: input.candidateNativeSessionId,
            sourceNativeSessionId: 'sid-src',
            sourceCutId: 'exec-cold-1',
            sourcePrefixHash: 'e'.repeat(64),
            candidatePrefixHash: 'e'.repeat(64),
            idMap: [[runId, randomUUID()]],
            model: null,
            effort: null,
            permissionMode: 'ask',
          },
          file: {
            nativeSessionId: input.candidateNativeSessionId,
            nativeCutId: 'exec-cold-1',
            prefixHash: 'e'.repeat(64),
            prefixBytes: 1024,
            prefixRecords: 4,
            idMap: [[runId, randomUUID()]],
            rawHash: 'f'.repeat(64),
            rawBytes: 2048,
            rawRecords: 4,
          },
        }
      },
    }

    const client = createAgyNativeStorageClient(mockForkFiles, '/tmp/mock-app-data')
    const signal = new AbortController().signal

    const probed = await client.probeSessionStatus!(
      {
        sessionId,
        agentId: 'agy',
        requestId,
        runId,
        nativeSessionId: 'sid-cold-1',
        nativeTurnId: runId,
        bindingGeneration: 1,
        cwd: '/tmp/proj',
        model: null,
        effort: null,
        planSource: true,
      },
      signal,
    )
    expect(probed).toMatchObject({
      kind: 'ended',
      outcome: 'completed',
      output: {
        outputId: 'exec-cold-1',
        text: answerText,
        completeness: 'complete',
        plan: { nativeId: 'implementation_plan.md', text: '# Cold Plan\n' },
      },
    })

    const receipts = await client.probeInputReceipts!(
      {
        sessionId,
        agentId: 'agy',
        requestId,
        runId,
        nativeSessionId: 'sid-cold-1',
        nativeTurnId: runId,
        bindingGeneration: 1,
        cwd: '/tmp/proj',
        model: null,
        effort: null,
        unresolvedInputIds: [runId, steerId, 'unmatched-id'],
        recordConsumption: () => undefined,
      },
      signal,
    )
    expect(receipts).toEqual([runId, steerId])

    const steerVerified = await client.verifySteerConsumption!(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        nativeSessionId: 'sid-cold-1',
        nativeTurnId: runId,
        inputId: steerId,
        minStepIdx: 1,
      },
      signal,
    )
    expect(steerVerified).toEqual({
      consumed: true,
      stepIdx: 2,
      executionId: 'exec-cold-1',
    })

    // Item 5: Cold SQLite trajectory without terminal record ('running') MUST return no_evidence (never live_runtime)!
    coldStatus = 'running'
    const coldRunningProbe = await client.probeSessionStatus!(
      {
        sessionId,
        agentId: 'agy',
        requestId,
        runId,
        nativeSessionId: 'sid-cold-1',
        nativeTurnId: runId,
        bindingGeneration: 1,
        cwd: '/tmp/proj',
        model: null,
        effort: null,
      },
      signal,
    )
    expect(coldRunningProbe).toMatchObject({
      kind: 'no_evidence',
      output: {
        outputId: 'exec-cold-1',
        text: answerText,
        completeness: 'partial',
      },
    })
    expect(coldRunningProbe).not.toHaveProperty('source', 'live_runtime')

    const rebuildSourceHash = 'a'.repeat(64)
    const seedRes = await client.writeRebuildSeed(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        candidateSessionId: 'sid-rebuild-1',
        sourceHash: rebuildSourceHash,
        chunks: (async function* () {
          yield {
            chunk: {
              kind: 'message' as const,
              messageId: randomUUID(),
              sequence: 1,
              speaker: 'user' as const,
              state: 'complete' as const,
              part: 0,
              final: true,
              content: 'Seed text',
            },
          }
        })(),
      },
      signal,
    )
    expect(seedRes).not.toHaveProperty('initializationWitness')
    expect(seedRes).toMatchObject({
      seedHash: 'c'.repeat(64),
      pbSha256: 'd'.repeat(64),
      pbBytes: 512,
      stepCount: 2,
    })

    // Before cold load, inspectRebuildSeed MUST NOT synthesize a fallback agy_rebuild_v1 witness!
    const preColdInspect = await client.inspectRebuildSeed(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        nativeSessionId: 'sid-rebuild-1',
        sourceHash: rebuildSourceHash,
        chunks: (async function* () {})(),
      },
      signal,
    )
    expect(preColdInspect).toEqual({ verified: false, seedHash: '', stepCount: 0 })

    // After confirmRebuildColdLoad, inspectRebuildSeed verifies cleanly with coldLoadVerifiedAt!
    const coldWitness = await client.confirmRebuildColdLoad(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        nativeSessionId: 'sid-rebuild-1',
        sourceHash: rebuildSourceHash,
        pbSha256: 'd'.repeat(64),
        pbBytes: 512,
        stepCount: 2,
      },
      signal,
    )
    expect(coldWitness).toEqual({
      kind: 'agy_rebuild_v1',
      nativeSessionId: 'sid-rebuild-1',
      pbSha256: 'd'.repeat(64),
      pbBytes: 512,
      stepCount: 2,
      sourceHash: rebuildSourceHash,
      coldLoadVerifiedAt: '2026-11-19T12:00:00.000Z',
    })
    const postColdInspect = await client.inspectRebuildSeed(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        nativeSessionId: 'sid-rebuild-1',
        sourceHash: rebuildSourceHash,
        chunks: (async function* () {})(),
      },
      signal,
    )
    expect(postColdInspect).toEqual({
      verified: true,
      seedHash: 'c'.repeat(64),
      stepCount: 2,
      initializationWitness: coldWitness,
    })

    const boundary = await client.prepareFork!(
      {
        appDataDir: '/tmp/mock-app-data',
        cwd: '/tmp/proj',
        nativeSessionId: 'sid-src',
        nativeTurnId: runId,
        runId,
        bindingGeneration: 1,
        throughSequence: 2,
        deliveryCursor: 1,
        responseHash: answerHash,
      },
      signal,
    )
    expect(boundary.provider).toBe('agy')
    expect(boundary.nativeCutId).toBe('exec-cold-1')
  })

  it('executes real createAgyNativeStorageClient(new NativeForkFiles()) sourceHash Rebuild round-trip, unpopulated Fork shell classification, onCandidate witness commit, and appDataDir override', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'pact-real-agy-storage-bridge-'))
    const forkFiles = new NativeForkFiles()
    try {
      const storageRoot = join(tempDir, 'agy-app-data')
      const cwd = await realpath(tempDir)
      await mkdir(join(storageRoot, 'conversations'), { recursive: true })
      await mkdir(join(storageRoot, 'brain'), { recursive: true })

      const createZeroTurnShell = (sessionId: string): { dbPath: string; trajectoryId: string } => {
        const trajectoryId = randomUUID()
        const rawSummary = encodeProtobufFields([
          encodeStringField(4, trajectoryId),
          encodeBytesField(15, Buffer.alloc(0)),
          encodeBytesField(
            17,
            encodeProtobufFields([
              encodeStringField(6, sessionId),
              encodeBytesField(90, Buffer.alloc(560, 0x2a)),
            ]),
          ),
          encodeVarintField(22, 1),
        ])
        const sumDb = new Database(join(storageRoot, 'conversation_summaries.db'))
        try {
          sumDb.pragma('journal_mode = WAL')
          sumDb.exec(`
            CREATE TABLE IF NOT EXISTS "conversation_summaries" (
              "conversation_id" TEXT PRIMARY KEY,
              "title" TEXT,
              "step_count" INTEGER NOT NULL DEFAULT 0,
              "last_user_input_step_index" INTEGER NOT NULL DEFAULT 0,
              "raw_summary" BLOB,
              "parent_conversation_id" TEXT
            );
          `)
          sumDb
            .prepare(
              'INSERT INTO "conversation_summaries" ("conversation_id", "title", "step_count", "last_user_input_step_index", "raw_summary") VALUES (?, ?, 0, 0, ?)',
            )
            .run(sessionId, '', rawSummary)
        } finally {
          sumDb.close()
        }

        const dbPath = join(storageRoot, 'conversations', `${sessionId}.db`)
        const db = new Database(dbPath)
        try {
          db.pragma('page_size = 32768')
          db.pragma('journal_mode = WAL')
          db.exec(`
            CREATE TABLE "trajectory_meta" (
              "trajectory_id" TEXT PRIMARY KEY,
              "cascade_id" TEXT NOT NULL,
              "step_format" INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE "steps" (
              "idx" INTEGER PRIMARY KEY,
              "step_type" INTEGER NOT NULL,
              "status" INTEGER NOT NULL,
              "has_subtrajectory" INTEGER NOT NULL DEFAULT 0,
              "metadata" BLOB,
              "error_details" BLOB,
              "permissions" BLOB,
              "task_details" BLOB,
              "render_info" BLOB,
              "step_payload" BLOB,
              "step_format" INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE "gen_metadata" (
              "idx" INTEGER PRIMARY KEY,
              "data" BLOB NOT NULL,
              "size" INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE "executor_metadata" (
              "idx" INTEGER PRIMARY KEY,
              "data" BLOB NOT NULL,
              "size" INTEGER NOT NULL DEFAULT 0
            );
          `)
          db.prepare(
            'INSERT INTO "trajectory_meta" ("trajectory_id", "cascade_id", "step_format") VALUES (?, ?, 0)',
          ).run(trajectoryId, sessionId)
        } finally {
          db.close()
        }
        return { dbPath, trajectoryId }
      }

      // Pass an invalid defaultAppDataDir to prove explicit per-call `appDataDir` wins across all methods!
      const client = createAgyNativeStorageClient(forkFiles, join(tempDir, 'nonexistent-default'))
      const signal = new AbortController().signal

      // 1. Real writeRebuildSeed -> pre-cold inspectRebuildSeed (unconfirmed) -> confirmRebuildColdLoad -> inspectRebuildSeed with 64-hex `sourceHash`!
      const rebuildSid = randomUUID()
      createZeroTurnShell(rebuildSid)
      const sourceHash = createHash('sha256').update('frozen-rebuild-history-v1').digest('hex')
      const msg1Id = randomUUID()
      const msg2Id = randomUUID()
      const rebuildChunks = [
        {
          kind: 'message' as const,
          messageId: msg1Id,
          sequence: 1,
          speaker: 'user' as const,
          state: 'complete' as const,
          part: 0,
          final: true,
          content: 'Inspect ACP framing invariants.',
        },
        {
          kind: 'message' as const,
          messageId: msg2Id,
          sequence: 2,
          speaker: 'agy' as const,
          state: 'complete' as const,
          part: 0,
          final: true,
          content: 'Verified ACP framing invariants.',
        },
      ]

      const writtenSeed = await client.writeRebuildSeed(
        {
          appDataDir: storageRoot,
          cwd,
          candidateSessionId: rebuildSid,
          sourceHash,
          chunks: (async function* () {
            for (const chunk of rebuildChunks) yield { chunk }
          })(),
        },
        signal,
      )
      expect(writtenSeed).not.toHaveProperty('initializationWitness')
      expect(writtenSeed.stepCount).toBe(2)

      // Seed written WITHOUT cold-load confirmation MUST return verified: false!
      const unconfirmedSeed = await client.inspectRebuildSeed(
        {
          appDataDir: storageRoot,
          cwd,
          nativeSessionId: rebuildSid,
          sourceHash,
          chunks: (async function* () {
            yield* rebuildChunks
          })(),
        },
        signal,
      )
      expect(unconfirmedSeed).toEqual({
        verified: false,
        seedHash: '',
        stepCount: 0,
      })

      const confirmedWitness = await client.confirmRebuildColdLoad(
        {
          appDataDir: storageRoot,
          cwd,
          nativeSessionId: rebuildSid,
          sourceHash,
          pbSha256: writtenSeed.pbSha256,
          pbBytes: writtenSeed.pbBytes,
          stepCount: 2,
        },
        signal,
      )
      expect(confirmedWitness).toMatchObject({
        kind: 'agy_rebuild_v1',
        nativeSessionId: rebuildSid,
        sourceHash,
        stepCount: 2,
        coldLoadVerifiedAt: expect.any(String),
      })

      const verifiedSeed = await client.inspectRebuildSeed(
        {
          appDataDir: storageRoot,
          cwd,
          nativeSessionId: rebuildSid,
          sourceHash,
          chunks: (async function* () {
            yield* rebuildChunks
          })(),
        },
        signal,
      )
      expect(verifiedSeed.verified).toBe(true)
      expect(verifiedSeed.seedHash).toBe(writtenSeed.seedHash)
      expect(verifiedSeed.initializationWitness).toEqual(confirmedWitness)

      // Mismatched `sourceHash` MUST return `{ verified: false }` cleanly instead of throwing!
      const mismatchedSeed = await client.inspectRebuildSeed(
        {
          appDataDir: storageRoot,
          cwd,
          nativeSessionId: rebuildSid,
          sourceHash: 'f'.repeat(64),
          chunks: (async function* () {
            yield* rebuildChunks
          })(),
        },
        signal,
      )
      expect(mismatchedSeed).toEqual({
        verified: false,
        seedHash: '',
        stepCount: 0,
      })

      // 2. Real source trajectory -> probeSessionStatus / probeInputReceipts (with `appDataDir`) -> prepareFork -> inspectFork / writeFork!
      const sourceSid = randomUUID()
      const candidateSid = randomUUID()
      const { dbPath: sourceDbPath, trajectoryId: sourceTrajId } = createZeroTurnShell(sourceSid)
      const { trajectoryId: candidateTrajId } = createZeroTurnShell(candidateSid)

      const pactRunId = randomUUID()
      const pactMsgId = randomUUID()
      const canonicalAnswer = 'Real Worker Fork canonical answer.'
      const db = new Database(sourceDbPath)
      try {
        const u0Meta = encodeCortexStepMetadata({
          createdAtSeconds: 1_710_000_500n,
          source: 1,
          executionId: 'exec-real-1',
          trajectoryId: sourceTrajId,
          stepIndex: 0,
          cascadeId: sourceSid,
          stepId: 'step-r0',
        })
        const u0Data = encodeAgyUserInputStep({
          metadata: u0Meta,
          text: `Prompt mentioning ${sourceSid} and ${sourceTrajId}\n${JSON.stringify({
            version: 'pact-agent-prompt-v1',
            messageId: pactMsgId,
            pactRunId,
          })}`,
        })
        const p1Meta = encodeCortexStepMetadata({
          createdAtSeconds: 1_710_000_501n,
          source: 2,
          executionId: 'exec-real-1',
          trajectoryId: sourceTrajId,
          stepIndex: 1,
          cascadeId: sourceSid,
          stepId: 'step-r1',
        })
        const p1Data = encodeAgyPlannerResponseStep({
          metadata: p1Meta,
          response: canonicalAnswer,
        })
        const insertStep = db.prepare(
          'INSERT INTO "steps" ("idx", "step_type", "status", "has_subtrajectory", "metadata", "step_payload", "step_format") VALUES (?, ?, ?, 0, ?, ?, 0)',
        )
        insertStep.run(0, CORTEX_STEP_TYPE_USER_INPUT, CORTEX_STEP_STATUS_DONE, u0Meta, u0Data)
        insertStep.run(
          1,
          CORTEX_STEP_TYPE_PLANNER_RESPONSE,
          CORTEX_STEP_STATUS_DONE,
          p1Meta,
          p1Data,
        )

        const genData = encodeProtobufFields([
          encodeBytesField(
            1,
            encodeProtobufFields([
              encodeBytesField(
                20,
                encodeProtobufFields([
                  encodeStringField(1, 'trajectory_id'),
                  encodeStringField(2, sourceTrajId),
                ]),
              ),
              encodeBytesField(
                20,
                encodeProtobufFields([
                  encodeStringField(1, 'cascade_id'),
                  encodeStringField(2, sourceSid),
                ]),
              ),
            ]),
          ),
          encodeVarintField(2, 1),
          encodeStringField(4, 'exec-real-1'),
        ])
        db.prepare('INSERT INTO "gen_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
          genData,
          genData.byteLength,
        )
        const execData = encodeExecutorMetadata({
          terminationReason: EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
          numGeneratorInvocations: 1,
          lastStepIdx: 1,
          executionId: 'exec-real-1',
        })
        db.prepare('INSERT INTO "executor_metadata" ("idx", "data", "size") VALUES (0, ?, ?)').run(
          execData,
          execData.byteLength,
        )
      } finally {
        db.close()
      }

      const probedStatus = await client.probeSessionStatus!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          agentId: 'agy',
          requestId: randomUUID(),
          runId: pactRunId,
          nativeSessionId: sourceSid,
          nativeTurnId: pactRunId,
          bindingGeneration: 1,
          cwd,
          model: null,
          effort: null,
        },
        signal,
      )
      expect(probedStatus).toMatchObject({
        kind: 'ended',
        outcome: 'completed',
        output: { text: canonicalAnswer },
      })

      const probedReceipts = await client.probeInputReceipts!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          agentId: 'agy',
          requestId: randomUUID(),
          runId: pactRunId,
          nativeSessionId: sourceSid,
          nativeTurnId: pactRunId,
          bindingGeneration: 1,
          cwd,
          model: null,
          effort: null,
          unresolvedInputIds: [pactRunId, pactMsgId, 'other-id'],
          recordConsumption: () => undefined,
        },
        signal,
      )
      expect(probedReceipts).toEqual([pactRunId, pactMsgId])

      const responseHash = createHash('sha256').update(canonicalAnswer).digest('hex')
      const boundary = await client.prepareFork!(
        {
          appDataDir: storageRoot,
          cwd,
          nativeSessionId: sourceSid,
          nativeTurnId: pactRunId,
          runId: pactRunId,
          nativeInputIds: [pactRunId],
          bindingGeneration: 1,
          throughSequence: 2,
          deliveryCursor: 2,
          responseHash,
        },
        signal,
      )

      const placeholderWitness: AgentNativeForkWitness = {
        version: 'pact-native-fork-v1',
        provider: 'agy',
        nativeSessionId: candidateSid,
        sourceNativeSessionId: sourceSid,
        sourceCutId: boundary.nativeCutId,
        sourceTrajectoryId: sourceTrajId,
        candidateTrajectoryId: candidateTrajId,
        ...(boundary.agyCut
          ? {
              cutStepIdx: boundary.agyCut.cutStepIdx,
              agyCut: boundary.agyCut,
            }
          : {}),
        sourcePrefixHash: boundary.prefixHash,
        candidatePrefixHash: boundary.prefixHash,
        idMap: [[pactRunId, randomUUID()]],
        model: null,
        effort: null,
        permissionMode: 'ask',
      }

      // Item 4: Persisted candidate `nativeSessionId` WITHOUT `witness` stays `unconfirmed` when the DB exists,
      // and ONLY returns `missing` when `<candidateSid>.db` is genuinely absent while the source cut remains intact!
      const witnesslessExistingInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'fork',
          nativeSessionId: candidateSid,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(witnesslessExistingInspect.kind).toBe('unconfirmed')

      const absentCandidateSid = randomUUID()
      const witnesslessAbsentInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'fork',
          nativeSessionId: absentCandidateSid,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(witnesslessAbsentInspect.kind).toBe('missing')

      // Unpopulated zero-Turn candidate shell on `lastDispatchedPhase: 'fork'` WITH witness MUST return `kind: 'missing'`!
      const unpopulatedForkInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'fork',
          nativeSessionId: candidateSid,
          witness: placeholderWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(unpopulatedForkInspect.kind).toBe('missing')

      // Unpopulated shell on `lastDispatchedPhase: 'initialize'` MUST return `kind: 'unconfirmed'`!
      const unpopulatedInitInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'initialize',
          nativeSessionId: candidateSid,
          witness: placeholderWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(unpopulatedInitInspect.kind).toBe('unconfirmed')

      // Real writeFork commits `onCandidate` before returning, and inspectFork does NOT report `ready: true` without `file.initializedVerified`!
      const committedCandidates: Array<{ sid: string; witness: AgentNativeForkWitness }> = []
      const forkWitness = await client.writeFork!(
        {
          appDataDir: storageRoot,
          cwd,
          candidateSessionId: candidateSid,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          onCandidate: async (sid, witness) => {
            committedCandidates.push({ sid, witness })
          },
        },
        signal,
      )
      expect(committedCandidates).toHaveLength(1)
      expect(committedCandidates[0]?.sid).toBe(candidateSid)

      const unsealedInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'fork',
          nativeSessionId: candidateSid,
          witness: forkWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(unsealedInspect).toMatchObject({
        kind: 'verified',
        ready: false,
        workSettled: true,
      })

      // Forged `initializedAt` with wrong `initializedPrefixHash` MUST NOT bypass `file.initializedVerified`!
      const forgedWitness: AgentNativeForkWitness = {
        ...forkWitness,
        initializedAt: '2026-11-19T12:00:00.000Z',
        initializedPrefixHash: '0'.repeat(64),
        initializedPrefixBytes: 1,
        initializedPrefixRecords: 1,
      }
      const forgedInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'initialize',
          nativeSessionId: candidateSid,
          witness: forgedWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(forgedInspect).toMatchObject({
        kind: 'verified',
        ready: false,
        workSettled: false,
      })

      // Exact physical digest match seals `ready: true`, while permissionMode drift keeps `ready: false`!
      const sealedWitness: AgentNativeForkWitness = {
        ...forkWitness,
        initializedAt: '2026-11-19T12:00:00.000Z',
        initializedPrefixHash: unsealedInspect.rawHash!,
        initializedPrefixBytes: unsealedInspect.rawBytes!,
        initializedPrefixRecords: unsealedInspect.rawRecords!,
      }
      const sealedInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          source: boundary,
          lastDispatchedPhase: 'initialize',
          nativeSessionId: candidateSid,
          witness: sealedWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(sealedInspect).toMatchObject({
        kind: 'verified',
        ready: true,
        workSettled: true,
      })

      const modeDriftInspect = await client.inspectFork!(
        {
          appDataDir: storageRoot,
          sessionId: randomUUID(),
          operationId: randomUUID(),
          cwd,
          model: null,
          effort: null,
          permissionMode: 'full',
          source: boundary,
          lastDispatchedPhase: 'initialize',
          nativeSessionId: candidateSid,
          witness: sealedWitness,
          onDispatched: async () => undefined,
          onCandidate: async () => undefined,
          reportNativeWork: () => undefined,
        },
        signal,
      )
      expect(modeDriftInspect).toMatchObject({
        kind: 'verified',
        ready: false,
        workSettled: true,
      })
    } finally {
      await forkFiles.dispose()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('returns CONFLICT when settingsRevision changes mid-preparation, preserving user draft without creating a Run or retaining Full access', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })
    f.db.sessionRepository.savePermission({
      sessionId: f.sessionId,
      agentId: 'agy',
      mode: 'full',
      expectedRevision: 1,
      confirmedFullAccess: true,
    })

    // Mutate session settings (downgrading agy Full access -> Ask) mid-preparation during handoffRange!
    let mutatedMidSend = false
    const origHandoffRange = f.db.conversationRepository.handoffRange.bind(
      f.db.conversationRepository,
    )
    vi.spyOn(f.db.conversationRepository, 'handoffRange').mockImplementation((...args) => {
      if (!mutatedMidSend) {
        mutatedMidSend = true
        const cur = f.db.sessionRepository.find(f.sessionId)!
        f.db.sessionRepository.savePermission({
          sessionId: f.sessionId,
          agentId: 'agy',
          mode: 'ask',
          expectedRevision: cur.settingsRevision,
          confirmedFullAccess: false,
        })
      }
      return origHandoffRange(...args)
    })

    const conflictResult = await f.sendMessage(f.sessionId, 'Draft message during settings change')
    expect(conflictResult).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('draft was preserved'),
      },
    })
    expect(harness.runs).toHaveLength(0)
    expect(harness.retiredFullAccess).toContainEqual(
      expect.objectContaining({ sessionId: f.sessionId }),
    )
    const persisted = f.db.conversationRepository.read(f.sessionId)
    expect(persisted.messages).toHaveLength(0)
    expect(persisted.runs).toHaveLength(0)
  })

  it('keeps existing ready native binding ready on pre-Turn quota/auth rejection for immediate 3rd-agent replacement, and filters retired member warnings identically in Conversation sessionIssues', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'claude',
    })

    // 1. Establish a healthy ready native binding for agy
    const firstSend = await f.sendMessage(f.sessionId, 'Initial healthy turn')
    expect(firstSend.ok).toBe(true)
    await f.waitForIdle()
    const established = f.db.conversationRepository.nativeContext(f.sessionId, 'agy')
    expect(established?.continuationState).toBe('ready')

    // 2. Next turn rejects BEFORE submitting a Turn due to quota_or_rate_limit
    const agyExecUuid = '00000000-0000-4000-8000-0000000000a1'
    const { AgentExecutionError } = await import('./agent-execution-error.js')
    harness.nextRunBehavior = (_agentId, input) => {
      input.recordDispatch?.('rejected', input.nativeSessionId, agyExecUuid)
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: String(input.nativeGeneration ?? 1),
        state: 'settled',
      })
      throw new AgentExecutionError(
        'quota_or_rate_limit',
        'Antigravity quota pool is exhausted until reset.',
        false,
      )
    }

    const quotaSend = await f.sendMessage(f.sessionId, 'Quota blocked turn')
    expect(quotaSend.ok).toBe(true)
    await f.waitForIdle()

    // Binding stays 'ready' while the Run records 'quota_or_rate_limit'!
    const afterQuotaContext = f.db.conversationRepository.nativeContext(f.sessionId, 'agy')
    const latestAgyRun = f.db.conversationRepository.latestAgentRun(f.sessionId, 'agy')
    expect({
      afterQuotaContext,
      runStatus: latestAgyRun?.status,
      runFailureKind: latestAgyRun?.failureKind,
      runDispatchPhase: latestAgyRun?.dispatchPhase,
      runEffects: latestAgyRun?.nativeEffectsState,
    }).toMatchObject({
      afterQuotaContext: {
        continuationState: 'ready',
        nativeSessionId: established?.nativeSessionId,
      },
      runStatus: 'failed',
      runFailureKind: 'quota_or_rate_limit',
    })

    // Repeat for authentication_required before Turn submission
    harness.nextRunBehavior = (_agentId, input) => {
      input.recordDispatch?.('rejected', input.nativeSessionId, agyExecUuid)
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: String(input.nativeGeneration ?? 1),
        state: 'settled',
      })
      throw new AgentExecutionError(
        'authentication_required',
        'Antigravity sign-in session expired.',
        false,
      )
    }
    let latestPatchIssues: import('@pact/contracts').SessionIssues | undefined
    const unsub = f.flow.subscribe((patch, progress) => {
      if (!progress && patch.sessionId === f.sessionId && patch.sessionIssues) {
        latestPatchIssues = patch.sessionIssues
      }
    })
    try {
      const authSend = await f.sendMessage(f.sessionId, 'Auth blocked turn')
      expect(authSend.ok).toBe(true)
      await f.waitForIdle()
      expect(f.db.conversationRepository.nativeContext(f.sessionId, 'agy')?.continuationState).toBe(
        'ready',
      )

      // While agy is still in the active pair (agy, claude), its settled warning is visible in Conversation
      expect(latestPatchIssues?.agents.map((i) => i.agentId) ?? []).toContain('agy')

      // 3. Immediate 3rd-agent replacement (swap agy -> codex) succeeds cleanly AND filters retired agy's warning!
      const current = f.db.sessionRepository.find(f.sessionId)!
      const swapped = f.db.sessionRepository.saveSettings(f.sessionId, {
        ...current.settings,
        primaryAgentId: 'codex',
        secondaryAgentId: 'claude',
      })
      expect(swapped.session.settings.primaryAgentId).toBe('codex')
      // Catalog issues AND Conversation snapshot issues both filter out retired agy's settled warning!
      const catalogIssues = f.db.conversationRepository.nativeIssueMetadata(f.sessionId)
      expect(catalogIssues.agents.map((i) => i.agentId)).not.toContain('agy')

      // Trigger a Conversation patch and verify Conversation.sessionIssues matches Catalog!
      const codexSend = await f.sendMessage(f.sessionId, 'Continue with Codex')
      expect(codexSend.ok).toBe(true)
      await f.waitForIdle()
      expect(latestPatchIssues?.agents.map((i) => i.agentId) ?? []).not.toContain('agy')
    } finally {
      unsub()
    }
  })

  it('gates Conversation.rebuildNativeContext completion on a cold-load-verified agy_rebuild_v1 witness', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    const initialSend = await f.sendMessage(f.sessionId, 'Establish initial agy binding')
    expect(initialSend.ok).toBe(true)
    await f.waitForIdle()

    const originalContext = f.db.conversationRepository.nativeContext(f.sessionId, 'agy')!
    expect(originalContext.continuationState).toBe('ready')
    f.db.conversationRepository.markNativeContextsMissing(
      f.sessionId,
      ['agy'],
      'Simulated missing native DB for rebuild test.',
    )

    // 1. Seed written WITHOUT coldLoadVerifiedAt -> executeNativeRebuild stays unconfirmed & preserves original binding!
    const agyExecUuid = '00000000-0000-4000-8000-0000000000a1'
    harness.rebuildHandler = async (input) => {
      await input.onNativeCreationDispatched?.(agyExecUuid)
      await input.onNativeSessionCreated?.('sid-rebuilt-candidate')
      input.reportNativeWork?.({
        executorId: agyExecUuid,
        nativeSessionId: 'sid-rebuilt-candidate',
        state: 'settled',
      })
      // Missing coldLoadVerifiedAt (unconfirmed seed)!
      return {
        nativeSessionId: 'sid-rebuilt-candidate',
      }
    }

    const startedRebuild = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'agy',
      intent: 'create',
      clientOperationId: randomUUID(),
      expectedNativeSessionId: originalContext.nativeSessionId,
      expectedGeneration: originalContext.bindingGeneration,
    })
    expect(startedRebuild.ok).toBe(true)

    await vi.waitFor(() => {
      const op = f.db.conversationRepository.lastNativeRebuild(f.sessionId, 'agy')
      expect(op?.stage).toBe('unconfirmed')
    })
    expect(f.db.conversationRepository.nativeContext(f.sessionId, 'agy')?.nativeSessionId).toBe(
      originalContext.nativeSessionId,
    )

    // 2. Check WITHOUT cold-load witness keeps rebuild unconfirmed (NATIVE_CONTEXT_RECOVERY_REQUIRED)!
    const opBeforeCheck = f.db.conversationRepository.lastNativeRebuild(f.sessionId, 'agy')!
    harness.rebuildCheckHandler = async () => ({
      nativeSessionId: 'sid-rebuilt-candidate',
    })
    const unconfirmedCheck = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'agy',
      intent: 'inspect',
      expectedRebuildId: opBeforeCheck.id,
      expectedNativeSessionId: originalContext.nativeSessionId,
      expectedGeneration: originalContext.bindingGeneration,
    })
    expect(unconfirmedCheck).toMatchObject({
      ok: false,
      error: { code: 'NATIVE_CONTEXT_RECOVERY_REQUIRED' },
    })
    expect(f.db.conversationRepository.nativeContext(f.sessionId, 'agy')?.nativeSessionId).toBe(
      originalContext.nativeSessionId,
    )

    // 3. Check WITH cold-load-verified agy_rebuild_v1 witness completes cleanly and updates binding!
    harness.rebuildCheckHandler = async (input) => ({
      nativeSessionId: 'sid-rebuilt-candidate',
      initializationWitness: {
        kind: 'agy_rebuild_v1',
        nativeSessionId: 'sid-rebuilt-candidate',
        pbSha256: 'e'.repeat(64),
        pbBytes: 1024,
        stepCount: 2,
        sourceHash: input.sourceHash ?? opBeforeCheck.sourceHash ?? 'f'.repeat(64),
        coldLoadVerifiedAt: '2026-11-19T12:30:00.000Z',
      },
    })
    const confirmedCheck = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'agy',
      intent: 'inspect',
      expectedRebuildId: opBeforeCheck.id,
      expectedNativeSessionId: originalContext.nativeSessionId,
      expectedGeneration: originalContext.bindingGeneration,
    })
    expect(confirmedCheck.ok).toBe(true)
    const updatedContext = f.db.conversationRepository.nativeContext(f.sessionId, 'agy')
    expect(updatedContext?.nativeSessionId).toBe('sid-rebuilt-candidate')
    expect(updatedContext?.continuationState).toBe('ready')
    expect(updatedContext?.bindingGeneration).toBe((originalContext.bindingGeneration ?? 1) + 1)
  })

  it('shares one AgyAcpConnectionPool across Main Session + Side Chat, honors custom ANTIGRAVITY_GEMINI_DIR, and disposes pools on shutdown', async () => {
    const prevGeminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']
    const customGeminiRoot = await mkdtemp(join(tmpdir(), 'pact-custom-gemini-dir-'))
    process.env['ANTIGRAVITY_GEMINI_DIR'] = customGeminiRoot
    try {
      expect(resolveEffectiveAgyAppDataDir(process.env)).toBe(
        join(customGeminiRoot, 'antigravity-cli'),
      )

      const f = await createOrchestrationFixture({
        primaryAgentId: 'agy',
        secondaryAgentId: 'codex',
        permissionModes: { agy: 'full' },
      })

      // 1. Run Main Session -> captures AgyAgentAdapter options
      const mainSend = await f.sendMessage(f.sessionId, 'Main session turn')
      expect(mainSend.ok).toBe(true)
      await f.waitForIdle()

      // 2. Create a Side Chat in the same project and run a Side Chat turn -> must share the exact same connectionPool & appDataDir!
      const sideCreated = await f.flow.createSideChat({
        parentSessionId: f.sessionId,
        operationId: randomUUID(),
        origin: 'btw',
      })
      expect(sideCreated.ok).toBe(true)
      if (!sideCreated.ok) throw new Error(sideCreated.error.message)
      const sideSessionId = sideCreated.value.sideChat.id

      const sideSend = await f.sendMessage(sideSessionId, 'Side chat turn')
      expect(sideSend.ok).toBe(true)
      await f.waitForIdle()

      expect(harness.agyOptions).toHaveLength(2)
      const mainOpts = harness.agyOptions[0]
      const sideOpts = harness.agyOptions[1]
      expect(typeof mainOpts === 'object' && mainOpts !== null).toBe(true)
      expect(typeof sideOpts === 'object' && sideOpts !== null).toBe(true)
      if (
        typeof mainOpts !== 'object' ||
        mainOpts === null ||
        typeof sideOpts !== 'object' ||
        sideOpts === null
      ) {
        throw new Error('Expected AgyAgentAdapter options objects')
      }
      expect(Reflect.get(mainOpts, 'appDataDir')).toBe(join(customGeminiRoot, 'antigravity-cli'))
      expect(Reflect.get(sideOpts, 'appDataDir')).toBe(join(customGeminiRoot, 'antigravity-cli'))
      const sharedPool = Reflect.get(mainOpts, 'connectionPool')
      expect(sharedPool).toBeInstanceOf(AgyAcpConnectionPool)
      expect(Reflect.get(sideOpts, 'connectionPool')).toBe(sharedPool)
      if (!(sharedPool instanceof AgyAcpConnectionPool)) {
        throw new Error('Expected sharedPool to be an AgyAcpConnectionPool instance')
      }

      // 3. Downgrading Full access on Main Session retires ONLY Main Session's Full-access lease
      // (preserving child Side Chat whose own locked settings.permissionModes.agy === 'full'!).
      const poolRetireSpy = vi.spyOn(sharedPool, 'retireFullAccess')
      const poolDisposeSpy = vi.spyOn(sharedPool, 'dispose')

      const mainCurrent = f.db.sessionRepository.find(f.sessionId)!
      f.db.sessionRepository.savePermission({
        sessionId: f.sessionId,
        agentId: 'agy',
        mode: 'ask',
        expectedRevision: mainCurrent.settingsRevision,
        confirmedFullAccess: false,
      })
      await f.flow.reconcileSessionSettingsChanged(f.sessionId)
      expect(harness.retiredFullAccess.map((r) => r.sessionId)).toEqual([f.sessionId])
      expect(poolRetireSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: f.sessionId }),
      )
      expect(poolRetireSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: sideSessionId }),
      )

      // Archiving the parent Session archives its Side Chats and retires the Side Chat's Full-access lease cleanly!
      const archivedMain = await f.flow.archiveWorkspace(
        { kind: 'session', sessionId: f.sessionId },
        undefined,
        (opId) => {
          f.db.sessionRepository.archive(f.sessionId, opId)
          return { ok: true as const, value: true }
        },
        () => ({ ok: true as const, value: true }),
      )
      expect(archivedMain.ok).toBe(true)
      expect(poolRetireSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: sideSessionId }),
      )

      // 4. Disposing Conversation disposes the shared AgyAcpConnectionPool!
      await f.flow.dispose()
      expect(poolDisposeSpy).toHaveBeenCalledTimes(1)
    } finally {
      if (prevGeminiDir === undefined) delete process.env['ANTIGRAVITY_GEMINI_DIR']
      else process.env['ANTIGRAVITY_GEMINI_DIR'] = prevGeminiDir
      await rm(customGeminiRoot, { recursive: true, force: true })
    }
  })

  it('enforces MCP root/subagent/completion-token correlation on the descriptor published during a real AgyAgentAdapter run', async () => {
    const { EventEmitter } = await import('node:events')
    const { PassThrough } = await import('node:stream')
    const { createInterface } = await import('node:readline')
    const { AgyAgentAdapter: RealAgyAgentAdapter } =
      await vi.importActual<typeof import('./agy-agent-adapter.js')>('./agy-agent-adapter.js')

    const tempProject = await mkdtemp(join(tmpdir(), 'pact-real-agy-mcp-corr-'))
    const realCwd = await realpath(tempProject)
    const activeSessionId = '55555555-5555-4555-8555-555555555555'
    const runId = randomUUID()
    const grantId = randomUUID()
    let sourceReaderCalls = 0
    const mcpResponses: Record<string, unknown> = {}

    let publishedMcpUrl = ''
    let publishedMcpAuthHeader = ''
    const adapter = new RealAgyAgentAdapter({
      executablePath: '/mock/bin/agy',
      appDataDir: join(tempProject, 'app-data'),
      peerTargetAgentId: 'codex',
      processFactory: async () => {
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        const emitter = new EventEmitter()
        const procDouble = Object.assign(emitter, {
          stdin,
          stdout,
          stderr,
          pid: 42424,
          exitCode: null as number | null,
          signalCode: null as NodeJS.Signals | null,
          killed: false,
          kill() {
            procDouble.killed = true
            procDouble.exitCode = 0
            stdout.end()
            emitter.emit('exit', 0, null)
            emitter.emit('close', 0, null)
            return true
          },
        })
        const proc =
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal ChildProcess double for ACP stdio stream test.
          procDouble as unknown as import('node:child_process').ChildProcessWithoutNullStreams

        let mcpServerName = ''
        let mcpUrl = ''
        let mcpAuthHeader = ''
        const rl = createInterface({ input: stdin })
        rl.on('line', (line) => {
          if (!line.trim()) return
          const msg: unknown = JSON.parse(line)
          if (typeof msg !== 'object' || msg === null) return
          const id: unknown = Reflect.get(msg, 'id')
          const method: unknown = Reflect.get(msg, 'method')
          const rawParams: unknown = Reflect.get(msg, 'params')
          const params = typeof rawParams === 'object' && rawParams !== null ? rawParams : {}
          const send = (obj: object) => stdout.write(`${JSON.stringify(obj)}\n`)

          if (method === 'initialize') {
            send({
              jsonrpc: '2.0',
              id,
              result: { protocolVersion: 1, agentInfo: { name: 'agy', version: '1.5.11' } },
            })
          } else if (method === 'session/new') {
            const rawServers: unknown = Reflect.get(params, 'mcpServers')
            const mcp: unknown = Array.isArray(rawServers) ? rawServers[0] : undefined
            if (typeof mcp === 'object' && mcp !== null) {
              mcpServerName = String(Reflect.get(mcp, 'name') ?? '')
              mcpUrl = String(Reflect.get(mcp, 'url') ?? '')
              const rawHeaders: unknown = Reflect.get(mcp, 'headers')
              if (Array.isArray(rawHeaders)) {
                for (const h of rawHeaders) {
                  if (typeof h === 'object' && h !== null) {
                    const hName = String(Reflect.get(h, 'name') ?? '')
                    if (hName.toLowerCase() === 'authorization') {
                      mcpAuthHeader = String(Reflect.get(h, 'value') ?? '')
                    }
                  }
                }
              }
            }
            publishedMcpUrl = mcpUrl
            publishedMcpAuthHeader = mcpAuthHeader
            send({
              jsonrpc: '2.0',
              id,
              result: {
                sessionId: activeSessionId,
                modes: {
                  currentModeId: 'agent',
                  availableModes: [{ id: 'agent' }, { id: 'plan' }],
                },
                models: { currentModelId: 'gemini-4-carbon-high', availableModels: [] },
                configOptions: [],
              },
            })
          } else if (method === 'session/prompt') {
            void (async () => {
              const callMcp = async (name: string, args: object, meta: object): Promise<unknown> =>
                await fetch(mcpUrl, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    authorization: mcpAuthHeader,
                    connection: 'close',
                  },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: randomUUID(),
                    method: 'tools/call',
                    params: { name, arguments: args, _meta: meta },
                  }),
                }).then((r) => r.json())

              // 0. Pre-ACP-bind HTTP calls MUST be rejected without self-pinning trajectoryId or invoking sourceReader!
              mcpResponses['preBindSource'] = await callMcp(
                'read_collaboration_source',
                { runId, grant: grantId, source: 'inputs', offset: 0 },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'attacker-traj:0',
                },
              )
              mcpResponses['preBindPeer'] = await callMcp(
                'request_peer_assistance',
                { target: 'codex', kind: 'review', reason: 'Pre-bind spoof' },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'attacker-traj:1',
                },
              )
              mcpResponses['preBindSourceCalls'] = sourceReaderCalls

              // Bind root trajectory strictly via trusted ACP root `tool_call` notification:
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: activeSessionId,
                  update: {
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tc-source-1',
                    name: `mcp__${mcpServerName}__read_collaboration_source`,
                    status: 'in_progress',
                    progressToken: 'traj-live:0',
                  },
                },
              })
              await new Promise((r) => setTimeout(r, 10))

              // 1. Stale root_conversation_id rejected!
              mcpResponses['staleRoot'] = await callMcp(
                'publish_session_title',
                { title: 'Stale Root Spoof' },
                {
                  'antigravity.google/root_conversation_id': 'stale-session-id',
                  'antigravity.google/conversation_id': 'stale-session-id',
                  progressToken: 'traj-live:0',
                },
              )

              // 2. Delegated subagent call (conversation_id !== root_conversation_id) rejected!
              mcpResponses['subagent'] = await callMcp(
                'publish_session_title',
                { title: 'Subagent Spoof' },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': 'subagent-child-sid',
                  progressToken: 'traj-live:1',
                },
              )

              // 3. Foreign trajectory after ACP bind rejected with 0 sourceReader calls, then valid root trajectory succeeds!
              mcpResponses['hijackSource'] = await callMcp(
                'read_collaboration_source',
                { runId, grant: grantId, source: 'inputs', offset: 0 },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'attacker-traj:4',
                },
              )
              mcpResponses['postHijackSourceCalls'] = sourceReaderCalls

              mcpResponses['confirmedSource'] = await callMcp(
                'read_collaboration_source',
                { runId, grant: grantId, source: 'inputs', offset: 0 },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'traj-live:0',
                },
              )

              // 4. Valid MCP call WITHOUT matching completed tool_call_update progressToken -> withheld!
              mcpResponses['unconfirmedPeer'] = await callMcp(
                'request_peer_assistance',
                { target: 'codex', kind: 'review', reason: 'Unconfirmed token' },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'traj-live:99',
                },
              )

              // 5. Valid MCP title call WITH matching completed tool_call_update progressToken -> admitted!
              mcpResponses['confirmedTitle'] = await callMcp(
                'publish_session_title',
                { title: 'Confirmed Production Title' },
                {
                  'antigravity.google/root_conversation_id': activeSessionId,
                  'antigravity.google/conversation_id': activeSessionId,
                  progressToken: 'traj-live:2',
                },
              )
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: activeSessionId,
                  update: {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'tc-title-1',
                    name: `${mcpServerName}/publish_session_title`,
                    status: 'completed',
                    progressToken: 'traj-live:2',
                  },
                },
              })
              send({
                jsonrpc: '2.0',
                method: 'session/update',
                params: {
                  sessionId: activeSessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Completed turn safely.' },
                  },
                },
              })
              send({
                jsonrpc: '2.0',
                id,
                result: { stopReason: 'end_turn' },
              })
            })()
          } else if (method && id !== undefined) {
            send({ jsonrpc: '2.0', id, result: {} })
          }
        })

        return {
          child: proc,
          close: async () => {
            proc.kill()
          },
        }
      },
    })

    try {
      const events: NormalizedAgentEvent[] = []
      const sessionUuid = randomUUID()
      for await (const ev of adapter.run(
        {
          runId,
          sessionId: sessionUuid,
          cwd: realCwd,
          model: null,
          effort: null,
          permissionMode: 'ask',
          peerAssistanceAllowed: true,
          readCollaborationSourcePart: () => {
            sourceReaderCalls += 1
            return {
              source: 'inputs',
              offset: 0,
              nextOffset: null,
              text: 'Frozen collaboration source page',
            }
          },
          promptEnvelope: {
            version: 'pact-agent-prompt-v1',
            sessionId: sessionUuid,
            requestSessionTitle: true,
            sourceGrant: { runId, grant: grantId },
            message: { id: randomUUID(), content: 'Test MCP correlation' },
            comments: [],
          },
        },
        new AbortController().signal,
      )) {
        events.push(ev)
      }

      const readMcpIsError = (key: string): unknown => {
        const resp = mcpResponses[key]
        if (typeof resp !== 'object' || resp === null) return undefined
        const res: unknown = Reflect.get(resp, 'result')
        if (typeof res !== 'object' || res === null) return undefined
        return Reflect.get(res, 'isError')
      }

      expect(readMcpIsError('preBindSource')).toBe(true)
      expect(readMcpIsError('preBindPeer')).toBe(true)
      expect(mcpResponses['preBindSourceCalls']).toBe(0)
      expect(readMcpIsError('staleRoot')).toBe(true)
      expect(readMcpIsError('subagent')).toBe(true)
      expect(readMcpIsError('hijackSource')).toBe(true)
      expect(mcpResponses['postHijackSourceCalls']).toBe(0)
      expect(readMcpIsError('confirmedSource')).toBeUndefined()
      expect(sourceReaderCalls).toBe(1)
      expect(readMcpIsError('unconfirmedPeer')).toBeUndefined()
      expect(readMcpIsError('confirmedTitle')).toBeUndefined()

      // Unconfirmed peer token ('traj-live:99') never completed in session/update -> MUST NOT emit peer.assistance.requested!
      expect(events.filter((e) => e.type === 'peer.assistance.requested')).toEqual([])
      // Confirmed title token ('traj-live:2') completed in session/update -> MUST emit session.title.updated!
      expect(events).toContainEqual({
        agentId: 'agy',
        type: 'session.title.updated',
        title: 'Confirmed Production Title',
      })
      // Post-turn call on the per-Turn MCP server fails because the server was closed on Turn end!
      await expect(
        fetch(publishedMcpUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: publishedMcpAuthHeader,
            connection: 'close',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: randomUUID(),
            method: 'tools/call',
            params: {
              name: 'publish_session_title',
              arguments: { title: 'Post-turn Spoof' },
              _meta: {
                'antigravity.google/root_conversation_id': activeSessionId,
                'antigravity.google/conversation_id': activeSessionId,
                progressToken: 'traj-live:3',
              },
            },
          }),
        }),
      ).rejects.toThrow(/fetch failed|ECONNREFUSED|closed/iu)
    } finally {
      await adapter.dispose()
      await rm(tempProject, { recursive: true, force: true })
    }
  })

  it('enforces live settingsRevision on acceptPeerProposal and uses live admission settingsRevision on queued input admission', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'codex',
      secondaryAgentId: 'agy',
    })
    f.db.sessionRepository.savePermission({
      sessionId: f.sessionId,
      agentId: 'agy',
      mode: 'full',
      expectedRevision: 1,
      confirmedFullAccess: true,
    })

    // 1. Codex turn emits a pending peer proposal targeting agy
    harness.emitPeerProposal = { from: 'codex', target: 'agy', kind: 'review' }
    const firstTurn = await f.sendMessage(f.sessionId, 'Ask Codex then review with Agy')
    expect(firstTurn.ok).toBe(true)
    await f.waitForIdle()
    harness.emitPeerProposal = undefined

    const runsAfterFirst = f.db.conversationRepository.read(f.sessionId).runs
    const proposalId = runsAfterFirst[0]?.peerProposal?.id
    expect(typeof proposalId).toBe('string')
    if (!proposalId) throw new Error('Expected pending peerProposal')

    // Mutate settingsRevision (downgrading agy full -> ask) mid-preparation during acceptPeerProposal!
    let mutatedDuringAccept = false
    const origHandoffRange = f.db.conversationRepository.handoffRange.bind(
      f.db.conversationRepository,
    )
    const handoffSpy = vi
      .spyOn(f.db.conversationRepository, 'handoffRange')
      .mockImplementation((...args) => {
        if (!mutatedDuringAccept) {
          mutatedDuringAccept = true
          const cur = f.db.sessionRepository.find(f.sessionId)!
          f.db.sessionRepository.savePermission({
            sessionId: f.sessionId,
            agentId: 'agy',
            mode: 'ask',
            expectedRevision: cur.settingsRevision,
            confirmedFullAccess: false,
          })
        }
        return origHandoffRange(...args)
      })

    const acceptConflict = await f.flow.acceptPeerProposal({
      sessionId: f.sessionId,
      proposalId,
      clientMessageId: randomUUID(),
    })
    handoffSpy.mockRestore()

    expect(acceptConflict).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: expect.stringContaining('peer request'),
      },
    })
    // Proposal remains pending and no agy Run was created!
    expect(f.db.conversationRepository.read(f.sessionId).runs).toHaveLength(1)
    expect(f.db.conversationRepository.read(f.sessionId).runs[0]?.peerProposal?.state).toBe(
      'pending',
    )
    expect(harness.retiredFullAccess).toContainEqual(
      expect.objectContaining({ sessionId: f.sessionId }),
    )

    // Dismiss the proposal before testing queued input admission
    expect(f.flow.dismissPeerProposal({ sessionId: f.sessionId, proposalId }).ok).toBe(true)

    // 2. Grant Full access again, hold codex running, queue a message to @agy, then downgrade agy Full -> Ask + update agy model BEFORE admission!
    const beforeQueueSession = f.db.sessionRepository.find(f.sessionId)!
    f.db.sessionRepository.savePermission({
      sessionId: f.sessionId,
      agentId: 'agy',
      mode: 'full',
      expectedRevision: beforeQueueSession.settingsRevision,
      confirmedFullAccess: true,
    })

    harness.waitOnAgent = 'codex'
    const heldSend = await f.sendMessage(f.sessionId, 'Hold Codex running')
    expect(heldSend.ok).toBe(true)
    await vi.waitFor(() => expect(harness.releaseWait).toBeTypeOf('function'))

    const queuedReceipt = await f.sendMessage(
      f.sessionId,
      '@agy Run with live admission settings',
      {
        route: { type: 'agent', agentId: 'agy' },
      },
    )
    expect(queuedReceipt.ok).toBe(true)

    // While queued, downgrade agy Full -> Ask AND update agy model!
    const midQueueSession = f.db.sessionRepository.find(f.sessionId)!
    const afterPerm = f.db.sessionRepository.savePermission({
      sessionId: f.sessionId,
      agentId: 'agy',
      mode: 'ask',
      expectedRevision: midQueueSession.settingsRevision,
      confirmedFullAccess: false,
    })
    const afterModel = f.db.sessionRepository.saveSettings(f.sessionId, {
      ...afterPerm.session.settings,
      agents: {
        ...afterPerm.session.settings.agents,
        agy: { model: 'gemini-4-neon-high', effort: null, speed: 'native' },
      },
    })
    expect(afterModel.session.settingsRevision).toBeGreaterThan(afterPerm.session.settingsRevision)

    // Release Codex -> queued @agy input admits and MUST use live settingsRevision (ask + gemini-4-neon-high, NEVER revoked full)!
    harness.releaseWait?.()
    await vi.waitFor(() => {
      const agyRun = f.db.conversationRepository.latestAgentRun(f.sessionId, 'agy')
      expect(agyRun?.status).toBe('completed')
    })
    await f.waitForIdle()

    const admittedAgyRun = f.db.conversationRepository.latestAgentRun(f.sessionId, 'agy')!
    expect(admittedAgyRun).toBeDefined()
    const lastExecutedAgy = harness.runs.findLast((entry) => entry.agentId === 'agy')
    expect(lastExecutedAgy?.input.model).toBe('gemini-4-neon-high')
    // Once fix-contracts-db merges beginRun's live-revision admission settings, admittedAgyRun.permissionMode is also 'ask'
    expect(harness.retiredFullAccess).toContainEqual(
      expect.objectContaining({ sessionId: f.sessionId }),
    )
  })

  it('persists lease-bound dispatchedExecutorId on rebuildNativeContext and never disposes a shared AgyAcpConnectionPool while referenced by cached adapters', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    const initialSend = await f.sendMessage(f.sessionId, 'Initial agy turn')
    expect(initialSend.ok).toBe(true)
    await f.waitForIdle()
    const originalContext = f.db.conversationRepository.nativeContext(f.sessionId, 'agy')!

    f.db.conversationRepository.markNativeContextsMissing(
      f.sessionId,
      ['agy'],
      'Missing native DB for lease-bound executorId test.',
    )

    const leaseSpecificExecutorUuid = '00000000-0000-4000-8000-0000000000b2'
    harness.rebuildHandler = async (input) => {
      await input.onNativeCreationDispatched?.(leaseSpecificExecutorUuid)
      await input.onNativeSessionCreated?.('sid-lease-rebuilt')
      input.reportNativeWork?.({
        executorId: leaseSpecificExecutorUuid,
        nativeSessionId: 'sid-lease-rebuilt',
        state: 'settled',
      })
      return {
        nativeSessionId: 'sid-lease-rebuilt',
        initializationWitness: {
          kind: 'agy_rebuild_v1',
          nativeSessionId: 'sid-lease-rebuilt',
          pbSha256: 'e'.repeat(64),
          pbBytes: 512,
          stepCount: 2,
          sourceHash: input.sourceHash ?? 'f'.repeat(64),
          coldLoadVerifiedAt: '2026-11-19T14:00:00.000Z',
        },
      }
    }

    const rebuildStarted = await f.flow.rebuildNativeContext({
      sessionId: f.sessionId,
      agentId: 'agy',
      intent: 'create',
      clientOperationId: randomUUID(),
      expectedNativeSessionId: originalContext.nativeSessionId,
      expectedGeneration: originalContext.bindingGeneration,
    })
    expect(rebuildStarted.ok).toBe(true)
    await vi.waitFor(() => {
      expect(f.db.conversationRepository.nativeContext(f.sessionId, 'agy')?.nativeSessionId).toBe(
        'sid-lease-rebuilt',
      )
    })
    // Must persist leaseSpecificExecutorUuid ('...00b2'), NOT adapter.executorId ('...00a1')!
    expect(f.db.conversationRepository.nativeContext(f.sessionId, 'agy')?.executorId).toBe(
      leaseSpecificExecutorUuid,
    )

    // Verify 9 distinct ANTIGRAVITY_GEMINI_DIR pools evict referencing idle adapters BEFORE disposing the evicted pool!
    const prevGeminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']
    const tempGeminiDirs: string[] = []
    const events: string[] = []
    try {
      let firstPool: AgyAcpConnectionPool | undefined
      let firstSessionId = ''
      for (let idx = 0; idx < 9; idx += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential pool eviction verification across 9 distinct appDataDirs.
        const customDir = await mkdtemp(join(tmpdir(), `pact-pool-cap-${idx}-`))
        tempGeminiDirs.push(customDir)
        process.env['ANTIGRAVITY_GEMINI_DIR'] = customDir
        const created = f.db.sessionRepository.create(
          {
            id: randomUUID(),
            projectId: f.projectId,
            title: `Pool session ${idx}`,
            createdAt: new Date().toISOString(),
          },
          {
            primaryAgentId: 'agy',
            secondaryAgentId: 'codex',
            agents: {
              claude: { model: null, effort: null, speed: 'native' },
              codex: { model: null, effort: null, speed: 'native' },
              agy: { model: null, effort: null, speed: 'native' },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        )
        const optCountBefore = harness.agyOptions.length
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential turn execution to populate each distinct pool slot.
        const sendRes = await f.sendMessage(created.session.id, `Turn ${idx}`)
        expect(sendRes.ok).toBe(true)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for idle before next pool slot.
        await f.waitForIdle()
        expect(harness.agyOptions.length).toBeGreaterThan(optCountBefore)
        if (idx === 0) {
          firstSessionId = created.session.id
          const rawOpt = harness.agyOptions.at(-1)
          const pool =
            typeof rawOpt === 'object' && rawOpt !== null
              ? Reflect.get(rawOpt, 'connectionPool')
              : undefined
          if (pool instanceof AgyAcpConnectionPool) {
            firstPool = pool
            const origPoolDispose = pool.dispose.bind(pool)
            vi.spyOn(pool, 'dispose').mockImplementation(async (deadline) => {
              events.push('pool0-disposed')
              await origPoolDispose(deadline)
            })
          }
        }
      }
      expect(firstPool).toBeDefined()
      expect(events).toContain('pool0-disposed')

      // Re-running firstSessionId after its pool was evicted allocates a fresh non-disposed pool & adapter cleanly!
      process.env['ANTIGRAVITY_GEMINI_DIR'] = tempGeminiDirs[0]!
      const rerunFirst = await f.sendMessage(firstSessionId, 'Turn after pool eviction')
      expect(rerunFirst.ok).toBe(true)
      await f.waitForIdle()
      const freshOpt = harness.agyOptions.at(-1)
      const freshPool =
        typeof freshOpt === 'object' && freshOpt !== null
          ? Reflect.get(freshOpt, 'connectionPool')
          : undefined
      expect(freshPool).toBeInstanceOf(AgyAcpConnectionPool)
      expect(freshPool).not.toBe(firstPool)
    } finally {
      if (prevGeminiDir === undefined) delete process.env['ANTIGRAVITY_GEMINI_DIR']
      else process.env['ANTIGRAVITY_GEMINI_DIR'] = prevGeminiDir
      await Promise.all(tempGeminiDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    }
  })
})
