import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { SkillSelection } from '@pact/contracts'
import type {
  AnchoredComment,
  CollaborationDecisionQuestions,
  ConversationPatch,
  ConversationPage,
  ConversationSendInput,
  ConversationQueueActionInput,
  RuntimeAgentId,
  NativeInputValues,
  NativePermissionRequest,
  NativeContextRebuildInput,
  ConversationSnapshotView,
} from '@pact/contracts'

import {
  CONVERSATION_EXPAND_BYTES,
  CONVERSATION_PAGE_ITEMS,
  CONVERSATION_STREAM_BATCH_ITEMS,
  CONVERSATION_STREAM_BATCH_BYTES,
  NATIVE_PERMISSION_REQUESTS,
  NATIVE_PERMISSION_TIMEOUT_MS,
  nativeInputValuesSchema,
} from '@pact/contracts'
import { IMAGE_REFERENCE_ITEMS, type ConversationImage } from '@pact/contracts/images'

import { conversationQueryKeys, RpcError, unwrapRpcResult } from '../../query-client'
import { acceptSessionCatalogChange, patchCatalogSession } from '../workspace/session-catalog-cache'
import {
  assertComposerEditCapacity,
  assertComposerEditLengths,
  composerEncodedTextBytes,
  COMPOSER_DRAFT_BYTES,
  COMPOSER_DRAFT_ITEMS,
} from './composer-capacity'
import { releaseComposerRoute } from './composer-document'
import {
  mergeActivityPage,
  mergeRunArtifactPage,
  closeRunArtifacts,
  mergeConversationPatch,
  mergeMessagePage,
  mergeSentComments,
  windowFromPage,
  withCommentError,
  nativeInputRequests,
  conversationWindowStartOrder,
  isRunResponseComplete,
  type ActivityBodySource,
  type ConversationWindow,
  type ConversationViewProjection,
  type ExpandedActivityBody,
  type LoadMoreActivityBody,
} from './conversation-window'
import { uploadConversationImage, releaseDraftImage, type DraftImage } from './image-client'

export interface DecisionReplyContext {
  reference: NonNullable<ConversationSendInput['replyToDecision']>
  questions: CollaborationDecisionQuestions
}
export interface DecisionAnswerDraft extends DecisionReplyContext {
  originalReply?: string | undefined
  answers: Record<string, { optionIds: string[]; text: string }>
}
export const sameDecision = (
  left: DecisionReplyContext['reference'] | undefined,
  right: DecisionReplyContext['reference'] | undefined,
): boolean => JSON.stringify(left) === JSON.stringify(right)
export const hasDecisionAnswers = (draft: DecisionAnswerDraft | undefined): boolean =>
  Boolean(
    draft &&
    (draft.originalReply?.trim() ||
      Object.values(draft.answers).some((answer) => answer.optionIds.length || answer.text.trim())),
  )
function formatDecisionAnswers(draft: DecisionAnswerDraft): string {
  if (!draft.questions.length) return draft.originalReply?.trim() ?? ''
  return draft.questions
    .flatMap((question) => {
      const answer = draft.answers[question.id]
      if (!answer || (!answer.optionIds.length && !answer.text.trim())) return []
      const choices =
        question.options?.filter((option) => answer.optionIds.includes(option.id)) ?? []
      return [
        `Question: ${question.prompt}`,
        ...choices.map(
          (option) =>
            `Selected: ${option.label}${option.description ? ` — ${option.description}` : ''}`,
        ),
        ...(answer.text.trim() ? [`My answer: ${answer.text.trim()}`] : []),
        '',
      ]
    })
    .join('\n')
    .trim()
}

