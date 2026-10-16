import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const parserWorker = vi.hoisted(() => ({ path: '' }))
vi.mock('node:worker_threads', async (original) => {
  const actual = await original<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(
        filename: ConstructorParameters<typeof actual.Worker>[0],
        options?: ConstructorParameters<typeof actual.Worker>[1],
      ) {
        super(
          String(filename).endsWith('native-json-parser-worker.js') ? parserWorker.path : filename,
          options,
        )
      }
    },
  }
})

import { LogicalIpcWorkerTraffic, logicalIpcMeasurement } from '../../shared/logical-ipc-traffic'
import { parseNativeJsonFrame } from './native-json-parser'
import { nativeWorkerFixture } from './native-workers-fixture.test-support'

let fixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  fixture = await nativeWorkerFixture(['native-json-parser-worker'])
  parserWorker.path = fixture.paths['native-json-parser-worker']!
}, 30_000)
afterAll(async () => {
  await fixture?.dispose()
})
const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

describe('actual Native parser Worker traffic', () => {
  it('records same-fixture off/on cost and confirms every physical Worker settles', async () => {
    const body = { id: 4, result: Array.from({ length: 262_145 }, () => 0) }
    const frozen = JSON.stringify(body),
      digest = hash(body)
    const samples: {
      enabled: boolean
      durationMs: number
      cpuUserMicros: number
      cpuSystemMicros: number
      eventLoopSamples: number
      eventLoopP95Ms: number
      processRssBytes: number
    }[] = []
    const traffic = new LogicalIpcWorkerTraffic(
      ['utility-native-json'],
      '00000000-0000-4000-8000-000000000004',
    )
    for (const enabled of [false, true]) {
      const eventLoop = monitorEventLoopDelay({ resolution: 10 })
      eventLoop.enable()
      const cpu = process.cpuUsage(),
        started = performance.now()
      try {
        for (let index = 0; index < 8; index += 1) {
          // oxlint-disable-next-line no-await-in-loop -- Before/after use the same eight sequential genuine parser Workers.
          const result = await parseNativeJsonFrame(
            Buffer.from(frozen),
            new AbortController().signal,
            enabled ? traffic : undefined,
          )
          expect(hash(result.message)).toBe(digest)
        }
        const cost = process.cpuUsage(cpu)
        samples.push({
          enabled,
          durationMs: performance.now() - started,
          cpuUserMicros: cost.user,
          cpuSystemMicros: cost.system,
          eventLoopSamples: eventLoop.count,
          eventLoopP95Ms: eventLoop.count
            ? Math.max(0, eventLoop.percentile(95) / 1_000_000 - 10)
            : 0,
          processRssBytes: process.memoryUsage().rss,
        })
      } finally {
        eventLoop.disable()
      }
    }
    expect(traffic.snapshots()[0]).toMatchObject({
      complete: true,
      startedTransports: 8,
      settledTransports: 8,
      activeTransports: 0,
    })
    const directory = resolve(import.meta.dirname, '../../../../../.pact-data/ci-delivery-review')
    await mkdir(directory, { recursive: true })
    await writeFile(
      resolve(directory, 'ipc-native-parser-overhead.json'),
      JSON.stringify(
        {
          fixtureBytes: Buffer.byteLength(frozen),
          fixtureSha256: digest,
          iterationsPerLane: 8,
          samples,
          counters: traffic.snapshots(),
          scope:
            'Node parser Worker only; CPU includes this Vitest process, other Workers and hash oracle; not Electron/Windows/packaged or full IPC overhead acceptance.',
        },
        null,
        2,
      ) + '\n',
    )
  }, 30_000)
  it('preserves dense admitted bodies, transfer ownership and exact scalar receipt bytes', async () => {
    const original = { id: 7, result: Array.from({ length: 262_145 }, () => 0) }
    expect(logicalIpcMeasurement(original)).toMatchObject({ complete: false, reason: 'node_limit' })
    const bytes = Buffer.from(JSON.stringify(original))
    const rawBytes = bytes.length
    const traffic = new LogicalIpcWorkerTraffic(
      ['utility-native-json'],
      '00000000-0000-4000-8000-000000000001',
    )
    const result = await parseNativeJsonFrame(bytes, new AbortController().signal, traffic)
    expect(hash(result.message)).toBe(hash(original))
    expect(bytes.byteLength).toBe(0)
    const snapshot = traffic.snapshots()[0]!
    expect(snapshot).toMatchObject({
      complete: true,
      startedTransports: 1,
      settledTransports: 1,
      activeTransports: 0,
    })
    const input = snapshot.counters[0]!.business
    expect(input.messages).toBe(1)
    expect(input.binaryBytes).toBe(rawBytes)
    expect(input.jsonBytes).toBe(Buffer.byteLength('{"bytes":null,"measure":true}'))
    const output = snapshot.counters[1]!.business
    expect(output.messages).toBe(1)
    expect(output.binaryBytes).toBe(0)
    const ipcMeasurement = {
      complete: true,
      jsonBytes: output.jsonBytes,
      binaryBytes: 0,
      totalBytes: output.totalBytes,
    }
    expect(output.totalBytes).toBe(Buffer.byteLength(JSON.stringify({ ...result, ipcMeasurement })))
    expect(JSON.stringify(snapshot)).not.toContain('result')
  })

  it('counts the full legal native depth without increasing the generic measurement bounds', async () => {
    let value: unknown = 9
    for (let index = 0; index < 64; index += 1) value = [value]
    const traffic = new LogicalIpcWorkerTraffic(
      ['utility-native-json'],
      '00000000-0000-4000-8000-000000000002',
    )
    const result = await parseNativeJsonFrame(
      Buffer.from(JSON.stringify(value)),
      new AbortController().signal,
      traffic,
    )
    expect(hash(result.message)).toBe(hash(value))
    expect(traffic.snapshots()[0]).toMatchObject({
      complete: true,
      activeTransports: 0,
      settledTransports: 1,
    })
  })

  it('retains valid zero-off behavior and rejects invalid native bytes after physical settlement', async () => {
    const before = Buffer.from('{"id":1,"result":"unchanged"}')
    await expect(parseNativeJsonFrame(before, new AbortController().signal)).resolves.toMatchObject(
      { message: { id: 1, result: 'unchanged' } },
    )
    const traffic = new LogicalIpcWorkerTraffic(
      ['utility-native-json'],
      '00000000-0000-4000-8000-000000000003',
    )
    await expect(
      parseNativeJsonFrame(Buffer.from('{broken'), new AbortController().signal, traffic),
    ).rejects.toThrow('invalid frame')
    expect(traffic.snapshots()[0]).toMatchObject({
      complete: true,
      activeTransports: 0,
      settledTransports: 1,
    })
    expect(traffic.snapshots()[0]!.counters[1]!.business.messages).toBe(1)
  })
})
