export interface ScopedReservation {
  release(): void
}

interface ScopeEntry {
  readonly name: string
  readonly fn: () => void
  active: boolean
}

/**
 * Structured LIFO resource disposal scope (inspired by emdash Scope) for Turn
 * lifetimes. Guarantees every registered timer, listener, subscription, or
 * working-memory reservation is released in reverse acquisition order with
 * full error isolation and idempotency.
 */
export class TurnResourceScope {
  private readonly cleanups: ScopeEntry[] = []
  private disposed = false

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Register a named LIFO cleanup step. Returns an idempotent unregister handle
   * for resources explicitly released earlier in the normal path. If the scope
   * is already disposed, runs the cleanup immediately in isolation.
   */
  add(name: string, fn: () => void): () => void {
    if (this.disposed) {
      try {
        fn()
      } catch {
        // Scope is already disposed; isolate late registration cleanup.
      }
      return () => undefined
    }
    const entry: ScopeEntry = { name, fn, active: true }
    this.cleanups.push(entry)
    return () => {
      if (!entry.active) return
      entry.active = false
      if (!this.disposed) {
        const idx = this.cleanups.lastIndexOf(entry)
        if (idx !== -1) this.cleanups.splice(idx, 1)
      }
    }
  }

  /**
   * Register a working-memory reservation for automatic LIFO release.
   * `clearRef` always runs in `finally` so callers never resize a released handle.
   */
  trackReservation<T extends ScopedReservation>(
    name: string,
    reservation: T,
    clearRef?: () => void,
  ): T {
    this.add(name, () => {
      try {
        reservation.release()
      } finally {
        clearRef?.()
      }
    })
    return reservation
  }

  /**
   * Schedule a timer bound to this scope and return an idempotent cancel function.
   */
  setTimeout(name: string, fn: () => void, ms: number, unref = false): () => void {
    if (this.disposed) return () => undefined
    let cleared = false
    let removeCleanup: (() => void) | undefined
    const handle = setTimeout(() => {
      if (cleared) return
      cleared = true
      removeCleanup?.()
      fn()
    }, ms)
    if (unref) handle.unref?.()
    const clear = (): void => {
      if (cleared) return
      cleared = true
      clearTimeout(handle)
      removeCleanup?.()
    }
    removeCleanup = this.add(name, clear)
    return clear
  }

  /**
   * Execute every registered cleanup in strict LIFO order. Isolates failures so
   * later cleanups always run, returning the first thrown error if any.
   */
  dispose(): unknown {
    if (this.disposed) return undefined
    this.disposed = true
    const entries = this.cleanups.splice(0)
    let firstError: unknown
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i]!
      if (!entry.active) continue
      entry.active = false
      try {
        entry.fn()
      } catch (err) {
        firstError ??= err
      }
    }
    return firstError
  }
}
