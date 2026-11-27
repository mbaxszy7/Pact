import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  AnchoredComment,
  CollaborationSession,
  ConversationPatch,
  ConversationSnapshotView,
  NativePermissionRequest,
  RuntimeAgentId,
  SkillSelection,
} from '@pact/contracts'

import {
  CONVERSATION_EXPAND_BYTES,
  CONVERSATION_STREAM_BATCH_BYTES,
  CONVERSATION_STREAM_BATCH_ITEMS,
  NATIVE_PERMISSION_REQUESTS,
  NATIVE_PERMISSION_TIMEOUT_MS,
  nativeInputValuesSchema,
} from '@pact/contracts'
import { IMAGE_REFERENCE_ITEMS } from '@pact/contracts/images'

import { conversationQueryKeys, RpcError, unwrapRpcResult } from '../../query-client'
import { acceptSessionCatalogChange, patchCatalogSession } from '../workspace/session-catalog-cache'
import {
  assertComposerEditCapacity,
  COMPOSER_DRAFT_BYTES,
  COMPOSER_DRAFT_ITEMS,
} from './composer-capacity'
import { releaseComposerRoute } from './composer-document'
import {
  bodyTextEncoder,
  commentDraftSaveSucceeded,
  emptyComposerDraft,
  EMPTY_ACTIVITY_META,
  EMPTY_COMPOSER_IMAGES,
  EMPTY_COMPOSER_SKILLS,
  formatDecisionAnswers,
  hasDecisionAnswers,
  INITIAL_SYNC_TIMEOUT_MS,
  liveNativeDraft,
  readActivityBody,
  readSentComments,
  sameDecision,
  shouldClearComposerAfterAck,
  type CommentDraftInputWithoutRevision,
  type CommentDraftSaveOutcome,
  type ConversationComposerDraft,
  type ConversationComposerMention,
  type ConversationFlow,
  type ConversationHistoryControls,
  type DecisionAnswerDraft,
  type DecisionReplyContext,
  type NativeInputDraft,
  type PendingSubmission,
  type ReturnedInputRead,
  type SessionOperationState,
} from './conversation-draft-helpers'
import {
  closeRunArtifacts,
  conversationWindowStartOrder,
  isRunResponseComplete,
  mergeActivityPage,
  mergeConversationPatch,
  mergeMessagePage,
  mergeRunArtifactPage,
  mergeSentComments,
  nativeInputRequests,
  windowFromPage,
  withCommentError,
  type ActivityBodySource,
  type ConversationWindow,
  type ExpandedActivityBody,
} from './conversation-window'
import { releaseDraftImage, uploadConversationImage, type DraftImage } from './image-client'
import { useConversationActions } from './useConversationActions'

export {
  commentDraftSaveSucceeded,
  hasDecisionAnswers,
  sameDecision,
  shouldClearComposerAfterAck,
  type CommentDraftInputWithoutRevision,
  type CommentDraftSaveOutcome,
  type ConversationComposerMention,
  type ConversationFlow,
  type ConversationHistoryControls,
  type DecisionAnswerDraft,
  type DecisionReplyContext,
  type NativeInputDraft,
}

