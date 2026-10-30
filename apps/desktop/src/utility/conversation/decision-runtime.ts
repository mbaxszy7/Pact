import type {
  DecisionCapability,
  DecisionCapabilityReason,
  DecisionInput,
  DecisionOutcome,
  SchedulingUsage,
} from '@pact/contracts'

export type { DecisionCapability, DecisionCapabilityReason } from '@pact/contracts'

/** Complete host-owned sources are loaded inside the invocation's original deadline and lease. */
export type DecisionInputLoader = (context: {
  signal: AbortSignal
  deadlineAt: number
}) => Promise<DecisionInput> | DecisionInput

/** One disposable native invocation; the host retains all scheduling and authorization policy. */
export interface DecisionRuntime {
  /** Zero-Turn native compatibility evidence. It never authorizes a later invocation. */
  probeAdmission(signal?: AbortSignal): Promise<DecisionCapability>
  evaluateDecision(
    // oxlint-disable-next-line typescript/no-redundant-type-constituents -- Name the supported loader while retaining runtime validation of all callers.
    value: unknown | DecisionInputLoader,
    signal: AbortSignal,
  ): Promise<DecisionOutcome>
  dispose(): Promise<boolean>
  settlement(): Promise<boolean>
  readonly invoked: boolean
  readonly usage: SchedulingUsage | undefined
  diagnostics(): {
    phase: string
    failure: string | undefined
    failureReason?: DecisionCapabilityReason | undefined
    refusalCode: number | undefined
    working: {
      heldBytes: number
      highWaterBytes: number
      items: number
      released: boolean
    }
  }
}

/** Same native protocol for both providers; information is available only on the explicit host candidate. */
export function decisionRuntimePrompt(input: DecisionInput): string {
  const base =
    'Return only JSON with candidateId (an allowed candidate ID or null) and highlights (at most eight {text,sourceIds} entries). Use only the complete supplied sources. Write highlight explanations in English and preserve exact sourceIds; quoted source facts remain complete. This is advice, never authorization. Do not use tools. If unable to judge, return {"candidateId":null,"highlights":[]}.\n\n'
  if (!input.candidates.some((candidate) => candidate.id === 'clarify_prepared_input')) return base
  return (
    base +
    'The candidate clarify_prepared_input selects the existing unanswered user-declared field supplied by the host. Read its complete declaration and current sources. Return information:{fieldId:"the exact admitted field ID"} with highlights:[] only for that candidate. The question, choices and answer state belong to the host; never invent or change them, infer another missing field from prose, or ask for technical facts. Otherwise select an existing recipient or null and OMIT information. A field selection grants no authority or recipient change.\n\n'
  )
}
