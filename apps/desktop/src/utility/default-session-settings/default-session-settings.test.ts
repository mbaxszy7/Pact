import { sql } from 'drizzle-orm'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENAI_DECISION_MODEL } from '@pact/contracts'
import { PactDatabase } from '@pact/persistence'

import { Conversation } from '../conversation/conversation.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
import { runDirectoryWorker } from '../workspace-changes/directory-worker.test-support.js'
import { DefaultSessionSettings } from './default-session-settings.js'

const owners: Array<{
  db: PactDatabase
  catalogs: DefaultSessionSettings
  flow: Conversation
  directory: string
}> = []
afterEach(async () => {
  // oxlint-disable no-await-in-loop -- Each owner closes physical work before its database and files.
  for (const owner of owners.splice(0)) {
    await owner.flow.dispose()
    await owner.catalogs.dispose()
    owner.db.close()
    await rm(owner.directory, { recursive: true, force: true })
  }
  // oxlint-enable no-await-in-loop
  vi.restoreAllMocks()
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'pact-relay-catalog-'))
  const db = await PactDatabase.open({
    filePath: ':memory:',
    migrationsFolder: resolve(import.meta.dirname, '../../../../../packages/persistence/drizzle'),
  })
  const runtime = new RuntimePreparation(db.runtimePreparationRepository)
  const catalogs = new DefaultSessionSettings(runtime, db.defaultSessionSettingsRepository)
  const flow = new Conversation(
    db.conversationRepository,
    db.sessionRepository,
    db.projectCatalogRepository,
    runtime,
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository, runDirectoryWorker),
  )
  owners.push({ db, catalogs, flow, directory })
  return { db, runtime, catalogs, flow, directory }
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
            agentId: 'codex',
            executablePath: process.execPath,
            state: 'ready',
            checkedAt: new Date().toISOString(),
          },
          {
            agentId: 'claude',
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
  'Real zero-input Codex catalog transport and process cleanup',
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
            {
              agentId: 'codex',
              state: 'ready',
              executablePath: path,
              checkedAt: new Date().toISOString(),
            },
            { agentId: 'claude', state: 'missing', checkedAt: new Date().toISOString() },
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

    it('shares one physical catalog, fences a configuration change and awaits owned process close on disposal', async () => {
      const f = await protocol({ hold: true, slowClose: true })
      const first = f.catalogs.loadEditorState(),
        second = f.catalogs.loadEditorState()
      await expect
        .poll(async () => (await f.read()).filter((fact) => fact.method === 'model/list').length)
        .toBe(1)
      expect((await f.read()).filter((fact) => fact.pid)).toHaveLength(1)
      await f.runtime.selectExecutable({ agentId: 'codex', executablePath: f.path })
      await writeFile(f.release, 'release')
      expect(await first).toMatchObject({ ok: false })
      expect(await second).toMatchObject({ ok: false })
      const next = f.catalogs.loadEditorState()
      await expect.poll(async () => (await f.read()).filter((fact) => fact.pid).length).toBe(2)
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
  },
)
