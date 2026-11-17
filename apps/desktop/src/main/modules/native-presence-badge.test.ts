import type { BrowserWindow } from 'electron'

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UtilityProcessClient } from '../utility-process/client.js'

import { resolveApplicationIdentity } from '../application-identity.js'
import { createRendererTrust } from '../renderer-trust.js'
import { NativePresence, renderWindowsBadgeBitmap } from './native-presence.js'

const harness = vi.hoisted(() => ({
  dockSetBadge: vi.fn<(text: string) => void>(),
  dockBounce: vi.fn<(type?: 'critical' | 'informational') => number>(() => 42),
  dockCancelBounce: vi.fn<(id: number) => void>(),
  dockSetMenu: vi.fn<() => void>(),
  bitmaps: [] as Array<{
    buffer: Buffer
    options: { width: number; height: number; scaleFactor: number }
  }>,
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => 'C:/pact-badge-fixture',
    getPath: () => 'C:/pact-badge-fixture',
    quit: vi.fn<() => void>(),
    whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    on: vi.fn<() => void>(),
    removeListener: vi.fn<() => void>(),
    setJumpList: vi.fn<() => string>(() => 'ok'),
    getJumpListSettings: () => ({ removedItems: [] }),
    dock: {
      setBadge: harness.dockSetBadge,
      bounce: harness.dockBounce,
      cancelBounce: harness.dockCancelBounce,
      setMenu: harness.dockSetMenu,
    },
  },
  ipcMain: {
    handle: vi.fn<() => void>(),
    removeHandler: vi.fn<() => void>(),
  },
  Menu: {
    buildFromTemplate: (items: unknown[]) => ({ items }),
  },
  nativeImage: {
    createFromPath: () => ({
      addRepresentation: vi.fn<() => void>(),
      setTemplateImage: vi.fn<() => void>(),
    }),
    createFromBitmap: (
      buffer: Buffer,
      options: { width: number; height: number; scaleFactor: number },
    ) => {
      const image = {
        buffer: Buffer.from(buffer),
        options,
        isEmpty: () => buffer.length === 0,
        getSize: () => ({ width: options.width, height: options.height }),
      }
      harness.bitmaps.push({ buffer: image.buffer, options })
      return image
    },
  },
  powerMonitor: { on: vi.fn<() => void>(), removeListener: vi.fn<() => void>() },
  Tray: function () {
    return Object.assign(new EventEmitter(), {
      setToolTip: vi.fn<() => void>(),
      destroy: vi.fn<() => void>(),
      popUpContextMenu: vi.fn<() => void>(),
    })
  },
  dialog: { showMessageBox: vi.fn<() => Promise<{ response: number }>>() },
}))
vi.mock('node:fs', () => ({
  readFileSync: () => Buffer.from('template'),
  realpathSync: (value: string) => value,
  statSync: () => ({ size: 1, isDirectory: () => true, isFile: () => true }),
}))
vi.mock('../../../build/icon.ico?asset', () => ({ default: 'icon.ico' }))
vi.mock('../../../build/tray.ico?asset', () => ({ default: 'tray.ico' }))
vi.mock('../../../build/trayTemplate.png?asset', () => ({ default: 'trayTemplate.png' }))
vi.mock('../../../build/trayTemplate@2x.png?asset', () => ({ default: 'trayTemplate@2x.png' }))
vi.mock('../application-identity.js', () => ({
  resolveApplicationIdentity: () => ({
    kind: 'production-ci',
    name: 'Pact',
    appId: 'com.pact.desktop',
    packageName: '@pact/desktop',
    profileDirectory: 'Pact',
  }),
}))

const owners: NativePresence[] = []

beforeEach(() => {
  harness.dockSetBadge.mockClear()
  harness.dockBounce.mockClear().mockReturnValue(42)
  harness.dockCancelBounce.mockClear()
  harness.dockSetMenu.mockClear()
  harness.bitmaps.length = 0
})

afterEach(() => {
  for (const owner of owners.splice(0)) owner.dispose()
  vi.restoreAllMocks()
})

function createPresenceFixture() {
  let focused = false
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled test double for NativePresence badge tests.
  const utility = {
    isRunning: () => true,
    getNativePresence: vi.fn<UtilityProcessClient['getNativePresence']>(async () => ({
      ok: true,
      value: {
        version: { incarnation: crypto.randomUUID(), revision: 1 },
        running: [],
        attention: [],
        attentionTotal: 0,
        recent: [],
      },
    })),
    subscribeNativePresence: () => () => undefined,
    subscribeNativeQuitRecent: () => () => undefined,
  } as unknown as UtilityProcessClient

  const setOverlayIcon = vi.fn<(icon: Electron.NativeImage | null, description: string) => void>()
  const flashFrame = vi.fn<(flag: boolean) => void>()

  const window = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: () => focused,
    setOverlayIcon,
    flashFrame,
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: { url: 'app://bundle/index.html' },
      getURL: () => 'app://bundle/index.html',
      isDestroyed: () => false,
      isCrashed: () => false,
      send: vi.fn<() => void>(),
    }),
  })
  const trust = createRendererTrust({ isPackaged: true })
  trust.registerWindow(window)
  const presentation = { show: vi.fn<() => void>(), hide: vi.fn<() => void>() }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Controlled BrowserWindow test surface.
  const nativeWindow = window as unknown as BrowserWindow
  const owner = new NativePresence(
    resolveApplicationIdentity(),
    utility,
    trust,
    () => nativeWindow,
    undefined,
  )
  owners.push(owner)
  return {
    owner,
    window,
    setOverlayIcon,
    flashFrame,
    setFocused(next: boolean) {
      focused = next
    },
    attach: () => owner.attachWindow(nativeWindow, presentation),
  }
}

