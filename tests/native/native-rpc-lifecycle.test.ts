import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import {
  cleanupNativeFixture,
  isolatedEnv,
  LoopbackProvider,
  NativeRpc,
  NativeProcessSet,
  NativeProcessOwner,
  NativeStderrStages,
  ownedRoot,
  within,
} from './native-harness.js'

function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it('releases an OS-rejected spawn without inventing a Job-empty receipt', async () => {
  const owned = await ownedRoot()
  try {
    const rpc = await NativeRpc.create(
      process.execPath,
      join(owned.root, 'missing-cwd'),
      isolatedEnv(owned.root, owned.home),
      { processes: owned.processes },
    )
    let spawnError: Error | undefined
    rpc.child.once('error', (error) => {
      spawnError = error
    })
    await within(rpc.exited, 2000, 'OS spawn rejection was not observed')
    expect(spawnError).toMatchObject({ code: 'ENOENT' })
    await rpc.close()
    expect(rpc.cleanupFacts()).toMatchObject({
      released: true,
      childExit: false,
      childClosed: true,
      pendingRequests: 0,
      helperReleased: true,
      windowsJobEmpty: null,
    })
    const scopes = owned.processes.facts()
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toMatchObject({
      admitted: false,
      spawnFailedBeforeStart: true,
      released: true,
    })
  } finally {
    await cleanupNativeFixture(owned)
  }
})

const stageLine = (
  message: string,
  target = 'codex_app_server_transport::transport::stdio',
  level = 'INFO',
) =>
  JSON.stringify({
    target,
    level,
    fields: { message },
    span: { privateValue: 'private-秘密-canary' },
  })

it('projects only fixed stderr stages across chunk and UTF-8 boundaries without retaining log content', () => {
  const probe = new NativeStderrStages()
  probe.push(Buffer.from(stageLine('processor task exited', 'codex_app_server') + '\n'))
  probe.start()
  const bytes = Buffer.from(stageLine('stdin reader finished (EOF)', undefined, 'DEBUG') + '\n')
  const split = bytes.indexOf(Buffer.from('秘')) + 1
  probe.push(bytes.subarray(0, split))
  probe.push(bytes.subarray(split))
  probe.push(
    Buffer.from(
      [
        stageLine('stdout writer exited (channel closed)'),
        stageLine('processor task exited', 'codex_app_server'),
        stageLine('stdin reader finished (EOF)', undefined, 'DEBUG'),
        stageLine('processor task exited', 'unrelated_target'),
        stageLine('private-unknown-event'),
        '{not-json',
      ].join('\n') + '\n',
    ),
  )
  probe.end()
  const observation = probe.stop()
  expect(observation.stages.map((entry) => entry.stage)).toEqual([
    'stdin-reader-finished',
    'stdout-writer-finished',
    'processor-exited',
  ])
  expect(
    observation.stages.every(
      (entry) => Number.isSafeInteger(entry.observedMs) && entry.observedMs >= 0,
    ),
  ).toBe(true)
  expect(observation).toMatchObject({
    lineOverflow: false,
    partialLineAtSnapshot: false,
    stderrEnded: true,
  })
  expect(JSON.stringify(observation)).not.toContain('private-')
  observation.stages.length = 0
  expect(probe.stop().stages).toHaveLength(3)
})

it('bounds overlong stderr lines, resumes at LF and handles a bounded EOF tail', () => {
  const probe = new NativeStderrStages()
  probe.start()
  probe.push(Buffer.from('sensitive'.repeat(600)))
  probe.push(Buffer.from('\n' + stageLine('processor task exited', 'codex_app_server')))
  probe.end()
  expect(probe.stop()).toMatchObject({
    stages: [{ stage: 'processor-exited' }],
    lineOverflow: true,
    partialLineAtSnapshot: false,
    stderrEnded: true,
  })
})

