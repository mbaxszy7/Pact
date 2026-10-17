import type { NativeMemoryDiagnostics } from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'

export const NATIVE_OWNER_WORKING_BYTES = 128 * 1024 * 1024
export const NATIVE_APP_WORKING_BYTES = 512 * 1024 * 1024
let appHeldBytes = 0

interface MemoryObservations {
  reservationItems: number | null
  highWaterBytes: number
  highWaterItems: number | null
  acquiredBytes: number | null
  releasedBytes: number | null
  acquiredItems: number | null
  releasedItems: number | null
}

function emptyObservations(): MemoryObservations {
  return {
    reservationItems: 0,
    highWaterBytes: 0,
    highWaterItems: 0,
    acquiredBytes: 0,
    releasedBytes: 0,
    acquiredItems: 0,
    releasedItems: 0,
  }
}

const appObservations = emptyObservations()

function addObservation(value: number | null, delta: number): number | null {
  if (value === null) return null
  const next = value + delta
  return Number.isSafeInteger(next) && next >= 0 ? next : null
}

function observeChange(
  observations: MemoryObservations,
  heldBytes: number,
  byteDelta: number,
  itemDelta: number,
): void {
  observations.reservationItems = addObservation(observations.reservationItems, itemDelta)
  observations.highWaterBytes = Math.max(observations.highWaterBytes, heldBytes)
  observations.highWaterItems =
    observations.highWaterItems === null || observations.reservationItems === null
      ? null
      : Math.max(observations.highWaterItems, observations.reservationItems)
  if (byteDelta > 0)
    observations.acquiredBytes = addObservation(observations.acquiredBytes, byteDelta)
  else if (byteDelta < 0)
    observations.releasedBytes = addObservation(observations.releasedBytes, -byteDelta)
  if (itemDelta > 0)
    observations.acquiredItems = addObservation(observations.acquiredItems, itemDelta)
  else if (itemDelta < 0)
    observations.releasedItems = addObservation(observations.releasedItems, -itemDelta)
}

function snapshotObservations(
  chargedBytes: number,
  observations: MemoryObservations,
): NativeMemoryDiagnostics {
  return {
    unit: 'native-working-reservations-v1',
    observationsComplete: Object.values(observations).every((value) => value !== null),
    chargedBytes,
    ...observations,
  }
}

/** Shared by the same Utility module instance and admission counter, never a process-RSS estimate. */
export function nativeWorkingMemoryDiagnostics(): NativeMemoryDiagnostics {
  return snapshotObservations(appHeldBytes, appObservations)
}

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
  private readonly observations = emptyObservations()

  get bytes(): number {
    return this.heldBytes
  }

  diagnostics(): NativeMemoryDiagnostics {
    return snapshotObservations(this.heldBytes, this.observations)
  }

  reserve(initialBytes: number): NativeMemoryReservation {
    let bytes = 0
    let released = false
    let initialized = false
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
      observeChange(this.observations, this.heldBytes, delta, initialized ? 0 : 1)
      observeChange(appObservations, appHeldBytes, delta, initialized ? 0 : 1)
      bytes = next
      initialized = true
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
        observeChange(this.observations, this.heldBytes, -bytes, -1)
        observeChange(appObservations, appHeldBytes, -bytes, -1)
        bytes = 0
        released = true
      },
    }
  }
}
