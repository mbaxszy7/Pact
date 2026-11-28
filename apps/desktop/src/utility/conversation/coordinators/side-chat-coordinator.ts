import { createHash } from 'node:crypto'

import type {
  AgentRun,
  ConversationSendInput,
  CreateSideChatInput,
  CreateSideChatReceipt,
  DiscardEmptySideChatInput,
  DiscardEmptySideChatResult,
  ListSideChatsInput,
  ListSideChatsPage,
  ReadSideChatReceiptInput,
  RpcResult,
  RuntimeAgentId,
  SideChatSyncMainInput,
  SideChatSyncMainReceipt,
} from '@pact/contracts'

import {
  AGENTS,
  collaborationInputGate,
  parseComposerCommandPrefix,
  resolveMainChatSyncTarget,
  validateSideChatMainSyncContent,
} from '@pact/contracts'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'

import {
  AGY_PREPARATION_TIMEOUT_MS,
  BACKGROUND_INPUT_REASON,
  MAX_AGENT_OPERATIONS,
  PREPARATION_TIMEOUT_MS,
} from '../conversation-types'

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

/**
 * Autonomous deep coordinator owning Side Chat creation, listing, empty discard,
 * and `@Main` sync-back orchestration directly against `ConversationRuntimeCore`.
 * Replaces the former 25-callback `ConversationSideChatHost` bag.
 */
