import { sql } from 'drizzle-orm'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENAI_DECISION_MODEL } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import desktopPackage from '../../../package.json'
import { Conversation } from '../conversation/conversation.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { DefaultSessionSettings } from './default-session-settings.js'

const owners: Array<{
  db: PactDatabase
  runtime: RuntimePreparation
  catalogs: DefaultSessionSettings
  flow: Conversation
  directory: string
}> = []

afterEach(async () => {
  // oxlint-disable no-await-in-loop -- Each owner closes physical work before its database and files.
  for (const owner of owners.splice(0)) {
    await owner.flow.dispose()
    await owner.catalogs.dispose()
    await owner.runtime.dispose()
    owner.db.close()
    await rm(owner.directory, { recursive: true, force: true })
  }
  // oxlint-enable no-await-in-loop
  vi.restoreAllMocks()
})

interface CatalogProbeFact {
  pid: number
  event?: string
  args?: string[]
  cwd?: string
  cwdMode?: number
  method?: string
  params?: Record<string, unknown>
}

function parseCatalogProbeFact(line: string): CatalogProbeFact {
  const raw: unknown = JSON.parse(line)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { pid: 0 }
  }
  const pid = Reflect.get(raw, 'pid')
  const event = Reflect.get(raw, 'event')
  const args = Reflect.get(raw, 'args')
  const cwd = Reflect.get(raw, 'cwd')
  const cwdMode = Reflect.get(raw, 'cwdMode')
  const method = Reflect.get(raw, 'method')
  const params = Reflect.get(raw, 'params')
  const entry: CatalogProbeFact = { pid: typeof pid === 'number' ? pid : 0 }
  if (typeof event === 'string') entry.event = event
  if (Array.isArray(args)) {
    entry.args = args.filter((item): item is string => typeof item === 'string')
  }
  if (typeof cwd === 'string') entry.cwd = cwd
  if (typeof cwdMode === 'number') entry.cwdMode = cwdMode
  if (typeof method === 'string') entry.method = method
  if (typeof params === 'object' && params !== null && !Array.isArray(params)) {
    entry.params = Object.fromEntries(Object.entries(params))
  }
  return entry
}

async function readJsonlFacts(filePath: string): Promise<CatalogProbeFact[]> {
  try {
    return (await readFile(filePath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => parseCatalogProbeFact(line))
  } catch {
    return []
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-relay-catalog-'))
  const isolatedHome = join(directory, 'home')
  const isolatedGemini = join(isolatedHome, '.gemini')
  await mkdir(isolatedGemini, { recursive: true })
  const isolatedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    ANTIGRAVITY_GEMINI_DIR: isolatedGemini,
  }
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const runtime = new RuntimePreparation(db.runtimePreparationRepository, { env: isolatedEnv })
  const catalogs = new DefaultSessionSettings(runtime, db.defaultSessionSettingsRepository, {
    env: isolatedEnv,
  })
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    runtime,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
  )
  owners.push({ db, runtime, catalogs, flow, directory })
  return { db, runtime, catalogs, flow, directory, isolatedGemini, isolatedEnv }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

function buildAgyCatalogSettings(
  model: string,
  effort: 'low' | 'medium' | 'high' | 'xhigh' | null,
) {
  return {
    primaryAgentId: 'codex' as const,
    secondaryAgentId: 'agy' as const,
    agents: {
      claude: { model: null, effort: null },
      codex: { model: 'gpt-5.4', effort: null },
      agy: { model, effort },
    },
    maxDiscussionRounds: 6,
    maxReviewCycles: 3,
    maxRepairAttempts: 3,
  }
}

describe('Relay settings persist independently from native discovery', () => {
  it('saves global intent without loading model catalogs, readiness or starting any Turn', async () => {
    const f = await fixture(),
      load = vi.spyOn(f.catalogs, 'loadModelCatalogs'),
      readiness = vi.spyOn(f.runtime, 'inspectReadiness')
    const repo = f.db.conversationRepository
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: repo.schedulingSettings().revision,
        enabled: true,
        showIndicator: false,
      }),
    ).toMatchObject({ ok: true })
    expect(f.flow.getSchedulingSettings()).toMatchObject({
      ok: true,
      value: {
        enabled: true,
        provider: 'openai',
        model: OPENAI_DECISION_MODEL,
        credential: { configured: false, revision: 0 },
        showIndicator: false,
      },
    })
    const state = f.flow.getSchedulingState({})
    expect(state).toMatchObject({
      ok: true,
      value: {
        context: null,
        connection: { status: 'unconfirmed', checkedAt: null, expiresAt: null },
      },
    })
    if (!state.ok) throw Error('Missing global scheduling state')
    const serialized = JSON.stringify(state.value)
    expect(serialized).not.toContain('ciphertext')
    expect(serialized).not.toContain('key')
    expect(load).not.toHaveBeenCalled()
    expect(readiness).not.toHaveBeenCalled()
    expect(f.db.drizzle.get(sql`SELECT count(*) AS n FROM agent_runs`)).toEqual({ n: 0 })
    expect(repo.readSchedulingActivity({}).rows).toEqual([])
    const beforeInvalid = repo.schedulingSettings(),
      generationBeforeInvalid = repo.schedulingConfigurationGeneration()
    // Retired selector fields are refused by the current settings schema before any discovery.
    // oxlint-disable no-await-in-loop -- Each retired-selector refusal is observed serially.
    for (const invalid of [
      { expectedRevision: repo.schedulingSettings().revision, selection: null },
      {
        expectedRevision: repo.schedulingSettings().revision,
        selection: { target: 'codex_luna', provider: 'codex', modelId: 'gpt-6-luna' },
      },
      { expectedRevision: repo.schedulingSettings().revision, provider: 'codex' },
      { expectedRevision: repo.schedulingSettings().revision, model: 'gpt-6-luna' },
      { expectedRevision: repo.schedulingSettings().revision, catalogIdentity: 'abc' },
    ])
      await expect(
        // oxlint-disable-next-line typescript/unbound-method -- Reflect bypasses typing only at the deliberate invalid-settings boundary.
        Reflect.apply(f.flow.saveSchedulingSettings, f.flow, [invalid]),
      ).resolves.toMatchObject({ ok: false })
    // oxlint-enable no-await-in-loop
    expect(load).not.toHaveBeenCalled()
    expect(repo.schedulingSettings()).toEqual(beforeInvalid)
    expect(repo.schedulingConfigurationGeneration()).toBe(generationBeforeInvalid)
  })

  it('keeps Relay settings and generation unchanged when the coding native executable changes', async () => {
    const f = await fixture()
    vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
      ok: true,
      value: {
        firstUse: false,
        agents: [
          {
            agentId: 'claude',
            executablePath: process.execPath,
            state: 'ready',
            checkedAt: new Date().toISOString(),
          },
          {
            agentId: 'codex',
            executablePath: process.execPath,
            state: 'ready',
            checkedAt: new Date().toISOString(),
          },
          {
            agentId: 'agy',
            executablePath: process.execPath,
            state: 'ready',
            checkedAt: new Date().toISOString(),
          },
        ],
      },
    })
    const load = vi.spyOn(f.catalogs, 'loadModelCatalogs')
    const repo = f.db.conversationRepository
    await f.flow.saveSchedulingSettings({
      expectedRevision: repo.schedulingSettings().revision,
      enabled: true,
    })
    const settings = f.flow.getSchedulingSettings(),
      state = f.flow.getSchedulingState({}),
      generation = repo.schedulingConfigurationGeneration(),
      identity = f.runtime.catalogIdentity(process.cwd())
    const before = await f.runtime.selectExecutable({
      agentId: 'codex',
      executablePath: process.execPath,
    })
    expect(before.ok).toBe(true)
    expect(f.runtime.catalogIdentity(process.cwd())).not.toBe(identity)
    expect(f.flow.getSchedulingSettings()).toEqual(settings)
    expect(f.flow.getSchedulingState({})).toEqual(state)
    expect(repo.schedulingConfigurationGeneration()).toBe(generation)
    expect(load).not.toHaveBeenCalled()
  })
})

