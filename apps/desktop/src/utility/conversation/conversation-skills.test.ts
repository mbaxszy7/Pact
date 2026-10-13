import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentRunInput } from '@pact/agent-runtime'
import type { ConversationSendInput, NormalizedAgentEvent, RuntimeAgentId } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { Conversation } from './conversation.js'
import { nativeSkillCatalog } from './native-skill-catalog.js'

type Record = Parameters<typeof nativeSkillCatalog>[3][number]
const native = vi.hoisted(() => ({
  records: { codex: [] as Record[], claude: [] as Record[] },
  inputs: [] as AgentRunInput[],
  discoveries: [] as AbortSignal[],
  blocked: undefined as Promise<void> | undefined,
}))

function adapter(id: RuntimeAgentId) {
  return class {
    readonly id = id
    async probe() {
      return { id, available: true }
    }
    async discoverSkills(cwd: string, signal: AbortSignal) {
      if (native.discoveries.length >= 32) throw new Error('Fixture discovery bound exceeded')
      native.discoveries.push(signal)
      if (native.blocked) {
        let abort!: () => void
        try {
          await Promise.race([
            native.blocked,
            new Promise<void>((_resolve, reject) => {
              abort = () => reject(new Error('Owned discovery cancelled'))
              signal.addEventListener('abort', abort, { once: true })
              if (signal.aborted) abort()
            }),
          ])
        } finally {
          signal.removeEventListener('abort', abort)
        }
      }
      return nativeSkillCatalog(id, cwd, process.execPath, native.records[id])
    }
    async *run(input: AgentRunInput): AsyncGenerator<NormalizedAgentEvent> {
      if (native.inputs.length >= 8) throw new Error('Fixture input bound exceeded')
      native.inputs.push(input)
      yield { agentId: id, type: 'session.started', nativeSessionId: input.runId }
      yield {
        agentId: id,
        type: 'text.completed',
        turnId: input.runId,
        outputId: 'owned-answer',
        text: 'Owned answer',
      }
      yield { agentId: id, type: 'turn.completed', turnId: input.runId, outcome: 'completed' }
    }
    async dispose() {}
  }
}
vi.mock('./codex-agent-adapter.js', () => ({ CodexAgentAdapter: adapter('codex') }))
vi.mock('./claude-agent-adapter.js', () => ({ ClaudeAgentAdapter: adapter('claude') }))

const owned: Array<{ db?: PactDatabase; conversation?: Conversation; directory: string }> = []
beforeEach(() => {
  native.inputs.length = 0
  native.discoveries.length = 0
  native.blocked = undefined
})
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map(async (value) => {
      try {
        await value.conversation?.dispose()
      } finally {
        try {
          value.db?.close()
        } finally {
          await rm(value.directory, { recursive: true, force: true })
        }
      }
    }),
  )
  vi.restoreAllMocks()
})

