import { describe, expect, it } from 'vitest'

import { commentAnchorSchema } from './anchored-comments.js'

const anchor = {
  type: 'message',
  messageId: '00000000-0000-4000-8000-000000000001',
  contentHash: 'a'.repeat(64),
  textBasis: 'markdown-visible-v2',
  startOffset: 0,
  endOffset: 4,
  quote: 'Plan',
}
describe('versioned plan Comment references', () => {
  it('keeps ordinary Message anchors compatible and accepts one exact plan source', () => {
    expect(commentAnchorSchema.parse(anchor)).toEqual(anchor)
    const plan = { runId: '00000000-0000-4000-8000-000000000002', version: 1 }
    expect(commentAnchorSchema.parse({ ...anchor, plan })).toEqual({ ...anchor, plan })
  })
  it.each([
    { runId: 'invalid', version: 1 },
    { runId: '00000000-0000-4000-8000-000000000002', version: 0 },
    { runId: '00000000-0000-4000-8000-000000000002', version: 1, content: 'forged authority' },
  ])('rejects an invalid or unowned source descriptor %j', (plan) => {
    expect(commentAnchorSchema.safeParse({ ...anchor, plan }).success).toBe(false)
  })
})
