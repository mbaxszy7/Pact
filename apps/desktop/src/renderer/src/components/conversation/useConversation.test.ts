import { describe, expect, it } from 'vitest'

import { shouldClearComposerAfterAck } from './useConversation'

describe('Composer acknowledgement', () => {
  it('clears the exact original composer snapshot after a trimmed submission is acknowledged', () => {
    expect(
      shouldClearComposerAfterAck('  hello\n', {
        composerSnapshot: '  hello\n',
      }),
    ).toBe(true)
  })

  it('preserves edits made while the submitted bundle is awaiting acknowledgement', () => {
    expect(
      shouldClearComposerAfterAck('  hello\nplus a follow-up', {
        composerSnapshot: '  hello\n',
      }),
    ).toBe(false)
  })
})
