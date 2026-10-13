import { AgentExecutionError } from './agent-execution-error'

export const NATIVE_OWNER_WORKING_BYTES = 128 * 1024 * 1024
export const NATIVE_APP_WORKING_BYTES = 512 * 1024 * 1024
let appHeldBytes = 0

export interface NativeMemoryReservation {
  readonly bytes: number
  resize: (bytes: number) => void
  release: () => void
}

/** One Connection/SDK Query owns its held DTOs, parse/encode workspace and queues.
 * The shared counter includes both providers. These are simultaneous working allocations,
 * not a message-content limit. Outbound admission precedes Native stdin dispatch.
 */
export class NativeWorkingMemory {
  private heldBytes = 0

  get bytes(): number {
    return this.heldBytes
  }

  reserve(initialBytes: number): NativeMemoryReservation {
    let bytes = 0
    let released = false
    const resize = (next: number): void => {
      if (released || !Number.isSafeInteger(next) || next < 0)
        throw new AgentExecutionError(
          'protocol_error',
          'Invalid Native working reservation.',
          false,
        )
      const delta = next - bytes
      if (
        this.heldBytes + delta > NATIVE_OWNER_WORKING_BYTES ||
        appHeldBytes + delta > NATIVE_APP_WORKING_BYTES
      )
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native working capacity is full.',
          false,
        )
      this.heldBytes += delta
      appHeldBytes += delta
      bytes = next
    }
    resize(initialBytes)
    return {
      get bytes() {
        return bytes
      },
      resize,
      release: () => {
        if (released) return
        this.heldBytes -= bytes
        appHeldBytes -= bytes
        bytes = 0
        released = true
      },
    }
  }
}
