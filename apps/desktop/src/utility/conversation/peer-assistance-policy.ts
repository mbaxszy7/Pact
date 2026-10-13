import { randomUUID } from 'node:crypto'

import type { PeerRequestToolInput, RuntimeAgentId } from '@pact/contracts'

import { peerRequestToolInputSchema } from '@pact/contracts'

export const PEER_ASSISTANCE_INSTRUCTIONS = [
  'Evaluate peer assistance independently for every current Turn. A Proposal recorded in an earlier Turn never prevents a new eligible Proposal now.',
  'After completing your own substantive analysis, use request_peer_assistance exactly once when any of these conditions applies: review for a substantial code or design review; challenge for material ambiguity or tradeoffs in requirements or a plan; fact_check for a key fact that could change the conclusion; supplement for genuinely missing important context or perspective.',
  'For a difficult bug with competing root causes or conflicting evidence, use challenge when the peer should test the causal explanation or approach, and fact_check when the peer should verify decisive evidence or a key fact.',
  'The user does not need to explicitly ask for the peer when one of these conditions applies.',
  'If none of the listed conditions applies, do not call the Tool. Do not propose peer assistance for routine work, simple fixes, or a request that already explicitly routes to both Agents.',
  'A peer proposal is an optional follow-up and never substitutes for your current answer.',
  'Reach your own conclusion and give the user a complete, substantive answer even if they choose Not now.',
  'Do not mention anywhere in the user-facing answer the Tool, Proposal, routing, recording, approval flow, or what the peer should review.',
  'Put only a short rationale in reason, then continue the user-facing answer itself.',
].join(' ')

export const PEER_ASSISTANCE_TOOL_DESCRIPTION =
  'For this Turn only, after completing your own substantive analysis, record one inert suggestion for the user to ask the other Pact Agent. Use review for substantial code or design review; challenge for material requirements or plan tradeoffs; fact_check for a conclusion-changing fact; and supplement for missing important context or perspective. For difficult bugs, choose challenge for competing causal explanations or fact_check for decisive evidence. A prior Turn does not count. This never invokes the peer and never replaces the current answer.'

export const PEER_ASSISTANCE_RECORDED_RESULT =
  'Request accepted for this Turn. Do not mention this Tool or its routing. Finish the current user-facing answer with your own substantive conclusion.'

export type PeerAssistanceAdmission =
  | { ok: true; request: PeerRequestToolInput }
  | { ok: false; error: string }

/** One Turn's provider-independent Proposal validation and duplicate guard. */
export class PeerAssistanceTurn {
  readonly receipt = randomUUID()
  private recorded = false

  constructor(
    private readonly expectedTarget: RuntimeAgentId,
    private readonly allowed: boolean,
  ) {}

  accept(input: unknown): PeerAssistanceAdmission {
    const admission = this.validate(input)
    if (!admission.ok) return admission
    if (this.recorded) return { ok: false, error: 'This answer already has a peer request.' }
    this.recorded = true
    return admission
  }

  /** Validation alone cannot consume a root Turn's single completed Proposal. */
  validate(input: unknown): PeerAssistanceAdmission {
    if (!this.allowed)
      return { ok: false, error: 'Peer assistance is unavailable for this routed request.' }
    const parsed = peerRequestToolInputSchema.safeParse(input)
    if (!parsed.success) return { ok: false, error: 'Peer request arguments are invalid.' }
    if (parsed.data.target !== this.expectedTarget)
      return { ok: false, error: 'An Agent can only request the other Pact Agent.' }
    return { ok: true, request: parsed.data }
  }
}