async function fixture() {
  if (owned.length !== 0) throw new Error('Each admission test owns one fixture')
  const directory = await mkdtemp(join(tmpdir(), 'pact-skill-admission-'))
  const owner: (typeof owned)[number] = { directory }
  owned.push(owner)
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  owner.db = db
  const sessionId = randomUUID(),
    projectId = randomUUID(),
    createdAt = '2026-10-07T00:00:00.000Z'
  await Promise.all(
    (['codex', 'claude'] as const).map(async (agentId) => {
      const folder = join(directory, agentId)
      await mkdir(folder)
      const path = join(folder, 'SKILL.md')
      await writeFile(path, `# ${agentId} definition\n`)
      native.records[agentId] = [
        { name: 'x', description: `${agentId} definition`, scope: 'user', path },
      ]
    }),
  )
  db.projectCatalogRepository.add({
    id: projectId,
    name: 'Owned Skills',
    directoryPath: directory,
    kind: 'directory',
    createdAt,
  })
  db.sessionRepository.create(
    { id: sessionId, projectId, title: 'Owned Skills', createdAt },
    {
      primaryAgentId: 'codex',
      agents: { codex: { model: null, effort: null }, claude: { model: null, effort: null } },
      maxDiscussionRounds: 3,
      runningMessagePolicy: 'next_round',
      maxReviewCycles: 3,
      maxRepairAttempts: 3,
    },
  )
  const preparation = new RuntimePreparation(db.runtimePreparationRepository)
  vi.spyOn(preparation, 'findRecoveryExecutable').mockResolvedValue(process.execPath)
  vi.spyOn(preparation, 'inspectReadiness').mockResolvedValue({
    ok: true,
    value: {
      firstUse: false,
      agents: [
        {
          agentId: 'codex',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
        {
          agentId: 'claude',
          executablePath: process.execPath,
          state: 'ready',
          checkedAt: createdAt,
        },
      ],
    },
  })
  const conversation = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    preparation,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
  )
  owner.conversation = conversation
  const input = (content: string): ConversationSendInput => ({
    sessionId,
    clientMessageId: randomUUID(),
    content,
    expectedCommentsRevision: 0,
    commentIds: [],
  })
  const catalog = async (
    agentId: RuntimeAgentId = 'codex',
    refresh = false,
    generation?: string,
  ) => {
    const result = await conversation.readSkillCatalog({
      sessionId,
      agentId,
      query: '',
      offset: 0,
      refresh,
      ...(generation ? { generation } : {}),
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  return { db, conversation, directory, sessionId, input, catalog }
}

describe('Skill admission through Conversation', () => {
  it('rejects a later stale repeated selection before persisting or dispatching input', async () => {
    const f = await fixture(),
      page = await f.catalog()
    const entry = page.skills[0]!
    const result = await f.conversation.send({
      ...f.input('/x /x task'),
      skills: [
        { id: entry.id, name: 'x', agentId: 'codex', start: 0, end: 2 },
        { id: 'b'.repeat(64), name: 'x', agentId: 'codex', start: 3, end: 5 },
      ],
    })
    expect(result).toMatchObject({ ok: false })
    expect(native.inputs).toHaveLength(0)
    expect(f.db.conversationRepository.latestAgentRun(f.sessionId, 'codex')).toBeUndefined()
  })

  it('freezes one shared task and independent native definitions for both @all targets', async () => {
    const f = await fixture()
    const result = await f.conversation.send(f.input('/x @all task\nnext line'))
    expect(result.ok).toBe(true)
    await vi.waitFor(() => expect(native.inputs).toHaveLength(2))
    const invocation = native.inputs[0]!.promptEnvelope.skillInvocation!
    expect(invocation.arguments).toBe('task\nnext line')
    expect(invocation.bindings.map((entry) => [entry.agentId, entry.description])).toEqual([
      ['codex', 'codex definition'],
      ['claude', 'claude definition'],
    ])
    expect(invocation.bindings[0]?.id).not.toBe(invocation.bindings[1]?.id)
    expect(native.inputs[1]!.promptEnvelope.skillInvocation).toEqual(invocation)
    expect(native.inputs[1]!.promptEnvelope.handoffContext).toBeUndefined()
    const message = f.db.conversationRepository
      .read(f.sessionId)
      .messages.find((entry) => entry.role === 'user')!
    expect(f.db.conversationRepository.skillInvocation(message.id)).toEqual(invocation)
  })

  it('blocks an incomplete @all Skill before creating a User input', async () => {
    const f = await fixture()
    native.records.claude = []
    expect(await f.conversation.send(f.input('/x @all task'))).toMatchObject({ ok: false })
    expect(native.inputs).toHaveLength(0)
    expect(f.db.conversationRepository.read(f.sessionId).messages).toHaveLength(0)
  })

  it('preserves an unchanged catalog generation on a refresh but fences changed definitions', async () => {
    const f = await fixture(),
      first = await f.catalog()
    expect((await f.catalog('codex', true, first.generation)).generation).toBe(first.generation)
    native.records.codex[0]!.description = 'changed definition'
    const result = await f.conversation.readSkillCatalog({
      sessionId: f.sessionId,
      agentId: 'codex',
      query: '',
      offset: 0,
      refresh: true,
      generation: first.generation,
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect((await f.catalog()).skills[0]?.id).not.toBe(first.skills[0]?.id)
    expect(native.inputs).toHaveLength(0)
  })

  it('reads only the advertised document and returns truthful unavailability without invoking a model', async () => {
    const f = await fixture(),
      page = await f.catalog()
    const document = await f.conversation.readSkillDocument({
      sessionId: f.sessionId,
      agentId: 'codex',
      skillId: page.skills[0]!.id,
      requestId: randomUUID(),
    })
    expect(document).toMatchObject({
      ok: true,
      value: { status: 'available', content: '# codex definition\n' },
    })
    delete native.records.claude[0]!.path
    const claude = await f.catalog('claude')
    expect(
      await f.conversation.readSkillDocument({
        sessionId: f.sessionId,
        agentId: 'claude',
        skillId: claude.skills[0]!.id,
        requestId: randomUUID(),
      }),
    ).toMatchObject({
      ok: true,
      value: { status: 'unavailable', reason: 'native_document_not_exposed' },
    })
    expect(native.inputs).toHaveLength(0)
  })

  it('cancels discovery, releases its signal, and permits a fresh metadata read', async () => {
    const f = await fixture(),
      blocked = Promise.withResolvers<void>()
    native.blocked = blocked.promise
    const read = f.conversation.readSkillCatalog({
      sessionId: f.sessionId,
      agentId: 'codex',
      query: '',
      offset: 0,
      refresh: false,
    })
    await vi.waitFor(() => expect(native.discoveries).toHaveLength(1))
    f.conversation.cancelSkillCatalog(f.sessionId)
    expect((await read).ok).toBe(false)
    expect(native.discoveries[0]?.aborted).toBe(true)
    blocked.resolve()
    native.blocked = undefined
    // Logical cancellation precedes physical actor settlement. Let its Promise cleanup finish.
    await new Promise<void>((done) => setImmediate(done))
    expect((await f.catalog()).skills.map((entry) => entry.name)).toEqual(['x'])
    expect(native.inputs).toHaveLength(0)
  })
})
