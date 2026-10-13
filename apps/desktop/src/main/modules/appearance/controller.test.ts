import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

import type { AppearanceSettings, AppearanceSnapshot, RpcResult } from '@pact/contracts'

import type {
  UtilityProcessClient,
  UtilityRequestPayload,
  UtilityTransportResult,
} from '../../utility-process/client.js'

import {
  createAppearanceController,
  type AppearanceWindow,
  type NativeThemeSource,
} from './controller.js'

function settings(
  revision: number,
  overrides: Partial<AppearanceSettings> = {},
): AppearanceSettings {
  return {
    theme: 'system',
    windowMaterial: 'solid',
    materialOpacity: 85,
    revision,
    ...overrides,
  }
}

function response(result: RpcResult<AppearanceSettings>): UtilityTransportResult {
  return {
    kind: 'response',
    response: { type: 'appearance.response', requestId: 'test', result },
  }
}

function runtimeWith(
  handler: (payload: UtilityRequestPayload) => Promise<UtilityTransportResult>,
): Pick<UtilityProcessClient, 'request'> {
  return { request: async (payload) => handler(payload) }
}

function nativeTheme(): {
  source: NativeThemeSource
  setDark(value: boolean): void
  emitUpdated(): void
  listenerCount(): number
  themeSource(): NativeThemeSource['themeSource']
} {
  let dark = false
  let source: NativeThemeSource['themeSource'] = 'system'
  const listeners = new Set<() => void>()
  return {
    source: {
      get themeSource() {
        return source
      },
      set themeSource(value) {
        source = value
      },
      get shouldUseDarkColors() {
        return dark
      },
      prefersReducedTransparency: false,
      shouldUseHighContrastColors: false,
      inForcedColorsMode: false,
      on: (_event, listener) => {
        listeners.add(listener)
      },
      removeListener: (_event, listener) => {
        listeners.delete(listener)
      },
    },
    setDark(value): void {
      dark = value
    },
    emitUpdated(): void {
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
    themeSource: () => source,
  }
}

function nativeWindow(): {
  window: AppearanceWindow
  calls: string[]
  overlays: Parameters<AppearanceWindow['setTitleBarOverlay']>[0][]
  close(): void
  closedListenerCount(): number
} {
  const emitter = new EventEmitter()
  const calls: string[] = []
  const overlays: Parameters<AppearanceWindow['setTitleBarOverlay']>[0][] = []
  let destroyed = false
  const window: AppearanceWindow = Object.assign(emitter, {
    isDestroyed: () => destroyed,
    setBackgroundColor(color: string): void {
      calls.push(`color:${color}`)
    },
    setBackgroundMaterial(material: string): void {
      calls.push(`material:${material}`)
    },
    setTitleBarOverlay(options: Parameters<AppearanceWindow['setTitleBarOverlay']>[0]): void {
      overlays.push(options)
    },
  })
  return {
    window,
    calls,
    overlays,
    close(): void {
      destroyed = true
      emitter.emit('closed')
    },
    closedListenerCount: () => emitter.listenerCount('closed'),
  }
}

describe('AppearanceController', () => {
  it.runIf(process.platform === 'win32')(
    'restores Windows caption colors and releases native theme updates',
    async () => {
      const theme = nativeTheme()
      const controller = createAppearanceController(
        runtimeWith(async () => response({ ok: true, value: settings(0) })),
        theme.source,
      )
      await controller.refresh()
      const first = nativeWindow()
      controller.attachWindow(first.window)
      expect(first.overlays.at(-1)?.symbolColor).toBe('#0a0d12')

      theme.setDark(true)
      theme.emitUpdated()
      expect(first.overlays.at(-1)?.symbolColor).toBe('#f2f7fb')
      const recreated = nativeWindow()
      controller.attachWindow(recreated.window)
      expect(recreated.overlays.at(-1)?.symbolColor).toBe('#f2f7fb')

      first.close()
      const firstCount = first.overlays.length
      theme.setDark(false)
      theme.emitUpdated()
      expect(first.overlays).toHaveLength(firstCount)
      expect(recreated.overlays.at(-1)?.symbolColor).toBe('#0a0d12')

      controller.dispose()
      const recreatedCount = recreated.overlays.length
      theme.setDark(true)
      theme.emitUpdated()
      expect(recreated.overlays).toHaveLength(recreatedCount)
      expect(theme.listenerCount()).toBe(0)
    },
  )

  it('loads settings before attaching a window and publishes acknowledged changes', async () => {
    let current = settings(0)
    const theme = nativeTheme()
    const controller = createAppearanceController(
      runtimeWith(async (payload) => {
        if (payload.type === 'appearance.get.request') return response({ ok: true, value: current })
        if (payload.type === 'appearance.update.request') {
          current = {
            ...current,
            theme: payload.input.theme ?? current.theme,
            revision: current.revision + 1,
          }
        } else {
          current = settings(current.revision + 1)
        }
        return response({ ok: true, value: current })
      }),
      theme.source,
    )
    const listener = vi.fn<(snapshot: AppearanceSnapshot) => void>()
    controller.subscribe(listener)

    await expect(controller.refresh()).resolves.toMatchObject({
      ok: true,
      value: { requested: { revision: 0 }, effective: { theme: 'light', revision: 0 } },
    })
    expect(listener).not.toHaveBeenCalled()

    const first = nativeWindow()
    controller.attachWindow(first.window)
    expect(first.calls).toContain('color:#ebf5ff')
    expect(listener).not.toHaveBeenCalled()

    await controller.update({ expectedRevision: 0, theme: 'dark' })
    expect(theme.themeSource()).toBe('dark')
    expect(first.calls).toContain('color:#0f1720')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith(
      expect.objectContaining({ requested: settings(1, { theme: 'dark' }) }),
    )

    const second = nativeWindow()
    controller.attachWindow(second.window)
    expect(second.calls).toContain('color:#0f1720')
    await controller.reset({ expectedRevision: 1 })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ requested: settings(2) }))
    controller.dispose()
  })

  it('reprojects a system-theme change without rereading Utility or changing revision', async () => {
    let reads = 0
    const theme = nativeTheme()
    const controller = createAppearanceController(
      runtimeWith(async () => {
        reads += 1
        return response({ ok: true, value: settings(4) })
      }),
      theme.source,
    )
    const listener = vi.fn<(snapshot: AppearanceSnapshot) => void>()
    controller.subscribe(listener)
    const initial = await controller.refresh()
    if (!initial.ok) throw new Error('Initial appearance read failed')

    theme.setDark(true)
    theme.emitUpdated()
    expect(reads).toBe(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        requested: settings(4),
        effective: expect.objectContaining({ theme: 'dark', revision: 4 }),
        projectionVersion: initial.value.projectionVersion + 1,
      }),
    )
    theme.emitUpdated()
    expect(listener).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('does not let an old read reapply material after a newer mutation', async () => {
    let resolveRead: ((result: UtilityTransportResult) => void) | undefined
    const oldRead = new Promise<UtilityTransportResult>((resolve) => {
      resolveRead = resolve
    })
    const theme = nativeTheme()
    const controller = createAppearanceController(
      runtimeWith(async (payload) =>
        payload.type === 'appearance.get.request'
          ? oldRead
          : response({ ok: true, value: settings(2, { theme: 'dark' }) }),
      ),
      theme.source,
    )
    const fixture = nativeWindow()
    controller.attachWindow(fixture.window)
    const pendingRead = controller.refresh()
    await controller.update({ expectedRevision: 1, theme: 'dark' })
    const callsAfterUpdate = fixture.calls.length
    resolveRead?.(response({ ok: true, value: settings(1, { theme: 'light' }) }))
    await pendingRead
    expect(fixture.calls).toHaveLength(callsAfterUpdate)
    expect(theme.themeSource()).toBe('dark')
    controller.dispose()
  })

  it('blocks uncertain writes until an explicit read reconciles them', async () => {
    let mutations = 0
    const theme = nativeTheme()
    const controller = createAppearanceController(
      runtimeWith(async (payload) => {
        if (payload.type === 'appearance.get.request')
          return response({ ok: true, value: settings(1) })
        mutations += 1
        if (mutations === 1)
          return {
            kind: 'unknown-delivery',
            error: { code: 'TIMEOUT', message: 'Timed out' },
          }
        return response({ ok: true, value: settings(2, { theme: 'dark' }) })
      }),
      theme.source,
    )
    await controller.refresh()
    await expect(controller.update({ expectedRevision: 1, theme: 'dark' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNCERTAIN' },
    })
    theme.setDark(true)
    theme.emitUpdated()
    await expect(controller.reset({ expectedRevision: 1 })).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNCERTAIN' },
    })
    expect(mutations).toBe(1)

    await controller.refresh()
    await expect(controller.update({ expectedRevision: 1, theme: 'dark' })).resolves.toMatchObject({
      ok: true,
      value: { requested: { revision: 2 } },
    })
    expect(mutations).toBe(2)
    controller.dispose()
  })

  it('keeps definitely unsent writes retriable and disposes native listeners', async () => {
    let mutations = 0
    const theme = nativeTheme()
    const controller = createAppearanceController(
      runtimeWith(async (payload) => {
        if (payload.type === 'appearance.get.request')
          return response({ ok: true, value: settings(0) })
        mutations += 1
        if (mutations === 1)
          return {
            kind: 'not-sent',
            error: { code: 'RUNTIME_UNAVAILABLE', message: 'Runtime unavailable' },
          }
        return response({ ok: true, value: settings(1, { theme: 'dark' }) })
      }),
      theme.source,
    )
    const first = nativeWindow()
    const second = nativeWindow()
    controller.attachWindow(first.window)
    controller.attachWindow(second.window)
    expect(theme.listenerCount()).toBe(1)
    expect(first.closedListenerCount()).toBe(1)
    first.close()
    expect(first.closedListenerCount()).toBe(0)

    await expect(controller.update({ expectedRevision: 0, theme: 'dark' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'RUNTIME_UNAVAILABLE' },
    })
    await expect(controller.update({ expectedRevision: 0, theme: 'dark' })).resolves.toMatchObject({
      ok: true,
      value: { requested: { revision: 1 } },
    })
    expect(mutations).toBe(2)
    controller.dispose()
    controller.dispose()
    expect(theme.listenerCount()).toBe(0)
    expect(second.closedListenerCount()).toBe(0)
  })
})
