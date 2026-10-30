import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentModelCatalog, SchedulingModelSelection } from '@pact/contracts'

import { PactDatabase } from '@pact/persistence'

import { Conversation } from '../conversation/conversation.js'
import { ProjectFileReader } from '../project-file/project-file-reader.js'
import { RuntimePreparation } from '../runtime-preparation/runtime-preparation.js'
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
    new ProjectFileReader(db.sessionRepository, db.projectCatalogRepository),
    undefined,
    undefined,
    undefined,
    catalogs,
  )
  owners.push({ db, catalogs, flow, directory })
  return { db, runtime, catalogs, flow, directory }
}
const catalog = (agentId: 'codex' | 'claude', ids: string[]): AgentModelCatalog => ({
  agentId,
  status: 'available',
  checkedAt: new Date().toISOString(),
  models: ids.map((id) => ({ id, displayName: id, supportedEfforts: [] })),
})
const luna: SchedulingModelSelection = {
  target: 'codex_luna',
  provider: 'codex',
  modelId: 'gpt-6-luna',
}

describe('Relay through the existing Conversation and catalog owners', () => {
  it('saves global intent without probing runtimes or starting any Turn and distinguishes exact native model identities', async () => {
    const f = await fixture(),
      load = vi.spyOn(f.catalogs, 'loadModelCatalogs').mockResolvedValue({
        codex: catalog('codex', ['gpt-6-luna']),
        claude: {
          ...catalog('claude', ['haiku']),
          models: [
            {
              id: 'haiku',
              resolvedModel: 'deepseek-flash',
              displayName: 'Haiku',
              supportedEfforts: [],
            },
          ],
        },
      })
    const readiness = vi.spyOn(f.runtime, 'inspectReadiness')
    expect(
      await f.flow.saveSchedulingSettings({ expectedRevision: 0, enabled: true }),
    ).toMatchObject({ ok: true, value: { enabled: true, selection: null } })
    expect(load).not.toHaveBeenCalled()
    expect(readiness).not.toHaveBeenCalled()
    const available = await f.flow.refreshSchedulingModels()
    expect(available).toMatchObject({
      ok: true,
      value: {
        models: [
          { target: 'codex_luna', status: 'found', selection: luna },
          { target: 'claude_haiku_5_5', status: 'not_found', selection: null },
        ],
      },
    })
    expect(f.db.conversationRepository.readSchedulingActivity({}).rows).toEqual([])
  })

  it('retains an explicitly saved dated Haiku ID while both exact versions remain listed', async () => {
    const f = await fixture(),
      a = 'claude-haiku-5-5-20261001',
      b = 'claude-haiku-5-5-20261015'
    const load = vi.spyOn(f.catalogs, 'loadModelCatalogs').mockResolvedValue({
      codex: catalog('codex', ['gpt-6-luna']),
      claude: catalog('claude', [a, b]),
    })
    const selection: SchedulingModelSelection = {
      target: 'claude_haiku_5_5',
      provider: 'claude',
      modelId: b,
    }
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: 0,
        selection,
        catalogIdentity: f.runtime.catalogIdentity(process.cwd()),
      }),
    ).toMatchObject({ ok: true, value: { selection } })
    expect(await f.flow.refreshSchedulingModels()).toMatchObject({
      ok: true,
      value: { models: [{}, { status: 'found', selection }] },
    })
    load.mockResolvedValue({
      codex: catalog('codex', ['gpt-6-luna']),
      claude: catalog('claude', [a]),
    })
    await f.flow.refreshSchedulingModels()
    expect(f.flow.getSchedulingSettings()).toMatchObject({ ok: true, value: { selection } })
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: 1,
        selection,
        catalogIdentity: f.runtime.catalogIdentity(process.cwd()),
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } })
    expect(f.flow.getSchedulingSettings()).toMatchObject({
      ok: true,
      value: { selection, revision: 1 },
    })
  })

  it.each(['refresh', 'save'] as const)(
    'rejects %s completion after selected executable/configuration generation changes',
    async (operation) => {
      const f = await fixture(),
        pending = Promise.withResolvers<{ codex: AgentModelCatalog; claude: AgentModelCatalog }>()
      vi.spyOn(f.catalogs, 'loadModelCatalogs').mockReturnValue(pending.promise)
      vi.spyOn(f.runtime, 'inspectReadiness').mockResolvedValue({
        ok: true,
        value: {
          firstUse: false,
          agents: [
            { agentId: 'claude', state: 'missing', checkedAt: new Date().toISOString() },
            { agentId: 'codex', state: 'missing', checkedAt: new Date().toISOString() },
          ],
        },
      })
      const identity = f.runtime.catalogIdentity(process.cwd())
      const request =
        operation === 'refresh'
          ? f.flow.refreshSchedulingModels()
          : f.flow.saveSchedulingSettings({
              expectedRevision: 0,
              selection: luna,
              catalogIdentity: identity,
            })
      await f.runtime.selectExecutable({ agentId: 'codex', executablePath: process.execPath })
      expect(f.runtime.catalogIdentity(process.cwd())).not.toBe(identity)
      expect(f.runtime.catalogIdentity(f.directory)).not.toBe(
        f.runtime.catalogIdentity(process.cwd()),
      )
      pending.resolve({ codex: catalog('codex', ['gpt-6-luna']), claude: catalog('claude', []) })
      expect(await request).toMatchObject({ ok: false })
      expect(f.flow.getSchedulingSettings()).toMatchObject({
        ok: true,
        value: { selection: null, revision: 0 },
      })
    },
  )

  it('rejects a stale selection before discovery and revalidates model availability at the real catalog interface', async () => {
    const f = await fixture(),
      load = vi
        .spyOn(f.catalogs, 'loadModelCatalogs')
        .mockResolvedValue({ codex: catalog('codex', []), claude: catalog('claude', []) })
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: 0,
        selection: luna,
        catalogIdentity: '0'.repeat(64),
      }),
    ).toMatchObject({ ok: false })
    expect(load).not.toHaveBeenCalled()
    expect(
      await f.flow.saveSchedulingSettings({
        expectedRevision: 0,
        selection: luna,
        catalogIdentity: f.runtime.catalogIdentity(process.cwd()),
      }),
    ).toMatchObject({ ok: false })
    expect(load).toHaveBeenCalledOnce()
    expect(f.flow.getSchedulingSettings()).toMatchObject({
      ok: true,
      value: { selection: null, revision: 0 },
    })
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
