import { describe, expect, it } from 'vitest'

import type { CollaborationStage, RuntimeAgentId } from '@pact/contracts'

import { planRunInput } from './collaboration-fixture.test-support.js'
import { collaborationInstructions } from './collaboration-prompt.js'

describe('collaboration revision guidance instructions', () => {
  it('reads the current complete manifest and original evidence while preserving turn authority', () => {
    const input = planRunInput('codex')
    const task = input.promptEnvelope.collaboration!
    const authorization = input.promptEnvelope.collaborationAuthorization!
    authorization.sourceManifestRef = {
      id: '00000000-0000-4000-8000-000000000001',
      sha256: 'a'.repeat(64),
      bytes: 100,
      chars: 100,
    }
    const prompt = collaborationInstructions(task, authorization)
    expect(prompt).toContain(
      `Current source manifest: ${JSON.stringify(authorization.sourceManifestRef)}`,
    )
    expect(prompt).toContain('Read this complete paginated manifest')
    expect(prompt).toContain('complete original task, inputs, plan and review sources')
    expect(prompt).toContain(
      'schema version plan-revision-guidance-v1; reject unknown guidance versions',
    )
    expect(prompt).toContain(
      'optional focus that you may reject after checking the original sources',
    )
    expect(prompt).toContain(
      'never replaces those sources, changes the fixed roles or current stage',
    )
    expect(prompt).toContain('or grants execution authority')
    expect(prompt).toContain('Historical grants are invalid; use only the current sourceGrant')
    expect(prompt).toContain(
      'Continue each needed source from offset 0 through every nextOffset until null',
    )
    expect(prompt).toContain('Remain in native planning mode')
  })

  it('keeps ordinary planning prompts unchanged when no source manifest is frozen', () => {
    const input = planRunInput('claude')
    const prompt = collaborationInstructions(
      input.promptEnvelope.collaboration!,
      input.promptEnvelope.collaborationAuthorization,
    )
    expect(prompt).not.toContain('Current source manifest:')
    expect(prompt).not.toContain('adopted revision guidance')
    expect(prompt).toContain(
      'Read the complete supplied task, current inputs and relevant plan/review scope',
    )
    expect(prompt).toContain(
      'Plan submission requests independent review in Pact; it never authorizes implementation',
    )
  })
})

const stagePrompt = (stage: CollaborationStage, actor: RuntimeAgentId) => {
  const input = planRunInput('codex')
  return collaborationInstructions(input.promptEnvelope.collaboration!, {
    ...input.promptEnvelope.collaborationAuthorization!,
    stage,
    actor,
  })
}

describe('adversarial review instructions', () => {
  it.each(['plan_review', 'code_review'] as const)(
    'gives the %s reviewer an adversarial stance grounded in checked evidence',
    (stage) => {
      const prompt = stagePrompt(stage, 'claude')
      expect(prompt).toContain('Review adversarially')
      expect(prompt).toContain('Do not rely on the author’s summary')
      expect(prompt).toContain('an author’s response or claimed fix is a claim, not evidence')
      expect(prompt).toContain('A finding is blocking only when, in a reachable scenario')
      expect(prompt).toContain('an unconfirmed concern is not a defect')
      expect(prompt).toContain('never manufacture a defect to look rigorous')
      expect(prompt).toContain('accepted only after you actively tried to break the work')
      expect(prompt).toContain('Submit exactly one submit_review verdict')
    },
  )

  it('makes the plan reviewer attack the plan’s implementability', () => {
    const prompt = stagePrompt('plan_review', 'claude')
    expect(prompt).toContain('Attack the plan, not only its wording')
    expect(prompt).toContain(
      'Treat a materially simpler or safer approach as a suggestion unless the current approach has a blocking defect',
    )
    expect(prompt).toContain('Acceptance means the current plan is implementable')
  })

  it('makes the code reviewer distrust reported results and stay read-only', () => {
    const prompt = stagePrompt('code_review', 'claude')
    expect(prompt).toContain('with the accepted plan when one exists')
    expect(prompt).toContain('Examine the tests as hard as the code')
    expect(prompt).toContain(
      'A completed Agent Run or tool acknowledgement does not establish that tests passed',
    )
    expect(prompt).toContain('Do not modify code or expand permissions to obtain verification')
  })

  it.each(['plan', 'implement', 'respond', 'repair', 'reply'] as const)(
    'keeps the reviewer stance out of the %s stage',
    (stage) => {
      expect(stagePrompt(stage, 'codex')).not.toContain('Review adversarially')
    },
  )

  it('makes authors answer findings with checked evidence instead of agreement', () => {
    expect(stagePrompt('respond', 'codex')).toContain('instead of agreeing or defending by default')
    expect(stagePrompt('repair', 'codex')).toContain(
      'Do not weaken, delete or skip tests or checks',
    )
    expect(stagePrompt('implement', 'codex')).toContain(
      'Disclose deviations from the accepted plan or request',
    )
  })

  it('makes the plan author self-review adversarially without dropping findings', () => {
    const prompt = stagePrompt('plan', 'codex')
    expect(prompt).toContain('challenge it as an adversarial reviewer would')
    expect(prompt).toContain('Do not silently drop a finding')
  })
})
