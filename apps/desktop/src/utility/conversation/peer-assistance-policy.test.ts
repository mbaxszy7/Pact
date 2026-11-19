import { describe, expect, it } from 'vitest'

import { PeerAssistanceTurn } from './peer-assistance-policy.js'

describe('PeerAssistanceTurn', () => {
  it('enforces one target and one proposal per Turn', () => {
    const turn = new PeerAssistanceTurn('claude', true)
    expect(turn.accept({ target: 'codex', kind: 'review' })).toMatchObject({ ok: false })
    expect(turn.accept({ target: 'claude', kind: 'review', reason: 'probe' })).toMatchObject({
      ok: true,
    })
    expect(turn.accept({ target: 'claude', kind: 'review' })).toMatchObject({
      ok: false,
      error: 'This answer already has a peer request.',
    })
    expect(turn.receipt).toBeTruthy()
    expect(
      new PeerAssistanceTurn('claude', false).accept({ target: 'claude', kind: 'review' }),
    ).toMatchObject({
      ok: false,
      error: 'Peer assistance is unavailable for this routed request.',
    })
  })
})