describe.skipIf(process.platform === 'win32')(
  'Real zero-input Codex & Antigravity catalog transport, active-pair scoping, and cleanup',
  () => {
    async function protocol(
      options: { total?: number; large?: boolean; hold?: boolean; slowClose?: boolean } = {},
    ) {
      const f = await fixture(),
        path = join(f.directory, 'codex'),
        facts = join(f.directory, 'facts.jsonl'),
        release = join(f.directory, 'release')
      await writeFile(
        path,
        `#!${process.execPath}\nconst fs=require('node:fs');const rl=require('node:readline').createInterface({input:process.stdin});const options=${JSON.stringify(options)};const facts=${JSON.stringify(facts)};const release=${JSON.stringify(release)};function record(value){fs.appendFileSync(facts,JSON.stringify(value)+'\\n')}function send(value){process.stdout.write(JSON.stringify(value)+'\\n')}record({pid:process.pid});process.on('SIGTERM',()=>{record({closing:true});setTimeout(()=>process.exit(0),options.slowClose?200:0)});rl.on('close',()=>{if(!options.slowClose)process.exit(0)});rl.on('line',line=>{const r=JSON.parse(line);record({method:r.method,params:r.params});if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list'){const answer=()=>{const offset=Number(r.params.cursor||0),total=options.total||50;const data=Array.from({length:Math.min(25,total-offset)},(_,i)=>({id:'model-'+(offset+i),displayName:options.large?'x'.repeat(15000):'Model '+(offset+i)}));send({id:r.id,result:{data,nextCursor:offset+25<total?String(offset+25):null}})};if(options.hold){const timer=setInterval(()=>{if(fs.existsSync(release)){clearInterval(timer);answer()}},10)}else answer()}else if(r.method!=='initialized')process.exit(3)});`,
      )
      await chmod(path, 0o755)
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            { agentId: 'claude', state: 'missing', checkedAt: new Date().toISOString() },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: path,
              checkedAt: new Date().toISOString(),
            },
            { agentId: 'agy', state: 'missing', checkedAt: new Date().toISOString() },
          ],
        },
      })
      const read = async (): Promise<
        Array<{
          pid?: number
          method?: string
          params?: { limit?: number; cursor?: string }
          closing?: boolean
        }>
      > => {
        try {
          return (await readFile(facts, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        } catch {
          return []
        }
      }
      return { ...f, path, facts, release, read }
    }

    async function createThreeAgentCatalogFixture(options: { holdCodex?: boolean } = {}) {
      const f = await fixture()
      const repo = f.db.defaultSessionSettingsRepository
      const claudePath = join(f.directory, 'claude-catalog-mock.mjs')
      const codexPath = join(f.directory, 'codex-catalog-mock.mjs')
      const agyPath = join(f.directory, 'agy-catalog-mock.mjs')
      const claudeFacts = join(f.directory, 'claude-facts.jsonl')
      const codexFacts = join(f.directory, 'codex-facts.jsonl')
      const agyFacts = join(f.directory, 'agy-facts.jsonl')
      const codexRelease = join(f.directory, 'codex-release')

      await writeFile(
        claudePath,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const facts = ${JSON.stringify(claudeFacts)}
const record = (entry) => appendFileSync(facts, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
record({ event: 'spawn' })
const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  const msg = JSON.parse(line)
  if (msg.type !== 'control_request') continue
  if (msg.request.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: {
          commands: [],
          agents: [],
          output_style: 'default',
          available_output_styles: ['default'],
          models: [
            { value: 'default', displayName: 'Default' },
            { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', supportedEffortLevels: ['low', 'medium', 'high'], supportsFastMode: true },
          ],
          account: { email: 'user@example.test' },
          hooks_applied: true,
          current_permission_mode: 'dontAsk',
        },
      },
    }) + '\\n')
  }
}
`,
        { mode: 0o755 },
      )
      await chmod(claudePath, 0o755)

      await writeFile(
        codexPath,
        `#!${process.execPath}
import { appendFileSync, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
const facts = ${JSON.stringify(codexFacts)}
const release = ${JSON.stringify(codexRelease)}
const hold = ${JSON.stringify(Boolean(options.holdCodex))}
const record = (entry) => appendFileSync(facts, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
record({ event: 'spawn' })
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req = JSON.parse(line)
  record({ method: req.method })
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: req.id, result: {} }) + '\\n')
  } else if (req.method === 'model/list') {
    const respond = () => {
      process.stdout.write(JSON.stringify({
        id: req.id,
        result: {
          data: [
            {
              id: 'gpt-5.4',
              displayName: 'GPT-5.4',
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
            },
          ],
          nextCursor: null,
        },
      }) + '\\n')
    }
    if (hold) {
      const timer = setInterval(() => {
        if (existsSync(release)) {
          clearInterval(timer)
          respond()
        }
      }, 15)
    } else {
      respond()
    }
  }
})
`,
        { mode: 0o755 },
      )
      await chmod(codexPath, 0o755)

      await writeFile(
        agyPath,
        `#!${process.execPath}
