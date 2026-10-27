import type { Page, TestInfo } from '@playwright/test'

import { createHash } from 'node:crypto'
import { lstat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { DesktopBridge } from '../../packages/contracts/src/index.js'
import type { RuntimeFixture } from './runtime-fixture.js'

import {
  diagnosticRecordSchema,
  diagnosticStatusSchema,
  sourceReadDiagnosticSchema,
} from '../../packages/contracts/src/diagnostics.js'

export async function routingSchedulingObservation(page: Page, sessionId: string, refresh = false) {
  return page.evaluate(
    async (payload) => {
      const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
      const reply = payload.refresh
        ? await bridge.refreshSchedulingState({ sessionId: payload.sessionId })
        : await bridge.getSchedulingState({ sessionId: payload.sessionId })
      if (!reply.ok) return { ok: false as const, error: reply.error.code }
      const state = reply.value
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- This helper must travel inside the serialized browser closure.
      const project = (value: typeof state.host) => ({
        status: value.status,
        provider: value.capability?.provider ?? null,
        model: value.capability?.modelId ?? null,
        reason: value.capability?.reason ?? null,
        physicalReleased: value.capability?.physicalReleased ?? null,
      })
      return {
        ok: true as const,
        enabled: state.settings.enabled,
        host: project(state.host),
        context: state.context
          ? { eligibility: state.context.eligibility, ...project(state.context.observation) }
          : null,
        decision: state.activity.decision.status,
        check: state.activity.check.status,
      }
    },
    { sessionId, refresh },
  )
}

export async function routingSafeLogPhases(
  fixture: Pick<RuntimeFixture, 'databaseFile'>,
  page?: Page,
) {
  try {
    const path = join(dirname(fixture.databaseFile), 'logs/development/pact-0.jsonl'),
      before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 5 * 1024 * 1024)
      return { status: 'unavailable' }
    const handle = await open(path, 'r')
    try {
      const current = await handle.stat()
      if (current.dev !== before.dev || current.ino !== before.ino) return { status: 'changed' }
      const size = Math.min(current.size, 64 * 1024),
        start = current.size - size,
        bytes = Buffer.alloc(size)
      const read = await handle.read(bytes, 0, size, start),
        text = bytes.subarray(0, read.bytesRead).toString('utf8'),
        lines = text.split('\n')
      if (start) lines.shift()
      let invalidLines = 0
      const sourceFailures: unknown[] = []
      let sourceFailuresOmitted = 0,
        droppedObserved = false
      const events = lines.flatMap((line) => {
        if (!line) return []
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          invalidLines += 1
          return []
        }
        const parsed = diagnosticRecordSchema.safeParse(raw)
        if (!parsed.success) {
          invalidLines += 1
          return []
        }
        const value = parsed.data
        if (value.operation === 'queue' && value.phase === 'dropped') droppedObserved = true
        if (value.sourceRead) {
          if (sourceFailures.length < 4) sourceFailures.push(value.sourceRead)
          else sourceFailuresOmitted += 1
        }
        return [
          {
            operation: value.operation,
            phase: value.phase,
            level: value.level,
            agent: value.agentId ?? null,
            code: value.code ?? null,
            catalogPhase: value.settingsCatalogPhase ?? null,
            catalogFailure: value.settingsCatalogFailure ?? null,
            boundary: value.runtimeBoundary ?? null,
            errorType: value.runtimeErrorType ?? null,
            informationAdviceRefusal: value.informationAdviceRefusal ?? null,
            inputAdviceResult: value.inputAdviceResult ?? null,
          },
        ]
      })
      let statusDeadline: ReturnType<typeof setTimeout> | undefined
      let statusValue: unknown
      try {
        if (page)
          statusValue = await Promise.race([
            page
              .evaluate(async () => {
                const bridge: DesktopBridge = Reflect.get(globalThis, 'pact')
                return bridge.getDiagnosticStatus?.()
              })
              .catch(() => undefined),
            new Promise<void>((resolve) => {
              statusDeadline = setTimeout(resolve, 1000)
            }),
          ])
      } finally {
        if (statusDeadline) clearTimeout(statusDeadline)
      }
      const diagnosticStatus = diagnosticStatusSchema.safeParse(statusValue)
      return {
        status: 'bounded-tail',
        tailBytes: read.bytesRead,
        events: events.slice(-32),
        sourceFailures,
        sourceFailuresOmitted,
        sourceFailuresComplete: start === 0 && invalidLines === 0 && sourceFailuresOmitted === 0,
        droppedObserved,
        diagnosticStatus: diagnosticStatus.success
          ? { state: diagnosticStatus.data.state, dropped: diagnosticStatus.data.dropped }
          : null,
      }
    } finally {
      await handle.close()
    }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Explanation only. Missing or ambiguous diagnostics never establish successful source access. */
export function correlateSourceReadFailures(
  leaves: ReadonlyArray<{
    nativeCallSha256: string | null
    nativeCallUnique: boolean
    requestSha256: string | null
  }>,
  observation: Awaited<ReturnType<typeof routingSafeLogPhases>>,
) {
  return leaves.map((leaf) => {
    if (
      observation.status !== 'bounded-tail' ||
      !('sourceFailures' in observation) ||
      !observation.sourceFailuresComplete ||
      observation.droppedObserved ||
      observation.diagnosticStatus?.state !== 'ready' ||
      observation.diagnosticStatus.dropped !== 0 ||
      !leaf.nativeCallUnique ||
      !leaf.nativeCallSha256 ||
      !leaf.requestSha256
    )
      return { status: 'unknown' as const, reason: 'incomplete_observation' as const }
    const candidates = observation.sourceFailures.flatMap((value) => {
      const parsed = sourceReadDiagnosticSchema.safeParse(value)
      return parsed.success && parsed.data.nativeCallSha256 === leaf.nativeCallSha256
        ? [parsed.data]
        : []
    })
    if (
      candidates.length !== 1 ||
      leaves.filter((other) => other.nativeCallSha256 === leaf.nativeCallSha256).length !== 1
    )
      return { status: 'unknown' as const, reason: 'missing_or_duplicate_call' as const }
    const candidate = candidates[0]!
    if (candidate.requestSha256 !== leaf.requestSha256)
      return { status: 'unknown' as const, reason: 'request_mismatch' as const }
    return { status: 'matched_observed_failure' as const, sourceRead: candidate }
  })
}

export async function retainSourceReadFailureDiagnostics(
  info: TestInfo,
  fixture: RuntimeFixture,
  page: Page,
  leaves: Parameters<typeof correlateSourceReadFailures>[0],
) {
  const observation = await routingSafeLogPhases(fixture, page)
  await emitRoutingEvidence(info, 'source-read-failure-diagnostics', {
    observation,
    correlations: correlateSourceReadFailures(leaves, observation),
  })
}
export function routingUsageCounts(text: string | null) {
  if (!text) return null
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const counts: Record<string, number> = {}
  for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens', 'totalTokens']) {
    const count: unknown = Reflect.get(value, key)
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) counts[key] = count
  }
  return counts
}