it('freezes a partial stderr snapshot at stop and ignores later input, EOF and restart', () => {
  const probe = new NativeStderrStages()
  probe.start()
  const bytes = Buffer.from(stageLine('processor task exited', 'codex_app_server'))
  probe.push(bytes.subarray(0, bytes.length - 1))
  const snapshot = probe.stop()
  expect(snapshot).toEqual({
    stages: [],
    lineOverflow: false,
    partialLineAtSnapshot: true,
    stderrEnded: false,
  })
  probe.push(bytes.subarray(bytes.length - 1))
  probe.push(Buffer.from('\n' + stageLine('processor task exited', 'codex_app_server') + '\n'))
  probe.end()
  probe.start()
  expect(probe.stop()).toEqual(snapshot)
})

it('closes a preparation ticket before disposal returns and never starts its late child', async () => {
  const owned = await ownedRoot()
  const held = gate()
  const prepared = gate()
  const prepare = NativeProcessOwner.prepare.bind(NativeProcessOwner)
  const observation = vi
    .spyOn(NativeProcessOwner, 'prepare')
    .mockImplementation(async (...args) => {
      const owner = await prepare(...args)
      prepared.resolve()
      await held.promise
      return owner
    })
  let invocation: Promise<unknown> | undefined
  try {
    invocation = owned.processes.spawnOwnedAsync(
      process.execPath,
      ['-e', 'process.stdin.resume();'],
      { cwd: owned.cwd, env: isolatedEnv(owned.root, owned.home), shell: false },
      performance.now() + 50_000,
    )
    void invocation.catch(() => undefined)
    await prepared.promise
    let closed = false
    const originalClosing = owned.processes.close()
    const closing = originalClosing.then(() => {
      closed = true
      return undefined
    })
    expect(owned.processes.close()).toBe(originalClosing)
    expect(() => owned.processes.spawnOwned(process.execPath, [], { cwd: owned.cwd })).toThrow(
      'closing',
    )
    await expect(
      owned.processes.spawnOwnedAsync(
        process.execPath,
        [],
        { cwd: owned.cwd },
        performance.now() + 50_000,
      ),
    ).rejects.toThrow('closing')
    await Promise.resolve()
    expect(closed).toBe(false)
    expect((await stat(owned.root)).isDirectory()).toBe(true)
    held.resolve()
    await expect(invocation).rejects.toThrow('closing')
    await closing
    expect(owned.processes.facts()).toEqual([
      expect.objectContaining({ admitted: false, released: true, helperReleased: true }),
    ])
    await cleanupNativeFixture(owned)
    await expect(stat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    held.resolve()
    observation.mockRestore()
    await invocation?.catch(() => undefined)
    await owned.processes.close().catch(() => undefined)
    if (owned.processes.facts().every((fact) => fact.released))
      await rm(owned.root, { recursive: true, force: true })
  }
})

it('rechecks an unadmitted owner once after genuine group release and never removes its confirmed helper twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-native-prepared-recovery-'))
  const owner = await NativeProcessOwner.prepare(process.execPath, root, performance.now() + 30_000)
  const failure = new Error('Controlled unadmitted group failure')
  const groupClose = vi.spyOn(owner.group, 'close').mockRejectedValueOnce(failure)
  try {
    const original = owner.close()
    await expect(original).rejects.toBe(failure)
    expect(owner.facts().released).toBe(false)
    expect(() => owner.start([], { cwd: root })).toThrow('admission is obsolete')
    groupClose.mockRestore()
    await owner.group.close()
    const repaired = owner.close({ recheck: true })
    await repaired
    expect(owner.facts()).toMatchObject({
      admitted: false,
      groupReleased: true,
      controlClosed: true,
      helperReleased: true,
      released: true,
    })
    expect(owner.close({ recheck: true })).toBe(repaired)
    expect(() => owner.start([], { cwd: root })).toThrow('admission is obsolete')
  } finally {
    groupClose.mockRestore()
    await owner.group.close()
    await owner.close({ recheck: true }).catch(() => undefined)
    if (owner.facts().released) await rm(root, { recursive: true, force: true })
  }
})

