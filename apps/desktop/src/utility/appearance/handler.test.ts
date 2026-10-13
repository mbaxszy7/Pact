import { describe, expect, it } from 'vitest'

import type { PactDatabase } from '@pact/persistence'

import { handleAppearanceRequest } from './handler.js'

function repository(): PactDatabase['appearanceSettingsRepository'] {
  return {
    read: () => ({ theme: 'system', windowMaterial: 'system', materialOpacity: 85, revision: 0 }),
    update: () => ({
      status: 'conflict',
      currentRevision: 4,
    }),
    reset: () => ({
      status: 'conflict',
      currentRevision: 4,
    }),
  }
}

describe('Appearance utility handler', () => {
  it('returns repository reads and preserves compare-and-swap conflicts', () => {
    const storage = repository()
    expect(
      handleAppearanceRequest(
        storage,
        { type: 'appearance.get.request', requestId: crypto.randomUUID() },
        false,
      ),
    ).toMatchObject({ ok: true, value: { revision: 0 } })
    expect(
      handleAppearanceRequest(
        storage,
        {
          type: 'appearance.update.request',
          requestId: crypto.randomUUID(),
          input: { expectedRevision: 0, theme: 'dark' },
        },
        false,
      ),
    ).toEqual({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'Appearance settings changed at revision 4; refresh before retrying.',
      },
    })
  })

  it('limits forced write failure to mutations', () => {
    const storage = repository()
    expect(
      handleAppearanceRequest(
        storage,
        { type: 'appearance.get.request', requestId: crypto.randomUUID() },
        true,
      ),
    ).toMatchObject({ ok: true })
    expect(
      handleAppearanceRequest(
        storage,
        {
          type: 'appearance.reset.request',
          requestId: crypto.randomUUID(),
          input: { expectedRevision: 0 },
        },
        true,
      ),
    ).toMatchObject({ ok: false, error: { code: 'INTERNAL' } })
  })
})