import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const facts = ${JSON.stringify(agyFacts)}
const record = (entry) => appendFileSync(facts, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')
const args = process.argv.slice(2)
const cwdMode = statSync(process.cwd()).mode & 0o777
record({ event: 'spawn', args, cwd: process.cwd(), cwdMode })

const availableModels = [
  { modelId: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { modelId: 'orchestrator', name: 'Orchestrator' },
  { modelId: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { modelId: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
]

function configOptionsForModel(modelId) {
  const base = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: modelId,
      options: availableModels.map((m) => ({ value: m.modelId, name: m.name })),
    },
  ]
  if (modelId === 'gemini-4-carbon') {
    base.push({
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'max', name: 'Max' },
      ],
    })
  } else if (modelId === 'orchestrator') {
    base.push({
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    })
  } else if (modelId === 'claude-opus-5-5') {
    base.push({
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    })
  }
  // gpt-oss-120b intentionally offers NO thought_level metadata to verify native default fallback!
  return base
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  record({ method: msg.method, params: msg.params })
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.11' },
      },
    }) + '\\n')
  } else if (msg.method === 'session/new') {
    const sid = '22222222-2222-4222-8222-222222222222'
    if (process.env.ANTIGRAVITY_GEMINI_DIR) {
      const convDir = join(process.env.ANTIGRAVITY_GEMINI_DIR, 'antigravity-cli', 'conversations')
      mkdirSync(convDir, { recursive: true })
      writeFileSync(join(convDir, sid + '.db'), 'probe-zero-turn')
    }
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: sid,
        models: {
          availableModels,
          currentModelId: 'gemini-4-carbon',
        },
        configOptions: configOptionsForModel('gemini-4-carbon'),
      },
    }) + '\\n')
  } else if (msg.method === 'session/set_config_option') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        configOptions: configOptionsForModel(msg.params.value),
      },
    }) + '\\n')
  } else if (msg.method === 'session/close') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    }) + '\\n')
  }
})
rl.on('close', () => process.exit(0))
`,
        { mode: 0o755 },
      )
      await chmod(agyPath, 0o755)

      return {
        ...f,
        repo,
        claudePath,
        codexPath,
        agyPath,
        claudeFacts,
        codexFacts,
        agyFacts,
        codexRelease,
        readJsonl: readJsonlFacts,
      }
    }

    it.each([
      { total: 200, available: true },
      { total: 225, available: false },
      { total: 25, large: true, available: false },
    ])(
      'keeps 25/page, 200 models/256 KiB and zero thread/turn input for $total/$large',
      async ({ total, large, available }) => {
        const f = await protocol({ total, large: large ?? false }),
          value = await f.catalogs.loadModelCatalogs(),
          facts = await f.read()
        expect(value.codex.status).toBe(available ? 'available' : 'unavailable')
        expect(value.codex.models).toHaveLength(available ? total : 0)
        const requests = facts.filter((fact) => fact.method)
        expect(
          requests.every((fact) =>
            ['initialize', 'initialized', 'model/list'].includes(fact.method!),
          ),
        ).toBe(true)
        expect(
          requests
            .filter((fact) => fact.method === 'model/list')
            .every((fact) => fact.params?.limit === 25),
        ).toBe(true)
        const pid = facts.find((fact) => fact.pid)?.pid
        expect(pid).toBeDefined()
        expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/u)
      },
    )

    it('counts cold PATH preparation inside the original catalog deadline and cleanup reserve', async () => {
      const f = await protocol()
      const readiness = await f.runtime.inspectReadiness()
      let now = Date.now()
      let environmentReady = false
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
      vi.spyOn(f.runtime, 'prepareEnvironment').mockImplementation(async () => {
        now += 2500
        environmentReady = true
      })
      const identity = f.runtime.catalogIdentity.bind(f.runtime)
      vi.spyOn(f.runtime, 'catalogIdentity').mockImplementation((directory, pairKey) => {
        expect(environmentReady).toBe(true)
        return identity(directory, pairKey)
      })
      vi.spyOn(f.runtime, 'inspectReadiness').mockImplementation(async () => {
        // Together with PATH preparation this leaves less than the original 4s cleanup reserve.
        now += 18_500
        return readiness
      })
      try {
        expect(await f.catalogs.loadEditorState()).toMatchObject({ ok: false })
        expect(await f.read()).toEqual([])
      } finally {
        clock.mockRestore()
      }
    })

    it('shares one physical catalog, fences a configuration change and awaits owned process close on disposal', async () => {
      const f = await protocol({ hold: true, slowClose: true })
      const first = f.catalogs.loadEditorState(),
        second = f.catalogs.loadEditorState()
      await expect
        .poll(async () => (await f.read()).filter((fact) => fact.method === 'model/list').length, {
          timeout: 5_000,
        })
        .toBe(1)
      expect((await f.read()).filter((fact) => fact.pid)).toHaveLength(1)
      await f.runtime.selectExecutable({ agentId: 'codex', executablePath: f.path })
      await writeFile(f.release, 'release')
      expect(await first).toMatchObject({ ok: false })
      expect(await second).toMatchObject({ ok: false })
      const next = f.catalogs.loadEditorState()
      await expect
        .poll(async () => (await f.read()).filter((fact) => fact.pid).length, { timeout: 5_000 })
        .toBe(2)
      let done = false
      const disposing = f.catalogs.dispose().then(() => {
        done = true
        return undefined
      })
      expect(done).toBe(false)
      await disposing
      expect(await next).toMatchObject({ ok: false })
      const pids = (await f.read()).flatMap((fact) => (fact.pid === undefined ? [] : [fact.pid]))
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/u)
    })

    it('automatically pre-selects the 2 ready CLIs on first-use setup when only 2 of 3 CLIs are ready, and loads agy full catalog + per-model thought_level without scanning/deleting user DBs', async () => {
      const f = await createThreeAgentCatalogFixture()
      const userConvDir = join(f.isolatedGemini, 'antigravity-cli', 'conversations')
      await mkdir(userConvDir, { recursive: true })
      const userDb = join(userConvDir, 'existing-user-conversation.db')
      await writeFile(userDb, 'important-user-history')

      const checkedAt = new Date().toISOString()
      const agents = [
        { agentId: 'claude' as const, state: 'missing' as const, checkedAt },
        {
          agentId: 'codex' as const,
          state: 'ready' as const,
          executablePath: f.codexPath,
          version: 'codex-cli 0.159.2',
          checkedAt,
        },
        {
          agentId: 'agy' as const,
          state: 'ready' as const,
          executablePath: f.agyPath,
          version: '1.5.9',
          checkedAt,
        },
      ]
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: { firstUse: true, agents },
      })

      // First-use initial pair helper picks ('codex', 'agy'), never hardcoding ('claude', 'codex').
      expect(DefaultSessionSettings.createInitialSettings(agents)).toMatchObject({
        primaryAgentId: 'codex',
        secondaryAgentId: 'agy',
      })

      const result = await f.catalogs.loadEditorState(f.directory)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)

      // Claude was missing and unselected; Codex and Antigravity were automatically selected and loaded!
      expect(result.value.recommendedPair).toEqual({
        primaryAgentId: 'codex',
        secondaryAgentId: 'agy',
      })
      expect(result.value.modelCatalogs.claude.status).toBe('unavailable')
      expect(result.value.modelCatalogs.codex.status).toBe('available')
      expect(result.value.modelCatalogs.agy).toEqual({
        agentId: 'agy',
        status: 'available',
        cliVersion: '1.5.9',
        checkedAt: expect.any(String),
        models: [
          {
            id: 'gemini-4-carbon',
            displayName: 'Gemini 4 Carbon',
            supportedEfforts: ['low', 'medium', 'high', 'max'],
            defaultEffort: 'high',
          },
          {
            id: 'orchestrator',
            displayName: 'Orchestrator',
            supportedEfforts: ['medium', 'high', 'xhigh'],
            defaultEffort: 'medium',
          },
          {
            id: 'claude-opus-5-5',
            displayName: 'Claude Opus 5.5',
            supportedEfforts: ['low', 'high'],
            defaultEffort: 'high',
          },
          {
            id: 'gpt-oss-120b',
            displayName: 'GPT-OSS 120B',
            supportedEfforts: [],
          },
        ],
      })

      const agyFacts = await f.readJsonl(f.agyFacts)
      const spawnFact = agyFacts.find((fact) => fact.event === 'spawn')
      expect(spawnFact?.args).toEqual(['acp', '--disable-telemetry'])
      expect(spawnFact?.cwdMode).toBe(0o700)
      expect(await exists(spawnFact!.cwd!)).toBe(false)

      const initFact = agyFacts.find((fact) => fact.method === 'initialize')
      expect(initFact?.params).toMatchObject({
        protocolVersion: 1,
        clientInfo: { name: 'pact', version: desktopPackage.version },
      })

      const closeFact = agyFacts.find((fact) => fact.method === 'session/close')
      expect(closeFact?.params).toEqual({ sessionId: '22222222-2222-4222-8222-222222222222' })
      expect(agyFacts.some((fact) => fact.method === 'session/prompt')).toBe(false)
      expect(() => process.kill(spawnFact!.pid, 0)).toThrow(/ESRCH/u)

      // Zero scanning or deleting of user conversation DBs.
      expect(await readFile(userDb, 'utf8')).toBe('important-user-history')
      expect(await exists(join(userConvDir, '22222222-2222-4222-8222-222222222222.db'))).toBe(true)
      expect(await f.readJsonl(f.claudeFacts)).toEqual([])
    })

    it('loads catalogs only for the active pair, cancels in-flight probes when pair changes, and preserves saved settings of the unselected 3rd Agent', async () => {
      const f = await createThreeAgentCatalogFixture({ holdCodex: true })
      const checkedAt = new Date().toISOString()
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            {
              agentId: 'claude',
              state: 'ready',
              executablePath: f.claudePath,
              version: '2.1.272',
              checkedAt,
            },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: f.codexPath,
              version: '0.159.2',
              checkedAt,
            },
            {
              agentId: 'agy',
              state: 'ready',
              executablePath: f.agyPath,
              version: '1.5.9',
              checkedAt,
            },
          ],
        },
      })

      // 1. Start loading ('claude', 'codex') — codex is held in model/list, agy is NOT spawned.
      const pendingClaudeCodex = f.catalogs.loadEditorState(f.directory, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      })
      await expect
        .poll(
          async () => (await f.readJsonl(f.codexFacts)).some((e) => e.method === 'model/list'),
          {
            timeout: 5_000,
          },
        )
        .toBe(true)
      expect(await f.readJsonl(f.agyFacts)).toEqual([])
      const heldCodexPid = (await f.readJsonl(f.codexFacts)).find((e) => e.event === 'spawn')?.pid
      expect(heldCodexPid).toBeDefined()

      // 2. Switch active pair to ('claude', 'agy') — cancels held codex probe and loads claude + agy!
      const switchedResult = await f.catalogs.loadEditorState(f.directory, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      })
      expect(await pendingClaudeCodex).toMatchObject({ ok: false })
      expect(() => process.kill(heldCodexPid!, 0)).toThrow(/ESRCH/u)
      expect(switchedResult).toMatchObject({
        ok: true,
        value: {
          modelCatalogs: {
            claude: { status: 'available' },
            codex: { status: 'unavailable' },
            agy: { status: 'available' },
          },
        },
      })

      // 3. Seed saved settings including a concrete Codex model, then save ('claude', 'agy') with
      // codex unselected (even if codex later becomes missing) and verify Codex's saved settings survive!
      f.repo.save({
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
        agents: {
          claude: { model: 'claude-sonnet-4-6', effort: 'high', speed: 'native' },
          codex: { model: 'gpt-5.4', effort: 'medium', speed: 'fast' },
          agy: { model: null, effort: null, speed: 'native' },
        },
        maxDiscussionRounds: 6,
        maxReviewCycles: 3,
        maxRepairAttempts: 3,
      })

      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            {
              agentId: 'claude',
              state: 'ready',
              executablePath: f.claudePath,
              version: '2.1.272',
              checkedAt,
            },
            {
              agentId: 'codex',
              state: 'authentication_required',
              executablePath: f.codexPath,
              version: '0.159.2',
              checkedAt,
            },
            {
              agentId: 'agy',
              state: 'ready',
              executablePath: f.agyPath,
              version: '1.5.9',
              checkedAt,
            },
          ],
        },
      })

      const saveResult = await f.catalogs.saveDefaults({
        settings: {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
          agents: {
            claude: { model: 'claude-sonnet-4-6', effort: 'low', speed: 'native' },
            codex: { model: null, effort: null, speed: 'native' },
            agy: { model: 'gemini-4-carbon', effort: 'max', speed: 'native' },
          },
          maxDiscussionRounds: 8,
          maxReviewCycles: 4,
          maxRepairAttempts: 2,
        },
      })

      expect(saveResult).toMatchObject({
        ok: true,
        value: {
          settings: {
            primaryAgentId: 'claude',
            secondaryAgentId: 'agy',
            agents: {
              claude: { model: 'claude-sonnet-4-6', effort: 'low', speed: 'native' },
              codex: { model: 'gpt-5.4', effort: 'medium', speed: 'fast' },
              agy: { model: 'gemini-4-carbon', effort: 'max', speed: 'native' },
            },
            maxDiscussionRounds: 8,
            maxReviewCycles: 4,
            maxRepairAttempts: 2,
          },
        },
      })

      // Invalid effort for GPT-OSS 120B (which offers no thought_level metadata) is rejected,
      // while native default (effort: null) is accepted!
      expect(
        await f.catalogs.validateSettings(
          {
            primaryAgentId: 'claude',
            secondaryAgentId: 'agy',
            agents: {
              claude: { model: 'claude-sonnet-4-6', effort: 'low' },
              codex: { model: 'gpt-5.4', effort: 'medium' },
              agy: { model: 'gpt-oss-120b', effort: 'high' },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
          f.directory,
        ),
      ).toMatchObject({
        ok: false,
        error: { code: 'VALIDATION', message: 'Antigravity effort is unavailable for this model.' },
      })

      expect(
        await f.catalogs.validateSettings(
          {
            primaryAgentId: 'claude',
            secondaryAgentId: 'agy',
            agents: {
              claude: { model: 'claude-sonnet-4-6', effort: 'low' },
              codex: { model: 'gpt-5.4', effort: 'medium' },
              agy: { model: 'gpt-oss-120b', effort: null },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
          f.directory,
        ),
      ).toMatchObject({ ok: true })
    })

    it('deduplicates real agy 1.5.11 pre-expanded <family>-<effort> availableModels via configOptions.model.options and falls back to session/set_model for standalone entries', async () => {
      const f = await fixture()
      const codexPath = join(f.directory, 'codex-real-agy-test.mjs')
      const agyPath = join(f.directory, 'agy-1-5-11-real-catalog.mjs')
      const agyFacts = join(f.directory, 'agy-1-5-11-facts.jsonl')

      await writeFile(
        codexPath,
        `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
  } else if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }], nextCursor: null },
    }) + '\\n')
  }
})
`,
        { mode: 0o755 },
      )
      await chmod(codexPath, 0o755)

      await writeFile(
        agyPath,
        `#!${process.execPath}
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const facts = ${JSON.stringify(agyFacts)}
const record = (entry) => appendFileSync(facts, JSON.stringify({ pid: process.pid, ...entry }) + '\\n')

