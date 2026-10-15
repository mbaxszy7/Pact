import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppearanceSettings } from '@pact/contracts'

import type { AppearanceController } from './controller.js'

import { createAppearanceController } from './controller.js'

const runtime = vi.hoisted(() => ({ platform: 'win32' as NodeJS.Platform, windowsBuild: 26_100 }))
vi.mock('./material.js', async (original) => ({
  ...(await original<typeof import('./material.js')>()),
  currentMaterialRuntime: () => ({ ...runtime }),
}))

const controllers: AppearanceController[] = []
beforeEach(() => {
  runtime.platform = 'win32'
})
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
})

function fixture(material: AppearanceSettings['windowMaterial'] = 'translucent') {
  const theme = Object.assign(new EventEmitter(), {
    themeSource: 'system' as const,
    shouldUseDarkColors: true,
    prefersReducedTransparency: false,
    shouldUseHighContrastColors: false,
    inForcedColorsMode: false,
  })
  let saved: AppearanceSettings = {
    theme: 'dark',
    windowMaterial: material,
    materialOpacity: 85,
    revision: 4,
  }
  let failRead = false
  const controller = createAppearanceController(
    {
      request: async (payload) => {
        if (payload.type === 'appearance.get.request' && failRead)
          return {
            kind: 'unknown-delivery',
            error: { code: 'TIMEOUT', message: 'Controlled read timeout.' },
          }
        if (payload.type === 'appearance.update.request')
          saved = {
            theme: payload.input.theme ?? saved.theme,
            windowMaterial: payload.input.windowMaterial ?? saved.windowMaterial,
            materialOpacity: payload.input.materialOpacity ?? saved.materialOpacity,
            revision: saved.revision + 1,
          }
        return {
          kind: 'response',
          response: {
            type: 'appearance.response',
            requestId: 'fixture',
            result: { ok: true, value: saved },
          },
        }
      },
    },
    theme,
  )
  controllers.push(controller)
  return {
    controller,
    theme,
    failRead: (value: boolean) => {
      failRead = value
    },
  }
}

describe('Appearance startup and native material lifetime', () => {
  it('refuses to pin unknown settings and uses saved Translucent after a failed read is retried', async () => {
    const f = fixture()
    f.failRead(true)
    expect((await f.controller.refresh()).ok).toBe(false)
    expect(() => f.controller.getWindowAppearance()).toThrow(/must be loaded/)
    f.failRead(false)
    await f.controller.refresh()
    expect(f.controller.getWindowAppearance()).toEqual({
      windowMaterial: 'translucent',
      backgroundColor: '#00000000',
    })
    await expect(f.controller.refresh()).resolves.toMatchObject({
      ok: true,
      value: {
        requested: { windowMaterial: 'translucent', revision: 4 },
        effective: { windowMaterial: 'translucent' },
      },
    })
    const loaded = await f.controller.refresh()
    expect(loaded.ok && loaded.value.effective.restartRequired).toBeUndefined()
  })

  it('keeps the Windows native mode until full restart, clears the notice on reverting, and applies theme live', async () => {
    const f = fixture('solid')
    await f.controller.refresh()
    expect(f.controller.getWindowAppearance().windowMaterial).toBe('solid')
    const changed = await f.controller.update({
      expectedRevision: 4,
      windowMaterial: 'translucent',
      theme: 'light',
    })
    expect(changed).toMatchObject({
      ok: true,
      value: {
        requested: { windowMaterial: 'translucent' },
        effective: { windowMaterial: 'solid', theme: 'light', restartRequired: true },
      },
    })
    expect(f.controller.getWindowAppearance()).toEqual({
      windowMaterial: 'solid',
      backgroundColor: '#ebf5ff',
    })
    const reverted = await f.controller.update({ expectedRevision: 5, windowMaterial: 'solid' })
    expect(reverted.ok && reverted.value.effective.restartRequired).toBeUndefined()
  })

  it('allows accessibility to paint a transparent-backed window Solid and restore it live', async () => {
    const f = fixture()
    await f.controller.refresh()
    f.controller.getWindowAppearance()
    f.theme.prefersReducedTransparency = true
    f.theme.emit('updated')
    await expect(f.controller.refresh()).resolves.toMatchObject({
      ok: true,
      value: { effective: { windowMaterial: 'solid', fallbackReason: 'reduced_transparency' } },
    })
    f.theme.prefersReducedTransparency = false
    f.theme.emit('updated')
    const restored = await f.controller.refresh()
    expect(restored.ok && restored.value.effective.windowMaterial).toBe('translucent')
    expect(restored.ok && restored.value.effective.restartRequired).toBeUndefined()
  })

  it('keeps a window created opaque by accessibility opaque when policy later permits transparency', async () => {
    const f = fixture()
    f.theme.prefersReducedTransparency = true
    await f.controller.refresh()
    expect(f.controller.getWindowAppearance().windowMaterial).toBe('solid')
    f.theme.prefersReducedTransparency = false
    f.theme.emit('updated')
    await expect(f.controller.refresh()).resolves.toMatchObject({
      ok: true,
      value: { effective: { windowMaterial: 'solid', restartRequired: true } },
    })
  })

  it('retains live macOS material changes rather than applying the Windows startup pin', async () => {
    runtime.platform = 'darwin'
    const f = fixture('solid')
    await f.controller.refresh()
    f.controller.getWindowAppearance()
    const updated = await f.controller.update({
      expectedRevision: 4,
      windowMaterial: 'translucent',
    })
    expect(updated.ok && updated.value.effective.windowMaterial).toBe('translucent')
    expect(updated.ok && updated.value.effective.restartRequired).toBeUndefined()
  })
})
