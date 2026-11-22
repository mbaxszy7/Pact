import { createHash } from 'node:crypto'

import type {
  AgentRun,
  ConversationPatch,
  ConversationSendInput,
  CreateSideChatInput,
  CreateSideChatReceipt,
  DiscardEmptySideChatInput,
  DiscardEmptySideChatResult,
  FrozenSkillInvocation,
  ListSideChatsInput,
  ListSideChatsPage,
  OriginSideChat,
  PendingNativeInteraction,
  ReadSideChatReceiptInput,
  RpcResult,
  RuntimeAgentId,
  SessionIssues,
  SideChatSyncMainInput,
  SideChatSyncMainReceipt,
} from '@pact/contracts'
import type { ConversationRepository, SessionRepository } from '@pact/persistence'

import {
  AGENTS,
  collaborationInputGate,
  parseComposerCommandPrefix,
  resolveMainChatSyncTarget,
  validateSideChatMainSyncContent,
} from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationImages } from './conversation-images'

const MAX_AGENT_OPERATIONS = 5
const PREPARATION_TIMEOUT_MS = 10_000
const AGY_PREPARATION_TIMEOUT_MS = 38_000
const BACKGROUND_INPUT_REASON = 'Check the background work before sending another message.'

export interface ConversationSideChatHost {
  readonly conversations: ConversationRepository
  readonly sessions: SessionRepository
  readonly images?: ConversationImages | undefined
  isDisposed(): boolean
  nativeQuitSealed(): boolean
  shuttingDown(): RpcResult<never>
  quitPrepared(): RpcResult<never>
  archiveBusy(): RpcResult<never>
  nativeRecoveryRequired(): RpcResult<never>
  capacityFailure(): RpcResult<never>
  sendFailure(error: unknown): RpcResult<never>
  sessionIssues(
    sessionId: string,
    contexts: NonNullable<ConversationPatch['nativeContexts']>,
  ): SessionIssues
  pendingNativeInteractions(sessionId: string): PendingNativeInteraction[]
  hasBlockingBackgroundWork(sessionId: string): boolean
  hasSessionOperation(sessionId: string, includePreparingContinuation?: boolean): boolean
  hasCachedAdapterForSession(sessionId: string): boolean
  activeExecutionRun(sessionId: string): AgentRun | undefined
  operationCount(): number
  nativeMetadataChanged(): void
  publish(patch: ConversationPatch, progress?: boolean): void
  prepareSkillInvocation(
    input: Pick<ConversationSendInput, 'sessionId' | 'content' | 'skills'>,
    targets: readonly RuntimeAgentId[],
    signal: AbortSignal,
  ): Promise<FrozenSkillInvocation | undefined>
  sendWithSyncOptions(
    input: ConversationSendInput,
    ownerKey: string | undefined,
    options: { originSideChat: OriginSideChat; syncMainOperationId: string },
  ): Promise<RpcResult<ConversationPatch>>
}

export function stripLeadingMainToken(
  content: string,
  skills: NonNullable<ConversationSendInput['skills']>,
): { content: string; skills: NonNullable<ConversationSendInput['skills']> } {
  const match = /^([ \t]*@Main)(?=[ \t\r\n]|$)([ \t]*)/iu.exec(content)
  if (!match) {
    return { content, skills: skills.map((entry) => ({ ...entry })) }
  }
  const removeEnd = match[0].length
  const nextContent = content.slice(removeEnd)
  const shiftedSkills = skills.flatMap((entry) => {
    if (entry.end <= removeEnd) return []
    if (entry.start < removeEnd) {
      throw new RunOperationConflictError('Skill selection overlaps the leading @Main mention.')
    }
    return [
      {
        ...entry,
        start: entry.start - removeEnd,
        end: entry.end - removeEnd,
      },
    ]
  })
  return { content: nextContent, skills: shiftedSkills }
}