describe('NativePresence notification badges', () => {
  it('updates macOS Dock badge (including 99+ cap), bounces only on increments, and clears on zero or dispose', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    const f = createPresenceFixture()
    f.attach()

    f.owner.setNotificationBadgeCount(1)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('1')
    expect(harness.dockBounce).toHaveBeenCalledTimes(1)
    expect(harness.dockBounce).toHaveBeenCalledWith('informational')

    // Equal count does not re-set badge or bounce again.
    f.owner.setNotificationBadgeCount(1)
    expect(harness.dockSetBadge).toHaveBeenCalledTimes(1)
    expect(harness.dockBounce).toHaveBeenCalledTimes(1)

    // Incrementing cancels previous bounce and bounces again.
    f.owner.setNotificationBadgeCount(3)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('3')
    expect(harness.dockCancelBounce).toHaveBeenCalledWith(42)
    expect(harness.dockBounce).toHaveBeenCalledTimes(2)

    // Decrementing updates badge label without bouncing.
    f.owner.setNotificationBadgeCount(2)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('2')
    expect(harness.dockBounce).toHaveBeenCalledTimes(2)

    // Counts above 99 render as '99+' and bounce since 125 > 2.
    f.owner.setNotificationBadgeCount(125)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('99+')
    expect(harness.dockCancelBounce).toHaveBeenCalledTimes(2)
    expect(harness.dockBounce).toHaveBeenCalledTimes(3)

    // Non-positive or non-finite values clear the badge and cancel bounce.
    f.owner.setNotificationBadgeCount(0)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('')
    expect(harness.dockCancelBounce).toHaveBeenCalledTimes(3)

    f.owner.setNotificationBadgeCount(Number.NaN)
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('')

    f.owner.setNotificationBadgeCount(4)
    f.owner.dispose()
    expect(harness.dockSetBadge).toHaveBeenLastCalledWith('')
  })

  it('renders and caches Windows taskbar overlay bitmaps, flashes while unfocused, stops flash on focus, and clears on dispose', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const f = createPresenceFixture()

    // Setting badge before window attaches applies the overlay upon attachWindow.
    f.owner.setNotificationBadgeCount(2)
    expect(f.setOverlayIcon).not.toHaveBeenCalled()
    f.attach()
    expect(f.setOverlayIcon).toHaveBeenCalledWith(
      expect.objectContaining({ getSize: expect.any(Function) }),
      '2 unread Session notifications',
    )

    // Increment while unfocused flashes taskbar frame; same count reuses cached bitmap.
    f.owner.setNotificationBadgeCount(5)
    expect(f.setOverlayIcon).toHaveBeenLastCalledWith(
      expect.any(Object),
      '5 unread Session notifications',
    )
    expect(f.flashFrame).toHaveBeenCalledWith(true)

    // Window focus stops taskbar flash without clearing unread badge until count reaches 0.
    f.setFocused(true)
    f.window.emit('focus')
    expect(f.flashFrame).toHaveBeenLastCalledWith(false)

    // Counts above 99 display '99+' overlay description and bitmap.
    f.setFocused(false)
    f.owner.setNotificationBadgeCount(105)
    expect(f.setOverlayIcon).toHaveBeenLastCalledWith(
      expect.any(Object),
      '99+ unread Session notifications',
    )
    expect(f.flashFrame).toHaveBeenLastCalledWith(true)

    // Zero count clears overlay and stops flash.
    f.owner.setNotificationBadgeCount(0)
    expect(f.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(f.flashFrame).toHaveBeenLastCalledWith(false)

    // Bitmap rendering produces a 32x32 BGRA bitmap with opaque foreground pixels.
    const badge = renderWindowsBadgeBitmap('99+')
    expect(badge.isEmpty()).toBe(false)
    expect(badge.getSize()).toEqual({ width: 32, height: 32 })
    const latest = harness.bitmaps.at(-1)!
    expect(latest.buffer.byteLength).toBe(32 * 32 * 4)
    // At least one opaque white glyph pixel (0xff, 0xff, 0xff, 0xff) is drawn.
    let whitePixels = 0
    for (let offset = 0; offset < latest.buffer.length; offset += 4) {
      if (
        latest.buffer[offset] === 0xff &&
        latest.buffer[offset + 1] === 0xff &&
        latest.buffer[offset + 2] === 0xff &&
        latest.buffer[offset + 3] === 0xff
      ) {
        whitePixels += 1
      }
    }
    expect(whitePixels).toBeGreaterThan(20)

    f.owner.setNotificationBadgeCount(3)
    f.owner.dispose()
    expect(f.setOverlayIcon).toHaveBeenLastCalledWith(null, '')
    expect(f.flashFrame).toHaveBeenLastCalledWith(false)
  })
})
