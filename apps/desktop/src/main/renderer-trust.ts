interface ManagedFrame {
  url: string
}

interface ManagedWebContents {
  readonly mainFrame: ManagedFrame
  getURL(): string
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface TrustedIpcEvent {
  sender: ManagedWebContents
  senderFrame: ManagedFrame | null
}

interface ManagedWindow {
  readonly webContents: ManagedWebContents
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
}

export interface RendererTrustOptions {
  isPackaged: boolean
  rendererUrl?: string
}

export interface RendererTrust {
  readonly loadUrl: string
  allowsNavigation(url: string): boolean
  registerWindow(window: ManagedWindow): () => void
  assertTrustedMainFrame(event: TrustedIpcEvent): void
  trustedWindows(): Iterable<ManagedWindow>
}

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url)
  } catch {
    return undefined
  }
}

export function createRendererTrust({
  isPackaged,
  rendererUrl,
}: RendererTrustOptions): RendererTrust {
  const configuredUrl = !isPackaged && rendererUrl ? parseUrl(rendererUrl) : undefined
  if (
    !isPackaged &&
    rendererUrl &&
    (!configuredUrl ||
      !['http:', 'https:'].includes(configuredUrl.protocol) ||
      configuredUrl.username ||
      configuredUrl.password)
  ) {
    throw new TypeError('ELECTRON_RENDERER_URL must be an HTTP(S) URL without credentials.')
  }

  const loadUrl = configuredUrl?.toString() ?? 'app://bundle/index.html'
  const allowsNavigation = configuredUrl
    ? (url: string): boolean => {
        const candidate = parseUrl(url)
        return (
          candidate !== undefined &&
          ['http:', 'https:'].includes(candidate.protocol) &&
          !candidate.username &&
          !candidate.password &&
          candidate.origin === configuredUrl.origin
        )
      }
    : (url: string): boolean => {
        const candidate = parseUrl(url)
        return (
          candidate !== undefined &&
          candidate.protocol === 'app:' &&
          candidate.hostname === 'bundle' &&
          candidate.port === '' &&
          candidate.username === '' &&
          candidate.password === ''
        )
      }

  const windows = new Set<ManagedWindow>()
  const isUsableWindow = (window: ManagedWindow): boolean =>
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    allowsNavigation(window.webContents.mainFrame.url) &&
    allowsNavigation(window.webContents.getURL())

  return {
    loadUrl,
    allowsNavigation,

    registerWindow(window): () => void {
      windows.add(window)
      const unregister = (): void => {
        windows.delete(window)
      }
      window.once('closed', unregister)
      return unregister
    },

    assertTrustedMainFrame(event): void {
      const senderFrame = event.senderFrame
      if (!senderFrame || senderFrame !== event.sender.mainFrame) {
        throw new Error('Rejected IPC request from a non-main frame.')
      }

      const window = [...windows].find((candidate) => candidate.webContents === event.sender)
      if (!window || !isUsableWindow(window)) {
        throw new Error('Rejected IPC request from an unregistered or inactive window.')
      }

      if (!allowsNavigation(senderFrame.url) || !allowsNavigation(event.sender.getURL())) {
        throw new Error('Rejected IPC request from an untrusted document.')
      }
    },

    *trustedWindows(): Iterable<ManagedWindow> {
      for (const window of windows) {
        if (isUsableWindow(window)) yield window
      }
    },
  }
}
