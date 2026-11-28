import { createHash, randomUUID } from 'node:crypto'

import type { AgentAdapter } from '@pact/agent-runtime'
import type {
  AgentRun,
  CommentAnchor,
  CommentDraftRemoveInput,
  CommentDraftSaveInput,
  CommentSourceResolution,
  ConversationPatch,
  NativeInputRead,
  NativeInputRespond,
  NativeInteractionDetails,
  NativePermissionDecision,
  NativePermissionRequest,
  NativePermissionRespondInput,
  NativeUserInputRequest,
  NativeUserInputResult,
  PendingNativeInteraction,
  RpcResult,
  RuntimeAgentId,
} from '@pact/contracts'

import {
  compileNativeFormValidator,
  CONVERSATION_MARKDOWN_BYTES,
  MESSAGE_ANCHOR_TEXT_BASIS,
  NATIVE_PERMISSION_REQUESTS,
  NATIVE_PERMISSION_TIMEOUT_MS,
  nativeApprovalDetailsSchema,
  nativeInputDetailsSchema,
  nativeInputValuesSchema,
  nativePermissionDecisionSchema,
  nativePermissionRequestSchema,
  validateNativeInputValues,
} from '@pact/contracts'
import { CommentLimitError, RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { ActiveNativeTitleSync, NativeInteractionOwner } from '../conversation-types'

import { AgentExecutionError } from '../agent-execution-error'
import { MAX_ADAPTER_SLOTS } from '../conversation-types'

export class InteractionAndTitleCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  observeNativeTitle(
    sessionId: string,
    adapter: AgentAdapter,
    nativeSessionId: string,
    bindingGeneration: number,
  ): void {
    const cached = this.core.adapters.get(`${sessionId}:codex`)
    const binding = this.core.conversations.nativeContext(sessionId, 'codex')
    if (
      this.core.disposed ||
      cached?.adapter !== adapter ||
      binding?.nativeSessionId !== nativeSessionId ||
      binding.bindingGeneration !== bindingGeneration
    )
      return
    cached.nativeTitleObserved = {
      nativeSessionId,
      bindingGeneration,
      executorId: adapter.executorId,
    }
  }

  private nativeTitleState(sessionId: string, adapter: AgentAdapter) {
    if (this.core.gate.nativeQuitSealed()) return undefined
    if (this.core.conversations.archives.blocksSession(sessionId)) return undefined
    const cached = this.core.adapters.get(`${sessionId}:codex`)
    if (this.core.disposed || cached?.adapter !== adapter || !adapter.setNativeTitle)
      return undefined
    const session = this.core.sessions.find(sessionId)
    if (!session || session.status === 'archived') return undefined
    const fork = this.core.conversations.forkOperation(sessionId)
    if (
      session.titleSource !== 'agent' &&
      session.titleSource !== 'user' &&
      !(session.titleSource === 'local' && fork?.ready)
    )
      return undefined // Let the existing first Native title arrive before decorating.
    if (fork && !fork.ready) return undefined
    const binding = this.core.conversations.nativeContext(sessionId, 'codex')
    const project = this.core.projects.find(session.projectId)
    if (
      !binding?.nativeSessionId ||
      !project ||
      cached.cwd !== project.directoryPath ||
      !['ready', 'responding'].includes(binding.continuationState ?? '')
    )
      return undefined
    const observed = cached.nativeTitleObserved
    if (
      session.titleSource === 'agent' &&
      (!observed ||
        observed.nativeSessionId !== binding.nativeSessionId ||
        observed.bindingGeneration !== binding.bindingGeneration ||
        !observed.executorId ||
        !this.core.adapterOwnsExecutor(adapter, observed.executorId))
    )
      return undefined // A Claude title must not preempt Codex's own first Native title.
    const title = `[Pact] ${project.name} · ${session.title}`
    const key = JSON.stringify([
      title,
      session.titleSource,
      binding.nativeSessionId,
      binding.bindingGeneration,
      cached.executablePath,
      cached.cwd,
      adapter.executorId,
    ])
    if (Buffer.byteLength(key) > 8192) return undefined
    return { key, title, cwd: cached.cwd, nativeSessionId: binding.nativeSessionId }
  }

  scheduleNativeTitleSync(sessionId: string): void {
    if (this.core.gate.nativeQuitSealed()) return
    if (this.core.conversations.archives.blocksSession(sessionId)) return
    const cached = this.core.adapters.get(`${sessionId}:codex`)
    if (!cached?.adapter.setNativeTitle || this.core.disposed) return
    const state = this.nativeTitleState(sessionId, cached.adapter)
    if (!state) return
    const previous = this.core.nativeTitleSyncs.get(sessionId)
    if (previous) {
      if (previous.desiredKey !== state.key) {
        previous.desiredKey = state.key
        previous.dirty = true
      }
      return
    }
    if (this.core.nativeTitleSyncs.size >= MAX_ADAPTER_SLOTS) return
    const owner: ActiveNativeTitleSync = {
      adapter: cached.adapter,
      executorId: cached.adapter.executorId,
      abortController: new AbortController(),
      desiredKey: state.key,
      dirty: false,
      cancelled: false,
      promise: Promise.resolve(),
    }
    this.core.nativeTitleSyncs.set(sessionId, owner)
    owner.promise = (async () => {
      const timer = setTimeout(() => owner.abortController.abort(), 4000)
      let retryLatest = false
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (this.core.disposed || owner.abortController.signal.aborted) break
          const latest = this.nativeTitleState(sessionId, owner.adapter)
          if (
            !latest ||
            !owner.executorId ||
            !this.core.adapterOwnsExecutor(owner.adapter, owner.executorId)
          )
            break
          owner.desiredKey = latest.key
          owner.dirty = false
          // oxlint-disable-next-line no-await-in-loop -- Serialize this Session's absolute metadata writes and coalesce to the newest durable title.
          const result = await owner.adapter.setNativeTitle!(
            {
              nativeSessionId: latest.nativeSessionId,
              cwd: latest.cwd,
              title: latest.title,
              isCurrent: () =>
                this.core.nativeTitleSyncs.get(sessionId) === owner &&
                Boolean(
                  owner.executorId &&
                  this.core.adapterOwnsExecutor(owner.adapter, owner.executorId),
                ) &&
                this.nativeTitleState(sessionId, owner.adapter)?.key === latest.key,
            },
            owner.abortController.signal,
          )
          const current = this.nativeTitleState(sessionId, owner.adapter)
          owner.dirty = owner.dirty || Boolean(current && current.key !== latest.key)
          if (result === 'unknown_delivery') {
            owner.dirty = false
            break
          }
          if (!owner.dirty) break
          retryLatest = true
        }
      } catch {
        /* The persistent Pact title remains the next connection's desired value. */
      } finally {
        clearTimeout(timer)
        if (this.core.nativeTitleSyncs.get(sessionId) === owner)
          this.core.nativeTitleSyncs.delete(sessionId)
        if (retryLatest && owner.dirty && !this.core.disposed && !owner.cancelled)
          queueMicrotask(() => this.scheduleNativeTitleSync(sessionId))
      }
      return undefined
    })()
  }

  cancelNativeTitleSync(sessionId: string): Promise<void> {
    const owner = this.core.nativeTitleSyncs.get(sessionId)
    if (owner) owner.cancelled = true
    owner?.abortController.abort()
    return owner?.promise ?? Promise.resolve()
  }

  interactionCurrent(pending: {
    operationId: string
    sessionId: string
    agentId: RuntimeAgentId
    bindingGeneration: number
    executorId?: string | undefined
    visible: boolean
    valid: () => boolean
  }): boolean {
    if (!pending.visible || !pending.valid()) return false
    if (!pending.executorId) return false
    if (
      this.core.conversations.forkActorIsCurrent(
        pending.sessionId,
        pending.operationId,
        pending.agentId,
        pending.executorId,
      )
    ) {
      const adapter = this.core.adapters.get(`${pending.sessionId}:${pending.agentId}`)?.adapter
      return (
        pending.bindingGeneration === 1 &&
        (adapter?.hasActiveBackgroundWork?.(pending.operationId) === true ||
          [...this.core.nativeForks.values()].some(
            (owner) =>
              owner.sessionId === pending.sessionId && owner.operationId === pending.operationId,
          ))
      )
    }
    const operation = this.core.conversations.nativeRebuildOperation(pending.operationId)
    if (operation) {
      const adapter = this.core.adapters.get(`${pending.sessionId}:${pending.agentId}`)?.adapter
      const context = this.core.conversations.nativeContext(pending.sessionId, pending.agentId)
      const rebuild = this.core.nativeRebuilds.get(pending.sessionId)
      try {
        this.core.conversations.verifyRebuildReceipt(
          pending.operationId,
          pending.sessionId,
          pending.agentId,
        )
      } catch {
        return false
      }
      return (
        !['completed', 'failed', 'superseded'].includes(operation.stage) &&
        (context?.bindingGeneration ?? 1) === operation.oldGeneration &&
        pending.bindingGeneration === operation.oldGeneration + 1 &&
        Boolean(adapter && this.core.adapterOwnsExecutor(adapter, pending.executorId)) &&
        (rebuild?.rebuildId === pending.operationId ||
          adapter?.hasActiveBackgroundWork?.(pending.operationId) === true)
      )
    }
    const run = this.core.conversations.findRun(pending.operationId)
    const context = this.core.conversations.nativeContext(pending.sessionId, pending.agentId)
    return (
      run !== undefined &&
      !run.forkSourceRunId &&
      run.sessionId === pending.sessionId &&
      run.agentId === pending.agentId &&
      run.controlDisposition !== 'abandoned' &&
      (run.bindingGeneration ?? 1) === pending.bindingGeneration &&
      (context?.bindingGeneration ?? run?.bindingGeneration ?? 1) === pending.bindingGeneration &&
      run.executorId === pending.executorId &&
      (!context?.executorId ||
        context.lastRunId !== run.id ||
        context.executorId === pending.executorId)
    )
  }

  pendingNativeInteractions(sessionId: string): PendingNativeInteraction[] {
    return [...this.core.permissions.values()]
      .filter((pending) => pending.sessionId === sessionId && this.interactionCurrent(pending))
      .map((pending) => {
        const projection: PendingNativeInteraction = {
          agentId: pending.agentId,
          bindingGeneration: pending.bindingGeneration,
          request: {
            id: pending.request.id,
            operationId: pending.operationId,
            kind: pending.request.kind ?? 'approval',
            title: 'Native interaction',
            detail: '',
            createdAt: pending.request.createdAt,
          },
        }
        if (pending.executorId) projection.executorId = pending.executorId
        return projection
      })
  }

  respondNativePermission(input: NativePermissionRespondInput): RpcResult<ConversationPatch> {
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    const pending = this.core.permissions.get(input.permissionId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      (pending.request.kind !== undefined && pending.request.kind !== 'approval') ||
      pending.details?.kind !== 'approval' ||
      !pending.details.actions.some((action) => action.id === input.decision)
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This permission request is no longer active.' },
      }
    try {
      return { ok: true, value: pending.settle(input.decision) }
    } catch {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message:
            'The permission decision could not be saved; its native outcome is not confirmed.',
        },
      }
    }
  }

  requestNativePermission(
    owner: NativeInteractionOwner,
    input: Omit<NativePermissionRequest, 'id' | 'createdAt'>,
    signal: AbortSignal,
  ): Promise<NativePermissionDecision> {
    if (!input.actions?.length)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'The native request supplied no usable actions. No user decision was supplied.',
        false,
      )
    const details = nativeApprovalDetailsSchema.parse({
      kind: 'approval',
      title: input.title,
      detail: input.detail,
      actions: input.actions,
      ...(input.defaultToNo != null ? { defaultToNo: input.defaultToNo } : {}),
    })
    return this.requestNativeInteraction(
      owner,
      { title: 'Native interaction', detail: '', kind: 'approval' },
      signal,
      (reply) => nativePermissionDecisionSchema.parse(reply),
      details,
    )
  }

  readNativeInput(input: NativeInputRead): RpcResult<NativeInteractionDetails> {
    const pending = this.core.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      !pending.details
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This native input request is no longer active.' },
      }
    return { ok: true, value: pending.details }
  }

  respondNativeInput(input: NativeInputRespond): RpcResult<ConversationPatch> {
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    const pending = this.core.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      !pending.details ||
      pending.details.kind === 'approval'
    )
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'This native input request is no longer active.' },
      }
    if (pending.details.kind === 'url' && input.action === 'accept')
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: 'Open the native authorization page before consenting.',
        },
      }
    try {
      return {
        ok: true,
        value: pending.settle({
          action: input.action,
          ...(input.values ? { values: input.values } : {}),
        }),
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: error instanceof Error ? error.message : 'Check the native input fields.',
        },
      }
    }
  }

  confirmNativeInputURL(input: NativeInputRead): RpcResult<ConversationPatch> {
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    const pending = this.core.permissions.get(input.requestId)
    if (
      !pending ||
      pending.operationId !== input.operationId ||
      !this.interactionCurrent(pending) ||
      pending.details?.kind !== 'url'
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'This native authorization request is no longer active.',
        },
      }
    try {
      return { ok: true, value: pending.settle({ action: 'accept' }) }
    } catch {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message:
            'The browser consent could not be recorded. Native authorization was not confirmed.',
        },
      }
    }
  }

  requestNativeUserInput(
    owner: NativeInteractionOwner,
    input: NativeUserInputRequest,
    signal: AbortSignal,
  ): Promise<NativeUserInputResult> {
    if (
      this.core.conversations.collaborationTurnAuthorization(owner.id)?.replyIntentBasis?.kind ===
      'ask_only'
    )
      return Promise.resolve({ action: 'cancel' })
    if (
      input.kind === 'questions' &&
      this.core.conversations.findRun(owner.id)?.collaboration &&
      this.core.conversations.receivedCollaborationInput(owner.sessionId)
    )
      return Promise.resolve({ action: 'cancel' })
    if (
      owner.valid() &&
      input.nativeSessionId &&
      !this.core.conversations.nativeContext(owner.sessionId, owner.agentId)
    ) {
      const execution = this.core.activeExecutions.get(owner.sessionId)
      if (execution?.run.id === owner.id)
        this.core.publish(
          this.core.conversations.applyEvent(owner.sessionId, owner.id, {
            type: 'session.started',
            agentId: owner.agentId,
            nativeSessionId: input.nativeSessionId,
          }),
        )
    }
    const details = nativeInputDetailsSchema.parse({
      kind: input.kind,
      title: input.title,
      message: input.message,
      fields: input.fields,
      ...(input.url ? { url: input.url } : {}),
    })
    if (details.kind === 'url') {
      const url = new URL(details.url ?? '')
      if (
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          )) ||
        url.username ||
        url.password
      )
        throw new Error(
          'The native authorization URL uses an unsupported or credential-bearing address.',
        )
    }
    const validateForm = input.requestedSchema
      ? compileNativeFormValidator(input.requestedSchema)
      : undefined
    return this.requestNativeInteraction(
      owner,
      {
        kind: details.kind,
        title: 'Native user input',
        detail:
          details.kind === 'url'
            ? 'Open the native authorization page to continue.'
            : 'The native Agent or MCP server needs your input.',
      },
      signal,
      (reply) => {
        if (typeof reply === 'string')
          throw new Error('This request needs input, not permission approval.')
        if (reply.action !== 'accept') return { action: reply.action }
        const values = nativeInputValuesSchema.parse(reply.values ?? {})
        if (!validateNativeInputValues(details.fields, values))
          throw new Error(
            'Complete the required fields using the provided answer types and choices.',
          )
        if (validateForm && !validateForm(values))
          throw new Error(
            'The input does not match the native form requirements. Check the fields and try again.',
          )
        return { action: 'accept', values }
      },
      details,
    )
  }

  private requestNativeInteraction<T extends NativePermissionDecision | NativeUserInputResult>(
    owner: NativeInteractionOwner,
    input: Omit<NativePermissionRequest, 'id' | 'createdAt'>,
    signal: AbortSignal,
    validate: (reply: NativePermissionDecision | NativeUserInputResult) => T,
    details?: NativeInteractionDetails,
  ): Promise<T> {
    const bindingGeneration =
      owner.bindingGeneration ?? this.core.conversations.findRun(owner.id)?.bindingGeneration ?? 1
    const pendingOwner = {
      operationId: owner.id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      bindingGeneration,
      executorId: owner.executorId,
      visible: true,
      valid: () => owner.valid() && !signal.aborted,
    }
    if (!this.interactionCurrent(pendingOwner))
      throw new RunOperationConflictError(
        'The native request owner is no longer available. No user decision was supplied.',
      )
    if (this.core.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      throw new AgentExecutionError(
        'runtime_incompatible',
        'Native interaction capacity is occupied. No user decision was supplied.',
        false,
      )
    const request = nativePermissionRequestSchema.parse({
      ...input,
      operationId: owner.id,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    })
    const current = this.core.activeExecutions.get(owner.sessionId)
    if (current?.run.id === owner.id) current.streamBuffer?.flush()
    const result = Promise.withResolvers<T>()
    let settled = false
    const requests = (): NativePermissionRequest[] =>
      [...this.core.permissions.values()]
        .filter(
          (pending) =>
            pending.sessionId === owner.sessionId &&
            pending.agentId === owner.agentId &&
            this.interactionCurrent(pending),
        )
        .map((pending) => pending.request)
    const scope = () => {
      const pending = this.core.permissions.get(request.id) ?? pendingOwner
      return {
        bindingGeneration,
        // A native abort expires the request but may still clear its own
        // projection; it cannot clear a different binding or retired owner.
        projectionAllowed: this.interactionCurrent({ ...pending, valid: () => true }),
      }
    }
    const withdraw = (source: 'expired' | 'aborted'): void => {
      if (settled) return
      try {
        const patch = this.core.conversations.recordContextPermissions(
          owner.sessionId,
          owner.agentId,
          owner.id,
          requests().filter((item) => item.id !== request.id),
          { permissionId: request.id, source },
          scope(),
        )
        settled = true
        this.core.permissions.delete(request.id)
        this.core.publish(patch)
      } catch {
        settled = true
        this.core.permissions.delete(request.id)
      } finally {
        clearTimeout(timeout)
        signal.removeEventListener('abort', abort)
        result.reject(
          new AgentExecutionError(
            'runtime_incompatible',
            source === 'expired'
              ? 'The native interaction expired without a user decision.'
              : 'The native interaction was interrupted without a user decision.',
            false,
          ),
        )
      }
    }
    const abort = (): void => withdraw('aborted')
    const timeout = setTimeout(() => withdraw('expired'), NATIVE_PERMISSION_TIMEOUT_MS)
    const settle = (reply: NativePermissionDecision | NativeUserInputResult): ConversationPatch => {
      if (settled) throw new RunOperationConflictError('The permission request already settled.')
      const decision = validate(reply)
      const action =
        typeof decision === 'string' && details?.kind === 'approval'
          ? details.actions.find((item) => item.id === decision)
          : undefined
      // Approval cannot reach the provider before its audit is committed.
      const patch = this.core.conversations.recordContextPermissions(
        owner.sessionId,
        owner.agentId,
        owner.id,
        requests().filter((item) => item.id !== request.id),
        {
          permissionId: request.id,
          source: 'user',
          decision:
            typeof decision === 'string'
              ? action?.kind === 'allow' || action?.kind === 'rule'
                ? 'accept'
                : action?.kind === 'decline'
                  ? 'decline'
                  : 'cancel'
              : decision.action,
          ...(action ? { actionId: action.id, actionKind: action.kind } : {}),
        },
        scope(),
      )
      settled = true
      this.core.permissions.delete(request.id)
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      this.core.publish(patch)
      result.resolve(decision)
      return patch
    }
    this.core.permissions.set(request.id, {
      operationId: owner.id,
      sessionId: owner.sessionId,
      agentId: owner.agentId,
      bindingGeneration,
      ...(owner.executorId ? { executorId: owner.executorId } : {}),
      visible: true,
      valid: () => owner.valid() && !signal.aborted,
      request,
      ...(details ? { details } : {}),
      settle,
      withdraw,
    })
    try {
      this.core.publish(
        this.core.conversations.recordContextPermissions(
          owner.sessionId,
          owner.agentId,
          owner.id,
          requests(),
          undefined,
          scope(),
        ),
      )
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    } catch (error) {
      clearTimeout(timeout)
      this.core.permissions.delete(request.id)
      signal.removeEventListener('abort', abort)
      result.reject(error)
    }
    return result.promise
  }

  async saveCommentDraft(input: CommentDraftSaveInput): Promise<RpcResult<ConversationPatch>> {
    try {
      const session = this.core.sessions.find(input.sessionId)
      if (!session || session.status === 'archived') {
        return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
      }
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return this.core.nativeRecoveryRequired()
      if (input.mode === 'create') await this.validateCommentAnchor(input.sessionId, input.anchor)
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return this.core.nativeRecoveryRequired()
      if (this.core.disposed) return this.core.shuttingDown()
      const patch = this.core.conversations.saveCommentDraft(input)
      this.core.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code:
            error instanceof CommentLimitError
              ? 'COMMENT_LIMIT'
              : this.core.isConflict(error)
                ? 'CONFLICT'
                : 'VALIDATION',
          message: error instanceof Error ? error.message : 'The Comment draft could not be saved.',
        },
      }
    }
  }

  removeCommentDraft(input: CommentDraftRemoveInput): RpcResult<ConversationPatch> {
    try {
      if (this.core.conversations.nativeRecoveryBlocksInput(input.sessionId))
        return this.core.nativeRecoveryRequired()
      const patch = this.core.conversations.removeCommentDraft(input)
      this.core.publish(patch)
      return { ok: true, value: patch }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: this.core.isConflict(error) ? 'CONFLICT' : 'VALIDATION',
          message:
            error instanceof Error ? error.message : 'The Comment draft could not be removed.',
        },
      }
    }
  }

  async resolveCommentSource(
    sessionId: string,
    commentId: string,
  ): Promise<RpcResult<CommentSourceResolution>> {
    const comment = this.core.conversations.comment(commentId)
    if (!comment || comment.sessionId !== sessionId) {
      return { ok: false, error: { code: 'VALIDATION', message: 'Comment is unavailable.' } }
    }
    const anchor = comment.anchor
    if (anchor.type === 'unavailable')
      return {
        ok: true,
        value: { status: 'unavailable', commentId, quote: anchor.quote, reason: anchor.reason },
      }
    if (anchor.type === 'file')
      return this.core.projectFiles.resolveCommentSource(sessionId, comment)
    if (anchor.type === 'cutoff_message') {
      const textBasis = anchor.textBasis ?? MESSAGE_ANCHOR_TEXT_BASIS
      if (textBasis !== MESSAGE_ANCHOR_TEXT_BASIS && textBasis !== 'markdown-visible-v1') {
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: 'This Comment uses an unsupported Markdown projection.',
          },
        }
      }
      const metadata = this.core.conversations.messageMetadata(
        anchor.messageId,
        anchor.sourceSessionId,
      )
      const liveMessage = metadata
        ? this.core.conversations.internalMessage(anchor.messageId, anchor.sourceSessionId)
        : undefined
      const liveHash = liveMessage
        ? createHash('sha256').update(liveMessage.content, 'utf8').digest('hex')
        : undefined
      if (!metadata || !liveMessage || liveHash !== anchor.contentSha256) {
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: 'The referenced message changed or is unavailable.',
          },
        }
      }
      const projected =
        textBasis === MESSAGE_ANCHOR_TEXT_BASIS
          ? await this.core.markdownVisibleProjection(liveMessage.content)
          : liveMessage.content
      if (projected.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote) {
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: 'Comment source changed.',
          },
        }
      }
      return {
        ok: true,
        value: { status: 'resolved', commentId, anchor: { ...anchor, textBasis } },
      }
    }

    if (
      anchor.textBasis !== MESSAGE_ANCHOR_TEXT_BASIS &&
      !(anchor.textBasis === 'plain-visible-v1' && (anchor.plan || anchor.report))
    ) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'This Comment uses an earlier Markdown projection.',
        },
      }
    }
    const metadata = this.core.conversations.messageMetadata(anchor.messageId, sessionId)
    if (!metadata) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'Message unavailable.',
        },
      }
    }
    if (!anchor.plan && !anchor.report && metadata.contentBytes > CONVERSATION_MARKDOWN_BYTES) {
      return {
        ok: true,
        value: {
          status: 'unavailable',
          commentId,
          quote: anchor.quote,
          reason:
            'This long Message is shown as plain text; exact Comment positioning is unavailable.',
        },
      }
    }
    try {
      const source = this.core.conversations.collaborationCommentDocument(sessionId, anchor)
      if (source) {
        const owner = this.core.conversations.collaborationDocumentRow(
          sessionId,
          source,
        ).sourceRunId!
        if (anchor.textBasis !== 'plain-visible-v1')
          await this.core.prepareMarkdown(sessionId, owner, source)
        const matched =
          source.sha256 === anchor.contentHash &&
          this.core.conversations.collaborationQuote(
            sessionId,
            source,
            anchor.startOffset,
            anchor.endOffset,
            anchor.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : 'markdown-visible-v2',
          ) === anchor.quote
        return {
          ok: true,
          value: matched
            ? { status: 'resolved', commentId, anchor }
            : {
                status: 'outdated',
                commentId,
                quote: anchor.quote,
                reason: 'Comment source changed.',
              },
        }
      }
    } catch (error) {
      return {
        ok: true,
        value: {
          status: 'unavailable',
          commentId,
          quote: anchor.quote,
          reason: error instanceof Error ? error.message : 'Comment source unavailable.',
        },
      }
    }
    let content: string
    try {
      content = this.commentMarkdown(sessionId, anchor)
    } catch (error) {
      if (anchor.plan || anchor.report)
        return {
          ok: true,
          value: {
            status: 'outdated',
            commentId,
            quote: anchor.quote,
            reason: error instanceof Error ? error.message : 'Plan source unavailable.',
          },
        }
      return {
        ok: false,
        error: {
          code: 'VALIDATION',
          message: error instanceof Error ? error.message : 'The Comment source is unavailable.',
        },
      }
    }
    if (this.core.hash(content) !== anchor.contentHash) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: anchor.plan || anchor.report ? 'Comment source changed.' : 'Message changed.',
        },
      }
    }
    const projection = await this.core.markdownVisibleProjection(content)
    if (projection.slice(anchor.startOffset, anchor.endOffset) !== anchor.quote) {
      return {
        ok: true,
        value: {
          status: 'outdated',
          commentId,
          quote: anchor.quote,
          reason: 'Message text changed.',
        },
      }
    }
    return { ok: true, value: { status: 'resolved', commentId, anchor } }
  }

  private async validateCommentAnchor(
    sessionId: string,
    anchor: Extract<CommentDraftSaveInput, { mode: 'create' }>['anchor'],
  ): Promise<void> {
    if (anchor.type === 'file') {
      await this.core.projectFiles.validateCommentAnchor(sessionId, anchor)
      return
    }

    if (
      anchor.textBasis !== MESSAGE_ANCHOR_TEXT_BASIS &&
      !(anchor.textBasis === 'plain-visible-v1' && (anchor.plan || anchor.report))
    ) {
      throw new Error('This Comment uses an earlier Markdown projection.')
    }
    const source = this.core.conversations.collaborationCommentDocument(sessionId, anchor)
    if (source) {
      if (source.sha256 !== anchor.contentHash)
        throw new Error('The immutable Comment source changed.')
      const owner = this.core.conversations.collaborationDocumentRow(sessionId, source).sourceRunId!
      if (anchor.textBasis !== 'plain-visible-v1')
        await this.core.prepareMarkdown(sessionId, owner, source)
      if (
        this.core.conversations.collaborationQuote(
          sessionId,
          source,
          anchor.startOffset,
          anchor.endOffset,
          anchor.textBasis === 'plain-visible-v1' ? 'plain-visible-v1' : 'markdown-visible-v2',
        ) !== anchor.quote
      )
        throw new Error('The Comment quote no longer matches its source range.')
      return
    }
    const content = this.commentMarkdown(sessionId, anchor)
    if (this.core.hash(content) !== anchor.contentHash) {
      throw new Error('The selected message changed before this Comment could be saved.')
    }
    if (
      (await this.core.markdownVisibleProjection(content)).slice(
        anchor.startOffset,
        anchor.endOffset,
      ) !== anchor.quote
    ) {
      throw new Error('The selected message range no longer matches its quoted text.')
    }
  }

  /** Select the bounded immutable source behind a Message's body or structured plan Comment. */
  private commentMarkdown(
    sessionId: string,
    anchor: Extract<CommentAnchor, { type: 'message' }>,
  ): string {
    if (anchor.plan || anchor.report)
      throw new Error('The immutable plan or review source is unavailable.')
    const metadata = this.core.conversations.messageMetadata(anchor.messageId, sessionId)
    if (!metadata) throw new Error('The selected message is unavailable.')
    if (metadata.contentBytes > CONVERSATION_MARKDOWN_BYTES)
      throw new Error('Text Comments are unavailable on long plain-text Messages.')
    const message = this.core.conversations.internalMessage(anchor.messageId, sessionId)
    if (!message) throw new Error('The selected message is unavailable.')
    return message.content
  }

  scheduleTitleEnrichment(
    adapter: AgentAdapter,
    run: AgentRun,
    nativeSessionId: string,
    cwd: string,
  ): void {
    if (!adapter.enrichTitle || this.core.disposed || this.core.gate.nativeQuitSealed()) return
    this.cancelTitleEnrichment(run.sessionId)
    const abortController = new AbortController()
    const promise = adapter
      .enrichTitle(
        {
          runId: run.id,
          sessionId: run.sessionId,
          nativeSessionId,
          cwd,
          observeNativeTitle: (nativeId, logicalTitle) => {
            if (
              !logicalTitle &&
              !abortController.signal.aborted &&
              this.core.conversations.ownsNativeControl(run.id)
            )
              this.observeNativeTitle(run.sessionId, adapter, nativeId, run.bindingGeneration ?? 1)
          },
        },
        abortController.signal,
      )
      .then((title) => {
        if (!title || this.core.disposed || abortController.signal.aborted) return undefined
        const event: import('@pact/contracts').NormalizedAgentEvent = {
          agentId: run.agentId,
          type: 'session.title.updated',
          title,
        }
        this.core.publish(
          this.core.conversations.ownsNativeControl(run.id)
            ? this.core.conversations.applyEvent(run.sessionId, run.id, event)
            : this.core.conversations.applyArchivedEvent(run.sessionId, run.id, event),
        )
        if (this.core.conversations.ownsNativeControl(run.id))
          this.observeNativeTitle(
            run.sessionId,
            adapter,
            nativeSessionId,
            run.bindingGeneration ?? 1,
          )
        return undefined
      })
      .catch(() => undefined)
      .finally(() => {
        const active = this.core.titleEnrichments.get(run.sessionId)
        if (active?.runId === run.id) this.core.titleEnrichments.delete(run.sessionId)
        this.scheduleNativeTitleSync(run.sessionId)
      })
    this.core.titleEnrichments.set(run.sessionId, {
      runId: run.id,
      agentId: run.agentId,
      abortController,
      promise,
    })
  }

  cancelTitleEnrichment(sessionId: string): void {
    const active = this.core.titleEnrichments.get(sessionId)
    if (!active) return
    this.core.titleEnrichments.delete(sessionId)
    active.abortController.abort()
  }
}