export function checkSideChatSyncGateFailure(
  host: ConversationSideChatHost,
  sideChatId: string,
  parentSessionId: string,
): RpcResult<never> | undefined {
  if (host.isDisposed()) return host.shuttingDown()
  if (host.nativeQuitSealed()) return host.quitPrepared()
  if (
    host.conversations.archives.blocksSession(sideChatId) ||
    host.conversations.archives.blocksSession(parentSessionId)
  ) {
    return host.archiveBusy()
  }
  const sideChat = host.sessions.find(sideChatId)
  if (!sideChat || sideChat.parentSessionId !== parentSessionId || sideChat.status === 'archived') {
    throw new RunOperationConflictError('The side chat is unavailable.')
  }
  const parent = host.sessions.find(parentSessionId)
  if (!parent || parent.status === 'archived' || parent.parentSessionId) {
    throw new RunOperationConflictError('The parent Session is unavailable.')
  }
  if (host.pendingNativeInteractions(sideChatId).length > 0) {
    throw new RunOperationConflictError(
      'Respond to the pending native permission or question in this side chat first.',
    )
  }
  if (
    host.conversations.nativeRecoveryBlocksInput(sideChatId) ||
    host.conversations.nativeRecoveryBlocksInput(parentSessionId)
  ) {
    return host.nativeRecoveryRequired()
  }
  if (host.hasBlockingBackgroundWork(parentSessionId)) {
    throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
  }
  host.conversations.assertRelayDecisionResolved(parentSessionId, undefined, true)
  return undefined
}

