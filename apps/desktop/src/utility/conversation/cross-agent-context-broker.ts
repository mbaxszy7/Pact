import type {
  AgentPromptEnvelope,
  AgentPromptPlanSummary,
  HandoffSpineEntry,
  PeerWorkspaceChangeFile,
  PeerWorkspaceChangeLedgerEntry,
} from '@pact/agent-runtime'
import type {
  AgentRun,
  AnchoredComment,
  ConversationSnapshot,
  RuntimeAgentId,
} from '@pact/contracts'
import type { ConversationImage } from '@pact/contracts/images'
import type { ConversationRepository, HandoffBundle, HandoffSourceRef } from '@pact/persistence'

import { agentPromptImageGroups, serializeAgentPromptEnvelope } from '@pact/agent-runtime'
import {
  CUTOFF_INLINE_TAIL_MAX_BYTES,
  FROZEN_EXECUTION_INPUT_ITEMS,
  isCollaborationOpenMode,
} from '@pact/contracts'
import {
  HANDOFF_READ_DEADLINE_MS,
  HANDOFF_SAFETY_BYTES,
  HandoffSourceUnavailableError,
  HandoffTooLargeError,
} from '@pact/persistence'

import type { WorkspaceChanges } from '../workspace-changes/workspace-changes'
import type { ConversationImages } from './conversation-images'

