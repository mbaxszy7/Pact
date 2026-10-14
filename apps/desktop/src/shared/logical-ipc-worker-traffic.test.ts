import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'

import { IPC_TRAFFIC_OWNER_CATEGORIES, ipcTrafficSchema } from '@pact/contracts'

import {
  LogicalIpcTrafficCollector,
  LogicalIpcWorkerTraffic,
  logicalIpcTrafficSnapshot,
  measureMonacoWorkerMessage,
  observeWorkerTraffic,
  projectLogicalIpcTraffic,
} from './logical-ipc-traffic'

const epoch = '00000000-0000-4000-8000-000000000001'
describe('physical Worker traffic seams', () => {
  it('preserves actual clone/transfer/delivery and counts exactly once despite two consumers', async () => {
    const traffic = new LogicalIpcTrafficCollector('utility-markdown', epoch)
    const worker = new Worker(
      "const {parentPort}=require('node:worker_threads');parentPort.on('message',value=>parentPort.postMessage(value))",
      { eval: true },
    )
    observeWorkerTraffic(worker, traffic, 'utility-markdown.request', 'markdown-utility.reply')
    let received = 0
    const consumer = (): void => {
      received += 1
    }
    worker.on('message', consumer)
    worker.on('message', consumer)
    const bytes = new Uint8Array([1, 2, 3, 4])
    const packet = { text: 'é😀', bytes }
    try {
      const reply = once(worker, 'message')
      worker.postMessage(packet, [bytes.buffer])
      const [actual] = await reply
      expect(actual).toEqual({ text: 'é😀', bytes: new Uint8Array([1, 2, 3, 4]) })
      expect(bytes.byteLength).toBe(0)
      expect(received).toBe(2)
      expect(worker.listenerCount('message')).toBe(3) // one observation tap, two unchanged business registrations
      const expected = Buffer.byteLength(JSON.stringify({ text: 'é😀', bytes: null })) + 4
      const before = traffic.snapshot()
      expect(before.counters.map((row) => row.business.messages)).toEqual([1, 1])
      expect(before.counters.map((row) => row.business.totalBytes)).toEqual([expected, expected])
      expect(before.activeTransports).toBe(1)
      await worker.terminate()
      expect(traffic.snapshot()).toMatchObject({
        complete: true,
        activeTransports: 0,
        startedTransports: 1,
        settledTransports: 1,
      })
      expect(worker.listenerCount('message')).toBe(0) // Node releases its native message port listeners at actual exit
    } finally {
      await worker.terminate()
    }
  })

  it('commits no outgoing byte receipt when the actual native clone fails', async () => {
    const traffic = new LogicalIpcTrafficCollector('utility-markdown', epoch)
    const worker = new Worker("require('node:worker_threads').parentPort.on('message',()=>{})", {
      eval: true,
    })
    observeWorkerTraffic(worker, traffic, 'utility-markdown.request', 'markdown-utility.reply')
    try {
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- This is node:worker_threads, not a browser Window.
      expect(() => worker.postMessage({ callback: () => undefined })).toThrow(
        /could not be cloned/u,
      )
      expect(traffic.snapshot().counters[0].business.messages).toBe(0)
      expect(traffic.snapshot().issues).toContain('transport_error')
    } finally {
      await worker.terminate()
    }
    expect(traffic.snapshot().activeTransports).toBe(0)
  })

  it('retains fixed group counters across Worker instances and rejects missing groups/resets', () => {
    const owners = Object.keys(IPC_TRAFFIC_OWNER_CATEGORIES).filter(
      (owner): owner is keyof typeof IPC_TRAFFIC_OWNER_CATEGORIES =>
        owner in IPC_TRAFFIC_OWNER_CATEGORIES,
    )
    const traffic = new LogicalIpcWorkerTraffic(owners, epoch)
    const main = traffic.collector('main-utility')!
    const complete = logicalIpcTrafficSnapshot(
      main.snapshot(),
      traffic.snapshots().filter((value) => value.owner !== 'main-utility'),
    )
    expect(complete.owners).toHaveLength(9)
    expect(complete.owners.reduce((n, value) => n + value.counters.length, 0)).toBe(25)
    expect(ipcTrafficSchema.safeParse(complete).success).toBe(true)
    const missing = structuredClone(complete)
    missing.owners = missing.owners.filter((value) => value.owner !== 'utility-image')
    missing.complete = false
    expect(projectLogicalIpcTraffic(missing, complete).issues).toContain(
      'utility-image:missing-owner',
    )
  })

  it('measures only the installed Monaco own-data class profile and never calls getters', () => {
    class RequestMessage {
      vsWorker = 1
      req = '1'
      channel = 'default'
      method = 'compute'
      args = ['é😀']
      type = 0
    }
    const packet = new RequestMessage()
    expect(measureMonacoWorkerMessage(packet)).toMatchObject({
      complete: true,
      totalBytes: Buffer.byteLength(JSON.stringify(structuredClone(packet))),
    })
    let getters = 0
    Object.defineProperty(packet, 'args', {
      get: () => {
        getters += 1
        return ['hidden']
      },
      enumerable: true,
    })
    expect(measureMonacoWorkerMessage(packet)).toMatchObject({
      complete: false,
      reason: 'accessor',
    })
    expect(getters).toBe(0)
    class UnknownMessage {
      field = 1
    }
    expect(measureMonacoWorkerMessage(new UnknownMessage())).toMatchObject({
      complete: false,
      reason: 'unsupported_prototype',
    })
  })
})
