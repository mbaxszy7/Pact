import { afterEach, expect, it, vi } from 'vitest'

import { OwnedProcessGroup } from './owned-process-group.js'

afterEach(() => vi.useRealTimers())

it.each([
  { supplied: undefined, elapsed: 4_000 },
  { supplied: 750, elapsed: 750 },
  { supplied: 10_000, elapsed: 4_000 },
])(
  'caps physical input cleanup at $elapsed ms with supplied budget $supplied',
  async ({ supplied, elapsed }) => {
    vi.useFakeTimers()
    const input = Promise.withResolvers<void>()
    const closeInput = vi.fn<() => Promise<void>>(() => input.promise)
    const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
    const closing = owner.close(supplied === undefined ? undefined : Date.now() + supplied)
    const settled = vi.fn<(result: unknown) => void>()
    const observed = closing.then(
      () => {
        settled('released')
        return undefined
      },
      (error: unknown) => {
        settled(error)
        return undefined
      },
    )
    try {
      // An already-started owner joins its first cleanup; neither a later longer
      // deadline nor a later shorter deadline starts a second cleanup window.
      expect(owner.close(Date.now() + 20_000)).toBe(closing)
      expect(owner.close(Date.now() + 1)).toBe(closing)
      await vi.advanceTimersByTimeAsync(elapsed - 1)
      expect(settled).not.toHaveBeenCalled()
      expect(closeInput).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'The owned process scope did not release before its deadline.',
        }),
      )
      await observed
      expect(owner.released).toBe(false)
    } finally {
      // No OS child is created by this boundary fixture. Complete the one actual
      // input-close task without retrying the failed owner or inventing release.
      input.resolve()
      await input.promise
      await observed
    }
    expect(closeInput).toHaveBeenCalledOnce()
    expect(owner.released).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  },
)

it('still requires actual input completion before releasing inside the shared deadline', async () => {
  vi.useFakeTimers()
  const input = Promise.withResolvers<void>()
  const closeInput = vi.fn<() => Promise<void>>(() => input.promise)
  const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
  const closing = owner.close(Date.now() + 500)
  try {
    await vi.advanceTimersByTimeAsync(499)
    expect(owner.released).toBe(false)
    input.resolve()
    await closing
    expect(owner.released).toBe(true)
    expect(owner.close(Date.now() + 10_000)).toBe(closing)
    expect(closeInput).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    input.resolve()
    await closing.catch(() => undefined)
  }
})

it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects malformed cleanup deadline %s before admitting cleanup',
  async (deadline) => {
    const closeInput = vi.fn<() => void>()
    const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
    await expect(owner.close(deadline)).rejects.toThrow(/deadline/)
    expect(closeInput).not.toHaveBeenCalled()
    expect(owner.released).toBe(false)
  },
)

it('does not restart the cleanup budget for an already expired positive deadline', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  const input = Promise.withResolvers<void>()
  const closeInput = vi.fn<() => Promise<void>>(() => input.promise)
  const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
  const closing = owner.close(9_999)
  try {
    await expect(closing).rejects.toThrow(/did not release before its deadline/)
    expect(owner.released).toBe(false)
  } finally {
    input.resolve()
    await input.promise
  }
  expect(closeInput).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
