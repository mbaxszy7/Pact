import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, expect, it, vi } from 'vitest'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import {
  cleanupNativeFixture,
  isolatedEnv,
  NativeRpc,
  ownedRoot,
  within,
} from '../native/native-harness.js'
import { writeNativeTransportFault } from './native-transport-fault.js'
import {
  disposeWindowsLauncherImage,
  windowsLauncherImageDiagnostic,
  writeWindowsNodeLauncher,
  writeWindowsObservedLauncher,
} from './windows-cli-launcher.js'

afterAll(() => {
  if (process.platform !== 'win32') return
  disposeWindowsLauncherImage()
  if (windowsLauncherImageDiagnostic().privateLinks !== 0)
    throw new Error('Windows fixture private image cleanup unconfirmed')
})

it.skipIf(process.platform !== 'win32')(
  'confirms an empty Job after a genuine post-start helper exception without inventing root exit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-job-exception-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 10000)
    try {
      const source = await readFile(resolve('scripts/windows-e2e-job.cs'), 'utf8')
      const boundary = 'var clock = Stopwatch.StartNew(); long exitedAt = -1'
      expect(source.includes(boundary)).toBe(true)
      const injected = join(root, 'job.cs')
      await writeFile(
        injected,
        source.replace(
          boundary,
          'if (process.Pid > 0) throw new IOException("owned post-start fixture failure"); ' +
            boundary,
        ),
      )
      // Detach this owned image from the immutable shared seed before compiling.
      await unlink(owner.executablePath)
      execFileSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'Microsoft.NET',
          process.arch === 'ia32' ? 'Framework' : 'Framework64',
          'v4.0.30319/csc.exe',
        ),
        [
          '/nologo',
          '/target:exe',
          '/reference:System.Web.Extensions.dll',
          `/out:${owner.executablePath}`,
          injected,
          resolve('tests/e2e/windows-cli-launcher.cs'),
        ],
        { timeout: 10000, maxBuffer: 16384, shell: false, windowsHide: true },
      )
      owner.armStartup(performance.now() + 10000)
      const child = spawn(owner.executablePath, ['-e', 'setInterval(()=>{},1000)'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const closed = once(child, 'close')
      child.stdout.resume()
      child.stderr.resume()
      await owner.started
      await expect(owner.rootExit).rejects.toThrow('root exit is unavailable')
      expect(await owner.empty).toMatchObject({ active: 0, exitCode: 1 })
      await closed
      expect(child.exitCode).toBe(1)
      expect(owner.diagnostic()).toMatchObject({ lastActive: 0, exitCode: 1, nativeErrorCode: 0 })
      expect(owner.diagnostic().rootExit).toBeUndefined()
    } finally {
      owner.cancel()
      await owner.disposeControl()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows fixture images share a file instance and keep private descriptors independent',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-image-isolation-test-'))
    try {
      const first = join(root, 'first'),
        second = join(root, 'second')
      await mkdir(first)
      await mkdir(second)
      const a = await writeWindowsNodeLauncher(first, 'entry', ['-e', "console.log('first')"])
      const b = await writeWindowsNodeLauncher(second, 'entry', ['-e', "console.log('second')"])
      const [aInfo, bInfo] = await Promise.all([
        stat(a, { bigint: true }),
        stat(b, { bigint: true }),
      ])
      expect(aInfo.ino).not.toBe(0n)
      expect(aInfo.ino).toBe(bInfo.ino)
      expect(aInfo.nlink).toBeGreaterThanOrEqual(3n)
      for (const [image, marker] of [
        [a, 'first'],
        [b, 'second'],
      ])
        expect(
          execFileSync(image!, [], {
            timeout: 10_000,
            maxBuffer: 4096,
            windowsHide: true,
            shell: false,
          }).toString(),
        ).toBe(marker + '\n')
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32').each(['unarmed', 'expired', 'cancelled'] as const)(
  'never starts a target from a late %s control connection',
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-late-job-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 10_000)
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<unknown> | undefined
    try {
      if (state !== 'unarmed')
        owner.armStartup(performance.now() + (state === 'expired' ? 50 : 10_000))
      if (state === 'cancelled') owner.cancel()
      if (state === 'expired') await owner.started.catch(() => undefined)
      const marker = join(root, 'must-not-start')
      child = spawn(
        owner.executablePath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        { shell: false, windowsHide: true, stdio: 'ignore' },
      )
      closed = once(child, 'close')
      await expect(owner.started).rejects.toThrow('Windows Job')
      await expect(owner.empty).rejects.toThrow('Windows Job')
      await closed
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(owner.diagnostic().stages.started).toBeUndefined()
      expect(owner.diagnostic().stages.empty).toBeUndefined()
    } finally {
      owner.cancel()
      await owner.disposeControl()
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      await closed
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32').each(['cancelled', 'disposed', 'already-armed'] as const)(
  'refuses startup authorization after %s',
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-job-arm-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 10_000)
    try {
      if (state === 'cancelled') owner.cancel()
      if (state === 'disposed') await owner.disposeControl()
      if (state === 'already-armed') owner.armStartup(performance.now() + 50)
      expect(() => owner.armStartup(performance.now() + 30_000)).toThrow(
        'one live bounded caller deadline',
      )
      if (state === 'already-armed') await owner.started.catch(() => undefined)
    } finally {
      await owner.disposeControl()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'uses the caller startup deadline when the genuine Job host connects after eleven seconds',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-delayed-job-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 15_000)
    let child: ReturnType<typeof spawn> | undefined
    let closed: Promise<unknown> | undefined
    try {
      const delayedEntry = join(root, 'delayed-main.cs')
      await writeFile(
        delayedEntry,
        'public static class DelayedMain { public static int Main(string[] args) { System.Threading.Thread.Sleep(11000); return PactFixtureLauncher.Main(args); } }',
      )
      // This fixture intentionally replaces Main; detach it from the shared immutable image.
      await unlink(owner.executablePath)
      execFileSync(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'Microsoft.NET',
          process.arch === 'ia32' ? 'Framework' : 'Framework64',
          'v4.0.30319/csc.exe',
        ),
        [
          '/nologo',
          '/target:exe',
          '/main:DelayedMain',
          '/reference:System.Web.Extensions.dll',
          `/out:${owner.executablePath}`,
          resolve('scripts/windows-e2e-job.cs'),
          resolve('tests/e2e/windows-cli-launcher.cs'),
          delayedEntry,
        ],
        { timeout: 10_000, maxBuffer: 16 * 1024, windowsHide: true, shell: false },
      )
      const armedAt = performance.now()
      // Before the correction, the factory's independent ten-second timer refuses this real host.
      owner.armStartup(armedAt + 30_000)
      const marker = join(root, 'target-pid')
      child = spawn(
        owner.executablePath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid))`],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      closed = once(child, 'close')
      child.stdout?.resume()
      child.stderr?.resume()
      const started = await owner.started
      expect(performance.now() - armedAt).toBeGreaterThanOrEqual(11_000)
      expect(await owner.empty).toEqual({ generation: owner.generation, active: 0, exitCode: 0 })
      await closed
      expect(Number(await readFile(marker, 'utf8'))).toBe(started.pid)
      expect(gone(started.pid)).toBe(true)
    } finally {
      owner.cancel()
      await owner.disposeControl()
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      await closed
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  40_000,
)

it.skipIf(process.platform !== 'win32').each(['before', 'after'] as const)(
  'observed app Job survives relay death $0 initial publication and preserves protocol facts',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-observed-relay-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 15_000)
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = once(sentinel, 'close')
    try {
      const actual = await writeWindowsNodeLauncher(root, 'version-target', [
        '-e',
        "console.log('codex-cli 0.161.0')",
      ])
      const files = await writeNativeTransportFault(root, actual, 'hold-initialization')
      const marker = join(root, 'paused.json')
      const injection = join(root, 'pause.mjs')
      await writeFile(
        injection,
        `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{dirname}from'node:path';const rename=fs.renameSync;fs.renameSync=(source,target)=>{if(dirname(target)===${JSON.stringify(files.factsPath)}){const value=JSON.parse(fs.readFileSync(source));if(value.actualChildPid===null&&value.entries.length===0){if(${JSON.stringify(phase)}==='after')rename(source,target);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({relayPid:process.pid}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,6000);if(${JSON.stringify(phase)}==='after')return;}}return rename(source,target)};syncBuiltinESMExports();\n`,
      )
      const entry = join(root, 'app.mjs')
      await writeFile(
        entry,
        `import{spawn}from'node:child_process';const child=spawn(${JSON.stringify(files.executablePath)},['--version'],{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_OPTIONS:${JSON.stringify('--import=' + pathToFileURL(injection).href)}}});child.stdout.resume();child.stderr.resume();const timeout=setTimeout(()=>child.kill(),4000);child.once('close',()=>clearTimeout(timeout));\n`,
      )
      owner.armStartup(performance.now() + 15_000)
      const child = spawn(owner.executablePath, [entry], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      })
      const closed = once(child, 'close')
      const started = await owner.started
      const receipt = await owner.empty
      await closed
      expect(receipt).toEqual({ generation: owner.generation, active: 0, exitCode: 0 })
      const paused: { relayPid: number } = JSON.parse(await readFile(marker, 'utf8'))
      expect(gone(started.pid) && gone(paused.relayPid)).toBe(true)
      const names = await readdir(files.factsPath)
      const json = names.filter((name) => name.endsWith('.json'))
      expect(json).toHaveLength(phase === 'before' ? 0 : 1)
      const facts = json.length
        ? JSON.parse(await readFile(join(files.factsPath, json[0]!), 'utf8'))
        : null
      expect(facts?.closed ?? false).toBe(false)
      expect(facts?.actualChildPid ?? null).toBeNull()
      expect(names.filter((name) => name.endsWith('.tmp'))).toHaveLength(phase === 'before' ? 1 : 0)
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      owner.cancel()
      await owner.disposeControl()
      sentinel.kill()
      await sentinelClosed
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  25_000,
)

it.skipIf(process.platform !== 'win32')(
  'observed Job confirms independent-stdio descendants before releasing its control owner',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-observed-job-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 15_000)
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = once(sentinel, 'close')
    let child: ReturnType<typeof spawn> | undefined
    try {
      const report = join(root, 'workers.json')
      const source = `const {spawn}=require('node:child_process');const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{shell:false,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(report)},JSON.stringify({worker:process.pid,descendant:leaf.pid}));console.log('{"kind":"empty","active":0}');process.stdin.resume();setInterval(()=>{},1000);`
      owner.armStartup(performance.now() + 15_000)
      child = spawn(owner.executablePath, ['-e', source], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const closed = once(child, 'close')
      child.stdout?.resume()
      child.stderr?.resume()
      const started = await owner.started
      const workers = await waitForWorker(report)
      expect(started.pid).toBe(workers.worker)
      expect(started.generation).toBe(owner.generation)
      let emptyObserved = false
      void owner.empty.then(
        () => {
          emptyObserved = true
          return undefined
        },
        () => undefined,
      )
      await new Promise((done) => setTimeout(done, 50))
      expect(emptyObserved).toBe(false)
      owner.cancel()
      expect(await owner.empty).toEqual({ generation: owner.generation, active: 0, exitCode: 1 })
      await closed
      expect(gone(workers.worker) && gone(workers.descendant)).toBe(true)
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      owner.cancel()
      await owner.disposeControl()
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill()
        await once(child, 'close')
      }
      sentinel.kill()
      await sentinelClosed
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  25_000,
)

it.skipIf(process.platform !== 'win32').each(['token', 'generation'] as const)(
  'observed Job rejects wrong %s before starting its target',
  async (field) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-observed-admission-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 10_000)
    try {
      const descriptor = join(owner.directory, 'owned-launch.json')
      const configuration = JSON.parse(await readFile(descriptor, 'utf8'))
      configuration[field] = '00000000-0000-0000-0000-000000000000'
      await writeFile(descriptor, JSON.stringify(configuration))
      const marker = join(root, 'must-not-start')
      owner.armStartup(performance.now() + 10_000)
      const child = spawn(
        owner.executablePath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')`],
        { shell: false, windowsHide: true, stdio: 'ignore' },
      )
      const closed = once(child, 'close')
      await expect(owner.started).rejects.toThrow('control validation failed')
      await expect(owner.empty).rejects.toThrow('control validation failed')
      await closed
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await owner.disposeControl()
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32')(
  'observed Job host death cannot fabricate an empty receipt',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-observed-death-test-'))
    const owner = await writeWindowsObservedLauncher(root, process.execPath, 10_000)
    owner.armStartup(performance.now() + 10_000)
    const child = spawn(owner.executablePath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const closed = once(child, 'close')
    try {
      const started = await owner.started
      child.kill()
      await closed
      await expect(owner.empty).rejects.toThrow('without an authenticated empty receipt')
      await expect.poll(() => gone(started.pid)).toBe(true)
    } finally {
      await owner.disposeControl()
      if (child.exitCode === null && child.signalCode === null) {
        child.kill()
        await closed
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32').each(['initial', 'spawned'] as const)(
  'Windows relay preserves failure facts and releases its tree when $0 publication stays locked',
  async (phase) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-publish-failure-'))
    const owner = new OwnedProcessGroup()
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = once(sentinel, 'close')
    try {
      const report = join(root, 'workers.json')
      const entry = join(root, 'worker.mjs')
      await writeFile(
        entry,
        `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const leaf=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{shell:false,stdio:'ignore'});writeFileSync(${JSON.stringify(report)},JSON.stringify({worker:process.pid,descendant:leaf.pid}));process.stdin.resume();setInterval(()=>{},1000);\n`,
      )
      const actual = await writeWindowsNodeLauncher(root, 'actual-worker', [entry])
      const files = await writeNativeTransportFault(root, actual, 'hold-initialization')
      const injection = join(root, 'persistent-lock.mjs')
      await writeFile(
        injection,
        `import fs from'node:fs';import{syncBuiltinESMExports}from'node:module';import{dirname}from'node:path';const rename=fs.renameSync;const wait=new Int32Array(new SharedArrayBuffer(4));let observed=false;fs.renameSync=(source,target)=>{if(dirname(target)===${JSON.stringify(files.factsPath)}){const facts=JSON.parse(fs.readFileSync(source));if(${JSON.stringify(phase)}==='initial'||facts.actualChildPid!==null){if(${JSON.stringify(phase)}==='spawned'&&!observed){const end=performance.now()+5000;while(!fs.existsSync(${JSON.stringify(report)})&&performance.now()<end)Atomics.wait(wait,0,0,10);observed=true;}throw Object.assign(new Error('controlled persistent publish lock'),{code:'EPERM'});}}return rename(source,target)};syncBuiltinESMExports();\n`,
      )
      const child = owner.spawn(files.executablePath, ['app-server'], {
        cwd: root,
        env: {
          SystemRoot: process.env.SystemRoot,
          TEMP: root,
          NODE_OPTIONS: `--import=${pathToFileURL(injection).href}`,
        },
        windowsHide: true,
      })
      const closed = once(child, 'close')
      child.stdout.resume()
      child.stderr.resume()
      const [code] = await closed
      await owner.close()
      expect(code).toBe(1)
      expect(owner.released).toBe(true)
      const names = await readdir(files.factsPath)
      const published = names.filter((name) => name.endsWith('.json'))
      expect(published).toHaveLength(phase === 'initial' ? 0 : 1)
      const saved = published.length
        ? JSON.parse(await readFile(join(files.factsPath, published[0]!), 'utf8'))
        : null
      expect(saved?.closed ?? false).toBe(false)
      expect(names.filter((name) => name.endsWith('.tmp'))).toHaveLength(1)
      const workers = await readFile(report, 'utf8')
        .then((value): { worker: number; descendant: number } => JSON.parse(value))
        .catch(() => null)
      expect(workers === null).toBe(phase === 'initial')
      expect(workers ? gone(workers.worker) && gone(workers.descendant) : true).toBe(true)
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      try {
        await owner.close()
      } finally {
        sentinel.kill()
        await sentinelClosed
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      }
    }
  },
  20_000,
)

async function waitForWorker(
  path: string,
): Promise<{ worker: number; descendant: number; args?: string[] }> {
  for (let index = 0; index < 200; index++) {
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- One private fixture has a five-second startup bound.
      return JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && Reflect.get(error, 'code') === 'ENOENT')
      )
        throw error
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Wait only for this private worker's ready receipt.
    await new Promise((done) => setTimeout(done, 25))
  }
  throw new Error('Owned Windows RPC worker did not start')
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ESRCH') return true
    throw error
  }
}

