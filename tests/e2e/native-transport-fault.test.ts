import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { runInNewContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  writeNativeTransportFault,
  type NativeTransportFaultFiles,
} from './native-transport-fault.js'
import { windowsFixtureRenameSource } from './windows-fixture-rename.js'

function publish(code: string, failures: number, advanceClock = true, deadlineMs = 50) {
  let now = 0
  const calls: Array<[string, string]> = []
  const failure = Object.assign(new Error('publish failed'), { code })
  const run = (): void => {
    runInNewContext(
      `${windowsFixtureRenameSource}\nwindowsFixtureRename('candidate', 'facts', deadlineMs)`,
      {
        deadlineMs,
        performance: { now: () => now },
        Atomics: {
          wait: (_array: unknown, _index: number, _value: number, ms: number) => {
            if (advanceClock) now += ms
          },
        },
        renameSync: (source: string, target: string) => {
          calls.push([source, target])
          if (calls.length <= failures) throw failure
        },
      },
    )
  }
  return { run, calls, failure, elapsed: () => now }
}

describe('Windows fixture atomic publication bounds', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries the same candidate on %s', (code) => {
    const probe = publish(code, 2)
    probe.run()
    expect(probe.calls).toEqual(Array.from({ length: 3 }, () => ['candidate', 'facts']))
    expect(probe.elapsed()).toBe(3)
  })

  it('preserves the original failure at the 50ms deadline', () => {
    const probe = publish('EPERM', Infinity)
    expect(probe.run).toThrow(probe.failure)
    expect(probe.elapsed()).toBe(50)
    expect(probe.calls.length).toBeLessThanOrEqual(32)
  })

  it('stops at 32 attempts even if the monotonic clock has not advanced', () => {
    const probe = publish('EPERM', Infinity, false)
    expect(probe.run).toThrow(probe.failure)
    expect(probe.calls).toHaveLength(32)
  })

  it('does not retry other failures', () => {
    const probe = publish('ENOENT', Infinity)
    expect(probe.run).toThrow(probe.failure)
    expect(probe.calls).toHaveLength(1)
    expect(probe.elapsed()).toBe(0)
  })
})

interface WirePacket {
  id?: number
  method?: string
  result?: { thread?: { id: string }; injected?: boolean }
  error?: { message: string }
  params?: { delta?: string }
}
interface RelayFacts {
  appServer: boolean
  nativeInterruptionEnabled: boolean
  actualChildPid: number | null
  actualExecutable: string
  actualVersion?: string
  closed: boolean
  exitCode: number | null
  exitSignal: string | null
  pendingRequests: number
  forwardedTurns: number
  droppedAcks: number
  evictedEntries: number
  faultPhase: string
  stopReason?: string
  candidateNativeSessionId?: string
  entries: Array<{ kind: string; method?: string; nativeSessionId?: string; id?: number }>
}
interface Client {
  child: ChildProcessWithoutNullStreams
  closed: Promise<void>
  packets: WirePacket[]
  stdout: string
}