export interface ConversationHistoryControls {
  decisionDraft?: DecisionAnswerDraft | undefined
  setDecisionDraft?: ((draft: DecisionAnswerDraft) => boolean) | undefined
  clearDecisionDraft?: ((keepInMessage: boolean) => boolean) | undefined
  collapseEarlierResponses?: ((runId: string) => Promise<void>) | undefined
  setSnapshotFoldGuard?: ((guard: (() => boolean) | undefined) => void) | undefined
  queueActions?: {
    pending: boolean
    steer: () => Promise<boolean>
    remove: () => Promise<boolean>
    returnToComposer: () => Promise<boolean>
    restoreReturned: () => Promise<boolean>
    resume: () => Promise<boolean>
    checkStatus: () => Promise<boolean>
    setEnabled: (enabled: boolean) => Promise<boolean>
  }
  admitComposerEdit?: ((nextChars: number) => boolean) | undefined
  restoringInput?: boolean
  restoreReturnedInput?: () => Promise<boolean>
  discardReturnedInput?: () => Promise<boolean>
  protectReading: (messageId: string | undefined) => void
  readingPositionLost: boolean
  readError?: string | undefined
  retryRead: () => void
  window?: ConversationWindow | undefined
  loadingPage: boolean
  gapRecoveryPending: boolean
  loadingActivityRunId?: string | undefined
  draftLimitExceeded: boolean
  draftPage?: { hasMore: boolean; hasEarlier: boolean } | undefined
  loadMoreDrafts?: (() => void) | undefined
  firstDraftPage?: (() => void) | undefined
  draftsLoading: boolean
  draftError: boolean
  retryDrafts: () => void
  retryComments: () => void
  commentPages?: Record<string, { hasMore: boolean; hasEarlier: boolean }> | undefined
  loadingCommentsFor?: string | undefined
  loadCommentPage?: ((messageId: string, first?: boolean) => void) | undefined
  oversizedActivities: ConversationWindow['activityMeta']
  pageError?: string | undefined
  activityError?: { runId: string; message: string } | undefined
  loadOlder: () => Promise<void>
  loadLatest: () => Promise<void>
  recoverLatest?: (() => Promise<void>) | undefined
  recoverFromGap: (messageId: string) => Promise<void>
  historyResyncToken: number
  ensureMessage: (messageId: string) => Promise<void>
  loadActivities: (runId: string, automatic?: boolean) => Promise<void>
  setActivityReading?: ((runId: string, reading: boolean) => void) | undefined
  loadRunArtifacts: (
    userMessageId: string,
    agentId: RuntimeAgentId,
    before?: { createdAt: string; id: string },
  ) => Promise<void>
  closeRunArtifacts: () => void
  loadingArtifacts?: { userMessageId: string; agentId: RuntimeAgentId } | undefined
  artifactError?:
    | {
        userMessageId: string
        agentId: RuntimeAgentId
        message: string
        before?: { createdAt: string; id: string } | undefined
      }
    | undefined
  expandedActivityBody?: ExpandedActivityBody | undefined
  loadMoreActivityBody: LoadMoreActivityBody
}

const EMPTY_ACTIVITY_META: ConversationWindow['activityMeta'] = {}
const bodyTextEncoder = new TextEncoder()
const MAX_SENT_COMMENTS = CONVERSATION_PAGE_ITEMS * 3
const MAX_SENT_COMMENT_PAGES = Math.ceil(MAX_SENT_COMMENTS / CONVERSATION_PAGE_ITEMS)
const MAX_SENT_COMMENT_BYTES = 48 * 1024 * 3
const INITIAL_SYNC_TIMEOUT_MS = 15_000
const INLINE_INPUT_BYTES = 64 * 1024
const INPUT_UPLOAD_TIMEOUT_MS = 10_000
const INPUT_UPLOAD_CHARS = 8192

async function readActivityBody(
  sessionId: string,
  source: ActivityBodySource,
  isCurrent: () => boolean,
): Promise<string> {
  if (source.bodyBytes > CONVERSATION_EXPAND_BYTES) {
    throw new Error('This Work log detail exceeds the inline reading limit.')
  }
  const chunks = [source.preview]
  let offset = source.previewChars
  let loadedBytes = bodyTextEncoder.encode(source.preview).byteLength
  const deadline = Date.now() + 30_000
  for (let pageCount = 0; pageCount < 256; pageCount += 1) {
    if (!isCurrent()) throw new Error('The content request was cancelled.')
    if (Date.now() > deadline) throw new Error('Loading took too long. Try again.')
    const page = unwrapRpcResult(
      // oxlint-disable-next-line eslint/no-await-in-loop -- The next offset comes from this bounded page.
      await window.pact.getConversation({
        scope: 'activity-body',
        sessionId,
        activityId: source.activityId,
        detailRevision: source.revision,
        offset,
      }),
    )
    if (
      page.scope !== 'activity-body' ||
      page.activityId !== source.activityId ||
      page.detailRevision !== source.revision ||
      page.offset !== offset
    )
      throw new Error('The Work log detail changed or could not load. Try again.')
    if (!isCurrent()) throw new Error('The content request was cancelled.')
    loadedBytes += bodyTextEncoder.encode(page.text).byteLength
    if (loadedBytes > CONVERSATION_EXPAND_BYTES) {
      throw new Error('This Work log detail exceeds the inline reading limit.')
    }
    chunks.push(page.text)
    if (page.nextOffset === undefined) {
      if (loadedBytes !== source.bodyBytes) {
        throw new Error('The Work log detail changed while loading. Try again.')
      }
      return chunks.join('')
    }
    if (page.nextOffset <= offset) throw new Error('The content did not advance.')
    offset = page.nextOffset
  }
  throw new Error('This Work log detail exceeds the inline page limit.')
}

