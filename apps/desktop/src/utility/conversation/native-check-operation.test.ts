import { describe, expect, it, vi } from 'vitest'

import type { SchedulingCheckPhysicalOwner } from '@pact/contracts'

import { NativeCheckOperation } from './native-check-operation'

describe('native readback physical scope', () => {
  it('retains ownership after a caught read failure until the independently registered cleanup joins', async () => {
    const owner = new NativeCheckOperation(() => true),
      physical = Promise.withResolvers<void>(),
      controller = new AbortController()
    const check = owner.begin(controller.signal, async (signal) => {
      owner.observeRequest(signal, physical.promise)
      throw new Error('Read result failed; its Worker has not exited.')
    })
    await expect(check.result).rejects.toThrow('Read result failed')
    const complete = vi.fn<() => void>()
    void check.physicalCompletion.then(complete)
    await Promise.resolve()
    expect(owner.active).toBe(true)
    expect(complete).not.toHaveBeenCalled()
    const refused = owner.begin(controller.signal, async () => 42)
    await expect(refused.result).rejects.toThrow('still owns physical resources')
    physical.resolve()
    await check.physicalCompletion
    expect(owner.active).toBe(false)
    const next = owner.begin(controller.signal, async () => 42)
    await expect(next.result).resolves.toBe(42)
    await next.physicalCompletion
  })

  it('cancels delayed preparation before it can create a late resource during disposal', async () => {
    const owner = new NativeCheckOperation(() => true),
      started = vi.fn<() => void>(),
      controller = new AbortController()
    const check = owner.begin(controller.signal, async () => {
      started()
      return 1
    })
    owner.cancel()
    await expect(check.result).rejects.toThrow('aborted')
    await owner.join()
    expect(started).not.toHaveBeenCalled()
    expect(owner.active).toBe(false)
  })

  it('passes disposal cancellation through the exact context signal and joins real cleanup', async () => {
    const owner = new NativeCheckOperation(() => true),
      ready = Promise.withResolvers<void>(),
      physical = Promise.withResolvers<void>(),
      controller = new AbortController()
    let scopeSignal: AbortSignal | undefined
    const report = vi.fn<(owner: SchedulingCheckPhysicalOwner) => void>()
    const check = owner.begin(
      controller.signal,
      async (signal) => {
        scopeSignal = signal
        owner.observeRequest(signal, physical.promise)
        owner.recordPhysicalOwner(signal, { kind: 'inspection_pending' })
        ready.resolve()
        return 'Logical read finished'
      },
      { operationId: 'owned-check', recordPhysicalOwner: report },
    )
    await ready.promise
    await expect(check.result).resolves.toBe('Logical read finished')
    owner.cancel()
    expect(scopeSignal?.aborted).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(report).toHaveBeenCalledExactlyOnceWith({ kind: 'inspection_pending' })
    expect(owner.active).toBe(true)
    physical.resolve()
    await owner.join()
    expect(owner.active).toBe(false)
  })
})
