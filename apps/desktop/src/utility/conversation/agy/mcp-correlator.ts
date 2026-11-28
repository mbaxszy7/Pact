import { COLLABORATION_PUBLISHED_PLAN_MAX_BYTES } from '@pact/contracts'

import { isValidAgyTrajectoryId } from '../agy-native-storage'
import {
  buildCompactArgsFingerprint,
  canonicalizeProgressToken,
  compareArgsFingerprints,
  computePlanConversionWorkspaceBytes,
  computeRetainedPlanTextBytes,
  estimateStagedOutcomePayloadBytes,
  hashCallIdDigest,
  mergeArgsFingerprints,
  type AcpMcpCallLifecycle,
  type AcpToolCallAdmissionResult,
  type ActiveAcpMcpCall,
  type HttpClaimAttempt,
  type PendingPlanChunk,
  type PromotedMcpOutcome,
  type ProvisionalTokenOwner,
  type RootProofCheckResult,
  type StagedMcpOutcomeKind,
  type StagedMcpOutcomeRecord,
  type TokenLedgerEntry,
} from './frame-validator'
import {
  AGY_MCP_CORRELATION_WAIT_MS,
  AGY_MCP_MAX_ACTIVE_ACP_CALLS,
  AGY_MCP_MAX_CONSUMED_TOKENS,
  AGY_MCP_MAX_CORRELATION_BYTES,
  AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES,
  AGY_MCP_MAX_TOOL_CALL_ID_BYTES,
  AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES,
  AGY_MCP_TERMINAL_STUB_BYTES,
  normalizeAcpToolStatus,
  type CanonicalProgressToken,
  type CompactArgsFingerprint,
} from './types'

/**
 * Cohesive per-Run MCP call correlation state machine.
 * Owns canonical `tokenLedger`, irreversible `ActiveAcpMcpCall` lifecycles with bounded retired
 * call tombstones, provisional `token:<pt>` -> `call:<id>` atomic migration, staged outcomes,
 * plan chunk reassembly, and strict admit-before-insert correlation/plan byte reservation accounting.
 */
export class McpCallCorrelator {
  private closed = false
  private revoked = false
  private tokenCapacityExhausted = false
  private correlatorCapacityExhausted = false
  private tokenlessCorrelationCompromised = false
  private pinnedTrajectoryId: string | undefined
  private trajectoryIdSource: 'acp' | 'storage_db' | undefined
  private hostMinStepIdx: number | undefined
  private allowLazyStorageDbPin = true

  private readonly activeAcpToolCalls = new Map<string, ActiveAcpMcpCall>()
  private readonly retiredCallIdDigests = new Set<string>()
  private readonly tokenLedger = new Map<string, TokenLedgerEntry>()
  private readonly inFlightHttpFingerprints = new Map<string, number>()
  private readonly provisionalTokenOwners = new Map<string, ProvisionalTokenOwner>()
  private readonly stagedOutcomes = new Map<string, StagedMcpOutcomeRecord>()
  private readonly activeCallWaiters = new Set<() => void>()
  private wakeBatchDepth = 0
  private wakePending = false
  private recomputingProvisionalDepth = 0

  private titleConfirmed = false
  private pendingTitleOwner: string | undefined
  private peerConfirmed = false
  private pendingPeerOwner: string | undefined
  private openPlanFinalized = false
  private acknowledgedFinalOpenPlan = false
  private readonly confirmedPlanChunks: Buffer[] = []
  private confirmedPlanBytes = 0
  private confirmedPlanHasNonWhitespace = false
  private planConversionWorkspaceBytes = 0
  private pendingTransferredPlanBytes = 0
  private readonly pendingPlanChunks: PendingPlanChunk[] = []

  constructor(
    private readonly reserveCorrelationBytes?: (nextBytes: number) => boolean,
    private readonly getMinRootStepIdx?: () => number | undefined,
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  get isRevoked(): boolean {
    return this.revoked
  }

  get isTokenCapacityExhausted(): boolean {
    return this.tokenCapacityExhausted
  }

  get pinnedTrajectory(): string | undefined {
    return this.pinnedTrajectoryId
  }

  get pinnedTrajectorySource(): 'acp' | 'storage_db' | undefined {
    return this.trajectoryIdSource
  }

  get minHostStepIdx(): number | undefined {
    return this.hostMinStepIdx
  }

  get canLazyPinStorageDb(): boolean {
    return this.allowLazyStorageDbPin
  }

  get isTitleSlotTaken(): boolean {
    return this.titleConfirmed || this.pendingTitleOwner !== undefined
  }

  get isPeerSlotTaken(): boolean {
    return this.peerConfirmed || this.pendingPeerOwner !== undefined
  }

  get isOpenPlanFinalizedOrPendingFinal(): boolean {
    return (
      this.openPlanFinalized ||
      this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.complete)
    )
  }

  get hasAcknowledgedFinalOpenPlan(): boolean {
    return this.acknowledgedFinalOpenPlan
  }

  private effectiveMinStepIdx(): number | undefined {
    return this.getMinRootStepIdx?.() ?? this.hostMinStepIdx
  }

  private validatesAgainstRootEvidence(
    trajectoryId: string | undefined,
    stepIdx: number | undefined,
    parsedPt: CanonicalProgressToken | undefined,
  ): boolean {
    const minStepIdx = this.effectiveMinStepIdx()
    if (trajectoryId !== undefined) {
      if (!isValidAgyTrajectoryId(trajectoryId)) return false
      if (this.pinnedTrajectoryId !== undefined && trajectoryId !== this.pinnedTrajectoryId) {
        return false
      }
    }
    if (stepIdx !== undefined) {
      if (!Number.isSafeInteger(stepIdx) || stepIdx < 0) return false
      if (minStepIdx !== undefined && stepIdx < minStepIdx) {
        return false
      }
    }
    if (parsedPt?.structured) {
      if (parsedPt.structured.hasLeadingZeros) return false
      if (
        this.pinnedTrajectoryId !== undefined &&
        parsedPt.structured.trajectoryId !== this.pinnedTrajectoryId
      ) {
        return false
      }
      if (trajectoryId !== undefined && parsedPt.structured.trajectoryId !== trajectoryId) {
        return false
      }
      if (minStepIdx !== undefined && parsedPt.structured.stepIdx < minStepIdx) {
        return false
      }
      if (stepIdx !== undefined && parsedPt.structured.stepIdx !== stepIdx) {
        return false
      }
    }
    return true
  }

  get pendingPlanChunkCount(): number {
    return this.pendingPlanChunks.length
  }

  get confirmedPlanByteCount(): number {
    return this.confirmedPlanBytes
  }

  disallowLazyStorageDbPin(): void {
    this.allowLazyStorageDbPin = false
  }

  notifyRootProofUpdated(): void {
    this.wakeAllWaiters()
  }

  clearPendingTransferredPlanBytes(): void {
    if (this.pendingTransferredPlanBytes === 0) return
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
  }

  pinHostTrajectoryId(trajectoryId: string, stepCount?: number): void {
    if (!isValidAgyTrajectoryId(trajectoryId)) return
    let updated = false
    if (this.pinnedTrajectoryId === undefined) {
      this.pinnedTrajectoryId = trajectoryId
      this.trajectoryIdSource = 'storage_db'
      updated = true
    }
    if (stepCount !== undefined && this.hostMinStepIdx === undefined) {
      this.hostMinStepIdx = stepCount
      updated = true
    }
    if (updated) {
      this.wakeAllWaiters()
    }
  }

  pinRootTrajectoryId(trajectoryId: string): void {
    if (!isValidAgyTrajectoryId(trajectoryId)) return
    if (this.pinnedTrajectoryId === undefined) {
      this.pinnedTrajectoryId = trajectoryId
      this.trajectoryIdSource = 'acp'
      this.wakeAllWaiters()
    }
  }

  pendingPlanBufferBytes(): number {
    let total = 0
    for (const chunk of this.pendingPlanChunks) {
      if (!chunk.invalidated) total += chunk.bytes.byteLength
    }
    return total
  }

