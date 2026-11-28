import { describe, expect, it, vi } from 'vitest'

import { TurnResourceScope } from './turn-resource-scope'

describe('TurnResourceScope', () => {
  it('disposes registered resources in strict LIFO order and is idempotent', () => {
    const order: string[] = []
    const scope = new TurnResourceScope()

    scope.add('first', () => order.push('first'))
    scope.add('second', () => order.push('second'))
    scope.add('third', () => order.push('third'))

    expect(scope.isDisposed).toBe(false)
    expect(scope.dispose()).toBeUndefined()
    expect(scope.isDisposed).toBe(true)
    expect(order).toEqual(['third', 'second', 'first'])

    expect(scope.dispose()).toBeUndefined()
    expect(order).toEqual(['third', 'second', 'first'])
  })

  it('isolates cleanup errors so remaining cleanups still run and returns first error', () => {
    const order: string[] = []
    const scope = new TurnResourceScope()
    const firstBoom = new Error('boom-2')
    const secondBoom = new Error('boom-1')

    scope.add('bottom', () => {
      order.push('bottom')
      throw secondBoom
    })
    scope.add('middle', () => {
      order.push('middle')
      throw firstBoom
    })
    scope.add('top', () => order.push('top'))

    expect(scope.dispose()).toBe(firstBoom)
    expect(order).toEqual(['top', 'middle', 'bottom'])
  })

  it('supports unregistering cleanups early and cleans up late registrations after dispose', () => {
    const order: string[] = []
    const scope = new TurnResourceScope()

    const unregister = scope.add('removable', () => order.push('removable'))
    scope.add('kept', () => order.push('kept'))
    unregister()
    unregister()

    scope.dispose()
    expect(order).toEqual(['kept'])

    scope.add('late', () => order.push('late'))
    expect(order).toEqual(['kept', 'late'])
  })

  it('always runs clearRef for tracked reservations even when release throws', () => {
    const scope = new TurnResourceScope()
    let ref: { release(): void } | undefined = {
      release: () => {
        throw new Error('release failed')
      },
    }
    scope.trackReservation('mem', ref, () => {
      ref = undefined
    })

    const err = scope.dispose()
    expect(err).toBeInstanceOf(Error)
    expect(ref).toBeUndefined()
  })

  it('handles cross-entry unregistration during dispose without index shift or double execution', () => {
    const calls: string[] = []
    const scope = new TurnResourceScope()

    const unregisterFirst = scope.add('first', () => calls.push('first'))
    scope.add('second', () => calls.push('second'))
    scope.add('third', () => {
      calls.push('third')
      unregisterFirst()
    })

    expect(scope.dispose()).toBeUndefined()
    expect(calls).toEqual(['third', 'second'])
  })

  it('clears pending timers on dispose and skips timer creation once disposed', () => {
    vi.useFakeTimers()
    try {
      const scope = new TurnResourceScope()
      let fired = 0
      scope.setTimeout(
        't1',
        () => {
          fired += 1
        },
        100,
      )

      scope.dispose()
      vi.advanceTimersByTime(500)
      expect(fired).toBe(0)

      scope.setTimeout(
        't2',
        () => {
          fired += 1
        },
        10,
      )
      vi.advanceTimersByTime(100)
      expect(fired).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
