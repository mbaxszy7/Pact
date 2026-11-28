import { ipcMain } from 'electron'

import {
  IPC_CHANNELS,
  rpcResultSchema,
  TERMINAL_FLOW_HIGH_WATERMARK_BYTES,
  TERMINAL_FLOW_LOW_WATERMARK_BYTES,
  terminalAckOutputInputSchema,
  terminalAckOutputResultSchema,
  terminalCloseInputSchema,
  terminalCloseResultSchema,
  terminalCreateInputSchema,
  terminalLastExitNoticeResultSchema,
  terminalListInputSchema,
  terminalListResultSchema,
  terminalReleaseProjectViewsInputSchema,
  terminalReleaseProjectViewsResultSchema,
  terminalResizeInputSchema,
  terminalResizeResultSchema,
  terminalSnapshotInputSchema,
  terminalSnapshotResultSchema,
  terminalSubscribeInputSchema,
  terminalSubscribeResultSchema,
  terminalSummarySchema,
  terminalUnsubscribeInputSchema,
  terminalUnsubscribeResultSchema,
  terminalWriteInputSchema,
  terminalWriteResultSchema,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'
import type { NativeLastExitNoticeStore } from '../native-last-exit-notice'

interface TerminalSubscriptionEntry {
  subscriptionId: string
  terminalId: string
  projectId: string
  webContentsId: number
  webContents: Electron.WebContents
  unackedBytes: number
  backpressurePaused: boolean
}

/**
 * Registers IPC handlers and Renderer event forwarders for integrated Terminal panes,
 * bound strictly to trusted, live subscribed Renderer frames.
 */
export function registerTerminalIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
  lastExitNotice: NativeLastExitNoticeStore,
): () => void {
  const bySubscriptionId = new Map<string, TerminalSubscriptionEntry>()
  const subscriptionIdsByTerminal = new Map<string, Set<string>>()
  const subscriptionIdsByWebContents = new Map<number, Set<string>>()
  const watchedWebContents = new Map<number, () => void>()

  const isWebContentsTrusted = (webContents: Electron.WebContents): boolean => {
    if (webContents.isDestroyed() || webContents.isCrashed()) return false
    for (const window of trust.trustedWindows()) {
      if (window.webContents === webContents) return true
    }
    return false
  }

  const syncAggregateBackpressure = (terminalId: string): void => {
    const subIds = subscriptionIdsByTerminal.get(terminalId)
    let anyPaused = false
    if (subIds) {
      for (const id of subIds) {
        if (bySubscriptionId.get(id)?.backpressurePaused) {
          anyPaused = true
          break
        }
      }
    }
    if ((subIds?.size ?? 0) > 0) {
      void utilityClient.setTerminalVisibility({
        terminalId,
        visible: true,
        backpressurePaused: anyPaused,
      })
    }
  }

  const removeSubscription = (
    subscriptionId: string,
    options?: { notifyVisibilityIfEmpty?: boolean; rendererRetained?: boolean },
  ): void => {
    const entry = bySubscriptionId.get(subscriptionId)
    if (!entry) return
    bySubscriptionId.delete(subscriptionId)

    const terminalSet = subscriptionIdsByTerminal.get(entry.terminalId)
    if (terminalSet) {
      terminalSet.delete(subscriptionId)
      if (terminalSet.size === 0) subscriptionIdsByTerminal.delete(entry.terminalId)
    }

    const wcSet = subscriptionIdsByWebContents.get(entry.webContentsId)
    if (wcSet) {
      wcSet.delete(subscriptionId)
      if (wcSet.size === 0) {
        subscriptionIdsByWebContents.delete(entry.webContentsId)
        watchedWebContents.get(entry.webContentsId)?.()
        watchedWebContents.delete(entry.webContentsId)
      }
    }

    const remainingCount = subscriptionIdsByTerminal.get(entry.terminalId)?.size ?? 0
    if (remainingCount === 0 && options?.notifyVisibilityIfEmpty) {
      void utilityClient.setTerminalVisibility({
        terminalId: entry.terminalId,
        visible: false,
        rendererRetained: options.rendererRetained ?? true,
        backpressurePaused: false,
      })
    } else if (remainingCount > 0 && entry.backpressurePaused) {
      syncAggregateBackpressure(entry.terminalId)
    }
  }

  const removeAllForWebContents = (webContentsId: number, rendererRetained = false): void => {
    const subIds = [...(subscriptionIdsByWebContents.get(webContentsId) ?? [])]
    for (const subId of subIds) {
      removeSubscription(subId, { notifyVisibilityIfEmpty: true, rendererRetained })
    }
  }

  const ensureWebContentsLifecycle = (webContents: Electron.WebContents): void => {
    const webContentsId = webContents.id
    if (watchedWebContents.has(webContentsId)) return
    const onNavigate = (): void => {
      removeAllForWebContents(webContentsId, false)
    }
    const onGone = (): void => {
      removeAllForWebContents(webContentsId, false)
    }
    const onDestroyed = (): void => {
      removeAllForWebContents(webContentsId, false)
    }
    webContents.on('did-navigate', onNavigate)
    webContents.on('render-process-gone', onGone)
    webContents.once('destroyed', onDestroyed)
    watchedWebContents.set(webContentsId, () => {
      webContents.removeListener('did-navigate', onNavigate)
      webContents.removeListener('render-process-gone', onGone)
      webContents.removeListener('destroyed', onDestroyed)
    })
  }

  ipcMain.handle(IPC_CHANNELS.terminalList, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalListResultSchema).parse(
      await utilityClient.listTerminals(terminalListInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalCreate, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalSummarySchema).parse(
      await utilityClient.createTerminal(terminalCreateInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalSubscribe, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = terminalSubscribeInputSchema.parse(raw)
    const summary = utilityClient.getTrackedTerminal?.(input.terminalId)
    if (!summary) {
      return rpcResultSchema(terminalSubscribeResultSchema).parse({
        ok: false,
        error: { code: 'CONFLICT', message: 'Terminal session was not found.' },
      })
    }

    const webContentsId = event.sender.id
    const existingForWc = [...(subscriptionIdsByWebContents.get(webContentsId) ?? [])]
    for (const existingId of existingForWc) {
      const existing = bySubscriptionId.get(existingId)
      if (
        existing &&
        existing.terminalId === input.terminalId &&
        existingId !== input.subscriptionId
      ) {
        removeSubscription(existingId, { notifyVisibilityIfEmpty: false })
      }
    }
    if (bySubscriptionId.has(input.subscriptionId)) {
      removeSubscription(input.subscriptionId, { notifyVisibilityIfEmpty: false })
    }

    const entry: TerminalSubscriptionEntry = {
      subscriptionId: input.subscriptionId,
      terminalId: input.terminalId,
      projectId: summary.projectId,
      webContentsId,
      webContents: event.sender,
      unackedBytes: 0,
      backpressurePaused: false,
    }
    bySubscriptionId.set(input.subscriptionId, entry)
    let terminalSet = subscriptionIdsByTerminal.get(input.terminalId)
    if (!terminalSet) {
      terminalSet = new Set<string>()
      subscriptionIdsByTerminal.set(input.terminalId, terminalSet)
    }
    terminalSet.add(input.subscriptionId)
    let wcSet = subscriptionIdsByWebContents.get(webContentsId)
    if (!wcSet) {
      wcSet = new Set<string>()
      subscriptionIdsByWebContents.set(webContentsId, wcSet)
    }
    wcSet.add(input.subscriptionId)
    ensureWebContentsLifecycle(event.sender)

    const vis = await utilityClient.setTerminalVisibility({
      terminalId: input.terminalId,
      visible: true,
      rendererRetained: true,
      backpressurePaused: false,
    })
    if (!vis.ok) {
      removeSubscription(input.subscriptionId, {
        notifyVisibilityIfEmpty: true,
        rendererRetained: true,
      })
      return rpcResultSchema(terminalSubscribeResultSchema).parse(vis)
    }

    const latest = utilityClient.getTrackedTerminal?.(input.terminalId) ?? summary
    return rpcResultSchema(terminalSubscribeResultSchema).parse({
      ok: true,
      value: { subscribed: true, terminal: latest },
    })
  })

  ipcMain.handle(IPC_CHANNELS.terminalUnsubscribe, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = terminalUnsubscribeInputSchema.parse(raw)
    const entry = bySubscriptionId.get(input.subscriptionId)
    if (entry && entry.webContentsId === event.sender.id) {
      removeSubscription(input.subscriptionId, {
        notifyVisibilityIfEmpty: true,
        rendererRetained: true,
      })
    }
    return rpcResultSchema(terminalUnsubscribeResultSchema).parse({
      ok: true,
      value: { unsubscribed: true },
    })
  })

  ipcMain.handle(IPC_CHANNELS.terminalAckOutput, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = terminalAckOutputInputSchema.parse(raw)
    const entry = bySubscriptionId.get(input.subscriptionId)
    if (entry && entry.webContentsId === event.sender.id && entry.terminalId === input.terminalId) {
      entry.unackedBytes = Math.max(0, entry.unackedBytes - input.ackedBytes)
      if (entry.backpressurePaused && entry.unackedBytes <= TERMINAL_FLOW_LOW_WATERMARK_BYTES) {
        entry.backpressurePaused = false
        syncAggregateBackpressure(entry.terminalId)
      }
    }
    return rpcResultSchema(terminalAckOutputResultSchema).parse({
      ok: true,
      value: { acknowledged: true },
    })
  })

  ipcMain.handle(IPC_CHANNELS.terminalReleaseProjectViews, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = terminalReleaseProjectViewsInputSchema.parse(raw)
    const webContentsId = event.sender.id
    const subIds = [...(subscriptionIdsByWebContents.get(webContentsId) ?? [])]
    for (const subId of subIds) {
      const sub = bySubscriptionId.get(subId)
      if (sub && sub.projectId === input.projectId) {
        removeSubscription(subId, { notifyVisibilityIfEmpty: false })
      }
    }
    return rpcResultSchema(terminalReleaseProjectViewsResultSchema).parse(
      await utilityClient.releaseProjectTerminalViews(input.projectId),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalWrite, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalWriteResultSchema).parse(
      await utilityClient.writeTerminal(terminalWriteInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalResize, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalResizeResultSchema).parse(
      await utilityClient.resizeTerminal(terminalResizeInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalClose, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalCloseResultSchema).parse(
      await utilityClient.closeTerminal(terminalCloseInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalReadSnapshot, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    return rpcResultSchema(terminalSnapshotResultSchema).parse(
      await utilityClient.readTerminalSnapshot(terminalSnapshotInputSchema.parse(raw)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.terminalLastExitNotice, async (event) => {
    trust.assertTrustedMainFrame(event)
    const notice = await lastExitNotice.consume()
    return rpcResultSchema(terminalLastExitNoticeResultSchema).parse({
      ok: true,
      value: notice,
    })
  })

  const unsubscribeOutput = utilityClient.subscribeTerminalOutput((payload) => {
    const subIds = subscriptionIdsByTerminal.get(payload.terminalId)
    if (!subIds || subIds.size === 0) return
    for (const subId of Array.from(subIds)) {
      const entry = bySubscriptionId.get(subId)
      if (!entry) continue
      if (!isWebContentsTrusted(entry.webContents)) {
        removeSubscription(subId, { notifyVisibilityIfEmpty: true, rendererRetained: false })
        continue
      }
      entry.unackedBytes += payload.utf8Bytes
      if (!entry.backpressurePaused && entry.unackedBytes >= TERMINAL_FLOW_HIGH_WATERMARK_BYTES) {
        entry.backpressurePaused = true
        void utilityClient.setTerminalVisibility({
          terminalId: payload.terminalId,
          visible: true,
          backpressurePaused: true,
        })
      }
      entry.webContents.send(IPC_CHANNELS.terminalOutput, payload)
    }
  })

  const unsubscribeState = utilityClient.subscribeTerminalState((payload) => {
    if (payload.kind === 'removed') {
      const subIds = [...(subscriptionIdsByTerminal.get(payload.terminalId) ?? [])]
      for (const subId of subIds) {
        removeSubscription(subId, { notifyVisibilityIfEmpty: false })
      }
    }
    for (const window of trust.trustedWindows()) {
      if (!window.webContents.isCrashed?.()) {
        window.webContents.send(IPC_CHANNELS.terminalState, payload)
      }
    }
  })

  return () => {
    unsubscribeOutput()
    unsubscribeState()
    for (const disposeWatcher of watchedWebContents.values()) {
      disposeWatcher()
    }
    watchedWebContents.clear()
    bySubscriptionId.clear()
    subscriptionIdsByTerminal.clear()
    subscriptionIdsByWebContents.clear()
    ipcMain.removeHandler(IPC_CHANNELS.terminalList)
    ipcMain.removeHandler(IPC_CHANNELS.terminalCreate)
    ipcMain.removeHandler(IPC_CHANNELS.terminalSubscribe)
    ipcMain.removeHandler(IPC_CHANNELS.terminalUnsubscribe)
    ipcMain.removeHandler(IPC_CHANNELS.terminalAckOutput)
    ipcMain.removeHandler(IPC_CHANNELS.terminalReleaseProjectViews)
    ipcMain.removeHandler(IPC_CHANNELS.terminalWrite)
    ipcMain.removeHandler(IPC_CHANNELS.terminalResize)
    ipcMain.removeHandler(IPC_CHANNELS.terminalClose)
    ipcMain.removeHandler(IPC_CHANNELS.terminalReadSnapshot)
    ipcMain.removeHandler(IPC_CHANNELS.terminalLastExitNotice)
  }
}