  hasNonWhitespacePlanContent(extraHasNonWhitespace: boolean): boolean {
    if (extraHasNonWhitespace || this.confirmedPlanHasNonWhitespace) {
      return true
    }
    return this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.hasNonWhitespace)
  }

  private matchesCallRootEvidence(entry: ActiveAcpMcpCall, canonicalPt: string): boolean {
    const parsed = canonicalizeProgressToken(canonicalPt)
    if (!parsed?.structured) return true
    if (entry.trajectoryId !== undefined && parsed.structured.trajectoryId !== entry.trajectoryId) {
      return false
    }
    if (entry.stepIdx !== undefined && parsed.structured.stepIdx !== entry.stepIdx) {
      return false
    }
    return true
  }

  lookupVerifiedCallToolName(toolCallId: string): string | undefined {
    return this.activeAcpToolCalls.get(toolCallId)?.toolName
  }

  private computeAcpCallBytes(entry: ActiveAcpMcpCall): number {
    let bytes =
      AGY_MCP_TERMINAL_STUB_BYTES +
      Buffer.byteLength(entry.toolCallId, 'utf8') +
      (entry.trajectoryId ? Buffer.byteLength(entry.trajectoryId, 'utf8') + 16 : 0) +
      (entry.stepIdx !== undefined ? 16 : 0) +
      (entry.explicitProgressToken
        ? Buffer.byteLength(entry.explicitProgressToken, 'utf8') + 16
        : 0) +
      (entry.correlatedProgressToken
        ? Buffer.byteLength(entry.correlatedProgressToken, 'utf8') + 16
        : 0)
    if (entry.lifecycle === 'open') {
      bytes +=
        (entry.argsFingerprint?.approxBytes ?? 0) +
        (entry.claimedHttpArgsFingerprint?.approxBytes ?? 0)
    }
    return bytes
  }

  computeCorrelationHeldBytes(): {
    metadataBytes: number
    planBufferBytes: number
    extraPlanBytes: number
    totalBytes: number
  } {
    let metadataBytes = this.retiredCallIdDigests.size * AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES
    for (const entry of this.activeAcpToolCalls.values()) {
      metadataBytes += this.computeAcpCallBytes(entry)
    }
    for (const [token, ledgerEntry] of this.tokenLedger) {
      metadataBytes += Buffer.byteLength(token, 'utf8') + 32
      if (ledgerEntry.kind === 'claimed') {
        metadataBytes += Buffer.byteLength(ledgerEntry.ownerKey, 'utf8') + 16
      }
    }
    for (const inFlightBytes of this.inFlightHttpFingerprints.values()) {
      metadataBytes += inFlightBytes
    }
    for (const [token, prov] of this.provisionalTokenOwners) {
      metadataBytes += Buffer.byteLength(token, 'utf8') + prov.httpFingerprint.approxBytes + 32
    }
    for (const [ownerKey, rec] of this.stagedOutcomes) {
      metadataBytes +=
        Buffer.byteLength(ownerKey, 'utf8') +
        Buffer.byteLength(rec.progressToken, 'utf8') +
        rec.httpFingerprint.approxBytes +
        rec.payloadBytes +
        32
    }
    let planBufferBytes = 0
    for (const chunk of this.pendingPlanChunks) {
      if (!chunk.invalidated) {
        metadataBytes +=
          Buffer.byteLength(chunk.ownerKey, 'utf8') +
          (chunk.confirmedToolCallId ? Buffer.byteLength(chunk.confirmedToolCallId, 'utf8') : 0) +
          48
        planBufferBytes += chunk.bytes.byteLength
      }
    }
    for (const buf of this.confirmedPlanChunks) {
      planBufferBytes += buf.byteLength
    }
    const extraPlanBytes = this.planConversionWorkspaceBytes + this.pendingTransferredPlanBytes
    return {
      metadataBytes,
      planBufferBytes,
      extraPlanBytes,
      totalBytes: metadataBytes + planBufferBytes + extraPlanBytes,
    }
  }

  private tryAdmitBytes(
    nextMetadataBytes: number,
    nextPlanBufferBytes: number,
    nextExtraPlanBytes = this.planConversionWorkspaceBytes + this.pendingTransferredPlanBytes,
  ): boolean {
    if (
      nextMetadataBytes > AGY_MCP_MAX_CORRELATION_BYTES ||
      nextPlanBufferBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
    ) {
      return false
    }
    const nextTotal = nextMetadataBytes + nextPlanBufferBytes + nextExtraPlanBytes
    if (this.reserveCorrelationBytes && !this.reserveCorrelationBytes(nextTotal)) {
      return false
    }
    return true
  }

  private syncReservationAfterShrink(): void {
    const { totalBytes } = this.computeCorrelationHeldBytes()
    this.reserveCorrelationBytes?.(totalBytes)
  }

  beginWakeBatch(): void {
    this.wakeBatchDepth += 1
  }

  endWakeBatch(): void {
    if (this.wakeBatchDepth > 0) {
      this.wakeBatchDepth -= 1
    }
    if (this.wakeBatchDepth === 0 && this.wakePending) {
      this.wakePending = false
      this.wakeAllWaiters()
    }
  }

  private wakeAllWaiters(): void {
    if (this.wakeBatchDepth > 0) {
      this.wakePending = true
      return
    }
    for (const wake of Array.from(this.activeCallWaiters)) {
      wake()
    }
  }

  private invalidateToken(canonicalToken: string): void {
    const prev = this.tokenLedger.get(canonicalToken)
    if (prev?.kind === 'claimed') {
      const prevOwner = prev.ownerKey
      this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      this.revokeOwner(prevOwner)
    } else if (prev?.kind === 'in_flight_http') {
      this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      this.provisionalTokenOwners.delete(canonicalToken)
      this.syncReservationAfterShrink()
    } else if (prev?.kind === 'non_mcp' || prev?.kind === 'consumed') {
      this.provisionalTokenOwners.delete(canonicalToken)
      this.syncReservationAfterShrink()
    } else {
      if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
        this.tokenCapacityExhausted = true
      } else {
        const current = this.computeCorrelationHeldBytes()
        const delta = Buffer.byteLength(canonicalToken, 'utf8') + 32
        if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
          this.tokenCapacityExhausted = true
        } else {
          this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
        }
      }
    }
    for (const entry of Array.from(this.activeAcpToolCalls.values())) {
      if (
        entry.explicitProgressToken === canonicalToken ||
        entry.correlatedProgressToken === canonicalToken
      ) {
        this.retireCallId(entry.toolCallId)
      }
    }
  }

  private markExplicitTokenConsumed(canonicalToken: string): void {
    const prev = this.tokenLedger.get(canonicalToken)
    if (prev !== undefined) {
      if (prev.kind === 'in_flight_http') {
        this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
      }
      return
    }
    if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
      this.tokenCapacityExhausted = true
      return
    }
    const current = this.computeCorrelationHeldBytes()
    const delta = Buffer.byteLength(canonicalToken, 'utf8') + 32
    if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
      this.tokenCapacityExhausted = true
      return
    }
    this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
  }

  private retireCallId(toolCallId: string): void {
    const digest = hashCallIdDigest(toolCallId)
    const existing = this.activeAcpToolCalls.get(toolCallId)
    if (existing) {
      const explicitPt = existing.explicitProgressToken
      const retiredToolName = existing.toolName
      this.cancelStagedOwner(`call:${toolCallId}`)
      this.activeAcpToolCalls.delete(toolCallId)
      if (!this.retiredCallIdDigests.has(digest)) {
        if (this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES) {
          this.correlatorCapacityExhausted = true
          this.tokenlessCorrelationCompromised = true
        } else {
          // Deleting `existing` freed >= AGY_MCP_TERMINAL_STUB_BYTES + 1 (> tombstone bytes).
          this.retiredCallIdDigests.add(digest)
        }
      }
      this.syncReservationAfterShrink()
      if (explicitPt !== undefined) {
        this.markExplicitTokenConsumed(explicitPt)
      }
      this.recomputeProvisionalMigrationsForTool(retiredToolName)
      return
    }
    if (this.retiredCallIdDigests.has(digest)) {
      return
    }
    if (this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES) {
      this.correlatorCapacityExhausted = true
      this.tokenlessCorrelationCompromised = true
      return
    }
    const current = this.computeCorrelationHeldBytes()
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + AGY_MCP_RETIRED_CALL_TOMBSTONE_BYTES,
        current.planBufferBytes,
      )
    ) {
      this.correlatorCapacityExhausted = true
      this.tokenlessCorrelationCompromised = true
      return
    }
    this.retiredCallIdDigests.add(digest)
  }

  private evictTerminalCallIfNeeded(): boolean {
    if (this.activeAcpToolCalls.size < AGY_MCP_MAX_ACTIVE_ACP_CALLS) return true
    for (const [key, candidate] of this.activeAcpToolCalls) {
      if (candidate.lifecycle === 'open') continue
      const ownerKey = `call:${candidate.toolCallId}`
      if (this.stagedOutcomes.has(ownerKey)) continue
      const digest = hashCallIdDigest(candidate.toolCallId)
      if (
        !this.retiredCallIdDigests.has(digest) &&
        this.retiredCallIdDigests.size >= AGY_MCP_MAX_RETIRED_CALL_TOMBSTONES
      ) {
        this.correlatorCapacityExhausted = true
        this.tokenlessCorrelationCompromised = true
        return false
      }
      if (candidate.correlatedProgressToken !== undefined) {
        const ledger = this.tokenLedger.get(candidate.correlatedProgressToken)
        if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
          this.tokenLedger.set(candidate.correlatedProgressToken, { kind: 'consumed' })
        }
      }
      const explicitPt = candidate.explicitProgressToken
      this.activeAcpToolCalls.delete(key)
      this.retiredCallIdDigests.add(digest)
      this.syncReservationAfterShrink()
      if (explicitPt !== undefined) {
        this.markExplicitTokenConsumed(explicitPt)
      }
      return true
    }
    return false
  }

  private markClaimedTokenConsumedForOwner(ownerKey: string, knownToken?: string): void {
    if (knownToken !== undefined) {
      const ledger = this.tokenLedger.get(knownToken)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
        this.tokenLedger.set(knownToken, { kind: 'consumed' })
      }
      this.provisionalTokenOwners.delete(knownToken)
      return
    }
    if (ownerKey.startsWith('token:')) {
      const pt = ownerKey.slice('token:'.length)
      const ledger = this.tokenLedger.get(pt)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
        this.tokenLedger.set(pt, { kind: 'consumed' })
      }
      this.provisionalTokenOwners.delete(pt)
      return
    }
    if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      const call = this.activeAcpToolCalls.get(tcId)
      if (call?.correlatedProgressToken !== undefined) {
        const ledger = this.tokenLedger.get(call.correlatedProgressToken)
        if (ledger?.kind === 'claimed' && ledger.ownerKey === ownerKey) {
          this.tokenLedger.set(call.correlatedProgressToken, { kind: 'consumed' })
        }
      }
    }
  }

  private cancelStagedOwner(ownerKey: string): void {
    const staged = this.stagedOutcomes.get(ownerKey)
    this.stagedOutcomes.delete(ownerKey)
    if (this.pendingTitleOwner === ownerKey) {
      this.pendingTitleOwner = undefined
    }
    if (this.pendingPeerOwner === ownerKey) {
      this.pendingPeerOwner = undefined
    }
    this.markClaimedTokenConsumedForOwner(ownerKey, staged?.progressToken)
    const failedChunkIdx = this.pendingPlanChunks.findIndex(
      (chunk) => chunk.ownerKey === ownerKey && !chunk.invalidated,
    )
    if (failedChunkIdx >= 0) {
      const failedOffset = this.pendingPlanChunks[failedChunkIdx]!.offset
      let cancelledFinalChunk = false
      for (let i = this.pendingPlanChunks.length - 1; i >= 0; i -= 1) {
        const candidate = this.pendingPlanChunks[i]!
        if (candidate.ownerKey === ownerKey || candidate.offset >= failedOffset) {
          if (candidate.complete) {
            cancelledFinalChunk = true
          }
          candidate.invalidated = true
          const depStaged = this.stagedOutcomes.get(candidate.ownerKey)
          this.stagedOutcomes.delete(candidate.ownerKey)
          this.markClaimedTokenConsumedForOwner(candidate.ownerKey, depStaged?.progressToken)
          this.pendingPlanChunks.splice(i, 1)
        }
      }
      if (cancelledFinalChunk) {
        this.planConversionWorkspaceBytes = 0
      }
    }
    this.syncReservationAfterShrink()
  }

  private revokeOwner(ownerKey: string): void {
    if (ownerKey.startsWith('call:')) {
      this.retireCallId(ownerKey.slice('call:'.length))
      return
    }
    if (ownerKey.startsWith('token:')) {
      this.provisionalTokenOwners.delete(ownerKey.slice('token:'.length))
    }
    this.cancelStagedOwner(ownerKey)
  }

  private migrateProvisionalTokenOwner(
    canonicalPt: string,
    targetCall: ActiveAcpMcpCall,
  ): 'migrated' | 'rejected_capacity' | 'invalid_ledger' {
    const provisional = this.provisionalTokenOwners.get(canonicalPt)
    if (!provisional) return 'invalid_ledger'
    const oldOwnerKey = `token:${canonicalPt}`
    const newOwnerKey = `call:${targetCall.toolCallId}`
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind !== 'claimed' || ledger.ownerKey !== oldOwnerKey) {
      this.provisionalTokenOwners.delete(canonicalPt)
      this.syncReservationAfterShrink()
      return 'invalid_ledger'
    }

    const tokenBytes = Buffer.byteLength(canonicalPt, 'utf8')
    const oldOwnerBytes = Buffer.byteLength(oldOwnerKey, 'utf8')
    const newOwnerBytes = Buffer.byteLength(newOwnerKey, 'utf8')
    const ownerDiff = newOwnerBytes - oldOwnerBytes
    const matchingChunks = this.pendingPlanChunks.filter(
      (chunk) => !chunk.invalidated && chunk.ownerKey === oldOwnerKey,
    ).length
    const hasStaged = this.stagedOutcomes.has(oldOwnerKey)
    const metadataDelta =
      -(tokenBytes + provisional.httpFingerprint.approxBytes + 32) +
      (tokenBytes + 16 + provisional.httpFingerprint.approxBytes) +
      ownerDiff +
      (hasStaged ? ownerDiff : 0) +
      matchingChunks * ownerDiff

    const current = this.computeCorrelationHeldBytes()
    if (!this.tryAdmitBytes(current.metadataBytes + metadataDelta, current.planBufferBytes)) {
      this.revokeOwner(oldOwnerKey)
      this.retireCallId(targetCall.toolCallId)
      return 'rejected_capacity'
    }

    this.provisionalTokenOwners.delete(canonicalPt)
    targetCall.correlatedProgressToken = canonicalPt
    targetCall.claimedViaTokenless = targetCall.explicitProgressToken !== canonicalPt
    targetCall.claimedHttpArgsFingerprint = provisional.httpFingerprint
    this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey: newOwnerKey })

    const staged = this.stagedOutcomes.get(oldOwnerKey)
    if (staged) {
      this.stagedOutcomes.delete(oldOwnerKey)
      staged.ownerKey = newOwnerKey
      this.stagedOutcomes.set(newOwnerKey, staged)
    }
    if (this.pendingTitleOwner === oldOwnerKey) {
      this.pendingTitleOwner = newOwnerKey
    }
    if (this.pendingPeerOwner === oldOwnerKey) {
      this.pendingPeerOwner = newOwnerKey
    }
    for (const chunk of this.pendingPlanChunks) {
      if (chunk.ownerKey === oldOwnerKey) {
        chunk.ownerKey = newOwnerKey
      }
    }
    return 'migrated'
  }

  private recomputeProvisionalMigrationsForTool(toolName: string): void {
    if (this.provisionalTokenOwners.size === 0 || this.recomputingProvisionalDepth > 0) return
    this.recomputingProvisionalDepth += 1
    try {
      let progressed = true
      let iterations = 0
      while (progressed && this.provisionalTokenOwners.size > 0 && iterations < 16) {
        progressed = false
        iterations += 1
        for (const candidate of Array.from(this.activeAcpToolCalls.values())) {
          if (
            candidate.toolName !== toolName ||
            candidate.lifecycle !== 'open' ||
            candidate.correlatedProgressToken !== undefined
          ) {
            continue
          }
          const beforeToken = candidate.correlatedProgressToken
          this.tryMigrateProvisionalToOpenCall(candidate)
          if (candidate.correlatedProgressToken !== beforeToken) {
            progressed = true
          }
        }
      }
    } finally {
      this.recomputingProvisionalDepth -= 1
    }
  }

  private tryMigrateProvisionalToOpenCall(
    entry: ActiveAcpMcpCall,
  ): 'ok' | 'already_retired' | 'rejected_capacity' {
    if (
      entry.lifecycle !== 'open' ||
      entry.correlatedProgressToken !== undefined ||
      this.provisionalTokenOwners.size === 0
    ) {
      return 'ok'
    }
    if (entry.explicitProgressToken !== undefined) {
      const prov = this.provisionalTokenOwners.get(entry.explicitProgressToken)
      if (!prov) return 'ok'
      const conflict =
        prov.toolName !== entry.toolName ||
        !this.matchesCallRootEvidence(entry, entry.explicitProgressToken) ||
        (entry.argsFingerprint !== undefined &&
          compareArgsFingerprints(entry.argsFingerprint, prov.httpFingerprint) === 'mismatch')
      if (conflict) {
        this.revokeOwner(`token:${entry.explicitProgressToken}`)
        this.retireCallId(entry.toolCallId)
        return 'already_retired'
      }
      const migrated = this.migrateProvisionalTokenOwner(entry.explicitProgressToken, entry)
      return migrated === 'rejected_capacity' ? 'rejected_capacity' : 'ok'
    }
    if (
      this.tokenlessCorrelationCompromised ||
      this.correlatorCapacityExhausted ||
      this.tokenCapacityExhausted ||
      entry.argsFingerprint === undefined
    ) {
      return 'ok'
    }
    const compatibleProvisionals: string[] = []
    for (const [pt, prov] of this.provisionalTokenOwners) {
      if (prov.toolName !== entry.toolName) continue
      const ledger = this.tokenLedger.get(pt)
      if (ledger?.kind !== 'claimed' || ledger.ownerKey !== `token:${pt}`) continue
      if (!this.matchesCallRootEvidence(entry, pt)) continue
      const verdict = compareArgsFingerprints(entry.argsFingerprint, prov.httpFingerprint)
      if (verdict === 'exact' || verdict === 'subset') {
        compatibleProvisionals.push(pt)
      }
    }
    if (compatibleProvisionals.length === 1) {
      const pt = compatibleProvisionals[0]!
      const prov = this.provisionalTokenOwners.get(pt)
      if (!prov) return 'ok'
      let compatibleCalls = 0
      let missingArgsCount = 0
      for (const other of this.activeAcpToolCalls.values()) {
        if (
          other.toolName !== prov.toolName ||
          other.lifecycle !== 'open' ||
          other.correlatedProgressToken !== undefined
        ) {
          continue
        }
        if (!this.matchesCallRootEvidence(other, pt)) {
          continue
        }
        if (other.explicitProgressToken !== undefined) {
          if (other.explicitProgressToken === pt && other.toolCallId !== entry.toolCallId) {
            return 'ok'
          }
          if (other.explicitProgressToken !== pt) {
            continue
          }
        }
        const verdict = compareArgsFingerprints(other.argsFingerprint, prov.httpFingerprint)
        if (verdict === 'exact' || verdict === 'subset') {
          compatibleCalls += 1
        } else if (verdict === 'missing_acp_args') {
          missingArgsCount += 1
        }
      }
      if (compatibleCalls === 1 && missingArgsCount === 0) {
        const migrated = this.migrateProvisionalTokenOwner(pt, entry)
        return migrated === 'rejected_capacity' ? 'rejected_capacity' : 'ok'
      }
    }
    return 'ok'
  }

  observeNonMcpProgressToken(rawToken: unknown): void {
    if (this.closed) return
    const parsed = canonicalizeProgressToken(rawToken)
    if (!parsed) return
    const canonical = parsed.canonical
    const prev = this.tokenLedger.get(canonical)
    if (prev?.kind === 'claimed') {
      const prevOwner = prev.ownerKey
      this.tokenLedger.set(canonical, { kind: 'non_mcp' })
      this.revokeOwner(prevOwner)
    } else if (prev === undefined) {
      if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
        this.tokenCapacityExhausted = true
      } else {
        const current = this.computeCorrelationHeldBytes()
        const delta = Buffer.byteLength(canonical, 'utf8') + 32
        if (!this.tryAdmitBytes(current.metadataBytes + delta, current.planBufferBytes)) {
          this.tokenCapacityExhausted = true
        } else {
          this.tokenLedger.set(canonical, { kind: 'non_mcp' })
        }
      }
    } else {
      this.tokenLedger.set(canonical, { kind: 'non_mcp' })
      this.syncReservationAfterShrink()
    }
    this.wakeAllWaiters()
  }

  observeNonPactCall(toolCallId: string | undefined, allCanonicalTokens: readonly string[]): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      for (const token of allCanonicalTokens) {
        this.observeNonMcpProgressToken(token)
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeDisputedTokens(
    toolCallId: string | undefined,
    allCanonicalTokens: readonly string[],
  ): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      for (const token of allCanonicalTokens) {
        const parsedPt = canonicalizeProgressToken(token)
        if (parsedPt) {
          this.invalidateToken(parsedPt.canonical)
        }
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeAcpToolCall(toolCallId?: string, rawProgressToken?: unknown): void {
    if (this.closed) return
    this.beginWakeBatch()
    try {
      if (
        toolCallId !== undefined &&
        toolCallId.length > 0 &&
        Buffer.byteLength(toolCallId, 'utf8') <= AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        this.retireCallId(toolCallId)
      }
      if (rawProgressToken !== undefined) {
        const parsedPt = canonicalizeProgressToken(rawProgressToken)
        if (parsedPt) {
          this.invalidateToken(parsedPt.canonical)
        }
      }
      this.wakeAllWaiters()
    } finally {
      this.endWakeBatch()
    }
  }

  revokeIfKnownMcpCall(toolCallId: string, rawProgressToken?: unknown): void {
    if (this.closed) return
    if (
      toolCallId.length === 0 ||
      Buffer.byteLength(toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      return
    }
    if (!this.activeAcpToolCalls.has(toolCallId)) {
      return
    }
    this.revokeAcpToolCall(toolCallId, rawProgressToken)
  }

  observeAcpToolCall(entry: {
    toolCallId: string
    toolName: string
    status: string
    invalidStatus?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    invalidArgs?: boolean | undefined
    progressToken?: unknown
    disputedTokens?: readonly string[] | undefined
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
  }): AcpToolCallAdmissionResult {
    if (this.closed) return 'rejected_capacity'
    if (
      entry.toolCallId.length === 0 ||
      Buffer.byteLength(entry.toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      if (entry.disputedTokens && entry.disputedTokens.length > 0) {
        this.revokeDisputedTokens(undefined, entry.disputedTokens)
      }
      return 'already_retired'
    }

    const invalidateAllDisputed = (extraToken?: string): void => {
      if (extraToken !== undefined) {
        this.invalidateToken(extraToken)
      }
      if (entry.disputedTokens) {
        for (const disputed of entry.disputedTokens) {
          if (disputed !== extraToken) {
            this.invalidateToken(disputed)
          }
        }
      }
    }

    this.beginWakeBatch()
    try {
      const digest = hashCallIdDigest(entry.toolCallId)
      if (this.retiredCallIdDigests.has(digest)) {
        if (
          entry.rootEvidenceContradicted ||
          entry.invalidProgressToken ||
          entry.invalidArgs ||
          entry.invalidStatus
        ) {
          invalidateAllDisputed()
        }
        return 'already_retired'
      }

      const existing = this.activeAcpToolCalls.get(entry.toolCallId)
      // Terminal states (`completed | failed | revoked`) are strictly irreversible!
      if (existing && existing.lifecycle !== 'open') {
        return 'already_retired'
      }

      // S1-#4: Conflicting tool identity on an established MCP call immediately revokes it!
      if (existing && existing.toolName !== entry.toolName) {
        this.retireCallId(entry.toolCallId)
        const parsedPt =
          entry.progressToken !== undefined
            ? canonicalizeProgressToken(entry.progressToken)
            : undefined
        invalidateAllDisputed(parsedPt?.canonical)
        this.wakeAllWaiters()
        return 'already_retired'
      }

      let incomingCanonicalPt: string | undefined
      let parsedPt: CanonicalProgressToken | undefined
      let shouldRevoke =
        entry.invalidProgressToken === true ||
        entry.invalidStatus === true ||
        entry.invalidArgs === true ||
        entry.rootEvidenceContradicted === true
      let invalidateContestedToken = shouldRevoke
      if (entry.progressToken !== undefined) {
        parsedPt = canonicalizeProgressToken(entry.progressToken)
        if (!parsedPt) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else {
          incomingCanonicalPt = parsedPt.canonical
          if (parsedPt.structured?.hasLeadingZeros) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
        }
      }

      const normalizedStatus = normalizeAcpToolStatus(entry.status)
      if (!normalizedStatus) {
        shouldRevoke = true
        invalidateContestedToken = true
      }

      if (!this.validatesAgainstRootEvidence(entry.trajectoryId, entry.stepIdx, parsedPt)) {
        shouldRevoke = true
        invalidateContestedToken = true
      }

      // Monotonic trajectoryId and stepIdx retention & cross-frame consistency (even when tokenless!).
      const resolvedTrajectoryId =
        entry.trajectoryId ??
        (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros
          ? parsedPt.structured.trajectoryId
          : undefined)
      const resolvedStepIdx =
        entry.stepIdx ??
        (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros
          ? parsedPt.structured.stepIdx
          : undefined)
      if (
        existing?.trajectoryId !== undefined &&
        resolvedTrajectoryId !== undefined &&
        existing.trajectoryId !== resolvedTrajectoryId
      ) {
        shouldRevoke = true
        invalidateContestedToken = true
      }
      if (
        existing?.stepIdx !== undefined &&
        resolvedStepIdx !== undefined &&
        existing.stepIdx !== resolvedStepIdx
      ) {
        shouldRevoke = true
        invalidateContestedToken = true
      }
      const nextTrajectoryId = existing?.trajectoryId ?? resolvedTrajectoryId
      const nextStepIdx = existing?.stepIdx ?? resolvedStepIdx
      if (existing?.correlatedProgressToken !== undefined) {
        const claimedPt = canonicalizeProgressToken(existing.correlatedProgressToken)
        if (claimedPt?.structured) {
          if (
            nextTrajectoryId !== undefined &&
            claimedPt.structured.trajectoryId !== nextTrajectoryId
          ) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
          if (nextStepIdx !== undefined && claimedPt.structured.stepIdx !== nextStepIdx) {
            shouldRevoke = true
            invalidateContestedToken = true
          }
        }
      }

      if (!existing && this.correlatorCapacityExhausted) {
        this.tokenlessCorrelationCompromised = true
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      const nextLifecycle: AcpMcpCallLifecycle =
        normalizedStatus === 'completed'
          ? 'completed'
          : normalizedStatus === 'failed' || normalizedStatus === 'cancelled'
            ? 'failed'
            : 'open'

      // Monotonic per-key argsFingerprint merge (summary-only updates keep existing semantic keys!).
      let mergedFp: CompactArgsFingerprint | undefined = existing?.argsFingerprint
      if (entry.argsFingerprint !== undefined || entry.args !== undefined) {
        const incomingFp =
          entry.argsFingerprint ??
          (entry.args !== undefined ? buildCompactArgsFingerprint(entry.args, true) : undefined)
        if (!incomingFp) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else {
          const merged = mergeArgsFingerprints(existing?.argsFingerprint, incomingFp)
          if (merged.kind === 'conflict') {
            shouldRevoke = true
            invalidateContestedToken = true
          } else {
            mergedFp = merged.fingerprint
            if (
              existing?.claimedHttpArgsFingerprint !== undefined &&
              mergedFp !== undefined &&
              compareArgsFingerprints(mergedFp, existing.claimedHttpArgsFingerprint) === 'mismatch'
            ) {
              shouldRevoke = true
              invalidateContestedToken = true
            }
          }
        }
      }

      let explicitToken = existing?.explicitProgressToken
      const conflictingCallsToRetire: string[] = []
      if (incomingCanonicalPt !== undefined) {
        const conflictingCalls = [...this.activeAcpToolCalls.values()].filter(
          (other) =>
            other.toolCallId !== entry.toolCallId &&
            (other.explicitProgressToken === incomingCanonicalPt ||
              other.correlatedProgressToken === incomingCanonicalPt),
        )
        if (conflictingCalls.length > 0) {
          shouldRevoke = true
          invalidateContestedToken = true
          for (const other of conflictingCalls) {
            conflictingCallsToRetire.push(other.toolCallId)
          }
        }
        if (this.tokenLedger.get(incomingCanonicalPt)?.kind === 'non_mcp') {
          shouldRevoke = true
        } else if (
          existing?.correlatedProgressToken !== undefined &&
          existing.correlatedProgressToken !== incomingCanonicalPt
        ) {
          shouldRevoke = true
          invalidateContestedToken = true
        } else if (explicitToken === undefined) {
          if (conflictingCalls.length === 0 && !shouldRevoke) {
            explicitToken = incomingCanonicalPt
          }
        } else if (explicitToken !== incomingCanonicalPt) {
          shouldRevoke = true
          invalidateContestedToken = true
        }
      }

      if (shouldRevoke) {
        for (const otherId of conflictingCallsToRetire) {
          this.retireCallId(otherId)
        }
        this.retireCallId(entry.toolCallId)
        if (invalidateContestedToken) {
          invalidateAllDisputed(incomingCanonicalPt)
        }
        this.wakeAllWaiters()
        return 'already_retired'
      }

      if (parsedPt?.structured && !parsedPt.structured.hasLeadingZeros) {
        this.pinRootTrajectoryId(parsedPt.structured.trajectoryId)
      }

      if (!existing && !this.evictTerminalCallIfNeeded()) {
        this.tokenlessCorrelationCompromised = true
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      const isTerminal = nextLifecycle !== 'open'
      // Before committing a `completed` terminal on an unclaimed open call, discharge any unique
      // surviving provisional match onto this call using its monotonically merged evidence!
      if (
        nextLifecycle === 'completed' &&
        existing !== undefined &&
        existing.lifecycle === 'open' &&
        existing.correlatedProgressToken === undefined &&
        this.provisionalTokenOwners.size > 0
      ) {
        existing.trajectoryId = nextTrajectoryId
        existing.stepIdx = nextStepIdx
        existing.explicitProgressToken = explicitToken
        existing.argsFingerprint = mergedFp
        const preTermMigration = this.tryMigrateProvisionalToOpenCall(existing)
        if (preTermMigration !== 'ok') {
          this.wakeAllWaiters()
          return preTermMigration
        }
      }

      const candidate: ActiveAcpMcpCall = {
        toolCallId: entry.toolCallId,
        toolName: existing?.toolName ?? entry.toolName,
        lifecycle: nextLifecycle,
        sawPreTerminal: (existing?.sawPreTerminal ?? false) || !isTerminal,
        ...(nextTrajectoryId !== undefined ? { trajectoryId: nextTrajectoryId } : {}),
        ...(nextStepIdx !== undefined ? { stepIdx: nextStepIdx } : {}),
        argsFingerprint: !isTerminal ? mergedFp : undefined,
        explicitProgressToken: explicitToken,
        correlatedProgressToken: existing?.correlatedProgressToken,
        ...(existing?.claimedViaTokenless !== undefined
          ? { claimedViaTokenless: existing.claimedViaTokenless }
          : {}),
        claimedHttpArgsFingerprint: !isTerminal ? existing?.claimedHttpArgsFingerprint : undefined,
      }

      const current = this.computeCorrelationHeldBytes()
      const oldEntryBytes = existing ? this.computeAcpCallBytes(existing) : 0
      const newEntryBytes = this.computeAcpCallBytes(candidate)
      const nextMetadataBytes = current.metadataBytes - oldEntryBytes + newEntryBytes
      if (!this.tryAdmitBytes(nextMetadataBytes, current.planBufferBytes)) {
        this.tokenlessCorrelationCompromised = true
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        this.wakeAllWaiters()
        return 'rejected_capacity'
      }

      this.activeAcpToolCalls.set(entry.toolCallId, candidate)
      let admissionResult: AcpToolCallAdmissionResult = 'admitted'
      if (nextLifecycle === 'failed') {
        this.retireCallId(entry.toolCallId)
        invalidateAllDisputed(incomingCanonicalPt)
        admissionResult = 'already_retired'
      } else if (nextLifecycle === 'open') {
        const migration = this.tryMigrateProvisionalToOpenCall(candidate)
        if (migration !== 'ok') {
          admissionResult = migration
        }
        this.recomputeProvisionalMigrationsForTool(candidate.toolName)
      }

      this.wakeAllWaiters()
      return admissionResult
    } finally {
      this.endWakeBatch()
    }
  }

  beginInFlightToken(
    canonicalPt: string,
    httpFingerprint: CompactArgsFingerprint,
  ): { ok: true } | { ok: false; error: string } {
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const existing = this.tokenLedger.get(canonicalPt)
    if (existing?.kind === 'non_mcp') {
      return {
        ok: false,
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (existing !== undefined) {
      return {
        ok: false,
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }
    if (this.tokenLedger.size >= AGY_MCP_MAX_CONSUMED_TOKENS) {
      this.tokenCapacityExhausted = true
      this.wakeAllWaiters()
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const inFlightBytes = httpFingerprint.approxBytes + 64
    const ledgerBytes = Buffer.byteLength(canonicalPt, 'utf8') + 32
    const current = this.computeCorrelationHeldBytes()
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + ledgerBytes + inFlightBytes,
        current.planBufferBytes,
      )
    ) {
      return {
        ok: false,
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }
    this.tokenLedger.set(canonicalPt, { kind: 'in_flight_http' })
    this.inFlightHttpFingerprints.set(canonicalPt, inFlightBytes)
    return { ok: true }
  }

  releaseInFlightToken(canonicalPt: string): void {
    let changed = this.inFlightHttpFingerprints.delete(canonicalPt)
    const existing = this.tokenLedger.get(canonicalPt)
    if (existing?.kind === 'in_flight_http') {
      this.tokenLedger.delete(canonicalPt)
      changed = true
    }
    if (changed) {
      this.syncReservationAfterShrink()
    }
  }

  private findExplicitEntryForToken(canonicalPt: string): ActiveAcpMcpCall | undefined {
    for (const entry of this.activeAcpToolCalls.values()) {
      if (entry.explicitProgressToken === canonicalPt) return entry
    }
    return undefined
  }

  private tryClaimForHttp(
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    canonicalPt: string,
    allowExplicitMissingArgs: boolean,
    checkRootProof: () => RootProofCheckResult,
  ): HttpClaimAttempt {
    if (this.closed || this.revoked) {
      return { kind: 'reject', error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind === 'non_mcp') {
      return {
        kind: 'reject',
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (ledger?.kind !== 'in_flight_http') {
      return {
        kind: 'reject',
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }
    const rootProof = checkRootProof()
    if (rootProof !== 'ok') {
      return rootProof === 'wait' ? { kind: 'wait' } : rootProof
    }

    const explicitEntry = this.findExplicitEntryForToken(canonicalPt)
    if (explicitEntry !== undefined) {
      if (
        explicitEntry.lifecycle !== 'open' ||
        explicitEntry.toolName !== toolName ||
        explicitEntry.correlatedProgressToken !== undefined ||
        !this.matchesCallRootEvidence(explicitEntry, canonicalPt)
      ) {
        return {
          kind: 'reject',
          error: 'Antigravity MCP explicit progressToken does not match an active call.',
        }
      }
      const verdict = compareArgsFingerprints(explicitEntry.argsFingerprint, httpFingerprint)
      if (verdict === 'mismatch') {
        return {
          kind: 'reject',
          error: 'Antigravity MCP arguments conflict with the ACP-authorized tool call.',
        }
      }
      if (verdict === 'missing_acp_args') {
        if (!allowExplicitMissingArgs || toolName === 'read_collaboration_source') {
          return { kind: 'wait' }
        }
      }
      return this.commitCallClaim(explicitEntry, canonicalPt, httpFingerprint)
    }

    if (this.tokenlessCorrelationCompromised) {
      return {
        kind: 'reject',
        error:
          'Antigravity MCP tokenless call correlation is unavailable after capacity saturation.',
      }
    }

    const unclaimed = [...this.activeAcpToolCalls.values()].filter(
      (entry) =>
        entry.toolName === toolName &&
        entry.lifecycle === 'open' &&
        entry.correlatedProgressToken === undefined &&
        (entry.explicitProgressToken === undefined ||
          entry.explicitProgressToken === canonicalPt) &&
        this.matchesCallRootEvidence(entry, canonicalPt),
    )
    if (unclaimed.length === 0) return { kind: 'wait' }

    const exactMatches: ActiveAcpMcpCall[] = []
    const subsetMatches: ActiveAcpMcpCall[] = []
    let missingArgsCount = 0
    for (const entry of unclaimed) {
      const verdict = compareArgsFingerprints(entry.argsFingerprint, httpFingerprint)
      if (verdict === 'exact') {
        exactMatches.push(entry)
      } else if (verdict === 'subset') {
        subsetMatches.push(entry)
      } else if (verdict === 'missing_acp_args') {
        missingArgsCount += 1
      }
    }

    const compatible = [...exactMatches, ...subsetMatches]
    if (compatible.length > 1) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP call matches multiple ambiguous ACP root tool calls.',
      }
    }
    if (missingArgsCount > 0 || compatible.length !== 1) {
      return { kind: 'wait' }
    }
    return this.commitCallClaim(compatible[0]!, canonicalPt, httpFingerprint)
  }

  private commitCallClaim(
    chosen: ActiveAcpMcpCall,
    canonicalPt: string,
    httpFingerprint: CompactArgsFingerprint,
  ): HttpClaimAttempt {
    const ownerKey = `call:${chosen.toolCallId}`
    const releasedInFlight = this.inFlightHttpFingerprints.get(canonicalPt) ?? 0
    const deltaMetadata =
      -releasedInFlight +
      Buffer.byteLength(canonicalPt, 'utf8') +
      16 +
      httpFingerprint.approxBytes +
      Buffer.byteLength(ownerKey, 'utf8') +
      16
    const current = this.computeCorrelationHeldBytes()
    if (!this.tryAdmitBytes(current.metadataBytes + deltaMetadata, current.planBufferBytes)) {
      return {
        kind: 'reject',
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }
    this.inFlightHttpFingerprints.delete(canonicalPt)
    chosen.correlatedProgressToken = canonicalPt
    chosen.claimedViaTokenless = chosen.explicitProgressToken !== canonicalPt
    chosen.claimedHttpArgsFingerprint = httpFingerprint
    this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey })
    return { kind: 'claimed', ownerKey }
  }

  private hasBlockingPreTerminalCall(toolName: string): boolean {
    for (const entry of this.activeAcpToolCalls.values()) {
      if (
        entry.sawPreTerminal &&
        entry.lifecycle === 'open' &&
        entry.correlatedProgressToken === undefined &&
        (entry.explicitProgressToken === undefined || entry.toolName === toolName)
      ) {
        return true
      }
    }
    return false
  }

  async claimOrWaitForHttp(
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    canonicalPt: string,
    isCurrent: () => boolean,
    checkRootProof: () => RootProofCheckResult,
    timeoutMs = AGY_MCP_CORRELATION_WAIT_MS,
  ): Promise<{ ok: true; ownerKey: string } | { ok: false; error: string }> {
    const immediate = this.tryClaimForHttp(
      toolName,
      httpFingerprint,
      canonicalPt,
      false,
      checkRootProof,
    )
    if (immediate.kind === 'claimed') {
      return { ok: true, ownerKey: immediate.ownerKey }
    }
    if (immediate.kind === 'reject') {
      return { ok: false, error: immediate.error }
    }
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }

    const waitOutcome = await new Promise<HttpClaimAttempt>((resolveWait) => {
      let settled = false
      const cleanup = (timer: ReturnType<typeof setTimeout>): void => {
        clearTimeout(timer)
        this.activeCallWaiters.delete(onSignal)
      }
      const finish = (outcome: HttpClaimAttempt, timer: ReturnType<typeof setTimeout>): void => {
        if (settled) return
        settled = true
        cleanup(timer)
        resolveWait(outcome)
      }
      const timer = setTimeout(
        () => {
          if (this.closed || this.revoked || !isCurrent()) {
            finish(
              {
                kind: 'reject',
                error: 'This Pact tool capability belongs to a retired root turn.',
              },
              timer,
            )
            return
          }
          const finalCheck = this.tryClaimForHttp(
            toolName,
            httpFingerprint,
            canonicalPt,
            toolName !== 'read_collaboration_source',
            checkRootProof,
          )
          finish(finalCheck, timer)
        },
        Math.max(0, timeoutMs),
      )
      const onSignal = (): void => {
        if (this.closed || this.revoked || !isCurrent()) {
          finish(
            { kind: 'reject', error: 'This Pact tool capability belongs to a retired root turn.' },
            timer,
          )
          return
        }
        const check = this.tryClaimForHttp(
          toolName,
          httpFingerprint,
          canonicalPt,
          false,
          checkRootProof,
        )
        if (check.kind === 'claimed' || check.kind === 'reject') {
          finish(check, timer)
        }
      }
      this.activeCallWaiters.add(onSignal)
    })

    if (waitOutcome.kind === 'claimed') {
      return { ok: true, ownerKey: waitOutcome.ownerKey }
    }
    if (waitOutcome.kind === 'reject') {
      return { ok: false, error: waitOutcome.error }
    }
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }

    // Re-check terminal token dispositions & capacity BEFORE missing positive root proof.
    if (this.tokenCapacityExhausted || this.correlatorCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection token capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalPt)
    if (ledger?.kind === 'non_mcp') {
      return {
        ok: false,
        error: 'Antigravity MCP progressToken belongs to a non-Pact ACP tool call.',
      }
    }
    if (ledger?.kind !== 'in_flight_http') {
      return {
        ok: false,
        error: 'Duplicate or already consumed Antigravity MCP progressToken.',
      }
    }

    const finalRootProof = checkRootProof()
    if (finalRootProof !== 'ok') {
      return {
        ok: false,
        error:
          finalRootProof === 'wait'
            ? 'Antigravity MCP progressToken does not match an ACP-authenticated root trajectory or step boundary.'
            : finalRootProof.error,
      }
    }

    // Only ACP-pinned non-source tools with no blocking pre-terminal ACP call may stage provisionally
    // as `token:<canonicalPt>`, and they atomically migrate to `call:<id>` if a late `in_progress` arrives.
    if (
      this.trajectoryIdSource === 'acp' &&
      toolName !== 'read_collaboration_source' &&
      !this.tokenlessCorrelationCompromised &&
      !this.hasBlockingPreTerminalCall(toolName)
    ) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const releasedInFlight = this.inFlightHttpFingerprints.get(canonicalPt) ?? 0
      const deltaMetadata =
        -releasedInFlight +
        Buffer.byteLength(canonicalPt, 'utf8') +
        httpFingerprint.approxBytes +
        32 +
        Buffer.byteLength(tokenOwnerKey, 'utf8') +
        16
      const current = this.computeCorrelationHeldBytes()
      if (!this.tryAdmitBytes(current.metadataBytes + deltaMetadata, current.planBufferBytes)) {
        return {
          ok: false,
          error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
        }
      }
      this.inFlightHttpFingerprints.delete(canonicalPt)
      this.tokenLedger.set(canonicalPt, { kind: 'claimed', ownerKey: tokenOwnerKey })
      this.provisionalTokenOwners.set(canonicalPt, { toolName, httpFingerprint })
      return { ok: true, ownerKey: tokenOwnerKey }
    }

    return {
      ok: false,
      error: 'Antigravity MCP call does not match an active ACP-authenticated root tool call.',
    }
  }

  revalidateLiveClaim(
    canonicalToken: string,
    toolName: string,
    httpFingerprint: CompactArgsFingerprint,
    isCurrent: () => boolean,
  ): { ok: true; ownerKey: string } | { ok: false; error: string } {
    if (this.closed || this.revoked || !isCurrent()) {
      return { ok: false, error: 'This Pact tool capability belongs to a retired root turn.' }
    }
    if (this.correlatorCapacityExhausted || this.tokenCapacityExhausted) {
      return {
        ok: false,
        error: 'Antigravity MCP replay protection capacity reached for this turn.',
      }
    }
    const ledger = this.tokenLedger.get(canonicalToken)
    if (ledger?.kind !== 'claimed') {
      return {
        ok: false,
        error: 'Antigravity MCP claim was revoked or superseded before execution.',
      }
    }
    const ownerKey = ledger.ownerKey
    if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      if (this.retiredCallIdDigests.has(hashCallIdDigest(tcId))) {
        return {
          ok: false,
          error: 'Antigravity MCP claim was revoked before execution.',
        }
      }
      const entry = this.activeAcpToolCalls.get(tcId)
      if (
        !entry ||
        entry.lifecycle !== 'open' ||
        entry.toolName !== toolName ||
        entry.correlatedProgressToken !== canonicalToken ||
        !this.matchesCallRootEvidence(entry, canonicalToken) ||
        (entry.explicitProgressToken !== undefined &&
          entry.explicitProgressToken !== canonicalToken) ||
        (entry.explicitProgressToken === undefined && this.tokenlessCorrelationCompromised) ||
        entry.claimedHttpArgsFingerprint?.fullDigest !== httpFingerprint.fullDigest ||
        (entry.argsFingerprint !== undefined &&
          compareArgsFingerprints(entry.argsFingerprint, httpFingerprint) === 'mismatch')
      ) {
        return {
          ok: false,
          error: 'Antigravity MCP claim is no longer valid for this active tool call.',
        }
      }
      return { ok: true, ownerKey }
    }
    if (ownerKey === `token:${canonicalToken}`) {
      const prov = this.provisionalTokenOwners.get(canonicalToken)
      if (
        !prov ||
        prov.toolName !== toolName ||
        prov.httpFingerprint.fullDigest !== httpFingerprint.fullDigest ||
        this.trajectoryIdSource !== 'acp' ||
        this.tokenlessCorrelationCompromised ||
        toolName === 'read_collaboration_source'
      ) {
        return {
          ok: false,
          error: 'Antigravity MCP provisional claim is no longer valid.',
        }
      }
      return { ok: true, ownerKey }
    }
    return {
      ok: false,
      error: 'Antigravity MCP claim owner is invalid.',
    }
  }

  consumeRejectedClaim(canonicalToken: string): void {
    const ledger = this.tokenLedger.get(canonicalToken)
    if (ledger?.kind !== 'claimed') return
    const ownerKey = ledger.ownerKey
    if (this.stagedOutcomes.has(ownerKey)) return
    this.tokenLedger.set(canonicalToken, { kind: 'consumed' })
    if (ownerKey === `token:${canonicalToken}`) {
      this.provisionalTokenOwners.delete(canonicalToken)
    } else if (ownerKey.startsWith('call:')) {
      const tcId = ownerKey.slice('call:'.length)
      const call = this.activeAcpToolCalls.get(tcId)
      if (call?.correlatedProgressToken === canonicalToken) {
        this.retireCallId(tcId)
      }
    }
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  stageOutcome(
    auth: { progressToken: string; httpFingerprint: CompactArgsFingerprint },
    toolName: string,
    kind: StagedMcpOutcomeKind,
    isCurrent: () => boolean,
    planChunk?: { offset: number; bytes: Buffer; hasNonWhitespace: boolean; complete: boolean },
  ): { ok: true; ownerKey: string } | { ok: false; error: string } {
    const live = this.revalidateLiveClaim(
      auth.progressToken,
      toolName,
      auth.httpFingerprint,
      isCurrent,
    )
    if (!live.ok) {
      return live
    }
    const ownerKey = live.ownerKey
    if (
      this.stagedOutcomes.size >= 64 ||
      this.stagedOutcomes.has(ownerKey) ||
      (planChunk && this.pendingPlanChunks.length >= 64)
    ) {
      return { ok: false, error: 'Too many pending Pact MCP outcomes in this turn.' }
    }
    if (kind.type === 'title' && this.isTitleSlotTaken) {
      return { ok: false, error: 'A session title was already submitted in this turn.' }
    }
    if (kind.type === 'peer' && this.isPeerSlotTaken) {
      return { ok: false, error: 'This answer already has a peer request.' }
    }
    if (kind.type === 'publish_plan_chunk' && this.isOpenPlanFinalizedOrPendingFinal) {
      return { ok: false, error: 'A published Plan has already been finalized in this root turn.' }
    }

    const payloadBytes = estimateStagedOutcomePayloadBytes(kind)
    const stagedMetaBytes =
      Buffer.byteLength(ownerKey, 'utf8') +
      Buffer.byteLength(auth.progressToken, 'utf8') +
      auth.httpFingerprint.approxBytes +
      payloadBytes +
      32
    const chunkMetaBytes = planChunk ? Buffer.byteLength(ownerKey, 'utf8') + 48 : 0
    const chunkBufBytes = planChunk ? planChunk.bytes.byteLength : 0
    const current = this.computeCorrelationHeldBytes()
    const nextPlanBufferBytes = current.planBufferBytes + chunkBufBytes
    const nextConversionWorkspaceBytes = planChunk?.complete
      ? computePlanConversionWorkspaceBytes(nextPlanBufferBytes)
      : this.planConversionWorkspaceBytes
    if (
      !this.tryAdmitBytes(
        current.metadataBytes + stagedMetaBytes + chunkMetaBytes,
        nextPlanBufferBytes,
        nextConversionWorkspaceBytes + this.pendingTransferredPlanBytes,
      )
    ) {
      return {
        ok: false,
        error: 'Antigravity MCP correlation memory budget exceeded for this turn.',
      }
    }

    const record: StagedMcpOutcomeRecord = {
      ownerKey,
      progressToken: auth.progressToken,
      httpFingerprint: auth.httpFingerprint,
      kind,
      payloadBytes,
    }
    this.stagedOutcomes.set(ownerKey, record)
    if (planChunk) {
      if (planChunk.complete) {
        this.planConversionWorkspaceBytes = nextConversionWorkspaceBytes
        this.acknowledgedFinalOpenPlan = true
      }
      this.pendingPlanChunks.push({
        ownerKey,
        offset: planChunk.offset,
        bytes: planChunk.bytes,
        hasNonWhitespace: planChunk.hasNonWhitespace,
        complete: planChunk.complete,
        confirmed: false,
        invalidated: false,
      })
    }
    if (kind.type === 'title') {
      this.pendingTitleOwner = ownerKey
    } else if (kind.type === 'peer') {
      this.pendingPeerOwner = ownerKey
    }
    return { ok: true, ownerKey }
  }

  assembleCandidateOpenPlanMarkdown(finalOwnerKey: string): string | undefined {
    // Require EVERY preceding contributing chunk to be ACP-confirmed before accepting a durable
    // final intent so unconfirmed prefix bytes can never be promoted during cold recovery.
    const activePending = this.pendingPlanChunks.filter((chunk) => !chunk.invalidated)
    const finalChunk = activePending.find(
      (chunk) => chunk.ownerKey === finalOwnerKey && chunk.complete,
    )
    if (!finalChunk) return undefined
    if (
      activePending.some((chunk) => chunk !== finalChunk && !chunk.confirmed) ||
      finalChunk.offset !== this.confirmedPlanBytes
    ) {
      return undefined
    }
    const orderedParts: Buffer[] = [...this.confirmedPlanChunks, finalChunk.bytes]
    const totalBytes = this.confirmedPlanBytes + finalChunk.bytes.byteLength
    if (totalBytes <= 0 || totalBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
      return undefined
    }
    const markdown = Buffer.concat(orderedParts, totalBytes).toString('utf8')
    return markdown.trim().length > 0 ? markdown : undefined
  }

  rollbackFailedFinalOpenPlanIntent(ownerKey: string, canonicalToken: string): void {
    this.cancelStagedOwner(ownerKey)
    if (
      !this.openPlanFinalized &&
      !this.pendingPlanChunks.some((chunk) => !chunk.invalidated && chunk.complete)
    ) {
      this.acknowledgedFinalOpenPlan = false
    }
    this.consumeRejectedClaim(canonicalToken)
  }

  private resolvePromotableOwnerKey(info: {
    toolCallId: string
    toolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): string | undefined {
    if (this.revoked || this.closed || info.receivedAfterPromptReply) return undefined
    if (
      info.toolCallId.length === 0 ||
      Buffer.byteLength(info.toolCallId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
    ) {
      return undefined
    }
    if (this.retiredCallIdDigests.has(hashCallIdDigest(info.toolCallId))) {
      return undefined
    }
    if (this.correlatorCapacityExhausted || this.tokenCapacityExhausted) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    if (info.invalidProgressToken || info.rootEvidenceContradicted) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    let canonicalPt: string | undefined
    let parsedPt: CanonicalProgressToken | undefined
    if (info.progressToken !== undefined) {
      parsedPt = canonicalizeProgressToken(info.progressToken)
      if (!parsedPt || parsedPt.structured?.hasLeadingZeros) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      canonicalPt = parsedPt.canonical
    }
    if (!this.validatesAgainstRootEvidence(info.trajectoryId, info.stepIdx, parsedPt)) {
      this.retireCallId(info.toolCallId)
      return undefined
    }
    const entry = this.activeAcpToolCalls.get(info.toolCallId)
    // S1-#2: Require the current terminal transition to have been admitted into activeAcpToolCalls,
    // never already promoted, and strictly bound to the admitted toolName.
    if (
      !entry ||
      entry.lifecycle !== 'completed' ||
      entry.promoted === true ||
      entry.toolName !== info.toolName
    ) {
      return undefined
    }
    if (entry.correlatedProgressToken !== undefined) {
      const callOwnerKey = `call:${info.toolCallId}`
      const ledger = this.tokenLedger.get(entry.correlatedProgressToken)
      if (ledger?.kind !== 'claimed' || ledger.ownerKey !== callOwnerKey) {
        return undefined
      }
      if (
        (entry.explicitProgressToken === undefined || entry.claimedViaTokenless) &&
        this.tokenlessCorrelationCompromised
      ) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      if (
        !this.matchesCallRootEvidence(entry, entry.correlatedProgressToken) ||
        (entry.explicitProgressToken !== undefined &&
          entry.explicitProgressToken !== entry.correlatedProgressToken) ||
        (canonicalPt !== undefined && canonicalPt !== entry.correlatedProgressToken)
      ) {
        this.retireCallId(info.toolCallId)
        return undefined
      }
      return callOwnerKey
    }
    if (
      !entry.sawPreTerminal &&
      canonicalPt !== undefined &&
      entry.explicitProgressToken === canonicalPt &&
      this.trajectoryIdSource === 'acp' &&
      !this.tokenlessCorrelationCompromised &&
      this.matchesCallRootEvidence(entry, canonicalPt)
    ) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const ledger = this.tokenLedger.get(canonicalPt)
      const prov = this.provisionalTokenOwners.get(canonicalPt)
      if (
        ledger?.kind === 'claimed' &&
        ledger.ownerKey === tokenOwnerKey &&
        prov !== undefined &&
        prov.toolName === entry.toolName
      ) {
        return tokenOwnerKey
      }
    }
    return undefined
  }

  promoteCompletedAcpToolCall(info: {
    toolCallId: string
    toolName: string
    progressToken?: unknown
    invalidProgressToken?: boolean | undefined
    args?: Record<string, unknown> | undefined
    argsFingerprint?: CompactArgsFingerprint | undefined
    trajectoryId?: string | undefined
    stepIdx?: number | undefined
    rootEvidenceContradicted?: boolean | undefined
    receivedAfterPromptReply?: boolean | undefined
  }): PromotedMcpOutcome | undefined {
    const ownerKey = this.resolvePromotableOwnerKey({
      toolCallId: info.toolCallId,
      toolName: info.toolName,
      progressToken: info.progressToken,
      invalidProgressToken: info.invalidProgressToken,
      trajectoryId: info.trajectoryId,
      stepIdx: info.stepIdx,
      rootEvidenceContradicted: info.rootEvidenceContradicted,
      receivedAfterPromptReply: info.receivedAfterPromptReply,
    })
    if (!ownerKey) return undefined
    const entry = this.activeAcpToolCalls.get(info.toolCallId)
    if (entry) {
      entry.promoted = true
    }
    const staged = this.stagedOutcomes.get(ownerKey)
    this.stagedOutcomes.delete(ownerKey)
    if (!staged) {
      this.markClaimedTokenConsumedForOwner(ownerKey)
      this.syncReservationAfterShrink()
      return undefined
    }

    if (info.argsFingerprint !== undefined || info.args !== undefined) {
      const incomingFp =
        info.argsFingerprint ??
        (info.args !== undefined ? buildCompactArgsFingerprint(info.args, true) : undefined)
      if (
        !incomingFp ||
        compareArgsFingerprints(incomingFp, staged.httpFingerprint) === 'mismatch'
      ) {
        this.cancelStagedOwner(ownerKey)
        return undefined
      }
    }

    this.markClaimedTokenConsumedForOwner(ownerKey, staged.progressToken)
    const kind = staged.kind
    let promoted: PromotedMcpOutcome | undefined
    if (kind.type === 'title') {
      if (this.pendingTitleOwner === ownerKey) this.pendingTitleOwner = undefined
      if (!this.titleConfirmed && info.toolName === 'publish_session_title') {
        this.titleConfirmed = true
        promoted = kind
      }
    } else if (kind.type === 'peer') {
      if (this.pendingPeerOwner === ownerKey) this.pendingPeerOwner = undefined
      if (!this.peerConfirmed && info.toolName === 'request_peer_assistance') {
        this.peerConfirmed = true
        promoted = kind
      }
    } else if (kind.type === 'review') {
      promoted = info.toolName === 'submit_review' ? kind : undefined
    } else if (kind.type === 'input_result') {
      promoted = info.toolName === 'submit_input_result' ? kind : undefined
    } else if (kind.type === 'retain_plan') {
      promoted = info.toolName === 'retain_current_plan' ? kind : undefined
    } else if (kind.type === 'publish_plan_chunk') {
      if (info.toolName === 'publish_plan') {
        const chunk = this.pendingPlanChunks.find((c) => c.ownerKey === ownerKey && !c.invalidated)
        if (chunk && chunk.offset === kind.offset) {
          if (chunk.complete) {
            const idBytes = Buffer.byteLength(info.toolCallId, 'utf8')
            const current = this.computeCorrelationHeldBytes()
            if (!this.tryAdmitBytes(current.metadataBytes + idBytes, current.planBufferBytes)) {
              this.cancelStagedOwner(ownerKey)
              this.openPlanFinalized = true
              this.syncReservationAfterShrink()
              return {
                type: 'publish_plan_failed',
                reason:
                  'Antigravity open plan metadata budget exceeded while confirming final chunk.',
              }
            }
            chunk.confirmedToolCallId = info.toolCallId
          }
          chunk.confirmed = true
          promoted = this.flushConfirmedPlanChunks()
        }
      }
    }
    this.syncReservationAfterShrink()
    return promoted
  }

  private flushConfirmedPlanChunks(): PromotedMcpOutcome | undefined {
    if (this.openPlanFinalized) return undefined
    while (this.pendingPlanChunks.length > 0) {
      const head = this.pendingPlanChunks[0]!
      if (head.invalidated || !head.confirmed || head.offset !== this.confirmedPlanBytes) {
        break
      }
      this.pendingPlanChunks.shift()
      this.confirmedPlanChunks.push(head.bytes)
      this.confirmedPlanBytes += head.bytes.byteLength
      if (head.hasNonWhitespace) {
        this.confirmedPlanHasNonWhitespace = true
      }
      if (head.complete) {
        const finalToolCallId = head.confirmedToolCallId
        if (!this.confirmedPlanHasNonWhitespace || !finalToolCallId) {
          this.confirmedPlanChunks.length = 0
          this.confirmedPlanBytes = 0
          this.confirmedPlanHasNonWhitespace = false
          this.planConversionWorkspaceBytes = 0
          this.openPlanFinalized = true
          this.syncReservationAfterShrink()
          return {
            type: 'publish_plan_failed',
            reason: 'Antigravity open plan finalization lacked non-empty confirmed content.',
          }
        }
        const workspaceBytes = computePlanConversionWorkspaceBytes(this.confirmedPlanBytes)
        if (workspaceBytes > this.planConversionWorkspaceBytes) {
          const current = this.computeCorrelationHeldBytes()
          if (
            !this.tryAdmitBytes(
              current.metadataBytes,
              current.planBufferBytes,
              workspaceBytes + this.pendingTransferredPlanBytes,
            )
          ) {
            this.confirmedPlanChunks.length = 0
            this.confirmedPlanBytes = 0
            this.confirmedPlanHasNonWhitespace = false
            this.planConversionWorkspaceBytes = 0
            this.openPlanFinalized = true
            this.syncReservationAfterShrink()
            return {
              type: 'publish_plan_failed',
              reason: 'Antigravity open plan conversion exceeded shared working-memory budget.',
            }
          }
          this.planConversionWorkspaceBytes = workspaceBytes
        }
        const markdown = Buffer.concat(this.confirmedPlanChunks, this.confirmedPlanBytes).toString(
          'utf8',
        )
        this.confirmedPlanChunks.length = 0
        this.confirmedPlanBytes = 0
        this.confirmedPlanHasNonWhitespace = false
        this.planConversionWorkspaceBytes = 0
        if (!markdown.trim()) {
          this.openPlanFinalized = true
          this.syncReservationAfterShrink()
          return {
            type: 'publish_plan_failed',
            reason: 'Antigravity open plan decoded to empty Markdown.',
          }
        }
        this.pendingTransferredPlanBytes = computeRetainedPlanTextBytes(markdown)
        this.syncReservationAfterShrink()
        this.openPlanFinalized = true
        return { type: 'publish_plan', markdown, finalToolCallId }
      }
    }
    return undefined
  }

  failAcpToolCall(info: { toolCallId: string; toolName: string; progressToken?: unknown }): void {
    this.retireCallId(info.toolCallId)
    const parsedPt =
      info.progressToken !== undefined ? canonicalizeProgressToken(info.progressToken) : undefined
    const canonicalPt = parsedPt?.canonical
    if (canonicalPt !== undefined) {
      const tokenOwnerKey = `token:${canonicalPt}`
      const ledger = this.tokenLedger.get(canonicalPt)
      if (ledger?.kind === 'claimed' && ledger.ownerKey === tokenOwnerKey) {
        this.cancelStagedOwner(tokenOwnerKey)
      }
    }
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  notifyWaiters(): void {
    this.wakeAllWaiters()
  }

  revokeRun(): void {
    this.revoked = true
    this.pendingTitleOwner = undefined
    this.pendingPeerOwner = undefined
    this.provisionalTokenOwners.clear()
    this.stagedOutcomes.clear()
    this.pendingPlanChunks.length = 0
    this.confirmedPlanHasNonWhitespace = false
    this.planConversionWorkspaceBytes = 0
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
    this.wakeAllWaiters()
  }

  close(): void {
    this.closed = true
    this.revoked = true
    this.wakeAllWaiters()
    this.activeCallWaiters.clear()
    this.activeAcpToolCalls.clear()
    this.retiredCallIdDigests.clear()
    this.tokenLedger.clear()
    this.inFlightHttpFingerprints.clear()
    this.provisionalTokenOwners.clear()
    this.stagedOutcomes.clear()
    this.pendingTitleOwner = undefined
    this.pendingPeerOwner = undefined
    this.pendingPlanChunks.length = 0
    this.confirmedPlanChunks.length = 0
    this.confirmedPlanBytes = 0
    this.confirmedPlanHasNonWhitespace = false
    this.planConversionWorkspaceBytes = 0
    this.pendingTransferredPlanBytes = 0
    this.syncReservationAfterShrink()
  }
}
