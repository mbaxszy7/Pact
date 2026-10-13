import { describe, expect, it } from 'vitest'

import { createRendererTrust, type TrustedIpcEvent } from './renderer-trust.js'

interface FakeWebContents {
  mainFrame: { url: string }
  url: string
  destroyed: boolean
  sent: unknown[][]
  getURL(): string
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

interface FakeWindow {
  webContents: FakeWebContents
  destroyed: boolean
  closeListeners: Array<() => void>
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): void
}

function createWindow(url: string): FakeWindow {
  const webContents: FakeWebContents = {
    mainFrame: { url },
    url,
    destroyed: false,
    sent: [],
    getURL() {
      return this.url
    },
    isDestroyed() {
      return this.destroyed
    },
    send(channel, ...args) {
      this.sent.push([channel, ...args])
    },
  }

  return {
    webContents,
    destroyed: false,
    closeListeners: [],
    isDestroyed() {
      return this.destroyed
    },
    once(_event, listener) {
      this.closeListeners.push(listener)
    },
  }
}

function eventFor(
  window: FakeWindow,
  senderFrame: { url: string } | null = window.webContents.mainFrame,
): TrustedIpcEvent {
  return { sender: window.webContents, senderFrame }
}

describe('RendererTrust navigation', () => {
  it('accepts only the exact configured development origin without credentials', () => {
    const trust = createRendererTrust({
      isPackaged: false,
      rendererUrl: 'http://127.0.0.1:5173/',
    })

    expect(trust.loadUrl).toBe('http://127.0.0.1:5173/')
    expect(trust.allowsNavigation('http://127.0.0.1:5173/settings')).toBe(true)
    expect(trust.allowsNavigation('http://localhost:5173/')).toBe(false)
    expect(trust.allowsNavigation('http://127.0.0.1:5174/')).toBe(false)
    expect(trust.allowsNavigation('https://127.0.0.1:5173/')).toBe(false)
    expect(trust.allowsNavigation('http://user@127.0.0.1:5173/')).toBe(false)
    expect(trust.allowsNavigation('not a URL')).toBe(false)
  })

  it('rejects malformed or credential-bearing development URLs', () => {
    expect(() => createRendererTrust({ isPackaged: false, rendererUrl: 'not a URL' })).toThrow(
      /HTTP\(S\)/,
    )
    expect(() =>
      createRendererTrust({ isPackaged: false, rendererUrl: 'http://user@127.0.0.1:5173/' }),
    ).toThrow(/without credentials/)
  })

  it('uses only the bundle authority for packaged and built-app runs', () => {
    const packagedTrust = createRendererTrust({
      isPackaged: true,
      rendererUrl: 'not a URL',
    })
    const builtTrust = createRendererTrust({ isPackaged: false })

    for (const trust of [packagedTrust, builtTrust]) {
      expect(trust.loadUrl).toBe('app://bundle/index.html')
      expect(trust.allowsNavigation('app://bundle/index.html')).toBe(true)
      expect(trust.allowsNavigation('app://bundle/settings.html')).toBe(true)
      expect(trust.allowsNavigation('app://evil/index.html')).toBe(false)
      expect(trust.allowsNavigation('app://bundle:42/index.html')).toBe(false)
      expect(trust.allowsNavigation('app://user@bundle/index.html')).toBe(false)
      expect(trust.allowsNavigation('not a URL')).toBe(false)
    }
  })
})

describe('RendererTrust IPC', () => {
  it('accepts only a registered window main frame on an allowed document', () => {
    const trust = createRendererTrust({ isPackaged: true })
    const registered = createWindow('app://bundle/index.html')
    const rogueSameUrl = createWindow('app://bundle/index.html')
    trust.registerWindow(registered)

    expect(() => trust.assertTrustedMainFrame(eventFor(registered))).not.toThrow()
    expect(() => trust.assertTrustedMainFrame(eventFor(rogueSameUrl))).toThrow(/unregistered/)
    expect(() => trust.assertTrustedMainFrame(eventFor(registered, null))).toThrow(/non-main frame/)
    expect(() =>
      trust.assertTrustedMainFrame(eventFor(registered, { url: 'app://bundle/frame.html' })),
    ).toThrow(/non-main frame/)
  })

  it('rejects an untrusted sender frame URL from an otherwise usable registered window', () => {
    const trust = createRendererTrust({ isPackaged: true })
    const window = createWindow('app://bundle/index.html')
    trust.registerWindow(window)

    window.webContents.mainFrame.url = 'app://evil/index.html'
    expect(() => trust.assertTrustedMainFrame(eventFor(window))).toThrow(/inactive/)
    expect([...trust.trustedWindows()]).toEqual([])
  })

  it('rejects a registered main frame whose current web contents URL navigates away', () => {
    const trust = createRendererTrust({ isPackaged: true })
    const window = createWindow('app://bundle/index.html')
    trust.registerWindow(window)
    window.webContents.url = 'app://evil/index.html'

    expect(() => trust.assertTrustedMainFrame(eventFor(window))).toThrow(/inactive/)
    expect([...trust.trustedWindows()]).toEqual([])
  })

  it('rejects destroyed windows and web contents and filters publication recipients', () => {
    const trust = createRendererTrust({ isPackaged: true })
    const active = createWindow('app://bundle/index.html')
    const destroyedWindow = createWindow('app://bundle/index.html')
    const destroyedWebContents = createWindow('app://bundle/index.html')
    const navigatedWindow = createWindow('app://bundle/index.html')
    trust.registerWindow(active)
    trust.registerWindow(destroyedWindow)
    trust.registerWindow(destroyedWebContents)
    trust.registerWindow(navigatedWindow)
    destroyedWindow.destroyed = true
    destroyedWebContents.webContents.destroyed = true
    navigatedWindow.webContents.url = 'app://evil/index.html'

    expect(() => trust.assertTrustedMainFrame(eventFor(destroyedWindow))).toThrow(/inactive/)
    expect(() => trust.assertTrustedMainFrame(eventFor(destroyedWebContents))).toThrow(/inactive/)
    expect(() => trust.assertTrustedMainFrame(eventFor(navigatedWindow))).toThrow(/inactive/)
    for (const window of trust.trustedWindows()) {
      window.webContents.send('appearance:changed', { mode: 'dark' })
    }
    expect(active.webContents.sent).toEqual([['appearance:changed', { mode: 'dark' }]])
    expect(destroyedWindow.webContents.sent).toEqual([])
    expect(destroyedWebContents.webContents.sent).toEqual([])
    expect(navigatedWindow.webContents.sent).toEqual([])
  })

  it('unregisters closed windows and explicit unregisters from IPC and publications', () => {
    const trust = createRendererTrust({ isPackaged: true })
    const closed = createWindow('app://bundle/index.html')
    const explicitlyUnregistered = createWindow('app://bundle/index.html')
    trust.registerWindow(closed)
    const unregister = trust.registerWindow(explicitlyUnregistered)
    closed.closeListeners.forEach((listener) => listener())
    unregister()

    expect(() => trust.assertTrustedMainFrame(eventFor(closed))).toThrow(/unregistered/)
    expect(() => trust.assertTrustedMainFrame(eventFor(explicitlyUnregistered))).toThrow(
      /unregistered/,
    )
    expect([...trust.trustedWindows()]).toEqual([])
  })
})
