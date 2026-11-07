import { z } from 'zod'

const processBirthSchema = z.strictObject({
  pid: z.number().int().positive().max(0x7fffffff),
  started: z.string().min(1).max(64),
})
const darwinPhysicalWitnessSchema = z
  .strictObject({
    version: z.literal(1),
    platform: z.literal('darwin'),
    ownerId: z.string().uuid(),
    owner: processBirthSchema,
    root: processBirthSchema.extend({ pgid: z.number().int().positive().max(0x7fffffff) }),
    members: z
      .array(processBirthSchema.extend({ pgid: z.number().int().positive().max(0x7fffffff) }))
      .min(1)
      .max(256),
  })
  .refine(
    (value) =>
      value.root.pid === value.root.pgid &&
      value.owner.pid !== value.root.pid &&
      new Set(value.members.map((member) => member.pid)).size === value.members.length &&
      value.members.every((member) => member.pgid === value.root.pgid) &&
      value.members.some(
        (member) => member.pid === value.root.pid && member.started === value.root.started,
      ) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2 * 1024,
  )
const windowsProcessBirthSchema = z.strictObject({
  pid: z.number().int().positive().max(0x7fffffff),
  creationFileTime: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/u)
    .refine((value) => /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= 18446744073709551615n),
})
const windowsAllocationSchema = z.strictObject({
  version: z.literal(2),
  platform: z.literal('win32'),
  ownerId: z.string().uuid(),
  generation: z.string().uuid(),
  protocolVersion: z.literal(1),
  phase: z.literal('allocated'),
  owner: windowsProcessBirthSchema,
  receipt: z.strictObject({
    id: z.string().uuid(),
    volumeSerial: z.string().regex(/^[a-f0-9]{16}$/u),
    fileId: z.string().regex(/^[a-f0-9]{32}$/u),
  }),
})
const windowsContainedSchema = windowsAllocationSchema
  .extend({
    phase: z.literal('contained'),
    bridge: windowsProcessBirthSchema,
    root: windowsProcessBirthSchema,
    atomicJob: z.literal(true),
    noBreakaway: z.literal(true),
  })
  .refine((value) => new Set([value.owner.pid, value.bridge.pid, value.root.pid]).size === 3)
const windowsPhysicalWitnessSchema = z.discriminatedUnion('phase', [
  windowsAllocationSchema,
  windowsContainedSchema,
])

/** Versioned physical identities; Windows Job ownership is never represented as a POSIX group. */
export const decisionPhysicalWitnessSchema = z
  .union([darwinPhysicalWitnessSchema, windowsPhysicalWitnessSchema])
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 2 * 1024)
export type DecisionDarwinPhysicalWitness = z.infer<typeof darwinPhysicalWitnessSchema>
export type DecisionWindowsPhysicalWitness = z.infer<typeof windowsPhysicalWitnessSchema>
export type DecisionPhysicalWitness = z.infer<typeof decisionPhysicalWitnessSchema>

/** Same physical invocation may add witnessed members or progress from suspended allocation. */
export function decisionPhysicalWitnessExtends(
  previous: DecisionPhysicalWitness,
  next: DecisionPhysicalWitness,
): boolean {
  if (
    previous.platform !== next.platform ||
    previous.ownerId !== next.ownerId ||
    JSON.stringify(previous.owner) !== JSON.stringify(next.owner)
  )
    return false
  if (previous.platform === 'darwin' && next.platform === 'darwin')
    return (
      JSON.stringify(previous.root) === JSON.stringify(next.root) &&
      previous.members.every((known) =>
        next.members.some(
          (current) =>
            current.pid === known.pid &&
            current.pgid === known.pgid &&
            current.started === known.started,
        ),
      )
    )
  if (previous.platform !== 'win32' || next.platform !== 'win32') return false
  if (
    previous.generation !== next.generation ||
    previous.protocolVersion !== next.protocolVersion ||
    JSON.stringify(previous.receipt) !== JSON.stringify(next.receipt)
  )
    return false
  return (
    previous.phase === 'allocated' ||
    (next.phase === 'contained' &&
      JSON.stringify(previous.bridge) === JSON.stringify(next.bridge) &&
      JSON.stringify(previous.root) === JSON.stringify(next.root))
  )
}