async function readSentComments(
  sessionId: string,
  messageIds: string[],
  isCurrent: () => boolean,
): Promise<{ comments: AnchoredComment[]; hasMore: boolean }> {
  const requested = new Set(messageIds)
  const comments: AnchoredComment[] = []
  const encoder = new TextEncoder()
  const deadline = Date.now() + 10_000
  let afterPosition: number | undefined
  let bytes = 0
  for (let pageCount = 0; pageCount <= MAX_SENT_COMMENT_PAGES; pageCount += 1) {
    if (!isCurrent()) return { comments: [], hasMore: false }
    if (Date.now() > deadline) throw new Error('Comment loading timed out.')
    const page = unwrapRpcResult(
      // oxlint-disable-next-line eslint/no-await-in-loop -- Every bounded page supplies the next cursor.
      await window.pact.getConversation({
        scope: 'comments',
        sessionId,
        messageIds,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      }),
    )
    if (page.scope !== 'comments' || page.sessionId !== sessionId) {
      throw new Error('The Comment response did not match this Session.')
    }
    if (!isCurrent()) return { comments: [], hasMore: false }
    for (const comment of page.comments) {
      if (!comment.sentWithMessageId || !requested.has(comment.sentWithMessageId)) {
        throw new Error('The Comment response did not match the visible Messages.')
      }
      if (afterPosition !== undefined && comment.position <= afterPosition) {
        throw new Error('The Comment response did not advance.')
      }
      bytes += encoder.encode(JSON.stringify(comment)).byteLength
      if (comments.length >= MAX_SENT_COMMENTS || bytes > MAX_SENT_COMMENT_BYTES)
        return { comments, hasMore: true }
      comments.push(comment)
      afterPosition = comment.position
    }
    if (!page.hasMore) return { comments, hasMore: false }
    if (pageCount === MAX_SENT_COMMENT_PAGES - 1) return { comments, hasMore: true }
    if (page.comments.length === 0) throw new Error('The Comment response did not advance.')
  }
  throw new Error('Visible Comments exceed the safe page limit.')
}

export interface ConversationFlow {
  snapshot: ConversationViewProjection | undefined
  composer: string
  choosingImages: boolean
  composerImages: readonly DraftImage[]
  addComposerImages(this: void, files: readonly File[]): Promise<void>
  chooseComposerImages(this: void): Promise<void>
  removeComposerImage(this: void, id: string): void
  setComposer(value: string): void
  setComposerDocument(value: import('./composer-document').ComposerDocument): boolean
  composerRoute: import('./composer-document').ComposerDocument['route']
  composerReturnedInputOperationId: string | undefined
  composerSkills: SkillSelection[]
  setComposerSkills(value: SkillSelection[]): void
  composerMention: ConversationComposerMention | undefined
  setComposerMention(value: ConversationComposerMention | undefined): void
  loading: boolean
  sending: boolean
  stopping: boolean
  error: string | undefined
  send(
    content: string,
    commentIds: string[],
    route?: NonNullable<ConversationSendInput['route']>,
    skills?: SkillSelection[],
    decision?: DecisionReplyContext,
  ): Promise<boolean>
  acceptPeerProposal(proposalId: string): Promise<boolean>
  dismissPeerProposal(proposalId: string): Promise<boolean>
  saveCommentDraft(input: CommentDraftInputWithoutRevision): Promise<CommentDraftSaveOutcome>
  removeCommentDraft(commentId: string): Promise<boolean>
  undoWorkspaceChanges(changeSetId: string): Promise<boolean>
  respondNativePermission(
    runId: string,
    permissionId: string,
    decision: import('@pact/contracts').NativePermissionDecision,
  ): Promise<boolean>
  respondNativeInput(input: import('@pact/contracts').NativeInputRespond): Promise<boolean>
  nativeInputDrafts: Record<string, NativeInputDraft>
  setNativeInputDraft(
    this: void,
    request: NativePermissionRequest,
    draft: Pick<NativeInputDraft, 'values' | 'page'>,
    initializeOnly?: boolean,
  ): void
  stop(): Promise<boolean>
  checkNativeContext(agentId: RuntimeAgentId): Promise<boolean>
  rebuildNativeContext(
    agentId: RuntimeAgentId,
    options?: Omit<NativeContextRebuildInput, 'sessionId' | 'agentId'>,
  ): Promise<boolean>
  history: ConversationHistoryControls
}

