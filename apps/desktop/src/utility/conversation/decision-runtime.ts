import type {
  DecisionCapabilityReason,
  DecisionInput,
  DecisionRemoteOutcome,
  DecisionSelectionOutcome,
  SchedulingUsage,
} from '@pact/contracts'

export type { DecisionCapabilityReason } from '@pact/contracts'

/** Complete host-owned sources are loaded inside the invocation's original deadline and lease. */
export type DecisionInputLoader = (context: {
  signal: AbortSignal
  deadlineAt: number
}) => Promise<DecisionInput> | DecisionInput

/** One disposable HTTP invocation; the host retains all scheduling and authorization policy. */
export interface DecisionRuntime {
  /** Accepts a complete DecisionInput or DecisionInputLoader; validates every supplied value. */
  evaluateDecision(value: unknown, signal: AbortSignal): Promise<DecisionSelectionOutcome>
  dispose(): Promise<boolean>
  settlement(): Promise<boolean>
  readonly invoked: boolean
  readonly usage: SchedulingUsage | undefined
  diagnostics(): {
    phase: string
    failure: string | undefined
    failureReason?: DecisionCapabilityReason | undefined
    refusalCode: number | undefined
    remoteOutcome: DecisionRemoteOutcome
    working: {
      heldBytes: number
      highWaterBytes: number
      items: number
      released: boolean
    }
  }
}
