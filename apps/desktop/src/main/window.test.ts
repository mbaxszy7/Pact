import type { BrowserWindowConstructorOptions, Rectangle } from 'electron'

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createRendererTrust } from './renderer-trust.js'
import { createMainWindow, type WindowPresentation } from './window.js'

const harness = vi.hoisted(() => ({
  createWindow: vi.fn<(options: BrowserWindowConstructorOptions) => FakeWindow>(),
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
  pointer: { x: 240, y: 180 },
  settings: vi.fn<() => { prefersReducedMotion: boolean; shouldRenderRichAnimation: boolean }>(
    () => ({
      prefersReducedMotion: false,
      shouldRenderRichAnimation: true,
    }),
  ),
  nearestDisplay: vi.fn<(point: { x: number; y: number }) => void>(),
}))

vi.mock('electron', () => ({
  app: { getName: () => 'Pact - Development - Local' },
  BrowserWindow: function (options: BrowserWindowConstructorOptions) {
    return harness.createWindow(options)
  },
  screen: {
    getCursorScreenPoint: () => harness.pointer,
    getDisplayNearestPoint: (point: { x: number; y: number }) => {
      harness.nearestDisplay(point)
      return { workArea: harness.workArea, scaleFactor: 2 }
    },
    getDisplayMatching: () => ({ workArea: harness.workArea }),
    getAllDisplays: () => [{ workArea: harness.workArea }],
  },
  systemPreferences: { getAnimationSettings: () => harness.settings() },
  dialog: { showErrorBox: vi.fn<(title: string, content: string) => void>() },
  shell: { openExternal: vi.fn<(url: string) => Promise<void>>() },
}))
vi.mock('../../build/icon.png?asset', () => ({ default: 'pact-icon.png' }))

class FakeWindow extends EventEmitter {
  visible = false
  minimized = false
  maximized = false
  destroyed = false
  opacity = 1
  bounds: Rectangle
  readonly webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: 'app://bundle/index.html' },
    getURL: () => 'app://bundle/index.html',
    isDestroyed: () => this.destroyed,
    send: vi.fn<(channel: string, ...args: unknown[]) => void>(),
    setWindowOpenHandler: vi.fn<(handler: unknown) => void>(),
  })
  readonly show = vi.fn<() => void>(() => {
    this.visible = true
  })
  readonly hide = vi.fn<() => void>(() => {
    this.visible = false
  })
  readonly focus = vi.fn<() => void>()
  readonly restore = vi.fn<() => void>(() => {
    this.minimized = false
    this.visible = true
    this.emit('restore')
  })
  readonly setBounds = vi.fn<(bounds: Rectangle) => void>((bounds) => {
    this.bounds = { ...bounds }
    this.emit('resize')
  })
  readonly setMinimumSize = vi.fn<(width: number, height: number) => void>()
  readonly setShape = vi.fn<(rectangles: Rectangle[]) => void>()
  readonly setOpacity = vi.fn<(opacity: number) => void>((opacity) => {
    this.opacity = opacity
  })
  readonly loadURL = vi.fn<(url: string) => Promise<void>>(async () => undefined)

  constructor(readonly options: BrowserWindowConstructorOptions) {
    super()
    this.bounds = { x: options.x!, y: options.y!, width: options.width!, height: options.height! }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
  isVisible(): boolean {
    return this.visible
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isMaximized(): boolean {
    return this.maximized
  }
  // Transparent Windows windows can report false after a native fullscreen event.
  isFullScreen(): boolean {
    return false
  }
  getBounds(): Rectangle {
    return { ...this.bounds }
  }
  getOpacity(): number {
    return this.opacity
  }
  destroy(): void {
    this.destroyed = true
    this.emit('closed')
  }
}

function workspace(
  show = true,
  material?: 'solid' | 'translucent',
): { window: FakeWindow; presentation: WindowPresentation } {
  let presentation: WindowPresentation | undefined
  createMainWindow({
    show,
    ...(material
      ? {
          appearance: {
            windowMaterial: material,
            backgroundColor: material === 'solid' ? '#0f1720' : '#00000000',
          },
        }
      : {}),
    trust: createRendererTrust({ isPackaged: true }),
    onBeforeLoad: (_window, owner) => {
      presentation = owner
    },
  })
  const created = harness.createWindow.mock.results.at(-1)
  if (created?.type !== 'return') throw new Error('The native window was not created.')
  if (!presentation) throw new Error('The presentation interface was not attached before load.')
  return { window: created.value, presentation }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  harness.workArea = { x: 0, y: 0, width: 1920, height: 1032 }
  harness.pointer = { x: 240, y: 180 }
  harness.createWindow.mockImplementation((options) => new FakeWindow(options))
  harness.settings.mockReturnValue({ prefersReducedMotion: false, shouldRenderRichAnimation: true })
  harness.nearestDisplay.mockClear()
})