import {
  codexPromptInput,
  nativeImagePreparationBytes,
  setPromptCutoffSupplement,
} from './native-image-content'
import { freezeNativeJsonFrame } from './native-json-encoder'
import { NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'

export const CONTEXT_BROKER_L0_MAX_BYTES = 24 * 1024
export const CONTEXT_BROKER_L1_MAX_BYTES = 32 * 1024
export const CONTEXT_BROKER_RECENT_TURNS = 6
export const CONTEXT_BROKER_SPINE_PREVIEW_CHARS = 160
export const CONTEXT_BROKER_MAX_SPINE_ENTRIES = 128
export const CONTEXT_BROKER_MAX_LEDGER_RUNS = 8
export const CONTEXT_BROKER_MAX_LEDGER_BYTES = 8 * 1024
export const CONTEXT_BROKER_PLAN_EXCERPT_MAX_CHARS = 2000
export const CONTEXT_BROKER_PLAN_EXCERPT_MAX_BYTES = 4 * 1024
const MAX_CHANGE_SET_PAGES = 64

export interface CollectedHandoff {
  targetAgentId: RuntimeAgentId
  inlineBundles: HandoffBundle[]
  foldedImageGroups: Array<{
    messageId: string
    sequence: number
    images: ConversationImage[]
  }>
  spine: HandoffSpineEntry[]
  sourceRefs: HandoffSourceRef[]
  peerWorkspaceChanges: PeerWorkspaceChangeLedgerEntry[]
}

export interface CrossAgentContextBrokerDeps {
  conversations: ConversationRepository
  workspaceChanges?: WorkspaceChanges | undefined
  images?: ConversationImages | undefined
}

function toHandoffSourceRef(bundle: HandoffBundle): HandoffSourceRef {
  return Object.assign(
    {
      id: bundle.messageId,
      revision: bundle.contentRevision,
      digest: bundle.digest,
    },
    bundle.contextVersion ? { contextVersion: bundle.contextVersion } : {},
  )
}

function normalizePreview(text: string, maxChars: number): string {
  const collapsed = text.replaceAll(/\s+/gu, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  let slice = collapsed.slice(0, maxChars)
  if (slice.length > 0 && /[\uD800-\uDBFF]/u.test(slice.at(-1)!)) {
    slice = slice.slice(0, -1)
  }
  return `${slice.trimEnd()}...`
}

function toSpineEntry(bundle: HandoffBundle): HandoffSpineEntry {
  const previewSource =
    !bundle.inputBatchRef && bundle.comments.length > 0
      ? `[${bundle.comments.length} comment(s)] ${bundle.content}`
      : bundle.content
  return {
    messageId: bundle.messageId,
    sequence: bundle.sequence,
    speaker: bundle.speaker,
    chars: bundle.content.length,
    preview: normalizePreview(previewSource, CONTEXT_BROKER_SPINE_PREVIEW_CHARS),
  }
}

function encodedJsonBytes(items: readonly unknown[]): number {
  return items.length > 0 ? Buffer.byteLength(JSON.stringify(items), 'utf8') : 0
}

function boundUtf8Text(text: string, maxChars: number, maxBytes: number): string {
  if (maxChars <= 0 || maxBytes <= 0) return ''
  if (text.length <= maxChars && Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const ellipsis = '...'
  const contentByteLimit = Math.max(0, maxBytes - 3)
  const contentCharLimit = Math.max(0, maxChars - 3)
  let bounded = text.length > contentCharLimit ? text.slice(0, contentCharLimit) : text
  if (bounded.length > 0 && /[\uD800-\uDBFF]/u.test(bounded.at(-1)!)) {
    bounded = bounded.slice(0, -1)
  }
  while (bounded.length > 0 && Buffer.byteLength(bounded, 'utf8') > contentByteLimit) {
    bounded = bounded.slice(0, Math.floor(bounded.length * 0.85))
    if (bounded.length > 0 && /[\uD800-\uDBFF]/u.test(bounded.at(-1)!)) {
      bounded = bounded.slice(0, -1)
    }
  }
  const trimmed = bounded.trimEnd()
  return trimmed.length > 0 ? `${trimmed}${ellipsis}` : ''
}

/**
 * Single owner of L0/L1/L2 cross-agent prompt context compilation across Claude,
 * Codex, Antigravity, and Side Chat Cutoff sources.
 */
export class CrossAgentContextBroker {
  private readonly envelopeTargets = new WeakMap<AgentPromptEnvelope, RuntimeAgentId>()
  private readonly envelopeInlineSequences = new WeakMap<AgentPromptEnvelope, Map<string, number>>()

  constructor(private readonly deps: CrossAgentContextBrokerDeps) {}

  async collectHandoff(input: {
    sessionId: string
    targetAgentId: RuntimeAgentId
    signal: AbortSignal
    excludeMessageId?: string | undefined
    throughSequence?: number | undefined
    workflow?: boolean | undefined
  }): Promise<CollectedHandoff> {
    const {
      sessionId,
      targetAgentId,
      signal,
      excludeMessageId,
      throughSequence,
      workflow = false,
    } = input
    const range = this.deps.conversations.handoffRange(sessionId, targetAgentId)
    const effectiveThrough = Math.min(
      range.throughSequence,
      throughSequence ?? range.throughSequence,
    )
    const deadline = Date.now() + HANDOFF_READ_DEADLINE_MS
    const checkDeadline = (): void => {
      if (signal.aborted || Date.now() >= deadline) {
        throw new HandoffSourceUnavailableError('Reading the Agent handoff timed out.')
      }
    }
    const inlineBundles: HandoffBundle[] = []
    const foldedImageGroups: CollectedHandoff['foldedImageGroups'] = []
    const spine: HandoffSpineEntry[] = []
    const sourceRefs: HandoffSourceRef[] = []
    const peerTurnCandidates: Array<{ messageId: string; sequence: number; speaker: string }> = []
    const seenMessageIds = new Set<string>()
    let spineBytes = 0

    const pushSpine = (bundle: HandoffBundle, maxSpineBytes: number): void => {
      // Managed images from folded messages are preserved independently of text folding/caps.
      if (bundle.images?.length) {
        foldedImageGroups.push({
          messageId: bundle.messageId,
          sequence: bundle.sequence,
          images: bundle.images,
        })
      }
      const entry = toSpineEntry(bundle)
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
      const baseOverhead = spine.length === 0 ? 2 : 1
      if (entryBytes + 2 > maxSpineBytes) return
      while (
        spine.length > 0 &&
        (spine.length >= CONTEXT_BROKER_MAX_SPINE_ENTRIES ||
          spineBytes + baseOverhead + entryBytes > maxSpineBytes)
      ) {
        spine.shift()
        spineBytes = encodedJsonBytes(spine)
      }
      const nextOverhead = spine.length === 0 ? 2 : 1
      if (
        spine.length < CONTEXT_BROKER_MAX_SPINE_ENTRIES &&
        spineBytes + nextOverhead + entryBytes <= maxSpineBytes
      ) {
        spine.push(entry)
        spineBytes += nextOverhead + entryBytes
      }
    }

    const ingestBundle = (bundle: HandoffBundle): void => {
      if (excludeMessageId && bundle.messageId === excludeMessageId) return
      if (seenMessageIds.has(bundle.messageId)) return
      seenMessageIds.add(bundle.messageId)
      sourceRefs.push(toHandoffSourceRef(bundle))
      if (bundle.speaker !== 'user') {
        peerTurnCandidates.push({
          messageId: bundle.messageId,
          sequence: bundle.sequence,
          speaker: bundle.speaker,
        })
      }
      inlineBundles.push(bundle)
      while (inlineBundles.length > CONTEXT_BROKER_RECENT_TURNS) {
        const folded = inlineBundles.shift()
        if (folded) pushSpine(folded, CONTEXT_BROKER_L1_MAX_BYTES)
      }
    }

    // Complete handoff guarantee: never catch HandoffTooLargeError or return a truncated prefix.
    for await (const message of this.deps.conversations.readHandoffSources(
      sessionId,
      targetAgentId,
      range.afterSequence,
      effectiveThrough,
      signal,
      excludeMessageId,
      workflow,
    )) {
      checkDeadline()
      ingestBundle(message)
    }

    const peerWorkspaceChanges = this.collectPeerWorkspaceChanges(
      sessionId,
      peerTurnCandidates,
      signal,
      deadline,
    )
    const ledgerBytes = encodedJsonBytes(peerWorkspaceChanges)
    const sharedHistoryBudget = Math.max(0, CONTEXT_BROKER_L1_MAX_BYTES - ledgerBytes)

    // Trim oldest spine text entries if ledger + spine exceeds the shared L1 32 KiB budget.
    while (spine.length > 0 && spineBytes > sharedHistoryBudget) {
      spine.shift()
      spineBytes = encodedJsonBytes(spine)
    }

    // Enforce the shared L1 32 KiB budget across peer ledger, spine, and inline unseen turns.
    let inlineBytes = encodedJsonBytes(inlineBundles)
    while (
      inlineBundles.length > 0 &&
      (ledgerBytes + spineBytes + inlineBytes > CONTEXT_BROKER_L1_MAX_BYTES ||
        inlineBytes > HANDOFF_SAFETY_BYTES)
    ) {
      const folded = inlineBundles.shift()
      if (!folded) break
      pushSpine(folded, sharedHistoryBudget)
      inlineBytes = encodedJsonBytes(inlineBundles)
    }

    return {
      targetAgentId,
      inlineBundles,
      foldedImageGroups,
      spine,
      sourceRefs,
      peerWorkspaceChanges,
    }
  }

  private collectPeerWorkspaceChanges(
    sessionId: string,
    peerTurns: ReadonlyArray<{ messageId: string; sequence: number; speaker: string }>,
    signal: AbortSignal,
    deadline: number,
  ): PeerWorkspaceChangeLedgerEntry[] {
    if (!this.deps.workspaceChanges || !peerTurns.length) return []
    const checkDeadline = (): void => {
      if (signal.aborted || Date.now() >= deadline) {
        throw new HandoffSourceUnavailableError('Reading the Agent handoff timed out.')
      }
    }
    const isCancellation = (error: unknown): boolean =>
      signal.aborted || Date.now() >= deadline || error instanceof HandoffSourceUnavailableError
    checkDeadline()
    let candidates: ReturnType<ConversationRepository['recentPeerWorkspaceChangeCandidates']>
    try {
      candidates = this.deps.conversations.recentPeerWorkspaceChangeCandidates({
        sessionId,
        messageIds: peerTurns.map((turn) => turn.messageId),
        limit: CONTEXT_BROKER_MAX_LEDGER_RUNS,
        check: checkDeadline,
      })
    } catch (error) {
      if (isCancellation(error)) throw error
      return []
    }
    if (!candidates.length) return []

    const entries: PeerWorkspaceChangeLedgerEntry[] = []
    let totalLedgerBytes = 2

    for (const candidate of candidates) {
      if (entries.length >= CONTEXT_BROKER_MAX_LEDGER_RUNS) break
      checkDeadline()

      let summary: ReturnType<WorkspaceChanges['summary']>
      try {
        summary = this.deps.workspaceChanges.summary(candidate.runId)
      } catch (error) {
        if (isCancellation(error)) throw error
        continue
      }
      if (!summary || summary.fileCount <= 0 || summary.state === 'undone') continue

      const buildEntry = (
        entryFiles: PeerWorkspaceChangeFile[],
        clippedCount: number,
      ): PeerWorkspaceChangeLedgerEntry => ({
        runId: summary.runId,
        agentId: summary.agentId,
        sequence: candidate.sequence,
        ...(clippedCount > 0 ? { truncatedFileCount: clippedCount } : {}),
        files: entryFiles,
      })

      const separatorBytes = entries.length > 0 ? 1 : 0
      const files: PeerWorkspaceChangeFile[] = []
      let truncatedFileCount = 0
      let budgetExhausted = false
      let afterPath: string | undefined
      let hitPageCapWithMore = false

      for (let pageIndex = 0; pageIndex < MAX_CHANGE_SET_PAGES; pageIndex += 1) {
        checkDeadline()
        let page: ReturnType<WorkspaceChanges['readPage']>
        try {
          page = this.deps.workspaceChanges.readPage(
            afterPath === undefined
              ? { changeSetId: candidate.changeSetId }
              : { changeSetId: candidate.changeSetId, afterPath },
          )
        } catch (error) {
          if (isCancellation(error)) throw error
          break
        }
        for (const file of page.files) {
          if (file.hidden || Reflect.get(file, 'undone') === true) continue
          if (budgetExhausted) {
            truncatedFileCount += 1
            continue
          }
          const projected: PeerWorkspaceChangeFile = {
            path: file.path,
            kind: file.kind,
            additions: file.additions,
            deletions: file.deletions,
          }
          // Enforce actual encoded JSON byte limit starting from the very first entry/file,
          // reserving room for a truncatedFileCount marker in case later files are clipped.
          const probeEntry = buildEntry([...files, projected], 9999)
          const probeBytes = Buffer.byteLength(JSON.stringify(probeEntry), 'utf8')
          if (totalLedgerBytes + separatorBytes + probeBytes > CONTEXT_BROKER_MAX_LEDGER_BYTES) {
            budgetExhausted = true
            truncatedFileCount += 1
            continue
          }
          files.push(projected)
        }
        if (!page.nextPath || page.nextPath === afterPath) break
        if (pageIndex === MAX_CHANGE_SET_PAGES - 1) {
          hitPageCapWithMore = true
          break
        }
        afterPath = page.nextPath
      }

      if (hitPageCapWithMore && truncatedFileCount === 0) {
        truncatedFileCount = 1
      }
      if (!files.length && truncatedFileCount === 0) continue

      const entry = buildEntry(files, truncatedFileCount)
      const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8')
      if (totalLedgerBytes + separatorBytes + entryBytes > CONTEXT_BROKER_MAX_LEDGER_BYTES) {
        break
      }
      entries.push(entry)
      totalLedgerBytes += separatorBytes + entryBytes
      if (budgetExhausted) break
    }

    return entries.toReversed()
  }

  buildPromptEnvelope(input: {
    sessionId: string
    message: Pick<ConversationSnapshot['messages'][number], 'id' | 'content'>
    comments: AnchoredComment[]
    handoff?: CollectedHandoff | undefined
    pendingImages?: ConversationImage[] | undefined
    imageOwner?: string | undefined
  }): AgentPromptEnvelope {
    const { sessionId, message, comments, handoff, pendingImages, imageOwner } = input
    const imageMetadata =
      pendingImages ?? this.deps.conversations.imagesForMessage(message.id, sessionId)
    const currentImages = imageMetadata.map((image) => {
      if (!this.deps.images) throw new Error('Image input is unavailable.')
      return this.deps.images.resolve(sessionId, image, imageOwner)
    })
    const skillInvocation = this.deps.conversations.skillInvocation(message.id)
    const inlineBundles = handoff?.inlineBundles ?? []
    const foldedImageGroups = handoff?.foldedImageGroups ?? []
    const spine = handoff?.spine ?? []
    const peerWorkspaceChanges = handoff?.peerWorkspaceChanges ?? []
    const handoffImages = foldedImageGroups.map(({ messageId, images }) => ({
      messageId,
      images: images.map((image) => {
        if (!this.deps.images) throw new Error('Saved image input is unavailable.')
        return this.deps.images.resolve(sessionId, image)
      }),
    }))

    const envelope: AgentPromptEnvelope = {
      version: 'pact-agent-prompt-v1',
      sessionId,
      ...(skillInvocation ? { skillInvocation } : {}),
      message: { ...message, ...(currentImages.length ? { images: currentImages } : {}) },
      inputBatchRef:
        this.deps.conversations.inputBatchForMessage(sessionId, message.id) ?? undefined,
      comments: comments.map(({ id, body, anchor }) => ({ id, body, anchor })),
      ...(handoffImages.length > 0 ? { handoffImages } : {}),
      ...(inlineBundles.length > 0
        ? {
            handoffContext: inlineBundles.map(
              ({ messageId, speaker, content, comments: sent, images }) => {
                const entry: NonNullable<AgentPromptEnvelope['handoffContext']>[number] = {
                  messageId,
                  inputBatchRef:
                    this.deps.conversations.inputBatchForMessage(sessionId, messageId) ?? undefined,
                  speaker,
                  content,
                  comments: sent,
                }
                if (images?.length) {
                  entry.images = images.map((image) => {
                    if (!this.deps.images) throw new Error('Saved image input is unavailable.')
                    return this.deps.images.resolve(sessionId, image)
                  })
                }
                return entry
              },
            ),
          }
        : {}),
      ...(spine.length > 0 ? { handoffSpine: spine } : {}),
      // Preserve explicit [] on handoff envelopes so confirmed-unsent re-execution distinguishes
      // newly captured empty ledgers from legacy pre-upgrade snapshots (undefined).
      ...(handoff ? { peerWorkspaceChanges } : {}),
    }
    if (handoff?.targetAgentId) {
      this.envelopeTargets.set(envelope, handoff.targetAgentId)
    }
    if (inlineBundles.length > 0) {
      this.envelopeInlineSequences.set(
        envelope,
        new Map(inlineBundles.map((bundle) => [bundle.messageId, bundle.sequence])),
      )
    }
    return envelope
  }

  /** Reject oversized serialized prompts or target-aware native image working budgets before acceptance. */
  assertPromptFitsBudget(prompt: AgentPromptEnvelope, targetAgentId?: RuntimeAgentId): void {
    const serializedBytes = Buffer.byteLength(serializeAgentPromptEnvelope(prompt), 'utf8')
    if (serializedBytes > HANDOFF_SAFETY_BYTES) {
      throw new HandoffTooLargeError('The Agent context is too large to send safely.')
    }
    const imageGroups = agentPromptImageGroups(prompt)
    if (imageGroups.length > FROZEN_EXECUTION_INPUT_ITEMS) {
      throw new HandoffTooLargeError('The required Agent images exceed the safe item budget.')
    }
    const allImages = imageGroups.flatMap((group) => group.images)
    if (allImages.length > 0) {
      const effectiveTarget =
        targetAgentId ?? prompt.targetAgentId ?? this.envelopeTargets.get(prompt)
      const estimatedWorkingBytes =
        effectiveTarget === 'codex'
          ? freezeNativeJsonFrame(codexPromptInput(prompt)) + 256 * 1024
          : serializedBytes * 2 + nativeImagePreparationBytes(allImages) + 256 * 1024
      if (estimatedWorkingBytes > NATIVE_OWNER_WORKING_BYTES) {
        throw new HandoffTooLargeError(
          'The required Agent images exceed the safe native working budget.',
        )
      }
    }
  }

  /**
   * L0 (<= 24 KiB): Check remaining inline budget BEFORE querying SQLite, then read bounded,
   * verified frozen Batch members by ordinal while preserving the full Batch ref for pagination.
   */
  inlineCurrentComments(
    envelope: AgentPromptEnvelope,
    target: { sessionId: string; runId: string; batchId?: string | undefined },
  ): void {
    if (envelope.comments.length > 0) return
    const batchId = target.batchId ?? envelope.inputBatchRef?.id
    if (!batchId || envelope.inputBatchRef?.memberCount === 0) return
    const baseBytes =
      Buffer.byteLength(envelope.message.content, 'utf8') +
      (envelope.userClarification
        ? Buffer.byteLength(
            JSON.stringify({
              question: envelope.userClarification.question,
              answer: envelope.userClarification.answer,
            }),
            'utf8',
          )
        : 0)
    const remainingBytes = CONTEXT_BROKER_L0_MAX_BYTES - baseBytes
    if (remainingBytes <= 0) return
    const inlined = this.deps.conversations.readFrozenBatchInlineComments({
      sessionId: target.sessionId,
      runId: target.runId,
      batchId,
      maxBytes: remainingBytes,
      maxItems: FROZEN_EXECUTION_INPUT_ITEMS,
    })
    if (inlined.length > 0) {
      envelope.comments = inlined
    }
  }

  /**
   * L1 (<= 32 KiB): Attach bounded Plan/Review status and, in open collaboration mode,
   * a bounded reference excerpt of the latest plan within the shared 32 KiB L1 budget.
   */
  attachPlanSummary(envelope: AgentPromptEnvelope, sessionId: string, runId: string): void {
    const task = envelope.collaboration
    if (!task) {
      envelope.planSummary = undefined
      return
    }
    const stage = envelope.collaborationAuthorization?.stage ?? task.stage
    const reviewVerdict = task.review?.verdict
    if (task.planVersion <= 0 && !reviewVerdict) {
      envelope.planSummary = undefined
      return
    }
    const summary: AgentPromptPlanSummary = {
      version: task.planVersion,
      stage,
      ...(reviewVerdict ? { reviewVerdict } : {}),
    }
    const l1HistoryBytes = (): number =>
      encodedJsonBytes(envelope.peerWorkspaceChanges ?? []) +
      encodedJsonBytes(envelope.handoffSpine ?? []) +
      encodedJsonBytes(envelope.handoffContext ?? [])
    const baseSummaryBytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
    const inlineSequences = this.envelopeInlineSequences.get(envelope)

    // Ensure the shared 32 KiB L1 budget accommodates the base planSummary metadata alongside
    // peer workspace ledger, spine, and inline unseen history.
    while (
      envelope.handoffSpine &&
      envelope.handoffSpine.length > 1 &&
      l1HistoryBytes() + baseSummaryBytes > CONTEXT_BROKER_L1_MAX_BYTES
    ) {
      envelope.handoffSpine.shift()
    }
    while (
      envelope.handoffContext &&
      envelope.handoffContext.length > 0 &&
      l1HistoryBytes() + baseSummaryBytes > CONTEXT_BROKER_L1_MAX_BYTES
    ) {
      const folded = envelope.handoffContext.shift()
      if (!folded) break
      if (folded.images?.length) {
        envelope.handoffImages = [
          ...(envelope.handoffImages ?? []),
          { messageId: folded.messageId, images: folded.images },
        ]
      }
      const previewSource =
        !folded.inputBatchRef && folded.comments.length > 0
          ? `[${folded.comments.length} comment(s)] ${folded.content}`
          : folded.content
      const spineEntry: HandoffSpineEntry = {
        messageId: folded.messageId,
        sequence: inlineSequences?.get(folded.messageId) ?? 0,
        speaker: folded.speaker,
        chars: folded.content.length,
        preview: normalizePreview(previewSource, CONTEXT_BROKER_SPINE_PREVIEW_CHARS),
      }
      const nextSpine = [...(envelope.handoffSpine ?? []), spineEntry]
      while (nextSpine.length > CONTEXT_BROKER_MAX_SPINE_ENTRIES) {
        nextSpine.shift()
      }
      while (
        nextSpine.length > 1 &&
        encodedJsonBytes(envelope.peerWorkspaceChanges ?? []) +
          encodedJsonBytes(nextSpine) +
          encodedJsonBytes(envelope.handoffContext) +
          baseSummaryBytes >
          CONTEXT_BROKER_L1_MAX_BYTES
      ) {
        nextSpine.shift()
      }
      if (
        encodedJsonBytes(envelope.peerWorkspaceChanges ?? []) +
          encodedJsonBytes(nextSpine) +
          encodedJsonBytes(envelope.handoffContext) +
          baseSummaryBytes <=
        CONTEXT_BROKER_L1_MAX_BYTES
      ) {
        envelope.handoffSpine = nextSpine
      }
    }
    if (envelope.handoffContext && envelope.handoffContext.length === 0) {
      delete envelope.handoffContext
    }

    const usedBeforePlan = l1HistoryBytes()
    const remainingForPlan = CONTEXT_BROKER_L1_MAX_BYTES - usedBeforePlan
    const planDoc = task.planReference?.document
    if (isCollaborationOpenMode(task) && planDoc && remainingForPlan > baseSummaryBytes + 20) {
      try {
        const row = this.deps.conversations.collaborationDocumentRow(sessionId, planDoc)
        const page = this.deps.conversations.readPage({
          scope: 'collaboration-text',
          sessionId,
          runId: row.sourceRunId ?? runId,
          document: planDoc,
          offset: 0,
        })
        if (page.scope === 'collaboration-text' && page.text.trim()) {
          const rawText = page.text.trim()
          const maxExcerptBytes = Math.min(
            CONTEXT_BROKER_PLAN_EXCERPT_MAX_BYTES,
            remainingForPlan - baseSummaryBytes - 16,
          )
          if (maxExcerptBytes > 4) {
            let charLimit = Math.min(rawText.length, CONTEXT_BROKER_PLAN_EXCERPT_MAX_CHARS)
            let byteLimit = maxExcerptBytes
            while (charLimit > 0 && byteLimit > 4) {
              const candidate = boundUtf8Text(rawText, charLimit, byteLimit)
              if (!candidate) break
              const totalL1Bytes =
                usedBeforePlan +
                Buffer.byteLength(JSON.stringify({ ...summary, excerpt: candidate }), 'utf8')
              if (totalL1Bytes <= CONTEXT_BROKER_L1_MAX_BYTES) {
                summary.excerpt = candidate
                break
              }
              charLimit = Math.floor(charLimit * 0.8)
              byteLimit = Math.floor(byteLimit * 0.8)
            }
          }
        }
      } catch {
        // Plan excerpt is a read-only convenience projection; full plan remains readable via L2.
      }
    }
    envelope.planSummary = summary
  }

  authorizedCutoffsForEnvelope(
    run: Pick<AgentRun, 'sessionId' | 'userMessageId'> & { id?: string | undefined },
    envelope: AgentPromptEnvelope,
    isSideChat: boolean,
  ): string[] {
    if (isSideChat) {
      const anchor = this.deps.conversations.sideChatAnchorCutoff(run.sessionId)
      return anchor && anchor.maxMessageSequence >= 0 ? [anchor.cutoffId] : []
    }
    const frozenHandoffIds = run.id
      ? this.deps.conversations.frozenRunHandoffMessageIdsWithOriginCutoffs(run.id, run.sessionId)
      : []
    const candidateMessageIds = [
      ...new Set(
        [
          run.userMessageId,
          envelope.message.id,
          ...frozenHandoffIds,
          ...(envelope.handoffSpine ?? []).map((entry) => entry.messageId),
          ...(envelope.handoffContext ?? []).map((entry) => entry.messageId),
          ...(envelope.rebuiltContext ?? []).map((entry) => entry.message.id),
          envelope.collaborationBasis?.original?.id,
          envelope.collaborationBasis?.latest?.id,
        ].filter((id): id is string => Boolean(id)),
      ),
    ]
    if (!candidateMessageIds.length) return []
    const origins = this.deps.conversations.messageOriginCutoffs(run.sessionId, candidateMessageIds)
    const unique = new Set<string>()
    for (const entry of origins) {
      if (entry.maxMessageSequence >= 0) unique.add(entry.originSideChat.cutoffId)
    }
    return [...unique]
  }

  attachCutoffSupplement(
    sessionId: string,
    agentId: RuntimeAgentId,
    bindingGeneration: number,
    envelope: AgentPromptEnvelope,
    authorizedCutoffIds: readonly string[],
  ): string[] {
    if (!authorizedCutoffIds.length) {
      setPromptCutoffSupplement(envelope, undefined)
      return []
    }
    const delivered = new Set(
      this.deps.conversations.deliveredCutoffIds(sessionId, agentId, bindingGeneration),
    )
    let remainingBytes = CUTOFF_INLINE_TAIL_MAX_BYTES
    const inlineTails: Array<{ cutoffId: string; text: string }> = []
    const newlyInjected: string[] = []
    for (const cutoffId of authorizedCutoffIds) {
      if (delivered.has(cutoffId)) continue
      if (remainingBytes < 256) break
      const tail = this.deps.conversations.buildCutoffInlineTail(cutoffId, remainingBytes)
      const tailBytes = tail.text ? Buffer.byteLength(tail.text, 'utf8') : 0
      if (tail.text && tailBytes <= remainingBytes) {
        inlineTails.push({ cutoffId, text: tail.text })
        remainingBytes -= tailBytes
        newlyInjected.push(cutoffId)
      }
    }
    setPromptCutoffSupplement(envelope, {
      cutoffIds: [...authorizedCutoffIds],
      inlineTails,
    })
    return newlyInjected
  }
}
