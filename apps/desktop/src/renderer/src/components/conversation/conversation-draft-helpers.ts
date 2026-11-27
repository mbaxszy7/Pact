import type {
  AnchoredComment,
  CollaborationDecisionQuestions,
  ConversationSendInput,
  NativeContextRebuildInput,
  NativeInputValues,
  NativePermissionRequest,
  RuntimeAgentId,
  SkillSelection,
} from '@pact/contracts'

import {
  CONVERSATION_EXPAND_BYTES,
  CONVERSATION_PAGE_ITEMS,
  NATIVE_PERMISSION_TIMEOUT_MS,
} from '@pact/contracts'

import type { DraftImage } from './image-client'

import { unwrapRpcResult } from '../../query-client'
import {
  nativeInputRequests,
  type ActivityBodySource,
  type ConversationViewProjection,
  type ConversationWindow,
  type ExpandedActivityBody,
  type LoadMoreActivityBody,
} from './conversation-window'

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
const decisionAnswerMarkdownText = (text: string) => text.replace(/[\\`*_[\]<>]/gu, '\\$&')

export function formatDecisionAnswers(draft: DecisionAnswerDraft): string {
  if (!draft.questions.length) return draft.originalReply?.trim() ?? ''
  return draft.questions
    .flatMap((question, index) => {
      const answer = draft.answers[question.id]
      if (!answer || (!answer.optionIds.length && !answer.text.trim())) return []
      const choices =
        question.options?.filter((option) => answer.optionIds.includes(option.id)) ?? []
      return [
        [
          `**${index + 1}. ${decisionAnswerMarkdownText(question.prompt)}**`,
          '',
          '**Your answer:**',
          '',
          ...choices.map(
            (option) =>
              `- ${decisionAnswerMarkdownText(option.label)}${option.description ? ` — ${decisionAnswerMarkdownText(option.description)}` : ''}`,
          ),
          ...(answer.text.trim() ? ['', decisionAnswerMarkdownText(answer.text.trim())] : []),
        ].join('\n'),
      ]
    })
    .join('\n\n')
}

export interface ConversationHistoryControls {
  decisionDraft?: DecisionAnswerDraft | undefined
  setDecisionDraft?: ((draft: DecisionAnswerDraft) => boolean) | undefined
  clearDecisionDraft?: ((keepInMessage: boolean) => boolean) | undefined
  informationCancellation?:
    | {
        request: import('@pact/contracts').RelaySchedulingDecision
        status: 'submitting' | 'checking_receipt' | 'receipt_unconfirmed'
        error?: string | undefined
      }
    | undefined
  cancelledInformationDecisionId?: string | undefined
  cancelPreparedInformation?:
    | ((request: import('@pact/contracts').RelaySchedulingDecision) => Promise<boolean>)
    | undefined
  checkInformationCancellation?: (() => Promise<boolean>) | undefined
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

export const EMPTY_ACTIVITY_META: ConversationWindow['activityMeta'] = {}
export const EMPTY_COMPOSER_IMAGES: readonly DraftImage[] = []
export const EMPTY_COMPOSER_SKILLS: SkillSelection[] = []
export const bodyTextEncoder = new TextEncoder()
export const MAX_SENT_COMMENTS = CONVERSATION_PAGE_ITEMS * 3
export const MAX_SENT_COMMENT_PAGES = Math.ceil(MAX_SENT_COMMENTS / CONVERSATION_PAGE_ITEMS)
export const MAX_SENT_COMMENT_BYTES = 48 * 1024 * 3
export const INITIAL_SYNC_TIMEOUT_MS = 15_000
export const INLINE_INPUT_BYTES = 64 * 1024
export const INPUT_UPLOAD_TIMEOUT_MS = 10_000
export const INPUT_UPLOAD_CHARS = 8192
export const MAX_PENDING_SYNC_MAIN_SESSIONS = 32

export interface PendingSyncMain {
  operationId: string
  content: string
  imageIds: string[]
  commentIds: string[]
  skills: SkillSelection[]
  userInformation?: import('@pact/contracts').UserInformationDeclaration | undefined
  expectedRevision: number
  expectedCommentsRevision: number
  inputId?: string | undefined
  contentSha256?: string | undefined
  inputPreparation?: AbortController | undefined
}

export function sameSyncMainPayload(
  left: PendingSyncMain,
  right: Omit<PendingSyncMain, 'operationId' | 'inputPreparation' | 'inputId' | 'contentSha256'>,
): boolean {
  return (
    left.content === right.content &&
    left.expectedRevision === right.expectedRevision &&
    left.expectedCommentsRevision === right.expectedCommentsRevision &&
    left.imageIds.length === right.imageIds.length &&
    left.imageIds.every((id, index) => id === right.imageIds[index]) &&
    left.commentIds.length === right.commentIds.length &&
    left.commentIds.every((id, index) => id === right.commentIds[index]) &&
    JSON.stringify(left.skills) === JSON.stringify(right.skills) &&
    JSON.stringify(left.userInformation ?? null) === JSON.stringify(right.userInformation ?? null)
  )
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bodyTextEncoder.encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function releasePreparedInput(targetSessionId: string, targetInputId: string): void {
  void window.pact
    .writeConversationInput({
      type: 'release',
      sessionId: targetSessionId,
      inputId: targetInputId,
    })
    .catch(() => undefined)
}

/** Uploads oversized conversation text via bounded UTF-16 chunks before submit/sync-back. */
export async function uploadLargeConversationInput(params: {
  sessionId: string
  clientMessageId: string
  content: string
  controller: AbortController
  cancelErrorMessage: string
  startErrorMessage: string
  appendErrorMessage: string
  sealErrorMessage: string
  cancelledCheckErrorMessage: string
  onInputId?: (inputId: string | undefined) => void
  isCurrent?: () => boolean
}): Promise<string> {
  const { sessionId, clientMessageId, content, controller } = params
  let preparedInputId: string | undefined
  const timeout = window.setTimeout(() => controller.abort(), INPUT_UPLOAD_TIMEOUT_MS)
  const write = (input: Parameters<typeof window.pact.writeConversationInput>[0]) =>
    new Promise<Awaited<ReturnType<typeof window.pact.writeConversationInput>>>(
      (resolve, reject) => {
        const abort = () => reject(new Error(params.cancelErrorMessage))
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
    const initial = unwrapRpcResult(await write({ type: 'begin', sessionId, clientMessageId }))
    preparedInputId = initial.inputId
    params.onInputId?.(preparedInputId)
    if (initial.offset !== 0 || initial.sealed) throw new Error(params.startErrorMessage)
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
          inputId: preparedInputId,
          offset,
          text: content.slice(offset, end),
        }),
      )
      if (part.inputId !== preparedInputId || part.offset !== end || part.sealed)
        throw new Error(params.appendErrorMessage)
      offset = end
    }
    const sealed = unwrapRpcResult(
      await write({ type: 'seal', sessionId, inputId: preparedInputId }),
    )
    if (
      !sealed.sealed ||
      sealed.inputId !== preparedInputId ||
      sealed.offset !== content.length ||
      sealed.chars !== content.length
    )
      throw new Error(params.sealErrorMessage)
    if (controller.signal.aborted || (params.isCurrent && !params.isCurrent()))
      throw new Error(params.cancelledCheckErrorMessage)
    return preparedInputId
  } catch (error) {
    if (preparedInputId) {
      params.onInputId?.(undefined)
      void window.pact
        .writeConversationInput({ type: 'release', sessionId, inputId: preparedInputId })
        .catch(() => undefined)
    }
    throw error
  } finally {
    window.clearTimeout(timeout)
  }
}

export async function readActivityBody(
  sessionId: string,
  source: ActivityBodySource,
  isCurrent: () => boolean,
): Promise<string> {
  if (source.bodyBytes > CONVERSATION_EXPAND_BYTES) {
    throw new Error('This work log entry is too large to expand here.')
  }
  const chunks = [source.preview]
  let offset = source.previewChars
  let loadedBytes = bodyTextEncoder.encode(source.preview).byteLength
  const deadline = Date.now() + 30_000
  for (let pageCount = 0; pageCount < 256; pageCount += 1) {
    if (!isCurrent()) throw new Error('Loading was cancelled.')
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
      throw new Error('Work log details changed. Try again.')
    if (!isCurrent()) throw new Error('Loading was cancelled.')
    loadedBytes += bodyTextEncoder.encode(page.text).byteLength
    if (loadedBytes > CONVERSATION_EXPAND_BYTES) {
      throw new Error('This work log entry is too large to expand here.')
    }
    chunks.push(page.text)
    if (page.nextOffset === undefined) {
      if (loadedBytes !== source.bodyBytes) {
        throw new Error('Work log details changed while loading. Try again.')
      }
      return chunks.join('')
    }
    if (page.nextOffset <= offset) throw new Error('Couldn’t load the next part of the work log.')
    offset = page.nextOffset
  }
  throw new Error('This work log entry is too long to display in full.')
}

export async function readSentComments(
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
    if (Date.now() > deadline) throw new Error('Loading comments took too long. Try again.')
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
      throw new Error('Couldn’t load comments for this session.')
    }
    if (!isCurrent()) return { comments: [], hasMore: false }
    for (const comment of page.comments) {
      if (!comment.sentWithMessageId || !requested.has(comment.sentWithMessageId)) {
        throw new Error('Couldn’t match loaded comments to these messages.')
      }
      if (afterPosition !== undefined && comment.position <= afterPosition) {
        throw new Error('Couldn’t load the next page of comments.')
      }
      bytes += encoder.encode(JSON.stringify(comment)).byteLength
      if (comments.length >= MAX_SENT_COMMENTS || bytes > MAX_SENT_COMMENT_BYTES)
        return { comments, hasMore: true }
      comments.push(comment)
      afterPosition = comment.position
    }
    if (!page.hasMore) return { comments, hasMore: false }
    if (pageCount === MAX_SENT_COMMENT_PAGES - 1) return { comments, hasMore: true }
    if (page.comments.length === 0) throw new Error('Couldn’t load the next page of comments.')
  }
  throw new Error('Too many comments to display at once.')
}

export interface ConversationFlow {
  snapshot: ConversationViewProjection | undefined
  composer: string
  /** Legacy draft metadata remains available to in-flight receipts, without a Composer control. */
  composerUserInformation: import('@pact/contracts').UserInformationDeclaration | undefined
  setComposerUserInformation(
    value: import('@pact/contracts').UserInformationDeclaration | undefined,
  ): boolean
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
  composerRevision: number
  seedComposerDraft(
    targetSessionId: string,
    value: import('./composer-document').ComposerDocument,
    options?: { onConflict?: (() => void) | undefined },
  ): boolean
  clearSubmittedComposerDraft(
    targetSessionId: string,
    expectedRevision: number,
    consumedImageIds?: readonly string[],
  ): void
  syncToMain?: (
    content: string,
    commentIds: string[],
    skills?: SkillSelection[],
  ) => Promise<import('@pact/contracts').SideChatSyncMainReceipt | undefined>
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
    replaceTask?: ConversationSendInput['replaceTask'],
  ): Promise<boolean>
  acceptPeerProposal(proposalId: string): Promise<boolean>
  dismissPeerProposal(proposalId: string): Promise<boolean>
  saveCommentDraft(input: CommentDraftInputWithoutRevision): Promise<CommentDraftSaveOutcome>
  removeCommentDraft(commentId: string): Promise<boolean>
  undoWorkspaceChanges(changeSetId: string, path?: string): Promise<boolean>
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
  stop(background?: import('@pact/contracts').BackgroundStopTarget): Promise<boolean>
  checkNativeContext(agentId: RuntimeAgentId, runId?: string): Promise<boolean>
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

export function liveNativeDraft(
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

export interface ConversationComposerDraft {
  userInformation?: import('@pact/contracts').UserInformationDeclaration | undefined
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

export interface PendingSubmission {
  kind: 'message' | 'decision'
  askOnly?: ConversationSendInput['askOnly']
  replyToDecision?: ConversationSendInput['replyToDecision'] | undefined
  replaceTask?: ConversationSendInput['replaceTask'] | undefined
  userInformation?: import('@pact/contracts').UserInformationDeclaration | undefined
  sourceDocument: ConversationComposerDraft
  imageIds: string[]
  inputId?: string | undefined
  inputPreparation?: AbortController | undefined
  composerRevision?: number
  routeIntent?: NonNullable<ConversationSendInput['routeIntent']>
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

export interface ReturnedInputRead {
  sessionId: string
  controller: AbortController
  draft?: ConversationComposerDraft
  commentBytes?: number
}

export function emptyComposerDraft(value: ConversationComposerDraft): boolean {
  return (
    !value.userInformation &&
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

export const INFORMATION_CANCELLATION_ITEMS = 32

export interface InformationCancellation {
  request: import('@pact/contracts').RelaySchedulingDecision
  input: import('@pact/contracts').RelayDecisionAnswer
  declaration?: import('@pact/contracts').UserInformationDeclaration | undefined
  status: 'submitting' | 'checking_receipt' | 'receipt_unconfirmed'
  busy: boolean
  error?: string | undefined
}

export interface SessionOperationState {
  informationCancellation?: InformationCancellation | undefined
  cancelledInformationDecisionId?: string | undefined
  choosingImages?: boolean | undefined
  sendingOperationId?: string | undefined
  stoppingOperationId?: string | undefined
  queueOperationId?: string | undefined
  nativeCheck?: { operationId: string; runId: string } | undefined
  error?: string | undefined
}