export interface NativeInputDraft {
  operationId: string
  agentId: RuntimeAgentId
  bindingGeneration?: number | undefined
  executorId?: string | undefined
  expiresAt: number
  values: NativeInputValues
  page: number
}

function liveNativeDraft(
  interaction: ReturnType<typeof nativeInputRequests>[number],
  draft: NativeInputDraft,
): boolean {
  return (
    interaction.request.operationId === draft.operationId &&
    interaction.agentId === draft.agentId &&
    interaction.bindingGeneration === draft.bindingGeneration &&
    interaction.executorId === draft.executorId &&
    Date.parse(interaction.request.createdAt) + NATIVE_PERMISSION_TIMEOUT_MS === draft.expiresAt &&
    draft.expiresAt > Date.now()
  )
}

export type ConversationComposerMention = import('./composer-document').ComposerMention

interface ConversationComposerDraft {
  decisionAnswers?: DecisionAnswerDraft | undefined
  text: string
  images?: DraftImage[] | undefined
  revision?: number
  returnedInputOperationId?: string | undefined
  queueReturnOperationId?: string | undefined
  skills?: SkillSelection[] | undefined
  mention?: ConversationComposerMention | undefined
  route?: import('./composer-document').ComposerDocument['route']
}

export type CommentDraftInputWithoutRevision =
  | {
      mode: 'create'
      requestId?: string | undefined
      sessionId: string
      commentId: string
      body: string
      anchor: Extract<import('@pact/contracts').CommentDraftSaveInput, { mode: 'create' }>['anchor']
    }
  | {
      mode: 'edit'
      requestId?: string | undefined
      sessionId: string
      commentId: string
      body: string
    }

export type CommentDraftSaveOutcome = boolean | string | { conflict: true }
export const commentDraftSaveSucceeded = (value: CommentDraftSaveOutcome): value is true | string =>
  value === true || (typeof value === 'string' && value.length > 0)

interface PendingSubmission {
  kind: 'message' | 'decision'
  replyToDecision?: ConversationSendInput['replyToDecision'] | undefined
  sourceDocument: ConversationComposerDraft
  imageIds: string[]
  inputId?: string | undefined
  inputPreparation?: AbortController | undefined
  composerRevision?: number
  returnedInputOperationId?: string | undefined
  queueReturnOperationId?: string | undefined
  acknowledgementError?: string
  operationId: string
  clientMessageId: string
  content: string
  composerSnapshot: string
  skills?: SkillSelection[] | undefined
  commentIds: string[]
  expectedCommentsRevision: number
  route?: NonNullable<ConversationSendInput['route']> | undefined
}

interface ReturnedInputRead {
  sessionId: string
  controller: AbortController
  draft?: ConversationComposerDraft
  commentBytes?: number
}

function emptyComposerDraft(value: ConversationComposerDraft): boolean {
  return (
    !hasDecisionAnswers(value.decisionAnswers) &&
    !value.images?.length &&
    !value.text &&
    !value.skills?.length &&
    !value.mention &&
    !value.returnedInputOperationId &&
    !value.queueReturnOperationId &&
    (!value.route || (value.route.type === 'primary' && !value.route.agentId))
  )
}

export function shouldClearComposerAfterAck(
  currentComposer: string,
  pending: Pick<PendingSubmission, 'composerSnapshot'>,
): boolean {
  return currentComposer === pending.composerSnapshot
}

interface SessionOperationState {
  choosingImages?: boolean | undefined
  sendingOperationId?: string | undefined
  stoppingOperationId?: string | undefined
  queueOperationId?: string | undefined
  nativeCheck?: { operationId: string; runId: string } | undefined
  error?: string | undefined
}