const selectableModels = [
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
  { value: 'gemini-4-argon', name: 'Gemini 4 Argon' },
  { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
  { value: 'orchestrator', name: 'Orchestrator' },
  { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
  { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
]

// 22 pre-expanded <family>-<effort> entries matching real agy 1.5.11 + 1 standalone availableModels-only entry.
const availableModels = [
  { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
  { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
  { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
  { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
  { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
  { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
  { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
  { modelId: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
  { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
  { modelId: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
  { modelId: 'gemini-4-hydrogen-low', name: 'Gemini 4 Hydrogen (Low)' },
  { modelId: 'gemini-4-hydrogen-medium', name: 'Gemini 4 Hydrogen (Medium)' },
  { modelId: 'gemini-4-hydrogen-high', name: 'Gemini 4 Hydrogen (High)' },
  { modelId: 'orchestrator-medium', name: 'Orchestrator (Medium)' },
  { modelId: 'orchestrator-high', name: 'Orchestrator (High)' },
  { modelId: 'gemini-3.8-flash-low', name: 'Gemini 3.8 Flash (Low)' },
  { modelId: 'gemini-3.8-flash-medium', name: 'Gemini 3.8 Flash (Medium)' },
  { modelId: 'gemini-3.8-flash-high', name: 'Gemini 3.8 Flash (High)' },
  { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
  { modelId: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 (High)' },
  { modelId: 'claude-sonnet-5-5-high', name: 'Claude Sonnet 5.5 (High)' },
  { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  { modelId: 'agy-standalone-preview', name: 'Antigravity Standalone Preview' },
]

const effortsBySelectableModel = {
  'gemini-4-carbon': { currentValue: 'high', values: ['low', 'medium', 'high'] },
  'gemini-4-neon': { currentValue: 'high', values: ['low', 'medium', 'high', 'xhigh'] },
  'gemini-4-argon': { currentValue: 'medium', values: ['low', 'medium', 'high'] },
  'gemini-4-hydrogen': { currentValue: 'medium', values: ['low', 'medium', 'high'] },
  'orchestrator': { currentValue: 'high', values: ['medium', 'high'] },
  'gemini-3.8-flash': { currentValue: 'low', values: ['low', 'medium', 'high'] },
  'claude-opus-5-5': { currentValue: 'high', values: ['low', 'high'] },
  'claude-sonnet-5-5': { currentValue: 'high', values: ['high'] },
}

function buildConfigOptions(selectedModel) {
  const opts = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: selectedModel,
      options: selectableModels,
    },
  ]
  const effort = effortsBySelectableModel[selectedModel]
  if (effort) {
    opts.push({
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: effort.currentValue,
      options: effort.values.map((v) => ({ value: v, name: v.toUpperCase() })),
    })
  }
  return opts
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  record({ method: msg.method, params: msg.params })
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.11' } },
    }) + '\\n')
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: '33333333-3333-4333-8333-333333333333',
        models: { availableModels, currentModelId: 'gemini-4-carbon-high' },
        configOptions: buildConfigOptions('gemini-4-carbon'),
      },
    }) + '\\n')
  } else if (msg.method === 'session/set_config_option') {
    const val = msg.params.value
    if (!selectableModels.some((m) => m.value === val)) {
      // Real agy 1.5.11 rejects pre-expanded <family>-<effort> IDs and unknown values with -32602 (NOT -32601)!
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Invalid config option value: ' + val },
      }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { configOptions: buildConfigOptions(val) },
      }) + '\\n')
    }
  } else if (msg.method === 'session/set_model') {
    if (msg.params.modelId === 'agy-standalone-preview') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            ...buildConfigOptions('gemini-4-carbon'),
            {
              id: 'thought_level',
              name: 'Effort',
              category: 'thought_level',
              type: 'select',
              currentValue: 'medium',
              options: [{ value: 'low', name: 'LOW' }, { value: 'medium', name: 'MEDIUM' }],
            },
          ].filter((opt, idx, arr) => arr.findLastIndex((x) => x.id === opt.id) === idx),
        },
      }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'Unknown model' },
      }) + '\\n')
    }
  } else if (msg.method === 'session/close') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
  }
})
rl.on('close', () => process.exit(0))
`,
        { mode: 0o755 },
      )
      await chmod(agyPath, 0o755)

      const checkedAt = new Date().toISOString()
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: true,
          agents: [
            { agentId: 'claude', state: 'missing', checkedAt },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: codexPath,
              version: '0.159.2',
              checkedAt,
            },
            {
              agentId: 'agy',
              state: 'ready',
              executablePath: agyPath,
              version: '1.5.9',
              agentInfoVersion: '1.5.11',
              checkedAt,
            },
          ],
        },
      })

      const result = await f.catalogs.loadEditorState(f.directory)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.error.message)

      expect(result.value.modelCatalogs.agy).toMatchObject({
        agentId: 'agy',
        status: 'available',
        cliVersion: '1.5.9',
        checkedAt: expect.any(String),
      })
      // Passes through ALL selectable family models AND ALL real availableModels entries unchanged!
      expect(result.value.modelCatalogs.agy.models.slice(0, 9)).toEqual([
        {
          id: 'gemini-4-carbon',
          displayName: 'Gemini 4 Carbon',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'high',
        },
        {
          id: 'gemini-4-neon',
          displayName: 'Gemini 4 Neon',
          supportedEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'high',
        },
        {
          id: 'gemini-4-argon',
          displayName: 'Gemini 4 Argon',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        {
          id: 'gemini-4-hydrogen',
          displayName: 'Gemini 4 Hydrogen',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'medium',
        },
        {
          id: 'orchestrator',
          displayName: 'Orchestrator',
          supportedEfforts: ['medium', 'high'],
          defaultEffort: 'high',
        },
        {
          id: 'gemini-3.8-flash',
          displayName: 'Gemini 3.8 Flash',
          supportedEfforts: ['low', 'medium', 'high'],
          defaultEffort: 'low',
        },
        {
          id: 'claude-opus-5-5',
          displayName: 'Claude Opus 5.5',
          supportedEfforts: ['low', 'high'],
          defaultEffort: 'high',
        },
        {
          id: 'claude-sonnet-5-5',
          displayName: 'Claude Sonnet 5.5',
          supportedEfforts: ['high'],
          defaultEffort: 'high',
        },
        {
          id: 'gpt-oss-120b-medium',
          displayName: 'GPT-OSS 120B (Medium)',
          supportedEfforts: [],
        },
      ])
      expect(result.value.modelCatalogs.agy.models).toContainEqual({
        id: 'gemini-4-carbon-high',
        displayName: 'Gemini 4 Carbon (High)',
        supportedEfforts: [],
      })
      expect(result.value.modelCatalogs.agy.models.at(-1)).toEqual({
        id: 'agy-standalone-preview',
        displayName: 'Antigravity Standalone Preview',
        supportedEfforts: ['low', 'medium'],
        defaultEffort: 'medium',
      })
      expect(result.value.modelCatalogs.agy.models).toHaveLength(31)

      const facts = await readJsonlFacts(agyFacts)
      const setConfigValues = facts
        .filter((fact) => fact.method === 'session/set_config_option')
        .map((fact) => fact.params?.value)
      // Initial currentValue ('gemini-4-carbon') reused initialConfigOptions with 0 RPCs, and ZERO
      // pre-expanded <family>-<effort> IDs ('gemini-4-carbon-low', '-medium', '-high', etc.) were probed!
      expect(setConfigValues).toEqual([
        'gemini-4-neon',
        'gemini-4-argon',
        'gemini-4-hydrogen',
        'orchestrator',
        'gemini-3.8-flash',
        'claude-opus-5-5',
        'claude-sonnet-5-5',
        'gpt-oss-120b-medium',
      ])
      const setModelIds = facts
        .filter((fact) => fact.method === 'session/set_model')
        .map((fact) => fact.params?.modelId)
      expect(setModelIds).toEqual(['agy-standalone-preview'])
    })

    it('computes coveredVariantIds strictly from each option own supportedEfforts and validates both (familyId, effort) and exact availableModels IDs', async () => {
      const f = await fixture()
      const codexPath = join(f.directory, 'codex-exact-variant-test.mjs')
      const agyPath = join(f.directory, 'agy-exact-variant-test.mjs')

      await writeFile(
        codexPath,
        `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
  } else if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }], nextCursor: null },
    }) + '\\n')
  }
})
`,
        { mode: 0o755 },
      )
      await chmod(codexPath, 0o755)

      // gemini-4-carbon only supports low/medium/high in selectable configOptions, while gemini-4-neon supports xhigh.
      // availableModels ALSO exposes standalone gemini-4-carbon-xhigh, which must NOT be masked by neon's xhigh!
      await writeFile(
        agyPath,
        `#!${process.execPath}