export async function createSideChat(
  host: ConversationSideChatHost,
  input: CreateSideChatInput,
): Promise<RpcResult<CreateSideChatReceipt>> {
  if (host.isDisposed()) return host.shuttingDown()
  if (host.nativeQuitSealed()) return host.quitPrepared()
  if (host.conversations.archives.blocksSession(input.parentSessionId)) return host.archiveBusy()
  try {
    const parent = host.sessions.find(input.parentSessionId)
    if (!parent || parent.status === 'archived') {
      throw new RunOperationConflictError('The parent Session is unavailable.')
    }
    if (parent.parentSessionId) {
      throw new RunOperationConflictError('Side chats cannot be nested inside another side chat.')
    }
    if (
      input.origin === 'btw' &&
      !host.conversations.readCreateSideChatReceipt(input.operationId)
    ) {
      const issues = host.sessionIssues(
        input.parentSessionId,
        host.conversations.nativeContexts(input.parentSessionId),
      )
      if (issues.inputGate === 'read_only') {
        throw new RunOperationConflictError(
          'Finish or recover the active Fork before running /btw.',
        )
      }
      if (host.conversations.nativeRecoveryBlocksInput(input.parentSessionId)) {
        return host.nativeRecoveryRequired()
      }
      if (issues.inputGate === 'send_blocked') {
        throw new RunOperationConflictError(
          'Resolve the pending Session issue before running /btw.',
        )
      }
      if (host.pendingNativeInteractions(input.parentSessionId).length > 0) {
        throw new RunOperationConflictError(
          'Respond to the pending native permission or question before running /btw.',
        )
      }
      if (host.hasBlockingBackgroundWork(input.parentSessionId)) {
        throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
      }
      host.conversations.assertRelayDecisionResolved(input.parentSessionId, undefined, true)
      const received = host.conversations.receivedCollaborationInput(input.parentSessionId)
      if (received?.state === 'blocked') {
        throw new RunOperationConflictError(
          'Resolve the blocked queued message before running /btw.',
        )
      }
      host.conversations.assertDecisionInput({
        sessionId: input.parentSessionId,
        content: '',
        imageIds: [],
        commentIds: [],
        route: { type: 'primary' },
      })
      const savedTask = host.conversations.collaboration(input.parentSessionId)
      const task = savedTask?.status === 'complete' ? undefined : savedTask
      const taskGate = task ? collaborationInputGate(task) : undefined
      if (taskGate === 'needs_reply' || taskGate === 'incomplete') {
        throw new RunOperationConflictError(
          'Respond to the current workflow question or recovery prompt before running /btw.',
        )
      }
    }
    const { markdownVisibleProjection } = await import('../../shared/message-anchor-text.js')
    const receipt = host.conversations.createSideChat(input, {
      resolveVisibleText: markdownVisibleProjection,
    })
    host.nativeMetadataChanged()
    return { ok: true, value: receipt }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export function readCreateSideChatReceipt(
  host: ConversationSideChatHost,
  input: ReadSideChatReceiptInput,
): RpcResult<CreateSideChatReceipt | null> {
  if (host.isDisposed()) return host.shuttingDown()
  try {
    return {
      ok: true,
      value: host.conversations.readCreateSideChatReceipt(input.operationId) ?? null,
    }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export function listSideChats(
  host: ConversationSideChatHost,
  input: ListSideChatsInput,
): RpcResult<ListSideChatsPage> {
  if (host.isDisposed()) return host.shuttingDown()
  try {
    const parent = host.sessions.find(input.parentSessionId)
    if (!parent) {
      throw new RunOperationConflictError('The parent Session does not exist.')
    }
    if (parent.parentSessionId) {
      throw new RunOperationConflictError('Side chats cannot contain nested side chats.')
    }
    return { ok: true, value: host.sessions.listSideChatsPage(input) }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export function discardEmptySideChat(
  host: ConversationSideChatHost,
  input: DiscardEmptySideChatInput,
): RpcResult<DiscardEmptySideChatResult> {
  if (host.isDisposed() || host.nativeQuitSealed()) return { ok: true, value: { discarded: false } }
  if (
    host.conversations.archives.blocksSession(input.sideChatId) ||
    host.hasSessionOperation(input.sideChatId, true) ||
    host.hasCachedAdapterForSession(input.sideChatId)
  ) {
    return { ok: true, value: { discarded: false } }
  }
  try {
    const discarded = host.conversations.discardEmptySideChat(input.sideChatId)
    if (discarded) host.nativeMetadataChanged()
    return { ok: true, value: { discarded } }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export function readSyncSideChatReceipt(
  host: ConversationSideChatHost,
  input: ReadSideChatReceiptInput,
): RpcResult<SideChatSyncMainReceipt | null> {
  if (host.isDisposed()) return host.shuttingDown()
  try {
    return {
      ok: true,
      value: host.conversations.readSyncSideChatReceipt(input.operationId) ?? null,
    }
  } catch (error) {
    return host.sendFailure(error)
  }
}

export async function syncSideChatToMain(
  host: ConversationSideChatHost,
  input: SideChatSyncMainInput,
  ownerKey?: string,
): Promise<RpcResult<SideChatSyncMainReceipt>> {
  let releaseSourceImages: (() => void) | undefined
  let releaseClonedImages: (() => void) | undefined
  let preparedNeedsRollback = false
  let preparedCommentCount = 0
  let sealedInputId: string | undefined
  const releaseSealedInput = (): void => {
    if (!sealedInputId || !ownerKey) return
    const id = sealedInputId
    sealedInputId = undefined
    try {
      host.conversations.writeConversationInput(
        { type: 'release', sessionId: input.sideChatId, inputId: id },
        ownerKey,
      )
    } catch {
      // Best-effort cleanup of temporary side-chat @Main input segments.
    }
  }
  const skillController = new AbortController()
  let skillTimeout: ReturnType<typeof setTimeout> | undefined
  try {
    if (host.isDisposed()) return host.shuttingDown()
    if (input.inputId) {
      if (!ownerKey) {
        throw new RunOperationConflictError('Prepared input owner is unavailable.')
      }
      if (
        host.conversations.ownsTemporaryConversationInput(input.sideChatId, input.inputId, ownerKey)
      ) {
        sealedInputId = input.inputId
      }
    }
    if (host.nativeQuitSealed()) return host.quitPrepared()
    if (host.conversations.archives.blocksSession(input.sideChatId)) return host.archiveBusy()

    const sideChat = host.sessions.find(input.sideChatId)
    if (!sideChat || !sideChat.parentSessionId || sideChat.status === 'archived') {
      throw new RunOperationConflictError('The side chat is unavailable.')
    }
    const parentSessionId = sideChat.parentSessionId
    if (host.conversations.archives.blocksSession(parentSessionId)) return host.archiveBusy()
    const parent = host.sessions.find(parentSessionId)
    if (!parent || parent.status === 'archived' || parent.parentSessionId) {
      throw new RunOperationConflictError('The parent Session is unavailable.')
    }

    let rawContent = input.content
    let hasResolvedInput = false
    if (input.inputId) {
      if (sealedInputId || !host.conversations.readSyncSideChatReceipt(input.operationId)) {
        sealedInputId = input.inputId
        rawContent = host.conversations.resolveConversationInput(
          input.sideChatId,
          input.operationId,
          input.inputId,
          ownerKey!,
        )
        hasResolvedInput = true
      }
    }
    if (input.contentSha256 && (hasResolvedInput || !input.inputId)) {
      const expectedDigest = input.contentSha256.toLowerCase()
      const actualDigest = createHash('sha256').update(rawContent, 'utf8').digest('hex')
      if (actualDigest !== expectedDigest) {
        throw new RunOperationConflictError('The prepared message changed before sending.')
      }
    }

    if (host.conversations.readSyncSideChatReceipt(input.operationId)) {
      const verified = host.conversations.prepareMainSyncBack(input, ownerKey)
      if (verified.existingReceipt) return { ok: true, value: verified.existingReceipt }
    }

    const prePrepGateFailure = checkSideChatSyncGateFailure(host, input.sideChatId, parentSessionId)
    if (prePrepGateFailure) return prePrepGateFailure

    const stripped = stripLeadingMainToken(rawContent, input.skills)
    if (
      !stripped.content.trim() &&
      !input.imageIds.length &&
      input.commentIds.length === 0 &&
      !host.conversations.hasSideChatDrafts(input.sideChatId)
    ) {
      throw new RunOperationConflictError(
        'Write a message, add a Comment, or attach an image before sending to main.',
      )
    }
    const syncValidation = validateSideChatMainSyncContent(stripped.content, stripped.skills)
    if (!syncValidation.ok) {
      throw new RunOperationConflictError(syncValidation.message)
    }
    const prefix = parseComposerCommandPrefix(stripped.content, stripped.skills)

    const parentSavedTask = host.conversations.collaboration(parentSessionId)
    const parentTask = parentSavedTask?.status === 'complete' ? undefined : parentSavedTask
    const parentWaitingForWork =
      parentTask?.status === 'running' || host.hasSessionOperation(parentSessionId)
    if (
      input.userInformation &&
      (parentTask ||
        parentWaitingForWork ||
        stripped.skills.length ||
        input.imageIds.length ||
        prefix.skills.length)
    ) {
      throw new RunOperationConflictError(
        'Reserved information supports a new ordinary message only. Remove it before queueing, replying to a workflow, using Skills, images, or @all. Your draft was kept.',
      )
    }

    host.conversations.assertRelayDecisionResolved(parentSessionId, undefined, true)
    host.conversations.assertDecisionInput({
      sessionId: parentSessionId,
      content: stripped.content,
      imageIds: input.imageIds,
      commentIds: [],
      skills: stripped.skills,
      route: { type: 'primary' },
    })
    if (host.conversations.receivedCollaborationInput(parentSessionId)) {
      throw new RunOperationConflictError(
        'One message is already queued on the parent Session. Your draft was preserved.',
      )
    }
    if (host.conversations.nativeRecoveryBlocksInput(parentSessionId))
      return host.nativeRecoveryRequired()
    if (host.hasBlockingBackgroundWork(parentSessionId))
      throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)

    if (parentTask || parentWaitingForWork) {
      const parentPatch = host.conversations.metadataPatch(parentSessionId)
      if (!parentTask && !parentPatch.queue?.enabled) {
        throw new RunOperationConflictError('The queue is disabled. Your draft was preserved.')
      }
      const anchor =
        host.activeExecutionRun(parentSessionId) ??
        (parentTask ? host.conversations.findRun(parentTask.runId) : undefined) ??
        AGENTS.map((agentId) => host.conversations.latestAgentRun(parentSessionId, agentId))
          .filter((run): run is AgentRun => Boolean(run))
          .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
      if (!anchor) {
        throw new RunOperationConflictError(
          'Wait for the current execution to start before queuing a message.',
        )
      }
    } else {
      if (host.conversations.hasPendingRoutedContinuation(parentSessionId)) {
        throw new RunOperationConflictError(
          'Wait for or stop the remaining @all response before sending another message.',
        )
      }
      if (
        host.conversations
          .nativeContexts(parentSessionId)
          .some(
            (context) =>
              context.continuationState === 'responding' ||
              context.continuationState === 'waiting_user',
          )
      )
        return host.capacityFailure()
      if (host.operationCount() >= MAX_AGENT_OPERATIONS) return host.capacityFailure()
    }

    host.conversations.assertTaskReplacement({ sessionId: parentSessionId }, false)
    const defaultParentActor = resolveMainChatSyncTarget(parent.settings.primaryAgentId, parentTask)
    const parentTargets: RuntimeAgentId[] = [defaultParentActor]
    const preparationTimeoutMs =
      defaultParentActor === 'agy' ? AGY_PREPARATION_TIMEOUT_MS : PREPARATION_TIMEOUT_MS
    skillTimeout = setTimeout(() => skillController.abort(), preparationTimeoutMs)
    await host.prepareSkillInvocation(
      { sessionId: parentSessionId, content: stripped.content, skills: stripped.skills },
      parentTargets,
      skillController.signal,
    )

    const postPrepGateFailure = checkSideChatSyncGateFailure(
      host,
      input.sideChatId,
      parentSessionId,
    )
    if (postPrepGateFailure) return postPrepGateFailure

    if (input.imageIds.length) {
      if (!host.images) throw new Error('Image input is unavailable.')
      host.conversations.resolveMessageImages(input.sideChatId, input.imageIds, ownerKey)
      releaseSourceImages = host.images.hold(input.imageIds)
    }

    const { markdownVisibleProjection } = await import('../../shared/message-anchor-text.js')
    const prepared = host.conversations.prepareMainSyncBack(input, ownerKey, rawContent, {
      resolveVisibleText: markdownVisibleProjection,
    })
    if (prepared.existingReceipt) {
      return { ok: true, value: prepared.existingReceipt }
    }
    preparedNeedsRollback = true
    preparedCommentCount = prepared.mainCommentIds.length

    if (prepared.mainImageIds.length && host.images) {
      releaseClonedImages = host.images.hold(prepared.mainImageIds)
    }

    const parentDrafts = host.conversations.readPage({
      scope: 'drafts',
      sessionId: parentSessionId,
    })
    const expectedParentCommentsRevision =
      parentDrafts.scope === 'drafts' ? parentDrafts.commentsRevision : 0
    const sendInput: ConversationSendInput = {
      sessionId: prepared.parentSessionId,
      clientMessageId: prepared.mainMessageId,
      content: stripped.content,
      route: { type: 'primary' },
      ...(stripped.skills.length ? { skills: stripped.skills } : {}),
      ...(prepared.mainImageIds.length ? { imageIds: prepared.mainImageIds } : {}),
      commentIds: prepared.mainCommentIds,
      expectedCommentsRevision: expectedParentCommentsRevision,
      ...(input.userInformation ? { userInformation: input.userInformation } : {}),
    }
    const sent = await host.sendWithSyncOptions(sendInput, ownerKey, {
      originSideChat: prepared.originSideChat,
      syncMainOperationId: input.operationId,
    })
    if (!sent.ok) {
      const finalized = host.conversations.readSyncSideChatReceipt(input.operationId)
      if (finalized) {
        preparedNeedsRollback = false
        if (prepared.mainCommentIds.length > 0) {
          host.publish(host.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }))
        }
        return { ok: true, value: finalized }
      }
      host.conversations.rollbackMainSyncBack(input.operationId)
      preparedNeedsRollback = false
      return sent
    }
    const receipt = host.conversations.readSyncSideChatReceipt(input.operationId)
    if (!receipt) {
      host.conversations.rollbackMainSyncBack(input.operationId)
      preparedNeedsRollback = false
      throw new RunOperationConflictError(
        'The parent Session could not confirm syncing this message.',
      )
    }
    preparedNeedsRollback = false
    if (prepared.mainCommentIds.length > 0) {
      host.publish(host.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }))
    }
    return { ok: true, value: receipt }
  } catch (error) {
    if (preparedNeedsRollback) {
      const finalized = host.conversations.readSyncSideChatReceipt(input.operationId)
      if (finalized) {
        if (preparedCommentCount > 0) {
          host.publish(host.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }))
        }
        return { ok: true, value: finalized }
      }
      try {
        host.conversations.rollbackMainSyncBack(input.operationId)
      } catch {
        // Best-effort cleanup so rejected sends never leave orphaned sync rows.
      }
    }
    return host.sendFailure(error)
  } finally {
    if (skillTimeout) clearTimeout(skillTimeout)
    releaseSealedInput()
    releaseClonedImages?.()
    releaseSourceImages?.()
  }
}
