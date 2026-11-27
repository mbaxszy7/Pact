import type {
  AgentRun,
  CollaborationReviewObservation,
  ConversationPatch,
  NativeProbeResult,
  NormalizedAgentEvent,
} from '@pact/contracts'

import { CONVERSATION_MARKDOWN_BYTES, normalizedAgentEventSchema } from '@pact/contracts'
import { diagnosticEventSchema } from '@pact/contracts/diagnostics'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import { AgentExecutionError, classifyAgentError } from './agent-execution-error'
import { AgentStreamBuffer } from './agent-stream-buffer'
import { NativeWorkingMemory, type NativeMemoryReservation } from './native-working-memory'

const MAX_PENDING_ARCHIVE_ITEMS = 8

export interface CompletedNativeReceipt {
  readonly nativeTurnId: string
  readonly source: 'live_terminal' | 'stored_terminal'
  readonly executorId?: string | undefined
}

export interface RunOutputArchiverHost {
  readonly run: Pick<AgentRun, 'id' | 'sessionId' | 'agentId' | 'bindingGeneration'>
  readonly peerAssistanceAllowed: boolean
  isOwned(): boolean
  isDisposed(): boolean
  ownsCurrentControl(): boolean
  isRunEnded(): boolean
  applyStreamBatch(
    events: readonly Extract<
      NormalizedAgentEvent,
      { type: 'text.delta' | 'reasoning.summary.delta' }
    >[],
    archive: boolean,
  ): ConversationPatch
  applyEvent(event: NormalizedAgentEvent, archive: boolean): ConversationPatch
  completeAnswer(
    metadata: Omit<Extract<NormalizedAgentEvent, { type: 'text.completed' }>, 'text'>,
    parts: (signal: AbortSignal) => AsyncIterable<string>,
    signal: AbortSignal,
    archive: boolean,
  ): Promise<ConversationPatch>
  recordNativeEvidence(evidence: NativeProbeResult): ConversationPatch
  recordOutputFailure(failure: AgentExecutionError): ConversationPatch
  settleKnownNativeEnding(failure?: AgentExecutionError): ConversationPatch
  recordWorkflowPlan(plan: Extract<NormalizedAgentEvent, { type: 'collaboration.plan' }>): void
  recordWorkflowReview(review: CollaborationReviewObservation): void
  publish(patch: ConversationPatch, progress?: boolean): void
  observeNormalizedDelta(event: NormalizedAgentEvent, archived: boolean): void
  markInjectedCutoffs(): void
  reconcileCompletedCollaboration(receipt: CompletedNativeReceipt): void
  observeUncertainEffects(): void
  onCodexTitleUpdated?(): void
  onSessionStartedOrTitleUpdated?(): void
}

/**
 * Single-writer output pipeline for one active/background Run.
 *
 * Eliminates the 4-channel concurrency race (`applyEvent`, `recordNativeEvidence`,
 * `recordArchivedEvent`, `handoffFrozenPrefix`) by unifying:
 * - Foreground & Archive `AgentStreamBuffer` ownership (strict foreground-before-archive flush)
 * - Bounded `NativeWorkingMemory` (128 MiB cap, max 8 queued archive jobs)
 * - Terminal-first receipt commit & idempotent post-terminal deduplication
 * - Body-lane quarantine on output failure (preserving live native control callbacks)
 * - Ordered `PublishLane` so SQLite commit order matches `ConversationPatch` emission order.
 */
export class RunOutputArchiver {
  readonly archiveController = new AbortController()
  readonly archiveMemory = new NativeWorkingMemory()
  readonly foregroundBuffer: AgentStreamBuffer

  private archiveBufferValue: AgentStreamBuffer | undefined
  private archiveTailValue: Promise<void> | undefined
  private archivePendingValue = 0
  private outputFailureValue: AgentExecutionError | undefined
  private completedReceiptValue: CompletedNativeReceipt | undefined
  private reportedTitleValue = false
  private terminalSettledWithFailure = false

  constructor(private readonly host: RunOutputArchiverHost) {
    this.foregroundBuffer = new AgentStreamBuffer(
      (events) => this.host.applyStreamBatch(events, !this.host.ownsCurrentControl()),
      (patch) => this.emitPublished(patch, true),
      (error) => {
        this.markAborted(error)
      },
    )
  }

  get outputFailure(): AgentExecutionError | undefined {
    return this.outputFailureValue
  }

  get archiveBuffer(): AgentStreamBuffer | undefined {
    return this.archiveBufferValue
  }

