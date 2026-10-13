import { vi } from 'vitest'

import type { DesktopBridge } from '@pact/contracts'

/** Typed native editing/catalog responders shared by tests that mount the Composer. */
export function composerBridgeFixture() {
  return {
    cancelSkillCatalog: vi.fn<DesktopBridge['cancelSkillCatalog']>().mockResolvedValue({
      ok: true,
      value: { ready: true },
    }),
    setComposerEditingState: vi.fn<DesktopBridge['setComposerEditingState']>().mockResolvedValue({
      ok: true,
      value: { ready: true },
    }),
    onComposerEditCommand: vi.fn<DesktopBridge['onComposerEditCommand']>(() => vi.fn<() => void>()),
    settleComposerEdit: vi.fn<DesktopBridge['settleComposerEdit']>().mockResolvedValue({
      ok: true,
      value: { ready: true },
    }),
    readSkillCatalog: vi.fn<DesktopBridge['readSkillCatalog']>(async ({ agentId }) => ({
      ok: true,
      value: {
        agentId,
        generation: '30eeb5dd-cb5f-4e5c-b27c-383a285d593b',
        checkedAt: '2026-10-07T00:00:00.000Z',
        skills: [],
        total: 0,
        nextOffset: null,
      },
    })),
  }
}
