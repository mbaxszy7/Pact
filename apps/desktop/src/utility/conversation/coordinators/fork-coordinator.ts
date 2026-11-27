import type {
  AgentAdapter,
  AgentNativeForkBoundary,
  AgentNativeForkInput,
} from '@pact/agent-runtime'
import type {
  RpcResult,
  RuntimeAgentId,
  SessionForkInput,
  SessionForkResult,
} from '@pact/contracts'

import { resolveActiveAgentPair } from '@pact/contracts'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { PreparedSession } from '../conversation-types'

import { MAX_AGENT_OPERATIONS } from '../conversation-types'
import { safeNativePermissionText } from '../native-permission-wait'

export class ForkCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  forkSession(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    if (input.action !== 'prepare') return this.executeForkRequest(input)
    const existing = this.core.forkPreparations.get(input.sourceSessionId)
    if (existing)
      return existing.messageId === input.messageId
        ? existing.task
        : Promise.resolve({
            ok: false,
            error: { code: 'CONFLICT', message: 'Another message is being prepared for a fork.' },
          })
    if (this.core.forkPreparations.size >= MAX_AGENT_OPERATIONS)
      return Promise.resolve({
        ok: false,
        error: { code: 'CONFLICT', message: 'Fork preparation capacity is unavailable.' },
      })
    const entry = { messageId: input.messageId, task: this.executeForkRequest(input) }
    this.core.forkPreparations.set(input.sourceSessionId, entry)
    this.core.archiveAndQuit.nativeMetadataChanged()
    const release = (): void => {
      if (this.core.forkPreparations.get(input.sourceSessionId) === entry)
        this.core.forkPreparations.delete(input.sourceSessionId)
      this.core.archiveAndQuit.nativeMetadataChanged()
    }
    void entry.task.then(release, release)
    return entry.task
  }

  private async executeForkRequest(input: SessionForkInput): Promise<RpcResult<SessionForkResult>> {
    if (this.core.disposed) return this.core.shuttingDown()
    if (input.action === 'read')
      return {
        ok: true,
        value: {
          kind: 'state',
          operation: this.core.conversations.forkOperation(input.sessionId) ?? null,
        },
      }
    if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
    const archiveSessionId = 'sourceSessionId' in input ? input.sourceSessionId : input.sessionId
    if (this.core.conversations.archives.blocksSession(archiveSessionId, input.action === 'check'))
      return this.core.archiveBusy()
    const sourceSessionId =
      input.action === 'prepare' || input.action === 'create'
        ? input.sourceSessionId
        : input.sessionId
    const sourceSession = this.core.sessions.find(sourceSessionId)
    if (!sourceSession || sourceSession.status === 'archived')
      return { ok: false, error: { code: 'VALIDATION', message: 'Session is unavailable.' } }
    if (sourceSession.parentSessionId)
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Side chats cannot be forked.' },
      }
    if (input.action === 'create') {
      const existing = this.core.conversations.forkOperationById(input.operationId)
      if (existing) {
        if (
          existing.sourceSessionId !== input.sourceSessionId ||
          existing.sourceMessageId !== input.messageId
        )
          return {
            ok: false,
            error: { code: 'CONFLICT', message: 'This fork operation belongs to another message.' },
          }
        return {
          ok: true,
          value: {
            kind: 'created',
            change: this.core.sessions.change(existing.sessionId),
            operation: existing,
          },
        }
      }
    }
    if (
      this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS ||
      this.core.gate.hasSessionOperation(sourceSessionId, input.action !== 'check')
    )
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message:
            'Wait for this session and its native tasks to finish before forking or confirming native setup.',
        },
      }
    const owner = {
      sourceSessionId,
      controller: new AbortController(),
      ...(input.action !== 'prepare' && input.action !== 'create'
        ? { sessionId: input.sessionId, operationId: input.operationId }
        : {}),
    } as {
      sourceSessionId: string
      sessionId?: string
      operationId?: string
      controller: AbortController
      completion?: Promise<void>
      activeAdapters?: Set<AgentAdapter>
    }
    this.core.nativeForks.set(sourceSessionId, owner)
    this.core.publish(this.core.conversations.metadataPatch(sourceSessionId))
    let continued = false
    try {
      if (input.action === 'prepare' || input.action === 'create') {
        const prepared = await this.core.prepareSession(sourceSessionId, owner.controller.signal)
        if (!prepared.ok) return prepared
        const session = prepared.value.session
        if (
          this.core.conversations.sessionHasNativeWork(sourceSessionId) ||
          this.core.conversations.forkOperation(sourceSessionId)?.ready === false
        )
          throw new Error('Native tasks from the source session have not been confirmed finished.')
        const selection = this.core.conversations.selectForkSource(
          sourceSessionId,
          input.messageId,
          session.settings,
          session.settingsRevision,
        )
        if (
          input.action === 'create' &&
          (selection.prepared.sourceRevision !== input.sourceRevision ||
            selection.prepared.messageRevision !== input.messageRevision ||
            selection.prepared.settingsRevision !== input.settingsRevision)
        )
          throw new Error(
            'The source conversation or settings changed. Review the fork confirmation again.',
          )
        const forkPair = selection.pair ?? resolveActiveAgentPair(session.settings)
        const boundaries: Partial<Record<RuntimeAgentId, AgentNativeForkBoundary>> = {}
        // Two independent read-only sources; neither provider may write during preparation.
        const inspected = await Promise.allSettled(
          forkPair.map(async (agentId) => {
            const run = selection.runs[agentId]
            if (!run) throw new Error('The selected Fork boundary is missing its native Agent run.')
            const adapter = await this.core.adapterFor(
              sourceSessionId,
              agentId,
              prepared.value.executablePaths[agentId],
              owner.controller.signal,
              prepared.value.projectDirectory,
            )
            const releaseAdapter = this.holdForkAdapter(owner, adapter)
            try {
              if (!adapter.prepareNativeFork)
                throw new Error(`${agentId} does not support native forking.`)
              const response = this.core.conversations.forkResponse(
                run.id,
                selection.prepared.sequence,
              )
              boundaries[agentId] = await adapter.prepareNativeFork(
                {
                  cwd: prepared.value.projectDirectory,
                  nativeSessionId: run.nativeSessionId!,
                  nativeTurnId: run.nativeTurnId!,
                  nativeInputIds: this.core.conversations.nativeInputIdsForRun(run.id),
                  runId: run.id,
                  bindingGeneration: run.bindingGeneration,
                  throughSequence: response.sequence,
                  deliveryCursor: response.deliveryCursor,
                  responseHash: response.responseHash,
                },
                owner.controller.signal,
              )
            } finally {
              releaseAdapter()
            }
          }),
        )
        for (const result of inspected) if (result.status === 'rejected') throw result.reason
        if (this.core.disposed || owner.controller.signal.aborted)
          throw new Error('Fork preparation was cancelled.')
        if (input.action === 'prepare')
          return { ok: true, value: { kind: 'prepared', prepared: selection.prepared } }
        if (
          this.core.gate.hasSessionOperation(sourceSessionId, true, owner) ||
          this.core.conversations.sessionHasNativeWork(sourceSessionId)
        )
          throw new Error('The source session started native work. No fork was created.')
        const operation = this.core.conversations.commitFork(
          input.operationId,
          selection,
          boundaries,
          input.confirmedFullAccessAgents,
        )
        owner.sessionId = operation.sessionId
        owner.operationId = operation.id
        const change = this.core.sessions.change(operation.sessionId)
        // Commit receipt goes back immediately; progress/real native interactions use bounded Patches.
        continued = true
        owner.completion = Promise.allSettled(
          forkPair.map((agentId) => this.runForkSide(owner, agentId, 'continue')),
        )
          .then(() => undefined)
          .finally(() => {
            if (this.core.nativeForks.get(sourceSessionId) === owner)
              this.core.nativeForks.delete(sourceSessionId)
            if (!this.core.disposed)
              this.core.publish(this.core.conversations.metadataPatch(sourceSessionId))
          })
        return { ok: true, value: { kind: 'created', change, operation } }
      }
      const operation = this.core.conversations.forkOperation(input.sessionId)
      if (!operation || operation.id !== input.operationId)
        throw new Error('The fork operation is unavailable.')
      if (input.action === 'continue') {
        owner.sourceSessionId = operation.sourceSessionId
        this.core.publish(this.core.conversations.metadataPatch(operation.sourceSessionId))
      }
      if (input.action === 'check') {
        await this.checkForkSide(owner, input.agentId)
      } else {
        continued = true
        owner.completion = this.runForkSide(owner, input.agentId, input.action).finally(() => {
          if (this.core.nativeForks.get(sourceSessionId) === owner)
            this.core.nativeForks.delete(sourceSessionId)
          if (!this.core.disposed) {
            this.core.publish(this.core.conversations.metadataPatch(input.sessionId))
            if (owner.sourceSessionId !== input.sessionId)
              this.core.publish(this.core.conversations.metadataPatch(owner.sourceSessionId))
          }
        })
      }
      return {
        ok: true,
        value: {
          kind: 'state',
          operation: this.core.conversations.forkOperation(input.sessionId)!,
        },
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: safeNativePermissionText(
            error instanceof Error ? error.message : 'The fork could not be prepared.',
          ),
        },
      }
    } finally {
      if (!continued && this.core.nativeForks.get(sourceSessionId) === owner) {
        this.core.nativeForks.delete(sourceSessionId)
        if (!this.core.disposed)
          this.core.publish(this.core.conversations.metadataPatch(sourceSessionId))
      }
    }
  }

  private async forkAdapter(
    owner: { sessionId?: string; controller: AbortController },
    agentId: RuntimeAgentId,
  ) {
    const prepared = await this.core.prepareSession(owner.sessionId!, owner.controller.signal, [
      agentId,
    ])
    if (!prepared.ok) throw new Error(prepared.error.message)
    const adapter = await this.core.adapterFor(
      owner.sessionId!,
      agentId,
      prepared.value.executablePaths[agentId],
      owner.controller.signal,
      prepared.value.projectDirectory,
    )
    return { adapter, prepared: prepared.value }
  }

  private holdForkAdapter(
    owner: { activeAdapters?: Set<AgentAdapter> },
    adapter: AgentAdapter,
  ): () => void {
    owner.activeAdapters ??= new Set()
    const alreadyHeld = owner.activeAdapters.has(adapter)
    owner.activeAdapters.add(adapter)
    this.core.archiveAndQuit.nativeMetadataChanged()
    return () => {
      if (!alreadyHeld) owner.activeAdapters?.delete(adapter)
      this.core.archiveAndQuit.nativeMetadataChanged()
    }
  }

  private forkAdapterInput(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
    prepared: PreparedSession,
    phase: 'fork' | 'initialize',
  ): AgentNativeForkInput {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    const intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
    const settingsRevision = prepared.session.settingsRevision
    const current = (): boolean =>
      !this.core.disposed &&
      !owner.controller.signal.aborted &&
      this.core.conversations.forkOperation(sessionId)?.id === operationId &&
      this.core.sessions.find(sessionId)?.settingsRevision === settingsRevision &&
      this.core.sessions.find(sessionId)?.status !== 'archived'
    let dispatchedExecutor: string | undefined
    const actor = () => ({
      id: operationId,
      sessionId,
      agentId,
      bindingGeneration: 1,
      executorId:
        this.core.conversations.forkIntent(sessionId, operationId, agentId).executorId ?? undefined,
      valid: current,
    })
    return {
      operationId,
      sessionId,
      cwd: prepared.projectDirectory,
      model: prepared.session.settings.agents[agentId].model,
      effort: prepared.session.settings.agents[agentId].effort,
      permissionMode:
        prepared.session.settings.permissionModes?.[agentId] ??
        (agentId === 'codex' ? 'native' : 'ask'),
      source: intent.source,
      lastDispatchedPhase: intent.phase,
      ...(intent.nativeSessionId && !(phase === 'fork' && intent.candidateMissing)
        ? { nativeSessionId: intent.nativeSessionId }
        : {}),
      ...(intent.witness && !(phase === 'fork' && intent.candidateMissing)
        ? { witness: intent.witness }
        : {}),
      onDispatched: async (executorId) => {
        if (!current())
          throw new Error('The fork settings or operation changed before native dispatch.')
        this.core.workspaceChanges?.cancelUndoForNativeSession(sessionId)
        dispatchedExecutor = executorId
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            executorId,
            settingsRevision,
            phase,
            dispatched: true,
            state: phase === 'fork' ? 'forking' : 'initializing',
            nativeWorkState: 'pending',
            reason: null,
          }),
        )
      },
      onCandidate: async (nativeSessionId, witness) => {
        if (!current()) throw new Error('The fork candidate owner changed.')
        const saved = this.core.conversations.forkIntent(sessionId, operationId, agentId)
        if (
          dispatchedExecutor &&
          (saved.executorId !== dispatchedExecutor || saved.phase !== phase)
        )
          throw new Error('A late native candidate does not own this dispatch.')
        if (
          saved.nativeSessionId &&
          saved.nativeSessionId !== nativeSessionId &&
          !saved.candidateMissing
        )
          throw new Error('A different native candidate cannot replace this fork.')
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId,
            ...(witness ? { witnessJson: JSON.stringify(witness) } : {}),
            ...(phase === 'fork' ? { state: 'forking' as const, candidateVerified: false } : {}),
            candidateMissing: false,
          }),
        )
      },
      reportNativeWork: (report) => {
        const saved = this.core.conversations.forkIntent(sessionId, operationId, agentId)
        if (saved.executorId !== report.executorId) return
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeWorkState: report.state,
          }),
        )
      },
      requestPermission: (request, signal) =>
        this.core.interactions.requestNativePermission(actor(), request, signal),
      requestUserInput: (request, signal) =>
        this.core.interactions.requestNativeUserInput(actor(), request, signal),
    }
  }

  private async checkForkSide(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
  ): Promise<void> {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    const intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
    const alreadyReady = intent.state === 'ready'
    if (alreadyReady && this.core.conversations.latestAgentRun(sessionId, agentId)) return
    if (!intent.dispatched) return // Explicit Continue is the only creation path.
    if (!intent.nativeSessionId) {
      this.core.publish(
        this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: 'unconfirmed',
          reason:
            'Native fork may have been created, but its identity was not acknowledged. It will not be created again.',
        }),
      )
      return
    }
    const { adapter, prepared } = await this.forkAdapter(owner, agentId)
    const releaseAdapter = this.holdForkAdapter(owner, adapter)
    try {
      if (!adapter.inspectNativeFork)
        throw new Error('The native runtime does not support pure fork inspection.')
      const probe = this.forkAdapterInput(owner, agentId, prepared, 'initialize')
      // Later ordinary settings apply to the next task. Inspect the actual completed setup receipt.
      if (alreadyReady && intent.witness) {
        probe.model = intent.witness.model
        probe.effort = intent.witness.effort
        probe.permissionMode = intent.witness.permissionMode
      }
      const result = await adapter.inspectNativeFork(probe, owner.controller.signal)
      if (result.kind === 'verified') {
        if (alreadyReady && result.ready) {
          this.core.publish(this.core.conversations.metadataPatch(sessionId))
          this.core.interactions.scheduleNativeTitleSync(sessionId)
          return
        }
        const saved = this.core.conversations.forkIntent(sessionId, operationId, agentId)
        const maySettle = result.workSettled || saved.nativeWorkState === 'settled'
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId: result.result.nativeSessionId,
            witnessJson: JSON.stringify(result.result.witness),
            candidateVerified: true,
            candidateMissing: false,
            ...(maySettle ? { nativeWorkState: 'settled' as const } : {}),
            state: result.ready
              ? 'unconfirmed'
              : saved.phase === 'initialize' && !maySettle
                ? 'unconfirmed'
                : 'error',
            reason: result.ready
              ? null
              : maySettle
                ? 'Native fork verified. Continue initialization to make it ready.'
                : 'Native fork verified, but previous startup work has not been confirmed finished.',
          }),
        )
        if (result.ready) {
          this.core.publish(
            this.core.conversations.completeForkSide(
              sessionId,
              operationId,
              agentId,
              result.result.nativeSessionId,
              result.result.witness,
            ),
          )
          this.core.interactions.scheduleNativeTitleSync(sessionId)
        }
      } else
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            state: result.kind === 'missing' ? 'error' : 'unconfirmed',
            candidateVerified: false,
            candidateMissing: result.kind === 'missing',
            reason: safeNativePermissionText(result.reason).slice(0, 1024),
          }),
        )
    } finally {
      releaseAdapter()
    }
  }

  private async runForkSide(
    owner: {
      sessionId?: string
      operationId?: string
      controller: AbortController
      activeAdapters?: Set<AgentAdapter>
    },
    agentId: RuntimeAgentId,
    action: 'continue' | 'initialize',
  ): Promise<void> {
    const sessionId = owner.sessionId!,
      operationId = owner.operationId!
    let releaseAdapter: (() => void) | undefined
    try {
      let intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
      if (intent.state === 'ready') return
      this.core.publish(
        this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: action === 'continue' ? 'forking' : 'initializing',
          reason: null,
        }),
      )
      const { adapter, prepared } = await this.forkAdapter(owner, agentId)
      releaseAdapter = this.holdForkAdapter(owner, adapter)
      if (!adapter.forkNativeContext || !adapter.initializeNativeFork || !adapter.inspectNativeFork)
        throw new Error(`${agentId} cannot perform and verify a true native fork.`)
      if (action === 'continue') {
        if (intent.candidateMissing) {
          await this.checkForkSide(owner, agentId)
          intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
          if (intent.state === 'ready') return
        }
        if (intent.dispatched && !intent.candidateMissing)
          throw new Error(
            'Check the original native candidate before continuing. A possibly delivered fork will not be repeated.',
          )
        const operation = this.core.conversations.forkOperation(sessionId)!
        if (
          this.core.gate.hasSessionOperation(operation.sourceSessionId, true, owner) ||
          this.core.conversations.sessionHasNativeWork(operation.sourceSessionId)
        )
          throw new Error(
            'The source session is running. Wait for it to finish before continuing native fork creation.',
          )
        const result = await adapter.forkNativeContext(
          this.forkAdapterInput(owner, agentId, prepared, 'fork'),
          owner.controller.signal,
        )
        this.core.publish(
          this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
            nativeSessionId: result.nativeSessionId,
            witnessJson: JSON.stringify(result.witness),
            candidateVerified: true,
            candidateMissing: false,
          }),
        )
        intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
      } else {
        await this.checkForkSide(owner, agentId)
        intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
        if (intent.state === 'ready') return
      }
      if (
        !intent.candidateVerified ||
        !intent.nativeSessionId ||
        !intent.witness ||
        intent.nativeWorkState !== 'settled'
      )
        throw new Error(
          'The original native candidate or its previous work is not yet confirmed. No new initialization was started.',
        )
      const result = await adapter.initializeNativeFork(
        this.forkAdapterInput(owner, agentId, prepared, 'initialize'),
        owner.controller.signal,
      )
      if (
        this.core.sessions.find(sessionId)?.settingsRevision !== prepared.session.settingsRevision
      )
        throw new Error(
          'Session settings changed during native initialization. Check this candidate again.',
        )
      this.core.publish(
        this.core.conversations.completeForkSide(
          sessionId,
          operationId,
          agentId,
          result.nativeSessionId,
          result.witness,
        ),
      )
      this.core.interactions.scheduleNativeTitleSync(sessionId)
    } catch (error) {
      const intent = this.core.conversations.forkIntent(sessionId, operationId, agentId)
      this.core.publish(
        this.core.conversations.updateForkIntent(sessionId, operationId, agentId, {
          state: intent.dispatched && !intent.nativeSessionId ? 'unconfirmed' : 'error',
          reason: safeNativePermissionText(
            error instanceof Error ? error.message : 'Native fork could not be confirmed.',
          ).slice(0, 1024),
        }),
      )
    } finally {
      releaseAdapter?.()
    }
  }

  /** One physical compiler, bounded waiting identities, durable derived pages and no retained AST. */
}