  get archiveTail(): Promise<void> | undefined {
    return this.archiveTailValue
  }

  get archivePending(): number {
    return this.archivePendingValue
  }

  get completedNativeReceipt(): CompletedNativeReceipt | undefined {
    return this.completedReceiptValue
  }

  get reportedTitle(): boolean {
    return this.reportedTitleValue
  }

  static async *answerParts(text: string, signal: AbortSignal): AsyncIterable<string> {
    for (let offset = 0; offset < text.length;) {
      signal.throwIfAborted()
      let end = Math.min(text.length, offset + 8192)
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1
      }
      yield text.slice(offset, end)
      offset = end
    }
  }

  /**
   * 1) Admit an event from either the foreground stream or the background archive lane.
   * For small synchronous archive facts when no large archive tail is pending, commits
   * synchronously in exact call order.
   */
  admitEvent(
    event: NormalizedAgentEvent,
    channel: 'foreground' | 'archive',
    foregroundSignal?: AbortSignal,
  ): Promise<void> {
    if (channel === 'archive') {
      this.admitArchiveEventSync(event)
      return Promise.resolve()
    }
    return this.admitForegroundEvent(event, foregroundSignal)
  }

  /**
   * Synchronous archive entry point matching `AgentRunInput['recordArchivedEvent']`.
   */
  admitArchiveEventSync(event: NormalizedAgentEvent): void {
    if (!this.host.isOwned()) return
    if (this.outputFailureValue) {
      if (event.type === 'turn.completed' && this.host.isRunEnded()) {
        this.emitFailureEndingOnce()
      }
      return
    }
    let fact: NormalizedAgentEvent
    try {
      fact = normalizedAgentEventSchema.parse(event)
    } catch (error: unknown) {
      this.markAborted(error)
      return
    }
    this.host.observeNormalizedDelta(fact, true)
    const large =
      fact.type === 'text.completed' &&
      Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES

    const apply = async (): Promise<void> => {
      if (
        !this.host.isOwned() ||
        this.archiveController.signal.aborted ||
        this.outputFailureValue
      ) {
        return
      }
      // Late facts preserve their answer, but never establish workflow acceptance.
      if (fact.type === 'collaboration.plan') {
        this.host.recordWorkflowPlan(fact)
        return
      }
      if (fact.type === 'collaboration.review') {
        this.host.recordWorkflowReview({
          verdict: fact.verdict,
          ...(fact.questions ? { questions: fact.questions } : {}),
        })
        return
      }
      if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') {
        this.archiveBufferValue ??= new AgentStreamBuffer(
          (events) => this.host.applyStreamBatch(events, true),
          (patch) => this.emitPublished(patch, true),
          (error) => {
            this.markAborted(error)
          },
        )
        this.archiveBufferValue.push(fact)
        return
      }
      this.flush()
      if (this.outputFailureValue) {
        if (fact.type === 'turn.completed' && this.host.isRunEnded()) {
          this.emitFailureEndingOnce()
        }
        return
      }
      if (large && fact.type === 'text.completed') {
        const { text, ...metadata } = fact
        const patch = await this.host.completeAnswer(
          metadata,
          (bodySignal) => RunOutputArchiver.answerParts(text, bodySignal),
          this.archiveController.signal,
          true,
        )
        this.emitPublished(patch, false)
      } else {
        const patch = this.host.applyEvent(fact, true)
        this.emitPublished(patch, false)
      }
      if (fact.type === 'turn.started' || fact.type === 'turn.completed') {
        this.host.markInjectedCutoffs()
      }
      if (
        fact.type === 'turn.completed' &&
        fact.outcome === 'completed' &&
        this.completedReceiptValue?.nativeTurnId === fact.turnId
      ) {
        this.host.reconcileCompletedCollaboration(this.completedReceiptValue)
      }
    }

    if (!large && !this.archiveTailValue) {
      // Small facts preserve synchronous durable commit order.
      void apply().catch((error: unknown) => {
        this.handleArchiveError(error)
      })
      return
    }
    if (this.archivePendingValue >= MAX_PENDING_ARCHIVE_ITEMS) {
      this.markAborted(
        new AgentExecutionError('protocol_error', 'Archived answer work is full.', false),
      )
      return
    }
    const text = 'text' in fact ? fact.text : ''
    let reservation: NativeMemoryReservation
    try {
      reservation = this.archiveMemory.reserve(
        4096 + text.length * 10 + Buffer.byteLength(text, 'utf8') * 2,
      )
    } catch (error: unknown) {
      this.markAborted(error)
      return
    }
    this.archivePendingValue += 1
    const task = (this.archiveTailValue ?? Promise.resolve())
      .then(apply)
      .catch((error: unknown) => {
        this.handleArchiveError(error)
      })
      .finally(() => {
        reservation.release()
        this.archivePendingValue -= 1
        if (this.archiveTailValue === task) this.archiveTailValue = undefined
      })
    this.archiveTailValue = task
  }

  /**
   * 2) Terminal-first receipt admission: persists compact terminal metadata BEFORE flushing
   * buffered bodies or committing optional workflow metadata, and latches the completed
   * live receipt idempotently once.
   */
  admitTerminalReceipt(evidence: NativeProbeResult): void {
    const metadata: NativeProbeResult =
      evidence.kind === 'ended'
        ? {
            kind: evidence.kind,
            identity: evidence.identity,
            source: evidence.source,
            outcome: evidence.outcome,
            ...(evidence.planUnavailable || evidence.output?.planUnavailable
              ? { planUnavailable: true as const }
              : {}),
          }
        : evidence

    this.emitPublished(this.host.recordNativeEvidence(metadata), false)

    if (evidence.kind !== 'ended') return

    this.flush()
    if (this.outputFailureValue) {
      if (!this.host.ownsCurrentControl()) {
        this.emitFailureEndingOnce()
      }
      return
    }

    if (
      evidence.output?.plan ||
      evidence.output?.retainedPlan ||
      evidence.output?.reviewResult ||
      evidence.output?.reviewVerdict
    ) {
      this.emitPublished(this.host.recordNativeEvidence(evidence), false)
    }

    if (
      !this.completedReceiptValue &&
      evidence.source === 'live_terminal' &&
      evidence.outcome === 'completed' &&
      evidence.output?.completeness === 'complete' &&
      evidence.identity.nativeTurnId &&
      evidence.identity.executorId
    ) {
      this.completedReceiptValue = {
        nativeTurnId: evidence.identity.nativeTurnId,
        source: evidence.source,
        executorId: evidence.identity.executorId,
      }
    }
  }

  /**
   * 3) Quarantines ONLY the body lane (keeping exact native control callbacks live),
   * discards buffered deltas, aborts pending archive streaming, and publishes output failure.
   */
  markAborted(error: unknown): AgentExecutionError {
    if (this.outputFailureValue) return this.outputFailureValue
    const failure = classifyAgentError(error)
    this.outputFailureValue = failure
    this.archiveController.abort()
    this.foregroundBuffer.discard()
    this.archiveBufferValue?.discard()
    this.emitPublished(this.host.recordOutputFailure(failure), false)
    if (this.host.isRunEnded()) {
      this.emitPublished(this.host.settleKnownNativeEnding(), false)
    }
    return failure
  }

  /**
   * Flushes buffered foreground deltas strictly before archive deltas at Steer, non-delta,
   * and terminal boundaries.
   */
  flush(): boolean {
    if (this.outputFailureValue) return false
    const fgOk = this.foregroundBuffer.flush()
    const archOk = this.archiveBufferValue ? this.archiveBufferValue.flush() : true
    if (!fgOk || !archOk) {
      this.markAborted(
        new AgentExecutionError(
          'protocol_error',
          'The current output could not be committed before its input boundary.',
          false,
        ),
      )
      return false
    }
    return true
  }

  /**
   * 4) Awaits any queued archive work until the archive tail empties.
   */
  async drain(): Promise<void> {
    while (this.archiveTailValue) {
      const current = this.archiveTailValue
      // oxlint-disable-next-line no-await-in-loop -- Archive tasks may chain onto archiveTail during drain.
      await current
    }
  }

  /**
   * 5) Finalizes both stream buffers in strict foreground-before-archive order.
   */
  dispose(): boolean {
    let ok = true
    if (!this.foregroundBuffer.dispose()) ok = false
    if (this.archiveBufferValue && !this.archiveBufferValue.dispose()) ok = false
    return ok && !this.outputFailureValue
  }

  private async admitForegroundEvent(
    event: NormalizedAgentEvent,
    foregroundSignal?: AbortSignal,
  ): Promise<void> {
    if (this.host.isDisposed()) return
    let fact: NormalizedAgentEvent
    try {
      fact = normalizedAgentEventSchema.parse(event)
    } catch (error: unknown) {
      if (
        event.type === 'text.delta' ||
        event.type === 'text.completed' ||
        event.type === 'reasoning.summary.delta' ||
        event.type === 'reasoning.summary.completed'
      ) {
        throw this.markAborted(error)
      }
      throw error
    }
    if (!this.host.ownsCurrentControl()) {
      this.admitArchiveEventSync(fact)
      return
    }
    this.host.observeNormalizedDelta(fact, false)
    if (this.outputFailureValue) throw this.outputFailureValue
    if (fact.type === 'session.title.updated' && this.reportedTitleValue) return

    if (fact.type === 'collaboration.plan') {
      this.foregroundBuffer.flush()
      this.host.recordWorkflowPlan(fact)
      return
    }
    if (fact.type === 'collaboration.review') {
      this.foregroundBuffer.flush()
      this.host.recordWorkflowReview({
        verdict: fact.verdict,
        ...(fact.questions ? { questions: fact.questions } : {}),
      })
      return
    }
    if (fact.type === 'peer.assistance.requested' && !this.host.peerAssistanceAllowed) {
      return
    }
    if (fact.type === 'text.delta' || fact.type === 'reasoning.summary.delta') {
      this.foregroundBuffer.push(fact)
      return
    }

    this.flush()
    if (this.outputFailureValue) throw this.outputFailureValue

    if (
      fact.type === 'text.completed' &&
      Buffer.byteLength(fact.text, 'utf8') > CONVERSATION_MARKDOWN_BYTES
    ) {
      const { text, ...metadata } = fact
      const combinedSignal = foregroundSignal
        ? AbortSignal.any([foregroundSignal, this.archiveController.signal])
        : this.archiveController.signal
      try {
        const patch = await this.host.completeAnswer(
          metadata,
          (bodySignal) => RunOutputArchiver.answerParts(text, bodySignal),
          combinedSignal,
          false,
        )
        this.emitPublished(patch, false)
      } catch (error: unknown) {
        throw this.markAborted(error)
      }
    } else {
      const appliedFact =
        fact.type === 'session.title.updated' && this.host.run.agentId === 'agy' && !fact.origin
          ? { ...fact, origin: 'turn_result' as const }
          : fact
      try {
        const patch = this.host.applyEvent(appliedFact, false)
        this.emitPublished(patch, false)
        if (appliedFact.type === 'turn.started' || appliedFact.type === 'turn.completed') {
          this.host.markInjectedCutoffs()
        }
        if (appliedFact.type === 'session.title.updated' && appliedFact.origin === 'turn_result') {
          this.reportedTitleValue =
            patch.session.titleSource === 'agent' && patch.session.title === appliedFact.title
        }
      } catch (error: unknown) {
        // Failed optional metadata keeps the local title; the substantive Turn continues.
        if (appliedFact.type === 'session.title.updated' && appliedFact.origin === 'turn_result') {
          return
        }
        if (fact.type === 'text.completed' || fact.type === 'reasoning.summary.completed') {
          throw this.markAborted(error)
        }
        throw error
      }
    }

    if (fact.type === 'session.title.updated' && this.host.run.agentId === 'codex') {
      this.host.onCodexTitleUpdated?.()
    }
    if (fact.type === 'session.started' || fact.type === 'session.title.updated') {
      this.host.onSessionStartedOrTitleUpdated?.()
    }
  }

  private emitFailureEndingOnce(): void {
    if (this.terminalSettledWithFailure || !this.outputFailureValue) return
    this.terminalSettledWithFailure = true
    this.emitPublished(this.host.settleKnownNativeEnding(this.outputFailureValue), false)
  }

  /**
   * Serialized PublishLane: guarantees any already-committed foreground progress patches
   * are published strictly before a non-progress commit patch.
   */
  private emitPublished(patch: ConversationPatch, progress: boolean): void {
    if (!progress) {
      this.foregroundBuffer.publishPending()
    }
    this.host.publish(patch, progress)
  }

  private handleArchiveError(error: unknown): void {
    this.markAborted(error)
    recordDiagnostic({
      operation: 'native_check',
      phase: 'failed',
      level: 'warn',
      scope: 'run',
      sessionId: this.host.run.sessionId,
      runId: this.host.run.id,
      agentId: this.host.run.agentId,
      runtimeBoundary: 'archive',
      code: classifyAgentError(error).kind,
      runtimeErrorType:
        diagnosticEventSchema.shape.runtimeErrorType.safeParse(
          error instanceof Error ? error.name : 'other',
        ).data ?? 'other',
    })
    this.host.observeUncertainEffects()
  }
}
