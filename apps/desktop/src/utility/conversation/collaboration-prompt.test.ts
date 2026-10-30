import { describe, expect, it } from 'vitest'

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
