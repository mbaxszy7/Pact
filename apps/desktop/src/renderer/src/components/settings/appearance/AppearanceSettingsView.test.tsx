// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AppearanceEffectiveSettings, AppearanceSettings } from '@pact/contracts'

import { AppearanceSettingsView } from './AppearanceSettingsView'

afterEach(cleanup)

const settings: AppearanceSettings = {
  theme: 'dark',
  windowMaterial: 'translucent',
  materialOpacity: 85,
  revision: 1,
}

const effective: AppearanceEffectiveSettings = {
  theme: 'dark',
  windowMaterial: 'translucent',
  revision: 1,
}

function renderSettings(
  options: {
    settings?: AppearanceSettings
    effective?: AppearanceEffectiveSettings
    onPreview?: (opacity: number) => void
    onCommit?: (opacity: number) => void
  } = {},
): void {
  render(
    <AppearanceSettingsView
      settings={options.settings ?? settings}
      effective={options.effective ?? effective}
      loading={false}
      saving={false}
      onThemeChange={() => undefined}
      onMaterialChange={() => undefined}
      onMaterialOpacityPreview={options.onPreview ?? (() => undefined)}
      onMaterialOpacityCommit={options.onCommit ?? (() => undefined)}
      onReset={() => undefined}
      onRetry={() => undefined}
      platform="darwin"
    />,
  )
}

describe('Appearance transparency control', () => {
  it('shows a 0–100 strength scale while preserving the stored 70–100 range', () => {
    const onPreview = vi.fn<(opacity: number) => void>()
    const onCommit = vi.fn<(opacity: number) => void>()
    renderSettings({ onPreview, onCommit })
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Transparency strength' })
    expect(slider.min).toBe('0')
    expect(slider.max).toBe('100')
    expect(slider.value).toBe('50')

    fireEvent.input(slider, { target: { value: '100' } })
    fireEvent.pointerUp(slider, { target: { value: '100' } })
    expect(onPreview).toHaveBeenLastCalledWith(70)
    expect(onCommit).toHaveBeenLastCalledWith(70)
  })

  it('maps both endpoints and shows only the useful fallback message', () => {
    const onPreview = vi.fn<(opacity: number) => void>()
    renderSettings({ settings: { ...settings, materialOpacity: 70 }, onPreview })
    const slider = screen.getByRole<HTMLInputElement>('slider', { name: 'Transparency strength' })
    expect(slider.value).toBe('100')
    fireEvent.input(slider, { target: { value: '0' } })
    expect(onPreview).toHaveBeenLastCalledWith(100)
  })

  it('keeps the slider disabled and explains an explicit Translucent fallback', () => {
    renderSettings({
      effective: {
        ...effective,
        windowMaterial: 'solid',
        fallbackReason: 'reduced_transparency',
      },
    })
    expect(
      screen.getByRole<HTMLInputElement>('slider', { name: 'Transparency strength' }).disabled,
    ).toBe(true)
    expect(screen.getByText(/Using Solid/)).toBeTruthy()
    expect(screen.getByText(/Your system is reducing transparency/)).toBeTruthy()
    expect(screen.queryByText(/native material API/i)).toBeNull()
  })
})