afterEach(() => {
  for (const result of harness.createWindow.mock.results) {
    if (result.type === 'return') result.value.destroy()
  }
  harness.createWindow.mockClear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('workspace startup geometry', () => {
  it.each([
    {
      area: { x: -1920, y: 24, width: 1920, height: 1032 },
      expected: { x: -1728, y: 127, width: 1536, height: 826 },
      minimum: [720, 520],
    },
    {
      area: { x: 0, y: 0, width: 1000, height: 600 },
      expected: { x: 100, y: 40, width: 800, height: 520 },
      minimum: [720, 520],
    },
    {
      area: { x: 20, y: 40, width: 680, height: 480 },
      expected: { x: 20, y: 40, width: 680, height: 480 },
      minimum: [680, 480],
    },
  ])(
    'centers within the pointer work area, respecting minimums: $area',
    ({ area, expected, minimum }) => {
      harness.workArea = area
      harness.pointer = { x: area.x + 100, y: area.y + 100 }
      const { window } = workspace()
      expect(harness.nearestDisplay).toHaveBeenCalledWith(harness.pointer)
      expect(window.bounds).toEqual(expected)
      expect([window.options.minWidth, window.options.minHeight]).toEqual(minimum)
      expect(window.visible).toBe(false)
    },
  )

  it('recovers an unreachable title bar after its display is disconnected', () => {
    const { window, presentation } = workspace(false)
    window.emit('ready-to-show')
    window.bounds = { x: -1800, y: -100, width: 900, height: 650 }
    presentation.show()
    vi.runAllTimers()
    expect(window.bounds).toEqual({ x: 510, y: 191, width: 900, height: 650 })
    expect(window.visible).toBe(true)
  })
})

describe('Windows native Solid window', () => {
  it('uses opaque native styles without shape/opacity writes or animation timers', () => {
    const { window, presentation } = workspace(true, 'solid')
    expect(window.options).toMatchObject({
      transparent: false,
      thickFrame: true,
      backgroundColor: '#0f1720',
    })
    window.emit('ready-to-show')
    expect(window.visible).toBe(true)
    presentation.hide()
    expect(window.visible).toBe(false)
    window.minimized = true
    presentation.show()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.visible).toBe(true)
    expect(window.setOpacity).not.toHaveBeenCalled()
    expect(window.setShape).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves transparent backing, custom clipping and fades for Translucent', () => {
    const { window } = workspace(true, 'translucent')
    expect(window.options).toMatchObject({
      transparent: true,
      thickFrame: false,
      backgroundColor: '#00000000',
    })
    expect(window.setShape).toHaveBeenCalled()
    window.emit('ready-to-show')
    expect(window.setOpacity).toHaveBeenCalled()
    vi.runAllTimers()
    expect(window.visible).toBe(true)
  })
})

describe.each(['win32', 'darwin'] as const)('%s workspace visibility', (platform) => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  })

  it('waits for readiness, fades in/out and retains warm geometry and maximized state', () => {
    const { window, presentation } = workspace()
    expect(window.visible).toBe(false)
    window.emit('ready-to-show')
    vi.advanceTimersByTime(75)
    expect(window.visible).toBe(true)
    expect(window.opacity).toBeGreaterThan(0)
    expect(window.opacity).toBeLessThan(1)
    vi.advanceTimersByTime(75)
    expect(window.opacity).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    window.bounds = { x: 240, y: 150, width: 1000, height: 700 }
    presentation.hide()
    vi.advanceTimersByTime(50)
    expect(window.visible).toBe(true)
    vi.advanceTimersByTime(50)
    expect(window.visible).toBe(false)
    expect(window.opacity).toBe(1)
    presentation.show()
    vi.runAllTimers()
    expect(window.bounds).toEqual({ x: 240, y: 150, width: 1000, height: 700 })
    presentation.show()
    expect(window.opacity).toBe(1)
    expect(vi.getTimerCount()).toBe(0)

    window.maximized = true
    presentation.hide()
    vi.runAllTimers()
    presentation.show()
    vi.runAllTimers()
    expect(window.maximized).toBe(true)
    expect(window.visible).toBe(true)
  })

  it('reverses from current opacity and honors the latest visibility request', () => {
    const { window, presentation } = workspace()
    window.emit('ready-to-show')
    vi.runAllTimers()
    presentation.hide()
    vi.advanceTimersByTime(48)
    const partialOpacity = window.opacity
    presentation.show()
    expect(window.opacity).toBe(partialOpacity)
    expect(vi.getTimerCount()).toBe(1)
    presentation.show()
    vi.runAllTimers()
    expect(window.visible).toBe(true)
    expect(window.opacity).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['resize', 'minimize', 'enter-full-screen'] as const)(
    'completes the latest hide when %s interrupts its fade',
    (event) => {
      const { window, presentation } = workspace()
      window.emit('ready-to-show')
      vi.runAllTimers()
      presentation.hide()
      vi.advanceTimersByTime(32)
      expect(window.visible).toBe(true)
      window.show.mockClear()
      window.emit(event)
      expect(window.visible).toBe(false)
      expect(window.opacity).toBe(1)
      expect(window.show).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      vi.runAllTimers()
      expect(window.visible).toBe(false)
    },
  )

  it('keeps a newer reveal when geometry recovery interrupts an earlier hide', () => {
    const { window, presentation } = workspace()
    window.emit('ready-to-show')
    vi.runAllTimers()
    presentation.hide()
    vi.advanceTimersByTime(32)
    window.bounds = { x: -1800, y: -100, width: 900, height: 650 }
    presentation.show()
    expect(window.setBounds).toHaveBeenCalled()
    expect(window.hide).not.toHaveBeenCalled()
    vi.runAllTimers()
    expect(window.visible).toBe(true)
    expect(window.opacity).toBe(1)
    expect(window.bounds).toEqual({ x: 510, y: 191, width: 900, height: 650 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases animation work on destruction and leaves native state changes in control', () => {
    const { window, presentation } = workspace()
    window.emit('ready-to-show')
    vi.advanceTimersByTime(32)
    window.minimized = true
    window.visible = false
    window.show.mockClear()
    window.emit('minimize')
    expect(window.visible).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.opacity).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    presentation.show()
    expect(window.restore).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)

    window.emit('enter-full-screen')
    presentation.hide()
    presentation.show()
    expect(vi.getTimerCount()).toBe(0)
    expect(window.opacity).toBe(1)
    window.emit('leave-full-screen')
    presentation.hide()
    expect(vi.getTimerCount()).toBe(1)
    window.destroy()
    expect(vi.getTimerCount()).toBe(0)
    const opacityWrites = window.setOpacity.mock.calls.length
    presentation.show()
    vi.runAllTimers()
    expect(window.setOpacity).toHaveBeenCalledTimes(opacityWrites)
  })
})

