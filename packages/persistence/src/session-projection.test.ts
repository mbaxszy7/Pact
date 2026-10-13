import { describe, expect, it } from 'vitest'

import { projectSessionTitle } from './session-projection.js'

describe('Session title projection', () => {
  it('hides an Agent title derived from the internal Pact Prompt envelope', () => {
    expect(
      projectSessionTitle('{"version":"pact-agent-prompt-v1","sessionId":"session-1"}', 'agent'),
    ).toEqual({ title: 'New session', titleSource: 'placeholder' })
  })

  it('preserves user titles even when they quote the envelope marker', () => {
    const title = 'Why is "version":"pact-agent-prompt-v1" visible?'

    expect(projectSessionTitle(title, 'user')).toEqual({ title, titleSource: 'user' })
  })
})
