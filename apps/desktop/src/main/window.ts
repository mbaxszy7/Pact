import { BrowserWindow, dialog, shell } from 'electron'
import { join } from 'node:path'

import type { RendererTrust } from './renderer-trust'

const TITLE_BAR_HEIGHT = 48
const MACOS_TRAFFIC_LIGHT_SIZE = 14
const MAX_EXTERNAL_LINK_LENGTH = process.platform === 'win32' ? 2_081 : 8_192

export interface CreateMainWindowOptions {
  show?: boolean
  trust: RendererTrust
  onBeforeLoad?(window: BrowserWindow): void
}

export function createMainWindow(options: CreateMainWindowOptions): BrowserWindow {
  const shouldShow = options.show ?? true
  const window = new BrowserWindow({
    width: 1_120,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    backgroundColor:
      process.platform === 'darwin' || process.platform === 'win32' ? '#00000000' : '#0b0d12',
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
    ...(process.platform === 'win32' ? { frame: false, transparent: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => {
    if (shouldShow) window.show()
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
  options.trust.registerWindow(window)
  options.onBeforeLoad?.(window)

  void window.loadURL(options.trust.loadUrl)

  return window
}
