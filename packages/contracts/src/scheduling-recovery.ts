import { z } from 'zod'

import { decisionPhysicalWitnessSchema } from './decision-physical-witness.js'

/** Readback provenance. A shared RPC reply never proves its native process group closed. */
export const schedulingCheckPhysicalOwnerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('utility_io') }),
  z.strictObject({ kind: z.literal('shared_rpc') }),
  z.strictObject({ kind: z.literal('inspection_pending') }),
  z.strictObject({ kind: z.literal('inspection_group'), witness: decisionPhysicalWitnessSchema }),
])
export type SchedulingCheckPhysicalOwner = z.infer<typeof schedulingCheckPhysicalOwnerSchema>