interface RoutingBenefitArm {
  manualRouteCorrections: number
  realBusinessTurns: number
  decisionCalls: number
  firstActualRecipient: string
  elapsedMs: number
}

function evidenceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Root receipts retain full diagnostics; arm summaries reference those exact emitted bytes. */
function routingArmEvidence(arm: unknown): unknown {
  if (!evidenceRecord(arm) || !Array.isArray(arm['nativeFacts'])) return arm
  return {
    ...arm,
    nativeFacts: arm['nativeFacts'].map((fact: unknown) => {
      if (!evidenceRecord(fact)) return fact
      const source = fact['sourceAccess']
      if (!evidenceRecord(source) || !Object.hasOwn(source, 'boundaryDiagnostics')) return fact
      const { boundaryDiagnostics: _diagnostics, ...summary } = source
      return {
        ...fact,
        sourceAccess: summary,
        sourceAccessReceiptSha256: createHash('sha256')
          .update(JSON.stringify({ actor: fact['actor'], ...source }))
          .digest('hex'),
      }
    }),
  }
}

/** Full arm evidence is emitted separately; link it once instead of duplicating its body. */
function routingArmReference(label: string, arm: RoutingBenefitArm) {
  return {
    label,
    sha256: createHash('sha256')
      .update(JSON.stringify(routingArmEvidence(arm)))
      .digest('hex'),
    realBusinessTurns: arm.realBusinessTurns,
    manualRouteCorrections: arm.manualRouteCorrections,
    decisionCalls: arm.decisionCalls,
    firstActualRecipient: arm.firstActualRecipient,
    elapsedMs: arm.elapsedMs,
  }
}

export function routingBenefitSummary(off: RoutingBenefitArm, on: RoutingBenefitArm) {
  return {
    off: routingArmReference('relay-routing-off', off),
    on: routingArmReference('relay-routing-on', on),
    savedManualCorrections: off.manualRouteCorrections - on.manualRouteCorrections,
    savedBusinessTurns: off.realBusinessTurns - on.realBusinessTurns,
  }
}

export async function emitRoutingEvidence(
  info: Pick<TestInfo, 'attach'>,
  label: string,
  evidence: unknown,
) {
  const encoded = JSON.stringify(
    label === 'on' || label === 'off' ? routingArmEvidence(evidence) : evidence,
  )
  if (Buffer.byteLength(encoded) > 16 * 1024)
    throw Error('Routing evidence exceeds the fixed observation budget')
  console.info(`[pact-relay-routing-${label}]`, encoded)
  await info.attach(`relay-routing-${label}`, {
    body: Buffer.from(encoded),
    contentType: 'application/json',
  })
}
