import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'

import { ipcTrafficOwnerSnapshotSchema, ipcTrafficSchema } from '@pact/contracts'

import {
  LogicalIpcTrafficCollector,
  logicalIpcTrafficSnapshot,
  projectLogicalIpcTraffic,
} from './logical-ipc-traffic.js'

const epoch = '00000000-0000-4000-8000-000000000001'
const otherEpoch = '00000000-0000-4000-8000-000000000002'

describe('bounded logical IPC traffic collector', () => {
  it('counts independent JSON byte oracles and binary skeletons in separate fixed lanes', () => {
    const traffic = new LogicalIpcTrafficCollector('renderer-bridge', epoch)
    const first = { content: 'é😀\ud800', omitted: undefined }
    const second = { body: new Uint8Array(7) }
    traffic.record('renderer-main.invoke', 'business', first)
    traffic.record('renderer-main.invoke', 'business', second)
    traffic.record('main-renderer.reply', 'control', { ok: true })
    const snapshot = traffic.snapshot()
    expect(ipcTrafficOwnerSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot.counters[0]?.business).toEqual({
      messages: 2,
      incompleteMessages: 0,
      jsonBytes:
        Buffer.byteLength(JSON.stringify(first)) +
        Buffer.byteLength(JSON.stringify({ body: null })),
      binaryBytes: 7,
      totalBytes:
        Buffer.byteLength(JSON.stringify(first)) +
        Buffer.byteLength(JSON.stringify({ body: null })) +
        7,
    })
    expect(snapshot.counters[1]?.control.messages).toBe(1)
    expect(snapshot.counters).toHaveLength(4)
    expect(JSON.stringify(snapshot)).not.toContain('content')
    const counts = snapshot.counters[0]
    if (!counts) throw new Error('Expected fixed counter slot.')
    const bytes = counts.business.totalBytes
    counts.business.totalBytes = 0
    expect(traffic.snapshot().counters[0]?.business.totalBytes).toBe(bytes)
  })

  it('keeps unsupported/unknown observations sticky without retaining or invoking payload facts', () => {
    const traffic = new LogicalIpcTrafficCollector('main-utility', epoch)
    const getter = vi.fn<() => string>(() => 'private content')
    const payload = Object.defineProperty({}, 'content', { get: getter, enumerable: true })
    traffic.record('main-utility.request', 'business', payload)
    traffic.record('main-utility.request', 'business', { valid: true })
    traffic.invalidate('unvalidated_message')
    traffic.invalidate('unvalidated_message')
    const snapshot = traffic.snapshot()
    expect(snapshot.complete).toBe(false)
    expect(snapshot.issues).toEqual(['accessor', 'unvalidated_message'])
    expect(snapshot.counters[0]?.business).toMatchObject({
      messages: 2,
      incompleteMessages: 1,
      totalBytes: Buffer.byteLength('{"valid":true}'),
    })
    expect(getter).not.toHaveBeenCalled()
    expect(JSON.stringify(snapshot)).not.toContain('private')
    traffic.record('renderer-main.send', 'business', null)
    expect(traffic.snapshot().issues).toContain('unknown_category')
  })

  it('bounds message count and transport epochs through the primary interface', () => {
    const traffic = new LogicalIpcTrafficCollector('main-utility', epoch)
    for (let index = 0; index < 1_000_001; index += 1)
      traffic.record('main-utility.request', 'business', null)
    for (let index = 0; index < 64; index += 1) traffic.advanceTransportEpoch()
    expect(traffic.snapshot()).toMatchObject({ complete: false, transportEpoch: 64 })
    expect(traffic.snapshot().issues).toEqual(['counter_overflow', 'epoch_limit'])
    expect(traffic.snapshot().counters[0]?.business.messages).toBe(1_000_000)
    expect(traffic.snapshot().counters[0]?.business.totalBytes).toBe(4_000_000)
    traffic.dispose()
    traffic.record('main-utility.request', 'business', null)
    expect(traffic.snapshot().issues).toContain('disposed')
    expect(traffic.snapshot().counters[0]?.business.messages).toBe(1_000_000)
  })

  it('does not claim all IPC coverage from valid scoped counts and rejects incomplete contracts', () => {
    const main = new LogicalIpcTrafficCollector('main-utility', epoch)
    const bridge = new LogicalIpcTrafficCollector('renderer-bridge', otherEpoch)
    const observation = logicalIpcTrafficSnapshot(main.snapshot())
    observation.owners.push(bridge.snapshot())
    observation.uncovered = observation.uncovered.filter((hop) => hop !== 'renderer-main-bridge')
    const projected = projectLogicalIpcTraffic(observation)
    expect(projected.observed).toBe(true)
    expect(projected.complete).toBe(false)
    expect(projected.issues).toContain('uncovered:main-directory-worker')
    expect(ipcTrafficSchema.safeParse({ ...observation, complete: true }).success).toBe(false)
    expect(
      ipcTrafficSchema.safeParse({
        ...observation,
        owners: [observation.owners[0], observation.owners[0]],
      }).success,
    ).toBe(false)
    expect(
      ipcTrafficOwnerSnapshotSchema.safeParse({ ...main.snapshot(), counters: [] }).success,
    ).toBe(false)
    expect(new LogicalIpcTrafficCollector('main-utility', 'unverified').snapshot()).toMatchObject({
      epoch: null,
      complete: false,
      issues: ['invalid_epoch'],
    })
  })

  it('detects epoch/counter resets and missing snapshots instead of reusing an earlier success', () => {
    const main = new LogicalIpcTrafficCollector('main-utility', epoch)
    main.record('main-utility.request', 'business', { work: true })
    const previous = logicalIpcTrafficSnapshot(main.snapshot())
    const reset = logicalIpcTrafficSnapshot(
      new LogicalIpcTrafficCollector('main-utility', otherEpoch).snapshot(),
    )
    const projected = projectLogicalIpcTraffic(reset, previous)
    expect(projected.issues).toContain('main-utility:epoch-reset')
    expect(projected.issues).toContain('main-utility:counter-reset')
    expect(projectLogicalIpcTraffic(undefined, previous)).toMatchObject({
      observed: false,
      complete: false,
    })
    expect(projectLogicalIpcTraffic({ ...previous, unit: 'wire-bytes' }).observed).toBe(false)
    const invalid = structuredClone(previous)
    const invalidRow = invalid.owners[0]?.counters[0]
    if (!invalidRow) throw new Error('Expected fixed counter slot.')
    invalidRow.business.totalBytes += 1
    expect(projectLogicalIpcTraffic(invalid).observed).toBe(false)
  })
})
