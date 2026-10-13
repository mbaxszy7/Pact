import type {
  AppearanceEffectiveSettings,
  AppearanceFallbackReason,
  AppearanceSettings,
} from '@pact/contracts'

export interface NativeThemeSource {
  themeSource: AppearanceSettings['theme']
  readonly shouldUseDarkColors: boolean
  readonly prefersReducedTransparency: boolean
  readonly shouldUseHighContrastColors: boolean
  readonly inForcedColorsMode: boolean
  on(event: 'updated', listener: () => void): void
  removeListener(event: 'updated', listener: () => void): void
}

export type MaterialResult = Omit<AppearanceEffectiveSettings, 'revision'>

export interface MaterialWindow {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setBackgroundMaterial(material: 'mica' | 'none'): void
  setTitleBarOverlay(options: { color: string; symbolColor: string }): void
}

interface MaterialRuntime {
  platform: NodeJS.Platform
  windowsBuild?: number
}

export function currentMaterialRuntime(): MaterialRuntime {
  const platform = process.platform
  const windowsBuild =
    platform === 'win32' && typeof process.getSystemVersion === 'function'
      ? Number(process.getSystemVersion().split('.').at(-1))
      : undefined
  return { platform, ...(windowsBuild === undefined ? {} : { windowsBuild }) }
}

function fallbackReason(
  theme: NativeThemeSource,
  runtime: MaterialRuntime,
  preference: AppearanceSettings['windowMaterial'],
): AppearanceFallbackReason | undefined {
  if (preference === 'solid') return undefined
  if (theme.inForcedColorsMode) return 'forced_colors'
  if (theme.shouldUseHighContrastColors) return 'high_contrast'
  if (theme.prefersReducedTransparency) return 'reduced_transparency'
  if (runtime.platform === 'darwin') return undefined
  if (runtime.platform === 'win32' && (runtime.windowsBuild ?? 0) >= 22_621) return undefined
  return 'native_material_not_supported'
}

function applySolid(
  window: MaterialWindow,
  theme: MaterialResult['theme'],
  platform: NodeJS.Platform,
): void {
  const color = theme === 'dark' ? '#0f1720' : '#ebf5ff'
  if (platform === 'win32') window.setBackgroundMaterial('none')
  window.setBackgroundColor(color)
}

function applyTranslucent(window: MaterialWindow, platform: NodeJS.Platform): void {
  if (platform === 'win32') {
    window.setBackgroundMaterial('none')
    window.setBackgroundColor('#00000000')
  } else if (platform === 'darwin') {
    window.setBackgroundColor('#00000000')
  }
}

export function applyMaterial(
  settings: AppearanceSettings,
  nativeTheme: NativeThemeSource,
  windows: Iterable<MaterialWindow>,
  runtime: MaterialRuntime,
): MaterialResult {
  if (nativeTheme.themeSource !== settings.theme) nativeTheme.themeSource = settings.theme
  const theme =
    settings.theme === 'system'
      ? nativeTheme.shouldUseDarkColors
        ? 'dark'
        : 'light'
      : settings.theme
  let reason = fallbackReason(nativeTheme, runtime, settings.windowMaterial)
  let windowMaterial: MaterialResult['windowMaterial'] =
    settings.windowMaterial === 'solid' || reason ? 'solid' : 'translucent'

  if (runtime.platform === 'win32') {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: theme === 'dark' ? '#f2f7fb' : '#0a0d12',
        })
      }
    }
  }

  if (windowMaterial === 'translucent') {
    try {
      for (const window of windows) {
        if (!window.isDestroyed()) applyTranslucent(window, runtime.platform)
      }
    } catch {
      windowMaterial = 'solid'
      reason = 'native_material_initialization_failed'
    }
  }

  if (windowMaterial === 'solid') {
    for (const window of windows) {
      if (!window.isDestroyed()) {
        try {
          applySolid(window, theme, runtime.platform)
        } catch {
          // Preserve the Solid projection even when window cleanup fails.
        }
      }
    }
  }

  return { theme, windowMaterial, ...(reason ? { fallbackReason: reason } : {}) }
}