// This suite tests relay mechanics only. The executable below is deliberately
// synthetic and cannot count as Native/provider/business E2E evidence.
describe.skipIf(process.platform === 'win32')('Native transport relay protocol mechanics', () => {
  let root: string
  let actual: string
  let clients: Client[]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pact-native-relay-unit-'))
    actual = join(root, 'controlled-protocol.mjs')
    clients = []
    await writeFile(actual, `#!${process.execPath}\n${controlledProtocol}`, { mode: 0o700 })
    await chmod(actual, 0o700)
  })

  afterEach(async () => {
    for (const client of clients) {
      if (client.child.exitCode === null && client.child.signalCode === null)
        client.child.kill('SIGTERM')
    }
    await Promise.all(clients.map((client) => client.closed))
    await rm(root, { recursive: true, force: true })
  })

  function start(
    files: NativeTransportFaultFiles,
    args = ['app-server'],
    extraEnvironment: Record<string, string> = {},
  ): Client {
    if (clients.length >= 4) throw new Error('A protocol test owns at most four relays')
    const child = spawn(files.executablePath, args, {
      cwd: root,
      env: {
        HOME: root,
        CODEX_HOME: join(root, 'codex'),
        RELAY_UNIT_VALUE: 'isolated-value',
        ...extraEnvironment,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client: Client = {
      child,
      packets: [],
      stdout: '',
      closed: new Promise((resolve) => child.once('close', () => resolve())),
    }
    const reader = createInterface({ input: child.stdout })
    reader.on('line', (line) => {
      if (Buffer.byteLength(line) > 1024 * 1024)
        throw new Error('Protocol observer frame budget exceeded')
      client.stdout = (client.stdout + line + '\n').slice(-64 * 1024)
      try {
        const parsed: WirePacket = JSON.parse(line)
        if (client.packets.length >= 64) client.packets.shift()
        client.packets.push(parsed)
      } catch {
        // Version/auth output is intentionally not JSON.
      }
    })
    child.stderr.resume()
    child.once('close', () => reader.close())
    clients.push(client)
    return client
  }

  it('publishes a complete fact record at the first filesystem visibility boundary', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-turn')
    const observer = join(root, 'observe-first-publication.mjs')
    const observation = join(root, 'first-publication.json')
    await writeFile(
      observer,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const write = fs.writeFileSync;
const rename = fs.renameSync;
const read = fs.readFileSync;
const destination = ${JSON.stringify(files.factsPath)};
const observation = ${JSON.stringify(observation)};
let observed = false;
function capture(path) {
  if (observed || typeof path !== 'string' || !path.startsWith(destination + '/') || !path.endsWith('.json')) return;
  observed = true;
  write(observation, read(path), { flag: 'wx', mode: 0o600 });
}
fs.writeFileSync = (...args) => { const result = write(...args); capture(args[0]); return result; };
fs.renameSync = (...args) => { const result = rename(...args); capture(args[1]); return result; };
syncBuiltinESMExports();`,
      { mode: 0o600 },
    )
    const client = start(files, ['--version'], { NODE_OPTIONS: `--import=${observer}` })
    client.child.stdin.end()
    await client.closed
    const first: RelayFacts & { relayPid: number } = JSON.parse(await readFile(observation, 'utf8'))
    expect(first.relayPid).toBe(client.child.pid)
    expect(first.closed).toBe(false)
    expect(first.forwardedTurns).toBe(0)
    expect(first.entries).toEqual([])
    expect(first.actualExecutable).toBe(await realpath(actual))
  })

  async function facts(files: NativeTransportFaultFiles): Promise<RelayFacts[]> {
    const names = (await readdir(files.factsPath)).filter((name) => name.endsWith('.json'))
    if (names.length > 64) throw new Error('Protocol facts directory capacity exceeded')
    return Promise.all(
      names.map(async (name) => {
        const text = await readFile(join(files.factsPath, name), 'utf8')
        if (Buffer.byteLength(text) > 64 * 1024)
          throw new Error('Protocol facts byte budget exceeded')
        const value: RelayFacts = JSON.parse(text)
        return value
      }),
    )
  }

  it('delegates real arguments/version/auth commands unchanged without applying an app-server fault', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-turn')
    const version = start(files, ['--version'])
    version.child.stdin.end()
    await version.closed
    expect(version.stdout).toBe('codex-cli 9.8.7-protocol\n')
    expect(version.child.exitCode).toBe(0)
    const login = start(files, ['login', 'status'])
    login.child.stdin.end()
    await login.closed
    expect(login.stdout).toBe('Synthetic status isolated-value\n')
    expect(login.child.exitCode).toBe(0)
    const rows = await facts(files)
    const canonical = await realpath(actual)
    expect(rows).toHaveLength(2)
    expect(
      rows.every((row) => row.actualExecutable === canonical && row.closed && row.actualChildPid),
    ).toBe(true)
    expect(rows.find((row) => row.actualVersion)?.actualVersion).toBe('9.8.7-protocol')
    expect(JSON.stringify(rows)).not.toContain('isolated-value')
  })

  it('drops only one successful actual turn ACK and forwards errors and model packets byte-for-byte', async () => {
    const files = await writeNativeTransportFault(root, actual, 'drop-turn-ack')
    const client = start(files)
    await ready(client)
    request(client, 3, 'turn/start', {
      reject: true,
      body: 'credential-body-must-never-be-recorded',
    })
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 3)?.error?.message)
      .toBe('Actual controlled rejection')
    request(client, 4, 'turn/start', {
      threadId: 'owned-thread',
      body: 'credential-body-must-never-be-recorded',
    })
    await expect
      .poll(() =>
        client.packets.some(
          (packet) => packet.params?.delta === 'UNCHANGED_MODEL_PROTOCOL_PAYLOAD',
        ),
      )
      .toBe(true)
    expect(client.packets.some((packet) => packet.id === 4)).toBe(false)
    request(client, 5, 'turn/start')
    await expect.poll(() => client.packets.some((packet) => packet.id === 5)).toBe(true)
    await expect.poll(async () => (await facts(files))[0]?.droppedAcks).toBe(1)
    const text = JSON.stringify(await facts(files))
    expect(text).not.toContain('credential-body-must-never-be-recorded')
    expect(text).not.toContain('UNCHANGED_MODEL_PROTOCOL_PAYLOAD')
    expect((await facts(files))[0]?.faultPhase).toBe('dropped-after-native')
  })

  it('preserves the Native interruption launch override while applying the selected protocol fault', async () => {
    const files = await writeNativeTransportFault(root, actual, 'drop-turn-ack')
    const client = start(files, ['--enable', 'code_mode_interrupt', 'app-server'])
    await ready(client)
    request(client, 3, 'turn/start')
    await expect.poll(async () => (await facts(files))[0]?.droppedAcks).toBe(1)
    expect(client.packets.some((packet) => packet.id === 3)).toBe(false)
    expect((await facts(files))[0]).toMatchObject({
      appServer: true,
      nativeInterruptionEnabled: true,
      forwardedTurns: 1,
    })
    expect(
      client.packets.some((packet) => packet.params?.delta === 'UNCHANGED_MODEL_PROTOCOL_PAYLOAD'),
    ).toBe(true)
  })

  it('mechanically drops one child ACK before holding exactly one inspection reply for fifteen seconds', async () => {
    const files = await writeNativeTransportFault(root, actual, 'drop-ack-and-block-inspection')
    const client = start(files)
    await ready(client)
    request(client, 3, 'thread/read')
    await expect.poll(() => client.packets.some((packet) => packet.id === 3)).toBe(true)
    expect((await facts(files))[0]?.faultPhase).toBe('none')
    request(client, 4, 'turn/start', { reject: true })
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 4)?.error?.message)
      .toBe('Actual controlled rejection')
    expect((await facts(files))[0]?.droppedAcks).toBe(0)
    request(client, 5, 'turn/start')
    await expect.poll(async () => (await facts(files))[0]?.droppedAcks).toBe(1)
    expect(client.packets.some((packet) => packet.id === 5)).toBe(false)
    request(client, 6, 'thread/read')
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-after-native')
    expect(client.packets.some((packet) => packet.id === 6)).toBe(false)
    request(client, 7, 'thread/read')
    await expect.poll(() => client.packets.some((packet) => packet.id === 7)).toBe(true)
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 6)?.result?.thread?.id, {
        timeout: 18_000,
        interval: 100,
      })
      .toBe('owned-thread')
    request(client, 8, 'turn/start')
    request(client, 9, 'thread/read')
    await expect
      .poll(() => client.packets.some((packet) => packet.id === 8 && packet.result !== undefined))
      .toBe(true)
    await expect.poll(() => client.packets.some((packet) => packet.id === 9)).toBe(true)
    const row = (await facts(files))[0]!
    expect(row.droppedAcks).toBe(1)
    expect(
      row.entries.filter((entry) => entry.kind === 'stdout-held').map((entry) => entry.id),
    ).toEqual([6])
    expect(row.entries.findIndex((entry) => entry.kind === 'stdout-dropped')).toBeLessThan(
      row.entries.findIndex((entry) => entry.kind === 'stdout-held'),
    )
    expect(row.entries.some((entry) => entry.kind === 'reply-deadline-released')).toBe(true)
  }, 20_000)

  it('forwards non-protocol authentication stdin including its final unterminated bytes before EOF', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-turn')
    const client = start(files, ['echo-input'])
    client.child.stdin.end('synthetic-private-input\nfinal-unterminated-bytes')
    await client.closed
    expect(client.child.exitCode).toBe(0)
    expect(client.stdout).toBe('synthetic-private-input\nfinal-unterminated-bytes\n')
    expect(JSON.stringify(await facts(files))).not.toContain('synthetic-private-input')
    expect(JSON.stringify(await facts(files))).not.toContain('final-unterminated-bytes')
  })

  it('holds an actual inspection reply while forwarding other actual events, then releases it unchanged', async () => {
    const files = await writeNativeTransportFault(root, actual, 'block-inspection')
    const client = start(files)
    await ready(client)
    request(client, 3, 'thread/read')
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-after-native')
    await expect
      .poll(() => client.packets.some((packet) => packet.method === 'thread/status/changed'))
      .toBe(true)
    expect(client.packets.some((packet) => packet.id === 3)).toBe(false)
    await command(files, 'release')
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 3)?.result?.thread?.id)
      .toBe('owned-thread')
  })

  it('settles a held actual inspection at its fifteen-second deadline without a parent release', async () => {
    const files = await writeNativeTransportFault(root, actual, 'block-inspection')
    const client = start(files)
    await ready(client)
    request(client, 3, 'thread/read')
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-after-native')
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 3)?.result?.thread?.id, {
        timeout: 18000,
        interval: 100,
      })
      .toBe('owned-thread')
    await expect
      .poll(async () =>
        (await facts(files))[0]?.entries.some((entry) => entry.kind === 'reply-deadline-released'),
      )
      .toBe(true)
  }, 20000)

  it('pause-turn release proves pre-native hold without a synthesized ACK', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-turn')
    const client = start(files)
    await ready(client)
    request(client, 3, 'turn/start')
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-before-native')
    expect((await facts(files))[0]?.forwardedTurns).toBe(0)
    expect(
      client.packets.some(
        (packet) => packet.id === 3 || packet.method === 'item/agentMessage/delta',
      ),
    ).toBe(false)
    await command(files, 'release')
    await expect.poll(() => client.packets.some((packet) => packet.id === 3)).toBe(true)
  })

  it.each(['pause-turn', 'pause-resume'] as const)(
    '%s cancel closes the actual child without native delivery',
    async (fault) => {
      const files = await writeNativeTransportFault(root, actual, fault)
      const client = start(files)
      await ready(client)
      request(client, 3, fault === 'pause-turn' ? 'turn/start' : 'thread/resume')
      await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-before-native')
      await command(files, 'cancel')
      await client.closed
      expect((await facts(files))[0]).toMatchObject({
        closed: true,
        forwardedTurns: 0,
        pendingRequests: 0,
        faultPhase: 'cancelled-before-native',
      })
    },
  )

  it('holds a resume before dispatch, releases its unchanged reply and settles at EOF', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-resume')
    const client = start(files)
    await ready(client)
    request(client, 3, 'thread/resume', { threadId: 'distinct-owned-resume' })
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-before-native')
    const held = (await facts(files))[0]!
    expect(held.forwardedTurns).toBe(0)
    expect(held.entries.some((entry) => entry.kind === 'stdin-forwarded' && entry.id === 3)).toBe(
      false,
    )
    expect(client.packets.some((packet) => packet.id === 3)).toBe(false)
    await command(files, 'release')
    await expect
      .poll(() => client.packets.find((packet) => packet.id === 3)?.result)
      .toEqual({
        thread: { id: 'distinct-owned-resume' },
        injected: false,
      })
    client.child.stdin.end()
    await client.closed
    expect((await facts(files))[0]).toMatchObject({
      closed: true,
      pendingRequests: 0,
      forwardedTurns: 0,
      faultPhase: 'released-before-native',
      stopReason: 'stdin-eof',
    })
    expect(
      (await facts(files))[0]!.entries.filter(
        (entry) => entry.kind === 'stdin-forwarded' && entry.id === 3,
      ),
    ).toHaveLength(1)
  })

  it('forwards the actual candidate ACK before holding initialization and preserves its real identity on close', async () => {
    const files = await writeNativeTransportFault(root, actual, 'hold-initialization')
    const client = start(files)
    await ready(client)
    request(client, 3, 'thread/inject_items', { items: ['do-not-record-source-body'] })
    await expect.poll(async () => (await facts(files))[0]?.faultPhase).toBe('held-after-native')
    expect(client.packets.some((packet) => packet.id === 3)).toBe(false)
    expect((await facts(files))[0]?.candidateNativeSessionId).toBe('owned-thread')
    expect(
      (await facts(files))[0]?.entries.some((entry) => entry.kind === 'candidate-ack-forwarded'),
    ).toBe(true)
    client.child.stdin.end()
    await client.closed
    expect((await facts(files))[0]).toMatchObject({
      closed: true,
      pendingRequests: 0,
      candidateNativeSessionId: 'owned-thread',
      faultPhase: 'cancelled-after-native',
    })
    expect(JSON.stringify(await facts(files))).not.toContain('do-not-record-source-body')
  })

  it.each(['frame', 'requests'] as const)(
    'fails closed at the %s bound and confirms actual child cleanup',
    async (bound) => {
      const files = await writeNativeTransportFault(root, actual, 'drop-turn-ack')
      const client = start(files)
      await ready(client)
      if (bound === 'frame') client.child.stdin.write(Buffer.alloc(1024 * 1024 + 1, 120))
      else for (let id = 3; id < 132; id += 1) request(client, id, 'silent/request')
      await client.closed
      expect((await facts(files))[0]).toMatchObject({
        closed: true,
        pendingRequests: 0,
        stopReason: bound === 'frame' ? 'frame-budget' : 'request-capacity',
      })
    },
  )

  it('caps retained method/event facts and never retains model bodies', async () => {
    const files = await writeNativeTransportFault(root, actual, 'drop-turn-ack')
    const client = start(files)
    await ready(client)
    request(client, 3, 'emit/events')
    await expect
      .poll(() => client.packets.some((packet) => packet.method === 'events/complete'))
      .toBe(true)
    await expect.poll(async () => (await facts(files))[0]?.evictedEntries ?? 0).toBeGreaterThan(0)
    const rows = await facts(files)
    expect(rows[0]?.entries.length).toBeLessThanOrEqual(512)
    expect(Buffer.byteLength(JSON.stringify(rows[0]))).toBeLessThanOrEqual(64 * 1024)
    expect(JSON.stringify(rows)).not.toContain('UNCHANGED_MODEL_PROTOCOL_PAYLOAD')
  })

  it('terminates only its actual child after the two-second graceful-close deadline', async () => {
    const files = await writeNativeTransportFault(root, actual, 'pause-turn')
    const client = start(files, ['app-server', '--ignore-term'])
    await ready(client)
    await command(files, 'cancel')
    request(client, 3, 'turn/start')
    await client.closed
    expect((await facts(files))[0]).toMatchObject({
      closed: true,
      exitSignal: 'SIGKILL',
      pendingRequests: 0,
    })
  }, 10_000)
})

async function command(
  files: NativeTransportFaultFiles,
  action: 'release' | 'cancel',
): Promise<void> {
  const temporary = files.controlPath + '.parent'
  await writeFile(
    temporary,
    JSON.stringify({ armed: action !== 'release', action, generation: 1 }),
    { mode: 0o600 },
  )
  await rename(temporary, files.controlPath)
}

function request(client: Client, id: number, method: string, params: object = {}): void {
  client.child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
}

async function ready(client: Client): Promise<void> {
  request(client, 1, 'initialize')
  await expect
    .poll(() => client.packets.some((packet) => packet.id === 1), { timeout: 3000 })
    .toBe(true)
  request(client, 2, 'thread/start')
  await expect
    .poll(() => client.packets.find((packet) => packet.id === 2)?.result?.thread?.id, {
      timeout: 3000,
    })
    .toBe('owned-thread')
}

const controlledProtocol = String.raw`
import { createInterface } from 'node:readline'
const args = process.argv.slice(2)
if (args[0] === '--version') { console.log('codex-cli 9.8.7-protocol'); process.exit(0) }
if (args[0] === 'login') { console.log('Synthetic status ' + process.env.RELAY_UNIT_VALUE); process.exit(0) }
if (args[0] === 'echo-input') {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => { input += data; if (input.length > 4096) process.exit(1) })
  process.stdin.on('end', () => { console.log(input); process.exit(0) })
} else {
const ignoreTerm = args.includes('--ignore-term')
if (ignoreTerm) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000) }
const output = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const reader = createInterface({ input: process.stdin })
reader.on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'silent/request') return
  if (request.method === 'turn/start' && request.params?.reject) {
    output({ id: request.id, error: { message: 'Actual controlled rejection' } })
    return
  }
  output({ id: request.id, result: { thread: { id: request.method === 'thread/resume' ? request.params?.threadId : 'owned-thread' }, injected: request.method === 'thread/inject_items' } })
  if (request.method === 'turn/start') output({ method: 'item/agentMessage/delta', params: { delta: 'UNCHANGED_MODEL_PROTOCOL_PAYLOAD' } })
  if (request.method === 'thread/read') output({ method: 'thread/status/changed', params: { threadId: 'owned-thread' } })
  if (request.method === 'emit/events') {
    for (let index = 0; index < 2048; index++) output({ method: 'thread/status/changed', params: { delta: 'UNCHANGED_MODEL_PROTOCOL_PAYLOAD' } })
    output({ method: 'events/complete', params: {} })
  }
})
reader.on('close', () => { if (!ignoreTerm) process.exit(0) })
}
`
