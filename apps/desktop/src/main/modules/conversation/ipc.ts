import { BrowserWindow, ipcMain, dialog, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'

import type { RpcResult } from '@pact/contracts'

import { collaborationActionInputSchema } from '@pact/contracts'
import {
  imageWriteInputSchema,
  imageReadInputSchema,
  imageChooseInputSchema,
  skillCatalogReadSchema,
  skillDocumentReadSchema,
} from '@pact/contracts'
import {
  commentDraftRemoveInputSchema,
  commentDraftSaveInputSchema,
  conversationGetInputSchema,
  conversationInterestSchema,
  CONVERSATION_INTEREST_ITEMS,
  conversationPatchSchema,
  conversationRetryInputSchema,
  conversationSendInputSchema,
  conversationInputWriteSchema,
  CONVERSATION_INPUT_WRITE_BYTES,
  conversationStopInputSchema,
  conversationQueueActionInputSchema,
  conversationQueueReturnInputSchema,
  conversationQueueEnabledInputSchema,
  nativeContextRebuildInputSchema,
  sessionForkInputSchema,
  peerProposalAcceptInputSchema,
  peerProposalDismissInputSchema,
  IPC_CHANNELS,
} from '@pact/contracts'

import type { RendererTrust } from '../../renderer-trust'
import type { UtilityProcessClient } from '../../utility-process/client'

export function registerConversationIpcHandlers(
  trust: RendererTrust,
  utilityClient: UtilityProcessClient,
): () => void {
  // Each trusted renderer document owns only its unsubmitted input parts.
  // A new UUID on navigation/restart prevents recycled WebContents IDs from taking ownership.
  const inputOwners = new Map<WebContents, { key: string; release: () => void }>()
  const inputOwner = (sender: WebContents): string | undefined => {
    const existing = inputOwners.get(sender)
    if (existing) return existing.key
    if (inputOwners.size >= CONVERSATION_INTEREST_ITEMS || sender.isDestroyed()) return undefined
    const key = randomUUID()
    const release = (): void => {
      sender.removeListener('destroyed', release)
      sender.removeListener('render-process-gone', release)
      sender.removeListener('did-start-navigation', navigate)
      inputOwners.delete(sender)
      void utilityClient.releaseConversationInputs(key)
    }
    const navigate = (
      _event: unknown,
      _url: string,
      inPlace: boolean,
      mainFrame: boolean,
    ): void => {
      if (mainFrame && !inPlace) release()
    }
    inputOwners.set(sender, { key, release })
    sender.once('destroyed', release)
    sender.once('render-process-gone', release)
    sender.on('did-start-navigation', navigate)
    return key
  }
  ipcMain.handle(IPC_CHANNELS.conversationImageWrite, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = imageWriteInputSchema.safeParse(raw),
      owner = input.success ? inputOwner(event.sender) : undefined
    return input.success && owner
      ? utilityClient.writeConversationImage(input.data, owner)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid image input.' } }
  })
  ipcMain.handle(IPC_CHANNELS.conversationImageRead, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = imageReadInputSchema.safeParse(raw),
      owner = input.success ? inputOwner(event.sender) : undefined
    return input.success && owner
      ? utilityClient.readConversationImage(input.data, owner)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose an image in this Session.' } }
  })
  ipcMain.handle(IPC_CHANNELS.conversationImageChoose, async (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = imageChooseInputSchema.safeParse(raw),
      owner = input.success ? inputOwner(event.sender) : undefined
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!input.success || !owner || !window)
      return { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid image window.' } }
    const result = await dialog.showOpenDialog(window, {
      title: 'Add images',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    })
    if (result.canceled) return { ok: true, value: [] }
    if (inputOwners.get(event.sender)?.key !== owner)
      return { ok: false, error: { code: 'CONFLICT', message: 'The image input window changed.' } }
    return utilityClient.chooseConversationImages(input.data.sessionId, result.filePaths, owner)
  })
  ipcMain.handle(IPC_CHANNELS.conversationInput, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationInputWriteSchema.safeParse(rawInput)
    const ownerKey = input.success ? inputOwner(event.sender) : undefined
    return input.success && ownerKey
      ? utilityClient.writeConversationInput(input.data, ownerKey)
      : {
          ok: false,
          error: { code: 'VALIDATION', message: 'Choose a valid input part and window.' },
        }
  })
  ipcMain.handle(IPC_CHANNELS.skillDocumentRead, (event, input: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = skillDocumentReadSchema.safeParse(input)
    return parsed.success
      ? utilityClient.readSkillDocument(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid Skill document.' } }
  })
  ipcMain.handle(IPC_CHANNELS.skillDocumentCancel, (event, requestId: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = skillDocumentReadSchema.shape.requestId.safeParse(requestId)
    return parsed.success
      ? utilityClient.cancelSkillDocument(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid document request.' } }
  })
  ipcMain.handle(IPC_CHANNELS.skillCatalogCancel, (event, sessionId: unknown) => {
    trust.assertTrustedMainFrame(event)
    return typeof sessionId === 'string' && /^[a-f0-9-]{36}$/iu.test(sessionId)
      ? utilityClient.cancelSkillCatalog(sessionId)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid Skill owner.' } }
  })
  ipcMain.handle(IPC_CHANNELS.collaborationAction, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = collaborationActionInputSchema.safeParse(raw)
    return parsed.success
      ? utilityClient.actOnCollaboration(parsed.data)
      : {
          ok: false,
          error: { code: 'VALIDATION', message: 'Choose a current collaboration action.' },
        }
  })
  ipcMain.handle(IPC_CHANNELS.skillCatalogRead, (event, input: unknown) => {
    trust.assertTrustedMainFrame(event)
    const parsed = skillCatalogReadSchema.safeParse(input)
    return parsed.success
      ? utilityClient.readSkillCatalog(parsed.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a valid Skill catalog.' } }
  })
  // Each trusted document owns one replacement interest. Propagation has one
  // in-flight operation and one latest state, never a queue of UI transitions.
  const interests = new Map<
    object,
    { sessionId: string | null; generation: number; visible: () => boolean; release: () => void }
  >()
  ipcMain.handle(IPC_CHANNELS.sessionFork, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = sessionForkInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.forkSession(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid fork action.' },
        })
  })
  let revision = 0,
    appliedRevision = 0,
    disposed = false
  let syncing: Promise<RpcResult<{ ready: true }>> | undefined
  const syncInterests = (): Promise<RpcResult<{ ready: true }>> => {
    syncing ??= (async () => {
      const deadline = performance.now() + 10_000
      while (appliedRevision !== revision) {
        if (performance.now() >= deadline)
          return {
            ok: false as const,
            error: { code: 'TIMEOUT' as const, message: 'Session interest update timed out.' },
          }
        const target = revision
        const sessionIds = [
          ...new Set(
            [...interests.values()].flatMap((entry) =>
              entry.sessionId && entry.visible() ? [entry.sessionId] : [],
            ),
          ),
        ]
        // oxlint-disable-next-line no-await-in-loop -- One ordered latest-state propagation owner.
        const result = await utilityClient.setConversationInterests(
          sessionIds,
          deadline - performance.now(),
        )
        if (!result.ok) {
          // A failed obsolete update must not swallow replacement or release.
          // Send the latest state within this deadline; never retry unchanged state.
          if (target === revision) return result
          continue
        }
        appliedRevision = target
      }
      return { ok: true as const, value: { ready: true as const } }
    })().finally(() => {
      syncing = undefined
    })
    return syncing
  }
  ipcMain.handle(IPC_CHANNELS.conversationInterest, async (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationInterestSchema.safeParse(rawInput)
    if (!input.success)
      return {
        ok: false,
        error: { code: 'VALIDATION', message: 'Choose a valid Session interest.' },
      }
    const sender = event.sender
    let entry = interests.get(sender)
    if (entry && input.data.generation <= entry.generation) return syncInterests()
    if (!entry) {
      const ownerWindow = BrowserWindow.fromWebContents(sender)
      if (!ownerWindow)
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'Conversation window is unavailable.' },
        }
      if (interests.size === CONVERSATION_INTEREST_ITEMS)
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'Too many Conversation viewers.' },
        }
      const release = (): void => {
        sender.removeListener('destroyed', release)
        sender.removeListener('did-start-navigation', navigate)
        sender.removeListener('render-process-gone', release)
        ownerWindow.removeListener('hide', visibilityChanged)
        ownerWindow.removeListener('show', visibilityChanged)
        ownerWindow.removeListener('minimize', visibilityChanged)
        ownerWindow.removeListener('restore', visibilityChanged)
        interests.delete(sender)
        revision += 1
        if (!disposed) void syncInterests()
      }
      const visibilityChanged = (): void => {
        revision += 1
        void syncInterests()
      }
      const navigate = (
        _event: unknown,
        _url: string,
        inPlace: boolean,
        mainFrame: boolean,
      ): void => {
        if (mainFrame && !inPlace) release()
      }
      entry = {
        sessionId: null,
        generation: input.data.generation,
        release,
        visible: () =>
          !ownerWindow.isDestroyed() && ownerWindow.isVisible() && !ownerWindow.isMinimized(),
      }
      interests.set(sender, entry)
      sender.once('destroyed', release)
      sender.on('did-start-navigation', navigate)
      sender.once('render-process-gone', release)
      ownerWindow.on('hide', visibilityChanged)
      ownerWindow.on('show', visibilityChanged)
      ownerWindow.on('minimize', visibilityChanged)
      ownerWindow.on('restore', visibilityChanged)
    }
    entry.sessionId = input.data.sessionId
    entry.generation = input.data.generation
    revision += 1
    return syncInterests()
  })
  ipcMain.handle(IPC_CHANNELS.conversationGet, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationGetInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.getConversation(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Session.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.conversationSend, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationSendInputSchema.safeParse(rawInput)
    const withinBudget =
      input.success &&
      input.data.content.length <= CONVERSATION_INPUT_WRITE_BYTES &&
      Buffer.byteLength(JSON.stringify(input.data), 'utf8') <= 128 * 1024
    const ownerKey = withinBudget ? inputOwner(event.sender) : undefined
    return input.success && withinBudget && ownerKey
      ? utilityClient.sendConversationMessage(input.data, ownerKey)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Enter a message to send.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.steerQueuedConversationMessage, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationQueueActionInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.steerQueuedConversationMessage(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a current queued message.' } }
  })
  ipcMain.handle(IPC_CHANNELS.returnQueuedConversationMessage, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationQueueReturnInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.returnQueuedConversationMessage(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a current queued message.' } }
  })
  ipcMain.handle(IPC_CHANNELS.removeQueuedConversationMessage, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationQueueActionInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.removeQueuedConversationMessage(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a current queued message.' } }
  })
  ipcMain.handle(IPC_CHANNELS.resumeConversationQueue, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationQueueActionInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.resumeConversationQueue(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a current paused message.' } }
  })
  ipcMain.handle(IPC_CHANNELS.setConversationQueueEnabled, (event, raw: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationQueueEnabledInputSchema.safeParse(raw)
    return input.success
      ? utilityClient.setConversationQueueEnabled(input.data)
      : { ok: false, error: { code: 'VALIDATION', message: 'Choose a current Session queue.' } }
  })

  ipcMain.handle(IPC_CHANNELS.conversationRetry, (event, runIdInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationRetryInputSchema.safeParse(
      typeof runIdInput === 'string' ? { runId: runIdInput } : runIdInput,
    )
    return input.success
      ? utilityClient.retryConversationRun(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Run to retry.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.conversationStop, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = conversationStopInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.stopConversation(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a Session to stop.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.peerProposalAccept, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = peerProposalAcceptInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.acceptPeerProposal(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid peer request.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.peerProposalDismiss, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = peerProposalDismissInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.dismissPeerProposal(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid peer request.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.nativeContextRebuild, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = nativeContextRebuildInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.rebuildNativeContext(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a Native Session to rebuild.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.commentDraftSave, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = commentDraftSaveInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.saveCommentDraft(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Enter a valid Comment draft.' },
        })
  })

  ipcMain.handle(IPC_CHANNELS.commentDraftRemove, (event, rawInput: unknown) => {
    trust.assertTrustedMainFrame(event)
    const input = commentDraftRemoveInputSchema.safeParse(rawInput)
    return input.success
      ? utilityClient.removeCommentDraft(input.data)
      : Promise.resolve({
          ok: false as const,
          error: { code: 'VALIDATION' as const, message: 'Choose a valid Comment draft.' },
        })
  })

  ipcMain.handle(
    IPC_CHANNELS.commentSourceResolve,
    (event, sessionId: unknown, commentId: unknown) => {
      trust.assertTrustedMainFrame(event)
      return typeof sessionId === 'string' && typeof commentId === 'string'
        ? utilityClient.resolveCommentSource(sessionId, commentId)
        : Promise.resolve({
            ok: false as const,
            error: { code: 'VALIDATION' as const, message: 'Choose a valid Comment.' },
          })
    },
  )

  const unsubscribe = utilityClient.subscribeConversation((patch, progress) => {
    const payload = conversationPatchSchema.parse(patch)
    for (const window of trust.trustedWindows()) {
      const entry = interests.get(window.webContents)
      const interested = entry?.sessionId === patch.sessionId && entry.visible()
      if (progress && !interested) continue
      const routed = interested
        ? payload
        : {
            version: payload.version,
            sessionId: payload.sessionId,
            observation: payload.observation,
            session: payload.session,
            // Message identity is a durable send ACK even when its document is
            // reading another Session. Retain it without transmitting the body.
            messages: payload.messages
              .filter((change) => change.message.role === 'user')
              .map((change) => ({
                mode: 'metadata' as const,
                message: change.message,
                hasActivities: change.hasActivities,
                hasComments: change.hasComments,
              })),
            // A terminal context rejection is a body-free fact. Keep its
            // identity for the App-level Error Toast even while another
            // Session owns the visible Transcript.
            runs: payload.runs
              .filter((run) => run.status === 'failed' && run.failureKind === 'context_limit')
              .map(({ failureMessage: _failureMessage, ...run }) => run),
            activities: [],
            activityStates: [],
            ...(payload.forkOperation ? { forkOperation: payload.forkOperation } : {}),
            ...(payload.forkBlocked !== undefined ? { forkBlocked: payload.forkBlocked } : {}),
            ...(payload.forkOperation && payload.pendingNativeInteractions
              ? { pendingNativeInteractions: payload.pendingNativeInteractions }
              : {}),
            ...(payload.latestRunId ? { latestRunId: payload.latestRunId } : {}),
          }
      window.webContents.send(IPC_CHANNELS.conversationChanged, routed)
    }
  })

  return () => {
    disposed = true
    for (const entry of interests.values()) entry.release()
    for (const owner of inputOwners.values()) owner.release()
    inputOwners.clear()
    ipcMain.removeHandler(IPC_CHANNELS.conversationImageWrite)
    ipcMain.removeHandler(IPC_CHANNELS.conversationImageRead)
    ipcMain.removeHandler(IPC_CHANNELS.conversationImageChoose)
    ipcMain.removeHandler(IPC_CHANNELS.conversationInput)
    interests.clear()
    revision += 1
    void syncInterests()
    ipcMain.removeHandler(IPC_CHANNELS.conversationInterest)
    ipcMain.removeHandler(IPC_CHANNELS.sessionFork)
    ipcMain.removeHandler(IPC_CHANNELS.skillCatalogCancel)
    ipcMain.removeHandler(IPC_CHANNELS.skillCatalogRead)
    ipcMain.removeHandler(IPC_CHANNELS.skillDocumentRead)
    ipcMain.removeHandler(IPC_CHANNELS.skillDocumentCancel)
    ipcMain.removeHandler(IPC_CHANNELS.conversationGet)
    ipcMain.removeHandler(IPC_CHANNELS.conversationSend)
    ipcMain.removeHandler(IPC_CHANNELS.steerQueuedConversationMessage)
    ipcMain.removeHandler(IPC_CHANNELS.returnQueuedConversationMessage)
    ipcMain.removeHandler(IPC_CHANNELS.removeQueuedConversationMessage)
    ipcMain.removeHandler(IPC_CHANNELS.resumeConversationQueue)
    ipcMain.removeHandler(IPC_CHANNELS.setConversationQueueEnabled)
    ipcMain.removeHandler(IPC_CHANNELS.conversationStop)
    ipcMain.removeHandler(IPC_CHANNELS.peerProposalAccept)
    ipcMain.removeHandler(IPC_CHANNELS.peerProposalDismiss)
    ipcMain.removeHandler(IPC_CHANNELS.conversationRetry)
    ipcMain.removeHandler(IPC_CHANNELS.nativeContextRebuild)
    ipcMain.removeHandler(IPC_CHANNELS.commentDraftSave)
    ipcMain.removeHandler(IPC_CHANNELS.commentDraftRemove)
    ipcMain.removeHandler(IPC_CHANNELS.commentSourceResolve)
    unsubscribe()
  }
}
