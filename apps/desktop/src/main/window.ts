import {
  app,
  BrowserWindow,
  dialog,
  screen,
  shell,
  systemPreferences,
  type Rectangle,
} from 'electron'
import { join } from 'node:path'

import type { WindowAppearance } from './modules/appearance/material'
import type { RendererTrust } from './renderer-trust'

import icon from '../../build/icon.png?asset'

const TITLE_BAR_HEIGHT = 48
const MACOS_TRAFFIC_LIGHT_SIZE = 14
const WINDOWS_CORNER_RADIUS = 8
const MAX_EXTERNAL_LINK_LENGTH = process.platform === 'win32' ? 2_081 : 8_192
const MIN_WINDOW_WIDTH = 720
const MIN_WINDOW_HEIGHT = 520
const SHOW_DURATION_MS = 150
const HIDE_DURATION_MS = 100
const FRAME_INTERVAL_MS = 16

export interface WindowPresentation {
  show(): void
  hide(): void
}

export interface CreateMainWindowOptions {
  show?: boolean
  appearance?: WindowAppearance
  trust: RendererTrust
  onBeforeLoad?(window: BrowserWindow, presentation: WindowPresentation): void
}

function motionAllowed(): boolean {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false
  try {
    const settings = systemPreferences.getAnimationSettings()
    return !settings.prefersReducedMotion && settings.shouldRenderRichAnimation
  } catch {
    return false
  }
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const shouldShow = options.show ?? true
  const nativeSolid = process.platform === 'win32' && options.appearance?.windowMaterial === 'solid'
  const workArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const minWidth = Math.min(MIN_WINDOW_WIDTH, workArea.width)
  const minHeight = Math.min(MIN_WINDOW_HEIGHT, workArea.height)
  const startupWidth = Math.min(
    workArea.width,
    Math.max(minWidth, Math.round(workArea.width * 0.8)),
  )
  const startupHeight = Math.min(
    workArea.height,
    Math.max(minHeight, Math.round(workArea.height * 0.8)),
  )
  const window = new BrowserWindow({
    icon,
    title: app.getName(),
    x: workArea.x + Math.round((workArea.width - startupWidth) / 2),
    y: workArea.y + Math.round((workArea.height - startupHeight) / 2),
    width: startupWidth,
    height: startupHeight,
    minWidth,
    minHeight,
    show: false,
    autoHideMenuBar: true,
    backgroundColor:
      options.appearance?.backgroundColor ??
      (process.platform === 'darwin' || process.platform === 'win32' ? '#00000000' : '#0b0d12'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      height: TITLE_BAR_HEIGHT,
    },
    ...(process.platform === 'darwin'
      ? {
          trafficLightPosition: {
            x: 16,
            y: (TITLE_BAR_HEIGHT - MACOS_TRAFFIC_LIGHT_SIZE) / 2,
          },
          transparent: true,
        }
      : {}),
    ...(process.platform === 'win32'
      ? { frame: false, transparent: !nativeSolid, thickFrame: nativeSolid }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  let ready = false
  let wantedVisible = shouldShow
  let fullScreen = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let transition: { visible: boolean; from: number; started: number; duration: number } | undefined

  const cancelTransition = (): void => {
    clearTimeout(timer)
    timer = undefined
    transition = undefined
  }
  const resetOpacity = (): void => {
    if (nativeSolid) return
    try {
      if (!window.isDestroyed()) window.setOpacity(1)
    } catch {
      // An unavailable native opacity operation must not prevent showing or hiding the window.
    }
  }
  const finishVisibility = (visible: boolean): void => {
    cancelTransition()
    if (window.isDestroyed()) return
    // Hidden windows also retain full opacity so a later native restore cannot stay invisible.
    if (!visible) window.hide()
    resetOpacity()
    if (visible) window.show()
  }
  const step = (): void => {
    timer = undefined
    const active = transition
    if (!active || window.isDestroyed()) return
    try {
      const progress = Math.min(1, (performance.now() - active.started) / active.duration)
      if (progress >= 1) {
        finishVisibility(active.visible)
        return
      }
      // Arrivals decelerate; departures accelerate. Geometry and material remain unchanged.
      const eased = active.visible ? 1 - (1 - progress) ** 3 : progress ** 2
      window.setOpacity(active.from + ((active.visible ? 1 : 0) - active.from) * eased)
      timer = setTimeout(step, Math.min(FRAME_INTERVAL_MS, active.duration * (1 - progress)))
    } catch {
      finishVisibility(wantedVisible)
    }
  }
  const ensureReachable = (): void => {
    if (fullScreen || window.isFullScreen() || window.isMaximized()) return
    const bounds = window.getBounds()
    const reachable = screen.getAllDisplays().some(({ workArea: area }) => {
      const visibleWidth =
        Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)
      return (
        visibleWidth >= Math.min(120, bounds.width) &&
        bounds.y >= area.y &&
        bounds.y + TITLE_BAR_HEIGHT <= area.y + area.height
      )
    })
    const area = reachable
      ? screen.getDisplayMatching(bounds).workArea
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    window.setMinimumSize(
      Math.min(MIN_WINDOW_WIDTH, area.width),
      Math.min(MIN_WINDOW_HEIGHT, area.height),
    )
    if (reachable) return
    const restoredWidth = Math.min(bounds.width, area.width)
    const restoredHeight = Math.min(bounds.height, area.height)
    window.setBounds({
      x: area.x + Math.round((area.width - restoredWidth) / 2),
      y: area.y + Math.round((area.height - restoredHeight) / 2),
      width: restoredWidth,
      height: restoredHeight,
    })
  }
  const present = (visible: boolean): void => {
    wantedVisible = visible
    if (!ready || window.isDestroyed()) return
    if (nativeSolid) {
      // Keep this HWND on Windows' native path: no opacity or region mutations.
      if (visible) {
        if (window.isMinimized()) window.restore()
        else ensureReachable()
        window.show()
        window.focus()
      } else window.hide()
      return
    }
    if (transition?.visible === visible) {
      if (visible) window.focus()
      return
    }
    const minimized = window.isMinimized()
    if (visible && !minimized) ensureReachable()
    if (!visible && !window.isVisible()) {
      finishVisibility(false)
      return
    }
    if (minimized || fullScreen || window.isFullScreen() || !motionAllowed()) {
      cancelTransition()
      resetOpacity()
      if (visible && minimized) window.restore()
      finishVisibility(visible)
      if (visible) window.focus()
      return
    }
    if (visible && window.isVisible() && !transition) {
      window.focus()
      return
    }
    const from = transition ? window.getOpacity() : visible ? 0 : 1
    cancelTransition()
    try {
      window.setOpacity(from)
      if (visible) {
        window.show()
        window.focus()
      }
      transition = {
        visible,
        from,
        started: performance.now(),
        duration: Math.max(
          1,
          (visible ? SHOW_DURATION_MS : HIDE_DURATION_MS) * Math.abs((visible ? 1 : 0) - from),
        ),
      }
      step()
    } catch {
      finishVisibility(visible)
    }
  }
  const presentation: WindowPresentation = {
    show: () => present(true),
    hide: () => present(false),
  }
  const nativeStateChanging = (): void => {
    const finishHiding = transition !== undefined && !wantedVisible
    cancelTransition()
    resetOpacity()
    // Cancelling a fade must still honor the latest close-to-hide request. Do not
    // show here: native minimize/fullscreen/restore keeps ownership of its state.
    if (finishHiding && !window.isDestroyed()) window.hide()
  }
  const enterFullScreen = (): void => {
    fullScreen = true
    nativeStateChanging()
  }
  const leaveFullScreen = (): void => {
    fullScreen = false
    nativeStateChanging()
  }
  window.on('enter-full-screen', enterFullScreen)
  window.on('leave-full-screen', leaveFullScreen)
  window.on('minimize', nativeStateChanging)
  window.on('restore', nativeStateChanging)
  window.on('maximize', nativeStateChanging)
  window.on('unmaximize', nativeStateChanging)
  const resize = (): void => {
    if (transition) nativeStateChanging()
  }
  window.on('resize', resize)
  window.once('closed', () => {
    cancelTransition()
    window.removeListener('enter-full-screen', enterFullScreen)
    window.removeListener('leave-full-screen', leaveFullScreen)
    window.removeListener('minimize', nativeStateChanging)
    window.removeListener('restore', nativeStateChanging)
    window.removeListener('maximize', nativeStateChanging)
    window.removeListener('unmaximize', nativeStateChanging)
    window.removeListener('resize', resize)
  })

  // Native clipping also excludes the corner cutouts from drawing and pointer input,
  // including Solid material and the native Window Controls Overlay.
  if (process.platform === 'win32' && !nativeSolid) {
    // Transparent Windows windows can report false from isFullScreen() even
    // after entering full screen. Use the native transition events as the owner.
    const updateShape = (): void => {
      if (window.isDestroyed()) return
      if (window.isMaximized() || fullScreen) {
        window.setShape([])
        return
      }
      const { width, height } = window.getBounds()
      const radius = WINDOWS_CORNER_RADIUS
      const rectangles: Rectangle[] = [{ x: 0, y: radius, width, height: height - radius * 2 }]
      // Two fixed eight-row arcs plus the body: at most 17 rectangles per update.
      for (let row = 0; row < radius; row += 1) {
        const inset = Math.round(radius - Math.sqrt(radius ** 2 - (radius - row - 0.5) ** 2))
        const strip = { x: inset, width: width - inset * 2, height: 1 }
        rectangles.push({ ...strip, y: row }, { ...strip, y: height - row - 1 })
      }
      window.setShape(rectangles)
    }
    window.on('resize', updateShape)
    window.on('maximize', updateShape)
    window.on('unmaximize', updateShape)
    window.on('enter-full-screen', updateShape)
    window.on('leave-full-screen', updateShape)
    window.once('closed', () => {
      window.removeListener('resize', updateShape)
      window.removeListener('maximize', updateShape)
      window.removeListener('unmaximize', updateShape)
      window.removeListener('enter-full-screen', updateShape)
      window.removeListener('leave-full-screen', updateShape)
    })
    updateShape()
  }

  window.once('ready-to-show', () => {
    ready = true
    if (wantedVisible) presentation.show()
  })

  // The window owns one OS browser launch, with no queue or automatic retry.
  let openingExternalLink = false
  let externalLinkDeadline: ReturnType<typeof setTimeout> | undefined
  const reportExternalLinkFailure = (): void => {
    if (!window.isDestroyed()) {
      dialog.showErrorBox('Could not open link', 'Try opening the link in your browser.')
    }
  }
  window.once('closed', () => {
    clearTimeout(externalLinkDeadline)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (
      openingExternalLink ||
      !options.trust.allowsNavigation(window.webContents.mainFrame.url) ||
      !options.trust.allowsNavigation(window.webContents.getURL())
    )
      return { action: 'deny' }
    if (url.length > MAX_EXTERNAL_LINK_LENGTH) {
      if (/^https?:/iu.test(url)) reportExternalLinkFailure()
      return { action: 'deny' }
    }
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return { action: 'deny' }
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      return { action: 'deny' }
    if (target.href.length > MAX_EXTERNAL_LINK_LENGTH) {
      reportExternalLinkFailure()
      return { action: 'deny' }
    }
    openingExternalLink = true
    let timedOut = false
    externalLinkDeadline = setTimeout(() => {
      timedOut = true
      reportExternalLinkFailure()
    }, 10_000)
    // Electron cannot abort an OS launch. Keep its slot until physical settlement,
    // even after the reporting deadline, so repeated clicks cannot accumulate work.
    void shell
      .openExternal(target.href)
      .catch(() => {
        if (!timedOut) reportExternalLinkFailure()
      })
      .finally(() => {
        clearTimeout(externalLinkDeadline)
        externalLinkDeadline = undefined
        openingExternalLink = false
      })
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (!options.trust.allowsNavigation(url)) event.preventDefault()
  })
  // The HTML brand title must not replace the native build identity shown in the taskbar.
  window.on('page-title-updated', (event) => event.preventDefault())
  options.trust.registerWindow(window)
  options.onBeforeLoad?.(window, presentation)

  void window.loadURL(options.trust.loadUrl)

  return window
}
