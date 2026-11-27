import { createHash, randomUUID } from 'node:crypto'

import type {
  ConversationPatch,
  DecisionEvaluationOutcome,
  DecisionHttpOwner,
  DecisionInput,
  RelayDecisionAnswer,
  RelayDecisionReceipt,
  RelayDecisionReceiptRead,
  RpcResult,
  SchedulingEligibility,
  SchedulingHandoff,
  SchedulingState,
  SchedulingStateInput,
  SessionIssues,
} from '@pact/contracts'

import {
  AGENTS,
  collaborationInputGate,
  DECISION_CLEANUP_TARGET_MS,
  DECISION_HTTP_OWNER_BYTES,
  DECISION_PHYSICAL_RECEIPT_ITEMS,
  decisionHttpOwnerSchema,
  NATIVE_PERMISSION_REQUESTS,
  preparedInputContinueSchema,
  relayCredentialWriteSchema,
  relayDecisionAnswerSchema,
  relayDecisionReceiptReadSchema,
  SCHEDULING_CAPABILITY_TTL_MS,
  schedulingCheckPhysicalOwnerSchema,
  schedulingSettingsSchema,
  schedulingStateInputSchema,
  schedulingStateSchema,
} from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'
import { RunOperationConflictError } from '@pact/persistence'

import type { ConversationRuntimeCore } from '../conversation-runtime-core'
import type { DecisionInvocationOwner } from '../conversation-types'
import type { DecisionInputLoader, DecisionRuntime } from '../decision-runtime'
import type { RelayPolicyAdmission } from '../relay-policy'

import { recordDiagnostic } from '../../../diagnostics/utility-log'
import { OwnedProcessGroup } from '../../owned-process-group'
import { MAX_AGENT_OPERATIONS } from '../conversation-types'
import { NativeWorkingMemory, type NativeMemoryAllocator } from '../native-working-memory'
import { OpenAIDecisionRuntime } from '../openai-decision-runtime'

export class SchedulingDecisionCoordinator {
  constructor(private readonly core: ConversationRuntimeCore) {}

  subscribeSchedulingChanges(listener: () => void): () => void {
    if (this.core.schedulingListener)
      throw new Error('Scheduling already has its Utility subscriber.')
    const unsubscribe = this.core.conversations.subscribeSchedulingChanges(listener)
    this.core.schedulingListener = listener
    return () => {
      if (this.core.schedulingListener === listener) this.core.schedulingListener = undefined
      unsubscribe()
    }
  }

