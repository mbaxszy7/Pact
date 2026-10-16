import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LogicalIpcTrafficCollector, observeWorkerTraffic } from '../../shared/logical-ipc-traffic'
import { nativeWorkerFixture } from './native-workers-fixture.test-support'

let fixture: Awaited<ReturnType<typeof nativeWorkerFixture>>
beforeAll(async () => {
  fixture = await nativeWorkerFixture(
    ['markdown-projection-worker', 'image-codec-worker', 'log-worker'],
    { 'log-worker': resolve(import.meta.dirname, '../../diagnostics/log-worker.ts') },
  )
}, 30_000)
afterAll(async () => {
  await fixture?.dispose()
})
const epoch = '00000000-0000-4000-8000-000000000001'
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

describe('actual existing Markdown, image and diagnostic Workers', () => {
  it('preserves credited Markdown page order and independently counts every full receive', async () => {
    const worker = new Worker(fixture.paths['markdown-projection-worker']!)
    const traffic = new LogicalIpcTrafficCollector('utility-markdown', epoch)
    observeWorkerTraffic(worker, traffic, 'utility-markdown.request', 'markdown-utility.reply')
    let inputBytes = 0,
      outputBytes = 0,
      messages = 0
    const request = async (input: object): Promise<Record<string, unknown>> => {
      inputBytes += Buffer.byteLength(JSON.stringify(input))
      const answer = once(worker, 'message')
      worker.postMessage(input)
      const [raw]: unknown[] = await answer
      if (!raw || typeof raw !== 'object') throw new Error('Missing actual Markdown reply.')
      outputBytes += Buffer.byteLength(JSON.stringify(raw))
      messages += 1
      return Object.fromEntries(Object.entries(raw))
    }
    try {
      expect(await request({ type: 'append', text: '# Head\n\né😀 fixture text\n' })).toEqual({
        type: 'appended',
      })
      const pages: unknown[] = []
      let response = await request({ type: 'compile' })
      while (response.type === 'page') {
        pages.push(response.page)
        // oxlint-disable-next-line no-await-in-loop -- One durable credit precedes the next real compiler page.
        response = await request({ type: 'next' })
      }
      expect(response).toEqual({ type: 'complete' })
      expect(JSON.stringify(pages)).toContain('é😀 fixture text')
      await worker.terminate()
      expect(traffic.snapshot()).toMatchObject({
        complete: true,
        activeTransports: 0,
        settledTransports: 1,
      })
      expect(traffic.snapshot().counters.map((row) => row.business.totalBytes)).toEqual([
        inputBytes,
        outputBytes,
      ])
      expect(traffic.snapshot().counters.map((row) => row.business.messages)).toEqual([
        messages,
        messages,
      ])
    } finally {
      await worker.terminate()
    }
  })

  it('uses the actual native image codec and retains identical original bytes and thumbnail result', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-image-traffic-seam-'))
    const source = join(directory, 'source.png'),
      thumbnail = join(directory, 'thumbnail.webp')
    const original = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    })
      .png()
      .toBuffer()
    const traffic = new LogicalIpcTrafficCollector('utility-image', epoch)
    let worker: Worker | undefined
    try {
      await writeFile(source, original)
      const input = { source, thumbnail }
      worker = new Worker(fixture.paths['image-codec-worker']!, { workerData: input })
      traffic.record('utility-image.init', 'business', input)
      observeWorkerTraffic(worker, traffic, 'utility-image.init', 'image-utility.reply')
      const [response]: unknown[] = await once(worker, 'message')
      expect(response).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
      expect(hash(await readFile(source))).toBe(hash(original))
      const actualThumbnail = await readFile(thumbnail)
      expect(response).toMatchObject({ thumbnailBytes: actualThumbnail.length })
      await worker.terminate()
      expect(traffic.snapshot()).toMatchObject({
        complete: true,
        activeTransports: 0,
        settledTransports: 1,
      })
      expect(traffic.snapshot().counters.map((row) => row.business.totalBytes)).toEqual([
        Buffer.byteLength(JSON.stringify(input)),
        Buffer.byteLength(JSON.stringify(response)),
      ])
    } finally {
      await worker?.terminate()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('writes a real diagnostic record and counts ACK/busy/state/closed without losing physical exit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-log-traffic-seam-'))
    const input = { directory, pid: process.pid }
    const traffic = new LogicalIpcTrafficCollector('main-diagnostic-log', epoch)
    const worker = new Worker(fixture.paths['log-worker']!, { workerData: input })
    traffic.record('main-diagnostic-log.init', 'control', input)
    observeWorkerTraffic(
      worker,
      traffic,
      'main-diagnostic-log.request',
      'diagnostic-log-main.reply',
      'control',
    )
    let outputBytes = 0,
      outputMessages = 0
    const types = new Set<string>()
    worker.on('message', (packet: unknown) => {
      outputBytes += Buffer.byteLength(JSON.stringify(packet))
      outputMessages += 1
      if (packet && typeof packet === 'object') types.add(String(Reflect.get(packet, 'type')))
    })
    const packet = {
      type: 'diagnostic.record',
      id: randomUUID(),
      record: {
        timestamp: new Date().toISOString(),
        operation: 'app',
        phase: 'started',
        level: 'info',
        identity: {
          launchId: randomUUID(),
          appVersion: '0.1.0',
          process: 'main',
          pid: process.pid,
        },
      },
    }
    const acknowledged = new Promise<unknown>((accept, reject) => {
      worker.once('error', reject)
      worker.on('message', (reply: unknown) => {
        if (reply && typeof reply === 'object' && Reflect.get(reply, 'type') === 'diagnostic.ack')
          accept(reply)
      })
    })
    try {
      worker.postMessage(packet)
      expect(await acknowledged).toMatchObject({ id: packet.id, written: true })
      const exit = once(worker, 'exit')
      const close = { type: 'diagnostic.close' }
      worker.postMessage(close)
      await exit
      expect(types).toEqual(
        new Set(['diagnostic.busy', 'diagnostic.state', 'diagnostic.ack', 'diagnostic.closed']),
      )
      const logs = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
      expect(logs).toHaveLength(1)
      const written = await readFile(join(directory, logs[0]!), 'utf8')
      expect(JSON.parse(written)).toEqual(packet.record)
      expect(Buffer.byteLength(written)).toBe(Buffer.byteLength(JSON.stringify(packet.record)) + 1)
      const snapshot = traffic.snapshot()
      expect(snapshot).toMatchObject({ complete: true, activeTransports: 0, settledTransports: 1 })
      expect(snapshot.counters[1]!.control.totalBytes).toBe(
        Buffer.byteLength(JSON.stringify(packet)) + Buffer.byteLength(JSON.stringify(close)),
      )
      expect(snapshot.counters[2]!.control).toMatchObject({
        messages: outputMessages,
        totalBytes: outputBytes,
      })
    } finally {
      await worker.terminate()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