export class SideChatCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  checkSideChatSyncGateFailure(
    sideChatId: string,
    parentSessionId: string,
  ): RpcResult<never> | undefined {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (
      this.core.conversations.archives.blocksSession(sideChatId) ||
      this.core.conversations.archives.blocksSession(parentSessionId)
    ) {
      return this.core.archiveBusy()
    }
    const sideChat = this.core.sessions.find(sideChatId)
    if (
      !sideChat ||
      sideChat.parentSessionId !== parentSessionId ||
      sideChat.status === 'archived'
    ) {
      throw new RunOperationConflictError('The side chat is unavailable.')
    }
    const parent = this.core.sessions.find(parentSessionId)
    if (!parent || parent.status === 'archived' || parent.parentSessionId) {
      throw new RunOperationConflictError('The parent Session is unavailable.')
    }
    if (this.core.interactions.pendingNativeInteractions(sideChatId).length > 0) {
      throw new RunOperationConflictError(
        'Respond to the pending native permission or question in this side chat first.',
      )
    }
    if (
      this.core.conversations.nativeRecoveryBlocksInput(sideChatId) ||
      this.core.conversations.nativeRecoveryBlocksInput(parentSessionId)
    ) {
      return this.core.nativeRecoveryRequired()
    }
    if (this.core.gate.hasBlockingBackgroundWork(parentSessionId)) {
      throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
    }
    this.core.conversations.assertRelayDecisionResolved(parentSessionId, undefined, true)
    return undefined
  }

  async createSideChat(input: CreateSideChatInput): Promise<RpcResult<CreateSideChatReceipt>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    if (this.core.conversations.archives.blocksSession(input.parentSessionId)) {
      return this.core.archiveBusy()
    }
    try {
      const parent = this.core.sessions.find(input.parentSessionId)
      if (!parent || parent.status === 'archived') {
        throw new RunOperationConflictError('The parent Session is unavailable.')
      }
      if (parent.parentSessionId) {
        throw new RunOperationConflictError('Side chats cannot be nested inside another side chat.')
      }
      if (
        input.origin === 'btw' &&
        !this.core.conversations.readCreateSideChatReceipt(input.operationId)
      ) {
        const issues = this.core.gate.sessionIssues(
          input.parentSessionId,
          this.core.conversations.nativeContexts(input.parentSessionId),
        )
        if (issues.inputGate === 'read_only') {
          throw new RunOperationConflictError(
            'Finish or recover the active Fork before running /btw.',
          )
        }
        if (this.core.conversations.nativeRecoveryBlocksInput(input.parentSessionId)) {
          return this.core.nativeRecoveryRequired()
        }
        if (issues.inputGate === 'send_blocked') {
          throw new RunOperationConflictError(
            'Resolve the pending Session issue before running /btw.',
          )
        }
        if (this.core.interactions.pendingNativeInteractions(input.parentSessionId).length > 0) {
          throw new RunOperationConflictError(
            'Respond to the pending native permission or question before running /btw.',
          )
        }
        if (this.core.gate.hasBlockingBackgroundWork(input.parentSessionId)) {
          throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
        }
        this.core.conversations.assertRelayDecisionResolved(input.parentSessionId, undefined, true)
        const received = this.core.conversations.receivedCollaborationInput(input.parentSessionId)
        if (received?.state === 'blocked') {
          throw new RunOperationConflictError(
            'Resolve the blocked queued message before running /btw.',
          )
        }
        this.core.conversations.assertDecisionInput({
          sessionId: input.parentSessionId,
          content: '',
          imageIds: [],
          commentIds: [],
          route: { type: 'primary' },
        })
        const savedTask = this.core.conversations.collaboration(input.parentSessionId)
        const task = savedTask?.status === 'complete' ? undefined : savedTask
        const taskGate = task ? collaborationInputGate(task) : undefined
        if (taskGate === 'needs_reply' || taskGate === 'incomplete') {
          throw new RunOperationConflictError(
            'Respond to the current workflow question or recovery prompt before running /btw.',
          )
        }
      }
      const { markdownVisibleProjection } = await import('../../../shared/message-anchor-text.js')
      const receipt = this.core.conversations.createSideChat(input, {
        resolveVisibleText: markdownVisibleProjection,
      })
      this.core.archiveAndQuit.nativeMetadataChanged()
      return { ok: true, value: receipt }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  readCreateSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): RpcResult<CreateSideChatReceipt | null> {
    if (this.core.disposed) return this.core.shuttingDown()
    try {
      return {
        ok: true,
        value: this.core.conversations.readCreateSideChatReceipt(input.operationId) ?? null,
      }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  listSideChats(input: ListSideChatsInput): RpcResult<ListSideChatsPage> {
    if (this.core.disposed) return this.core.shuttingDown()
    try {
      const parent = this.core.sessions.find(input.parentSessionId)
      if (!parent) {
        throw new RunOperationConflictError('The parent Session does not exist.')
      }
      if (parent.parentSessionId) {
        throw new RunOperationConflictError('Side chats cannot contain nested side chats.')
      }
      return { ok: true, value: this.core.sessions.listSideChatsPage(input) }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  discardEmptySideChat(input: DiscardEmptySideChatInput): RpcResult<DiscardEmptySideChatResult> {
    if (this.core.disposed || this.core.gate.nativeQuitSealed()) {
      return { ok: true, value: { discarded: false } }
    }
    const hasCachedAdapter = [...this.core.adapters.values()].some(
      (entry) => entry.sessionId === input.sideChatId,
    )
    if (
      this.core.conversations.archives.blocksSession(input.sideChatId) ||
      this.core.gate.hasSessionOperation(input.sideChatId, true) ||
      hasCachedAdapter
    ) {
      return { ok: true, value: { discarded: false } }
    }
    try {
      const discarded = this.core.conversations.discardEmptySideChat(input.sideChatId)
      if (discarded) this.core.archiveAndQuit.nativeMetadataChanged()
      return { ok: true, value: { discarded } }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  readSyncSideChatReceipt(
    input: ReadSideChatReceiptInput,
  ): RpcResult<SideChatSyncMainReceipt | null> {
    if (this.core.disposed) return this.core.shuttingDown()
    try {
      return {
        ok: true,
        value: this.core.conversations.readSyncSideChatReceipt(input.operationId) ?? null,
      }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  async syncSideChatToMain(
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
        this.core.conversations.writeConversationInput(
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
      if (this.core.disposed) return this.core.shuttingDown()
      if (input.inputId) {
        if (!ownerKey) {
          throw new RunOperationConflictError('Prepared input owner is unavailable.')
        }
        if (
          this.core.conversations.ownsTemporaryConversationInput(
            input.sideChatId,
            input.inputId,
            ownerKey,
          )
        ) {
          sealedInputId = input.inputId
        }
      }
      if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
      if (this.core.conversations.archives.blocksSession(input.sideChatId)) {
        return this.core.archiveBusy()
      }

      const sideChat = this.core.sessions.find(input.sideChatId)
      if (!sideChat || !sideChat.parentSessionId || sideChat.status === 'archived') {
        throw new RunOperationConflictError('The side chat is unavailable.')
      }
      const parentSessionId = sideChat.parentSessionId
      if (this.core.conversations.archives.blocksSession(parentSessionId)) {
        return this.core.archiveBusy()
      }
      const parent = this.core.sessions.find(parentSessionId)
      if (!parent || parent.status === 'archived' || parent.parentSessionId) {
        throw new RunOperationConflictError('The parent Session is unavailable.')
      }

      let rawContent = input.content
      let hasResolvedInput = false
      if (input.inputId) {
        if (sealedInputId || !this.core.conversations.readSyncSideChatReceipt(input.operationId)) {
          sealedInputId = input.inputId
          rawContent = this.core.conversations.resolveConversationInput(
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

      if (this.core.conversations.readSyncSideChatReceipt(input.operationId)) {
        const verified = this.core.conversations.prepareMainSyncBack(input, ownerKey)
        if (verified.existingReceipt) return { ok: true, value: verified.existingReceipt }
      }

      const prePrepGateFailure = this.checkSideChatSyncGateFailure(
        input.sideChatId,
        parentSessionId,
      )
      if (prePrepGateFailure) return prePrepGateFailure

      const stripped = stripLeadingMainToken(rawContent, input.skills)
      if (
        !stripped.content.trim() &&
        !input.imageIds.length &&
        input.commentIds.length === 0 &&
        !this.core.conversations.hasSideChatDrafts(input.sideChatId)
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

      const parentSavedTask = this.core.conversations.collaboration(parentSessionId)
      const parentTask = parentSavedTask?.status === 'complete' ? undefined : parentSavedTask
      const parentWaitingForWork =
        parentTask?.status === 'running' || this.core.gate.hasSessionOperation(parentSessionId)
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

      this.core.conversations.assertRelayDecisionResolved(parentSessionId, undefined, true)
      this.core.conversations.assertDecisionInput({
        sessionId: parentSessionId,
        content: stripped.content,
        imageIds: input.imageIds,
        commentIds: [],
        skills: stripped.skills,
        route: { type: 'primary' },
      })
      if (this.core.conversations.receivedCollaborationInput(parentSessionId)) {
        throw new RunOperationConflictError(
          'One message is already queued on the parent Session. Your draft was preserved.',
        )
      }
      if (this.core.conversations.nativeRecoveryBlocksInput(parentSessionId)) {
        return this.core.nativeRecoveryRequired()
      }
      if (this.core.gate.hasBlockingBackgroundWork(parentSessionId)) {
        throw new RunOperationConflictError(BACKGROUND_INPUT_REASON)
      }

      if (parentTask || parentWaitingForWork) {
        const parentPatch = this.core.conversations.metadataPatch(parentSessionId)
        if (!parentTask && !parentPatch.queue?.enabled) {
          throw new RunOperationConflictError('The queue is disabled. Your draft was preserved.')
        }
        const anchor =
          this.core.activeExecutions.get(parentSessionId)?.run ??
          (parentTask ? this.core.conversations.findRun(parentTask.runId) : undefined) ??
          AGENTS.map((agentId) => this.core.conversations.latestAgentRun(parentSessionId, agentId))
            .filter((run): run is AgentRun => Boolean(run))
            .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]
        if (!anchor) {
          throw new RunOperationConflictError(
            'Wait for the current execution to start before queuing a message.',
          )
        }
      } else {
        if (this.core.conversations.hasPendingRoutedContinuation(parentSessionId)) {
          throw new RunOperationConflictError(
            'Wait for or stop the remaining @all response before sending another message.',
          )
        }
        if (
          this.core.conversations
            .nativeContexts(parentSessionId)
            .some(
              (context) =>
                context.continuationState === 'responding' ||
                context.continuationState === 'waiting_user',
            )
        ) {
          return this.core.capacityFailure()
        }
        if (this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS) {
          return this.core.capacityFailure()
        }
      }

      this.core.conversations.assertTaskReplacement({ sessionId: parentSessionId }, false)
      const defaultParentActor = resolveMainChatSyncTarget(
        parent.settings.primaryAgentId,
        parentTask,
      )
      const parentTargets: RuntimeAgentId[] = [defaultParentActor]
      const preparationTimeoutMs =
        defaultParentActor === 'agy' ? AGY_PREPARATION_TIMEOUT_MS : PREPARATION_TIMEOUT_MS
      skillTimeout = setTimeout(() => skillController.abort(), preparationTimeoutMs)
      await this.core.skills.prepareSkillInvocation(
        { sessionId: parentSessionId, content: stripped.content, skills: stripped.skills },
        parentTargets,
        skillController.signal,
      )

      const postPrepGateFailure = this.checkSideChatSyncGateFailure(
        input.sideChatId,
        parentSessionId,
      )
      if (postPrepGateFailure) return postPrepGateFailure

      if (input.imageIds.length) {
        if (!this.core.images) throw new Error('Image input is unavailable.')
        this.core.conversations.resolveMessageImages(input.sideChatId, input.imageIds, ownerKey)
        releaseSourceImages = this.core.images.hold(input.imageIds)
      }

      const { markdownVisibleProjection } = await import('../../../shared/message-anchor-text.js')
      const prepared = this.core.conversations.prepareMainSyncBack(input, ownerKey, rawContent, {
        resolveVisibleText: markdownVisibleProjection,
      })
      if (prepared.existingReceipt) {
        return { ok: true, value: prepared.existingReceipt }
      }
      preparedNeedsRollback = true
      preparedCommentCount = prepared.mainCommentIds.length

      if (prepared.mainImageIds.length && this.core.images) {
        releaseClonedImages = this.core.images.hold(prepared.mainImageIds)
      }

      const parentDrafts = this.core.conversations.readPage({
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
      const sent = await this.core.sendAndSteer.sendWithOptions(sendInput, ownerKey, {
        originSideChat: prepared.originSideChat,
        syncMainOperationId: input.operationId,
      })
      if (!sent.ok) {
        const finalized = this.core.conversations.readSyncSideChatReceipt(input.operationId)
        if (finalized) {
          preparedNeedsRollback = false
          if (prepared.mainCommentIds.length > 0) {
            this.core.publish(
              this.core.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }),
            )
          }
          return { ok: true, value: finalized }
        }
        this.core.conversations.rollbackMainSyncBack(input.operationId)
        preparedNeedsRollback = false
        return sent
      }
      const receipt = this.core.conversations.readSyncSideChatReceipt(input.operationId)
      if (!receipt) {
        this.core.conversations.rollbackMainSyncBack(input.operationId)
        preparedNeedsRollback = false
        throw new RunOperationConflictError(
          'The parent Session could not confirm syncing this message.',
        )
      }
      preparedNeedsRollback = false
      if (prepared.mainCommentIds.length > 0) {
        this.core.publish(
          this.core.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }),
        )
      }
      return { ok: true, value: receipt }
    } catch (error) {
      if (preparedNeedsRollback) {
        const finalized = this.core.conversations.readSyncSideChatReceipt(input.operationId)
        if (finalized) {
          if (preparedCommentCount > 0) {
            this.core.publish(
              this.core.conversations.metadataPatch(input.sideChatId, { draftsChanged: true }),
            )
          }
          return { ok: true, value: finalized }
        }
        try {
          this.core.conversations.rollbackMainSyncBack(input.operationId)
        } catch {
          // Best-effort cleanup so rejected sends never leave orphaned sync rows.
        }
      }
      return this.core.sendFailure(error)
    } finally {
      if (skillTimeout) clearTimeout(skillTimeout)
      releaseSealedInput()
      releaseClonedImages?.()
      releaseSourceImages?.()
    }
  }
}