export function useConversation(
  sessionId: string | undefined,
  onNotice: (message: string) => void,
  visible = true,
  onErrorNotice: (message: string) => void = onNotice,
  onInfoNotice: (message: string) => void = onNotice,
  hookOptions?: {
    disableAutoInterest?: boolean | undefined
    waitForInterest?: (() => Promise<boolean>) | undefined
    onSessionRead?: ((session: CollaborationSession) => void) | undefined
    projectionActive?: boolean | undefined
  },
): ConversationFlow {
  const onSessionReadRef = useRef(hookOptions?.onSessionRead)
  useLayoutEffect(() => {
    onSessionReadRef.current = hookOptions?.onSessionRead
  }, [hookOptions?.onSessionRead])
  const disableAutoInterest = Boolean(hookOptions?.disableAutoInterest)
  const disableAutoInterestRef = useRef(disableAutoInterest)
  const waitForInterestRef = useRef(hookOptions?.waitForInterest)
  useLayoutEffect(() => {
    disableAutoInterestRef.current = disableAutoInterest
    waitForInterestRef.current = hookOptions?.waitForInterest
  }, [disableAutoInterest, hookOptions?.waitForInterest])
  const queryClient = useQueryClient()
  const [operationsBySession, setOperationsBySession] = useState<
    Record<string, SessionOperationState>
  >({})
  const operationsBySessionRef = useRef<Record<string, SessionOperationState>>({})
  const [composerDraftsBySession, setComposerDraftsBySession] = useState<
    Record<string, ConversationComposerDraft>
  >({})
  const latestComposerDraft = useRef<
    { sessionId: string; draft: ConversationComposerDraft } | undefined
  >(undefined)
  const composerDraftsRef = useRef<Record<string, ConversationComposerDraft>>({})
  const imageUploads = useRef(
    new Map<string, { sessionId: string; controller: AbortController; bytes: number }>(),
  )
  const imageChoosers = useRef(new Map<string, AbortController>())
  const draftCapacityNotified = useRef(false)
  const returnOperation = useRef<ReturnedInputRead | undefined>(undefined)
  // Sensitive answers are bounded, ephemeral interaction state, never history/query data.
  const [nativeInputDrafts, setNativeInputDrafts] = useState<Record<string, NativeInputDraft>>({})
  const markedReadRef = useRef<{ sessionId: string; sequence: number } | undefined>(undefined)
  const pendingBySessionRef = useRef(new Map<string, PendingSubmission>())
  const activeSessionIdRef = useRef(sessionId)
  const admitComposerResidency = useCallback(
    (
      drafts: Record<string, ConversationComposerDraft>,
      pendingCandidate?: { sessionId: string; value: PendingSubmission },
      textCandidate?: { sessionId: string; chars: number },
    ): boolean => {
      // Immutable document identity shares the current draft with a frozen pending Send.
      const documents = new Set<ConversationComposerDraft>(
        Object.entries(drafts)
          .filter(
            ([id, value]) =>
              id === (textCandidate?.sessionId ?? activeSessionIdRef.current) ||
              pendingBySessionRef.current.has(id) ||
              !emptyComposerDraft(value),
          )
          .map(([, value]) => value),
      )
      if (returnOperation.current?.draft) documents.add(returnOperation.current.draft)
      let bytes = returnOperation.current?.commentBytes ?? 0,
        items = 0
      const pending = new Map(pendingBySessionRef.current)
      if (pendingCandidate) pending.set(pendingCandidate.sessionId, pendingCandidate.value)
      const heldSources = new Set([...pending.values()].map((value) => value.sourceDocument))
      for (const value of pending.values()) {
        documents.add(value.sourceDocument)
        items += 1
        bytes +=
          1024 +
          bodyTextEncoder.encode(
            JSON.stringify({
              skills: value.skills,
              imageIds: value.imageIds,
              route: value.route,
              routeIntent: value.routeIntent,
              composerRevision: value.composerRevision,
              commentIds: value.commentIds,
              replyToDecision: value.replyToDecision,
              askOnly: value.askOnly,
              replaceTask: value.replaceTask,
              userInformation: value.userInformation,
            }),
          ).byteLength
        if (value.content !== value.sourceDocument.text) bytes += value.content.length * 2
        if (
          value.composerSnapshot !== value.sourceDocument.text &&
          value.composerSnapshot !== value.content
        )
          bytes += value.composerSnapshot.length * 2
      }
      for (const value of documents) {
        if (textCandidate && value === drafts[textCandidate.sessionId] && !heldSources.has(value))
          continue
        items += 1
        bytes +=
          value.text.length * 2 +
          1024 +
          bodyTextEncoder.encode(
            JSON.stringify({
              skills: value.skills,
              images: value.images,
              mention: value.mention,
              route: value.route,
              returnedInputOperationId: value.returnedInputOperationId,
              queueReturnOperationId: value.queueReturnOperationId,
              decisionAnswers: value.decisionAnswers,
              userInformation: value.userInformation,
            }),
          ).byteLength
        if (value.decisionAnswers) bytes += JSON.stringify(value.decisionAnswers).length * 2
        if (value.userInformation) bytes += JSON.stringify(value.userInformation).length * 2
        if (bytes > COMPOSER_DRAFT_BYTES || items > COMPOSER_DRAFT_ITEMS) break
      }
      if (textCandidate) {
        items += 1
        bytes += textCandidate.chars * 2 + 64 * 1024 + 1024
        const answers = drafts[textCandidate.sessionId]?.decisionAnswers
        if (answers) bytes += JSON.stringify(answers).length * 3
        const declaration = JSON.stringify(drafts[textCandidate.sessionId]?.userInformation ?? null)
        bytes += bodyTextEncoder.encode(declaration).byteLength + declaration.length * 2
      }
      const imageIdentities = new Set(
        [...documents].flatMap((value) =>
          (value.images ?? []).map((image) => image.image?.id ?? image.id),
        ),
      )
      for (const value of pending.values()) for (const id of value.imageIds) imageIdentities.add(id)
      if (
        bytes <= COMPOSER_DRAFT_BYTES &&
        items <= COMPOSER_DRAFT_ITEMS &&
        imageIdentities.size <= 512
      ) {
        draftCapacityNotified.current = false
        return true
      }
      if (!draftCapacityNotified.current)
        onNotice(
          'Open drafts and pending messages need too much memory. Your previous draft was kept.',
        )
      draftCapacityNotified.current = true
      return false
    },
    [onNotice],
  )
  const putComposerDraft = useCallback(
    (ownerSessionId: string, draft: ConversationComposerDraft): boolean => {
      const before = composerDraftsRef.current[ownerSessionId]?.text ?? ''
      try {
        assertComposerEditCapacity(before, 0, before.length, draft.text)
      } catch (error) {
        if (!draftCapacityNotified.current)
          onNotice(error instanceof Error ? error.message : 'Your previous draft was kept.')
        draftCapacityNotified.current = true
        return false
      }
      const next = { ...composerDraftsRef.current, [ownerSessionId]: draft }
      // Empty inactive documents carry no user input or unknown-delivery evidence.
      for (const [id, value] of Object.entries(next))
        if (
          id !== ownerSessionId &&
          !pendingBySessionRef.current.has(id) &&
          emptyComposerDraft(value)
        )
          delete next[id]
      if (!admitComposerResidency(next)) return false
      composerDraftsRef.current = next
      if (activeSessionIdRef.current === ownerSessionId)
        latestComposerDraft.current = { sessionId: ownerSessionId, draft }
      setComposerDraftsBySession(next)
      return true
    },
    [admitComposerResidency, onNotice],
  )
  const lastContextLimitRunRef = useRef<string | undefined>(undefined)
  const [windowState, setWindowState] = useState<ConversationWindow | undefined>()
  const windowRef = useRef<ConversationWindow | undefined>(undefined)
  const readingMessageIdRef = useRef<string | undefined>(undefined)
  const snapshotViewRef = useRef<ConversationSnapshotView | undefined>(undefined)
  const preserveRunIdRef = useRef<string | undefined>(undefined)
  const snapshotViewGenerationRef = useRef(0)
  const snapshotFoldGuardRef = useRef<(() => boolean) | undefined>(undefined)
  const [readingPositionLost, setReadingPositionLost] = useState(false)
  const [readPending, setReadPending] = useState(true)
  const isProjectionActive = Boolean(visible || hookOptions?.projectionActive)
  const visibleRef = useRef(visible)
  const projectionActiveRef = useRef(isProjectionActive)
  useLayoutEffect(() => {
    visibleRef.current = visible
    projectionActiveRef.current = isProjectionActive
  }, [visible, isProjectionActive])
  const protectReading = useCallback((messageId: string | undefined): void => {
    readingMessageIdRef.current = messageId
    setReadingPositionLost(false)
  }, [])
  const [loadingPage, setLoadingPage] = useState(false)
  const [loadingActivityRunId, setLoadingActivityRunId] = useState<string | undefined>()
  const [draftLimitExceeded, setDraftLimitExceeded] = useState(false)
  const [draftPageAfter, setDraftPageAfter] = useState<number>()
  const [draftHasMore, setDraftHasMore] = useState(false)
  const [draftHasEarlier, setDraftHasEarlier] = useState(false)
  const [draftError, setDraftError] = useState(false)
  const [expandedActivityBody, setExpandedActivityBody] = useState<
    ExpandedActivityBody | undefined
  >()
  const bodyRequestGenerationRef = useRef(0)
  const activeBodyReadsRef = useRef(0)
  const [draftsReadyRevision, setDraftsReadyRevision] = useState<number | undefined>()
  const [draftReloadToken, setDraftReloadToken] = useState(0)
  const [commentReloadToken, setCommentReloadToken] = useState(0)
  const [commentPages, setCommentPages] = useState<
    Record<string, { hasMore: boolean; hasEarlier: boolean }>
  >({})
  const [loadingCommentsFor, setLoadingCommentsFor] = useState<string>()
  const commentReadOwner = useRef<{
    pending: boolean
    desired?: { messageId: string; first: boolean } | undefined
  }>({ pending: false })
  const commentPageLoaderRef = useRef<((messageId: string, first: boolean) => void) | undefined>(
    undefined,
  )
  const draftReloadTokenRef = useRef(0)
  const [pageError, setPageError] = useState<string | undefined>()
  const [activityError, setActivityError] = useState<
    { runId: string; message: string } | undefined
  >()
  const [historyResyncToken, setHistoryResyncToken] = useState(0)
  const [gapRecoveryPending, setGapRecoveryPending] = useState(false)
  const requestGenerationRef = useRef(0)
  const resyncGenerationRef = useRef(0)
  const pageInFlightRef = useRef(false)
  const pendingAroundMessageRef = useRef<
    { messageId?: string | undefined; historicalSource: boolean } | undefined
  >(undefined)
  const activityInFlightRef = useRef<string | undefined>(undefined)
  const pendingActivityRunRef = useRef<string | undefined>(undefined)
  const activityRequestIdRef = useRef(0)
  const artifactRequestRef = useRef<AbortController | undefined>(undefined)
  const [loadingArtifacts, setLoadingArtifacts] = useState<
    { userMessageId: string; agentId: RuntimeAgentId } | undefined
  >()
  const [artifactError, setArtifactError] = useState<
    | {
        userMessageId: string
        agentId: RuntimeAgentId
        message: string
        before?: { createdAt: string; id: string } | undefined
      }
    | undefined
  >()
  const interestGenerationRef = useRef(0)
  // Only an in-flight initial page may retain early Patches. ACK, read and an
  // optional latest fallback share one deadline; all exit paths release it.
  const initialPatchesRef = useRef<
    | {
        sessionId: string
        generation: number
        patches: ConversationPatch[]
        bytes: number
        overflow: boolean
        deadline: number
        receivedAt?: number | undefined
        resyncGeneration: number
      }
    | undefined
  >(undefined)
  const query = useQuery({
    queryKey: conversationQueryKeys.session(sessionId ?? 'none'),
    queryFn: async ({ signal }) => {
      const generation = ++interestGenerationRef.current
      const snapshotViewGeneration = snapshotViewGenerationRef.current
      initialPatchesRef.current = {
        sessionId: sessionId ?? '',
        generation,
        patches: [],
        bytes: 0,
        overflow: false,
        deadline: performance.now() + INITIAL_SYNC_TIMEOUT_MS,
        receivedAt: undefined,
        resyncGeneration: resyncGenerationRef.current,
      }
      setReadPending(true)
      let expired = false
      let timeout: number | undefined
      let cancel: (() => void) | undefined
      const stopped = new Promise<never>((_resolve, reject) => {
        timeout = window.setTimeout(() => {
          expired = true
          reject(
            new RpcError({ code: 'TIMEOUT', message: 'Reading messages timed out. Try again.' }),
          )
        }, INITIAL_SYNC_TIMEOUT_MS)
        cancel = () => reject(new DOMException('Conversation read cancelled.', 'AbortError'))
        signal.addEventListener('abort', cancel, { once: true })
      })
      const checkCurrent = (): void => {
        signal.throwIfAborted()
        if (
          expired ||
          !projectionActiveRef.current ||
          initialPatchesRef.current?.generation !== generation ||
          snapshotViewGeneration !== snapshotViewGenerationRef.current
        )
          throw new DOMException('Conversation read cancelled.', 'AbortError')
      }
      const read = async () => {
        checkCurrent()
        if (!disableAutoInterestRef.current) {
          unwrapRpcResult(await window.pact.setConversationInterest(sessionId ?? null, generation))
        } else if (waitForInterestRef.current) {
          if (!(await waitForInterestRef.current())) {
            throw new Error('Could not subscribe to active sessions.')
          }
        }
        checkCurrent()
        const aroundMessageId = readingMessageIdRef.current
        let result = await window.pact.getConversation({
          sessionId: sessionId ?? '',
          scope: 'messages',
          ...(snapshotViewRef.current ? { snapshotView: snapshotViewRef.current } : {}),
          ...(preserveRunIdRef.current ? { preserveRunId: preserveRunIdRef.current } : {}),
          ...(aroundMessageId
            ? {
                aroundMessageId,
                includeHistoricalSource: windowRef.current?.sourceMessageId === aroundMessageId,
              }
            : {}),
        })
        checkCurrent()
        if (!result.ok && aroundMessageId) {
          // Recovery of a disposable reading position may fall back once. This
          // is a read, never an Agent retry or a replacement Comment target.
          readingMessageIdRef.current = undefined
          setReadingPositionLost(true)
          result = await window.pact.getConversation({
            sessionId: sessionId ?? '',
            scope: 'messages',
            ...(snapshotViewRef.current ? { snapshotView: snapshotViewRef.current } : {}),
            ...(preserveRunIdRef.current ? { preserveRunId: preserveRunIdRef.current } : {}),
          })
          checkCurrent()
        }
        const page = unwrapRpcResult(result)
        if (page.scope === 'messages' && aroundMessageId && page.snapshotView)
          snapshotViewRef.current = page.snapshotView
        if (initialPatchesRef.current?.generation === generation)
          initialPatchesRef.current.receivedAt = Date.now()
        return page
      }
      try {
        return await Promise.race([read(), stopped])
      } catch (error) {
        if (initialPatchesRef.current?.generation === generation)
          initialPatchesRef.current = undefined
        throw error
      } finally {
        if (timeout !== undefined) window.clearTimeout(timeout)
        if (cancel) signal.removeEventListener('abort', cancel)
      }
    },
    enabled: Boolean(sessionId && isProjectionActive),
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  })
  const refetchConversation = query.refetch
  /* oxlint-disable react/set-state-in-effect -- Visibility cancels external reads and settles their pending UI state. */
  useEffect(() => {
    // Selection changes must activate even a fresh cached page (gcTime:0 is
    // asynchronous). Join an existing fetch instead of duplicating its read.
    if (sessionId && isProjectionActive) void refetchConversation({ cancelRefetch: false })
    else {
      initialPatchesRef.current = undefined
      requestGenerationRef.current += 1
      artifactRequestRef.current?.abort()
      artifactRequestRef.current = undefined
      setLoadingArtifacts(undefined)
      activityRequestIdRef.current += 1
      bodyRequestGenerationRef.current += 1
      setExpandedActivityBody((current) => (current?.loading ? undefined : current))
      pageInFlightRef.current = false
      activityInFlightRef.current = undefined
      pendingActivityRunRef.current = undefined
      pendingAroundMessageRef.current = undefined
      setLoadingPage(false)
      setReadPending(true)
      setLoadingActivityRunId(undefined)
      if (sessionId)
        void queryClient.cancelQueries({
          queryKey: conversationQueryKeys.session(sessionId),
          exact: true,
        })
      if (!disableAutoInterestRef.current) {
        void window.pact
          .setConversationInterest(null, ++interestGenerationRef.current)
          .catch(() => undefined)
      }
    }
  }, [queryClient, refetchConversation, sessionId, isProjectionActive])
  /* oxlint-enable react/set-state-in-effect */
  useEffect(
    () => () => {
      initialPatchesRef.current = undefined
      returnOperation.current?.controller.abort()
      returnOperation.current = undefined
      for (const owner of imageUploads.current.values()) owner.controller.abort()
      imageUploads.current.clear()
      for (const owner of imageChoosers.current.values()) owner.abort()
      imageChoosers.current.clear()
      for (const [ownerSessionId, draft] of Object.entries(composerDraftsRef.current))
        for (const entry of draft.images ?? [])
          if (
            entry.image &&
            !pendingBySessionRef.current.get(ownerSessionId)?.imageIds.includes(entry.image.id)
          )
            releaseDraftImage(ownerSessionId, entry.image.id)
      composerDraftsRef.current = {}
      operationsBySessionRef.current = {}
      latestComposerDraft.current = undefined
      for (const [ownerSessionId, pending] of pendingBySessionRef.current) {
        pending.inputPreparation?.abort()
        if (pending.inputPreparation && pending.inputId)
          void window.pact
            .writeConversationInput({
              type: 'release',
              sessionId: ownerSessionId,
              inputId: pending.inputId,
            })
            .catch(() => undefined)
      }
      pendingBySessionRef.current.clear()
      if (!disableAutoInterestRef.current) {
        void window.pact
          .setConversationInterest(null, ++interestGenerationRef.current)
          .catch(() => undefined)
      }
    },
    [],
  )
  const currentOperations = sessionId ? operationsBySession[sessionId] : undefined
  const sending = Boolean(currentOperations?.sendingOperationId)
  const stopping = Boolean(currentOperations?.stoppingOperationId)
  const checkingNativeTargetId = currentOperations?.nativeCheck?.runId
  const actionError = currentOperations?.error
  const composerDraft = sessionId ? composerDraftsBySession[sessionId] : undefined
  const composer = composerDraft?.text ?? ''
  const composerUserInformation = composerDraft?.userInformation
  const setComposerUserInformation = (
    userInformation: import('@pact/contracts').UserInformationDeclaration | undefined,
  ): boolean => {
    if (!sessionId || returnOperation.current?.sessionId === sessionId) return false
    if (
      userInformation &&
      bodyTextEncoder.encode(JSON.stringify(userInformation)).byteLength > 4096
    ) {
      onNotice('This information is too long. Your previous draft was kept.')
      return false
    }
    const previous = composerDraftsRef.current[sessionId] ?? { text: '' }
    return putComposerDraft(sessionId, {
      ...previous,
      // Each field edit gets a fresh identity, including a change back to earlier text.
      userInformation: userInformation ? { ...userInformation } : undefined,
      revision: (previous.revision ?? 0) + 1,
    })
  }
  const clearCancelledInformation = (
    ownerSessionId: string,
    expected: import('@pact/contracts').UserInformationDeclaration,
  ): boolean => {
    const previous = composerDraftsRef.current[ownerSessionId]
    if (
      !previous ||
      expected.state.status !== 'unanswered' ||
      previous.userInformation !== expected
    )
      return false
    return putComposerDraft(ownerSessionId, {
      ...previous,
      userInformation: undefined,
      revision: (previous.revision ?? 0) + 1,
    })
  }
  const composerImages = composerDraft?.images ?? EMPTY_COMPOSER_IMAGES
  const composerMention = composerDraft?.mention
  const composerSkills = composerDraft?.skills ?? EMPTY_COMPOSER_SKILLS
  useLayoutEffect(() => {
    if (
      sessionId &&
      (latestComposerDraft.current?.sessionId !== sessionId ||
        (composerDraft?.revision ?? 0) >= (latestComposerDraft.current?.draft.revision ?? 0))
    )
      latestComposerDraft.current = { sessionId, draft: composerDraft ?? { text: '' } }
  }, [sessionId, composerDraft])
  const setComposerDocument = (
    document: import('./composer-document').ComposerDocument,
  ): boolean => {
    if (!sessionId || returnOperation.current?.sessionId === sessionId) return false
    const previous =
      latestComposerDraft.current?.sessionId === sessionId
        ? latestComposerDraft.current.draft
        : { text: '' }
    // Return receipts are settled by the Hook, never by an editor callback (including IME).
    const { returnedInputOperationId: _editingContext, ...editing } = document
    const draft = {
      ...previous,
      ...editing,
      route:
        previous.returnedInputOperationId || previous.queueReturnOperationId
          ? editing.route
          : releaseComposerRoute(editing.route),
      revision: (previous.revision ?? 0) + 1,
    }
    return putComposerDraft(sessionId, draft)
  }
  const setDecisionDraft = (decisionAnswers: DecisionAnswerDraft): boolean => {
    if (!sessionId || sending || returnOperation.current?.sessionId === sessionId) return false
    const previous = composerDraftsRef.current[sessionId] ?? { text: '' }
    if (
      hasDecisionAnswers(previous.decisionAnswers) &&
      !sameDecision(previous.decisionAnswers?.reference, decisionAnswers.reference)
    )
      return false
    if (
      (decisionAnswers.originalReply?.length ?? 0) > 4096 ||
      (decisionAnswers.questions.length > 0 && Boolean(decisionAnswers.originalReply?.trim())) ||
      decisionAnswers.questions.length > 3 ||
      Object.keys(decisionAnswers.answers).length > 3 ||
      Object.entries(decisionAnswers.answers).some(([id, answer]) => {
        const question = decisionAnswers.questions.find((item) => item.id === id)
        return (
          !question ||
          answer.text.length > 4096 ||
          answer.optionIds.length > (question.selection === 'single' ? 1 : 6) ||
          answer.optionIds.some(
            (optionId) => !question.options?.some((option) => option.id === optionId),
          )
        )
      })
    )
      return false
    return putComposerDraft(sessionId, {
      ...previous,
      decisionAnswers,
      revision: (previous.revision ?? 0) + 1,
    })
  }
  const clearDecisionDraft = (keepInMessage: boolean): boolean => {
    if (!sessionId || sending || returnOperation.current?.sessionId === sessionId) return false
    const previous = composerDraftsRef.current[sessionId]
    if (!previous?.decisionAnswers) return true
    const saved = keepInMessage ? formatDecisionAnswers(previous.decisionAnswers) : ''
    return putComposerDraft(sessionId, {
      ...previous,
      text: saved ? [previous.text, saved].filter(Boolean).join('\n\n') : previous.text,
      decisionAnswers: undefined,
      revision: (previous.revision ?? 0) + 1,
    })
  }
  const setComposerSkills = (skills: SkillSelection[]): void => {
    if (!sessionId || returnOperation.current?.sessionId === sessionId) return
    const previous = composerDraftsRef.current[sessionId]
    putComposerDraft(sessionId, {
      ...previous,
      text: previous?.text ?? '',
      skills,
      revision: (previous?.revision ?? 0) + 1,
    })
  }
  const setComposer = useCallback(
    (value: string): void => {
      if (!sessionId) return
      if (returnOperation.current?.sessionId === sessionId) return
      const previous = composerDraftsRef.current[sessionId]
      putComposerDraft(sessionId, {
        ...previous,
        text: value,
        revision: (previous?.revision ?? 0) + 1,
      })
    },
    [sessionId, putComposerDraft],
  )
  const setComposerMention = useCallback(
    (value: ConversationComposerMention | undefined): void => {
      if (!sessionId) return
      if (returnOperation.current?.sessionId === sessionId) return
      const previous = composerDraftsRef.current[sessionId]
      putComposerDraft(sessionId, {
        ...previous,
        text: previous?.text ?? '',
        mention: value,
        revision: (previous?.revision ?? 0) + 1,
      })
    },
    [sessionId, putComposerDraft],
  )
  const seedComposerDraft = useCallback(
    (
      targetSessionId: string,
      value: import('./composer-document').ComposerDocument,
      options?: { onConflict?: (() => void) | undefined },
    ): boolean => {
      const existing =
        latestComposerDraft.current?.sessionId === targetSessionId
          ? latestComposerDraft.current.draft
          : composerDraftsRef.current[targetSessionId]
      const nextRoute = value.route ? releaseComposerRoute(value.route) : undefined
      const hasExistingContent = Boolean(
        existing &&
        (existing.text.trim().length > 0 ||
          (existing.skills?.length ?? 0) > 0 ||
          Boolean(existing.mention) ||
          (existing.images?.length ?? 0) > 0),
      )
      if (hasExistingContent && existing) {
        const existingSkills = existing.skills ?? []
        const sameSkills =
          existingSkills.length === value.skills.length &&
          existingSkills.every(
            (skill, index) =>
              skill.id === value.skills[index]?.id &&
              skill.agentId === value.skills[index]?.agentId &&
              skill.name === value.skills[index]?.name,
          )
        const sameMention =
          JSON.stringify(existing.mention ?? null) === JSON.stringify(value.mention ?? null)
        const sameRoute =
          JSON.stringify(existing.route ?? null) === JSON.stringify(nextRoute ?? null)
        const hasImages = (existing.images?.length ?? 0) > 0
        if (
          hasImages ||
          existing.text !== value.text ||
          !sameSkills ||
          !sameMention ||
          !sameRoute
        ) {
          options?.onConflict?.()
          return false
        }
      }
      const next: ConversationComposerDraft = {
        ...existing,
        text: value.text,
        skills: value.skills.length ? value.skills : undefined,
        mention: value.mention,
        route: nextRoute,
        returnedInputOperationId: undefined,
        queueReturnOperationId: undefined,
        revision: (existing?.revision ?? 0) + 1,
      }
      const admitted = putComposerDraft(targetSessionId, next)
      if (admitted && activeSessionIdRef.current === targetSessionId) {
        latestComposerDraft.current = { sessionId: targetSessionId, draft: next }
      }
      return admitted
    },
    [putComposerDraft],
  )
  const clearSubmittedComposerDraft = useCallback(
    (
      targetSessionId: string,
      expectedRevision: number,
      consumedImageIds: readonly string[] = [],
    ): void => {
      const latest =
        latestComposerDraft.current?.sessionId === targetSessionId
          ? latestComposerDraft.current.draft
          : composerDraftsRef.current[targetSessionId]
      if (!latest) return
      const currentRevision = latest.revision ?? 0
      const remainingImages = latest.images?.filter(
        (entry) => !entry.image || !consumedImageIds.includes(entry.image.id),
      )
      const cleared: ConversationComposerDraft =
        currentRevision === expectedRevision
          ? {
              ...(remainingImages?.length ? { images: remainingImages } : {}),
              text: '',
              revision: currentRevision + 1,
            }
          : {
              ...latest,
              ...(remainingImages !== undefined
                ? { images: remainingImages.length ? remainingImages : undefined }
                : {}),
              revision: currentRevision + 1,
            }
      putComposerDraft(targetSessionId, cleared)
      if (latestComposerDraft.current?.sessionId === targetSessionId) {
        latestComposerDraft.current = { sessionId: targetSessionId, draft: cleared }
      }
    },
    [putComposerDraft],
  )

  const updateImages = useCallback(
    (ownerSessionId: string, update: (images: DraftImage[]) => DraftImage[]): boolean => {
      if (returnOperation.current?.sessionId === ownerSessionId) return false
      const draft = composerDraftsRef.current[ownerSessionId] ?? { text: '' }
      const images = update(draft.images ?? [])
      const resident = Object.values(composerDraftsRef.current).reduce(
        (count, value) => count + (value.images?.length ?? 0),
        0,
      )
      if (
        images.length > IMAGE_REFERENCE_ITEMS ||
        resident - (draft.images?.length ?? 0) + images.length > 512
      ) {
        onNotice('Open drafts have too many images. Remove an image before adding another.')
        return false
      }
      return putComposerDraft(ownerSessionId, {
        ...draft,
        images,
        revision: (draft.revision ?? 0) + 1,
      })
    },
    [putComposerDraft, onNotice],
  )

  const addComposerImages = async (files: readonly File[]): Promise<void> => {
    const ownerSessionId = sessionId
    if (!ownerSessionId || !files.length || returnOperation.current) return
    const bytes = files.reduce((total, file) => total + file.size, 0)
    const retained = [...imageUploads.current.values()]
    if (
      retained.reduce((total, owner) => total + owner.bytes, 0) + bytes > 1024 * 1024 * 1024 ||
      retained
        .filter((owner) => owner.sessionId === ownerSessionId)
        .reduce((total, owner) => total + owner.bytes, 0) +
        bytes >
        256 * 1024 * 1024
    ) {
      onNotice('These images need too much memory to prepare together. Add them in smaller groups.')
      return
    }
    const entries: DraftImage[] = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name,
      status: 'preparing',
    }))
    if (!updateImages(ownerSessionId, (current) => [...current, ...entries])) return
    // Sequential preparation keeps one segment and one active upload per chosen group.
    for (const [index, file] of files.entries()) {
      const entry = entries[index]!
      const controller = new AbortController()
      imageUploads.current.set(entry.id, {
        sessionId: ownerSessionId,
        controller,
        bytes: file.size,
      })
    }
    for (const [index, file] of files.entries()) {
      const entry = entries[index]!,
        owner = imageUploads.current.get(entry.id)
      if (!owner) continue
      const timer = window.setTimeout(() => owner.controller.abort(), 10_000)
      try {
        // oxlint-disable-next-line no-await-in-loop -- Each file has one cancellable bounded upload; queued Files retain only their source handle.
        const image = await uploadConversationImage(
          ownerSessionId,
          entry.id,
          file,
          owner.controller.signal,
        )
        if (
          owner.controller.signal.aborted ||
          !composerDraftsRef.current[ownerSessionId]?.images?.some((value) => value.id === entry.id)
        ) {
          releaseDraftImage(ownerSessionId, image.id)
          continue
        }
        if (
          !updateImages(ownerSessionId, (current) =>
            current.map((value) =>
              value.id === entry.id ? { ...value, status: 'ready', image } : value,
            ),
          )
        )
          releaseDraftImage(ownerSessionId, image.id)
      } catch (error) {
        if (!owner.controller.signal.aborted)
          updateImages(ownerSessionId, (current) =>
            current.map((value) =>
              value.id === entry.id
                ? {
                    ...value,
                    status: 'failed',
                    error: error instanceof Error ? error.message : 'Image could not be added.',
                  }
                : value,
            ),
          )
        else if (
          composerDraftsRef.current[ownerSessionId]?.images?.some((value) => value.id === entry.id)
        )
          updateImages(ownerSessionId, (current) =>
            current.map((value) =>
              value.id === entry.id
                ? {
                    ...value,
                    status: 'failed',
                    error: 'Adding this image took too long. Remove it and try again.',
                  }
                : value,
            ),
          )
      } finally {
        window.clearTimeout(timer)
        imageUploads.current.delete(entry.id)
      }
    }
  }

  const chooseComposerImages = async (): Promise<void> => {
    const ownerSessionId = sessionId
    if (!ownerSessionId || imageChoosers.current.size || returnOperation.current) return
    const controller = new AbortController()
    imageChoosers.current.set(ownerSessionId, controller)
    updateSessionOperations(ownerSessionId, (current) => ({ ...current, choosingImages: true }))
    try {
      const images = unwrapRpcResult(
        await window.pact.chooseConversationImages({ sessionId: ownerSessionId }),
      )
      if (
        controller.signal.aborted ||
        !updateImages(ownerSessionId, (current) => [
          ...current,
          ...images.map((image) => ({
            id: image.id,
            name: image.name,
            status: 'ready' as const,
            image,
          })),
        ])
      )
        for (const image of images) releaseDraftImage(ownerSessionId, image.id)
    } catch (error) {
      if (!controller.signal.aborted)
        onNotice(
          error instanceof Error
            ? error.message
            : 'Images could not be added. Your draft was kept.',
        )
    } finally {
      imageChoosers.current.delete(ownerSessionId)
      if (!controller.signal.aborted)
        updateSessionOperations(ownerSessionId, (current) => ({
          ...current,
          choosingImages: false,
        }))
    }
  }

  const removeComposerImage = (id: string): void => {
    if (!sessionId || returnOperation.current?.sessionId === sessionId) return
    const entry = composerDraftsRef.current[sessionId]?.images?.find((image) => image.id === id)
    if (!entry || !updateImages(sessionId, (current) => current.filter((image) => image.id !== id)))
      return
    imageUploads.current.get(id)?.controller.abort()
    imageUploads.current.delete(id)
    if (
      entry.image &&
      !pendingBySessionRef.current.get(sessionId)?.imageIds.includes(entry.image.id)
    )
      releaseDraftImage(sessionId, entry.image.id)
  }

  const updateSessionOperations = useCallback(
    (
      ownerSessionId: string,
      update: (current: SessionOperationState) => SessionOperationState,
    ): void => {
      const current = operationsBySessionRef.current,
        next = { ...current, [ownerSessionId]: update(current[ownerSessionId] ?? {}) }
      operationsBySessionRef.current = next
      setOperationsBySession(next)
    },
    [],
  )

  const clearOtherCancelledInformation = useCallback((exceptSessionId: string): void => {
    const states = { ...operationsBySessionRef.current }
    for (const [id, state] of Object.entries(states))
      if (id !== exceptSessionId && state.cancelledInformationDecisionId)
        states[id] = { ...state, cancelledInformationDecisionId: undefined }
    operationsBySessionRef.current = states
  }, [])

  const getReturnOperation = useCallback(
    (): ReturnedInputRead | undefined => returnOperation.current,
    [],
  )

  const setReturnOperation = useCallback((value: ReturnedInputRead | undefined): void => {
    returnOperation.current = value
  }, [])

  const bumpDraftReloadToken = useCallback((): void => {
    draftReloadTokenRef.current += 1
    setDraftReloadToken(draftReloadTokenRef.current)
  }, [])

  const settleSubmission = useCallback(
    (ownerSessionId: string, clientMessageId: string): void => {
      const pending = pendingBySessionRef.current.get(ownerSessionId)
      if (!pending || pending.clientMessageId !== clientMessageId) return
      pendingBySessionRef.current.delete(ownerSessionId)
      const settleDraft = (
        draft: ConversationComposerDraft | undefined,
      ): ConversationComposerDraft | undefined => {
        if (pending.askOnly) {
          return draft &&
            (draft.revision ?? 0) === (pending.composerRevision ?? 0) &&
            shouldClearComposerAfterAck(draft.text, pending)
            ? { ...draft, text: '', revision: (draft.revision ?? 0) + 1 }
            : draft
        }
        if (pending.kind === 'decision') {
          return draft?.decisionAnswers &&
            JSON.stringify(draft.decisionAnswers) ===
              JSON.stringify(pending.sourceDocument.decisionAnswers)
            ? { ...draft, decisionAnswers: undefined, revision: (draft.revision ?? 0) + 1 }
            : draft
        }
        if (
          (draft?.revision ?? 0) === (pending.composerRevision ?? 0) &&
          shouldClearComposerAfterAck(draft?.text ?? '', pending)
        )
          return {
            text: '',
            images: draft?.images?.filter(
              (entry) => !entry.image || !pending.imageIds.includes(entry.image.id),
            ),
            revision: (draft?.revision ?? 0) + 1,
          }
        if (
          pending.returnedInputOperationId &&
          draft?.returnedInputOperationId === pending.returnedInputOperationId
        ) {
          const { returnedInputOperationId: _consumed, ...kept } = draft
          // Fixed targets belong to that receipt. Keep the selected route kind in the newer
          // draft; the context change clears old Undo facts even when the text is unchanged.
          return {
            ...kept,
            images: kept.images?.filter(
              (entry) => !entry.image || !pending.imageIds.includes(entry.image.id),
            ),
            route: releaseComposerRoute(kept.route),
            revision: (kept.revision ?? 0) + 1,
          }
        }
        if (
          pending.queueReturnOperationId &&
          draft?.queueReturnOperationId === pending.queueReturnOperationId
        ) {
          const { queueReturnOperationId: _consumed, ...kept } = draft
          return {
            ...kept,
            images: kept.images?.filter(
              (entry) => !entry.image || !pending.imageIds.includes(entry.image.id),
            ),
            route: releaseComposerRoute(kept.route),
            revision: (kept.revision ?? 0) + 1,
          }
        }
        if (
          draft?.images?.some((entry) => entry.image && pending.imageIds.includes(entry.image.id))
        )
          return {
            ...draft,
            images: draft.images.filter(
              (entry) => !entry.image || !pending.imageIds.includes(entry.image.id),
            ),
            revision: (draft.revision ?? 0) + 1,
          }
        return draft
      }
      if (latestComposerDraft.current?.sessionId === ownerSessionId)
        latestComposerDraft.current = {
          sessionId: ownerSessionId,
          draft: settleDraft(latestComposerDraft.current.draft) ?? { text: '' },
        }
      {
        const current = composerDraftsRef.current
        const draft = current[ownerSessionId]
        const next = settleDraft(draft)
        if (next && next !== draft) {
          composerDraftsRef.current = { ...current, [ownerSessionId]: next }
          setComposerDraftsBySession(composerDraftsRef.current)
        }
      }
      updateSessionOperations(ownerSessionId, (current) =>
        current.sendingOperationId === pending.operationId
          ? { ...current, sendingOperationId: undefined, error: undefined }
          : pending.acknowledgementError && current.error === pending.acknowledgementError
            ? { ...current, error: undefined }
            : current,
      )
    },
    [updateSessionOperations],
  )

  useEffect(() => {
    if (query.data?.scope === 'messages')
      for (const id of query.data.header.receivedInputIds ?? [])
        settleSubmission(query.data.sessionId, id)
  }, [query.data, settleSubmission])

  const acknowledgePatch = useCallback(
    (patch: ConversationPatch): void => {
      for (const id of patch.receivedInputIds ?? []) settleSubmission(patch.sessionId, id)
      for (const { message } of patch.messages)
        if (message.role === 'user' && message.sessionId === patch.sessionId)
          settleSubmission(patch.sessionId, message.id)
    },
    [settleSubmission],
  )

  const releaseSupersededQueueReturn = useCallback(
    (next: ConversationWindow | undefined): void => {
      if (!next?.view.queue) return
      const ownerSessionId = next.view.sessionId
      if (returnOperation.current?.sessionId === ownerSessionId) return
      const draft = composerDraftsRef.current[ownerSessionId]
      if (
        !draft?.queueReturnOperationId ||
        draft.queueReturnOperationId === next.view.queue.returnedInput?.operationId
      )
        return
      // Reconcile only the receipt against the latest authoritative projection. Keep the
      // latest document, including edits made after a replacement return lost its ACK.
      const { queueReturnOperationId: _superseded, ...kept } = draft
      putComposerDraft(ownerSessionId, {
        ...kept,
        route: releaseComposerRoute(kept.route),
        revision: (kept.revision ?? 0) + 1,
      })
    },
    [putComposerDraft],
  )

  const commitWindow = useCallback(
    (next: ConversationWindow | undefined): void => {
      const previousWindow = windowRef.current
      if (next?.activityView && previousWindow?.view.sessionId === next.view.sessionId) {
        const runId = next.activityView.runId
        const previousRun = previousWindow.view.runs.find((run) => run.id === runId)
        const nextRun = next.view.runs.find((run) => run.id === runId)
        if (previousRun && !isRunResponseComplete(previousRun) && isRunResponseComplete(nextRun)) {
          // Completion ends this reading intent once. A later explicit expansion
          // remains selected through ordinary paging and virtualization.
          next = { ...next, activityView: { ...next.activityView, manual: undefined } }
          bodyRequestGenerationRef.current += 1
          setExpandedActivityBody(undefined)
        }
      }
      if (next) {
        // A live cut remains in place until the View makes one guarded completion
        // decision. This is disposable selected-window state, never Run state.
        const running = next.view.runs.findLast(
          (run) =>
            run.outputSnapshots &&
            !run.outputSnapshots.settled &&
            ['starting', 'running', 'recovering'].includes(run.status),
        )
        if (running && preserveRunIdRef.current !== running.id) {
          preserveRunIdRef.current = running.id
          snapshotViewGenerationRef.current += 1
        }
        next = {
          ...next,
          snapshotView: snapshotViewRef.current,
          preserveRunId: preserveRunIdRef.current,
        }
      }
      windowRef.current = next
      setWindowState(next)
      if (next) {
        const pending = pendingBySessionRef.current.get(next.view.sessionId)
        if (
          pending &&
          next.view.messages.some(
            (message) =>
              message.role === 'user' &&
              message.sessionId === next.view.sessionId &&
              message.id === pending.clientMessageId,
          )
        )
          settleSubmission(next.view.sessionId, pending.clientMessageId)
        releaseSupersededQueueReturn(next)
        const live = nativeInputRequests(next.view)
        setNativeInputDrafts((current) => {
          const retained = Object.entries(current).filter(([id, draft]) =>
            live.some(
              (interaction) => interaction.request.id === id && liveNativeDraft(interaction, draft),
            ),
          )
          return retained.length === Object.keys(current).length
            ? current
            : Object.fromEntries(retained)
        })
      }
    },
    [releaseSupersededQueueReturn, settleSubmission],
  )

  const setNativeInputDraft = useCallback(
    (
      request: NativePermissionRequest,
      draft: Pick<NativeInputDraft, 'values' | 'page'>,
      initializeOnly = false,
    ): void => {
      const liveRequests = nativeInputRequests(windowRef.current?.view)
      const interaction = liveRequests.find(
        (live) =>
          live.request.id === request.id && live.request.operationId === request.operationId,
      )
      if (!request.operationId || !interaction) return
      const expiresAt = Date.parse(interaction.request.createdAt) + NATIVE_PERMISSION_TIMEOUT_MS
      if (expiresAt <= Date.now()) return
      const parsed = nativeInputValuesSchema.safeParse(draft.values)
      if (!parsed.success) {
        onNotice('The native answers are too large. Shorten the input and try again.')
        return
      }
      const operationId = request.operationId
      setNativeInputDrafts((current) => {
        if (
          initializeOnly &&
          current[request.id] &&
          liveNativeDraft(interaction, current[request.id]!)
        )
          return current
        const next = Object.fromEntries(
          Object.entries(current).filter(([id, value]) =>
            liveRequests.some((live) => live.request.id === id && liveNativeDraft(live, value)),
          ),
        )
        if (!next[request.id] && Object.keys(next).length >= NATIVE_PERMISSION_REQUESTS) return next
        next[request.id] = {
          operationId,
          agentId: interaction.agentId,
          bindingGeneration: interaction.bindingGeneration,
          executorId: interaction.executorId,
          expiresAt,
          values: parsed.data,
          page: Math.max(0, Math.min(7, Math.floor(draft.page))),
        }
        return next
      })
    },
    [onNotice],
  )
  useEffect(() => {
    const expiry = Math.min(...Object.values(nativeInputDrafts).map((draft) => draft.expiresAt))
    if (!Number.isFinite(expiry)) return undefined
    const timeout = window.setTimeout(
      () => {
        setNativeInputDrafts((current) =>
          Object.fromEntries(
            Object.entries(current).filter(([, draft]) => draft.expiresAt > Date.now()),
          ),
        )
      },
      Math.max(0, expiry - Date.now()),
    )
    return () => window.clearTimeout(timeout)
  }, [nativeInputDrafts])

  /* oxlint-disable react/set-state-in-effect -- Switching Sessions releases the previous bounded owner state. */
  useEffect(() => {
    activeSessionIdRef.current = sessionId
    if (initialPatchesRef.current?.sessionId !== sessionId) initialPatchesRef.current = undefined
    requestGenerationRef.current += 1
    artifactRequestRef.current?.abort()
    artifactRequestRef.current = undefined
    setLoadingArtifacts(undefined)
    setArtifactError(undefined)
    windowRef.current = undefined
    readingMessageIdRef.current = undefined
    snapshotViewRef.current = undefined
    preserveRunIdRef.current = undefined
    setReadingPositionLost(false)
    setReadPending(true)
    setWindowState(undefined)
    setNativeInputDrafts({})
    setLoadingPage(false)
    setLoadingActivityRunId(undefined)
    setDraftLimitExceeded(false)
    setDraftPageAfter(undefined)
    setDraftHasMore(false)
    setDraftHasEarlier(false)
    setCommentPages({})
    setLoadingCommentsFor(undefined)
    commentReadOwner.current.desired = undefined
    setDraftError(false)
    setExpandedActivityBody(undefined)
    bodyRequestGenerationRef.current += 1
    setDraftsReadyRevision(undefined)
    setPageError(undefined)
    setActivityError(undefined)
    setHistoryResyncToken(0)
    setGapRecoveryPending(false)
    pageInFlightRef.current = false
    pendingAroundMessageRef.current = undefined
    activityInFlightRef.current = undefined
    pendingActivityRunRef.current = undefined
    activityRequestIdRef.current += 1
    return () => {
      requestGenerationRef.current += 1
      artifactRequestRef.current?.abort()
      artifactRequestRef.current = undefined
      pageInFlightRef.current = false
      pendingAroundMessageRef.current = undefined
      activityInFlightRef.current = undefined
      pendingActivityRunRef.current = undefined
      activityRequestIdRef.current += 1
      windowRef.current = undefined
      bodyRequestGenerationRef.current += 1
    }
  }, [sessionId])
  /* oxlint-enable react/set-state-in-effect */

  const setActivityReading = useCallback(
    (runId: string, reading: boolean, automatic = false): void => {
      const current = windowRef.current
      if (
        !current ||
        !visibleRef.current ||
        (!reading && !automatic && current.activityView?.runId !== runId)
      )
        return
      if (
        !reading &&
        !automatic &&
        current.latestRun &&
        ['starting', 'running', 'recovering'].includes(current.latestRun.status)
      )
        runId = current.latestRun.id
      const same = current.activityView?.runId === runId
      if (!reading && pendingActivityRunRef.current === runId)
        pendingActivityRunRef.current = undefined
      if (!same) {
        bodyRequestGenerationRef.current += 1
        setExpandedActivityBody(undefined)
        setActivityError(undefined)
      }
      commitWindow({
        ...current,
        view: { ...current.view, activities: same ? current.view.activities : [] },
        activityMeta: same ? current.activityMeta : {},
        activityBodyResync: same ? current.activityBodyResync : {},
        activityView: {
          runId,
          manual: reading || (automatic && same && current.activityView?.manual) ? true : undefined,
          truncated: same ? (current.activityView?.truncated ?? false) : false,
          observation: current.view.observation,
        },
      })
    },
    [commitWindow],
  )

  const loadActivities = useCallback(
    async function readActivities(runId: string, automatic = false): Promise<void> {
      const current = windowRef.current
      if (!visibleRef.current || !sessionId || !current) return
      if (automatic && current.activityView?.manual && current.activityView.runId !== runId) return
      setActivityReading(runId, !automatic, automatic)
      if (activityInFlightRef.current) {
        pendingActivityRunRef.current = runId
        return
      }
      const generation = requestGenerationRef.current
      const requestId = ++activityRequestIdRef.current
      activityInFlightRef.current = runId
      setLoadingActivityRunId(runId)
      setActivityError(undefined)
      try {
        const page = unwrapRpcResult(
          await window.pact.getConversation({ scope: 'activities', sessionId, runId }),
        )
        if (page.scope !== 'activities' || page.runId !== runId)
          throw new Error('Unexpected Work log page.')
        if (
          generation !== requestGenerationRef.current ||
          requestId !== activityRequestIdRef.current
        )
          return
        const resident = windowRef.current
        if (!resident || resident.view.sessionId !== sessionId) return
        const merged = mergeActivityPage(resident, page)
        if (!merged) {
          if (
            resident.activityView?.runId === runId &&
            resident.view.runs.some((run) => run.id === runId)
          )
            throw new Error('The Work log changed. Open it again.')
          return
        }
        commitWindow(merged)
        if (Object.keys(merged.activityBodyResync).length)
          throw new Error('Work log changed. Try again.')
      } catch (error) {
        if (
          generation === requestGenerationRef.current &&
          requestId === activityRequestIdRef.current &&
          windowRef.current?.activityView?.runId === runId
        ) {
          setActivityError({
            runId,
            message: error instanceof Error ? error.message : 'Work log could not load.',
          })
        }
      } finally {
        if (
          generation === requestGenerationRef.current &&
          requestId === activityRequestIdRef.current
        ) {
          activityInFlightRef.current = undefined
          const pending = pendingActivityRunRef.current
          pendingActivityRunRef.current = undefined
          setLoadingActivityRunId(undefined)
          if (pending && windowRef.current?.activityView?.runId === pending)
            void readActivities(pending, true)
        }
      }
    },
    [commitWindow, sessionId, setActivityReading],
  )

  const cachePatch = useCallback(
    (patch: ConversationPatch): void => {
      acknowledgePatch(patch)
      patchCatalogSession(queryClient, patch.session)
      if (!isProjectionActive) return
      if (patch.sessionId !== sessionId || patch.sessionId !== activeSessionIdRef.current) return
      if (patch.resync?.drafts) {
        setDraftsReadyRevision(undefined)
        draftReloadTokenRef.current += 1
        setDraftReloadToken(draftReloadTokenRef.current)
      }
      const current = windowRef.current
      if (!current || current.view.sessionId !== patch.sessionId) {
        const pending = initialPatchesRef.current
        if (!pending || pending.sessionId !== patch.sessionId || pending.overflow) return
        const bytes = new TextEncoder().encode(JSON.stringify(patch)).byteLength
        if (
          pending.patches.length === CONVERSATION_STREAM_BATCH_ITEMS ||
          pending.bytes + bytes > CONVERSATION_STREAM_BATCH_BYTES ||
          performance.now() > pending.deadline
        ) {
          pending.overflow = true
          pending.patches = []
          pending.bytes = 0
          return
        }
        pending.patches.push(patch)
        pending.bytes += bytes
        return
      }
      const merged = mergeConversationPatch(
        {
          ...current,
          snapshotView: snapshotViewRef.current,
          preserveRunId: preserveRunIdRef.current,
        },
        patch,
      )
      if (merged.applied) {
        commitWindow(merged.window)
        if (patch.comments) {
          setDraftLimitExceeded(false)
          setDraftsReadyRevision(patch.resync?.drafts ? undefined : patch.comments.revision)
        }
      }
      if (merged.resyncMessages) {
        resyncGenerationRef.current += 1
        activityRequestIdRef.current += 1
        activityInFlightRef.current = undefined
        pendingActivityRunRef.current = undefined
        setLoadingActivityRunId(undefined)
        bodyRequestGenerationRef.current += 1
        setExpandedActivityBody(undefined)
        setHistoryResyncToken((token) => token + 1)
        setGapRecoveryPending(true)
      }
      for (const runId of merged.resyncActivityRunIds) {
        if (windowRef.current?.activityView?.runId === runId) void loadActivities(runId, true)
      }
    },
    [acknowledgePatch, commitWindow, queryClient, sessionId, isProjectionActive, loadActivities],
  )

  const markSelectedRead = useCallback(
    async (ownerSessionId: string, sequence: number | undefined): Promise<void> => {
      if (!visible || !sessionId || ownerSessionId !== sessionId || sequence === undefined) return
      const marked = markedReadRef.current
      if (marked?.sessionId === sessionId && marked.sequence >= sequence) return
      const request = { sessionId, sequence }
      markedReadRef.current = request
      try {
        const change = unwrapRpcResult(
          await window.pact.markSessionRead({ sessionId, throughSequence: sequence }),
        )
        const currentWindow = windowRef.current
        if (
          currentWindow?.view.sessionId === change.session.id &&
          currentWindow.view.session.hasUnread !== change.session.hasUnread
        ) {
          commitWindow({
            ...currentWindow,
            view: {
              ...currentWindow.view,
              session: { ...currentWindow.view.session, hasUnread: change.session.hasUnread },
            },
          })
        }
        acceptSessionCatalogChange(queryClient, change)
        onSessionReadRef.current?.(change.session)
      } catch {
        if (markedReadRef.current === request) markedReadRef.current = undefined
      }
    },
    [commitWindow, queryClient, sessionId, visible],
  )

  useLayoutEffect(() => {
    return window.pact.onConversationChanged((patch) => {
      cachePatch(patch)
      const failure = patch.runs.at(-1)
      if (
        failure?.status === 'failed' &&
        failure.failureKind === 'context_limit' &&
        lastContextLimitRunRef.current !== failure.id
      ) {
        lastContextLimitRunRef.current = failure.id
        onErrorNotice('The context was too large for the Agent. Your message was saved.')
      }
      void markSelectedRead(
        patch.sessionId,
        patch.messages.findLast(
          (change) => change.message.role === 'assistant' && change.message.state === 'complete',
        )?.message.sequence,
      )
    })
  }, [cachePatch, markSelectedRead, onErrorNotice])

  useEffect(() => {
    if (
      !isProjectionActive ||
      query.data?.scope !== 'messages' ||
      query.data.sessionId !== sessionId
    )
      return
    if (
      query.isError ||
      query.isFetching ||
      (initialPatchesRef.current &&
        (initialPatchesRef.current.receivedAt === undefined ||
          query.dataUpdatedAt < initialPatchesRef.current.receivedAt))
    )
      return
    const current = windowRef.current
    const next =
      current && current.view.sessionId === sessionId
        ? mergeMessagePage(
            current,
            query.data,
            readingMessageIdRef.current &&
              current.view.observation.incarnation === query.data.observation.incarnation
              ? 'older'
              : 'around',
          )
        : windowFromPage(query.data)
    if (!next) return
    if (current && current.view.observation.incarnation !== next.view.observation.incarnation) {
      activityRequestIdRef.current += 1
      activityInFlightRef.current = undefined
      pendingActivityRunRef.current = undefined
      bodyRequestGenerationRef.current += 1
      setLoadingActivityRunId(undefined)
      setExpandedActivityBody(undefined)
      setDraftsReadyRevision(undefined)
      draftReloadTokenRef.current += 1
      setDraftReloadToken((token) => token + 1)
    }
    commitWindow(next)
    setReadPending(false)
    const pending = initialPatchesRef.current
    if (pending?.sessionId === sessionId) {
      initialPatchesRef.current = undefined
      for (const patch of pending.patches) cachePatch(patch)
      if (pending.overflow) {
        setHistoryResyncToken((token) => token + 1)
        setGapRecoveryPending(true)
      } else if (
        pending.resyncGeneration === resyncGenerationRef.current &&
        !Object.values(windowRef.current?.messageMeta ?? {}).some((meta) => meta.bodyResync)
      ) {
        setGapRecoveryPending(false)
      } else {
        // A hidden gap may already have consumed the View token. Reuse its
        // recovery owner only when the resumed page has not repaired the gap.
        setHistoryResyncToken((token) => token + 1)
        setGapRecoveryPending(true)
      }
    }
    const windowLatestAssistantSeq =
      windowRef.current?.view.sessionId === sessionId
        ? windowRef.current.view.messages.findLast(
            (message) => message.role === 'assistant' && message.state === 'complete',
          )?.sequence
        : undefined
    const readThroughSequence =
      query.data.header.latestCompleteAssistantSequence !== undefined &&
      windowLatestAssistantSeq !== undefined
        ? Math.max(query.data.header.latestCompleteAssistantSequence, windowLatestAssistantSeq)
        : (windowLatestAssistantSeq ?? query.data.header.latestCompleteAssistantSequence)
    void markSelectedRead(query.data.sessionId, readThroughSequence)
  }, [
    cachePatch,
    commitWindow,
    isProjectionActive,
    markSelectedRead,
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.isError,
    sessionId,
  ])

  const draftWindowSessionId = windowState?.view.sessionId
  const draftWindowRevision = windowState?.view.commentsRevision
  useEffect(() => {
    const revision = draftWindowSessionId === sessionId ? draftWindowRevision : undefined
    if (!isProjectionActive || !sessionId || revision === undefined) return undefined
    const generation = requestGenerationRef.current
    const reloadToken = draftReloadToken
    let cancelled = false
    void (async () => {
      const drafts: AnchoredComment[] = []
      let afterPosition = draftPageAfter
      const deadline = Date.now() + 10_000
      try {
        for (let pageCount = 0; pageCount < 3; pageCount += 1) {
          if (
            cancelled ||
            generation !== requestGenerationRef.current ||
            reloadToken !== draftReloadTokenRef.current ||
            Date.now() > deadline
          )
            return
          const page = unwrapRpcResult(
            // oxlint-disable-next-line eslint/no-await-in-loop -- Every keyset page depends on the previous position.
            await window.pact.getConversation({
              scope: 'drafts',
              sessionId,
              expectedRevision: revision,
              ...(afterPosition === undefined ? {} : { afterPosition }),
            }),
          )
          if (page.scope !== 'drafts') throw new Error('Unexpected Comment draft page.')
          drafts.push(...page.comments)
          if (
            cancelled ||
            generation !== requestGenerationRef.current ||
            reloadToken !== draftReloadTokenRef.current
          )
            return
          if (!page.hasMore || pageCount === 2) {
            const current = windowRef.current
            if (current?.view.commentsRevision !== revision) return
            commitWindow({ ...current, view: { ...current.view, draftComments: drafts } })
            setDraftLimitExceeded(false)
            setDraftHasMore(page.hasMore)
            setDraftHasEarlier(draftPageAfter !== undefined)
            setDraftsReadyRevision(revision)
            setDraftError(false)
            return
          }
          afterPosition = page.comments.at(-1)?.position
          if (afterPosition === undefined) throw new Error('Comment draft page did not advance.')
        }
        throw new Error('Comment drafts exceeded the page limit.')
      } catch {
        if (
          !cancelled &&
          generation === requestGenerationRef.current &&
          windowRef.current?.view.sessionId === sessionId &&
          windowRef.current.view.commentsRevision === revision
        ) {
          setDraftError(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    commitWindow,
    draftReloadToken,
    draftPageAfter,
    draftWindowRevision,
    draftWindowSessionId,
    isProjectionActive,
    sessionId,
  ])

  const commentWindow = windowState?.view.sessionId === sessionId ? windowState : undefined
  const pendingCommentIds = commentWindow
    ? commentWindow.view.messages
        .filter(
          (message) =>
            commentWindow.messageMeta[message.id]?.hasComments &&
            !commentWindow.loadedCommentMessageIds[message.id],
        )
        .map((message) => message.id)
    : []
  const pendingCommentKey = pendingCommentIds.join(',')
  useEffect(() => {
    if (!visible || !sessionId || !pendingCommentKey) return undefined
    if (commentReadOwner.current.pending) return undefined
    commentReadOwner.current.pending = true
    setLoadingCommentsFor('*')
    const messageIds = pendingCommentKey.split(',')
    const generation = requestGenerationRef.current
    const reloadToken = commentReloadToken
    let cancelled = false
    void (async () => {
      try {
        const page = await readSentComments(
          sessionId,
          messageIds,
          () =>
            !cancelled &&
            generation === requestGenerationRef.current &&
            reloadToken === commentReloadToken,
        )
        if (cancelled || generation !== requestGenerationRef.current) return
        const current = windowRef.current
        if (!current || current.view.sessionId !== sessionId) return
        commitWindow(
          withCommentError(mergeSentComments(current, messageIds, page.comments), undefined),
        )
        setCommentPages((old) =>
          Object.fromEntries(
            current.view.messages
              .filter((message) => current.messageMeta[message.id]?.hasComments)
              .map((message) => [
                message.id,
                messageIds.includes(message.id)
                  ? {
                      hasMore:
                        page.hasMore ||
                        !page.comments.some((comment) => comment.sentWithMessageId === message.id),
                      hasEarlier: false,
                    }
                  : (old[message.id] ?? { hasMore: true, hasEarlier: false }),
              ]),
          ),
        )
      } catch (error) {
        if (cancelled || generation !== requestGenerationRef.current) return
        const current = windowRef.current
        if (!current || current.view.sessionId !== sessionId) return
        commitWindow(
          withCommentError(
            current,
            error instanceof Error ? error.message : 'Comments could not load.',
          ),
        )
      } finally {
        commentReadOwner.current.pending = false
        if (!cancelled && generation === requestGenerationRef.current)
          setLoadingCommentsFor(undefined)
        const next = commentReadOwner.current.desired
        if (next && visibleRef.current) commentPageLoaderRef.current?.(next.messageId, next.first)
        else if (generation !== requestGenerationRef.current && visibleRef.current)
          setCommentReloadToken((value) => value + 1)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [commentReloadToken, commitWindow, pendingCommentKey, sessionId, visible])

  const loadCommentPage = useCallback(
    (messageId: string, first = false): void => {
      if (!sessionId || !visibleRef.current) return
      const owner = commentReadOwner.current
      owner.desired = { messageId, first }
      const read = async (): Promise<void> => {
        if (owner.pending || !owner.desired) return
        const requested = owner.desired
        const current = windowRef.current
        if (
          !current ||
          !current.view.messages.some((message) => message.id === requested.messageId)
        )
          return
        const generation = requestGenerationRef.current
        const afterPosition = requested.first
          ? undefined
          : current.sentCommentsByMessage[requested.messageId]?.at(-1)?.position
        owner.pending = true
        setLoadingCommentsFor(requested.messageId)
        try {
          const page = unwrapRpcResult(
            await window.pact.getConversation({
              scope: 'comments',
              sessionId,
              messageIds: [requested.messageId],
              ...(afterPosition === undefined ? {} : { afterPosition }),
            }),
          )
          if (
            generation !== requestGenerationRef.current ||
            !visibleRef.current ||
            owner.desired !== requested
          )
            return
          if (page.scope !== 'comments') throw new Error('Unexpected Comment page.')
          const latest = windowRef.current
          if (!latest || latest.view.sessionId !== sessionId) return
          commitWindow(
            withCommentError(
              mergeSentComments(latest, [requested.messageId], page.comments),
              undefined,
            ),
          )
          setCommentPages((old) => ({
            ...old,
            [requested.messageId]: {
              hasMore: page.hasMore,
              hasEarlier: afterPosition !== undefined,
            },
          }))
        } catch (error) {
          if (generation === requestGenerationRef.current && windowRef.current)
            commitWindow(
              withCommentError(
                windowRef.current,
                error instanceof Error ? error.message : 'Comments could not be loaded.',
              ),
            )
        } finally {
          owner.pending = false
          if (generation === requestGenerationRef.current) setLoadingCommentsFor(undefined)
          if (
            owner.desired &&
            owner.desired !== requested &&
            generation === requestGenerationRef.current
          )
            void read()
          else if (owner.desired === requested) owner.desired = undefined
        }
      }
      void read()
    },
    [commitWindow, sessionId],
  )
  useEffect(() => {
    commentPageLoaderRef.current = loadCommentPage
  }, [loadCommentPage])

  const loadHistory = useCallback(
    async function loadPage(
      direction: 'older' | 'around' | 'latest',
      messageId?: string,
      historicalSource = false,
      foldingRunId?: string,
    ): Promise<void> {
      const current = windowRef.current
      if (!visibleRef.current || !sessionId || !current) return
      if (direction === 'latest' && !foldingRunId) readingMessageIdRef.current = undefined
      const navigationTarget =
        direction === 'around' && messageId
          ? { messageId, historicalSource }
          : direction === 'latest' && !foldingRunId && !pendingAroundMessageRef.current?.messageId
            ? (pendingAroundMessageRef.current ?? { historicalSource: false })
            : undefined
      if (navigationTarget) pendingAroundMessageRef.current = navigationTarget
      if (pageInFlightRef.current) {
        // One pending target, newest intent wins. Comment navigation is executed
        // after the current page settles instead of requiring another click.
        if (direction === 'latest' && !foldingRunId && !pendingAroundMessageRef.current)
          pendingAroundMessageRef.current = { historicalSource: false }
        return
      }
      const boundary = conversationWindowStartOrder(current)
      if (direction === 'older' && boundary === undefined) return
      const generation = requestGenerationRef.current
      const viewGeneration = snapshotViewGenerationRef.current
      const requestedSnapshotView = snapshotViewRef.current
      const requestedPreserveRunId = foldingRunId ? undefined : preserveRunIdRef.current
      pageInFlightRef.current = true
      setLoadingPage(true)
      setPageError(undefined)
      try {
        const deadline = Date.now() + 30_000
        let fallbackToLatest = false
        // A page may race another invalidation. Retry within the same page owner,
        // never certify stale text or spin indefinitely under a continuous stream.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (Date.now() >= deadline) throw new Error('Conversation recovery timed out. Try again.')
          const resyncGeneration = resyncGenerationRef.current
          let effectiveDirection: 'older' | 'around' = direction === 'older' ? 'older' : 'around'
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each page is checked against concurrent invalidations before another attempt.
          let result = await window.pact.getConversation({
            scope: 'messages',
            sessionId,
            incarnation: current.view.observation.incarnation,
            ...(direction === 'older' ? { beforeDisplay: boundary } : {}),
            ...(requestedSnapshotView ? { snapshotView: requestedSnapshotView } : {}),
            ...(requestedPreserveRunId ? { preserveRunId: requestedPreserveRunId } : {}),
            ...(direction === 'around' && messageId && !fallbackToLatest
              ? { aroundMessageId: messageId, includeHistoricalSource: historicalSource }
              : {}),
          })
          if (generation !== requestGenerationRef.current || !visibleRef.current) return
          if (!result.ok && result.error.code === 'CONFLICT') {
            effectiveDirection = 'around'
            const anchorId =
              direction === 'latest' || fallbackToLatest
                ? undefined
                : (messageId ?? current.view.messages[0]?.id)
            if (Date.now() >= deadline)
              throw new Error('Conversation recovery timed out. Try again.')
            // oxlint-disable-next-line eslint/no-await-in-loop -- A changed repository incarnation requires one unfenced page at the same anchor.
            result = await window.pact.getConversation({
              scope: 'messages',
              sessionId,
              ...(requestedSnapshotView ? { snapshotView: requestedSnapshotView } : {}),
              ...(requestedPreserveRunId ? { preserveRunId: requestedPreserveRunId } : {}),
              ...(anchorId
                ? { aroundMessageId: anchorId, includeHistoricalSource: historicalSource }
                : {}),
            })
          }
          if (generation !== requestGenerationRef.current || !visibleRef.current) return
          if (!result.ok && direction === 'around' && !historicalSource && !fallbackToLatest) {
            if (Date.now() >= deadline)
              throw new Error('Conversation recovery timed out. Try again.')
            fallbackToLatest = true
            readingMessageIdRef.current = undefined
            setReadingPositionLost(true)
            // Explicit Comment navigation keeps its exact target; only a
            // disposable reading-position recovery may fall back to latest.
            // oxlint-disable-next-line no-await-in-loop -- One bounded fallback inside the current recovery owner.
            result = await window.pact.getConversation({
              scope: 'messages',
              sessionId,
              ...(requestedSnapshotView ? { snapshotView: requestedSnapshotView } : {}),
              ...(requestedPreserveRunId ? { preserveRunId: requestedPreserveRunId } : {}),
            })
          }
          if (Date.now() > deadline) throw new Error('Conversation recovery timed out. Try again.')
          const page = unwrapRpcResult(result)
          if (page.scope !== 'messages') throw new Error('Unexpected Message page.')
          if (navigationTarget && pendingAroundMessageRef.current !== navigationTarget) return
          if (
            generation !== requestGenerationRef.current ||
            viewGeneration !== snapshotViewGenerationRef.current
          )
            return
          const resident = windowRef.current
          if (!resident || resident.view.sessionId !== page.sessionId) return
          if (
            resident.view.observation.incarnation !== current.view.observation.incarnation &&
            resident.view.observation.incarnation !== page.observation.incarnation
          )
            return
          if (foldingRunId) {
            if (
              !snapshotFoldGuardRef.current?.() ||
              readingMessageIdRef.current ||
              pendingAroundMessageRef.current ||
              preserveRunIdRef.current !== foldingRunId
            )
              return
            preserveRunIdRef.current = undefined
          }
          if (historicalSource && page.snapshotView) snapshotViewRef.current = page.snapshotView
          const next = mergeMessagePage(resident, page, effectiveDirection)
          commitWindow(next)
          const recovered =
            resyncGeneration === resyncGenerationRef.current &&
            !Object.values(next.messageMeta).some((meta) => meta.bodyResync)
          if (effectiveDirection === 'around' && recovered) setGapRecoveryPending(false)
          if (resident.view.observation.incarnation !== next.view.observation.incarnation) {
            setDraftsReadyRevision(undefined)
            draftReloadTokenRef.current += 1
            setDraftReloadToken(draftReloadTokenRef.current)
          }
          if (
            resident.activityView?.runId !== next.activityView?.runId ||
            resident.view.observation.incarnation !== next.view.observation.incarnation
          ) {
            activityRequestIdRef.current += 1
            activityInFlightRef.current = undefined
            pendingActivityRunRef.current = undefined
            setLoadingActivityRunId(undefined)
            setActivityError(undefined)
            bodyRequestGenerationRef.current += 1
            setExpandedActivityBody(undefined)
          }
          if (effectiveDirection !== 'around' || recovered) {
            if (pendingAroundMessageRef.current === navigationTarget)
              pendingAroundMessageRef.current = undefined
            return
          }
        }
        throw new Error('Conversation is changing. Try again.')
      } catch (error) {
        if (pendingAroundMessageRef.current === navigationTarget)
          pendingAroundMessageRef.current = undefined
        if (
          generation === requestGenerationRef.current &&
          viewGeneration === snapshotViewGenerationRef.current
        ) {
          setPageError(
            error instanceof Error ? error.message : 'Conversation history could not load.',
          )
        }
      } finally {
        if (generation === requestGenerationRef.current) {
          pageInFlightRef.current = false
          setLoadingPage(false)
          const pendingMessageId = pendingAroundMessageRef.current
          if (pendingMessageId)
            void loadPage(
              pendingMessageId.messageId ? 'around' : 'latest',
              pendingMessageId.messageId,
              pendingMessageId.historicalSource,
            )
        }
      }
    },
    [commitWindow, sessionId],
  )

  const collapseEarlierResponses = useCallback(
    async (runId: string): Promise<void> => {
      const current = windowRef.current
      if (
        !current ||
        pageInFlightRef.current ||
        readingMessageIdRef.current ||
        pendingAroundMessageRef.current ||
        current.preserveRunId !== runId ||
        !snapshotFoldGuardRef.current?.()
      )
        return
      snapshotViewGenerationRef.current += 1
      await loadHistory('latest', undefined, false, runId)
    },
    [loadHistory],
  )

  const ensureMessage = useCallback(
    async (messageId: string): Promise<void> => {
      const current = windowRef.current
      const residentMessage = current?.view.messages.find((message) => message.id === messageId)
      if (current && residentMessage) {
        pendingAroundMessageRef.current = undefined
        if (residentMessage.outputSnapshot?.canonical === false && residentMessage.runId) {
          snapshotViewRef.current = { runId: residentMessage.runId, mode: 'expanded' }
          snapshotViewGenerationRef.current += 1
        }
        if (current.sourceMessageId !== messageId)
          commitWindow({ ...current, sourceMessageId: messageId })
        return
      }
      await loadHistory('around', messageId, true)
    },
    [commitWindow, loadHistory],
  )

  const recoverFromGap = useCallback(
    async (messageId: string): Promise<void> => {
      await loadHistory('around', messageId, windowRef.current?.sourceMessageId === messageId)
    },
    [loadHistory],
  )

  const loadRunArtifacts = useCallback(
    async (
      userMessageId: string,
      agentId: RuntimeAgentId,
      before?: { createdAt: string; id: string },
    ): Promise<void> => {
      const current = windowRef.current
      if (!sessionId || !visibleRef.current || !current || artifactRequestRef.current) return
      const generation = requestGenerationRef.current
      const controller = new AbortController()
      artifactRequestRef.current = controller
      setLoadingArtifacts({ userMessageId, agentId })
      setArtifactError(undefined)
      let timer: number | undefined
      let rejectCancelled: (() => void) | undefined
      try {
        const cancelled = new Promise<never>((_, reject) => {
          rejectCancelled = () => reject(new Error('Saved change history loading was cancelled.'))
          controller.signal.addEventListener('abort', rejectCancelled, { once: true })
          timer = window.setTimeout(
            () => reject(new Error('Saved change history took too long. Try again.')),
            30_000,
          )
        })
        const page = unwrapRpcResult(
          await Promise.race([
            window.pact.getConversation({
              scope: 'run-artifacts',
              sessionId,
              userMessageId,
              agentId,
              ...(before ? { before } : {}),
              incarnation: current.view.observation.incarnation,
            }),
            cancelled,
          ]),
        )
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current ||
          artifactRequestRef.current !== controller
        )
          return
        if (
          page.scope !== 'run-artifacts' ||
          page.userMessageId !== userMessageId ||
          page.agentId !== agentId
        )
          throw new Error('Unexpected saved change history.')
        const resident = windowRef.current
        if (resident?.view.sessionId === sessionId)
          commitWindow(mergeRunArtifactPage(resident, page))
      } catch (error) {
        if (
          !controller.signal.aborted &&
          generation === requestGenerationRef.current &&
          artifactRequestRef.current === controller
        )
          setArtifactError({
            userMessageId,
            agentId,
            before,
            message:
              error instanceof Error ? error.message : 'Saved change history could not load.',
          })
      } finally {
        if (timer !== undefined) window.clearTimeout(timer)
        if (rejectCancelled) controller.signal.removeEventListener('abort', rejectCancelled)
        if (artifactRequestRef.current === controller) {
          artifactRequestRef.current = undefined
          setLoadingArtifacts(undefined)
        }
      }
    },
    [commitWindow, sessionId],
  )

  useEffect(() => {
    if (!visible || query.data?.scope !== 'messages' || query.data.sessionId !== sessionId) return
    if (
      query.isError ||
      query.isFetching ||
      (initialPatchesRef.current &&
        (initialPatchesRef.current.receivedAt === undefined ||
          query.dataUpdatedAt < initialPatchesRef.current.receivedAt))
    )
      return
    const selected = windowRef.current?.activityView
    const run = query.data.header.latestRun
    // Selection restores durable progress once, rather than waiting for another
    // Delta to recreate it. Reuse the bounded, generation-fenced Work log reader.
    if (selected?.manual) void loadActivities(selected.runId, true)
    else if (
      run &&
      (['starting', 'running', 'recovering'].includes(run.status) ||
        windowRef.current?.activityView?.runId === run.id)
    )
      void loadActivities(run.id, true)
  }, [
    loadActivities,
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.isError,
    sessionId,
    visible,
  ])

  const loadMoreActivityBody = useCallback(
    (source: ActivityBodySource): void => {
      if (!sessionId || source.bodyBytes > CONVERSATION_EXPAND_BYTES) return
      if (activeBodyReadsRef.current >= 2) return
      const requestGeneration = requestGenerationRef.current
      const bodyGeneration = ++bodyRequestGenerationRef.current
      setExpandedActivityBody({
        activityId: source.activityId,
        revision: source.revision,
        text: source.preview,
        loading: true,
      })
      activeBodyReadsRef.current += 1
      void (async () => {
        const isCurrent = (): boolean =>
          requestGeneration === requestGenerationRef.current &&
          bodyGeneration === bodyRequestGenerationRef.current
        try {
          const text = await readActivityBody(sessionId, source, isCurrent)
          if (isCurrent()) {
            setExpandedActivityBody({
              activityId: source.activityId,
              revision: source.revision,
              text,
              loading: false,
            })
          }
        } catch (error) {
          if (isCurrent()) {
            setExpandedActivityBody({
              activityId: source.activityId,
              revision: source.revision,
              text: source.preview,
              loading: false,
              error: error instanceof Error ? error.message : 'The detail could not load.',
            })
          }
        } finally {
          activeBodyReadsRef.current -= 1
        }
      })()
    },
    [sessionId],
  )

  const {
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
  } = useConversationActions({
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
  })

  const visibleWindow = windowState?.view.sessionId === sessionId ? windowState : undefined
  // Suppress only this exact check error, and only while its Agent has a
  // visible durable recovery card. Other errors and lost projections remain visible.
  return {
    snapshot: visibleWindow?.view,
    composer,
    composerUserInformation,
    setComposerUserInformation,
    composerImages,
    choosingImages: Boolean(currentOperations?.choosingImages),
    addComposerImages,
    chooseComposerImages,
    removeComposerImage,
    setComposer,
    setComposerDocument,
    composerRoute: composerDraft?.route,
    composerReturnedInputOperationId:
      composerDraft?.returnedInputOperationId ?? composerDraft?.queueReturnOperationId,
    composerSkills,
    setComposerSkills,
    composerMention,
    setComposerMention,
    composerRevision: composerDraft?.revision ?? 0,
    seedComposerDraft,
    clearSubmittedComposerDraft,
    syncToMain,
    loading: Boolean(sessionId && visible && (query.isFetching || (!query.isError && readPending))),
    sending,
    stopping,
    error: actionError,
    send,
    acceptPeerProposal,
    dismissPeerProposal,
    saveCommentDraft,
    removeCommentDraft,
    undoWorkspaceChanges,
    respondNativePermission,
    respondNativeInput,
    nativeInputDrafts,
    setNativeInputDraft,
    stop,
    rebuildNativeContext,
    checkNativeContext,
    history: {
      decisionDraft: composerDraft?.decisionAnswers,
      setDecisionDraft,
      clearDecisionDraft,
      informationCancellation: currentOperations?.informationCancellation
        ? {
            request: currentOperations.informationCancellation.request,
            status: currentOperations.informationCancellation.status,
            error: currentOperations.informationCancellation.error,
          }
        : undefined,
      cancelledInformationDecisionId: currentOperations?.cancelledInformationDecisionId,
      cancelPreparedInformation,
      checkInformationCancellation,
      queueActions: {
        pending: Boolean(currentOperations?.queueOperationId) || restoringInput,
        steer: () => performQueueAction('steer'),
        remove: () => performQueueAction('remove'),
        resume: () => performQueueAction('resume'),
        checkStatus: checkQueuedDelivery,
        setEnabled: (enabled) => performQueueAction('enabled', enabled),
        returnToComposer: () => returnQueuedInputToComposer(true),
        restoreReturned: () => returnQueuedInputToComposer(false),
      },
      admitComposerEdit: (nextChars) =>
        Boolean(
          sessionId &&
          admitComposerResidency(composerDraftsRef.current, undefined, {
            sessionId,
            chars: nextChars,
          }),
        ),
      restoringInput,
      restoreReturnedInput,
      discardReturnedInput,
      protectReading,
      readingPositionLost: Boolean(visibleWindow && readingPositionLost),
      readError: query.error?.message,
      retryRead: () => {
        if (sessionId && projectionActiveRef.current)
          void refetchConversation({ cancelRefetch: false })
      },
      window: visibleWindow,
      loadingPage: Boolean(visibleWindow && loadingPage),
      gapRecoveryPending: Boolean(visibleWindow && gapRecoveryPending),
      loadingActivityRunId: visibleWindow ? loadingActivityRunId : undefined,
      draftLimitExceeded: Boolean(visibleWindow && draftLimitExceeded),
      draftPage: { hasMore: draftHasMore, hasEarlier: draftHasEarlier },
      loadMoreDrafts: () => {
        const cursor = windowRef.current?.view.draftComments.at(-1)?.position
        if (cursor !== undefined && draftHasMore) setDraftPageAfter(cursor)
      },
      firstDraftPage: () => setDraftPageAfter(undefined),
      draftsLoading: !visibleWindow || draftsReadyRevision !== visibleWindow.view.commentsRevision,
      draftError: Boolean(visibleWindow && draftError),
      retryDrafts: () => {
        setDraftError(false)
        draftReloadTokenRef.current += 1
        setDraftReloadToken(draftReloadTokenRef.current)
      },
      retryComments: () => {
        if (windowRef.current) commitWindow(withCommentError(windowRef.current, undefined))
        setCommentReloadToken((current) => current + 1)
      },
      commentPages,
      loadingCommentsFor,
      loadCommentPage,
      oversizedActivities: visibleWindow?.activityMeta ?? EMPTY_ACTIVITY_META,
      expandedActivityBody: visibleWindow ? expandedActivityBody : undefined,
      pageError: visibleWindow ? pageError : undefined,
      activityError: visibleWindow ? activityError : undefined,
      loadOlder: () => loadHistory('older'),
      loadLatest: () => {
        pendingAroundMessageRef.current = { historicalSource: false }
        snapshotViewRef.current = undefined
        snapshotViewGenerationRef.current += 1
        return loadHistory('latest')
      },
      recoverLatest: () => loadHistory('latest'),
      collapseEarlierResponses,
      setSnapshotFoldGuard: (guard) => {
        snapshotFoldGuardRef.current = guard
      },
      recoverFromGap,
      historyResyncToken: visibleWindow ? historyResyncToken : 0,
      ensureMessage,
      loadActivities,
      setActivityReading: (runId, reading) => {
        setActivityReading(runId, reading)
        const selected = windowRef.current?.activityView
        if (!reading && selected) void loadActivities(selected.runId, true)
      },
      loadRunArtifacts,
      closeRunArtifacts: () => {
        artifactRequestRef.current?.abort()
        artifactRequestRef.current = undefined
        setLoadingArtifacts(undefined)
        setArtifactError(undefined)
        if (windowRef.current) commitWindow(closeRunArtifacts(windowRef.current))
      },
      loadingArtifacts: visibleWindow ? loadingArtifacts : undefined,
      artifactError: visibleWindow ? artifactError : undefined,
      loadMoreActivityBody,
    },
  }
}