it.skipIf(process.platform !== 'win32').each([
  { kind: 'cmd', owned: false },
  { kind: 'exe', owned: false },
  { kind: 'cmd', owned: true },
  { kind: 'exe', owned: true },
] as const)(
  'Windows RPC $kind close owns ignored-EOF descendants and disposes its private launcher (group: $owned)',
  async ({ kind, owned }) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = new Promise((done) => sentinel.once('close', done))
    let rpc: NativeRpc | undefined
    const owner = owned ? new OwnedProcessGroup({ startupObservationMs: 2_000 }) : undefined
    let released = 0
    let pids: { worker: number; descendant: number } | undefined
    let stopObservation: (() => void) | undefined
    try {
      const entry = join(root, 'worker.mjs'),
        leaf = join(root, 'descendant.mjs'),
        report = join(root, 'workers.json')
      await writeFile(
        leaf,
        `process.stdin.resume();process.send('ready');setInterval(()=>{},1000);\n`,
      )
      await writeFile(
        entry,
        `import{spawn}from'node:child_process';import{openSync,writeFileSync}from'node:fs';
openSync(${JSON.stringify(join(root, 'held-file'))},'w');
const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{shell:false,stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>writeFileSync(${JSON.stringify(report)},JSON.stringify({worker:process.pid,descendant:child.pid})));
process.stdin.resume();setInterval(()=>{},1000);\n`,
      )
      let executable: string
      if (kind === 'cmd') {
        executable = join(root, 'worker.cmd')
        await writeFile(executable, `@echo off\r\n"${process.execPath}" "${entry}"\r\n`)
      } else executable = await writeWindowsNodeLauncher(root, 'actual-worker', [entry])
      const onReleased = (): void => {
        released++
        expect(owner?.released).toBe(true)
        // A startup failure must remain the primary error; no worker receipt exists then.
        expect(!pids || (gone(pids.worker) && gone(pids.descendant))).toBe(true)
        expect(readdirSync(root).filter((name) => name.startsWith('pact-owned-launch-'))).toEqual(
          [],
        )
      }
      rpc = await NativeRpc.create(
        executable,
        root,
        {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: root,
        },
        owner ? { group: owner, onReleased } : {},
      )
      const began = performance.now()
      const stages: Record<string, number> = {}
      let stderr = Buffer.alloc(0)
      const spawned = (): void => {
        stages.spawn = Math.round(performance.now() - began)
      }
      const failed = (): void => {
        stages.error = Math.round(performance.now() - began)
      }
      const exited = (): void => {
        stages.exit = Math.round(performance.now() - began)
      }
      const closed = (): void => {
        stages.close = Math.round(performance.now() - began)
      }
      const output = (chunk: Buffer): void => {
        stderr = Buffer.concat([stderr, chunk.subarray(0, Math.max(0, 4096 - stderr.length))])
      }
      rpc.child.once('spawn', spawned)
      rpc.child.once('error', failed)
      rpc.child.once('exit', exited)
      rpc.child.once('close', closed)
      rpc.child.stderr.on('data', output)
      const observed = rpc.child
      stopObservation = () => {
        observed.off('spawn', spawned).off('error', failed).off('exit', exited).off('close', closed)
        observed.stderr.off('data', output)
      }
      try {
        pids = await waitForWorker(report)
      } catch {
        throw new Error(
          `Owned Windows RPC worker did not start; controlled observation=${JSON.stringify({ stages, exitCode: rpc.child.exitCode, signalCode: rpc.child.signalCode, stderr: stderr.toString('utf8'), heldFile: existsSync(join(root, 'held-file')), workerReceipt: existsSync(report) })}`,
        )
      }
      const pending = rpc.request('unanswered', {}).catch((error: unknown) => error)
      expect(rpc.cleanupFacts().pendingRequests).toBe(1)
      await rpc.close()
      expect(released).toBe(owned ? 1 : 0)
      const outcome = await pending
      expect(outcome).toBeInstanceOf(Error)
      expect(rpc.cleanupFacts()).toMatchObject({
        released: true,
        childClosed: true,
        pendingRequests: 0,
        groupReleased: true,
        windowsJobEmpty: true,
        helperReleased: true,
      })
      expect(gone(pids.worker)).toBe(true)
      expect(gone(pids.descendant)).toBe(true)
      expect((await readdir(root)).filter((name) => name.startsWith('pact-owned-launch-'))).toEqual(
        [],
      )
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
      await rpc.close()
    } finally {
      stopObservation?.()
      try {
        await rpc?.close()
      } finally {
        sentinel.kill()
        await sentinelClosed
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      }
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows RPC preserves initialization packets and ordinary EOF exit zero',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    let rpc: NativeRpc | undefined
    try {
      const entry = join(root, 'protocol.mjs')
      await writeFile(
        entry,
        "import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin})){const message=JSON.parse(line);if(message.id!==undefined)console.log(JSON.stringify({id:message.id,result:{}}));}\n",
      )
      const executable = await writeWindowsNodeLauncher(root, 'protocol', [entry])
      rpc = await NativeRpc.create(executable, root, {
        TEMP: root,
        SystemRoot: process.env.SystemRoot,
      })
      await rpc.initialize()
      rpc.child.stdin.end()
      await rpc.exited
      expect(rpc.child.exitCode).toBe(0)
      await rpc.close()
      expect((await readdir(root)).filter((name) => name.startsWith('pact-owned-launch-'))).toEqual(
        [],
      )
    } finally {
      await rpc?.close()
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows RPC spawn failure releases its generated launcher',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    try {
      const rpc = await NativeRpc.create(process.execPath, join(root, 'missing-cwd'), {
        TEMP: root,
      })
      await rpc.exited
      await rpc.close()
      expect((await readdir(root)).filter((name) => name.startsWith('pact-owned-launch-'))).toEqual(
        [],
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows RPC missing compiler removes only its new private directory',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    try {
      vi.stubEnv('SystemRoot', join(root, 'missing-framework'))
      await expect(NativeRpc.create(process.execPath, root, { TEMP: root })).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readdir(root)).toEqual([])
    } finally {
      vi.unstubAllEnvs()
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.skipIf(process.platform !== 'win32')(
  'Windows native launcher forwards protocol stdin and literal argv',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    try {
      const entry = join(root, 'echo.mjs')
      await writeFile(
        entry,
        `import{createInterface}from'node:readline';for await(const line of createInterface({input:process.stdin}))console.log(JSON.stringify({args:process.argv.slice(2),line}));\n`,
      )
      const executable = await writeWindowsNodeLauncher(root, 'echo-cli', [entry])
      const child = spawn(executable, ['中文', 'a"b', '&|%$()', 'trailing\\'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = '',
        errors = ''
      child.stdout.on('data', (value: Buffer) => {
        output += value
      })
      child.stderr.on('data', (value: Buffer) => {
        errors += value
      })
      child.stdin.end('protocol input\n')
      const code = await new Promise((done, reject) => {
        child.once('close', done)
        child.once('error', reject)
      })
      expect(errors).toBe('')
      expect(code).toBe(0)
      expect(JSON.parse(output)).toEqual({
        args: ['中文', 'a"b', '&|%$()', 'trailing\\'],
        line: 'protocol input',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows transparent relay starts an actual native entry without creating a model response',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-cli-test-'))
    try {
      const entry = join(root, 'version.mjs')
      await writeFile(entry, `console.log('controlled-protocol 0.1.0');\n`)
      const actual = await writeWindowsNodeLauncher(root, 'actual-cli', [entry])
      const files = await writeNativeTransportFault(root, actual, 'pause-turn')
      const child = spawn(files.executablePath, ['--version'], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout.on('data', (value: Buffer) => {
        output += value
      })
      child.stderr.resume()
      child.stdin.end()
      const code = await new Promise((done, reject) => {
        child.once('close', done)
        child.once('error', reject)
      })
      expect(code).toBe(0)
      expect(output).toBe('controlled-protocol 0.1.0\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  15_000,
)

it.skipIf(process.platform !== 'win32').each([
  { kind: 'cmd', publishFault: undefined },
  { kind: 'exe', publishFault: undefined },
  { kind: 'cmd', publishFault: 'candidate' },
  { kind: 'cmd', publishFault: 'closed' },
] as const)(
  'Windows fault relay closes its $kind subtree before publishing held-reply cleanup ($publishFault)',
  async ({ kind, publishFault }) => {
    const root = await mkdtemp(join(tmpdir(), 'pact-windows-relay-test-'))
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = new Promise((done) => sentinel.once('close', done))
    const owner = new OwnedProcessGroup()
    try {
      const entry = join(root, 'protocol.mjs'),
        leaf = join(root, 'descendant.mjs'),
        report = join(root, 'workers.json'),
        requestsReport = join(root, 'requests.jsonl'),
        publishReport = join(root, 'publish.jsonl')
      await writeFile(leaf, "process.send('ready');setInterval(()=>{},1000);\n")
      await writeFile(
        entry,
        `import{spawn}from'node:child_process';import{writeFileSync,appendFileSync}from'node:fs';import{createInterface}from'node:readline';
const child=spawn(process.execPath,[${JSON.stringify(leaf)}],{shell:false,stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>writeFileSync(${JSON.stringify(report)},JSON.stringify({worker:process.pid,descendant:child.pid,args:process.argv.slice(2)})));
for await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line);appendFileSync(${JSON.stringify(requestsReport)},JSON.stringify(m.method)+'\\n');if(m.id!==undefined)console.log(JSON.stringify({id:m.id,result:m.method==='thread/start'?{thread:{id:'owned-candidate'}}:{}}));}
setInterval(()=>{},1000);\n`,
      )
      let actual: string
      if (kind === 'cmd') {
        actual = join(root, 'protocol.cmd')
        await writeFile(actual, `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`)
      } else actual = await writeWindowsNodeLauncher(root, 'actual-protocol', [entry])
      const files = await writeNativeTransportFault(root, actual, 'hold-initialization')
      const injection = join(root, 'publish-fault.mjs')
      if (publishFault)
        await writeFile(
          injection,
          `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';import{dirname}from'node:path';import{createHash}from'node:crypto';
const rename=fs.renameSync;let attempts=0,selected;const records=[];
fs.renameSync=(source,target)=>{
  if(dirname(target)===${JSON.stringify(files.factsPath)}){
    const bytes=fs.readFileSync(source);const facts=JSON.parse(bytes);
    const match=${JSON.stringify(publishFault)}==='closed'?facts.closed:facts.entries.at(-1)?.kind==='candidate-ack-forwarded';
    if(match&&!selected)selected=source;
    if(selected===source&&match&&attempts<3){
      attempts++;records.push({source,target,sha256:createHash('sha256').update(bytes).digest('hex'),attempts});
      if(attempts<3)throw Object.assign(new Error('injected transient publish lock'),{code:'EPERM'});
      const result=rename(source,target);
      // Evidence failure after commit must not retry the completed rename.
      try{fs.writeFileSync(${JSON.stringify(publishReport)},records.map(record=>JSON.stringify(record)).join('\\n')+'\\n',{flag:'wx'});}
      catch{throw Object.assign(new Error('Rename fault evidence could not be written'),{code:'PACT_TEST_REPORT_FAILED'});}
      return result;
    }
  }
  return rename(source,target);
};syncBuiltinESMExports();\n`,
        )
      const child = owner.spawn(
        files.executablePath,
        ['--enable', 'code_mode_interrupt', 'app-server'],
        {
          cwd: root,
          env: {
            SystemRoot: process.env.SystemRoot,
            TEMP: root,
            ...(publishFault ? { NODE_OPTIONS: `--import=${pathToFileURL(injection).href}` } : {}),
          },
          windowsHide: true,
        },
      )
      child.stdout.resume()
      child.stderr.resume()
      const workers = await waitForWorker(report)
      for (const [index, method] of ['initialize', 'thread/start', 'thread/inject_items'].entries())
        child.stdin.write(JSON.stringify({ id: index + 1, method, params: {} }) + '\n')
      const facts = async () => {
        const names = (await readdir(files.factsPath)).filter((name) => name.endsWith('.json'))
        expect(names).toHaveLength(1)
        const value: {
          actualExecutable: string
          closed: boolean
          nativeInterruptionEnabled: boolean
          pendingRequests: number
          forwardedTurns: number
          faultPhase: string
          entries: Array<{ kind: string }>
        } = JSON.parse(await readFile(join(files.factsPath, names[0]!), 'utf8'))
        return value
      }
      await expect.poll(async () => (await facts()).faultPhase).toBe('held-after-native')
      await owner.close()
      expect(owner.released).toBe(true)
      expect(await facts()).toMatchObject({
        actualExecutable: await realpath(actual),
        closed: true,
        nativeInterruptionEnabled: true,
        pendingRequests: 0,
        forwardedTurns: 0,
        faultPhase: 'cancelled-after-native',
      })
      expect((await facts()).entries.at(-1)?.kind).toBe('actual-child-closed')
      expect(workers.args).toEqual(['--enable', 'code_mode_interrupt', 'app-server'])
      expect(gone(workers.worker) && gone(workers.descendant)).toBe(true)
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
      expect((await readdir(files.factsPath)).some((name) => name.endsWith('.tmp'))).toBe(false)
      expect(
        (await readFile(requestsReport, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(['initialize', 'thread/start', 'thread/inject_items'])
      const attempts = publishFault
        ? (await readFile(publishReport, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : []
      expect(attempts).toHaveLength(publishFault ? 3 : 0)
      expect(
        new Set(
          attempts.map(({ source, target, sha256 }) => JSON.stringify({ source, target, sha256 })),
        ).size,
      ).toBe(publishFault ? 1 : 0)
    } finally {
      await owner.close()
      sentinel.kill()
      await sentinelClosed
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    }
  },
  20_000,
)

it.skipIf(process.platform !== 'win32')(
  'observes natural root exit without claiming an empty Job while a descendant lives',
  async () => {
    const owned = await ownedRoot()
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      stdio: 'ignore',
    })
    const sentinelClosed = once(sentinel, 'close')
    try {
      const entry = join(owned.root, 'root.mjs'),
        marker = join(owned.root, 'descendant.json')
      await writeFile(
        entry,
        // A spawn receipt does not prove the descendant entered its live loop.
        // Its own ready packet must arrive before the parent receives EOF.
        // Windows libuv kills ordinary children when their Node parent exits.
        // Detached skips that inner Job; our outer kernel-assigned Job still owns it.
        `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const child=spawn(process.execPath,['-e',"setInterval(()=>{},1000);process.send('ready')"],{shell:false,windowsHide:true,detached:true,stdio:['ignore','ignore','ignore','ipc']});child.once('message',message=>{if(message!=='ready')process.exit(7);writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));});process.stdin.resume();process.stdin.once('end',()=>process.exit(0));`,
      )
      const scope = await owned.processes.prepareRpcOwner(
        process.execPath,
        performance.now() + 15000,
      )
      const child = scope.start([entry], {
        cwd: owned.cwd,
        env: isolatedEnv(owned.root, owned.home),
        shell: false,
      })
      const closed = once(child, 'close')
      child.stdout.resume()
      child.stderr.resume()
      const root = scope.rootExited()
      expect(root).toBeDefined()
      await scope.started()
      await expect
        .poll(async () =>
          readFile(marker, 'utf8').then(
            () => true,
            () => false,
          ),
        )
        .toBe(true)
      const descendant: { pid: number } = JSON.parse(await readFile(marker, 'utf8'))
      expect(Number.isSafeInteger(descendant.pid)).toBe(true)
      expect(gone(descendant.pid)).toBe(false)
      child.stdin.end()
      const receipt = await within(root!, 2000, 'Missing OS root-exit receipt')
      console.info('[native root regression]', JSON.stringify({ receipt, owner: scope.facts() }))
      expect(receipt).toMatchObject({ exitCode: 0, natural: true })
      expect(receipt.active).toBeGreaterThan(0)
      expect(receipt.members.some((member) => member.role === 'descendant')).toBe(true)
      expect(scope.facts().windowsJobEmpty).toBe(false)
      expect(child.exitCode).toBeNull()
      await within(closed, 7000, 'Descendant drain did not retain its existing deadline')
      await scope.close()
      expect(child.exitCode).toBe(1)
      expect(scope.facts()).toMatchObject({
        released: true,
        windowsControl: { stoppingReason: 'descendants-still-running' },
      })
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      sentinel.kill()
      await sentinelClosed
      await cleanupNativeFixture(owned)
    }
  },
  20000,
)