it('retains recovery data when a genuine client rejects cleanup despite confirmed physical release', async () => {
  const owned = await ownedRoot(),
    protocol = await protocolChild()
  const observe = vi
    .spyOn(protocol.group, 'observe')
    .mockRejectedValueOnce(new Error('Controlled preliminary observation failure'))
  try {
    await expect(protocol.client.close()).rejects.toThrow(
      'Controlled preliminary observation failure',
    )
    expect(protocol.client.cleanupFacts()).toMatchObject({
      phase: 'released-with-errors',
      released: true,
      helperReleased: true,
    })
    await expect(cleanupNativeFixture(owned, { clients: [protocol.client] })).rejects.toThrow(
      'recovery data retained',
    )
    expect((await stat(owned.root)).isDirectory()).toBe(true)
  } finally {
    observe.mockRestore()
    await protocol.client.close().catch(() => undefined)
    await owned.processes.close()
    if (protocol.client.cleanupFacts().released) {
      await rm(protocol.directory, { recursive: true, force: true })
      await rm(owned.root, { recursive: true, force: true })
    }
  }
})

it('attempts every genuine process/provider cleanup and retains the root after an earlier owner rejects', async () => {
  const owned = await ownedRoot()
  const provider = new LoopbackProvider()
  const first = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error('Controlled disposal failure'))
    .mockResolvedValue(undefined)
  const second = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  try {
    await provider.start()
    await owned.processes.prepare(process.execPath, 1, performance.now() + 10_000)
    const processOwner = owned.processes.spawnOwned(
      process.execPath,
      ['-e', 'process.stdin.resume();'],
      {
        cwd: owned.cwd,
        env: isolatedEnv(owned.root, owned.home),
        shell: false,
      },
    )
    // This case requires an admitted real child. On Windows the returned Child
    // initially represents its Job helper, before authenticated target startup.
    await processOwner.started()
    const child = processOwner.child
    await expect(
      cleanupNativeFixture(owned, {
        adapters: [{ dispose: first }, { dispose: second }],
        provider,
      }),
    ).rejects.toThrow('recovery data retained')
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(owned.processes.facts()).toEqual([
      expect.objectContaining({
        admitted: true,
        childClosed: true,
        groupReleased: true,
        released: true,
      }),
    ])
    expect(provider.server.listening).toBe(false)
    expect((await stat(owned.root)).isDirectory()).toBe(true)
    // The controlled rejection is acknowledged before the second, genuine cleanup
    // receipt permits directory removal. No original failed receipt is rewritten.
    await cleanupNativeFixture(owned, {
      adapters: [{ dispose: first }, { dispose: second }],
      provider,
    })
    await expect(stat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await owned.processes.close().catch(() => undefined)
    await provider.close().catch(() => undefined)
    if (owned.processes.facts().every((facts) => facts.released))
      await rm(owned.root, { recursive: true, force: true })
  }
})

it('retains ownership when child close cleanup has not settled before its deadline', async () => {
  const owned = await protocolChild()
  const held = gate()
  const originalClosed: unknown = Reflect.get(owned.client, 'closed')
  if (!(originalClosed instanceof Promise)) throw new Error('Missing Native close settlement seam')
  // Real child/group release remains genuine; only the final async launcher-cleanup
  // settlement is held, as on a slow Windows filesystem. This is not Windows OS proof.
  Reflect.set(
    owned.client,
    'closed',
    originalClosed.then(() => held.promise),
  )
  try {
    await expect(owned.client.close()).rejects.toThrow('Owned child close deadline')
    await owned.childClosed
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts().released).toBe(false)
    expect(owned.client.cleanupFacts().phase).toBe('unconfirmed')
    expect(owned.onReleased).not.toHaveBeenCalled()
  } finally {
    held.resolve()
    await originalClosed
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    await owned.client.close({ recheck: true })
    expect(owned.client.cleanupFacts()).toMatchObject({ released: true, helperReleased: true })
    expect(owned.client.cleanupFacts().previousAttempt).toMatchObject({
      phase: 'unconfirmed',
      released: false,
    })
    if (owned.group.released && owned.client.cleanupFacts().released)
      await rm(owned.directory, { recursive: true, force: true })
  }
})

