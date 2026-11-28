import { describe, expect, it } from 'vitest'

import {
  decisionPhysicalWitnessExtends,
  decisionPhysicalWitnessSchema,
} from './decision-physical-witness.js'

const randomUUID = () => globalThis.crypto.randomUUID()

const allocation = () => ({
  version: 2 as const,
  platform: 'win32' as const,
  protocolVersion: 1 as const,
  ownerId: randomUUID(),
  generation: randomUUID(),
  phase: 'allocated' as const,
  owner: { pid: 101, creationFileTime: '134369000000000001' },
  receipt: { id: randomUUID(), volumeSerial: '0123456789abcdef', fileId: 'a'.repeat(32) },
})

describe('versioned decision physical witnesses', () => {
  it('preserves Darwin private-group evidence and never substitutes Windows PID evidence', () => {
    const witness = {
      version: 1,
      platform: 'darwin',
      ownerId: randomUUID(),
      owner: { pid: 101, started: 'Sat Oct 24 01:00:00 2026' },
      root: { pid: 102, pgid: 102, started: 'Sat Oct 24 01:00:01 2026' },
      members: [{ pid: 102, pgid: 102, started: 'Sat Oct 24 01:00:01 2026' }],
    }
    expect(decisionPhysicalWitnessSchema.parse(witness)).toEqual(witness)
    expect(decisionPhysicalWitnessSchema.safeParse({ ...witness, platform: 'win32' }).success).toBe(
      false,
    )
    expect(
      decisionPhysicalWitnessSchema.safeParse({
        version: 2,
        platform: 'win32',
        pid: 102,
        jobName: 'gone',
      }).success,
    ).toBe(false)
  })

  it('permits only the same allocation to become a contained suspended native root', () => {
    const allocated = decisionPhysicalWitnessSchema.parse(allocation())
    const contained = decisionPhysicalWitnessSchema.parse({
      ...allocated,
      phase: 'contained',
      bridge: { pid: 102, creationFileTime: '134369000000000002' },
      root: { pid: 103, creationFileTime: '134369000000000003' },
      atomicJob: true,
      noBreakaway: true,
    })
    expect(decisionPhysicalWitnessExtends(allocated, contained)).toBe(true)
    expect(decisionPhysicalWitnessExtends(contained, contained)).toBe(true)
    expect(decisionPhysicalWitnessExtends(contained, allocated)).toBe(false)
    for (const patch of [
      { generation: randomUUID() },
      { ownerId: randomUUID() },
      { owner: { pid: 101, creationFileTime: '134369000000000009' } },
      { receipt: { ...allocation().receipt, fileId: 'b'.repeat(32) } },
      { root: { pid: 103, creationFileTime: '134369000000000004' } },
    ]) {
      const replaced = decisionPhysicalWitnessSchema.parse({ ...contained, ...patch })
      expect(decisionPhysicalWitnessExtends(contained, replaced)).toBe(false)
    }
  })

  it('retains exact uint64 process births and refuses incomplete containment or escape permission', () => {
    const value = allocation()
    expect(
      decisionPhysicalWitnessSchema.parse({
        ...value,
        owner: { pid: 101, creationFileTime: '18446744073709551615' },
      }),
    ).toBeDefined()
    for (const creationFileTime of ['18446744073709551616', '001', '1.2', '0', '-1', 'invalid'])
      expect(
        decisionPhysicalWitnessSchema.safeParse({ ...value, owner: { pid: 101, creationFileTime } })
          .success,
      ).toBe(false)
    expect(decisionPhysicalWitnessSchema.safeParse({ ...value, phase: 'contained' }).success).toBe(
      false,
    )
    const contained = {
      ...value,
      phase: 'contained',
      bridge: { pid: 102, creationFileTime: '134369000000000002' },
      root: { pid: 103, creationFileTime: '134369000000000003' },
      atomicJob: true,
      noBreakaway: true,
    }
    for (const patch of [
      { noBreakaway: false },
      { atomicJob: false },
      { root: contained.bridge },
      { unboundedMembers: [] },
    ])
      expect(decisionPhysicalWitnessSchema.safeParse({ ...contained, ...patch }).success).toBe(
        false,
      )
  })
})
