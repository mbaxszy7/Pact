import type { QueryClient } from '@tanstack/react-query'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'

import type {
  ConversationPage,
  ConversationPatch,
  ConversationQueueActionInput,
  ConversationSendInput,
  RuntimeAgentId,
  SkillSelection,
  UserInformationDeclaration,
  NativeContextRebuildInput,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'

import {
  parseComposerCommandPrefix,
  relaySchedulingDecisionSchema,
  userInformationDeclarationSchema,
} from '@pact/contracts'

import type { ConversationWindow } from './conversation-window'

import { conversationQueryKeys, RpcError, unwrapRpcResult } from '../../query-client'
import { assertComposerEditLengths, composerEncodedTextBytes } from './composer-capacity'
import { composerRouteIntent } from './composer-document'
import {
  bodyTextEncoder,
  formatDecisionAnswers,
  hasDecisionAnswers,
  INFORMATION_CANCELLATION_ITEMS,
  INLINE_INPUT_BYTES,
  MAX_PENDING_SYNC_MAIN_SESSIONS,
  releasePreparedInput,
  sameDecision,
  sameSyncMainPayload,
  sha256Hex,
  uploadLargeConversationInput,
  type CommentDraftInputWithoutRevision,
  type CommentDraftSaveOutcome,
  type ConversationComposerDraft,
  type ConversationComposerMention,
  type DecisionReplyContext,
  type InformationCancellation,
  type PendingSubmission,
  type PendingSyncMain,
  type ReturnedInputRead,
  type SessionOperationState,
} from './conversation-draft-helpers'
import { releaseDraftImage, type DraftImage } from './image-client'

export interface ConversationActionsHost {
  readonly sessionId: string | undefined
  readonly visible: boolean
  readonly onNotice: (message: string) => void
  readonly onErrorNotice: (message: string) => void
  readonly onInfoNotice: (message: string) => void
  readonly queryClient: QueryClient
  readonly operationsBySessionRef: MutableRefObject<Record<string, SessionOperationState>>
  readonly clearOtherCancelledInformation: (exceptSessionId: string) => void
  readonly composerDraftsBySession: Record<string, ConversationComposerDraft>
  readonly latestComposerDraft: MutableRefObject<
    { sessionId: string; draft: ConversationComposerDraft } | undefined
  >
  readonly composerDraftsRef: MutableRefObject<Record<string, ConversationComposerDraft>>
  readonly imageUploads: MutableRefObject<
    Map<string, { sessionId: string; controller: AbortController; bytes: number }>
  >
  readonly imageChoosers: MutableRefObject<Map<string, AbortController>>
  readonly getReturnOperation: () => ReturnedInputRead | undefined
  readonly setReturnOperation: (value: ReturnedInputRead | undefined) => void
  readonly pendingBySessionRef: MutableRefObject<Map<string, PendingSubmission>>
  readonly activeSessionIdRef: MutableRefObject<string | undefined>
  readonly admitComposerResidency: (
    drafts: Record<string, ConversationComposerDraft>,
    pendingCandidate?: { sessionId: string; value: PendingSubmission },
    textCandidate?: { sessionId: string; chars: number },
  ) => boolean
  readonly putComposerDraft: (ownerSessionId: string, next: ConversationComposerDraft) => boolean
  readonly windowState: ConversationWindow | undefined
  readonly windowRef: MutableRefObject<ConversationWindow | undefined>
  readonly projectionActiveRef: MutableRefObject<boolean>
  readonly draftHasMore: boolean
  readonly draftHasEarlier: boolean
  readonly draftsReadyRevision: number | undefined
  readonly setDraftsReadyRevision: Dispatch<SetStateAction<number | undefined>>
  readonly bumpDraftReloadToken: () => void
  readonly refetchConversation: (options?: {
    cancelRefetch?: boolean
  }) => Promise<{ isError: boolean }>
  readonly sending: boolean
  readonly stopping: boolean
  readonly checkingNativeTargetId: string | undefined
  readonly composerDraft: ConversationComposerDraft | undefined
  readonly composer: string
  readonly clearCancelledInformation: (
    ownerSessionId: string,
    expected: UserInformationDeclaration,
  ) => boolean
  readonly composerImages: readonly DraftImage[]
  readonly composerMention: ConversationComposerMention | undefined
  readonly clearSubmittedComposerDraft: (
    targetSessionId: string,
    expectedRevision: number,
    consumedImageIds?: readonly string[],
  ) => void
  readonly updateSessionOperations: (
    ownerSessionId: string,
    update: (current: SessionOperationState) => SessionOperationState,
  ) => void
  readonly settleSubmission: (ownerSessionId: string, clientMessageId: string) => void
  readonly releaseSupersededQueueReturn: (next: ConversationWindow | undefined) => void
  readonly cachePatch: (patch: ConversationPatch) => void
}

/**
 * Cohesive React hook owning all conversation write operations, queue & return-to-composer
 * flows, side-chat sync-back, prepared-information cancellation, and native interaction responses.
 */
export function useConversationActions(host: ConversationActionsHost) {
  const {
    sessionId,
    visible,
    onNotice,
    onErrorNotice,
    onInfoNotice,
    queryClient,
    operationsBySessionRef,
    clearOtherCancelledInformation,
    composerDraftsBySession,
    latestComposerDraft,
    composerDraftsRef,
    imageUploads,
    imageChoosers,
    getReturnOperation,
    setReturnOperation,
    pendingBySessionRef,
    activeSessionIdRef,
    admitComposerResidency,
    putComposerDraft,
    windowState,
    windowRef,
    projectionActiveRef,
    draftHasMore,
    draftHasEarlier,
    draftsReadyRevision,
    setDraftsReadyRevision,
    bumpDraftReloadToken,
    refetchConversation,
    sending,
    stopping,
    checkingNativeTargetId,
    composerDraft,
    composer,
    clearCancelledInformation,
    composerImages,
    composerMention,
    clearSubmittedComposerDraft,
    updateSessionOperations,
    settleSubmission,
    releaseSupersededQueueReturn,
    cachePatch,
  } = host

  const queueOperation = useRef<
    { sessionId: string; operationId: string; controller: AbortController } | undefined
  >(undefined)
  const [restoringInput, setRestoringInput] = useState(false)
  const returnAttempt = useRef<string | undefined>(undefined)
  const pendingSyncMainRef = useRef(new Map<string, PendingSyncMain>())
  const pendingSyncInFlightRef = useRef(new Set<string>())
  useEffect(() => {
    const pendingSync = pendingSyncMainRef.current
    const inFlight = pendingSyncInFlightRef.current
    return () => {
      queueOperation.current?.controller.abort()
      queueOperation.current = undefined
      for (const entry of pendingSync.values()) entry.inputPreparation?.abort()
      pendingSync.clear()
      inFlight.clear()
    }
  }, [])

  const currentInformationCancellation = (owner: InformationCancellation) =>
    operationsBySessionRef.current[owner.request.sessionId]?.informationCancellation?.input
      .clientOperationId === owner.input.clientOperationId

  const observeInformationCancellation = async (
    owner: InformationCancellation,
    invoke: () => Promise<
      import('@pact/contracts').RpcResult<import('@pact/contracts').RelayDecisionReceipt>
    >,
    phase: 'cancel' | 'receipt',
  ): Promise<boolean> => {
    let result: Awaited<ReturnType<typeof invoke>>
    try {
      result = await invoke()
    } catch {
      result = {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message:
            'The cancellation result is not confirmed. Check this decision before sending again.',
        },
      }
    }
    if (!currentInformationCancellation(owner)) return false
    // This endpoint returns CONFLICT only before mutation; committed Cancel has its positive receipt.
    if (!result.ok && phase === 'cancel' && result.error.code === 'CONFLICT') {
      updateSessionOperations(owner.request.sessionId, (state) => ({
        ...state,
        informationCancellation: undefined,
      }))
      onErrorNotice(result.error.message)
      void queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.session(owner.request.sessionId),
        exact: true,
      })
      return false
    }
    if (
      result.ok &&
      result.value.disposition === 'cancelled' &&
      result.value.sessionId === owner.request.sessionId &&
      result.value.decisionId === owner.request.decisionId &&
      result.value.clientOperationId === owner.input.clientOperationId &&
      result.value.runId === null &&
      result.value.rebuildId === null
    ) {
      if (owner.declaration) clearCancelledInformation(owner.request.sessionId, owner.declaration)
      const consumer = owner.request.request
      const pending = pendingBySessionRef.current.get(owner.request.sessionId)
      const cancelledSubmission =
        consumer.category === 'necessary_information' &&
        pending?.clientMessageId === consumer.consumer.clientMessageId
          ? pending
          : undefined
      if (cancelledSubmission) {
        pendingBySessionRef.current.delete(owner.request.sessionId)
        cancelledSubmission.inputPreparation?.abort()
      }
      updateSessionOperations(owner.request.sessionId, (state) => ({
        ...state,
        ...(cancelledSubmission
          ? {
              sendingOperationId:
                state.sendingOperationId === cancelledSubmission.operationId
                  ? undefined
                  : state.sendingOperationId,
              error:
                state.error === cancelledSubmission.acknowledgementError ? undefined : state.error,
            }
          : {}),
        informationCancellation: undefined,
        cancelledInformationDecisionId: owner.request.decisionId,
      }))
      void queryClient.invalidateQueries({
        queryKey: conversationQueryKeys.session(owner.request.sessionId),
        exact: true,
      })
      return true
    }
    updateSessionOperations(owner.request.sessionId, (state) => ({
      ...state,
      informationCancellation: {
        ...owner,
        busy: false,
        status: 'receipt_unconfirmed',
        error: result.ok
          ? 'The cancellation receipt does not match. Check this decision before sending again.'
          : 'The cancellation result is not confirmed. Check this decision before sending again.',
      },
    }))
    return false
  }

  const checkInformationCancellation = async (ownerSessionId = sessionId): Promise<boolean> => {
    const owner = ownerSessionId
      ? operationsBySessionRef.current[ownerSessionId]?.informationCancellation
      : undefined
    if (!owner || owner.busy) return false
    updateSessionOperations(owner.request.sessionId, (state) => ({
      ...state,
      informationCancellation: {
        ...owner,
        busy: true,
        status: 'checking_receipt',
        error: undefined,
      },
    }))
    return observeInformationCancellation(
      owner,
      () =>
        window.pact.getRelayDecisionReceipt({
          sessionId: owner.request.sessionId,
          decisionId: owner.request.decisionId,
          clientOperationId: owner.input.clientOperationId,
        }),
      'receipt',
    )
  }

  const cancelPreparedInformation = async (
    raw: import('@pact/contracts').RelaySchedulingDecision,
  ): Promise<boolean> => {
    const parsed = relaySchedulingDecisionSchema.safeParse(raw)
    if (!parsed.success) return false
    const request = parsed.data
    if (request.sessionId !== sessionId || request.request.category !== 'necessary_information')
      return false
    const current = operationsBySessionRef.current[request.sessionId]
    if (
      current?.informationCancellation ||
      current?.cancelledInformationDecisionId === request.decisionId
    )
      return false
    // At most 32 pending operations: one 4 KiB card, one 4 KiB declaration and fixed metadata each.
    if (
      Object.values(operationsBySessionRef.current).filter((state) => state.informationCancellation)
        .length >= INFORMATION_CANCELLATION_ITEMS
    ) {
      onNotice('Resolve a pending cancellation before cancelling another request.')
      return false
    }
    const declaration = composerDraftsRef.current[request.sessionId]?.userInformation,
      field = request.request.field,
      expected =
        declaration?.state.status === 'unanswered' &&
        declaration.id === field.fieldId &&
        declaration.question === field.prompt &&
        declaration.input === field.input.kind &&
        (field.input.kind === 'text' ||
          JSON.stringify(declaration.options) === JSON.stringify(field.input.options))
          ? declaration
          : undefined,
      owner: InformationCancellation = {
        request,
        declaration: expected,
        busy: true,
        status: 'submitting',
        input: {
          reference: {
            sessionId: request.sessionId,
            decisionId: request.decisionId,
            revision: request.revision,
          },
          clientOperationId: crypto.randomUUID(),
          answer: { kind: 'cancel' },
        },
      }
    // Completed markers protect only mounted stale projections; other Session Views unmount.
    clearOtherCancelledInformation(request.sessionId)
    updateSessionOperations(request.sessionId, (state) => ({
      ...state,
      informationCancellation: owner,
    }))
    const confirmed = await observeInformationCancellation(
      owner,
      () => window.pact.answerRelayDecision(owner.input),
      'cancel',
    )
    if (confirmed || !currentInformationCancellation(owner)) return confirmed
    // Only receipt observation follows an uncertain answer; never repeat the mutation or poll.
    return checkInformationCancellation(request.sessionId)
  }

  const send = async (
    composerSnapshot: string,
    commentIds: string[],
    route?: NonNullable<ConversationSendInput['route']>,
    skills?: SkillSelection[],
    decision?: DecisionReplyContext,
    replaceTask?: ConversationSendInput['replaceTask'],
  ): Promise<boolean> => {
    if (
      !sessionId ||
      sending ||
      getReturnOperation()?.sessionId === sessionId ||
      (!decision && operationsBySessionRef.current[sessionId]?.informationCancellation)
    )
      return false
    const original = composerSnapshot.trim()
    const draftAnswers = composerDraftsRef.current[sessionId]?.decisionAnswers
    if (
      decision &&
      hasDecisionAnswers(draftAnswers) &&
      !sameDecision(draftAnswers?.reference, decision.reference)
    ) {
      onNotice(
        'Saved answers belong to an earlier request. Keep them in your message or discard them before answering the current questions.',
      )
      return false
    }
    const answers =
      decision && draftAnswers && sameDecision(draftAnswers.reference, decision.reference)
        ? formatDecisionAnswers(draftAnswers)
        : ''
    if (decision && !answers) return false
    const content = decision ? `**Replies to your questions**\n\n${answers}` : original
    const submissionSkills = decision ? undefined : skills
    const selectedRoute = decision ? undefined : route
    const userInformation = decision
      ? undefined
      : composerDraftsRef.current[sessionId]?.userInformation
    if (userInformation) {
      const validation = userInformationDeclarationSchema.safeParse(userInformation)
      const prefix = parseComposerCommandPrefix(content, submissionSkills)
      if (
        !validation.success ||
        decision ||
        (userInformation &&
          (submissionSkills?.length ||
            selectedRoute?.type === 'all' ||
            prefix.pact ||
            prefix.skills.length ||
            prefix.error ||
            composerDraftsRef.current[sessionId]?.returnedInputOperationId ||
            composerDraftsRef.current[sessionId]?.queueReturnOperationId ||
            composerDraftsRef.current[sessionId]?.images?.length))
      ) {
        onNotice('This saved input cannot be sent in this context. Your draft was kept.')
        return false
      }
    }
    const images = decision ? [] : (composerDraftsRef.current[sessionId]?.images ?? [])
    if (images.some((image) => image.status !== 'ready' || !image.image)) {
      onNotice('Wait for images to finish preparing, or remove an image that could not be added.')
      return false
    }
    const imageIds = images.map((entry) => entry.image!.id)
    const currentRevision = windowRef.current?.view.commentsRevision
    if (currentRevision === undefined) return false
    if (!decision && draftsReadyRevision !== currentRevision) {
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        error: 'Comment drafts are still loading. Try again in a moment.',
      }))
      return false
    }
    const pending = pendingBySessionRef.current.get(sessionId)
    if (
      pending &&
      (JSON.stringify(pending.imageIds) !== JSON.stringify(imageIds) ||
        pending.content !== content ||
        JSON.stringify(pending.userInformation) !== JSON.stringify(userInformation) ||
        JSON.stringify(pending.route) !== JSON.stringify(selectedRoute) ||
        JSON.stringify(pending.skills ?? []) !== JSON.stringify(submissionSkills ?? []) ||
        !sameDecision(pending.replyToDecision, decision?.reference) ||
        pending.askOnly !== undefined ||
        JSON.stringify(pending.replaceTask) !== JSON.stringify(replaceTask))
    ) {
      pending.acknowledgementError =
        'Confirm the previous message before sending different content.'
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        error: 'Confirm the previous message before sending different content.',
      }))
      return false
    }
    const preserved = pending
    const expectedCommentsRevision = preserved?.expectedCommentsRevision ?? currentRevision
    const submissionCommentIds = preserved?.commentIds ?? (decision ? [] : commentIds)
    const submissionRoute = preserved ? preserved.route : selectedRoute
    const clientMessageId = preserved?.clientMessageId ?? crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const currentDocument =
      latestComposerDraft.current?.sessionId === sessionId
        ? latestComposerDraft.current.draft
        : composerDraftsRef.current[sessionId]
    const sourceDocument = preserved?.sourceDocument ??
      currentDocument ?? { text: composerSnapshot }
    const returnedInputOperationId = decision
      ? undefined
      : preserved
        ? preserved.returnedInputOperationId
        : sourceDocument.returnedInputOperationId
    const queueReturnOperationId = decision
      ? undefined
      : preserved
        ? preserved.queueReturnOperationId
        : sourceDocument.queueReturnOperationId
    const routeIntent = preserved
      ? (preserved.routeIntent ?? 'explicit')
      : decision ||
          returnedInputOperationId ||
          queueReturnOperationId ||
          selectedRoute?.type === 'agent' ||
          selectedRoute?.type === 'all' ||
          !currentDocument ||
          currentDocument.text !== composerSnapshot
        ? 'explicit'
        : composerRouteIntent({ ...sourceDocument, skills: sourceDocument.skills ?? [] })
    const frozen: PendingSubmission = {
      kind: decision ? 'decision' : 'message',
      userInformation: decision
        ? undefined
        : (preserved?.userInformation ?? sourceDocument.userInformation),
      sourceDocument,
      imageIds: preserved?.imageIds ?? imageIds,
      inputId: preserved?.inputId,
      composerRevision: preserved
        ? (preserved.composerRevision ?? preserved.sourceDocument.revision ?? 0)
        : (sourceDocument.revision ?? 0),
      routeIntent,
      returnedInputOperationId,
      queueReturnOperationId,
      operationId,
      content,
      composerSnapshot,
      skills: preserved?.skills ?? submissionSkills,
      commentIds: submissionCommentIds,
      expectedCommentsRevision,
      clientMessageId,
      route: submissionRoute,
      replyToDecision: preserved?.replyToDecision ?? decision?.reference,
      replaceTask: preserved?.replaceTask ?? replaceTask,
    }
    if (!admitComposerResidency(composerDraftsRef.current, { sessionId, value: frozen }))
      return false
    pendingBySessionRef.current.set(sessionId, frozen)
    updateSessionOperations(sessionId, (current) => ({
      ...current,
      sendingOperationId: operationId,
      error: undefined,
    }))
    let didSubmit = false
    const sendMetadata = {
      sessionId,
      clientMessageId,
      ...(frozen.returnedInputOperationId
        ? { returnedInputOperationId: frozen.returnedInputOperationId }
        : {}),
      ...(frozen.queueReturnOperationId
        ? { queueReturnOperationId: frozen.queueReturnOperationId }
        : {}),
      expectedCommentsRevision,
      routeIntent: frozen.routeIntent,
      composerRevision: frozen.composerRevision,
      ...(frozen.userInformation ? { userInformation: frozen.userInformation } : {}),
      ...(frozen.replyToDecision ? { replyToDecision: frozen.replyToDecision } : {}),
      ...(frozen.replaceTask ? { replaceTask: frozen.replaceTask } : {}),
      commentIds: [],
      freezeDrafts: frozen.kind !== 'decision' && !frozen.askOnly,
      ...(frozen.askOnly ? { askOnly: frozen.askOnly } : {}),
      batchId: clientMessageId,
      ...(submissionRoute ? { route: submissionRoute } : {}),
      ...(frozen.skills?.length ? { skills: frozen.skills } : {}),
      ...(frozen.imageIds.length ? { imageIds: frozen.imageIds } : {}),
    }
    const inlineBytes =
      bodyTextEncoder.encode(JSON.stringify({ ...sendMetadata, content: '' })).byteLength +
      composerEncodedTextBytes(content)
    try {
      if (!frozen.inputId && inlineBytes > INLINE_INPUT_BYTES) {
        const controller = new AbortController()
        frozen.inputPreparation = controller
        try {
          frozen.inputId = await uploadLargeConversationInput({
            sessionId,
            clientMessageId,
            content,
            controller,
            cancelErrorMessage: 'Sending was cancelled or timed out. Your draft was kept.',
            startErrorMessage: 'Couldn’t start sending this message. Your draft was kept.',
            appendErrorMessage: 'Couldn’t send all of this message. Your draft was kept.',
            sealErrorMessage: 'Couldn’t finish sending this message. Your draft was kept.',
            cancelledCheckErrorMessage: 'Sending was cancelled. Your draft was kept.',
            onInputId: (id) => {
              frozen.inputId = id
            },
            isCurrent: () => pendingBySessionRef.current.get(sessionId) === frozen,
          })
        } finally {
          frozen.inputPreparation = undefined
        }
      }
      didSubmit = true
      const result = await window.pact.sendConversationMessage({
        ...sendMetadata,
        content: frozen.inputId ? '' : content,
        ...(frozen.inputId ? { inputId: frozen.inputId } : {}),
      })
      if (!result.ok) {
        const outstanding = pendingBySessionRef.current.get(sessionId)
        if (outstanding?.operationId !== operationId) return true
        if (result.error.code === 'AGENT_CAPACITY') {
          pendingBySessionRef.current.delete(sessionId)
          onNotice(result.error.message)
          return false
        }
        if (result.error.code === 'NATIVE_CONTEXT_RECOVERY_REQUIRED') {
          pendingBySessionRef.current.delete(sessionId)
          return false
        }
        if (result.error.code === 'NATIVE_CONTEXT_CHECK_FAILED') {
          pendingBySessionRef.current.delete(sessionId)
          onErrorNotice("Pact couldn't check the Agent's Native Session. Your draft is still here.")
          return false
        }
        if (
          result.error.code === 'CONTEXT_TOO_LARGE' ||
          result.error.code === 'CONTEXT_UNAVAILABLE'
        ) {
          pendingBySessionRef.current.delete(sessionId)
          onErrorNotice(
            result.error.code === 'CONTEXT_TOO_LARGE'
              ? 'The full context is too large to send. Your draft is still here.'
              : "Pact couldn't load the required context. Your draft is still here.",
          )
          return false
        }
        if (result.error.code !== 'TIMEOUT' && result.error.code !== 'UNCERTAIN') {
          pendingBySessionRef.current.delete(sessionId)
        }
        outstanding.acknowledgementError = result.error.message
        updateSessionOperations(sessionId, (current) => ({
          ...current,
          error: result.error.message,
        }))
        return false
      }
      // An ok reply from this exact typed Send confirms its durable client-message intent,
      // including when the bounded Patch carries resync instead of the oversized message.
      if (
        result.value.queuedInputIds?.includes(clientMessageId) &&
        !result.value.sessionIssues?.agents.some((issue) => issue.phase === 'background_working') &&
        !result.value.messages.some((item) => item.message.id === clientMessageId)
      )
        onInfoNotice("Your message is queued until the current Agent's work finishes.")
      if (result.value.sessionId === sessionId) {
        if (result.value.sendDisposition === 'held_for_information') {
          if (pendingBySessionRef.current.get(sessionId)?.operationId === operationId)
            pendingBySessionRef.current.delete(sessionId)
        } else settleSubmission(sessionId, clientMessageId)
      }
      cachePatch(result.value)
      return true
    } catch (error) {
      const outstanding = pendingBySessionRef.current.get(sessionId)
      if (outstanding?.operationId !== operationId) return true
      if (!didSubmit) pendingBySessionRef.current.delete(sessionId)
      outstanding.acknowledgementError =
        error instanceof Error ? error.message : 'The message could not be sent.'
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'The message could not be sent.',
      }))
      return false
    } finally {
      if (pendingBySessionRef.current.get(sessionId)?.clientMessageId !== clientMessageId)
        for (const id of frozen.imageIds)
          if (
            !composerDraftsRef.current[sessionId]?.images?.some((entry) => entry.image?.id === id)
          )
            releaseDraftImage(sessionId, id)
      if (
        frozen.inputId &&
        pendingBySessionRef.current.get(sessionId)?.clientMessageId !== clientMessageId
      )
        void window.pact
          .writeConversationInput({ type: 'release', sessionId, inputId: frozen.inputId })
          .catch(() => undefined)
      updateSessionOperations(sessionId, (current) =>
        current.sendingOperationId === operationId
          ? { ...current, sendingOperationId: undefined }
          : current,
      )
    }
  }

  const finalizeSyncedSideChatDraft = (
    ownerSessionId: string,
    draftRevision: number,
    consumedImageIds: readonly string[],
    consumedCommentCount: number,
  ): void => {
    clearSubmittedComposerDraft(ownerSessionId, draftRevision, consumedImageIds)
    for (const id of consumedImageIds) {
      if (
        !composerDraftsRef.current[ownerSessionId]?.images?.some((entry) => entry.image?.id === id)
      ) {
        releaseDraftImage(ownerSessionId, id)
      }
    }
    if (consumedCommentCount > 0 && activeSessionIdRef.current === ownerSessionId) {
      void refetchConversation({ cancelRefetch: false })
      bumpDraftReloadToken()
    }
  }

  const syncToMain = async (
    composerSnapshot: string,
    commentIds: string[],
    skills?: SkillSelection[],
  ): Promise<import('@pact/contracts').SideChatSyncMainReceipt | undefined> => {
    if (
      !sessionId ||
      sending ||
      getReturnOperation()?.sessionId === sessionId ||
      pendingSyncInFlightRef.current.has(sessionId)
    )
      return undefined
    const ownerSessionId = sessionId
    const draft =
      latestComposerDraft.current?.sessionId === ownerSessionId
        ? latestComposerDraft.current.draft
        : composerDraftsRef.current[ownerSessionId]
    const expectedRevision = draft?.revision ?? 0
    const images = draft?.images ?? []
    if (images.some((image) => image.status !== 'ready' || !image.image)) {
      onNotice('Wait for images to finish preparing, or remove an image that could not be added.')
      return undefined
    }
    const imageIds = images.map((entry) => entry.image!.id)
    const content = composerSnapshot.trim()
    const hasDraftComments = commentIds.length > 0 || draftHasMore || draftHasEarlier
    if (content.length === 0 && imageIds.length === 0 && !hasDraftComments) {
      onNotice('Write a message before sending to the main chat.')
      return undefined
    }
    const currentRevision = windowRef.current?.view.commentsRevision
    if (currentRevision === undefined) return undefined
    if (draftsReadyRevision !== currentRevision) {
      updateSessionOperations(ownerSessionId, (current) => ({
        ...current,
        error: 'Comment drafts are still loading. Try again in a moment.',
      }))
      return undefined
    }
    const normalizedSkills = [...(skills ?? [])]
    const currentPayload: Omit<
      PendingSyncMain,
      'operationId' | 'inputPreparation' | 'inputId' | 'contentSha256'
    > = {
      content,
      imageIds: [...imageIds],
      commentIds: [...commentIds],
      skills: normalizedSkills,
      ...(draft?.userInformation ? { userInformation: draft.userInformation } : {}),
      expectedRevision,
      expectedCommentsRevision: currentRevision,
    }
    const preserved = pendingSyncMainRef.current.get(ownerSessionId)
    let activeOperationId = preserved?.operationId ?? crypto.randomUUID()
    let pendingEntry: PendingSyncMain | undefined
    let preparedInputId: string | undefined
    let preparedContentSha256: string | undefined
    let keepRemoteInput = false
    pendingSyncInFlightRef.current.add(ownerSessionId)
    updateSessionOperations(ownerSessionId, (current) => ({
      ...current,
      sendingOperationId: activeOperationId,
      error: undefined,
    }))
    try {
      if (preserved) {
        const verifiedPrevious = await window.pact
          .readSyncSideChatReceipt({ operationId: preserved.operationId })
          .catch(() => undefined)
        if (!verifiedPrevious?.ok) {
          const probeError =
            verifiedPrevious?.error?.message ??
            'Could not verify whether your previous message finished sending. Try again.'
          if (!sameSyncMainPayload(preserved, currentPayload)) {
            onErrorNotice(probeError)
            updateSessionOperations(ownerSessionId, (current) => ({
              ...current,
              error: probeError,
            }))
            return undefined
          }
          preparedInputId = preserved.inputId
          preparedContentSha256 = preserved.contentSha256
        } else if (verifiedPrevious.value) {
          if (pendingSyncMainRef.current.get(ownerSessionId) === preserved) {
            pendingSyncMainRef.current.delete(ownerSessionId)
          }
          if (preserved.inputId) releasePreparedInput(ownerSessionId, preserved.inputId)
          finalizeSyncedSideChatDraft(
            ownerSessionId,
            preserved.expectedRevision,
            preserved.imageIds,
            Math.max(1, preserved.commentIds.length),
          )
          if (sameSyncMainPayload(preserved, currentPayload)) {
            return verifiedPrevious.value
          }
          onNotice(
            'Your previous message was already sent to the main chat. Send again if you also want to send your edits.',
          )
          return undefined
        } else if (!sameSyncMainPayload(preserved, currentPayload)) {
          if (pendingSyncMainRef.current.get(ownerSessionId) === preserved) {
            pendingSyncMainRef.current.delete(ownerSessionId)
          }
          if (preserved.inputId) releasePreparedInput(ownerSessionId, preserved.inputId)
          activeOperationId = crypto.randomUUID()
          updateSessionOperations(ownerSessionId, (current) => ({
            ...current,
            sendingOperationId: activeOperationId,
          }))
        } else {
          preparedInputId = preserved.inputId
          preparedContentSha256 = preserved.contentSha256
        }
      }
      if (
        !pendingSyncMainRef.current.has(ownerSessionId) &&
        pendingSyncMainRef.current.size >= MAX_PENDING_SYNC_MAIN_SESSIONS
      ) {
        for (const [candidateSessionId, candidateEntry] of pendingSyncMainRef.current.entries()) {
          // oxlint-disable-next-line no-await-in-loop -- Settle or discard one confirmed completed pending sync-back before admitting another.
          const candidateStatus = await window.pact
            .readSyncSideChatReceipt({ operationId: candidateEntry.operationId })
            .catch(() => undefined)
          if (!candidateStatus?.ok) continue
          if (pendingSyncMainRef.current.get(candidateSessionId) === candidateEntry) {
            pendingSyncMainRef.current.delete(candidateSessionId)
          }
          if (candidateEntry.inputId) {
            releasePreparedInput(candidateSessionId, candidateEntry.inputId)
          }
          if (candidateStatus.value) {
            finalizeSyncedSideChatDraft(
              candidateSessionId,
              candidateEntry.expectedRevision,
              candidateEntry.imageIds,
              Math.max(1, candidateEntry.commentIds.length),
            )
          }
          break
        }
        if (pendingSyncMainRef.current.size >= MAX_PENDING_SYNC_MAIN_SESSIONS) {
          const capacityMessage =
            'Too many side chats have unconfirmed messages waiting for verification. Retry or wait for one to finish.'
          onErrorNotice(capacityMessage)
          updateSessionOperations(ownerSessionId, (current) => ({
            ...current,
            error: capacityMessage,
          }))
          return undefined
        }
      }
      pendingEntry = {
        ...currentPayload,
        operationId: activeOperationId,
        ...(preparedInputId ? { inputId: preparedInputId } : {}),
        ...(preparedContentSha256 ? { contentSha256: preparedContentSha256 } : {}),
      }
      pendingSyncMainRef.current.set(ownerSessionId, pendingEntry)

      const syncMetadata = {
        operationId: activeOperationId,
        sideChatId: ownerSessionId,
        imageIds,
        commentIds,
        skills: normalizedSkills,
        ...(draft?.userInformation ? { userInformation: draft.userInformation } : {}),
        expectedCommentsRevision: currentRevision,
      }
      const encodedContentBytes = bodyTextEncoder.encode(content).byteLength
      const inlineBytes =
        bodyTextEncoder.encode(JSON.stringify({ ...syncMetadata, content: '' })).byteLength +
        encodedContentBytes
      const needsSealedInput =
        content.length > 0 &&
        (encodedContentBytes > INLINE_INPUT_BYTES || inlineBytes > INLINE_INPUT_BYTES)
      if (needsSealedInput && (!preparedInputId || !preparedContentSha256)) {
        const controller = new AbortController()
        pendingEntry.inputPreparation = controller
        try {
          preparedInputId = await uploadLargeConversationInput({
            sessionId: ownerSessionId,
            clientMessageId: activeOperationId,
            content,
            controller,
            cancelErrorMessage: 'Sending was cancelled or timed out. Your draft was kept.',
            startErrorMessage: 'Couldn’t start sending this message. Your draft was kept.',
            appendErrorMessage: 'Couldn’t send all of this message. Your draft was kept.',
            sealErrorMessage: 'Couldn’t finish sending this message. Your draft was kept.',
            cancelledCheckErrorMessage: 'Sending was cancelled. Your draft was kept.',
            onInputId: (id) => {
              preparedInputId = id
              if (pendingEntry) pendingEntry.inputId = id
            },
            isCurrent: () => pendingSyncMainRef.current.get(ownerSessionId) === pendingEntry,
          })
        } finally {
          pendingEntry.inputPreparation = undefined
        }
        preparedContentSha256 = await sha256Hex(content)
        pendingEntry.contentSha256 = preparedContentSha256
        if (
          controller.signal.aborted ||
          pendingSyncMainRef.current.get(ownerSessionId) !== pendingEntry
        ) {
          throw new Error('Sending was cancelled. Your draft was kept.')
        }
      }

      keepRemoteInput = Boolean(preparedInputId)
      const result = await window.pact.syncSideChatToMain({
        ...syncMetadata,
        ...(preparedInputId && preparedContentSha256
          ? { content: '', inputId: preparedInputId, contentSha256: preparedContentSha256 }
          : { content }),
      })
      let receipt: import('@pact/contracts').SideChatSyncMainReceipt | undefined
      let uncertainOutcome = false
      if (result.ok) {
        receipt = result.value
      } else if (result.error.code === 'TIMEOUT' || result.error.code === 'UNCERTAIN') {
        const verified = await window.pact
          .readSyncSideChatReceipt({ operationId: activeOperationId })
          .catch(() => undefined)
        if (verified?.ok && verified.value) {
          receipt = verified.value
        } else {
          uncertainOutcome = true
        }
      }
      if (!receipt) {
        if (!uncertainOutcome && pendingSyncMainRef.current.get(ownerSessionId) === pendingEntry) {
          pendingSyncMainRef.current.delete(ownerSessionId)
          keepRemoteInput = false
        }
        const message = result.ok
          ? 'The message could not be sent to the main chat.'
          : result.error.message
        onErrorNotice(message)
        updateSessionOperations(ownerSessionId, (current) => ({
          ...current,
          error: message,
        }))
        return undefined
      }
      if (pendingSyncMainRef.current.get(ownerSessionId) === pendingEntry) {
        pendingSyncMainRef.current.delete(ownerSessionId)
      }
      keepRemoteInput = false
      finalizeSyncedSideChatDraft(
        ownerSessionId,
        expectedRevision,
        imageIds,
        hasDraftComments ? Math.max(1, commentIds.length) : 0,
      )
      return receipt
    } catch (error) {
      const uncertainError =
        error instanceof RpcError && (error.code === 'TIMEOUT' || error.code === 'UNCERTAIN')
      if (!uncertainError) {
        if (pendingEntry && pendingSyncMainRef.current.get(ownerSessionId) === pendingEntry) {
          pendingSyncMainRef.current.delete(ownerSessionId)
        }
        keepRemoteInput = false
      }
      const message =
        error instanceof Error ? error.message : 'The message could not be sent to the main chat.'
      onErrorNotice(message)
      updateSessionOperations(ownerSessionId, (current) => ({
        ...current,
        error: message,
      }))
      return undefined
    } finally {
      pendingSyncInFlightRef.current.delete(ownerSessionId)
      if (preparedInputId && !keepRemoteInput) {
        void window.pact
          .writeConversationInput({
            type: 'release',
            sessionId: ownerSessionId,
            inputId: preparedInputId,
          })
          .catch(() => undefined)
      }
      updateSessionOperations(ownerSessionId, (current) =>
        current.sendingOperationId === activeOperationId
          ? { ...current, sendingOperationId: undefined }
          : current,
      )
    }
  }

  const refreshConflictedDrafts = async (ownerSessionId: string): Promise<void> => {
    if (activeSessionIdRef.current !== ownerSessionId || !projectionActiveRef.current) return
    setDraftsReadyRevision(undefined)
    // A read started before the rejected save may itself contain the stale revision.
    // Cancel that observation and obtain a new authoritative page after the conflict.
    const result = await refetchConversation({ cancelRefetch: true })
    if (activeSessionIdRef.current !== ownerSessionId || !projectionActiveRef.current) return
    bumpDraftReloadToken()
    if (result.isError)
      throw new Error('Comment drafts could not be refreshed. Your input is kept.')
  }

  const saveCommentDraft = async (
    input: CommentDraftInputWithoutRevision,
  ): Promise<CommentDraftSaveOutcome> => {
    if (!sessionId || input.sessionId !== sessionId || sending) return false
    const expectedCommentsRevision = windowRef.current?.view.commentsRevision
    if (expectedCommentsRevision === undefined) return false
    updateSessionOperations(sessionId, (current) => ({ ...current, error: undefined }))
    try {
      const patch = unwrapRpcResult(
        await window.pact.saveCommentDraft({ ...input, expectedCommentsRevision }),
      )
      cachePatch(patch)
      return patch.commentDraftReceipt?.commentId ?? false
    } catch (error) {
      if (error instanceof RpcError && error.code === 'CONFLICT') {
        let message = 'Comment drafts refreshed. Your input is kept; review it and add again.'
        try {
          await refreshConflictedDrafts(input.sessionId)
        } catch (refreshError) {
          message = refreshError instanceof Error ? refreshError.message : 'Comment refresh failed.'
        }
        updateSessionOperations(input.sessionId, (current) => ({ ...current, error: message }))
        return { conflict: true }
      }
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'The Comment draft could not be saved.',
      }))
      return false
    }
  }

  const removeCommentDraft = async (commentId: string): Promise<boolean> => {
    if (!sessionId || sending) return false
    const expectedCommentsRevision = windowRef.current?.view.commentsRevision
    if (expectedCommentsRevision === undefined) return false
    updateSessionOperations(sessionId, (current) => ({ ...current, error: undefined }))
    try {
      const patch = unwrapRpcResult(
        await window.pact.removeCommentDraft({ sessionId, commentId, expectedCommentsRevision }),
      )
      cachePatch(patch)
      return true
    } catch (error) {
      if (error instanceof RpcError && error.code === 'CONFLICT') {
        let message = 'Comment drafts refreshed. Review the updated draft before removing it.'
        try {
          await refreshConflictedDrafts(sessionId)
        } catch (refreshError) {
          message = refreshError instanceof Error ? refreshError.message : 'Comment refresh failed.'
        }
        updateSessionOperations(sessionId, (current) => ({ ...current, error: message }))
        return false
      }
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        error: error instanceof Error ? error.message : 'The Comment draft could not be removed.',
      }))
      return false
    }
  }

  const inspectNativeContext = async (runId: string, agentId: RuntimeAgentId): Promise<boolean> => {
    if (!sessionId || checkingNativeTargetId) return false
    const operationId = crypto.randomUUID()
    updateSessionOperations(sessionId, (current) => ({
      ...current,
      nativeCheck: { operationId, runId },
    }))
    try {
      cachePatch(
        unwrapRpcResult(
          await window.pact.retryConversationRun(runId, { intent: 'inspect', sessionId, agentId }),
        ),
      )
      return true
    } catch (error) {
      if (error instanceof RpcError && error.code === 'NATIVE_CONTEXT_RECOVERY_REQUIRED')
        return false
      throw error
    } finally {
      updateSessionOperations(sessionId, (current) =>
        current.nativeCheck?.operationId === operationId
          ? { ...current, nativeCheck: undefined }
          : current,
      )
    }
  }

  const undoWorkspaceChanges = async (changeSetId: string, path?: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await window.pact.undoWorkspaceChanges({
        changeSetId,
        ...(path !== undefined ? { path } : {}),
      })
      if (!result.ok) {
        onNotice(result.error.message)
        return false
      }
      cachePatch(result.value)
      return true
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Undo could not finish.')
      return false
    }
  }

  const respondNativePermission = async (
    runId: string,
    permissionId: string,
    decision: import('@pact/contracts').NativePermissionDecision,
  ): Promise<boolean> => {
    try {
      const result = await window.pact.respondNativePermission({
        operationId: runId,
        permissionId,
        decision,
      })
      if (!result.ok) {
        onNotice(result.error.message)
        return false
      }
      cachePatch(result.value)
      return true
    } catch {
      onNotice('The permission decision could not be delivered. Nothing was approved.')
      return false
    }
  }

  const respondNativeInput = async (
    input: import('@pact/contracts').NativeInputRespond,
  ): Promise<boolean> => {
    try {
      const result = await window.pact.respondNativeInput(input)
      if (!result.ok) {
        onNotice(result.error.message)
        return false
      }
      cachePatch(result.value)
      return true
    } catch {
      onNotice('The native response could not be delivered.')
      return false
    }
  }

  const checkNativeContext = (agentId: RuntimeAgentId, runId?: string): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false)
    if (runId) return inspectNativeContext(runId, agentId)
    const current = windowRef.current
    const context = current?.view.nativeContexts.find((item) => item.agentId === agentId)
    const matching = context
      ? current?.view.runs.filter(
          (item) =>
            item.agentId === agentId &&
            item.controlDisposition !== 'abandoned' &&
            item.nativeSessionId === context.nativeSessionId &&
            item.bindingGeneration === context.bindingGeneration,
        )
      : undefined
    const run = matching?.find((item) => item.id === context?.lastRunId) ?? matching?.at(-1)
    return inspectNativeContext(run?.id ?? sessionId, agentId)
  }

  const checkQueuedDelivery = async (): Promise<boolean> => {
    const entry = windowRef.current?.view.queue?.input
    if (!entry?.delivery || entry.recipient === 'all') return false
    try {
      const checked = await inspectNativeContext(entry.delivery.runId, entry.recipient)
      if (!checked || windowRef.current?.view.queue?.input?.id === entry.id) {
        onNotice('The original delivery is still unconfirmed. Nothing was resent.')
        return false
      }
      return true
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : 'The original delivery could not be checked.',
      )
      return false
    }
  }

  const rebuildNativeContext = async (
    agentId: RuntimeAgentId,
    options?: Omit<NativeContextRebuildInput, 'sessionId' | 'agentId'>,
  ): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await window.pact.rebuildNativeContext({ sessionId, agentId, ...options })
      if (!result.ok && result.error.code === 'NATIVE_CONTEXT_RECOVERY_REQUIRED') return false
      const patch = unwrapRpcResult(result)
      cachePatch(patch)
      return true
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error(
            'The Native Session rebuild request could not be delivered. The binding was kept.',
          )
    }
  }

  const performQueueAction = async (
    action: 'steer' | 'remove' | 'resume' | 'enabled',
    enabled?: boolean,
  ): Promise<boolean> => {
    const queue = windowRef.current?.view.queue
    if (
      !sessionId ||
      !queue ||
      queueOperation.current ||
      getReturnOperation() ||
      (action !== 'enabled' && !queue.input)
    )
      return false
    const operationId = crypto.randomUUID()
    const owner = { sessionId, operationId, controller: new AbortController() }
    queueOperation.current = owner
    updateSessionOperations(sessionId, (current) => ({ ...current, queueOperationId: operationId }))
    const timer = window.setTimeout(() => owner.controller.abort(), 10_000)
    try {
      const input: ConversationQueueActionInput = {
        sessionId,
        inputId: queue.input?.id ?? crypto.randomUUID(),
        expectedRevision: queue.revision,
        operationId,
      }
      const request =
        action === 'steer'
          ? window.pact.steerQueuedConversationMessage(input)
          : action === 'remove'
            ? window.pact.removeQueuedConversationMessage(input)
            : action === 'resume'
              ? window.pact.resumeConversationQueue(input)
              : window.pact.setConversationQueueEnabled({
                  sessionId,
                  enabled: enabled ?? true,
                  expectedRevision: queue.revision,
                  operationId,
                })
      const result = await new Promise<Awaited<typeof request>>((resolve, reject) => {
        const abort = () =>
          reject(
            new Error(
              'The queue action could not be confirmed. Check its status before trying again.',
            ),
          )
        owner.controller.signal.addEventListener('abort', abort, { once: true })
        if (owner.controller.signal.aborted) abort()
        void request
          .then(resolve, reject)
          .finally(() => owner.controller.signal.removeEventListener('abort', abort))
      })
      if (owner.controller.signal.aborted) return false
      cachePatch(unwrapRpcResult(result))
      return true
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        onNotice(
          error instanceof Error ? error.message : 'The queue action could not be confirmed.',
        )
        void refetchConversation({ cancelRefetch: false })
      }
      return false
    } finally {
      window.clearTimeout(timer)
      if (queueOperation.current === owner) queueOperation.current = undefined
      updateSessionOperations(sessionId, (current) =>
        current.queueOperationId === operationId
          ? { ...current, queueOperationId: undefined }
          : current,
      )
    }
  }

  const returnQueuedInputToComposer = async (fromQueue: boolean): Promise<boolean> => {
    const current = windowRef.current
    const queue = current?.view.queue
    if (
      !sessionId ||
      current?.view.sessionId !== sessionId ||
      !queue ||
      getReturnOperation() ||
      queueOperation.current ||
      pendingBySessionRef.current.has(sessionId) ||
      (fromQueue && (!queue.input || ['dispatching', 'unknown'].includes(queue.input.state))) ||
      (!fromQueue && !queue.returnedInput)
    )
      return false
    const draft = composerDraftsRef.current[sessionId] ?? { text: '' }
    const operationId = fromQueue ? crypto.randomUUID() : queue.returnedInput!.operationId
    const inputId = fromQueue ? queue.input!.id : queue.returnedInput!.inputId
    const expectedRevision = fromQueue ? queue.revision : queue.returnedInput!.expectedRevision
    const commentsRevision = current.view.commentsRevision
    const returned = queue.returnedInput
    const replay =
      !fromQueue &&
      returned?.state === 'installed' &&
      returned.installedCommentsRevision === commentsRevision
    if (replay && !returned.claimId) {
      onNotice('The original restoration receipt is unavailable. Your current draft was kept.')
      return false
    }
    const claimId = replay
      ? returned.claimId!
      : fromQueue || returned?.state !== 'installed'
        ? operationId
        : crypto.randomUUID()
    const owner: ReturnedInputRead = { sessionId, controller: new AbortController() }
    setReturnOperation(owner)
    setRestoringInput(true)
    const timeout = window.setTimeout(() => owner.controller.abort(), 10_000)
    const bounded = async <T>(task: Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const abort = () =>
          reject(
            new Error(
              'Returning the message was cancelled or timed out. The message remains available to restore.',
            ),
          )
        owner.controller.signal.addEventListener('abort', abort, { once: true })
        if (owner.controller.signal.aborted) abort()
        void task
          .then(resolve, reject)
          .finally(() => owner.controller.signal.removeEventListener('abort', abort))
      })
    let installed = false
    try {
      if (fromQueue) {
        const patch = unwrapRpcResult(
          await bounded(
            window.pact.returnQueuedConversationMessage({
              sessionId,
              inputId,
              operationId,
              expectedRevision,
              phase: 'return',
            }),
          ),
        )
        if (patch.queue?.returnedInput?.operationId !== operationId)
          throw new Error(
            'The returned message could not be confirmed. Refresh its status before restoring it.',
          )
        cachePatch(patch)
      }
      let chars = 0,
        offset = 0,
        afterPosition: number | undefined,
        first = true
      let restoredImages: ConversationImage[] = [],
        restoredSkills: SkillSelection[] = []
      let restoredRoute: import('@pact/contracts').ConversationMessageRoute | undefined
      const chunks: string[] = []
      while (true) {
        if (owner.controller.signal.aborted)
          throw new Error('Message restoration was cancelled or timed out.')
        const page: ConversationPage = unwrapRpcResult(
          // oxlint-disable-next-line no-await-in-loop -- Body and Comment cursors advance together under one ten-second owner.
          await bounded(
            window.pact.getConversation({
              scope: 'queued-input',
              source: 'returned',
              sessionId,
              inputId,
              operationId,
              offset,
              ...(afterPosition === undefined ? {} : { commentsAfterPosition: afterPosition }),
            }),
          ),
        )
        if (
          page.scope !== 'queued-input' ||
          page.sessionId !== sessionId ||
          page.source !== 'returned' ||
          page.inputId !== inputId ||
          page.operationId !== operationId ||
          page.offset !== offset ||
          page.nextOffset !== offset + page.text.length ||
          (page.hasMore && (!page.text || page.nextOffset <= offset))
        )
          throw new Error('The returned message changed or could not load. Try restoring it again.')
        if (first) {
          restoredImages = page.images ?? []
          restoredSkills = page.skills ?? []
          restoredRoute = page.route
          first = false
        } else if (JSON.stringify(restoredRoute) !== JSON.stringify(page.route)) {
          throw new Error('The returned message routing changed while loading.')
        }
        chars += page.text.length
        assertComposerEditLengths(draft.text.length, chars)
        chunks.push(page.text)
        offset = page.nextOffset
        for (const comment of page.comments) {
          if (afterPosition !== undefined && comment.position <= afterPosition)
            throw new Error('The returned Comments did not advance.')
          afterPosition = comment.position
        }
        if (
          page.commentsNextPosition !== null &&
          (!page.comments.length || page.commentsNextPosition !== afterPosition)
        )
          throw new Error('The returned Comment cursor did not advance.')
        if (!page.hasMore && page.commentsNextPosition === null) break
      }
      if (
        owner.controller.signal.aborted ||
        getReturnOperation() !== owner ||
        activeSessionIdRef.current !== sessionId ||
        (composerDraftsRef.current[sessionId]?.revision ?? 0) !== (draft.revision ?? 0)
      )
        return false
      const restoredDraft: ConversationComposerDraft = {
        text: chunks.join(''),
        revision: (draft.revision ?? 0) + 1,
        queueReturnOperationId: operationId,
        skills: restoredSkills,
        route: restoredRoute,
        images: restoredImages.map((image) => ({
          id: image.id,
          name: image.name,
          status: 'ready',
          image,
        })),
      }
      owner.draft = restoredDraft
      if (!admitComposerResidency({ ...composerDraftsRef.current, [sessionId]: restoredDraft }))
        return false
      const fresh = windowRef.current
      if (
        fresh?.view.sessionId !== sessionId ||
        fresh.view.queue?.returnedInput?.operationId !== operationId ||
        fresh.view.commentsRevision !== commentsRevision
      )
        throw new Error('The returned message or Comment drafts changed while loading.')
      const patch = unwrapRpcResult(
        await bounded(
          window.pact.returnQueuedConversationMessage({
            sessionId,
            inputId,
            operationId,
            expectedRevision,
            phase: 'claim',
            claimId,
            expectedCommentsRevision: commentsRevision,
          }),
        ),
      )
      const receipt = patch.queue?.returnedInput
      if (
        receipt?.operationId !== operationId ||
        receipt.claimId !== claimId ||
        receipt.state !== 'installed' ||
        receipt.installedCommentsRevision === undefined
      )
        throw new Error('The original restoration could not be confirmed. Your draft was kept.')
      cachePatch(patch)
      if (
        owner.controller.signal.aborted ||
        getReturnOperation() !== owner ||
        activeSessionIdRef.current !== sessionId ||
        windowRef.current?.view.commentsRevision !== receipt.installedCommentsRevision ||
        (composerDraftsRef.current[sessionId]?.revision ?? 0) !== (draft.revision ?? 0)
      )
        return false
      installed = putComposerDraft(sessionId, restoredDraft)
      if (!installed) return false
      for (const [id, upload] of imageUploads.current) {
        if (upload.sessionId !== sessionId) continue
        upload.controller.abort()
        imageUploads.current.delete(id)
      }
      imageChoosers.current.get(sessionId)?.abort()
      imageChoosers.current.delete(sessionId)
      updateSessionOperations(sessionId, (value) => ({ ...value, choosingImages: false }))
      const restoredImageIds = new Set(restoredImages.map((image) => image.id))
      for (const image of draft.images ?? [])
        if (image.image && !restoredImageIds.has(image.image.id))
          releaseDraftImage(sessionId, image.image.id)
      return installed
    } catch (error) {
      if (activeSessionIdRef.current === sessionId) {
        onNotice(
          error instanceof Error
            ? error.message
            : 'The returned message remains available to restore.',
        )
        void refetchConversation({ cancelRefetch: false })
      }
      return false
    } finally {
      window.clearTimeout(timeout)
      if (getReturnOperation() === owner) {
        setReturnOperation(undefined)
        releaseSupersededQueueReturn(windowRef.current)
        setRestoringInput(false)
        if (!installed) {
          const value = composerDraftsRef.current[sessionId]
          const failed = value?.images?.some(
            (image) => image.status === 'preparing' && !imageUploads.current.has(image.id),
          )
          if (failed)
            putComposerDraft(sessionId, {
              ...value!,
              revision: (value?.revision ?? 0) + 1,
              images: value!.images?.map((image) =>
                image.status === 'preparing' && !imageUploads.current.has(image.id)
                  ? Object.assign({}, image, {
                      status: 'failed',
                      error: 'Image upload was cancelled. Remove it and try again.',
                    })
                  : image,
              ),
            })
        }
      }
    }
  }

  const restoreReturnedInput = useCallback(
    async (automatic = false): Promise<boolean> => {
      const current = windowRef.current,
        recovery = current?.view.rebuildInputRecovery
      if (
        !sessionId ||
        current?.view.sessionId !== sessionId ||
        !recovery ||
        getReturnOperation() ||
        pendingBySessionRef.current.has(sessionId)
      )
        return false
      const draft = composerDraftsBySession[sessionId]
      if (draft?.queueReturnOperationId) return false
      const attempt = `${sessionId}:${recovery.operationId}`
      if (
        automatic &&
        (draft?.returnedInputOperationId === recovery.operationId ||
          returnAttempt.current === attempt)
      )
        return false
      if (
        hasDecisionAnswers(draft?.decisionAnswers) ||
        draft?.images?.length ||
        draft?.text ||
        draft?.mention ||
        draftsReadyRevision !== current.view.commentsRevision ||
        recovery.draftEligibility?.commentsRevision !== current.view.commentsRevision ||
        !recovery.draftEligibility.canRestore
      )
        return false
      const context = current.view.nativeContexts.find((item) => item.agentId === recovery.agentId)
      if (
        context?.bindingGeneration !== recovery.bindingGeneration ||
        context.continuationState !== 'ready'
      )
        return false
      if (automatic) returnAttempt.current = attempt
      const owner: ReturnedInputRead = {
        sessionId,
        controller: new AbortController(),
      }
      setReturnOperation(owner)
      setRestoringInput(true)
      const timeout = setTimeout(() => owner.controller.abort(), 10_000)
      const bounded = async <T>(task: Promise<T>): Promise<T> =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new Error('Input restoration was cancelled or timed out.'))
          owner.controller.signal.addEventListener('abort', abort, { once: true })
          if (owner.controller.signal.aborted) abort()
          void task
            .then(resolve, reject)
            .finally(() => owner.controller.signal.removeEventListener('abort', abort))
        })
      try {
        let restoredImages: ConversationImage[] = []
        let restoredSkills: SkillSelection[] = []
        let restoredRoute: import('@pact/contracts').ConversationMessageRoute | undefined
        let explicitReturnedTarget = false
        let chars = 0,
          offset = 0
        const chunks: string[] = []
        let first = true
        while (true) {
          if (owner.controller.signal.aborted)
            throw new Error('Input restoration was cancelled or timed out.')
          const page = unwrapRpcResult(
            // oxlint-disable-next-line no-await-in-loop -- Original input parts are ordered and share one ten-second owner.
            await bounded(
              window.pact.getConversation({
                scope: 'rebuild-input',
                sessionId,
                operationId: recovery.operationId,
                offset,
              }),
            ),
          )
          if (
            page.scope !== 'rebuild-input' ||
            page.operationId !== recovery.operationId ||
            page.messageId !== recovery.messageId ||
            page.nextOffset < offset ||
            (page.hasMore && (page.nextOffset === offset || !page.text))
          )
            throw new Error('Invalid returned input page.')
          if (first) {
            restoredImages = page.images ?? []
            restoredSkills = page.skills ?? []
            restoredRoute = page.route
            explicitReturnedTarget = page.route.type !== 'primary'
            first = false
          }
          chars += page.text.length
          assertComposerEditLengths(draft?.text.length ?? 0, chars)
          chunks.push(page.text)
          offset = page.nextOffset
          if (!page.hasMore) break
        }
        const text = chunks.join('')
        if (
          owner.controller.signal.aborted ||
          getReturnOperation() !== owner ||
          activeSessionIdRef.current !== sessionId
        )
          return false
        const latest = composerDraftsRef.current[sessionId]
        if (
          (latest?.revision ?? 0) !== (draft?.revision ?? 0) ||
          latest?.text ||
          latest?.mention ||
          latest?.images?.length ||
          hasDecisionAnswers(latest?.decisionAnswers)
        )
          return false
        let restoredMention: ConversationComposerMention | undefined
        if (explicitReturnedTarget && restoredRoute && restoredRoute.type !== 'primary') {
          const token =
            restoredRoute.type === 'all'
              ? '@all'
              : restoredRoute.agentId === 'codex'
                ? '@codex'
                : restoredRoute.agentId === 'agy'
                  ? '@agy'
                  : '@claude'
          let candidate: RegExpExecArray | undefined,
            ambiguous = false
          for (const entry of text.matchAll(/(?:^|\s)(@(claude|codex|agy|all))(?=\s|$)/gu)) {
            if (entry[1] !== token) continue
            if (candidate) {
              ambiguous = true
              break
            }
            candidate = entry
          }
          if (candidate && !ambiguous) {
            const start = candidate.index + candidate[0].length - token.length
            restoredMention = {
              route: restoredRoute.type === 'all' ? { type: 'all' } : restoredRoute,
              token,
              start,
              end: start + token.length,
            }
          }
        }
        const restoredDraft: ConversationComposerDraft = {
          text,
          revision: (latest?.revision ?? 0) + 1,
          returnedInputOperationId: recovery.operationId,
          skills: restoredSkills,
          images: restoredImages.map((image) => ({
            id: image.id,
            name: image.name,
            status: 'ready',
            image,
          })),
          route: restoredRoute,
          mention: restoredMention,
        }
        if (!admitComposerResidency({ ...composerDraftsRef.current, [sessionId]: restoredDraft }))
          return false
        owner.draft = restoredDraft
        const patch = unwrapRpcResult(
          await bounded(
            window.pact.rebuildNativeContext({
              sessionId,
              agentId: recovery.agentId,
              intent: 'claim_input',
              expectedRebuildId: recovery.operationId,
              expectedGeneration: recovery.bindingGeneration,
              expectedCommentsRevision: current.view.commentsRevision,
            }),
          ),
        )
        if (
          owner.controller.signal.aborted ||
          getReturnOperation() !== owner ||
          activeSessionIdRef.current !== sessionId
        )
          return false
        cachePatch(patch)
        const value = composerDraftsRef.current[sessionId]
        if (
          (value?.revision ?? 0) !== (draft?.revision ?? 0) ||
          value?.text ||
          value?.mention ||
          value?.images?.length ||
          hasDecisionAnswers(value?.decisionAnswers)
        )
          return false
        return putComposerDraft(sessionId, restoredDraft)
      } catch (error) {
        if (!owner.controller.signal.aborted)
          onNotice(
            error instanceof Error
              ? error.message
              : 'The previous input remains available to restore.',
          )
        return false
      } finally {
        clearTimeout(timeout)
        if (getReturnOperation() === owner) {
          setReturnOperation(undefined)
          setRestoringInput(false)
        }
      }
    },
    [
      sessionId,
      composerDraftsBySession,
      draftsReadyRevision,
      cachePatch,
      onNotice,
      admitComposerResidency,
      putComposerDraft,
      windowRef,
      getReturnOperation,
      setReturnOperation,
      pendingBySessionRef,
      activeSessionIdRef,
      composerDraftsRef,
    ],
  )

  const recovery =
    windowState?.view.sessionId === sessionId ? windowState?.view.rebuildInputRecovery : undefined
  useEffect(() => {
    if (
      !recovery ||
      composer ||
      composerMention ||
      composerImages.length ||
      hasDecisionAnswers(composerDraft?.decisionAnswers) ||
      !visible
    )
      return
    if (draftsReadyRevision !== windowState?.view.commentsRevision) return
    void restoreReturnedInput(true)
  }, [
    recovery,
    composerDraft?.decisionAnswers,
    composer,
    composerMention,
    composerImages.length,
    visible,
    draftsReadyRevision,
    windowState?.view.commentsRevision,
    restoreReturnedInput,
  ])

  useEffect(() => {
    const ownerSession = sessionId
    return () => {
      const current = getReturnOperation()
      if (current && current.sessionId === ownerSession) {
        current.controller.abort()
        setReturnOperation(undefined)
        setRestoringInput(false)
      }
      const queueOwner = queueOperation.current
      if (queueOwner && queueOwner.sessionId === ownerSession) {
        queueOwner.controller.abort()
        queueOperation.current = undefined
      }
    }
  }, [sessionId, getReturnOperation, setReturnOperation])

  const discardReturnedInput = async (): Promise<boolean> => {
    if (!sessionId || !recovery || getReturnOperation()) return false
    try {
      cachePatch(
        unwrapRpcResult(
          await window.pact.rebuildNativeContext({
            sessionId,
            agentId: recovery.agentId,
            intent: 'discard_input',
            expectedRebuildId: recovery.operationId,
          }),
        ),
      )
      return true
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Input recovery is still available.')
      return false
    }
  }

  const stop = async (
    background?: import('@pact/contracts').BackgroundStopTarget,
  ): Promise<boolean> => {
    if (!sessionId || stopping) return false
    const preparing =
      pendingBySessionRef.current.get(sessionId)?.inputPreparation ??
      pendingSyncMainRef.current.get(sessionId)?.inputPreparation
    if (preparing && !background) {
      preparing.abort()
      return true
    }
    const operationId = crypto.randomUUID()
    updateSessionOperations(sessionId, (current) => ({
      ...current,
      stoppingOperationId: operationId,
      error: undefined,
    }))
    try {
      const result = await window.pact.stopConversation({
        sessionId,
        ...(background ? { background } : {}),
      })
      if (!result.ok) {
        updateSessionOperations(sessionId, (current) => ({
          ...current,
          stoppingOperationId: undefined,
          error: result.error.message,
        }))
        return false
      }
      cachePatch(result.value)
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        stoppingOperationId: undefined,
      }))
      return true
    } catch (error) {
      updateSessionOperations(sessionId, (current) => ({
        ...current,
        stoppingOperationId: undefined,
        error: error instanceof Error ? error.message : 'The Run could not be stopped.',
      }))
      return false
    }
  }

  const acceptPeerProposal = async (proposalId: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await window.pact.acceptPeerProposal({
        sessionId,
        proposalId,
        clientMessageId: crypto.randomUUID(),
      })
      if (!result.ok) {
        if (result.error.code === 'AGENT_CAPACITY') onNotice(result.error.message)
        else if (result.error.code !== 'NATIVE_CONTEXT_RECOVERY_REQUIRED')
          onErrorNotice(result.error.message)
        return false
      }
      cachePatch(result.value)
      return true
    } catch (error) {
      onErrorNotice(error instanceof Error ? error.message : 'The peer request could not start.')
      return false
    }
  }

  const dismissPeerProposal = async (proposalId: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await window.pact.dismissPeerProposal({ sessionId, proposalId })
      if (!result.ok) {
        if (result.error.code !== 'NATIVE_CONTEXT_RECOVERY_REQUIRED')
          onErrorNotice(result.error.message)
        return false
      }
      cachePatch(result.value)
      return true
    } catch (error) {
      onErrorNotice(error instanceof Error ? error.message : 'The peer request could not dismiss.')
      return false
    }
  }

  return {
    restoringInput,
    checkInformationCancellation,
    cancelPreparedInformation,
    send,
    syncToMain,
    saveCommentDraft,
    removeCommentDraft,
    undoWorkspaceChanges,
    respondNativePermission,
    respondNativeInput,
    checkNativeContext,
    checkQueuedDelivery,
    rebuildNativeContext,
    performQueueAction,
    returnQueuedInputToComposer,
    restoreReturnedInput,
    discardReturnedInput,
    stop,
    acceptPeerProposal,
    dismissPeerProposal,
  }
}
