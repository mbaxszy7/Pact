import { describe, expect, it } from 'vitest'

import { nativeMemoryDiagnosticsSchema } from '@pact/contracts'

import {
  NativeWorkingMemory,
  nativeWorkingMemoryDiagnostics,
  NATIVE_APP_WORKING_BYTES,
  NATIVE_OWNER_WORKING_BYTES,
} from './native-working-memory'

describe('Native working reservation observations', () => {
  it('counts zero-byte live reservations and every successful resize/release boundary', () => {
    const owner = new NativeWorkingMemory()
    const first = owner.reserve(0)
    const second = owner.reserve(100)
    try {
      expect(owner.diagnostics()).toEqual({
        unit: 'native-working-reservations-v1',
        observationsComplete: true,
        chargedBytes: 100,
        reservationItems: 2,
        highWaterBytes: 100,
        highWaterItems: 2,
        acquiredBytes: 100,
        releasedBytes: 0,
        acquiredItems: 2,
        releasedItems: 0,
      })
      first.resize(300)
      second.resize(50)
      first.resize(0)
      expect(owner.bytes).toBe(50)
      expect(first.bytes).toBe(0)
      expect(owner.diagnostics()).toMatchObject({
        chargedBytes: 50,
        reservationItems: 2,
        highWaterBytes: 400,
        highWaterItems: 2,
        acquiredBytes: 400,
        releasedBytes: 350,
      })
      first.release()
      first.release()
      expect(() => first.resize(1)).toThrow('Invalid Native working reservation.')
      expect(owner.diagnostics()).toMatchObject({ reservationItems: 1, releasedItems: 1 })
    } finally {
      first.release()
      second.release()
    }
    expect(owner.diagnostics()).toMatchObject({
      chargedBytes: 0,
      reservationItems: 0,
      acquiredBytes: 400,
      releasedBytes: 400,
      acquiredItems: 2,
      releasedItems: 2,
      highWaterBytes: 400,
      highWaterItems: 2,
    })
    const snapshot = owner.diagnostics()
    snapshot.acquiredBytes = 1
    expect(owner.diagnostics().acquiredBytes).toBe(400)
    expect(nativeMemoryDiagnosticsSchema.safeParse(owner.diagnostics()).success).toBe(true)
  })

  it('preserves owner admission and every observation after invalid or over-capacity changes', () => {
    const owner = new NativeWorkingMemory()
    const reservation = owner.reserve(NATIVE_OWNER_WORKING_BYTES)
    try {
      const before = owner.diagnostics()
      for (const invalid of [
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
      ]) {
        expect(() => reservation.resize(invalid)).toThrow('Invalid Native working reservation.')
        expect(() => owner.reserve(invalid)).toThrow('Invalid Native working reservation.')
        expect(owner.diagnostics()).toEqual(before)
      }
      expect(() => reservation.resize(NATIVE_OWNER_WORKING_BYTES + 1)).toThrow(
        'Native working capacity is full.',
      )
      expect(() => owner.reserve(1)).toThrow('Native working capacity is full.')
      expect(owner.diagnostics()).toEqual(before)
      expect(reservation.bytes).toBe(NATIVE_OWNER_WORKING_BYTES)
    } finally {
      reservation.release()
    }
  })

  it('shares the actual application cap across independent Claude/Codex owners', () => {
    const before = nativeWorkingMemoryDiagnostics()
    const claude = [new NativeWorkingMemory(), new NativeWorkingMemory()]
    const codex = [new NativeWorkingMemory(), new NativeWorkingMemory()]
    const owners = [...claude, ...codex]
    const reservations = owners.map((owner) => owner.reserve(NATIVE_OWNER_WORKING_BYTES))
    const zeroOwner = new NativeWorkingMemory()
    const zero = zeroOwner.reserve(0)
    try {
      const full = nativeWorkingMemoryDiagnostics()
      expect(full.chargedBytes).toBe(NATIVE_APP_WORKING_BYTES)
      expect(full.reservationItems).toBe(before.reservationItems! + 5)
      expect(full.highWaterBytes).toBe(NATIVE_APP_WORKING_BYTES)
      expect(full.acquiredBytes).toBe(before.acquiredBytes! + NATIVE_APP_WORKING_BYTES)
      expect(full.acquiredItems).toBe(before.acquiredItems! + 5)
      expect(() => zero.resize(1)).toThrow('Native working capacity is full.')
      expect(() => new NativeWorkingMemory().reserve(1)).toThrow('Native working capacity is full.')
      expect(nativeWorkingMemoryDiagnostics()).toEqual(full)
      reservations[0]!.release()
      zero.resize(1)
      expect(zero.bytes).toBe(1)
      expect(nativeWorkingMemoryDiagnostics().chargedBytes).toBe(
        NATIVE_APP_WORKING_BYTES - NATIVE_OWNER_WORKING_BYTES + 1,
      )
      expect(
        nativeMemoryDiagnosticsSchema.safeParse(nativeWorkingMemoryDiagnostics()).success,
      ).toBe(true)
    } finally {
      for (const reservation of reservations) reservation.release()
      zero.release()
    }
    const after = nativeWorkingMemoryDiagnostics()
    expect(after.chargedBytes).toBe(before.chargedBytes)
    expect(after.reservationItems).toBe(before.reservationItems)
    expect(after.acquiredBytes! - after.releasedBytes!).toBe(after.chargedBytes)
    expect(after.acquiredItems! - after.releasedItems!).toBe(after.reservationItems)
  })

  it('returns actual aggregate bytes/items to baseline after 100 acquisition/error/release cycles', () => {
    const before = nativeWorkingMemoryDiagnostics()
    for (let index = 0; index < 100; index++) {
      const owner = new NativeWorkingMemory()
      const live = owner.reserve(0)
      try {
        live.resize(4096)
        live.resize(8192)
        live.resize(1024)
        const current = owner.diagnostics()
        expect(() => live.resize(NATIVE_OWNER_WORKING_BYTES + 1)).toThrow(
          'Native working capacity is full.',
        )
        expect(owner.diagnostics()).toEqual(current)
      } finally {
        live.release()
        live.release()
      }
      expect(owner.diagnostics()).toMatchObject({
        observationsComplete: true,
        chargedBytes: 0,
        reservationItems: 0,
        highWaterBytes: 8192,
        highWaterItems: 1,
        acquiredBytes: 8192,
        releasedBytes: 8192,
        acquiredItems: 1,
        releasedItems: 1,
      })
    }
    const after = nativeWorkingMemoryDiagnostics()
    expect(after.chargedBytes).toBe(before.chargedBytes)
    expect(after.reservationItems).toBe(before.reservationItems)
    expect(after.acquiredBytes).toBe(before.acquiredBytes! + 100 * 8192)
    expect(after.releasedBytes).toBe(before.releasedBytes! + 100 * 8192)
    expect(after.acquiredItems).toBe(before.acquiredItems! + 100)
    expect(after.releasedItems).toBe(before.releasedItems! + 100)
    expect(nativeMemoryDiagnosticsSchema.safeParse(after).success).toBe(true)
  })
})
