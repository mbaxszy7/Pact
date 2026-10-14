import { expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'

import { IPC_TRAFFIC_UNIT } from '../../packages/contracts/src/index.js'
import { PactDatabase } from '../../packages/persistence/src/index.js'
import { createRuntimeFixture, test } from './runtime-fixture.js'

const migrationsFolder = resolve(import.meta.dirname, '../../packages/persistence/drizzle')
test(
  'counts real Bridge/Utility/Directory traffic and retains Browser Worker physical-release proof separately',
  { tag: '@deterministic' },
  async () => {
    test.setTimeout(120_000)
    const fixture = await createRuntimeFixture({ measureIpcTraffic: true })
    const bundle = join(fixture.directory, 'directory-seam-bundle')
    await mkdir(bundle)
    const desktopRoot = resolve(import.meta.dirname, '../../apps/desktop')
    const desktopRequire = createRequire(join(desktopRoot, 'package.json'))
    const compiler = pathToFileURL(desktopRequire.resolve('electron-vite')).href
    const sources = {
      'directory-owner': resolve(
        desktopRoot,
        'src/main/utility-process/directory-file-operations.ts',
      ),
      'ipc-counter': resolve(desktopRoot, 'src/shared/logical-ipc-traffic.ts'),
    }
    const configFile = join(bundle, 'fixture.config.mjs')
    await writeFile(
      configFile,
      `import {externalizeDepsPlugin} from ${JSON.stringify(compiler)};export default {main:{plugins:[externalizeDepsPlugin({exclude:['@pact/contracts']})],build:{outDir:${JSON.stringify(bundle)},emptyOutDir:false,rollupOptions:{input:${JSON.stringify(sources)}}}}};`,
    )
    const compilerModule: unknown = await import(compiler)
    const build: unknown =
      compilerModule && typeof compilerModule === 'object'
        ? Reflect.get(compilerModule, 'build')
        : undefined
    if (typeof build !== 'function') throw new Error('The fixture compiler is unavailable.')
    await Reflect.apply(build, undefined, [
      { root: desktopRoot, configFile, ignoreConfigWarning: true, logLevel: 'silent' },
    ])
    const harness = {
      paths: {
        'directory-owner': join(bundle, 'directory-owner.js'),
        'ipc-counter': join(bundle, 'ipc-counter.js'),
      },
    }

    let app: Awaited<ReturnType<typeof fixture.launch>> | undefined
    try {
      const directory = await fixture.createProjectDirectory('ipc-worker-fixture')
      const text = '{"fixture":"é😀","enabled":true}\n'
      await writeFile(join(directory, 'fixture.json'), text)
      await writeFile(join(directory, 'fixture.ts'), 'export const fixture = true\n')
      const database = await PactDatabase.open({ filePath: fixture.databaseFile, migrationsFolder })
      const projectId = randomUUID(),
        sessionId = randomUUID(),
        createdAt = new Date().toISOString()
      try {
        database.projectCatalogRepository.add({
          id: projectId,
          name: 'IPC worker fixture',
          directoryPath: directory,
          kind: 'directory',
          createdAt,
        })
        database.sessionRepository.create(
          { id: sessionId, projectId, title: 'IPC worker fixture', createdAt },
          {
            primaryAgentId: 'codex',
            agents: { claude: { model: null, effort: null }, codex: { model: null, effort: null } },
            maxDiscussionRounds: 3,
            runningMessagePolicy: 'next_round',
            maxReviewCycles: 2,
            maxRepairAttempts: 2,
          },
        )
        const started = database.conversationRepository.beginRun({
          sessionId,
          clientMessageId: randomUUID(),
          content: 'Read isolated fixture files.',
          expectedCommentsRevision: 0,
          commentIds: [],
          agentId: 'codex',
          settingsRevision: 1,
          model: null,
          effort: null,
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'codex',
          type: 'text.completed',
          turnId: 'fixture-turn',
          outputId: 'fixture-output',
          text: '[fixture.json](fixture.json) · [fixture.ts](fixture.ts)',
        })
        database.conversationRepository.applyEvent(sessionId, started.run.id, {
          agentId: 'codex',
          type: 'turn.completed',
          turnId: 'fixture-turn',
          outcome: 'completed',
        })
      } finally {
        database.close()
      }
      app = await fixture.launch()
      const page = await app.firstWindow()
      await page.getByRole('button', { name: 'IPC worker fixture', exact: true }).click()
      const cdp = await page.context().newCDPSession(page)
      try {
        const workerTargets = async (): Promise<string[]> => {
          const { targetInfos } = await cdp.send('Target.getTargets')
          return targetInfos
            .filter(
              (target) => target.type === 'worker' && /(?:json|editor)\.worker/u.test(target.url),
            )
            .map((target) => target.targetId)
        }
        expect(await workerTargets()).toEqual([])
        await page.getByRole('button', { name: 'fixture.json', exact: true }).click()
        await expect(page.getByLabel('fixture.json source code')).toBeAttached()
        await expect.poll(workerTargets).not.toEqual([])
        await expect
          .poll(async () => {
            const health = await page.evaluate(() => {
              const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
              return bridge.getRuntimeHealth()
            })
            return health.ok
              ? health.value.ipcTraffic?.owners
                  .find((owner) => owner.owner === 'renderer-monaco')
                  ?.counters.find((row) => row.category === 'monaco-renderer.reply')?.business
                  .messages
              : undefined
          })
          .toBeGreaterThan(0)
        const jsonTargets = await workerTargets()
        const during = await page.evaluate(() => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.getRuntimeHealth()
        })
        expect(during.ok).toBe(true)
        if (!during.ok) throw new Error('Missing measured health.')
        expect(during.value.ipcTraffic?.owners).toHaveLength(9)
        const monaco = during.value.ipcTraffic?.owners.find(
          (owner) => owner.owner === 'renderer-monaco',
        )
        expect(monaco?.startedTransports).toBeGreaterThan(0)
        expect(
          monaco?.counters.find((row) => row.category === 'renderer-monaco.request')?.business
            .messages,
        ).toBeGreaterThan(0)
        expect(monaco?.issues).toEqual(['cleanup_unavailable'])
        expect(during.value.ipcTraffic?.complete).toBe(false)
        await page.getByRole('button', { name: 'Close file preview' }).click()
        await expect.poll(workerTargets).toEqual([])
        await page.getByRole('button', { name: 'fixture.ts', exact: true }).click()
        await expect(page.getByLabel('fixture.ts source code')).toBeAttached()
        await page.getByRole('button', { name: 'Close file preview' }).click()
        await expect.poll(workerTargets).toEqual([])
        expect(jsonTargets.length).toBeGreaterThan(0)
        // Real CDP disappearance is independent evidence; a Renderer scalar or terminate() call
        // cannot clear the runtime's unverified physical-release issue.
        const after = await page.evaluate(() => {
          const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
          return bridge.getRuntimeHealth()
        })
        if (!after.ok) throw new Error('Missing final measured health.')
        expect(after.value.ipcTraffic?.complete).toBe(false)
        expect(after.value.ipcTraffic?.unit).toBe(IPC_TRAFFIC_UNIT)
        const afterMonaco = after.value.ipcTraffic?.owners.find(
          (owner) => owner.owner === 'renderer-monaco',
        )
        expect(afterMonaco?.issues).toEqual(['cleanup_unavailable'])
        expect(
          afterMonaco?.counters.every(
            (row) => row.business.incompleteMessages === 0 && row.control.incompleteMessages === 0,
          ),
        ).toBe(true)
        expect(afterMonaco?.counters.every((row) => row.business.messages > 0)).toBe(true)
        const root = await stat(directory, { bigint: true })
        const input = {
          operation: 'capture' as const,
          rootPath: directory,
          rootDevice: root.dev.toString(),
          rootInode: root.ino.toString(),
          directories: [],
          name: 'fixture.json',
          auxiliaryPath: join(fixture.directory, 'captured.json'),
          maximumBytes: 1024,
        }
        const actual = await app.evaluate(
          async (_electron, args) => {
            const load = process.getBuiltinModule('module').createRequire(args.ownerBundle)
            const loadedOwner: unknown = load(args.ownerBundle),
              loadedCounter: unknown = load(args.counterBundle)
            if (
              !loadedOwner ||
              typeof loadedOwner !== 'object' ||
              !loadedCounter ||
              typeof loadedCounter !== 'object'
            )
              throw new Error('Missing actual Main fixture modules.')
            const Owner: unknown = Reflect.get(loadedOwner, 'DirectoryFileOperations'),
              Counter: unknown = Reflect.get(loadedCounter, 'LogicalIpcTrafficCollector')
            if (typeof Owner !== 'function' || typeof Counter !== 'function')
              throw new Error('Missing actual Main fixture interfaces.')
            const owner: unknown = Reflect.construct(Owner, [args.worker]),
              counter: unknown = Reflect.construct(Counter, ['main-directory', args.epoch])
            if (!owner || typeof owner !== 'object' || !counter || typeof counter !== 'object')
              throw new Error('Invalid actual Main fixture instances.')
            const configure: unknown = Reflect.get(owner, 'configureTraffic'),
              execute: unknown = Reflect.get(owner, 'execute'),
              dispose: unknown = Reflect.get(owner, 'dispose'),
              snapshot: unknown = Reflect.get(counter, 'snapshot')
            if (
              [configure, execute, dispose, snapshot].some((method) => typeof method !== 'function')
            )
              throw new Error('Missing actual Main owner operation.')
            if (
              typeof configure !== 'function' ||
              typeof execute !== 'function' ||
              typeof dispose !== 'function' ||
              typeof snapshot !== 'function'
            )
              throw new Error('Invalid Main owner operations.')
            Reflect.apply(configure, owner, [counter])
            try {
              const result: unknown = await Reflect.apply(execute, owner, [args.input])
              await Reflect.apply(dispose, owner, [])
              return { result, traffic: Reflect.apply(snapshot, counter, []) as unknown }
            } finally {
              await Reflect.apply(dispose, owner, [])
            }
          },
          {
            ownerBundle: harness.paths['directory-owner'],
            counterBundle: harness.paths['ipc-counter'],
            worker: resolve(
              import.meta.dirname,
              '../../apps/desktop/out/main/utility/workspace-directory-worker.js',
            ),
            epoch: randomUUID(),
            input,
          },
        )
        const expectedHash = createHash('sha256').update(text).digest('hex')
        expect(actual.result).toMatchObject({
          ok: true,
          existed: true,
          hash: expectedHash,
          bytes: Buffer.byteLength(text),
        })
        expect(await readFile(input.auxiliaryPath, 'utf8')).toBe(text)
        expect(actual.traffic).toMatchObject({
          complete: true,
          activeTransports: 0,
          startedTransports: 1,
          settledTransports: 1,
          counters: [
            {
              category: 'main-directory.request',
              business: { messages: 1, totalBytes: Buffer.byteLength(JSON.stringify(input)) },
            },
            {
              category: 'directory-main.reply',
              business: {
                messages: 1,
                totalBytes: Buffer.byteLength(JSON.stringify(actual.result)),
              },
            },
          ],
        })
        await test.info().attach('ipc-worker-physical-seams', {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({
              monacoPhysical: {
                createdTargets: jsonTargets.length,
                afterCloseTargets: 0,
                evidence: 'CDP Target.getTargets',
              },
              runtimeObservation: after.value.ipcTraffic,
              directoryPhysical: actual.traffic,
              directoryContentHash: expectedHash,
              scope:
                'Current host only; physical CDP proof remains separate from runtime counters; complete IPC soak remains blocked.',
            }),
          ),
        })
      } finally {
        await cdp.detach()
      }
    } finally {
      await app?.close()
      await fixture.dispose()
    }
  },
)
