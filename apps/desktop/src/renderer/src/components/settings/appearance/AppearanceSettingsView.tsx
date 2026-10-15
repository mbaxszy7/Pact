import { useRef } from 'react'

import type {
  AppearanceEffectiveSettings,
  AppearanceSettings,
  AppearanceTheme,
  WindowMaterial,
} from '@pact/contracts'

import { MATERIAL_OPACITY_MAX, MATERIAL_OPACITY_MIN } from '@pact/contracts'

interface AppearanceSettingsViewProps {
  settings: AppearanceSettings | undefined
  effective: AppearanceEffectiveSettings | undefined
  loading: boolean
  saving: boolean
  loadError?: string | undefined
  saveError?: string | undefined
  onThemeChange: (theme: AppearanceTheme) => void
  onMaterialChange: (material: WindowMaterial) => void
  onMaterialOpacityPreview: (opacity: number) => void
  onMaterialOpacityCommit: (opacity: number) => void
  onReset: () => void
  onRetry: () => void
  platform: 'darwin' | 'win32' | 'linux' | undefined
}

const themeOptions: ReadonlyArray<{
  value: AppearanceTheme
  label: string
  description?: string
}> = [
  { value: 'system', label: 'Follow system', description: 'Match your device.' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

const materialOptions: ReadonlyArray<{
  value: WindowMaterial
  label: string
  description?: string
}> = [
  { value: 'system', label: 'Automatic', description: 'Use an available system background.' },
  { value: 'solid', label: 'Solid' },
  { value: 'translucent', label: 'Translucent' },
]

function fallbackDetail(reason: AppearanceEffectiveSettings['fallbackReason']): string | undefined {
  switch (reason) {
    case 'reduced_transparency':
      return 'Your system is reducing transparency.'
    case 'high_contrast':
      return 'High contrast is on.'
    case 'forced_colors':
      return 'System colors are overriding Pact.'
    case 'native_material_initialization_failed':
      return 'The background effect could not be applied.'
    case 'native_material_not_supported':
      return 'This background is unavailable on this device.'
    default:
      return undefined
  }
}

function toEffectStrength(opacity: number): number {
  return Math.round(
    ((MATERIAL_OPACITY_MAX - opacity) / (MATERIAL_OPACITY_MAX - MATERIAL_OPACITY_MIN)) * 100,
  )
}

function toMaterialOpacity(strength: number): number {
  return Math.round(
    MATERIAL_OPACITY_MAX - (strength / 100) * (MATERIAL_OPACITY_MAX - MATERIAL_OPACITY_MIN),
  )
}

function PreferenceOptions<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; description?: string }>
  disabled: boolean
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="mt-group divide-y divide-border border-y border-border">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex min-h-12 cursor-pointer items-center gap-group px-group py-2 hover:bg-surface-muted has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-[-2px] has-[:focus-visible]:outline-focus has-[:disabled]:cursor-not-allowed"
        >
          <input
            className="size-4 shrink-0 accent-focus"
            type="radio"
            name={name}
            value={option.value}
            aria-label={option.label}
            checked={value === option.value}
            disabled={disabled}
            onChange={() => onChange(option.value)}
          />
          <span className="min-w-0">
            <span className="block text-body font-medium text-primary">{option.label}</span>
            {option.description ? (
              <span className="mt-0.5 block text-caption text-secondary">{option.description}</span>
            ) : null}
          </span>
        </label>
      ))}
    </div>
  )
}

