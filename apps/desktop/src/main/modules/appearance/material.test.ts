import { describe, expect, it } from 'vitest'

import type { AppearanceSettings } from '@pact/contracts'

import { applyMaterial, type MaterialWindow, type NativeThemeSource } from './material.js'

function settings(overrides: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return {
    theme: 'system',
    windowMaterial: 'translucent',
    materialOpacity: 85,
    revision: 1,
    ...overrides,
  }
}

function theme(
  overrides: Partial<{
    dark: boolean
    reducedTransparency: boolean
    highContrast: boolean
    forcedColors: boolean
  }> = {},
): NativeThemeSource {
  let source: NativeThemeSource['themeSource'] = 'system'
  return {
    get themeSource() {
      return source
    },
    set themeSource(value) {
      source = value
    },
    get shouldUseDarkColors() {
      return overrides.dark ?? false
    },
    get prefersReducedTransparency() {
      return overrides.reducedTransparency ?? false
    },
    get shouldUseHighContrastColors() {
      return overrides.highContrast ?? false
    },
    get inForcedColorsMode() {
      return overrides.forcedColors ?? false
    },
    on: () => undefined,
    removeListener: () => undefined,
  }
}

function windowWith(options: { failMaterial?: boolean } = {}): {
  window: MaterialWindow
  calls: string[]
  overlays: Parameters<MaterialWindow['setTitleBarOverlay']>[0][]
} {
  const calls: string[] = []
  const overlays: Parameters<MaterialWindow['setTitleBarOverlay']>[0][] = []
  const window: MaterialWindow = {
    isDestroyed: () => false,
    setBackgroundColor(color: string): void {
      calls.push(`color:${color}`)
      if (options.failMaterial && color === '#00000000') throw new Error('material failed')
    },
    setBackgroundMaterial(material: string): void {
      calls.push(`material:${material}`)
    },
    setTitleBarOverlay(overlay): void {
      overlays.push(overlay)
    },
  }
  return { window, calls, overlays }
}

describe('Appearance material rules', () => {
  it('uses an explicit alpha backing on macOS and restores an opaque Solid background', () => {
    const nativeTheme = theme({ dark: true })
    const fixture = windowWith()
    expect(
      applyMaterial(settings(), nativeTheme, [fixture.window], { platform: 'darwin' }),
    ).toEqual({
      theme: 'dark',
      windowMaterial: 'translucent',
    })
    expect(
      applyMaterial(settings({ windowMaterial: 'solid' }), nativeTheme, [fixture.window], {
        platform: 'darwin',
      }),
    ).toEqual({ theme: 'dark', windowMaterial: 'solid' })
    expect(
      applyMaterial(settings(), nativeTheme, [fixture.window], { platform: 'darwin' }),
    ).toEqual({
      theme: 'dark',
      windowMaterial: 'translucent',
    })
    expect(fixture.calls).toEqual(['color:#00000000', 'color:#0f1720', 'color:#00000000'])
    expect(fixture.overlays).toEqual([])
  })

  it.each(['solid', 'translucent'] as const)(
    'keeps Windows caption controls transparent and follows theme changes with %s material',
    (windowMaterial) => {
      const fixture = windowWith()
      const nativeTheme = theme()
      const runtime = { platform: 'win32' as const, windowsBuild: 26_100 }
      applyMaterial(
        settings({ theme: 'dark', windowMaterial }),
        nativeTheme,
        [fixture.window],
        runtime,
      )
      applyMaterial(
        settings({ theme: 'light', windowMaterial }),
        nativeTheme,
        [fixture.window],
        runtime,
      )

      expect(fixture.overlays).toEqual([
        { color: '#00000000', symbolColor: '#f2f7fb' },
        { color: '#00000000', symbolColor: '#0a0d12' },
      ])
    },
  )

  it('uses an alpha backing on a supported Windows build without a wallpaper material', () => {
    const nativeTheme = theme()
    const fixture = windowWith()
    expect(
      applyMaterial(settings(), nativeTheme, [fixture.window], {
        platform: 'win32',
        windowsBuild: 22_621,
      }),
    ).toEqual({ theme: 'light', windowMaterial: 'translucent' })
    expect(fixture.calls).toEqual(['material:none', 'color:#00000000'])

    const unsupported = windowWith()
    expect(
      applyMaterial(settings(), nativeTheme, [unsupported.window], {
        platform: 'win32',
        windowsBuild: 22_620,
      }),
    ).toEqual({
      theme: 'light',
      windowMaterial: 'solid',
      fallbackReason: 'native_material_not_supported',
    })
    expect(unsupported.calls).toEqual(['material:none', 'color:#ebf5ff'])
  })

  it.each([
    [{ reducedTransparency: true }, 'reduced_transparency'],
    [{ highContrast: true }, 'high_contrast'],
    [{ forcedColors: true }, 'forced_colors'],
  ] as const)('uses Solid when accessibility requires %s', (preference, reason) => {
    const fixture = windowWith()
    expect(
      applyMaterial(settings(), theme(preference), [fixture.window], { platform: 'darwin' }),
    ).toEqual({
      theme: 'light',
      windowMaterial: 'solid',
      fallbackReason: reason,
    })
    expect(fixture.calls).toEqual(['color:#ebf5ff'])
  })

  it('reverts every attached window to Solid when material application throws', () => {
    const first = windowWith()
    const failing = windowWith({ failMaterial: true })
    expect(
      applyMaterial(settings(), theme(), [first.window, failing.window], { platform: 'darwin' }),
    ).toEqual({
      theme: 'light',
      windowMaterial: 'solid',
      fallbackReason: 'native_material_initialization_failed',
    })
    expect(first.calls).toEqual(['color:#00000000', 'color:#ebf5ff'])
    expect(failing.calls).toEqual(['color:#00000000', 'color:#ebf5ff'])
  })

  it('never requests a native effect on an unsupported platform', () => {
    const fixture = windowWith()
    expect(applyMaterial(settings(), theme(), [fixture.window], { platform: 'linux' })).toEqual({
      theme: 'light',
      windowMaterial: 'solid',
      fallbackReason: 'native_material_not_supported',
    })
    expect(fixture.calls).toEqual(['color:#ebf5ff'])
  })
})
