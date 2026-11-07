import {
  DECISION_WORKING_BYTES,
  type NativeMemoryDiagnostics,
  type NativeMemoryCapacities,
} from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'

export const NATIVE_OWNER_WORKING_BYTES = 128 * 1024 * 1024
export const NATIVE_APP_WORKING_BYTES = 512 * 1024 * 1024
export const NATIVE_COMBINED_WORKING_BYTES = NATIVE_APP_WORKING_BYTES + DECISION_WORKING_BYTES

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

interface MemoryPool {
  heldBytes: number
  limit: number
  observations: MemoryObservations
}
const business: MemoryPool = {
  heldBytes: 0,
  limit: NATIVE_APP_WORKING_BYTES,
  observations: emptyObservations(),
}
const decision: MemoryPool = {
  heldBytes: 0,
  limit: DECISION_WORKING_BYTES,
  observations: emptyObservations(),
}

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
  return snapshotObservations(business.heldBytes, business.observations)
}

export function decisionWorkingMemoryDiagnostics(): NativeMemoryDiagnostics {
  return snapshotObservations(decision.heldBytes, decision.observations)
}

/** Two real independent caps; the combined total is explicit rather than hidden in a renamed ledger. */
export function nativeWorkingMemoryCapacities(): NativeMemoryCapacities {
  return {
    businessLimitBytes: NATIVE_APP_WORKING_BYTES,
    decisionLimitBytes: DECISION_WORKING_BYTES,
    combinedLimitBytes: NATIVE_COMBINED_WORKING_BYTES,
    chargedBytes: business.heldBytes + decision.heldBytes,
    business: nativeWorkingMemoryDiagnostics(),
    decision: decisionWorkingMemoryDiagnostics(),
  }
}

export interface NativeMemoryReservation {
  readonly bytes: number
  resize: (bytes: number) => void
  release: () => void
}

export interface NativeMemoryAllocator {
  reserve: (bytes: number) => NativeMemoryReservation
}

/** One fixed App admission, with bounded suballocations inside the same 16 MiB.
 * Suballocations are not an additional App charge. The fixed charge outlives
 * logical cancellation and is released only after every physical owner joins.
 */
export class DecisionMemoryLease implements NativeMemoryAllocator {
  private readonly admission = new NativeWorkingMemory('decision').reserve(DECISION_WORKING_BYTES)
  private held = 0
  private items = 0
  private released = false
  private peak = 0

  diagnostics() {
    return {
      heldBytes: this.held,
      highWaterBytes: this.peak,
      items: this.items,
      released: this.released,
    }
  }

  reserve(initialBytes: number): NativeMemoryReservation {
    if (this.released || this.items >= 64)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Decision working capacity is full.',
        false,
      )
    let bytes = 0,
      released = false
    const resize = (next: number) => {
      if (released || !Number.isSafeInteger(next) || next < 0)
        throw new AgentExecutionError(
          'protocol_error',
          'Invalid decision working reservation.',
          false,
        )
      if (this.held + next - bytes > DECISION_WORKING_BYTES)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Decision working capacity is full.',
          false,
        )
      this.held += next - bytes
      bytes = next
      this.peak = Math.max(this.peak, this.held)
    }
    resize(initialBytes)
    this.items++
    return {
      get bytes() {
        return bytes
      },
      resize,
      release: () => {
        if (released) return
        this.held -= bytes
        bytes = 0
        this.items--
        released = true
      },
    }
  }

  release(): void {
    if (this.released) return
    if (this.items || this.held)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Decision physical work is still held.',
        false,
      )
    this.released = true
    this.admission.release()
  }
}

/** One Connection/SDK Query owns its held DTOs, parse/encode workspace and queues.
 * The shared counter includes both providers. These are simultaneous working allocations,
 * not a message-content limit. Outbound admission precedes Native stdin dispatch.
 */
export class NativeWorkingMemory {
  private heldBytes = 0
  private readonly observations = emptyObservations()
  private readonly pool: MemoryPool
  private readonly ownerLimit: number

  constructor(readonly domain: 'business' | 'decision' = 'business') {
    if (domain !== 'business' && domain !== 'decision')
      throw new AgentExecutionError('protocol_error', 'Invalid Native memory domain.', false)
    this.pool = domain === 'decision' ? decision : business
    this.ownerLimit = domain === 'decision' ? DECISION_WORKING_BYTES : NATIVE_OWNER_WORKING_BYTES
  }

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
      if (this.heldBytes + delta > this.ownerLimit || this.pool.heldBytes + delta > this.pool.limit)
        throw new AgentExecutionError(
          'runtime_incompatible',
          'Native working capacity is full.',
          false,
        )
      this.heldBytes += delta
      this.pool.heldBytes += delta
      observeChange(this.observations, this.heldBytes, delta, initialized ? 0 : 1)
      observeChange(this.pool.observations, this.pool.heldBytes, delta, initialized ? 0 : 1)
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
        this.pool.heldBytes -= bytes
        observeChange(this.observations, this.heldBytes, -bytes, -1)
        observeChange(this.pool.observations, this.pool.heldBytes, -bytes, -1)
        bytes = 0
        released = true
      },
    }
  }
}