async function protocolChild(
  withGroup = true,
  initialize = true,
): Promise<{
  directory: string
  group: OwnedProcessGroup
  client: NativeRpc
  onReleased: ReturnType<typeof vi.fn<() => void>>
  childClosed: Promise<void>
  eofPath: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-rpc-lifecycle-'))
  const eofPath = join(directory, 'eof')
  const group = new OwnedProcessGroup()
  let client: NativeRpc | undefined
  try {
    // Node receives NativeRpc's actual app-server argv. This bounded protocol child
    // acknowledges initialization, deliberately leaves hold pending, and records EOF.
    await writeFile(
      join(directory, 'app-server'),
      `const fs = require('node:fs');
const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize' && ${!initialize}) {
    process.stdout.write(JSON.stringify({ id: 999, result: { private: 'private-native-observation-payload' } }) + '\\n' + 'private-native-partial-frame');
    process.stderr.write('private-native-stderr');
    return;
  }
  if (request.id && request.method !== 'hold') process.stdout.write(JSON.stringify({ id: request.id, result: {} }) + '\\n');
});
input.once('close', () => { fs.writeFileSync(${JSON.stringify(eofPath)}, 'natural-eof'); });
`,
      { mode: 0o600 },
    )
    const onReleased = vi.fn<() => void>()
    client = await NativeRpc.create(
      process.execPath,
      directory,
      {
        PATH: process.env.PATH,
        HOME: directory,
        USERPROFILE: directory,
        TMPDIR: directory,
        TEMP: directory,
      },
      {
        group: withGroup ? group : undefined,
        onReleased,
        processes: new NativeProcessSet(directory),
      },
    )
    const created = client
    const childClosed = new Promise<void>((done) => created.child.once('close', () => done()))
    if (initialize) await client.initialize()
    if (withGroup) await group.observe()
    return { directory, group, client, onReleased, childClosed, eofPath }
  } catch (error) {
    await client?.close().catch(() => undefined)
    await group.close()
    if (group.released && (!client || client.cleanupFacts().released))
      await rm(directory, { recursive: true, force: true })
    throw error
  }
}

it('freezes bounded scalar observations at the first initialize timeout before failure or cleanup', async () => {
  const owned = await protocolChild(true, false)
  const partial = 'private-native-partial-frame',
    stderr = 'private-native-stderr'
  const unmatched = `${JSON.stringify({ id: 999, result: { private: 'private-native-observation-payload' } })}\n${partial}`
  const stdoutReceived = gate(),
    stderrReceived = gate()
  let stdoutBytes = 0,
    stderrBytes = 0
  const stdout = (data: Buffer): void => {
    stdoutBytes += data.length
    if (stdoutBytes >= Buffer.byteLength(unmatched)) stdoutReceived.resolve()
  }
  const errors = (data: Buffer): void => {
    stderrBytes += data.length
    if (stderrBytes >= Buffer.byteLength(stderr)) stderrReceived.resolve()
  }
  const timers = vi.spyOn(globalThis, 'setTimeout')
  try {
    // A genuine earlier reply distinguishes matched replies from the unrelated ID below.
    await owned.client.request('probe', {})
    timers.mockClear()
    expect(owned.client.cleanupFacts()).not.toHaveProperty('initializeTimeout')
    owned.client.child.stdout.on('data', stdout)
    owned.client.child.stderr.on('data', errors)
    const initialized = owned.client.initialize().catch((error: unknown) => error)
    await within(
      Promise.all([stdoutReceived.promise, stderrReceived.promise]),
      2000,
      'Controlled initialize output was not observed',
    )
    const index = timers.mock.calls.findIndex((args) => args[1] === 10_000)
    const call = timers.mock.calls[index],
      scheduled = timers.mock.results[index]
    if (!call || scheduled?.type !== 'return')
      throw new Error('Missing existing initialize deadline')
    // Invoke that existing deadline callback after real pipe observations; do not wait 10s
    // or change the fixture's actual request/startup/lifetime deadlines and ordering.
    clearTimeout(scheduled.value)
    call[0]()
    timers.mockRestore()
    expect(await initialized).toMatchObject({
      message: 'unknown_delivery: initialize exceeded 10s',
    })
    const snapshot = owned.client.cleanupFacts().initializeTimeout
    if (!snapshot) throw new Error('Missing first initialize timeout observation')
    expect(snapshot).toMatchObject({
      writeCallbackDone: true,
      writeCallbackError: false,
      stdoutBytes: Buffer.byteLength(`${JSON.stringify({ id: 1, result: {} })}\n`) + stdoutBytes,
      stderrBytes,
      partialFrameBytes: Buffer.byteLength(partial),
      matchingReplies: 1,
      unmatchedReplies: 1,
      childExit: false,
      childClosed: false,
      stdinWritable: true,
    })
    expect(snapshot.elapsedMs).toEqual(expect.any(Number))
    expect(snapshot.writeCallbackElapsedMs).toEqual(expect.any(Number))
    expect(
      Object.values(snapshot).every(
        (value) =>
          typeof value !== 'number' ||
          (Number.isSafeInteger(value) && value >= 0 && value <= 8 * 1024 * 1024),
      ),
    ).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1024)
    expect(JSON.stringify(snapshot)).not.toContain('private-native')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Reflect.set(snapshot, 'stdoutBytes', 0)).toBe(false)
    expect(owned.client.cleanupFacts().pendingRequests).toBe(0)
    await expect(owned.client.request('initialize', {})).rejects.toThrow('initialize exceeded 10s')
    const late = gate()
    owned.client.child.stdout.once('data', () => late.resolve())
    owned.client.child.stdin.write(`${JSON.stringify({ id: 500, method: 'probe', params: {} })}\n`)
    await within(late.promise, 2000, 'Later owned protocol output was not observed')
    expect(owned.client.cleanupFacts().initializeTimeout).toBe(snapshot)
    await owned.client.close()
    await owned.childClosed
    expect(owned.client.cleanupFacts()).toMatchObject({ released: true, childClosed: true })
    expect(owned.client.cleanupFacts().initializeTimeout).toBe(snapshot)
    expect(snapshot.childClosed).toBe(false)
    expect(snapshot.stdinWritable).toBe(true)
  } finally {
    timers.mockRestore()
    owned.client.child.stdout.off('data', stdout)
    owned.client.child.stderr.off('data', errors)
    await owned.client.close().catch(() => undefined)
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    await owned.client.close({ recheck: true }).catch(() => undefined)
    if (owned.group.released && owned.client.cleanupFacts().released)
      await rm(owned.directory, { recursive: true, force: true })
  }
})

