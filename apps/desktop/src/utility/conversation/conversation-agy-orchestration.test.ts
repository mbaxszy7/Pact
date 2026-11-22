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

import {
  buildBoundedNativePlanId,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
  type DefaultSessionSettings,
  type NormalizedAgentEvent,
  type PeerRequestKind,
  type RuntimeAgentId,
} from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { AgyAcpConnectionPool } from './agy-acp-connection.js'
import { buildAgyPactMcpServerName } from './agy-agent-adapter.js'
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
  nextRunGenerator: undefined as
    | ((agentId: RuntimeAgentId, input: AgentRunInput) => AsyncGenerator<NormalizedAgentEvent>)
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
      if (harness.nextRunGenerator) {
        const gen = harness.nextRunGenerator
        harness.nextRunGenerator = undefined
        yield* gen(agentId, input)
        return
      }
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
vi.mock('./agy-agent-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agy-agent-adapter.js')>()
  return {
    ...actual,
    AgyAgentAdapter: createMockAdapter('agy'),
  }
})

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
  harness.nextRunGenerator = undefined
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
                    rawInput: { runId, grant: grantId, source: 'inputs', offset: 0 },
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

  it('Round-4 Med #16: wires shared agyForkFiles physical operation observer and retries failed agyForkFiles / agyConnectionPool disposal without replaying completed base shutdown', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    // Exercise adapter creation with a shared agyForkFiles implementing addPhysicalOperationObserver
    const registeredObservers: Array<(signal: AbortSignal, completion: Promise<void>) => void> = []
    let unsubscribeCalls = 0
    let forkDisposeCalls = 0
    let failFirstForkDispose = true
    const fakeSharedForkFiles = {
      addPhysicalOperationObserver(
        observer: (signal: AbortSignal, completion: Promise<void>) => void,
      ): () => void {
        registeredObservers.push(observer)
        return () => {
          unsubscribeCalls += 1
        }
      },
      async dispose(): Promise<void> {
        forkDisposeCalls += 1
        if (failFirstForkDispose) {
          failFirstForkDispose = false
          throw new Error('forced fork-files dispose failure')
        }
      },
    }
    Reflect.set(f.flow, 'agyForkFiles', fakeSharedForkFiles)

    const sendRes = await f.sendMessage(f.sessionId, 'Trigger agy adapter & pool creation')
    expect(sendRes.ok).toBe(true)
    await f.waitForIdle()

    // Adapter options MUST receive subscribeStoragePhysicalOperations wired to agyForkFiles.addPhysicalOperationObserver
    const rawOpt = harness.agyOptions.at(-1)
    const rawSubscribe =
      typeof rawOpt === 'object' && rawOpt !== null
        ? Reflect.get(rawOpt, 'subscribeStoragePhysicalOperations')
        : undefined
    expect(typeof rawSubscribe).toBe('function')
    if (typeof rawSubscribe !== 'function') {
      throw new Error('Expected subscribeStoragePhysicalOperations function')
    }
    const unsub: unknown = rawSubscribe(() => undefined)
    expect(registeredObservers).toHaveLength(1)
    if (typeof unsub === 'function') unsub()
    expect(unsubscribeCalls).toBe(1)

    // Also make the active agyConnectionPool fail its first dispose() call and succeed on retry
    const rawPool =
      typeof rawOpt === 'object' && rawOpt !== null
        ? Reflect.get(rawOpt, 'connectionPool')
        : undefined
    expect(rawPool).toBeInstanceOf(AgyAcpConnectionPool)
    if (!(rawPool instanceof AgyAcpConnectionPool)) throw new Error('Expected AgyAcpConnectionPool')
    const origPoolDispose = rawPool.dispose.bind(rawPool)
    let poolDisposeCalls = 0
    let failFirstPoolDispose = true
    vi.spyOn(rawPool, 'dispose').mockImplementation(async (deadline) => {
      poolDisposeCalls += 1
      if (failFirstPoolDispose) {
        failFirstPoolDispose = false
        throw new Error('forced pool dispose failure')
      }
      await origPoolDispose(deadline)
    })

    // Spy on base shutdown resource (notificationProjector) to ensure completed base shutdown does NOT replay on retry
    const rawProjector: unknown = Reflect.get(f.flow, 'notificationProjector')
    if (typeof rawProjector !== 'object' || rawProjector === null) {
      throw new Error('Expected notificationProjector object')
    }
    const origProjectorDispose: unknown = Reflect.get(rawProjector, 'dispose')
    if (typeof origProjectorDispose !== 'function') {
      throw new Error('Expected notificationProjector.dispose function')
    }
    let projectorDisposeCalls = 0
    Reflect.set(rawProjector, 'dispose', (...args: unknown[]) => {
      projectorDisposeCalls += 1
      return Reflect.apply(origProjectorDispose, rawProjector, args)
    })

    const getPoolMap = (): Map<unknown, unknown> => {
      const m: unknown = Reflect.get(f.flow, 'agyConnectionPools')
      if (!(m instanceof Map)) throw new Error('Expected agyConnectionPools Map')
      return m
    }

    // First dispose() MUST reject, retaining failed pool & agyForkFiles for retry
    await expect(f.flow.dispose()).rejects.toThrow(
      /Pact could not finish all output commits and resource cleanup/u,
    )
    expect(forkDisposeCalls).toBe(1)
    expect(poolDisposeCalls).toBe(1)
    expect(projectorDisposeCalls).toBe(1)
    expect(Reflect.get(f.flow, 'agyForkFiles')).toBe(fakeSharedForkFiles)
    expect(getPoolMap().size).toBe(1)

    // Second dispose() retries ONLY pending agyForkFiles + failed pool and succeeds cleanly without replaying base shutdown
    await expect(f.flow.dispose()).resolves.toBeUndefined()
    expect(forkDisposeCalls).toBe(2)
    expect(poolDisposeCalls).toBe(2)
    expect(projectorDisposeCalls).toBe(1)
    expect(Reflect.get(f.flow, 'agyForkFiles')).toBeUndefined()
    expect(getPoolMap().size).toBe(0)
  })

  it('Round-5 Shard 3: 9th pool eviction retires healthy idle pools with warm occupiedProcessSlotCount > 0, skips busy pools, never swallows dispose errors, and retains unconfirmed pools', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    const prevGeminiDir = process.env['ANTIGRAVITY_GEMINI_DIR']
    const tempGeminiDirs: string[] = []
    let pool0Occupied = 0
    let pool1Occupied = 0
    let pool2Occupied = 0
    try {
      const createdPools: AgyAcpConnectionPool[] = []
      const createAgySession = (title: string) =>
        f.db.sessionRepository.create(
          {
            id: randomUUID(),
            projectId: f.projectId,
            title,
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

      // Populate 8 distinct pool slots
      for (let idx = 0; idx < 8; idx += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Populate 8 distinct pools sequentially.
        const customDir = await mkdtemp(join(tmpdir(), `pact-pool-rec8-${idx}-`))
        tempGeminiDirs.push(customDir)
        process.env['ANTIGRAVITY_GEMINI_DIR'] = customDir
        const created = createAgySession(`Rec8 Pool ${idx}`)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequential run to allocate each pool.
        const sendRes = await f.sendMessage(created.session.id, `Rec8 turn ${idx}`)
        expect(sendRes.ok).toBe(true)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Wait for idle before next slot.
        await f.waitForIdle()
        const latestOpt = harness.agyOptions.at(-1)
        const pool =
          typeof latestOpt === 'object' && latestOpt !== null
            ? Reflect.get(latestOpt, 'connectionPool')
            : undefined
        expect(pool).toBeInstanceOf(AgyAcpConnectionPool)
        if (pool instanceof AgyAcpConnectionPool) createdPools.push(pool)
      }

      const rawPoolMap: unknown = Reflect.get(f.flow, 'agyConnectionPools')
      if (!(rawPoolMap instanceof Map)) throw new Error('Expected agyConnectionPools Map')
      const poolMap = rawPoolMap
      expect(poolMap.size).toBe(8)

      // Subcase 0 (Shard 3 fix): Pool #0 is a healthy idle pool holding a warm process
      // (`occupiedProcessSlotCount === 1`). `tryRetireIdle()` MUST be invoked and retire Pool #0
      // (releasing its warm process slot to 0) so the 9th pool succeeds via LRU eviction!
      const pool0 = createdPools[0]!
      pool0Occupied = 1
      Object.defineProperty(pool0, 'occupiedProcessSlotCount', {
        get: () => pool0Occupied,
        configurable: true,
      })
      const pool0DisposeSpy = vi.spyOn(pool0, 'dispose').mockImplementationOnce(async () => {
        pool0Occupied = 0
      })

      const ninthDir = await mkdtemp(join(tmpdir(), 'pact-pool-rec8-9-'))
      tempGeminiDirs.push(ninthDir)
      process.env['ANTIGRAVITY_GEMINI_DIR'] = ninthDir
      const ninthSession = createAgySession('Rec8 Pool 9')
      const ninthSend = await f.sendMessage(ninthSession.session.id, 'Rec8 turn 9')
      expect(ninthSend.ok).toBe(true)
      await f.waitForIdle()

      expect(pool0DisposeSpy).toHaveBeenCalledTimes(1)
      expect([...poolMap.values()]).not.toContain(pool0)
      expect(poolMap.size).toBe(8)

      // Subcase A: Pool #1 is genuinely busy (`tryRetireIdle()` returns `{ kind: 'busy' }`, e.g.
      // quarantined/unconfirmed slot with `occupiedProcessSlotCount === 1`). Eviction MUST skip
      // Pool #1 without calling `dispose()` and evict Pool #2!
      const pool1 = createdPools[1]!
      const pool2 = createdPools[2]!
      pool1Occupied = 1
      Object.defineProperty(pool1, 'occupiedProcessSlotCount', {
        get: () => pool1Occupied,
        configurable: true,
      })
      vi.spyOn(pool1, 'tryRetireIdle').mockReturnValue({ kind: 'busy' })
      const pool1DisposeSpy = vi.spyOn(pool1, 'dispose')
      const pool2DisposeSpy = vi.spyOn(pool2, 'dispose')

      const tenthDir = await mkdtemp(join(tmpdir(), 'pact-pool-rec8-10-'))
      tempGeminiDirs.push(tenthDir)
      process.env['ANTIGRAVITY_GEMINI_DIR'] = tenthDir
      const tenthSession = createAgySession('Rec8 Pool 10')
      const tenthSend = await f.sendMessage(tenthSession.session.id, 'Rec8 turn 10')
      expect(tenthSend.ok).toBe(true)
      await f.waitForIdle()

      expect(pool1DisposeSpy).not.toHaveBeenCalled()
      expect(pool2DisposeSpy).toHaveBeenCalledTimes(1)
      expect([...poolMap.values()]).toContain(pool1)
      expect([...poolMap.values()]).not.toContain(pool2)
      expect(poolMap.size).toBe(8)

      // Subcase B: When candidate pool dispose() rejects, the error is NOT swallowed and the
      // candidate pool stays retained in agyConnectionPools.
      const pool3 = createdPools[3]!
      vi.spyOn(pool3, 'dispose').mockRejectedValueOnce(new Error('quarantined eviction failure'))
      const eleventhDir = await mkdtemp(join(tmpdir(), 'pact-pool-rec8-11-'))
      tempGeminiDirs.push(eleventhDir)
      process.env['ANTIGRAVITY_GEMINI_DIR'] = eleventhDir
      const eleventhSession = createAgySession('Rec8 Pool 11')
      const eleventhSendA = await f.sendMessage(eleventhSession.session.id, 'Rec8 turn 11A')
      expect(eleventhSendA.ok).toBe(false)
      await f.waitForIdle()
      expect([...poolMap.values()]).toContain(pool3)
      expect(poolMap.size).toBe(8)

      // Subcase C: Even if dispose() resolves without throwing, if occupiedProcessSlotCount stays > 0,
      // the pool is retained rather than deleted (and eviction moves on to the next truly idle pool, pool4)!
      const pool4 = createdPools[4]!
      pool2Occupied = 0
      Object.defineProperty(pool3, 'occupiedProcessSlotCount', {
        get: () => pool2Occupied,
        configurable: true,
      })
      const pool3DisposeMock = vi.spyOn(pool3, 'dispose').mockImplementationOnce(async () => {
        // Simulate a slot becoming quarantined during dispose
        pool2Occupied = 1
      })
      const eleventhSessionB = createAgySession('Rec8 Pool 11B')
      const eleventhSendB = await f.sendMessage(eleventhSessionB.session.id, 'Rec8 turn 11B')
      expect(eleventhSendB.ok).toBe(true)
      await f.waitForIdle()
      // 1 call in Subcase B (rejected) + 1 call in Subcase C (quarantined)
      expect(pool3DisposeMock).toHaveBeenCalledTimes(2)
      expect([...poolMap.values()]).toContain(pool3)
      expect([...poolMap.values()]).not.toContain(pool4)
      expect(poolMap.size).toBe(8)
    } finally {
      pool0Occupied = 0
      pool1Occupied = 0
      pool2Occupied = 0
      if (prevGeminiDir === undefined) delete process.env['ANTIGRAVITY_GEMINI_DIR']
      else process.env['ANTIGRAVITY_GEMINI_DIR'] = prevGeminiDir
      await Promise.all(tempGeminiDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    }
  })

  it('Wave-3: resolves Open-mode cold publish_plan intent only when inspectAgyRun confirms completion', async () => {
    const nativeSessionId = randomUUID()
    const runId = randomUUID()
    const sessionId = randomUUID()
    const requestId = randomUUID()
    let hasCompleted = true
    let completedTokens: readonly string[] = ['traj-1:42']
    const fakeForkFiles = {
      execute: async () => {
        throw new Error('unused')
      },
      prepareAgyBoundary: async () => {
        throw new Error('unused')
      },
      exists: async () => true,
      forkAgy: async () => {
        throw new Error('unused')
      },
      inspectAgyFork: async () => {
        throw new Error('unused')
      },
      rebuildAgySeed: async () => {
        throw new Error('unused')
      },
      verifyAgySeed: async () => {
        throw new Error('unused')
      },
      readAgyTrajectoryIdentity: async () => ({
        nativeSessionId,
        status: 'ok' as const,
        trajectoryId: 'traj-1',
        stepCount: 4,
      }),
      inspectAgyRun: async () => ({
        exists: true,
        stepCount: 4,
        terminalState: {
          executionId: 'exec-open-1',
          status: 'completed' as const,
          consumedInputStepIds: [],
          consumedInputs: [],
          answer: 'Updated the plan.',
          responseHash: 'a'.repeat(64),
          hasCompletedPactPublishPlan: hasCompleted,
          completedPactPublishPlanTokens: completedTokens,
        },
      }),
    }

    const storageClient = createAgyNativeStorageClient(
      fakeForkFiles,
      '/tmp/app-data',
      (_probeRunId, terminalState) => {
        if (
          terminalState.hasCompletedPactPublishPlan &&
          terminalState.completedPactPublishPlanTokens?.includes('traj-1:42')
        ) {
          return {
            plan: {
              nativeId: `${nativeSessionId}:tc-open-final`,
              text: '# Recovered Open Plan\nVerified from intent.',
            },
          }
        }
        return undefined
      },
    )

    // 1. Confirmed completed publish_plan token -> cold probe recovers plan cleanly.
    const confirmed = await storageClient.probeSessionStatus!(
      {
        agentId: 'agy',
        sessionId,
        requestId,
        runId,
        nativeSessionId,
        nativeTurnId: 'exec-open-1',
        bindingGeneration: 1,
        executorId: 'exec-1',
        cwd: '/tmp/repo',
        model: null,
        effort: null,
        inspectMissingPlan: true,
      },
      new AbortController().signal,
    )
    expect(confirmed).toMatchObject({
      kind: 'ended',
      output: {
        plan: {
          nativeId: `${nativeSessionId}:tc-open-final`,
          text: '# Recovered Open Plan\nVerified from intent.',
        },
      },
    })

    // 2. Unconfirmed / mismatched token -> cold probe NEVER invents a plan!
    hasCompleted = false
    completedTokens = []
    const unconfirmed = await storageClient.probeSessionStatus!(
      {
        agentId: 'agy',
        sessionId,
        requestId,
        runId,
        nativeSessionId,
        nativeTurnId: 'exec-open-1',
        bindingGeneration: 1,
        executorId: 'exec-1',
        cwd: '/tmp/repo',
        model: null,
        effort: null,
        inspectMissingPlan: true,
      },
      new AbortController().signal,
    )
    expect(unconfirmed.kind).toBe('ended')
    expect(unconfirmed.kind === 'ended' ? unconfirmed.output?.plan : 'wrong-kind').toBeUndefined()
  })

  it('Round-5 Shard 4: strictly isolates Open-mode publish_plan from Brain artifacts, rejects empty token fallback, and shares canonical bounded nativePlanId', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })

    // 1. Open Mode probeSessionStatus MUST NOT request Brain artifacts (`includePlan === false`)
    // and MUST NEVER let a Brain artifact shadow journaled publish_plan recovery!
    const nativeSessionId = randomUUID()
    const runId = randomUUID()
    const observedIncludePlan: boolean[] = []
    const fakeForkFiles = {
      execute: async () => {
        throw new Error('unused')
      },
      prepareAgyBoundary: async () => {
        throw new Error('unused')
      },
      exists: async () => true,
      forkAgy: async () => {
        throw new Error('unused')
      },
      inspectAgyFork: async () => {
        throw new Error('unused')
      },
      rebuildAgySeed: async () => {
        throw new Error('unused')
      },
      verifyAgySeed: async () => {
        throw new Error('unused')
      },
      readAgyTrajectoryIdentity: async () => ({
        nativeSessionId,
        status: 'ok' as const,
        trajectoryId: 'traj-open',
        stepCount: 4,
      }),
      inspectAgyRun: async (input: { includePlan?: boolean }) => {
        observedIncludePlan.push(Boolean(input.includePlan))
        return {
          exists: true,
          stepCount: 4,
          terminalState: {
            executionId: 'exec-open-shadow',
            status: 'completed' as const,
            consumedInputStepIds: [],
            consumedInputs: [],
            answer: 'Done.',
            responseHash: 'b'.repeat(64),
            // Even if Brain artifact were somehow returned on an Open Mode probe, Open Mode must ignore it!
            plan: {
              nativeId: `${nativeSessionId}:implementation_plan`,
              text: '# Stale Brain Plan (MUST NOT SHADOW OPEN MODE)',
            },
            hasCompletedPactPublishPlan: true,
            completedPactPublishPlanTokens: ['traj-open:77'],
          },
        }
      },
    }

    const storageClient = createAgyNativeStorageClient(
      fakeForkFiles,
      '/tmp/app-data',
      (_probeRunId, _terminalState, probedNativeSessionId) => ({
        plan: {
          nativeId: buildBoundedNativePlanId(
            probedNativeSessionId ?? nativeSessionId,
            'tc-open-77',
          ),
          text: '# Canonical Open Mode Plan',
        },
      }),
    )

    // Open Mode (no `planSource`, `inspectMissingPlan: true`) -> includePlan MUST be false, Open Mode plan wins!
    const openProbe = await storageClient.probeSessionStatus!(
      {
        agentId: 'agy',
        sessionId: f.sessionId,
        requestId: randomUUID(),
        runId,
        nativeSessionId,
        nativeTurnId: 'exec-open-shadow',
        bindingGeneration: 1,
        executorId: 'exec-1',
        cwd: '/tmp/repo',
        model: null,
        effort: null,
        inspectMissingPlan: true,
      },
      new AbortController().signal,
    )
    expect(observedIncludePlan[0]).toBe(false)
    expect(openProbe).toMatchObject({
      kind: 'ended',
      output: {
        plan: {
          nativeId: buildBoundedNativePlanId(nativeSessionId, 'tc-open-77'),
          text: '# Canonical Open Mode Plan',
        },
      },
    })

    // Phase 1 (`planSource: 'native_plan_artifact'`) -> includePlan MUST be true, Brain artifact wins!
    const phase1Probe = await storageClient.probeSessionStatus!(
      {
        agentId: 'agy',
        sessionId: f.sessionId,
        requestId: randomUUID(),
        runId,
        nativeSessionId,
        nativeTurnId: 'exec-open-shadow',
        bindingGeneration: 1,
        executorId: 'exec-1',
        cwd: '/tmp/repo',
        model: null,
        effort: null,
        planSource: true,
        inspectMissingPlan: true,
      },
      new AbortController().signal,
    )
    expect(observedIncludePlan[1]).toBe(true)
    expect(phase1Probe).toMatchObject({
      kind: 'ended',
      output: {
        plan: {
          nativeId: `${nativeSessionId}:implementation_plan`,
          text: '# Stale Brain Plan (MUST NOT SHADOW OPEN MODE)',
        },
      },
    })

    // 2. Test Conversation.resolveColdOpenPlanIntent directly:
    // - Rejects empty completedPactPublishPlanTokens (no weak intents.length === 1 fallback)
    // - Matches long (>256-char) toolCallId using shared bounded encoders and returns canonical nativePlanId
    const longCallId = `tc-${'x'.repeat(300)}`
    const boundedCallKey = encodeBoundedOpenPlanCallKey(`call:${longCallId}`)
    const boundedToken = encodeBoundedOpenPlanProgressToken(`traj-long-${'y'.repeat(280)}:99`)
    const expectedCanonicalNativePlanId = buildBoundedNativePlanId(nativeSessionId, longCallId)

    const repo = f.db.conversationRepository
    const openRunId = randomUUID()
    vi.spyOn(repo, 'workflowOpenPlanPublishIntents').mockReturnValue([
      {
        runId: openRunId,
        executionId: 'exec-long-1',
        actor: 'agy',
        callKey: boundedCallKey,
        progressToken: boundedToken,
        nativePlanId: expectedCanonicalNativePlanId,
        document: {
          id: randomUUID(),
          sha256: 'c'.repeat(64),
          bytes: 32,
          chars: 32,
        },
      },
    ])
    vi.spyOn(repo, 'readOpenPlanPublishIntentText').mockReturnValue(
      '# Long ID Open Plan\nVerified.',
    )
    const rawResolver: unknown = Reflect.get(f.flow, 'resolveColdOpenPlanIntent')
    if (typeof rawResolver !== 'function') {
      throw new Error('Expected resolveColdOpenPlanIntent method on Conversation')
    }

    // Empty tokens -> MUST return planUnavailable (NO weak intents.length === 1 fallback)!
    expect(
      Reflect.apply(rawResolver, f.flow, [
        openRunId,
        {
          executionId: 'exec-long-1',
          status: 'completed',
          hasCompletedPactPublishPlan: true,
          completedPactPublishPlanTokens: [],
        },
        nativeSessionId,
      ]),
    ).toEqual({ planUnavailable: true })

    // Matching raw long toolCallId -> matches bounded callKey AND returns exact canonical nativePlanId!
    expect(
      Reflect.apply(rawResolver, f.flow, [
        openRunId,
        {
          executionId: 'exec-long-1',
          status: 'completed',
          hasCompletedPactPublishPlan: true,
          completedPactPublishPlanTokens: [longCallId],
        },
        nativeSessionId,
      ]),
    ).toEqual({
      plan: {
        nativeId: expectedCanonicalNativePlanId,
        text: '# Long ID Open Plan\nVerified.',
      },
    })
  })

  it('Round-5 Shard 4: Open Mode Ask only dispatches strictly as read-only reply stage and blocks persisted non-reply ask_only authorizations before native dispatch', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })
    const repo = f.db.conversationRepository

    // Bring a collaboration task cleanly into idle Open Mode (accepted plan -> execute -> waiting openMode).
    const startRes = await f.sendMessage(f.sessionId, '/plan Design and build module Z')
    expect(startRes.ok).toBe(true)
    await f.waitForIdle()

    // Advance into an idle Open Mode task directly in SQLite for deterministic ask_only dispatch test.
    const planRun = harness.runs.at(-1)!
    repo.recordWorkflowPlan(planRun.input.runId, {
      nativeId: 'plan-z-1',
      text: '# Plan Z\n1. Implement Z',
    })
    repo.reconcileCompletedCollaboration(planRun.input.runId)
    const afterPlan = repo.collaboration(f.sessionId)!
    expect(afterPlan.nextStage).toBe('plan_review')

    // Verify directly through ConversationRepository + Conversation dispatch that ask_only on an
    // idle Open Mode task chooses stage === 'reply' (never 'collaborate').
    const openTask = {
      ...afterPlan,
      openMode: true,
      status: 'waiting' as const,
      stage: 'collaborate' as const,
      automation: 'active' as const,
      nextStage: undefined,
      pauseReason: undefined,
      notice: undefined,
      planVersion: 1,
      revision: afterPlan.revision + 1,
    }
    const askReply = repo.workflowReply(openTask, 'agy', true)
    expect(askReply.stage).toBe('reply')
    const normalCollab = repo.workflowReply(openTask, 'agy', false)
    expect(normalCollab.stage).toBe('collaborate')

    // Verify Conversation rejects a corrupted/persisted ask_only authorization whose stage !== 'reply'
    // BEFORE recordNativeEffects(run.id, 'pending') and BEFORE adapter.run()!
    const runsBefore = harness.runs.length
    const nativeEffectsSpy = vi.spyOn(repo, 'recordNativeEffects')
    const baseAuth = repo.collaborationTurnAuthorization(planRun.input.runId)!
    vi.spyOn(repo, 'collaborationTurnAuthorization').mockReturnValueOnce({
      ...baseAuth,
      stage: 'collaborate',
      actor: 'agy',
      replyIntentBasis: {
        kind: 'ask_only',
        inputId: randomUUID(),
        inputDigest: 'e'.repeat(64),
        taskRevision: openTask.revision - 1,
        priorInputSequence: openTask.inputSequence,
      },
    })

    const sendGuard = await f.sendMessage(f.sessionId, 'Just a quick question')
    expect(sendGuard.ok).toBe(true)
    await f.waitForIdle()
    // Adapter MUST NOT have been invoked and nativeEffects MUST NOT have been marked 'pending' for the rejected run!
    expect(harness.runs.length).toBe(runsBefore)
    const pendingCalls = nativeEffectsSpy.mock.calls.filter(([, state]) => state === 'pending')
    expect(pendingCalls.length).toBe(0)
  })

  it('Wave 6: Open Mode Ask only through the real received-input queue dispatches strictly as read-only reply stage', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })
    const repo = f.db.conversationRepository

    // 1. Start /plan -> plan_review (accepted) -> execute -> idle Open Mode using real Conversation transitions.
    const makeStageGenerator = (
      nextStageHook?: (stage: string | undefined, input: AgentRunInput) => void,
    ) => {
      const gen = async function* (
        agentId: RuntimeAgentId,
        input: AgentRunInput,
      ): AsyncGenerator<NormalizedAgentEvent> {
        const stage = input.promptEnvelope.collaboration?.stage
        if (stage === 'plan' || stage === 'plan_review' || stage === 'implement') {
          harness.nextRunGenerator = gen
        }
        const nativeSessionId =
          input.nativeSessionId ?? `${agentId}-sid-${input.sessionId.slice(0, 8)}`
        const executorId =
          agentId === 'agy'
            ? '00000000-0000-4000-8000-0000000000a1'
            : '00000000-0000-4000-8000-0000000000c2'
        input.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
        yield { agentId, type: 'session.started', nativeSessionId }
        input.recordDispatch?.('accepted', nativeSessionId, executorId)
        yield { agentId, type: 'turn.started', turnId: input.runId }
        nextStageHook?.(stage, input)
        yield {
          agentId,
          type: 'text.completed',
          turnId: input.runId,
          outputId: `${agentId}-out`,
          text: `Completed ${stage ?? 'turn'}.`,
        }
        const activeRun = repo.findRun(input.runId)
        input.recordNativeEvidence?.({
          kind: 'ended',
          source: 'live_terminal',
          outcome: 'completed',
          identity: {
            sessionId: input.sessionId,
            agentId,
            requestId: input.runId,
            runId: input.runId,
            nativeSessionId,
            nativeTurnId: input.runId,
            bindingGeneration: activeRun?.bindingGeneration ?? input.bindingGeneration ?? 1,
            executorId,
          },
          output: {
            outputId: `${agentId}-out`,
            text: `Completed ${stage ?? 'turn'}.`,
            completeness: 'complete',
          },
        })
        yield { agentId, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
        input.reportNativeEffects?.({
          runId: input.runId,
          generation: String(input.nativeGeneration ?? 1),
          state: 'settled',
        })
      }
      return gen
    }
    harness.nextRunGenerator = makeStageGenerator((stage, input) => {
      if (stage === 'plan') {
        input.recordWorkflowPlan?.({ nativeId: 'plan-q-1', text: '# Plan Q\n1. Build Q' })
      } else if (stage === 'plan_review') {
        input.recordWorkflowReview?.({ verdict: 'accepted' })
      }
    })
    const startRes = await f.sendMessage(f.sessionId, '/plan Design module Q')
    expect(startRes.ok).toBe(true)
    await vi.waitFor(() => {
      const task = repo.collaboration(f.sessionId)
      expect(task?.stage).toBe('plan_review')
      expect(task?.status).toBe('ready')
    })
    await f.waitForIdle()

    const afterReview = repo.collaboration(f.sessionId)!
    const execRes = await f.flow.actOnCollaboration({
      sessionId: f.sessionId,
      taskId: afterReview.id,
      revision: afterReview.revision,
      action: 'execute',
      clientMessageId: randomUUID(),
    })
    expect(execRes.ok).toBe(true)
    await f.waitForIdle()
    harness.nextRunGenerator = undefined

    const settledOpenTask = repo.collaboration(f.sessionId)!
    expect(settledOpenTask.openMode).toBe(true)
    expect(settledOpenTask.status).toBe('waiting')

    // 2. Send a real `askOnly` message through Conversation.send() -> received-input queue -> dispatch!
    const runsBeforeAsk = harness.runs.length
    const askRes = await f.sendMessage(f.sessionId, 'Why did we pick strategy A?', {
      askOnly: { taskId: settledOpenTask.id, expectedRevision: settledOpenTask.revision },
      freezeDrafts: false,
    })
    expect(askRes.ok ? 'ok' : askRes.error.message).toBe('ok')
    await vi.waitFor(() => {
      expect(harness.runs.length).toBe(runsBeforeAsk + 1)
    })
    await f.waitForIdle()

    // Verify the dispatched run materialized through the received-input queue as read-only `reply` stage!
    expect(harness.runs.length).toBe(runsBeforeAsk + 1)
    const askRun = harness.runs.at(-1)!
    expect(askRun.input.promptEnvelope.collaboration?.stage).toBe('reply')
    expect(askRun.input.promptEnvelope.collaborationAuthorization?.stage).toBe('reply')
    expect(askRun.input.promptEnvelope.collaborationAuthorization?.replyIntentBasis?.kind).toBe(
      'ask_only',
    )
  })

  it('Wave 6: resolveColdOpenPlanIntent enforces exact per-run serverName, typed callId/progressToken matching, ignores stepId, and fails closed on ambiguity', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })
    const repo = f.db.conversationRepository
    const nativeSessionId = randomUUID()
    const openRunId = randomUUID()
    const expectedServerName = buildAgyPactMcpServerName(openRunId)
    const wrongServerName = buildAgyPactMcpServerName(randomUUID())

    const longCallId = `tc-w6-${'a'.repeat(300)}`
    const boundedCallKey = encodeBoundedOpenPlanCallKey(`call:${longCallId}`)
    const longProgressToken = `traj-w6-${'b'.repeat(280)}:42`
    const boundedProgressToken = encodeBoundedOpenPlanProgressToken(longProgressToken)
    const canonicalNativePlanId = buildBoundedNativePlanId(nativeSessionId, longCallId)

    const rawResolver: unknown = Reflect.get(f.flow, 'resolveColdOpenPlanIntent')
    if (typeof rawResolver !== 'function') {
      throw new Error('Expected resolveColdOpenPlanIntent method on Conversation')
    }
    const callResolver = (terminalState: Record<string, unknown>) =>
      Reflect.apply(rawResolver, f.flow, [openRunId, terminalState, nativeSessionId])

    const intentsSpy = vi.spyOn(repo, 'workflowOpenPlanPublishIntents')
    const readTextSpy = vi.spyOn(repo, 'readOpenPlanPublishIntentText')

    // 1. Exact per-run serverName + >256B callId & progressToken -> matches cleanly!
    intentsSpy.mockReturnValue([
      {
        runId: openRunId,
        executionId: 'exec-w6-1',
        actor: 'agy',
        callKey: boundedCallKey,
        progressToken: boundedProgressToken,
        nativePlanId: canonicalNativePlanId,
        document: { id: randomUUID(), sha256: 'a'.repeat(64), bytes: 24, chars: 24 },
      },
    ])
    readTextSpy.mockReturnValue('# Wave 6 Typed Cold Plan\nMatched.')

    expect(
      callResolver({
        executionId: 'exec-w6-1',
        status: 'completed',
        hasCompletedPactPublishPlan: true,
        completedPactPublishPlanCalls: [
          {
            serverName: expectedServerName,
            callId: boundedCallKey,
            progressToken: boundedProgressToken,
            stepId: 'step-ignored-1',
          },
        ],
      }),
    ).toEqual({
      plan: {
        nativeId: canonicalNativePlanId,
        text: '# Wave 6 Typed Cold Plan\nMatched.',
      },
    })

    // 2. Wrong serverName -> MUST fail closed (`planUnavailable: true`) even if callId & progressToken match!
    expect(
      callResolver({
        executionId: 'exec-w6-1',
        status: 'completed',
        hasCompletedPactPublishPlan: true,
        completedPactPublishPlanCalls: [
          {
            serverName: wrongServerName,
            callId: boundedCallKey,
            progressToken: boundedProgressToken,
          },
        ],
      }),
    ).toEqual({ planUnavailable: true })

    // 3. stepId colliding with another intent's callId/progressToken -> stepId MUST be ignored!
    intentsSpy.mockReturnValue([
      {
        runId: openRunId,
        executionId: 'exec-w6-1',
        actor: 'agy',
        callKey: 'call:step-collision-99',
        progressToken: 'step-collision-99',
        nativePlanId: `${nativeSessionId}:step-collision-99`,
        document: { id: randomUUID(), sha256: 'b'.repeat(64), bytes: 20, chars: 20 },
      },
    ])
    expect(
      callResolver({
        executionId: 'exec-w6-1',
        status: 'completed',
        hasCompletedPactPublishPlan: true,
        completedPactPublishPlanCalls: [
          {
            serverName: expectedServerName,
            callId: 'call:different-call',
            progressToken: 'different-token',
            stepId: 'step-collision-99',
          },
        ],
      }),
    ).toEqual({ planUnavailable: true })

    // 4. Provisional `token:` intent without `callId` on the completed call MUST NOT borrow stepId or unrelated tokens!
    intentsSpy.mockReturnValue([
      {
        runId: openRunId,
        executionId: 'exec-w6-1',
        actor: 'agy',
        callKey: 'token:traj-prov:7',
        progressToken: 'traj-prov:7',
        document: { id: randomUUID(), sha256: 'c'.repeat(64), bytes: 20, chars: 20 },
      },
    ])
    expect(
      callResolver({
        executionId: 'exec-w6-1',
        status: 'completed',
        hasCompletedPactPublishPlan: true,
        completedPactPublishPlanCalls: [
          {
            serverName: expectedServerName,
            progressToken: 'traj-prov:7',
            stepId: 'step-must-not-become-native-id',
          },
        ],
      }),
    ).toEqual({
      plan: {
        nativeId: buildBoundedNativePlanId(nativeSessionId, 'traj-prov:7'),
        text: '# Wave 6 Typed Cold Plan\nMatched.',
      },
    })

    // 5. Ambiguous multi-intent match -> MUST fail closed (`planUnavailable: true`)!
    intentsSpy.mockReturnValue([
      {
        runId: openRunId,
        executionId: 'exec-w6-1',
        actor: 'agy',
        callKey: 'token:dup-token:1',
        progressToken: 'dup-token:1',
        document: { id: randomUUID(), sha256: 'd'.repeat(64), bytes: 20, chars: 20 },
      },
      {
        runId: openRunId,
        executionId: 'exec-w6-1',
        actor: 'agy',
        callKey: 'token:dup-token:2',
        progressToken: 'dup-token:1',
        document: { id: randomUUID(), sha256: 'e'.repeat(64), bytes: 20, chars: 20 },
      },
    ])
    expect(
      callResolver({
        executionId: 'exec-w6-1',
        status: 'completed',
        hasCompletedPactPublishPlan: true,
        completedPactPublishPlanCalls: [
          {
            serverName: expectedServerName,
            progressToken: 'dup-token:1',
          },
        ],
      }),
    ).toEqual({ planUnavailable: true })
  })

  it('Wave 6: incomplete visible prefix (text.delta + turn.completed failed without text.completed) persists assistant message as incomplete while preserving verified native completed outcome', async () => {
    const f = await createOrchestrationFixture({
      primaryAgentId: 'agy',
      secondaryAgentId: 'codex',
    })
    const repo = f.db.conversationRepository

    harness.nextRunGenerator = async function* (_agentId, input) {
      const nativeSessionId = randomUUID()
      const turnId = `exec-partial-${randomUUID()}`
      const executorId = '00000000-0000-4000-8000-0000000000a1'
      input.recordDispatch?.('possibly_sent', nativeSessionId, executorId)
      yield { type: 'session.started', agentId: 'agy', nativeSessionId }
      input.recordDispatch?.('accepted', nativeSessionId, executorId)
      yield { type: 'turn.started', agentId: 'agy', turnId }
      yield {
        type: 'text.delta',
        agentId: 'agy',
        turnId,
        outputId: 'partial-out-1',
        text: 'Truncated prefix before unresolved pre-bind frames',
      }
      // Intentionally omit `text.completed` and emit `turn.completed { outcome: 'failed' }`
      // before recording the independently verified native outcome with `completeness: 'partial'`,
      // matching AgyAgentAdapter's unresolved pre-bind output settlement.
      yield { type: 'turn.completed', agentId: 'agy', turnId, outcome: 'failed' }
      const activeRun = repo.findRun(input.runId)
      input.recordNativeEvidence?.({
        kind: 'ended',
        source: 'live_terminal',
        outcome: 'completed',
        identity: {
          sessionId: input.sessionId,
          agentId: 'agy',
          requestId: input.runId,
          runId: input.runId,
          nativeSessionId,
          nativeTurnId: turnId,
          bindingGeneration: activeRun?.bindingGeneration ?? input.bindingGeneration ?? 1,
          executorId,
        },
        output: {
          outputId: 'partial-out-1',
          text: 'Truncated prefix before unresolved pre-bind frames',
          completeness: 'partial',
        },
      })
      input.reportNativeEffects?.({
        runId: input.runId,
        generation: String(input.nativeGeneration ?? 1),
        state: 'unknown',
      })
    }

    const res = await f.sendMessage(f.sessionId, 'Trigger truncated prefix', {
      route: { type: 'agent', agentId: 'agy' },
    })
    expect(res.ok).toBe(true)
    await f.waitForIdle()

    const run = harness.runs.at(-1)!
    const runRecord = repo.findRun(run.input.runId)
    expect(runRecord).toEqual(
      expect.objectContaining({
        nativeOutcome: 'completed',
      }),
    )

    const page = repo.readPage({ scope: 'messages', sessionId: f.sessionId })
    if (page.scope !== 'messages') throw new Error('Expected messages page')
    const assistantEntry = page.messages.find(
      (entry) => entry.kind === 'complete' && entry.message.role === 'assistant',
    )
    expect(assistantEntry).toBeDefined()
    if (!assistantEntry || assistantEntry.kind !== 'complete') {
      throw new Error('Expected complete message entry')
    }
    expect(assistantEntry.message.state).toBe('incomplete')
    expect(assistantEntry.message.content).toBe(
      'Truncated prefix before unresolved pre-bind frames',
    )
  })
})