import { createInterface } from 'node:readline'
const selectableModels = [
  { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
  { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
]
const availableModels = [
  { modelId: 'gemini-4-carbon-low', name: 'Gemini 4 Carbon (Low)' },
  { modelId: 'gemini-4-carbon-medium', name: 'Gemini 4 Carbon (Medium)' },
  { modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' },
  { modelId: 'gemini-4-carbon-xhigh', name: 'Gemini 4 Carbon (XHigh Experimental)' },
  // Intentionally omit 'gemini-4-neon-high' so we prove unlisted family-effort strings are NEVER synthesized!
  { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
]
const efforts = {
  'gemini-4-carbon': { currentValue: 'high', values: ['low', 'medium', 'high'] },
  'gemini-4-neon': { currentValue: 'high', values: ['high', 'xhigh'] },
}
function configOptionsFor(selected) {
  const e = efforts[selected]
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selected, options: selectableModels },
    ...(e ? [{
      id: 'thought_level',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: e.currentValue,
      options: e.values.map((v) => ({ value: v, name: v.toUpperCase() })),
    }] : []),
  ]
}
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n')
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: '44444444-4444-4444-8444-444444444444',
        models: { availableModels, currentModelId: 'gemini-4-carbon-high' },
        configOptions: configOptionsFor('gemini-4-carbon'),
      },
    }) + '\\n')
  } else if (msg.method === 'session/set_config_option') {
    const val = msg.params.value
    if (!efforts[val]) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Invalid' } }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { configOptions: configOptionsFor(val) } }) + '\\n')
    }
  } else if (msg.method === 'session/set_model') {
    if (msg.params.modelId === 'gemini-4-carbon-xhigh') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'gemini-4-carbon', options: selectableModels }] },
      }) + '\\n')
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown' } }) + '\\n')
    }
  } else if (msg.method === 'session/close') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
  }
})
rl.on('close', () => process.exit(0))
`,
        { mode: 0o755 },
      )
      await chmod(agyPath, 0o755)

      const checkedAt = new Date().toISOString()
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            { agentId: 'claude', state: 'missing', checkedAt },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: codexPath,
              version: '0.159.2',
              checkedAt,
            },
            {
              agentId: 'agy',
              state: 'ready',
              executablePath: agyPath,
              version: '1.5.9',
              checkedAt,
            },
          ],
        },
      })

      const loaded = await f.catalogs.loadEditorState(f.directory, {
        primaryAgentId: 'codex',
        secondaryAgentId: 'agy',
      })
      expect(loaded.ok).toBe(true)
      if (!loaded.ok) throw new Error(loaded.error.message)
      // Passes through ALL real selectableModels + availableModels entries without hiding entries via coveredVariantIds!
      expect(loaded.value.modelCatalogs.agy?.models.map((m) => m.id)).toEqual([
        'gemini-4-carbon',
        'gemini-4-neon',
        'gemini-4-carbon-low',
        'gemini-4-carbon-medium',
        'gemini-4-carbon-high',
        'gemini-4-carbon-xhigh',
        'gemini-4-neon-xhigh',
      ])

      // 1. (familyId, supportedEffort) passes
      expect(
        await f.catalogs.validateSettings(
          buildAgyCatalogSettings('gemini-4-carbon', 'high'),
          f.directory,
        ),
      ).toMatchObject({ ok: true })
      // 2. Exact CLI-returned availableModels IDs pass
      expect(
        await f.catalogs.validateSettings(
          buildAgyCatalogSettings('gemini-4-carbon-high', null),
          f.directory,
        ),
      ).toMatchObject({ ok: true })
      expect(
        await f.catalogs.validateSettings(
          buildAgyCatalogSettings('gemini-4-carbon-xhigh', null),
          f.directory,
        ),
      ).toMatchObject({ ok: true })
      // 3. Unlisted synthesized family-effort string ('gemini-4-neon-high', NOT returned in availableModels) MUST be rejected!
      expect(
        await f.catalogs.validateSettings(
          buildAgyCatalogSettings('gemini-4-neon-high', null),
          f.directory,
        ),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
      // 4. Unsupported pre-expanded ID rejected
      expect(
        await f.catalogs.validateSettings(
          buildAgyCatalogSettings('gemini-4-neon-low', null),
          f.directory,
        ),
      ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } })
    })

    it('aborts an in-flight activePair catalog probe immediately when switching back to a cached pair', async () => {
      const f = await fixture()
      const claudePath = join(f.directory, 'claude-abort-cache.mjs')
      const codexPath = join(f.directory, 'codex-abort-cache.mjs')
      const agyPath = join(f.directory, 'agy-hanging-probe.mjs')
      const agyPidFile = join(f.directory, 'agy-hanging.pid')

      await writeFile(
        claudePath,
        `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: { models: [{ value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' }] },
      },
    }) + '\\n')
  }
})
`,
        { mode: 0o755 },
      )
      await chmod(claudePath, 0o755)

      await writeFile(
        codexPath,
        `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
  } else if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }], nextCursor: null },
    }) + '\\n')
  }
})
`,
        { mode: 0o755 },
      )
      await chmod(codexPath, 0o755)

      await writeFile(
        agyPath,
        `#!${process.execPath}
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    writeFileSync(${JSON.stringify(agyPidFile)}, String(process.pid), 'utf8')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n')
  }
  // Intentionally stall on session/new until aborted!
})
setInterval(() => {}, 1000)
`,
        { mode: 0o755 },
      )
      await chmod(agyPath, 0o755)

      const checkedAt = new Date().toISOString()
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            {
              agentId: 'claude',
              state: 'ready',
              executablePath: claudePath,
              version: '2.1.0',
              checkedAt,
            },
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: codexPath,
              version: '0.159.2',
              checkedAt,
            },
            {
              agentId: 'agy',
              state: 'ready',
              executablePath: agyPath,
              version: '1.5.9',
              checkedAt,
            },
          ],
        },
      })

      // 1. Prime cache for (claude, codex)
      const initial = await f.catalogs.loadSessionEditorState('session-1', f.directory, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      })
      expect(initial.ok).toBe(true)

      // 2. Start slow/stalled (claude, agy) catalog probe in the same session scope
      const pendingAgy = f.catalogs.loadSessionEditorState('session-1', f.directory, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'agy',
      })
      await vi.waitFor(async () => {
        const raw = await readFile(agyPidFile, 'utf8')
        expect(Number(raw.trim())).toBeGreaterThan(0)
      })
      const agyPid = Number((await readFile(agyPidFile, 'utf8')).trim())

      // 3. Switch back to (claude, codex) — hits completedCatalogs cache AND must abort the in-flight agy probe!
      const cachedReturn = await f.catalogs.loadSessionEditorState('session-1', f.directory, {
        primaryAgentId: 'claude',
        secondaryAgentId: 'codex',
      })
      expect(cachedReturn.ok).toBe(true)
      expect(await pendingAgy).toMatchObject({ ok: false })

      await vi.waitFor(() => {
        expect(() => process.kill(agyPid, 0)).toThrow(/ESRCH/u)
      })
    })

    it(
      'invalidates auto catalog cache on saveDefaults and ref-counts shared in-flight catalogReads across sibling Session scopes',
      { timeout: 15_000 },
      async () => {
        const f = await fixture()
        const claudePath = join(f.directory, 'claude-refcount.mjs')
        const codexPath = join(f.directory, 'codex-refcount.mjs')
        const agyPath = join(f.directory, 'agy-refcount.mjs')
        const agyGateFile = join(f.directory, 'agy-gate-open')
        const agyStartedFile = join(f.directory, 'agy-started')

        await writeFile(
          claudePath,
          `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_request' && msg.request?.subtype === 'initialize') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response: { models: [{ value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' }] },
      },
    }) + '\\n')
  }
})
`,
          { mode: 0o755 },
        )
        await chmod(claudePath, 0o755)

        await writeFile(
          codexPath,
          `#!${process.execPath}
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\\n')
  } else if (msg.method === 'model/list') {
    process.stdout.write(JSON.stringify({
      id: msg.id,
      result: { data: [{ id: 'gpt-5.4', displayName: 'GPT-5.4' }], nextCursor: null },
    }) + '\\n')
  }
})
`,
          { mode: 0o755 },
        )
        await chmod(codexPath, 0o755)

        await writeFile(
          agyPath,
          `#!${process.execPath}
import { existsSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.method === 'initialize') {
    writeFileSync(${JSON.stringify(agyStartedFile)}, String(process.pid), 'utf8')
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } }) + '\\n')
  } else if (msg.method === 'session/new') {
    const reply = () => {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: '77777777-7777-4777-8777-777777777777',
          models: { availableModels: [{ modelId: 'gemini-4-carbon-high', name: 'Gemini 4 Carbon (High)' }] },
          configOptions: [],
        },
      }) + '\\n')
    }
    if (existsSync(${JSON.stringify(agyGateFile)})) {
      reply()
    } else {
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(agyGateFile)})) {
          clearInterval(timer)
          reply()
        }
      }, 25)
    }
  } else if (msg.method === 'session/close') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\\n')
  } else if (msg.id !== undefined) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\\n')
  }
})
rl.on('close', () => process.exit(0))
`,
          { mode: 0o755 },
        )
        await chmod(agyPath, 0o755)

        const checkedAt = new Date().toISOString()
        vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
          ok: true,
          value: {
            firstUse: false,
            agents: [
              {
                agentId: 'claude',
                state: 'ready',
                executablePath: claudePath,
                version: '2.1.0',
                checkedAt,
              },
              {
                agentId: 'codex',
                state: 'ready',
                executablePath: codexPath,
                version: '0.159.2',
                checkedAt,
              },
              {
                agentId: 'agy',
                state: 'ready',
                executablePath: agyPath,
                version: '1.5.9',
                checkedAt,
              },
            ],
          },
        })

        // Part 1: Subscriber ref-counting — both session-A and session-B subscribe to (claude, agy).
        // When session-A switches to (claude, codex), session-B's shared (claude, agy) probe MUST stay alive and succeed!
        const sessionALoad = f.catalogs.loadSessionEditorState('session-A', f.directory, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
        await vi.waitFor(async () => {
          expect(Number((await readFile(agyStartedFile, 'utf8')).trim())).toBeGreaterThan(0)
        })
        const sessionBLoad = f.catalogs.loadSessionEditorState('session-B', f.directory, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'agy',
        })
        await new Promise((r) => setTimeout(r, 40))

        // Session A switches away to (claude, codex):
        const sessionASwitched = await f.catalogs.loadSessionEditorState('session-A', f.directory, {
          primaryAgentId: 'claude',
          secondaryAgentId: 'codex',
        })
        expect(sessionASwitched.ok).toBe(true)
        expect(await sessionALoad).toMatchObject({ ok: false })

        // Release agy gate -> Session B's shared (claude, agy) load completes undisturbed!
        await writeFile(agyGateFile, 'open', 'utf8')
        const sessionBResult = await sessionBLoad
        expect(sessionBResult).toMatchObject({
          ok: true,
          value: {
            recommendedPair: { primaryAgentId: 'claude', secondaryAgentId: 'agy' },
            modelCatalogs: {
              agy: {
                status: 'available',
                models: [{ id: 'gemini-4-carbon-high' }],
              },
            },
          },
        })

        // Part 2: Auto cache invalidation on saveDefaults — prime auto load with initial (claude, codex),
        // then saveDefaults to (claude, agy) and verify reopening loadEditorState(cwd) serves (claude, agy)!
        const autoInitial = await f.catalogs.loadEditorState(f.directory)
        expect(autoInitial).toMatchObject({
          ok: true,
          value: {
            recommendedPair: { primaryAgentId: 'claude', secondaryAgentId: 'codex' },
            modelCatalogs: {
              claude: { status: 'available' },
              codex: { status: 'available' },
              agy: { status: 'unavailable' },
            },
          },
        })

        const savedNewDefaults = await f.catalogs.saveDefaults({
          settings: {
            primaryAgentId: 'claude',
            secondaryAgentId: 'agy',
            agents: {
              claude: { model: 'claude-sonnet-4-6', effort: null },
              codex: { model: null, effort: null },
              agy: { model: 'gemini-4-carbon-high', effort: null },
            },
            maxDiscussionRounds: 6,
            maxReviewCycles: 3,
            maxRepairAttempts: 3,
          },
        })
        expect(savedNewDefaults.ok).toBe(true)

        const autoReopened = await f.catalogs.loadEditorState(f.directory)
        expect(autoReopened).toMatchObject({
          ok: true,
          value: {
            recommendedPair: { primaryAgentId: 'claude', secondaryAgentId: 'agy' },
            modelCatalogs: {
              claude: { status: 'available' },
              codex: { status: 'unavailable' },
              agy: { status: 'available', models: [{ id: 'gemini-4-carbon-high' }] },
            },
          },
        })
      },
    )
  },
)