export function AppearanceSettingsView({
  settings,
  effective,
  loading,
  saving,
  loadError,
  saveError,
  onThemeChange,
  onMaterialChange,
  onMaterialOpacityPreview,
  onMaterialOpacityCommit,
  onReset,
  onRetry,
  platform,
}: AppearanceSettingsViewProps): React.JSX.Element {
  const lastCommittedOpacity = useRef<number | undefined>(undefined)
  const defaultValues =
    settings?.theme === 'system' &&
    settings.windowMaterial === 'system' &&
    settings.materialOpacity === 85
  const backgroundEffectActive = effective?.windowMaterial === 'translucent'
  const backgroundOptions = materialOptions.map((option) =>
    platform === 'win32' && option.value === 'translucent'
      ? { value: option.value, label: option.label, description: 'Requires restarting Pact.' }
      : option,
  )
  const effectStrength = settings ? toEffectStrength(settings.materialOpacity) : 50
  const fallbackMessage =
    settings?.windowMaterial === 'translucent'
      ? fallbackDetail(effective?.fallbackReason)
      : undefined
  const commitOpacity = (opacity: number): void => {
    if (lastCommittedOpacity.current === opacity) return
    lastCommittedOpacity.current = opacity
    onMaterialOpacityCommit(opacity)
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-[52rem] flex-col p-section sm:p-spacious">
      <header className="border-b border-border pb-section">
        <h2 className="text-title font-medium tracking-[-0.025em] text-primary">Appearance</h2>
        <p className="mt-2 max-w-prose text-body text-secondary">
          {platform === 'win32'
            ? 'Theme changes apply immediately. Changing the window background requires restarting Pact.'
            : 'Changes apply to every Pact window.'}
        </p>
      </header>

      {loading ? (
        <output className="mt-section block text-body text-secondary">
          Loading appearance settings…
        </output>
      ) : null}

      {loadError ? (
        <div className="mt-section border-y border-border py-group" role="alert">
          <p className="text-body font-medium text-danger">Couldn’t load appearance.</p>
          <p className="mt-1 text-caption text-secondary">{loadError}</p>
          <button
            className="mt-group h-9 rounded-control border border-border bg-surface-raised px-4 text-body font-medium text-primary hover:bg-surface-muted"
            type="button"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
      ) : null}

      {settings && effective ? (
        <div className="flex-1">
          <section className="mt-section" aria-labelledby="appearance-theme-heading">
            <h3 id="appearance-theme-heading" className="text-subtitle font-medium text-primary">
              Theme
            </h3>
            <PreferenceOptions
              name="appearance-theme"
              value={settings.theme}
              options={themeOptions}
              disabled={saving}
              onChange={onThemeChange}
            />
          </section>

          <section className="mt-spacious" aria-labelledby="appearance-material-heading">
            <h3 id="appearance-material-heading" className="text-subtitle font-medium text-primary">
              Window background
            </h3>
            <PreferenceOptions
              name="appearance-material"
              value={settings.windowMaterial}
              options={backgroundOptions}
              disabled={saving}
              onChange={onMaterialChange}
            />
            {effective.restartRequired ? (
              <output className="mt-group block rounded-control bg-surface-muted px-group py-2 text-caption text-secondary">
                <span className="font-medium text-primary">Restart required.</span> Currently using{' '}
                {effective.windowMaterial === 'solid' ? 'Solid' : 'Translucent'}. To apply your
                selected background, choose Exit in Pact’s tray menu, then open Pact again. Closing
                the window keeps Pact running and does not apply the change.
              </output>
            ) : null}
            {fallbackMessage ? (
              <output className="mt-group block rounded-control bg-surface-muted px-group py-2 text-caption text-secondary">
                <span className="font-medium text-primary">Using Solid.</span> {fallbackMessage}
              </output>
            ) : null}
          </section>

          <section
            className="mt-spacious border-t border-border pt-section"
            aria-labelledby="appearance-opacity-heading"
          >
            <div className="flex items-baseline justify-between gap-group">
              <h3
                id="appearance-opacity-heading"
                className="text-subtitle font-medium text-primary"
              >
                Transparency strength
              </h3>
              <output className="text-body font-medium text-primary" htmlFor="appearance-opacity">
                {effectStrength}
              </output>
            </div>
            <input
              id="appearance-opacity"
              className="mt-group w-full accent-focus disabled:cursor-not-allowed"
              type="range"
              min={0}
              max={100}
              value={effectStrength}
              disabled={!backgroundEffectActive}
              aria-labelledby="appearance-opacity-heading"
              aria-describedby={backgroundEffectActive ? undefined : 'appearance-opacity-help'}
              aria-valuetext={`${effectStrength} out of 100`}
              onInput={(event) => {
                lastCommittedOpacity.current = undefined
                onMaterialOpacityPreview(toMaterialOpacity(Number(event.currentTarget.value)))
              }}
              onPointerUp={(event) =>
                commitOpacity(toMaterialOpacity(Number(event.currentTarget.value)))
              }
              onKeyUp={(event) => {
                if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') {
                  commitOpacity(toMaterialOpacity(Number(event.currentTarget.value)))
                }
              }}
              onBlur={(event) =>
                commitOpacity(toMaterialOpacity(Number(event.currentTarget.value)))
              }
            />
            <div className="flex justify-between gap-group text-caption text-secondary">
              <span>Subtle</span>
              <span>Strong</span>
            </div>
            {!backgroundEffectActive ? (
              <p id="appearance-opacity-help" className="mt-2 text-caption text-secondary">
                {effective.restartRequired
                  ? settings.windowMaterial === 'translucent'
                    ? 'Restart Pact to enable transparency and adjust its strength.'
                    : 'Restart Pact to use your selected background.'
                  : 'Choose Translucent to adjust this.'}
              </p>
            ) : null}
          </section>

          <footer className="mt-spacious flex flex-wrap items-center justify-between gap-group border-t border-border pt-section">
            <output className="text-caption text-secondary">{saving ? 'Saving…' : 'Saved'}</output>
            <button
              className="h-9 rounded-control border border-border bg-surface-raised px-4 text-body font-medium text-primary hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={saving || defaultValues}
              onClick={onReset}
            >
              Restore defaults
            </button>
          </footer>

          {saveError ? (
            <p className="mt-group text-body text-danger" role="alert">
              {saveError}
            </p>
          ) : null}
        </div>
      ) : null}
    </main>
  )
}