  getSchedulingSettings(): RpcResult<import('@pact/contracts').SchedulingSettings> {
    const parsed = schedulingSettingsSchema.safeParse(this.core.conversations.schedulingSettings())
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          error: { code: 'INTERNAL', message: 'Scheduling settings could not be confirmed.' },
        }
  }

  private schedulingScope(sessionId: string | undefined) {
    if (!sessionId) return { sessionId: null, cwd: undefined, key: 'host' }
    const session = this.core.sessions.find(sessionId)
    const project = session && this.core.projects.find(session.projectId)
    if (!session || !project)
      throw new RunOperationConflictError('The scheduling context is unavailable.')
    return {
      sessionId,
      cwd: project.directoryPath,
      key: JSON.stringify([sessionId, project.id, project.directoryPath]),
    }
  }

  private schedulingConnection(): SchedulingState['connection'] {
    const saved = this.core.decisionConnection
    if (!saved?.expiresAt) return { status: 'unconfirmed', checkedAt: null, expiresAt: null }
    const stale =
      Date.parse(saved.expiresAt) <= Date.now() ||
      saved.generation !== this.core.conversations.schedulingConfigurationGeneration()
    return {
      status: stale ? 'stale' : saved.status,
      checkedAt: saved.checkedAt,
      expiresAt: saved.expiresAt,
    }
  }

  private schedulingEligibility(sessionId: string): SchedulingEligibility {
    const settings = this.core.conversations.schedulingSettings()
    if (!settings.enabled) return 'disabled'
    if (!settings.credential.configured) return 'key_required'
    const session = this.core.sessions.find(sessionId)
    if (
      !session ||
      session.status === 'archived' ||
      this.core.projects.find(session.projectId)?.archivedAt ||
      this.core.conversations.archives.blocksSession(sessionId)
    )
      return 'archived'
    if (this.core.interactions.pendingNativeInteractions(sessionId).length)
      return 'native_interaction'
    const task = this.core.conversations.collaboration(sessionId)
    if (task?.automation === 'paused') return 'paused'
    if (
      this.core.conversations.receivedCollaborationInput(sessionId) ||
      this.core.conversations.hasPendingRoutedContinuation(sessionId) ||
      (task && collaborationInputGate(task))
    )
      return 'input_pending'
    if (this.core.conversations.nativeRecoveryBlocksInput(sessionId)) return 'recovery_required'
    if (
      this.core.gate.hasSessionOperation(sessionId, true) ||
      this.core.decisionRuntime ||
      this.core.decisionRecovery ||
      this.core.conversations.activeSchedulingRuntimeOwner()
    )
      return 'busy'
    const connection = this.schedulingConnection()
    return connection.status === 'available'
      ? 'available'
      : connection.status === 'unavailable'
        ? 'unavailable'
        : 'unconfirmed'
  }

  /** Pure projection: neither reading Settings nor the indicator starts provider work. */
  getSchedulingState(raw: SchedulingStateInput): RpcResult<SchedulingState> {
    try {
      const input = schedulingStateInputSchema.parse(raw)
      const scope = this.schedulingScope(input.sessionId)
      const owner = this.core.conversations.activeSchedulingRuntimeOwner()
      const live = this.core.decisionRuntime
      const activity: SchedulingState['activity']['decision'] =
        owner && owner.kind !== 'check'
          ? {
              status:
                owner.phase === 'cleanup_unconfirmed' ||
                live?.settling ||
                !live ||
                live.operationId !== owner.id
                  ? 'cleanup_unconfirmed'
                  : 'evaluating',
              operationId: owner.id,
              sessionId: owner.sessionId,
            }
          : live?.settling && live.runtime
            ? {
                status: 'cleanup_unconfirmed',
                operationId: live.operationId,
                sessionId: live.sessionId,
              }
            : this.core.decisionRecoveryOwner
              ? { status: 'cleanup_unconfirmed', ...this.core.decisionRecoveryOwner }
              : { status: 'idle' }
      const value = schedulingStateSchema.parse({
        settings: this.core.conversations.schedulingSettings(),
        configurationGeneration: this.core.conversations.schedulingConfigurationGeneration(),
        connection: this.schedulingConnection(),
        context: scope.sessionId
          ? {
              sessionId: scope.sessionId,
              eligibility: this.schedulingEligibility(scope.sessionId),
            }
          : null,
        activity: {
          decision: activity,
          check:
            owner?.kind === 'check' && owner.sessionId
              ? {
                  status:
                    owner.phase !== 'cleanup_unconfirmed' &&
                    [...this.core.nativeChecks.values()].find(
                      (entry) => entry.automaticAttemptId === owner.id,
                    )?.phase === 'checking'
                      ? 'checking'
                      : 'cleanup_unconfirmed',
                  operationId: owner.id,
                  sessionId: owner.sessionId,
                }
              : { status: 'idle' },
        },
      })
      return { ok: true, value }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  private async retireSchedulingPhysicalReceipts(facts: {
    memory: NativeMemoryAllocator
    deadlineAt: number
    signal?: AbortSignal | undefined
  }): Promise<boolean> {
    if (process.platform !== 'win32') return true
    let cursor: string | undefined
    for (let index = 0; index < DECISION_PHYSICAL_RECEIPT_ITEMS; index++) {
      if (facts.signal?.aborted || Date.now() >= facts.deadlineAt) break
      const receipt = this.core.conversations.claimSchedulingPhysicalReceipt(cursor)
      if (!receipt) break
      cursor = receipt.receiptId
      // oxlint-disable-next-line no-await-in-loop -- One serial helper inside the existing decision lease and shared deadline.
      const result = await OwnedProcessGroup.cleanupPhysicalReceipt(
        receipt.witness,
        undefined,
        facts.memory,
        {
          deadlineAt: facts.deadlineAt,
          ...(facts.signal ? { signal: facts.signal } : {}),
        },
      )
      if (result === 'removed' || result === 'already_absent')
        this.core.conversations.acknowledgeSchedulingPhysicalReceipt(
          receipt.receiptId,
          receipt.witnessJson,
        )
    }
    return this.core.conversations.schedulingPhysicalReceiptCapacityAvailable()
  }

  /** The host supplies complete facts; the result cannot dispatch or authorize a business Turn. */
  async evaluateDecision(
    request:
      | DecisionInput
      | {
          handoff: SchedulingHandoff
          load: DecisionInputLoader
          retainHandoff?: boolean
        }
      | { sessionId: string; prepare: DecisionInputLoader },
    signal: AbortSignal,
  ): Promise<DecisionEvaluationOutcome> {
    const requestedHandoff = 'prepare' in request ? undefined : request.handoff
    const requestedSessionId = 'prepare' in request ? request.sessionId : request.handoff.sessionId
    const settings = this.core.conversations.schedulingSettings()
    if (this.core.disposed || !settings.enabled || !settings.credential.configured)
      return { kind: 'unavailable', reason: 'disabled' }
    if (this.core.decisionRuntime) return { kind: 'unavailable', reason: 'busy' }
    const available = () => {
      if (this.core.disposed || this.core.gate.nativeQuitSealed()) return undefined
      try {
        if (this.core.conversations.archives.blocksSession(requestedSessionId)) return undefined
        const session = this.core.sessions.find(requestedSessionId)
        if (!session || session.status === 'archived') return undefined
        const project = this.core.projects.find(session.projectId)
        return project && !project.archivedAt ? { session, project } : undefined
      } catch {
        return undefined
      }
    }
    const scope = available()
    if (!scope) return { kind: 'unavailable', reason: 'stale' }
    const { session, project } = scope
    const configurationGeneration = this.core.conversations.schedulingConfigurationGeneration()
    const credentialRevision = settings.credential.revision
    if (signal.aborted || this.core.disposed) return { kind: 'unavailable', reason: 'cancelled' }
    if (
      !available() ||
      this.core.conversations.schedulingConfigurationGeneration() !== configurationGeneration
    )
      return { kind: 'unavailable', reason: 'stale' }
    if (this.core.decisionRuntime) return { kind: 'unavailable', reason: 'busy' }
    let handoff = requestedHandoff
    let evaluationId: string | undefined
    let deadlineAt = 0
    const configurationFingerprint = this.core.conversations.schedulingConfigurationFingerprint()
    const controller = new AbortController()
    const invocationSignal = AbortSignal.any([signal, controller.signal])
    const invocationDeadlineAt = Date.now() + 15_000
    const current = () => {
      const liveScope = available()
      if (!liveScope) return false
      const saved = this.core.conversations.schedulingSettings()
      return (
        liveScope.project.id === project.id &&
        liveScope.project.directoryPath === project.directoryPath &&
        !invocationSignal.aborted &&
        saved.enabled &&
        saved.credential.configured &&
        saved.credential.revision === credentialRevision &&
        this.core.conversations.schedulingConfigurationGeneration() === configurationGeneration &&
        this.core.interactions.pendingNativeInteractions(session.id).length === 0 &&
        (!handoff || this.core.conversations.evaluationIsCurrent(handoff))
      )
    }
    if (!current()) return { kind: 'unavailable', reason: 'stale' }
    const existing = handoff && this.core.conversations.decisionEvaluationReceipt(handoff)
    // This intent owns no native resource or source body. It only merges automatic wakes.
    const owner: DecisionInvocationOwner = {
      kind: 'evaluation',
      operationId: randomUUID(),
      sessionId: session.id,
      handoff,
      controller,
      current,
      consulting: true,
    }
    this.core.decisionRuntime = owner
    if (existing) {
      // Inspect the stored owner, never wait for its process to exit or replay its inference.
      // An already absent owner must settle before returning the original duplicate receipt.
      await this.waitForDecisionRecovery(invocationDeadlineAt, invocationSignal)
      owner.consulting = 'load' in request && request.retainHandoff === true
      if (!owner.consulting && this.core.decisionRuntime === owner)
        this.core.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'duplicate' }
    }
    if (this.core.conversations.activeSchedulingRuntimeOwner() || this.core.decisionRecovery) {
      void this.recoverDecisionReservation()
      if (this.core.decisionRuntime === owner) this.core.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'busy' }
    }
    // Retain the preflight checkpoint: Quit/Archive may linearize before resource admission.
    await Promise.resolve()
    if (!current() || Date.now() >= invocationDeadlineAt) {
      if (this.core.decisionRuntime === owner) this.core.decisionRuntime = undefined
      return {
        kind: 'unavailable',
        reason: Date.now() >= invocationDeadlineAt ? 'timeout' : 'stale',
      }
    }
    const httpOwner: DecisionHttpOwner = {
      version: 1,
      kind: 'http',
      utilityEpoch: this.core.utilityEpoch,
      utilityPid: process.pid,
      requestId: owner.operationId,
    }
    let runtime: DecisionRuntime
    try {
      runtime = new OpenAIDecisionRuntime({
        deadlineAt: invocationDeadlineAt,
        current,
        credential: (facts) =>
          this.core.loadDecisionCredential
            ? this.core.loadDecisionCredential({
                signal: facts.signal,
                deadlineAt: facts.deadlineAt,
              })
            : null,
        reserve: (admitted, facts) => {
          handoff = admitted.handoff
          owner.handoff = handoff
          deadlineAt = facts.deadlineAt
          if (!current()) throw new Error('Decision invocation is no longer eligible.')
          const reservation = this.core.conversations.reserveEvaluation({
            handoff,
            configurationFingerprint,
            inputSha256: createHash('sha256').update(JSON.stringify(admitted)).digest('hex'),
            deadlineAt,
            httpOwner,
          })
          if (reservation.status === 'reserved') {
            evaluationId = reservation.evaluation.id
            owner.reserved = true
            return 'reserved'
          }
          return reservation.status === 'duplicate' ? 'duplicate' : 'busy'
        },
        dispatch: () => {
          if (
            !evaluationId ||
            !current() ||
            !this.core.conversations.dispatchEvaluation(evaluationId, httpOwner).created
          )
            throw new Error('Decision invocation is no longer eligible.')
        },
      })
    } catch {
      if (this.core.decisionRuntime === owner) this.core.decisionRuntime = undefined
      return { kind: 'unavailable', reason: 'busy' }
    }
    owner.runtime = runtime
    let outcome = await runtime.evaluateDecision(
      async (context: Parameters<DecisionInputLoader>[0]) => {
        context.signal.throwIfAborted()
        if (!current()) throw new Error('Decision invocation is no longer eligible.')
        const input =
          'prepare' in request
            ? await request.prepare(context)
            : 'load' in request
              ? await request.load(context)
              : request
        if (input.handoff.sessionId !== session.id)
          throw new Error('Decision input belongs to another Session.')
        handoff = input.handoff
        owner.handoff = handoff
        if (!current()) throw new Error('Decision invocation is no longer eligible.')
        return input
      },
      invocationSignal,
    )
    owner.consulting = 'load' in request && request.retainHandoff === true
    if (outcome.kind === 'selection' && !current())
      outcome = { kind: 'unavailable', reason: 'stale' }
    const diagnostics = runtime.diagnostics()
    const terminal = runtime.invoked
      ? outcome.kind === 'selection'
        ? 'completed'
        : 'failed'
      : 'not_sent'
    if (evaluationId)
      this.core.conversations.settleEvaluation(evaluationId, {
        outcome: terminal,
        selectedCandidateId: outcome.kind === 'selection' ? outcome.selection.candidateId : null,
        physicalReleased: false,
        ...(runtime.usage ? { usage: runtime.usage } : {}),
        httpOwner,
        remoteOutcome: diagnostics.remoteOutcome,
      })
    void runtime
      .settlement()
      .then((released) => {
        if (evaluationId)
          this.core.conversations.settleEvaluation(evaluationId, {
            outcome: terminal,
            selectedCandidateId:
              outcome.kind === 'selection' ? outcome.selection.candidateId : null,
            physicalReleased: released,
            ...(runtime.usage ? { usage: runtime.usage } : {}),
            httpOwner,
            remoteOutcome: runtime.diagnostics().remoteOutcome,
          })
        if (released) {
          owner.runtime = undefined
          if (!owner.consulting && this.core.decisionRuntime === owner)
            this.core.decisionRuntime = undefined
          const liveScope = available()
          const unchanged =
            liveScope?.project.directoryPath === project.directoryPath &&
            this.core.conversations.schedulingConfigurationGeneration() === configurationGeneration
          if (
            evaluationId &&
            unchanged &&
            (outcome.kind === 'selection' ||
              !['cancelled', 'stale', 'busy', 'duplicate'].includes(outcome.reason))
          ) {
            // Only a genuine provider attempt updates the app-wide connection observation.
            this.core.decisionConnection = {
              status: outcome.kind === 'selection' ? 'available' : 'unavailable',
              checkedAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + SCHEDULING_CAPABILITY_TTL_MS).toISOString(),
              generation: configurationGeneration,
            }
          }
          this.core.schedulingListener?.()
          // A completed attempt releases the single Decision slot for other waiting Sessions.
          // Duplicate facts are filtered before allocating a runtime, so this is not a retry loop.
          if (handoff) this.core.collaboration.schedulePendingRoutedContinuations()
        }
        return undefined
      })
      .catch(() => undefined)
    if (outcome.kind !== 'selection') return outcome
    if (!evaluationId || !deadlineAt || !handoff)
      return { kind: 'unavailable', reason: 'invalid_output' }
    return {
      ...outcome,
      evaluationReceipt: {
        evaluationId,
        handoffId: handoff.id,
        configurationGeneration,
        configurationFingerprint,
        deadlineAt,
      },
    }
  }

  /** At most one current admission and one unreconciled durable owner; identical Sessions coalesce. */
  decisionSessionIds(): Set<string> {
    const identities = new Set<string>()
    if (this.core.decisionRuntime?.runtime && this.core.decisionRuntime.sessionId)
      identities.add(this.core.decisionRuntime.sessionId)
    if (this.core.decisionRecoveryOwner?.sessionId)
      identities.add(this.core.decisionRecoveryOwner.sessionId)
    const saved = this.core.conversations.activeSchedulingRuntimeOwner()
    if (saved?.sessionId) identities.add(saved.sessionId)
    return identities
  }

  recoverDecisionReservation(): Promise<void> {
    if (this.core.decisionRecovery) return this.core.decisionRecovery
    if (this.core.decisionRuntime?.runtime || this.core.disposed) return Promise.resolve()
    const saved = this.core.conversations.activeSchedulingRuntimeOwner()
    if (saved?.kind === 'check') return this.recoverSchedulingCheck(saved.id)
    if (saved?.provider === 'openai') return this.recoverSchedulingHttpOwner(saved)
    const hasReceipts =
      process.platform === 'win32' && this.core.conversations.hasSchedulingPhysicalReceipts()
    if (!saved?.physicalWitnessJson && !hasReceipts) return Promise.resolve()
    const deadlineAt = Date.now() + DECISION_CLEANUP_TARGET_MS
    const memory = new NativeWorkingMemory('decision')
    const recoveryOwner = {
      operationId: saved?.id ?? randomUUID(),
      sessionId: saved?.sessionId ?? null,
    }
    this.core.decisionRecoveryOwner = recoveryOwner
    const recovery = (async () => {
      if (saved?.physicalWitnessJson) {
        let witness: unknown
        try {
          witness = JSON.parse(saved.physicalWitnessJson)
        } catch {
          return
        }
        if (
          await OwnedProcessGroup.provePhysicalRelease(witness, undefined, memory, { deadlineAt })
        )
          this.core.conversations.settleSchedulingOwnerAfterPhysicalProof(
            saved.id,
            saved.physicalWitnessJson,
            saved.nativeGeneration,
          )
      }
      await this.retireSchedulingPhysicalReceipts({ memory, deadlineAt })
    })().catch(() => undefined)
    this.core.decisionRecovery = recovery
    void recovery.then(() => {
      if (this.core.decisionRecovery === recovery) this.core.decisionRecovery = undefined
      if (this.core.decisionRecoveryOwner === recoveryOwner)
        this.core.decisionRecoveryOwner = undefined
      this.core.schedulingListener?.()
      return undefined
    })
    return recovery
  }

  /**
   * An HTTP owner has no native witness. Only a positive OS absence proof for its
   * stored Utility PID authorizes release; live, reused or unverifiable PIDs retain it.
   */
  private recoverSchedulingHttpOwner(saved: {
    id: string
    kind: string
    sessionId: string | null
    httpOwnerJson: string | null
  }): Promise<void> {
    const raw = saved.httpOwnerJson
    if (!raw || Buffer.byteLength(raw) > DECISION_HTTP_OWNER_BYTES) return Promise.resolve()
    let parsed: ReturnType<typeof decisionHttpOwnerSchema.safeParse>
    try {
      parsed = decisionHttpOwnerSchema.safeParse(JSON.parse(raw))
    } catch {
      return Promise.resolve()
    }
    if (!parsed.success || saved.kind !== 'evaluation' || parsed.data.requestId !== saved.id)
      return Promise.resolve()
    // A stored same-PID owner stays unresolved: rebuilding Conversation is not Utility exit.
    if (parsed.data.utilityPid === process.pid) return Promise.resolve()
    const ownerJson = raw,
      proof = parsed.data,
      id = saved.id
    const recoveryOwner = { operationId: saved.id, sessionId: saved.sessionId ?? null }
    this.core.decisionRecoveryOwner = recoveryOwner
    const recovery = (async () => {
      let absent = false
      try {
        process.kill(proof.utilityPid, 0)
      } catch (error) {
        absent =
          typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ESRCH'
      }
      if (!absent) return
      this.core.conversations.settleSchedulingHttpOwnerAfterExit(id, ownerJson)
    })().catch(() => undefined)
    this.core.decisionRecovery = recovery
    void recovery.then(() => {
      if (this.core.decisionRecovery === recovery) this.core.decisionRecovery = undefined
      if (this.core.decisionRecoveryOwner === recoveryOwner)
        this.core.decisionRecoveryOwner = undefined
      this.core.schedulingListener?.()
      return undefined
    })
    return recovery
  }

  private recoverSchedulingCheck(id: string): Promise<void> {
    const attempt = this.core.conversations.schedulingRecoveryAttempt(id)
    if (
      !attempt ||
      attempt.utilityPid === process.pid ||
      !Number.isSafeInteger(attempt.utilityPid) ||
      attempt.utilityPid <= 0
    )
      return Promise.resolve()
    const recovery = (async () => {
      try {
        process.kill(attempt.utilityPid, 0)
        return
      } catch (error) {
        if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ESRCH') return
      }
      const owner = schedulingCheckPhysicalOwnerSchema.safeParse(
        JSON.parse(attempt.physicalOwnerJson),
      )
      if (!owner.success || owner.data.kind === 'inspection_pending') return
      if (
        owner.data.kind === 'inspection_group' &&
        !(await OwnedProcessGroup.provePhysicalRelease(owner.data.witness))
      )
        return
      this.core.conversations.settleSchedulingRecoveryCheck(id, {
        ok: false,
        physicalReleased: true,
        retire: true,
      })
    })().catch(() => undefined)
    this.core.decisionRecovery = recovery
    void recovery.then(() => {
      if (this.core.decisionRecovery === recovery) this.core.decisionRecovery = undefined
      this.core.schedulingListener?.()
      return undefined
    })
    return recovery
  }

  private async waitForDecisionRecovery(deadlineAt: number, signal: AbortSignal): Promise<void> {
    const recovery = this.recoverDecisionReservation()
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, Math.max(0, deadlineAt - Date.now()))
      signal.addEventListener('abort', finish, { once: true })
      void recovery.then(finish, finish)
      if (signal.aborted) finish()
    })
  }

  async saveSchedulingSettings(
    input: import('@pact/contracts').SchedulingSettingsSave,
  ): Promise<RpcResult<import('@pact/contracts').SchedulingSettings>> {
    try {
      if (this.core.disposed) throw new Error('The scheduling owner is no longer available.')
      const generation = this.core.conversations.schedulingConfigurationGeneration()
      const saved = this.core.conversations.saveSchedulingSettings(input, (patch) =>
        this.core.publish(patch),
      )
      if (this.core.conversations.schedulingConfigurationGeneration() !== generation) {
        this.core.decisionConnection = undefined
        this.core.decisionRuntime?.controller.abort()
        for (const check of this.core.nativeChecks.values())
          if (check.automaticAttemptId) check.controller.abort()
        void this.core.decisionRuntime?.runtime?.dispose()
        this.core.collaboration.schedulePendingRoutedContinuations()
      }
      return { ok: true, value: saved }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  /** Credential mutation owner: same config-generation lifecycle as saveSchedulingSettings. */
  async writeRelayCredential(
    input: import('@pact/contracts').RelayCredentialWrite,
  ): Promise<
    import('@pact/contracts').RpcResult<import('@pact/contracts').RelayCredentialReceipt>
  > {
    let generation: number | undefined
    let deadlineAt = 0
    try {
      if (this.core.disposed)
        return {
          ok: false,
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'The scheduling owner is no longer available.',
          },
        }
      const parsed = relayCredentialWriteSchema.safeParse(input)
      if (!parsed.success)
        return {
          ok: false,
          error: { code: 'VALIDATION', message: 'The credential request is invalid.' },
        }
      deadlineAt = parsed.data.deadlineAt
      if (deadlineAt <= Date.now())
        return {
          ok: false,
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Secure credential storage is unavailable.',
          },
        }
      generation = this.core.conversations.schedulingConfigurationGeneration()
      const receipt = this.core.conversations.writeRelayCredential(parsed.data, (patch) =>
        this.core.publish(patch),
      )
      return { ok: true, value: receipt }
    } catch {
      // An unacknowledged outcome may still have committed; retained nonce + receipt
      // readback is the status check, never another implicit mutation.
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Couldn’t confirm the API key change. Check its current status.',
        },
      }
    } finally {
      if (generation !== undefined) {
        // A notification can fail after commit. That cannot leave the old key's
        // invocation running or authorize an automatic retry of the mutation.
        let changed = true
        try {
          changed = this.core.conversations.schedulingConfigurationGeneration() !== generation
        } catch {
          // An unreadable configuration cannot prove the old invocation is still current.
        }
        if (changed) {
          this.core.decisionConnection = undefined
          this.core.decisionRuntime?.controller.abort()
          for (const check of this.core.nativeChecks.values())
            if (check.automaticAttemptId) check.controller.abort()
          const cleanup = this.core.decisionRuntime?.runtime?.dispose().catch(() => false)
          this.core.collaboration.schedulePendingRoutedContinuations()
          if (cleanup) {
            let timer: ReturnType<typeof setTimeout> | undefined
            await Promise.race([
              cleanup,
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), Math.max(0, deadlineAt - Date.now()))
                timer.unref?.()
              }),
            ]).finally(() => clearTimeout(timer))
            // The response confirms the durable credential receipt only. The runtime
            // retains any unjoined physical owner through its existing settlement path.
          }
        }
      }
    }
  }

  readSchedulingActivity(
    input: import('@pact/contracts').SchedulingActivityRead,
  ): RpcResult<import('@pact/contracts').SchedulingActivityPage> {
    try {
      return { ok: true, value: this.core.conversations.readSchedulingActivity(input) }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Scheduling activity could not be loaded.' },
      }
    }
  }

  projectRelaySchedulingDecision(sessionId: string, issues?: SessionIssues) {
    const card = this.core.conversations.relaySchedulingDecision(sessionId)
    if (!card) {
      if (this.core.conversations.discardStaleRelaySchedulingDecision(sessionId))
        this.core.collaboration.schedulePendingRoutedContinuations()
      return null
    }
    const task = this.core.conversations.collaboration(sessionId)
    const recovery =
      issues ??
      this.core.gate.sessionIssues(
        sessionId,
        AGENTS.flatMap((actor) => {
          const context = this.core.conversations.nativeContext(sessionId, actor)
          return context ? [context] : []
        }),
      )
    const nativeRecovery =
      card.request.category === 'arrangement_change' &&
      card.request.operation.kind === 'rebuild_native_context'
        ? card.request.operation
        : undefined
    const representedIssue = (issue: SessionIssues['agents'][number]): boolean =>
      Boolean(
        nativeRecovery &&
        issue.action === 'rebuild' &&
        issue.agentId === nativeRecovery.agentId &&
        issue.generation === nativeRecovery.expectedGeneration &&
        (issue.nativeSessionId ?? null) === nativeRecovery.expectedNativeSessionId &&
        (issue.runId ?? null) === nativeRecovery.expectedRunId &&
        (issue.rebuildId ?? null) === nativeRecovery.expectedRebuildId &&
        issue.abandon === nativeRecovery.abandonOldWork,
      )
    if (
      this.core.interactions.pendingNativeInteractions(sessionId).length ||
      recovery.agents.some((issue) => !representedIssue(issue)) ||
      (!nativeRecovery && this.core.conversations.nativeRecoveryBlocksInput(sessionId)) ||
      (nativeRecovery &&
        ([...this.core.nativeChecks.keys()].some((key) => key.startsWith(`${sessionId}:`)) ||
          this.core.conversations.rebuildInputRecovery(sessionId))) ||
      (task &&
        (collaborationInputGate(task) ||
          this.core.conversations.needsWorkflowPlanRecovery(task.runId)))
    )
      return null
    return card
  }

  getRelayDecisionReceipt(raw: RelayDecisionReceiptRead): RpcResult<RelayDecisionReceipt> {
    try {
      const input = relayDecisionReceiptReadSchema.parse(raw)
      const receipt = this.core.conversations.relayDecisionReceipt(input)
      if (!receipt)
        throw new RunOperationConflictError(
          'This Relay answer has not been recorded. No action was repeated.',
        )
      return { ok: true, value: receipt }
    } catch (error) {
      return this.core.sendFailure(error)
    }
  }

  async answerRelayDecision(raw: RelayDecisionAnswer): Promise<RpcResult<RelayDecisionReceipt>> {
    let committedCancellation: RelayDecisionReceipt | undefined
    let unusedReceiptId: string | undefined
    let unusedPrepared: import('@pact/persistence').PreparedInputDispatch | undefined
    try {
      const input = relayDecisionAnswerSchema.parse(raw)
      const sessionId = input.reference.sessionId
      if (this.core.disposed) return this.core.shuttingDown()
      if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
      if (this.core.conversations.archives.blocksSession(sessionId)) return this.core.archiveBusy()
      const existing = this.core.conversations.relayDecisionReceipt({
        sessionId,
        decisionId: input.reference.decisionId,
        clientOperationId: input.clientOperationId,
      })
      const card = !existing ? this.projectRelaySchedulingDecision(sessionId) : null
      // The Repository checks the original digest even for identical answer readback.
      if (!existing && input.answer.kind !== 'cancel' && !card)
        throw new RunOperationConflictError(
          'Resolve the current native or collaboration interaction before confirming this scheduling action.',
        )
      if (
        !existing &&
        input.answer.kind !== 'cancel' &&
        (card?.request.category === 'necessary_information' ||
          (input.answer.kind === 'confirm' &&
            (card?.request.category === 'arrangement_change' ||
              card?.request.category === 'new_authorization'))) &&
        (this.core.gate.hasSessionOperation(sessionId) ||
          this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS ||
          this.core.permissions.size >= NATIVE_PERMISSION_REQUESTS)
      )
        return this.core.capacityFailure()
      const answer = this.core.conversations.answerRelaySchedulingDecision(input)
      // Own the committed intent before projection or listener code can fail.
      if (answer.created && answer.receiptId) unusedReceiptId = answer.receiptId
      // Only the successful Repository call has checked the original request digest and committed.
      if (
        input.answer.kind === 'cancel' &&
        answer.result.disposition === 'cancelled' &&
        answer.result.sessionId === sessionId &&
        answer.result.decisionId === input.reference.decisionId &&
        answer.result.clientOperationId === input.clientOperationId &&
        answer.result.runId === null &&
        answer.result.rebuildId === null
      )
        committedCancellation = answer.result
      this.core.publish(
        this.core.conversations.metadataPatch(
          sessionId,
          answer.draftsChanged ? { draftsChanged: true } : {},
        ),
      )
      if (answer.created && 'preparedInput' in answer && answer.preparedInput) {
        unusedPrepared = answer.preparedInput.receipt
        const sent = await this.core.sendAndSteer.enqueueSend(answer.preparedInput.input, {
          preparedInput: unusedPrepared,
        })
        if (!sent.ok) return sent
      }
      if (answer.created && 'nativeRebuild' in answer && answer.nativeRebuild)
        this.core.recovery.startNativeRebuildOperation(
          sessionId,
          answer.nativeRebuild.agentId,
          answer.nativeRebuild.operationId,
        )
      if (answer.created && answer.receiptId) {
        const prepared = this.core.conversations.preparedRelayWorkflowAction(answer.receiptId)
        const dispatched = await this.core.collaboration.startWorkflowTurn(
          prepared.task,
          prepared.next,
          input.clientOperationId,
          prepared.receipt.id,
          prepared.handoff,
        )
        if (!dispatched.ok) return dispatched
      }
      if (!committedCancellation) this.core.collaboration.schedulePendingRoutedContinuations()
      return {
        ok: true,
        value:
          this.core.conversations.relayDecisionReceipt({
            sessionId,
            decisionId: input.reference.decisionId,
            clientOperationId: input.clientOperationId,
          }) ?? answer.result,
      }
    } catch (error) {
      if (committedCancellation) {
        recordDiagnostic({
          operation: 'ipc',
          scope: 'request',
          requestType: 'relay.decision.answer.request',
          phase: 'failed',
          level: 'warn',
          sessionId: committedCancellation.sessionId,
          operationId: committedCancellation.clientOperationId,
          code: 'INTERNAL',
          failureSource: 'classified_error',
          runtimeBoundary: 'projection',
          runtimeErrorType:
            diagnosticEventSchema.shape.runtimeErrorType.safeParse(
              error instanceof Error ? error.name : 'other',
            ).data ?? 'other',
        })
        // Projection failure cannot undo this fact; receipt readback never repeats the action.
        return { ok: true, value: committedCancellation }
      }
      return this.core.sendFailure(error)
    } finally {
      if (unusedPrepared) {
        const draftsChanged = this.core.conversations.cancelPreparedInputDispatch(
          unusedPrepared,
          'preparation_failed',
        )
        if (!this.core.disposed)
          this.core.publish(
            this.core.conversations.metadataPatch(unusedPrepared.sessionId, { draftsChanged }),
          )
      }
      if (unusedReceiptId) {
        const patch = this.core.conversations.releaseUnusedRelayWorkflowAction(
          unusedReceiptId,
          true,
        )
        if (patch && !this.core.disposed) this.core.publish(patch)
      }
      if (committedCancellation) this.core.collaboration.schedulePendingRoutedContinuations()
    }
  }

  async continuePreparedInput(
    raw: import('@pact/contracts').PreparedInputContinue,
  ): Promise<RpcResult<ConversationPatch>> {
    let claimed: import('@pact/persistence').PreparedInputDispatch | undefined
    try {
      const input = preparedInputContinueSchema.parse(raw),
        old = this.core.conversations.readPreparedInputContinue(input)
      if (old) return { ok: true, value: old }
      if (this.core.disposed) return this.core.shuttingDown()
      if (this.core.gate.nativeQuitSealed()) return this.core.quitPrepared()
      if (this.core.conversations.archives.blocksSession(input.sessionId))
        return this.core.archiveBusy()
      if (
        this.core.gate.hasSessionOperation(input.sessionId) ||
        this.core.interactions.pendingNativeInteractions(input.sessionId).length ||
        this.core.gate.operationCount() >= MAX_AGENT_OPERATIONS
      )
        return this.core.capacityFailure()
      const prepared = this.core.conversations.continuePreparedInput(input)
      if (!prepared.created) return { ok: true, value: prepared.patch }
      claimed = prepared.receipt
      this.core.publish(this.core.conversations.metadataPatch(input.sessionId))
      return await this.core.sendAndSteer.enqueueSend(prepared.input, { preparedInput: claimed })
    } catch (error) {
      return this.core.sendFailure(error)
    } finally {
      if (claimed) {
        const draftsChanged = this.core.conversations.cancelPreparedInputDispatch(
          claimed,
          'preparation_failed',
        )
        if (!this.core.disposed)
          this.core.publish(
            this.core.conversations.metadataPatch(claimed.sessionId, { draftsChanged }),
          )
      }
    }
  }

  releaseDecisionHandoff(owner: DecisionInvocationOwner | undefined): void {
    if (!owner || this.core.decisionRuntime !== owner) return
    owner.consulting = false
    if (!owner.runtime) this.core.decisionRuntime = undefined
  }

  decisionRuntimeAdmission(): RelayPolicyAdmission['runtimeAdmission'] {
    if (this.core.decisionRuntime || this.core.conversations.activeSchedulingRuntimeOwner())
      return 'busy'
    if (!this.core.conversations.schedulingSettings().credential.configured)
      return 'known_unavailable'
    return 'may_attempt'
  }

  /** Advisory-only initial-role consult: a choice is an ID only; the host metadata supplies roles. */
}