describe('system animation preferences', () => {
  it.each(['reduced', 'disabled', 'unavailable'] as const)(
    'uses immediate visibility when preferences are %s',
    (mode) => {
      if (mode === 'unavailable')
        harness.settings.mockImplementation(() => {
          throw new Error('Native preferences unavailable.')
        })
      else
        harness.settings.mockReturnValue({
          prefersReducedMotion: mode === 'reduced',
          shouldRenderRichAnimation: mode !== 'disabled',
        })
      const { window, presentation } = workspace()
      window.emit('ready-to-show')
      expect(window.visible).toBe(true)
      expect(window.opacity).toBe(1)
      presentation.hide()
      expect(window.visible).toBe(false)
      presentation.show()
      expect(window.visible).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

describe('presentation fallback', () => {
  it('honors a hide requested before the first paint instead of exposing a hidden startup', () => {
    const { window, presentation } = workspace()
    presentation.hide()
    window.emit('ready-to-show')
    expect(window.visible).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
    presentation.show()
    vi.runAllTimers()
    expect(window.visible).toBe(true)
    expect(window.opacity).toBe(1)
  })

  it('still shows and hides if a native opacity update fails', () => {
    const { window, presentation } = workspace()
    window.setOpacity.mockImplementationOnce(() => {
      throw new Error('Native opacity unavailable.')
    })
    window.emit('ready-to-show')
    expect(window.visible).toBe(true)
    expect(window.opacity).toBe(1)
    window.setOpacity.mockImplementationOnce(() => {
      throw new Error('Native opacity unavailable.')
    })
    presentation.hide()
    expect(window.visible).toBe(false)
    expect(window.opacity).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