it('settles pending requests and shares one close after real child and group release', async () => {
  const owned = await protocolChild()
  const pending = owned.client.request('hold', {}).catch((error: unknown) => error)
  try {
    const closing = owned.client.close()
    expect(owned.client.close()).toBe(closing)
    const admitted = owned.client.methods.length
    await expect(owned.client.request('after-closing', {})).rejects.toThrow(/clos/iu)
    expect(owned.client.methods).toHaveLength(admitted)
    await closing
    await owned.childClosed
    expect(await pending).toBeInstanceOf(Error)
    expect(await readFile(owned.eofPath, 'utf8')).toBe('natural-eof')
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts()).toMatchObject({
      childExit: true,
      childClosed: true,
      stdinEnded: true,
      groupReleased: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(owned.client.close()).toBe(closing)
  } finally {
    await owned.client.close().catch(() => undefined)
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await owned.client.close({ recheck: true }).catch(() => undefined)
    expect(owned.client.cleanupFacts()).toMatchObject({
      released: true,
      helperReleased: true,
      closeSettled: true,
    })
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('confirms an observed group after the protocol child has already exited naturally', async () => {
  const owned = await protocolChild()
  try {
    owned.client.child.stdin.end()
    await within(owned.childClosed, 2000, 'Natural protocol child did not close')
    await expect(owned.client.close()).resolves.toBeUndefined()
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts()).toMatchObject({
      childClosed: true,
      groupReleased: true,
      helperReleased: true,
      released: true,
    })
  } finally {
    await owned.client.close().catch(() => undefined)
    await owned.group.close().catch(() => undefined)
    if (owned.group.released && owned.client.cleanupFacts().released)
      await rm(owned.directory, { recursive: true, force: true })
  }
})

it('closes a factory owner with a late-born helper before deleting its root', async () => {
  const owned = await ownedRoot()
  let helperPid: number | undefined
  let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  try {
    await writeFile(
      join(owned.cwd, 'late-helper.cjs'),
      `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
process.stdout.write('ready\\n');
const input = readline.createInterface({ input: process.stdin });
input.once('line', () => {
  const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000); setTimeout(()=>process.exit(0),5000); process.stdout.write("ready");'], { stdio: ['ignore', 'pipe', 'ignore'] });
  helper.stdout.once('data', () => {
    process.stdout.write(JSON.stringify({ pid: helper.pid }) + '\\n');
    helper.stdout.destroy(); helper.unref();
  });
});
input.once('close', () => process.exit(0));
`,
    )
    await owned.processes.prepare(process.execPath, 1, performance.now() + 10_000)
    const handle = owned.processes.spawnOwned(process.execPath, ['late-helper.cjs'], {
      cwd: owned.cwd,
      env: isolatedEnv(owned.root, owned.home),
      shell: false,
    })
    child = handle.child
    let pending = ''
    const ready = Promise.withResolvers<void>()
    const helper = Promise.withResolvers<number>()
    child.stdout.on('data', (bytes: Buffer) => {
      pending += bytes.toString('utf8')
      if (pending.length > 1024) throw new Error('Late helper fixture exceeds its bound')
      for (;;) {
        const end = pending.indexOf('\n')
        if (end < 0) break
        const line = pending.slice(0, end)
        pending = pending.slice(end + 1)
        if (line === 'ready') ready.resolve()
        else {
          const result: unknown = JSON.parse(line)
          const pid: unknown =
            result && typeof result === 'object' ? Reflect.get(result, 'pid') : undefined
          if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
            throw new Error('Invalid late helper identity')
          helper.resolve(pid)
        }
      }
    })
    await within(ready.promise, 2000, 'Late helper root did not start')
    await handle.observe()
    child.stdin.write('spawn\n')
    helperPid = await within(helper.promise, 2000, 'Late helper did not start')
    await expect(handle.close()).resolves.toBeUndefined()
    expect(owned.processes.facts()).toEqual([
      expect.objectContaining({
        admitted: true,
        childClosed: true,
        groupReleased: true,
        released: true,
      }),
    ])
    expect(() => process.kill(helperPid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    let platformReleased = owned.processes.facts()[0]?.windowsJobEmpty === true
    if (process.platform !== 'win32') {
      try {
        process.kill(-child.pid!, 0)
        platformReleased = false
      } catch (error) {
        platformReleased = Boolean(
          error && typeof error === 'object' && Reflect.get(error, 'code') === 'ESRCH',
        )
      }
    }
    expect(platformReleased).toBe(true)
    await cleanupNativeFixture(owned)
    await expect(stat(owned.root)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await owned.processes.close().catch(() => undefined)
    if (owned.processes.facts().every((fact) => fact.released))
      await rm(owned.root, { recursive: true, force: true })
  }
})

it('continues EOF and physical release after the single ownership observation rejects', async () => {
  const owned = await protocolChild()
  const failure = new Error('Controlled ownership observation failure')
  const observe = vi.spyOn(owned.group, 'observe').mockRejectedValueOnce(failure)
  try {
    const closing = owned.client.close()
    await expect(closing).rejects.toBe(failure)
    expect(owned.client.close()).toBe(closing)
    await within(owned.childClosed, 2000, 'Rejected observation prevented real child closure')
    expect(await readFile(owned.eofPath, 'utf8')).toBe('natural-eof')
    expect(owned.group.released).toBe(true)
    expect(owned.client.cleanupFacts()).toMatchObject({
      phase: 'released-with-errors',
      childClosed: true,
      stdinEnded: true,
      groupReleased: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
    const facts = owned.client.cleanupFacts()
    expect(facts.stages).toContainEqual({
      stage: 'observe',
      milliseconds: expect.any(Number),
      errorClass: 'Error',
    })
    expect(facts.stages.length).toBeLessThanOrEqual(7)
    expect(
      facts.stages.every(
        (stage) =>
          Object.keys(stage).toSorted().join(',') === 'errorClass,milliseconds,stage' &&
          Number.isSafeInteger(stage.milliseconds) &&
          stage.milliseconds >= 0,
      ),
    ).toBe(true)
    expect(JSON.stringify(facts)).not.toContain(failure.message)
    expect(observe).toHaveBeenCalledOnce()
    expect(owned.onReleased).toHaveBeenCalledOnce()
  } finally {
    observe.mockRestore()
    await owned.client.close().catch(() => undefined)
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await owned.client.close({ recheck: true }).catch(() => undefined)
    expect(owned.client.cleanupFacts()).toMatchObject({
      released: true,
      helperReleased: true,
      closeSettled: true,
    })
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('keeps release notification behind the real process-group release gate', async () => {
  const owned = await protocolChild()
  const held = gate()
  const originalClose = owned.group.close.bind(owned.group)
  const close = vi.spyOn(owned.group, 'close').mockImplementation(async () => {
    await held.promise
    await originalClose()
  })
  try {
    const closing = owned.client.close()
    await within(owned.childClosed, 2000, 'Natural EOF did not close the controlled protocol child')
    expect(owned.group.released).toBe(false)
    expect(owned.client.cleanupFacts()).toMatchObject({ childClosed: true, released: false })
    expect(owned.onReleased).not.toHaveBeenCalled()
    expect(owned.client.close()).toBe(closing)
    held.resolve()
    await closing
    expect(owned.group.released).toBe(true)
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(close).toHaveBeenCalledOnce()
  } finally {
    held.resolve()
    close.mockRestore()
    await owned.client.close().catch(() => undefined)
    await originalClose()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    await owned.client.close({ recheck: true }).catch(() => undefined)
    expect(owned.client.cleanupFacts()).toMatchObject({
      released: true,
      helperReleased: true,
      closeSettled: true,
    })
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('does not notify release when the group remains unconfirmed despite real child closure', async () => {
  const owned = await protocolChild()
  const failure = new Error('Controlled group release failure')
  const close = vi.spyOn(owned.group, 'close').mockRejectedValueOnce(failure)
  try {
    const closing = owned.client.close()
    await expect(closing).rejects.toBe(failure)
    await owned.childClosed
    expect(owned.group.released).toBe(false)
    expect(owned.client.cleanupFacts()).toMatchObject({
      phase: 'unconfirmed',
      childClosed: true,
      groupReleased: false,
      pendingRequests: 0,
      released: false,
    })
    expect(owned.onReleased).not.toHaveBeenCalled()
    expect(owned.client.close()).toBe(closing)
    await expect(owned.client.close()).rejects.toBe(failure)
    expect(close).toHaveBeenCalledOnce()
  } finally {
    close.mockRestore()
    await owned.group.close()
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    expect(owned.group.released).toBe(true)
    expect(owned.onReleased).not.toHaveBeenCalled()
    await owned.client.close({ recheck: true }).catch(() => undefined)
    expect(owned.client.cleanupFacts()).toMatchObject({
      released: true,
      helperReleased: true,
      closeSettled: true,
    })
    await rm(owned.directory, { recursive: true, force: true })
  }
})

it('confirms real child and default fixture-owner closure before notifying release', async () => {
  const owned = await protocolChild(false)
  expect(owned.client.cleanupFacts()).not.toHaveProperty('initializeTimeout')
  const closeEvent = vi.fn<() => void>()
  owned.client.child.once('close', closeEvent)
  try {
    await owned.client.close()
    expect(closeEvent).toHaveBeenCalledOnce()
    expect(owned.onReleased).toHaveBeenCalledOnce()
    expect(owned.onReleased.mock.invocationCallOrder[0]).toBeGreaterThan(
      closeEvent.mock.invocationCallOrder[0]!,
    )
    expect(owned.client.cleanupFacts()).toMatchObject({
      childExit: true,
      childClosed: true,
      pendingRequests: 0,
      lifetimeReleased: true,
      released: true,
    })
  } finally {
    await owned.client.close().catch(() => undefined)
    await within(owned.childClosed, 4000, 'Controlled protocol child did not close')
    await owned.group.close()
    await owned.client.close({ recheck: true }).catch(() => undefined)
    expect(owned.client.cleanupFacts()).toMatchObject({
      released: true,
      helperReleased: true,
      closeSettled: true,
    })
    await rm(owned.directory, { recursive: true, force: true })
  }
})