export function useConversation(
  sessionId: string | undefined,
  onNotice: (message: string) => void,
  visible = true,
  onErrorNotice: (message: string) => void = onNotice,
  onInfoNotice: (message: string) => void = onNotice,
): ConversationFlow {
  const queryClient = useQueryClient()
  const [operationsBySession, setOperationsBySession] = useState<
    Record<string, SessionOperationState>
  >({})
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
  const queueOperation = useRef<
    { sessionId: string; operationId: string; controller: AbortController } | undefined
  >(undefined)
  const [restoringInput, setRestoringInput] = useState(false)
  const returnAttempt = useRef<string | undefined>(undefined)
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
              commentIds: value.commentIds,
              replyToDecision: value.replyToDecision,
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
            }),
          ).byteLength
        if (value.decisionAnswers) bytes += JSON.stringify(value.decisionAnswers).length * 2
        if (bytes > COMPOSER_DRAFT_BYTES || items > COMPOSER_DRAFT_ITEMS) break
      }
      if (textCandidate) {
        items += 1
        bytes += textCandidate.chars * 2 + 64 * 1024 + 1024
        const answers = drafts[textCandidate.sessionId]?.decisionAnswers
        if (answers) bytes += JSON.stringify(answers).length * 3
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
  const visibleRef = useRef(visible)
  useLayoutEffect(() => {
    visibleRef.current = visible
  }, [visible])
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
          !visibleRef.current ||
          initialPatchesRef.current?.generation !== generation ||
          snapshotViewGeneration !== snapshotViewGenerationRef.current
        )
          throw new DOMException('Conversation read cancelled.', 'AbortError')
      }
      const read = async () => {
        checkCurrent()
        unwrapRpcResult(await window.pact.setConversationInterest(sessionId ?? null, generation))
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
    enabled: Boolean(sessionId && visible),
    retry: 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  })
  const refetchConversation = query.refetch
  /* oxlint-disable react/set-state-in-effect -- Visibility cancels external reads and settles their pending UI state. */
  useEffect(() => {
    // Selection changes must activate even a fresh cached page (gcTime:0 is
    // asynchronous). Join an existing fetch instead of duplicating its read.
    if (sessionId && visible) void refetchConversation({ cancelRefetch: false })
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
      void window.pact
        .setConversationInterest(null, ++interestGenerationRef.current)
        .catch(() => undefined)
    }
  }, [queryClient, refetchConversation, sessionId, visible])
  /* oxlint-enable react/set-state-in-effect */
  useEffect(
    () => () => {
      initialPatchesRef.current = undefined
      returnOperation.current?.controller.abort()
      returnOperation.current = undefined
      queueOperation.current?.controller.abort()
      queueOperation.current = undefined
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
      void window.pact
        .setConversationInterest(null, ++interestGenerationRef.current)
        .catch(() => undefined)
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
  const composerImages = composerDraft?.images ?? []
  const composerMention = composerDraft?.mention
  const composerSkills = composerDraft?.skills ?? []
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
                    error: 'Image preparation took too long. Remove it and try again.',
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
      setOperationsBySession((current) => ({
        ...current,
        [ownerSessionId]: update(current[ownerSessionId] ?? {}),
      }))
    },
    [],
  )

  const settleSubmission = useCallback(
    (ownerSessionId: string, clientMessageId: string): void => {
      const pending = pendingBySessionRef.current.get(ownerSessionId)
      if (!pending || pending.clientMessageId !== clientMessageId) return
      pendingBySessionRef.current.delete(ownerSessionId)
      const settleDraft = (
        draft: ConversationComposerDraft | undefined,
      ): ConversationComposerDraft | undefined => {
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
      if (!visible) return
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
    [acknowledgePatch, commitWindow, queryClient, sessionId, visible, loadActivities],
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
        acceptSessionCatalogChange(queryClient, change)
      } catch {
        if (markedReadRef.current === request) markedReadRef.current = undefined
      }
    },
    [queryClient, sessionId, visible],
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
    if (!visible || query.data?.scope !== 'messages' || query.data.sessionId !== sessionId) return
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
    void markSelectedRead(query.data.sessionId, query.data.header.latestCompleteAssistantSequence)
  }, [
    cachePatch,
    commitWindow,
    markSelectedRead,
    query.data,
    query.dataUpdatedAt,
    query.isFetching,
    query.isError,
    sessionId,
    visible,
  ])

  const draftWindowSessionId = windowState?.view.sessionId
  const draftWindowRevision = windowState?.view.commentsRevision
  useEffect(() => {
    const revision = draftWindowSessionId === sessionId ? draftWindowRevision : undefined
    if (!visible || !sessionId || revision === undefined) return undefined
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
    sessionId,
    visible,
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

  const send = async (
    composerSnapshot: string,
    commentIds: string[],
    route?: NonNullable<ConversationSendInput['route']>,
    skills?: SkillSelection[],
    decision?: DecisionReplyContext,
  ): Promise<boolean> => {
    if (!sessionId || sending || returnOperation.current?.sessionId === sessionId) return false
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
    const content = decision ? `Replies to your questions:\n${answers}` : original
    const submissionSkills = decision ? undefined : skills
    const selectedRoute = decision ? undefined : route
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
        JSON.stringify(pending.route) !== JSON.stringify(selectedRoute) ||
        JSON.stringify(pending.skills ?? []) !== JSON.stringify(submissionSkills ?? []) ||
        !sameDecision(pending.replyToDecision, decision?.reference))
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
    const submissionRoute = preserved?.route ?? selectedRoute
    const clientMessageId = preserved?.clientMessageId ?? crypto.randomUUID()
    const operationId = crypto.randomUUID()
    const sourceDocument =
      preserved?.sourceDocument ??
      (latestComposerDraft.current?.sessionId === sessionId
        ? latestComposerDraft.current.draft
        : (composerDraftsRef.current[sessionId] ?? { text: composerSnapshot }))
    const frozen: PendingSubmission = {
      kind: decision ? 'decision' : 'message',
      sourceDocument,
      imageIds: preserved?.imageIds ?? imageIds,
      inputId: preserved?.inputId,
      composerRevision:
        (latestComposerDraft.current?.sessionId === sessionId
          ? latestComposerDraft.current.draft
          : composerDraftsBySession[sessionId]
        )?.revision ?? 0,
      returnedInputOperationId: decision
        ? undefined
        : composerDraftsBySession[sessionId]?.returnedInputOperationId,
      queueReturnOperationId: decision
        ? undefined
        : (preserved?.queueReturnOperationId ?? sourceDocument.queueReturnOperationId),
      operationId,
      content,
      composerSnapshot,
      skills: preserved?.skills ?? submissionSkills,
      commentIds: submissionCommentIds,
      expectedCommentsRevision,
      clientMessageId,
      route: submissionRoute,
      replyToDecision: preserved?.replyToDecision ?? decision?.reference,
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
      ...(frozen.replyToDecision ? { replyToDecision: frozen.replyToDecision } : {}),
      commentIds: [],
      freezeDrafts: frozen.kind !== 'decision',
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
        const timeout = window.setTimeout(() => controller.abort(), INPUT_UPLOAD_TIMEOUT_MS)
        const write = (input: Parameters<typeof window.pact.writeConversationInput>[0]) =>
          new Promise<Awaited<ReturnType<typeof window.pact.writeConversationInput>>>(
            (resolve, reject) => {
              const abort = () =>
                reject(
                  new Error('Input preparation was cancelled or timed out. Your draft was kept.'),
                )
              controller.signal.addEventListener('abort', abort, { once: true })
              if (controller.signal.aborted) {
                controller.signal.removeEventListener('abort', abort)
                abort()
                return
              }
              void window.pact.writeConversationInput(input).then(
                (reply) => {
                  controller.signal.removeEventListener('abort', abort)
                  if (controller.signal.aborted) {
                    if (reply.ok)
                      void window.pact
                        .writeConversationInput({
                          type: 'release',
                          sessionId,
                          inputId: reply.value.inputId,
                        })
                        .catch(() => undefined)
                    return undefined
                  }
                  resolve(reply)
                  return undefined
                },
                (writeError: unknown) => {
                  controller.signal.removeEventListener('abort', abort)
                  reject(writeError)
                  return undefined
                },
              )
            },
          )
        try {
          const initial = unwrapRpcResult(
            await write({ type: 'begin', sessionId, clientMessageId }),
          )
          frozen.inputId = initial.inputId
          if (initial.offset !== 0 || initial.sealed)
            throw new Error('Input preparation returned an unexpected source.')
          let offset = 0
          while (offset < content.length) {
            let end = Math.min(content.length, offset + INPUT_UPLOAD_CHARS)
            const high = content.charCodeAt(end - 1),
              low = content.charCodeAt(end)
            if (
              end < content.length &&
              high >= 0xd800 &&
              high <= 0xdbff &&
              low >= 0xdc00 &&
              low <= 0xdfff
            )
              end -= 1
            const part: import('@pact/contracts').ConversationInputState = unwrapRpcResult(
              // oxlint-disable-next-line no-await-in-loop -- Each bounded UTF-16 segment follows the acknowledged offset under one deadline.
              await write({
                type: 'append',
                sessionId,
                inputId: frozen.inputId,
                offset,
                text: content.slice(offset, end),
              }),
            )
            if (part.inputId !== frozen.inputId || part.offset !== end || part.sealed)
              throw new Error('Input preparation did not acknowledge the complete segment.')
            offset = end
          }
          const sealed = unwrapRpcResult(
            await write({ type: 'seal', sessionId, inputId: frozen.inputId }),
          )
          if (
            !sealed.sealed ||
            sealed.inputId !== frozen.inputId ||
            sealed.offset !== content.length ||
            sealed.chars !== content.length
          )
            throw new Error('Input preparation did not seal the complete text.')
          if (controller.signal.aborted || pendingBySessionRef.current.get(sessionId) !== frozen)
            throw new Error('Input preparation was cancelled. Your draft was kept.')
        } finally {
          window.clearTimeout(timeout)
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
        !result.value.messages.some((item) => item.message.id === clientMessageId)
      )
        onInfoNotice("Your message is queued until the current Agent's work finishes.")
      if (result.value.sessionId === sessionId) settleSubmission(sessionId, clientMessageId)
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

  const refreshConflictedDrafts = async (ownerSessionId: string): Promise<void> => {
    if (activeSessionIdRef.current !== ownerSessionId || !visibleRef.current) return
    setDraftsReadyRevision(undefined)
    // A read started before the rejected save may itself contain the stale revision.
    // Cancel that observation and obtain a new authoritative page after the conflict.
    const result = await refetchConversation({ cancelRefetch: true })
    if (activeSessionIdRef.current !== ownerSessionId || !visibleRef.current) return
    draftReloadTokenRef.current += 1
    setDraftReloadToken(draftReloadTokenRef.current)
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

  const undoWorkspaceChanges = async (changeSetId: string): Promise<boolean> => {
    if (!sessionId) return false
    try {
      const result = await window.pact.undoWorkspaceChanges({ changeSetId })
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

  const checkNativeContext = (agentId: RuntimeAgentId): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false)
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
      returnOperation.current ||
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
      returnOperation.current ||
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
    returnOperation.current = owner
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
        returnOperation.current !== owner ||
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
        returnOperation.current !== owner ||
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
      if (returnOperation.current === owner) {
        returnOperation.current = undefined
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
                      error: 'Image preparation was cancelled. Remove it and try again.',
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
        returnOperation.current ||
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
      returnOperation.current = owner
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
          returnOperation.current !== owner ||
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
                : '@claude'
          let candidate: RegExpExecArray | undefined,
            ambiguous = false
          for (const entry of text.matchAll(/(?:^|\s)(@(claude|codex|all))(?=\s|$)/gu)) {
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
          returnOperation.current !== owner ||
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
        if (returnOperation.current === owner) {
          returnOperation.current = undefined
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
      const current = returnOperation.current
      if (current && current.sessionId === ownerSession) {
        current.controller.abort()
        returnOperation.current = undefined
        setRestoringInput(false)
      }
      const queueOwner = queueOperation.current
      if (queueOwner && queueOwner.sessionId === ownerSession) {
        queueOwner.controller.abort()
        queueOperation.current = undefined
      }
    }
  }, [sessionId])

  const discardReturnedInput = async (): Promise<boolean> => {
    if (!sessionId || !recovery || returnOperation.current) return false
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

  const stop = async (): Promise<boolean> => {
    if (!sessionId || stopping) return false
    const preparing = pendingBySessionRef.current.get(sessionId)?.inputPreparation
    if (preparing) {
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
      const result = await window.pact.stopConversation({ sessionId })
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

  const visibleWindow = windowState?.view.sessionId === sessionId ? windowState : undefined
  // Suppress only this exact check error, and only while its Agent has a
  // visible durable recovery card. Other errors and lost projections remain visible.
  return {
    snapshot: visibleWindow?.view,
    composer,
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
        if (sessionId && visibleRef.current) void refetchConversation({ cancelRefetch: false })
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
