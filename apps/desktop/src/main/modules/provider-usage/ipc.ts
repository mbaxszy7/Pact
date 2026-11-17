import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'

import {
  CONVERSATION_INTEREST_ITEMS,
  IPC_CHANNELS,
  providerUsageCancelInputSchema,
  providerUsageReadInputSchema,
  providerUsageRefreshInputSchema,
  type ProviderUsageProvider,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

interface DocumentUsageOwner {
  readonly ownerId: string
  readonly activeRequests: Map<ProviderUsageProvider, string>
  released: boolean
  readonly release: () => void
}

export function registerProviderUsageIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  const owners = new Map<WebContents, DocumentUsageOwner>()

  const getOrCreateOwner = (sender: WebContents): DocumentUsageOwner | undefined => {
    const existing = owners.get(sender)
    if (existing) return existing
    if (owners.size >= CONVERSATION_INTEREST_ITEMS || sender.isDestroyed()) return undefined

    const ownerId = randomUUID()
    const hostWindow = BrowserWindow.fromWebContents(sender)

    const cancelActive = (): void => {
      if (entry.released || entry.activeRequests.size === 0) return
      const activeEntries = [...entry.activeRequests.entries()]
      entry.activeRequests.clear()
      for (const [provider, requestId] of activeEntries) {
        void utilityClient
          .cancelProviderUsage({ ownerId, provider, requestId })
          .catch(() => undefined)
      }
    }

    const onNavigate = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ): void => {
      if (mainFrame && !inPlace) release()
    }

    const release = (): void => {
      if (entry.released) return
      entry.released = true
      entry.activeRequests.clear()
      owners.delete(sender)
      sender.removeListener('destroyed', release)
      sender.removeListener('render-process-gone', release)
      sender.removeListener('did-start-navigation', onNavigate)
      if (hostWindow && !hostWindow.isDestroyed()) {
        hostWindow.removeListener('hide', cancelActive)
        hostWindow.removeListener('minimize', cancelActive)
        hostWindow.removeListener('unresponsive', cancelActive)
        hostWindow.removeListener('closed', release)
      }
      void utilityClient.releaseProviderUsageOwner(ownerId).catch(() => undefined)
    }

    const entry: DocumentUsageOwner = {
      ownerId,
      activeRequests: new Map(),
      released: false,
      release,
    }

    owners.set(sender, entry)
    sender.once('destroyed', release)
    sender.once('render-process-gone', release)
    sender.on('did-start-navigation', onNavigate)
    if (hostWindow && !hostWindow.isDestroyed()) {
      hostWindow.on('hide', cancelActive)
      hostWindow.on('minimize', cancelActive)
      hostWindow.on('unresponsive', cancelActive)
      hostWindow.once('closed', release)
    }
    return entry
  }

  ipcMain.handle(IPC_CHANNELS.providerUsageGet, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = providerUsageReadInputSchema.safeParse(raw)
    return parsed.success
      ? utilityClient.getProviderUsage(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Invalid usage read request.' } }
  })

  ipcMain.handle(IPC_CHANNELS.providerUsageRefresh, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = providerUsageRefreshInputSchema.safeParse(raw)
    if (!parsed.success) {
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Invalid usage refresh request.' },
      }
    }
    const owner = getOrCreateOwner(event.sender)
    if (!owner || owner.released) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Usage check ownership is unavailable.' },
      }
    }
    owner.activeRequests.set(parsed.data.provider, parsed.data.requestId)
    try {
      const result = await utilityClient.refreshProviderUsage({
        ownerId: owner.ownerId,
        provider: parsed.data.provider,
        requestId: parsed.data.requestId,
      })
      trust.assertTrustedMainFrame(event)
      if (owner.released) {
        return {
          ok: false,
          error: { code: 'CONFLICT', message: 'Usage check was cancelled.' },
        }
      }
      return result
    } finally {
      if (owner.activeRequests.get(parsed.data.provider) === parsed.data.requestId) {
        owner.activeRequests.delete(parsed.data.provider)
      }
    }
  })

  ipcMain.handle(IPC_CHANNELS.providerUsageCancel, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = providerUsageCancelInputSchema.safeParse(raw)
    if (!parsed.success) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Invalid usage cancel request.' } }
    }
    const owner = owners.get(event.sender)
    if (!owner || owner.released) {
      return { ok: true, value: { cancelled: false, settled: true } }
    }
    if (owner.activeRequests.get(parsed.data.provider) === parsed.data.requestId) {
      owner.activeRequests.delete(parsed.data.provider)
    }
    return utilityClient.cancelProviderUsage({
      ownerId: owner.ownerId,
      provider: parsed.data.provider,
      requestId: parsed.data.requestId,
    })
  })

  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.providerUsageGet)
    ipcMain.removeHandler(IPC_CHANNELS.providerUsageRefresh)
    ipcMain.removeHandler(IPC_CHANNELS.providerUsageCancel)
    for (const owner of owners.values()) owner.release()
  }
}
