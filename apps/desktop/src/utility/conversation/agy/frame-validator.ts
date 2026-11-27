import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import type {
  CollaborationInputObservation,
  CollaborationReviewObservation,
  RuntimeAgentId,
} from '@pact/contracts'

import { sanitizeNativeTerminalFailure } from '@pact/agent-runtime'

import type { AgyIngress } from '../agy-acp-connection'

import { isValidAgyTrajectoryId } from '../agy-native-storage'
import { isAgyBrainArtifactPath, workspaceRelativePath } from '../native-file-changes'
import { safeNativePermissionText } from '../native-permission-wait'
import {
  AGY_MCP_MAX_FINGERPRINT_BYTES,
  AGY_MCP_MAX_FINGERPRINT_KEYS,
  AGY_MCP_MAX_PROGRESS_TOKEN_BYTES,
  AGY_MCP_MAX_TOOL_CALL_ID_BYTES,
  AGY_PROGRESS_TOKEN_PATTERN,
  AGY_STRICT_STEP_INDEX_PATTERN,
  VALID_ACP_STOP_REASONS,
  asString,
  isPlainObject,
  normalizeAcpToolStatus,
  type ActiveAgyRun,
  type CanonicalProgressToken,
  type CompactArgsFingerprint,
  type StructuredProgressToken,
  type ValidatedAgyFrame,
} from './types'

export function hasValidArtifactMetadata(args: Record<string, unknown> | undefined): boolean {
  if (!args) return false
  const meta = args.ArtifactMetadata ?? args.artifactMetadata
  if (!isPlainObject(meta)) return false
  return Object.keys(meta).length > 0
}

export const SAFE_BRAIN_COMPONENT_PATTERN = /^[A-Za-z0-9._-]+$/u

export function isEnoentFsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function verifyNonSymlinkBrainEntry(
  targetPath: string,
  expectedKind: 'dir' | 'file',
): 'exists' | 'missing' | 'invalid' {
  try {
    const st = lstatSync(targetPath)
    if (st.isSymbolicLink()) return 'invalid'
    if (expectedKind === 'dir' ? !st.isDirectory() : !st.isFile()) return 'invalid'
    if (realpathSync(targetPath) !== targetPath) return 'invalid'
    return 'exists'
  } catch (error) {
    return isEnoentFsError(error) ? 'missing' : 'invalid'
  }
}

export function resolveBrainPlanThreeSegmentFileName(
  baseRoot: string,
  candidatePath: string,
  nativeSessionId: string,
): string | undefined {
  const rel = relative(baseRoot, candidatePath).replaceAll('\\', '/')
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
  const parts = rel.split('/')
  if (parts.length !== 3 || parts[0] !== 'brain' || parts[1] !== nativeSessionId) return undefined
  const fileName = parts[2]!
  if (
    !fileName ||
    !fileName.toLowerCase().endsWith('.md') ||
    fileName === '.md' ||
    fileName.startsWith('..') ||
    !SAFE_BRAIN_COMPONENT_PATTERN.test(fileName)
  ) {
    return undefined
  }
  return fileName
}

export function isVerifiedDirectBrainPlanWriteTarget(
  rawPath: string,
  cwd: string,
  appDataDirs: readonly string[],
  nativeSessionId: string,
): boolean {
  if (
    !nativeSessionId ||
    nativeSessionId === '.' ||
    nativeSessionId === '..' ||
    !SAFE_BRAIN_COMPONENT_PATTERN.test(nativeSessionId) ||
    !rawPath ||
    rawPath.length > 4096 ||
    !rawPath.toLowerCase().endsWith('.md')
  ) {
    return false
  }
  for (let i = 0; i < rawPath.length; i += 1) {
    const code = rawPath.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return false
  }
  if (rawPath.split(/[/\\]/u).some((segment) => segment === '..')) {
    return false
  }
  const candidatePath = isAbsolute(rawPath) ? resolvePath(rawPath) : resolvePath(cwd, rawPath)
  if (workspaceRelativePath(candidatePath, cwd) !== undefined) {
    return false
  }
  for (const dir of appDataDirs) {
    let dirStat: ReturnType<typeof lstatSync>
    let canonicalAppData: string
    try {
      dirStat = lstatSync(dir)
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) continue
      canonicalAppData = realpathSync(dir)
    } catch {
      continue
    }
    const resolvedDir = resolvePath(dir)
    let fileName = resolveBrainPlanThreeSegmentFileName(
      canonicalAppData,
      candidatePath,
      nativeSessionId,
    )
    if (!fileName) {
      let resolvedDirMatches = false
      try {
        resolvedDirMatches = realpathSync(resolvedDir) === canonicalAppData
      } catch {
        resolvedDirMatches = false
      }
      if (resolvedDirMatches) {
        fileName = resolveBrainPlanThreeSegmentFileName(resolvedDir, candidatePath, nativeSessionId)
      }
    }
    if (!fileName) {
      const candidateAppData = dirname(dirname(dirname(candidatePath)))
      try {
        const candStat = lstatSync(candidateAppData)
        if (
          candStat.isDirectory() &&
          !candStat.isSymbolicLink() &&
          realpathSync(candidateAppData) === canonicalAppData
        ) {
          fileName = resolveBrainPlanThreeSegmentFileName(
            candidateAppData,
            candidatePath,
            nativeSessionId,
          )
        }
      } catch {
        fileName = undefined
      }
    }
    if (!fileName) continue

    const brainDir = join(canonicalAppData, 'brain')
    const sessionDir = join(brainDir, nativeSessionId)
    const leafPath = join(sessionDir, fileName)

    const brainState = verifyNonSymlinkBrainEntry(brainDir, 'dir')
    if (brainState === 'invalid') continue
    if (brainState === 'missing') {
      if (
        verifyNonSymlinkBrainEntry(sessionDir, 'dir') === 'missing' &&
        verifyNonSymlinkBrainEntry(leafPath, 'file') === 'missing'
      ) {
        return true
      }
      continue
    }

    const sessionState = verifyNonSymlinkBrainEntry(sessionDir, 'dir')
    if (sessionState === 'invalid') continue
    if (sessionState === 'missing') {
      if (verifyNonSymlinkBrainEntry(leafPath, 'file') === 'missing') {
        return true
      }
      continue
    }

    const leafState = verifyNonSymlinkBrainEntry(leafPath, 'file')
    if (leafState === 'exists' || leafState === 'missing') {
      return true
    }
  }
  return false
}

export function isMarkdownBrainPlanArtifact(
  rawPath: string,
  cwd: string,
  appDataDirs: readonly string[],
  nativeSessionId: string,
): boolean {
  if (!rawPath.toLowerCase().endsWith('.md')) return false
  return appDataDirs.some((dir) => isAgyBrainArtifactPath(rawPath, cwd, dir, nativeSessionId))
}

export function hashCallIdDigest(toolCallId: string): string {
  return createHash('sha256').update(toolCallId, 'utf8').digest('hex')
}

export function canonicalizeProgressToken(raw: unknown): CanonicalProgressToken | undefined {
  const rawStr =
    typeof raw === 'string'
      ? raw
      : typeof raw === 'number' && Number.isSafeInteger(raw)
        ? String(raw)
        : undefined
  if (
    !rawStr ||
    rawStr.length === 0 ||
    Buffer.byteLength(rawStr, 'utf8') > AGY_MCP_MAX_PROGRESS_TOKEN_BYTES
  ) {
    return undefined
  }
  const match = AGY_PROGRESS_TOKEN_PATTERN.exec(rawStr)
  if (!match) {
    return { canonical: rawStr }
  }
  const trajectoryId = match[1]!
  const digits = match[2]!
  const stepIdx = Number(digits)
  if (!isValidAgyTrajectoryId(trajectoryId) || !Number.isSafeInteger(stepIdx) || stepIdx < 0) {
    return undefined
  }
  const hasLeadingZeros = !AGY_STRICT_STEP_INDEX_PATTERN.test(digits)
  return {
    canonical: `${trajectoryId}:${stepIdx}`,
    structured: {
      trajectoryId,
      stepIdx,
      hasLeadingZeros,
    },
  }
}

export function parseRootProgressToken(raw: unknown): StructuredProgressToken | undefined {
  const parsed = canonicalizeProgressToken(raw)
  if (
    !parsed ||
    !parsed.structured ||
    parsed.structured.hasLeadingZeros ||
    !isValidAgyTrajectoryId(parsed.structured.trajectoryId)
  ) {
    return undefined
  }
  return {
    canonical: parsed.canonical,
    structured: {
      trajectoryId: parsed.structured.trajectoryId,
      stepIdx: parsed.structured.stepIdx,
      hasLeadingZeros: false,
    },
  }
}

export const PACT_SEMANTIC_ARG_KEYS = new Set([
  'verdict',
  'questions',
  'outcome',
  'title',
  'target',
  'kind',
  'reason',
  'text',
  'offset',
  'complete',
  'source',
  'part',
  'document',
  'batchId',
  'cutoffId',
  'messageId',
  'commentId',
  'sourceReference',
  'ordinal',
  'context',
  'runId',
  'grant',
])

export const AGY_CANONICAL_HASH_MAX_DEPTH = 12
export const AGY_CANONICAL_HASH_MAX_NODES = 16_384

export function updateCanonicalJsonHash(
  hasher: ReturnType<typeof createHash>,
  value: unknown,
  depth = 0,
  budget: { remaining: number } = { remaining: AGY_CANONICAL_HASH_MAX_NODES },
): boolean {
  if (depth > AGY_CANONICAL_HASH_MAX_DEPTH || budget.remaining <= 0) {
    return false
  }
  budget.remaining -= 1
  if (value === null || typeof value !== 'object') {
    hasher.update(JSON.stringify(value) ?? 'null')
    return true
  }
  if (Array.isArray(value)) {
    hasher.update('[')
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) hasher.update(',')
      if (!updateCanonicalJsonHash(hasher, value[i], depth + 1, budget)) {
        return false
      }
    }
    hasher.update(']')
    return true
  }
  const entries: Array<[string, unknown]> = []
  let seenKeys = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    seenKeys += 1
    if (seenKeys > budget.remaining) {
      budget.remaining = -1
      return false
    }
    const entryVal: unknown = Reflect.get(value, key)
    if (entryVal !== undefined) {
      entries.push([key, entryVal])
    }
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  hasher.update('{')
  for (let i = 0; i < entries.length; i += 1) {
    const [key, entryVal] = entries[i]!
    if (i > 0) hasher.update(',')
    hasher.update(JSON.stringify(key))
    hasher.update(':')
    if (!updateCanonicalJsonHash(hasher, entryVal, depth + 1, budget)) {
      return false
    }
  }
  hasher.update('}')
  return true
}

export function computeFullDigestFromKeyDigests(keyDigests: ReadonlyMap<string, string>): string {
  const sorted = [...keyDigests.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const hasher = createHash('sha256')
  hasher.update('{')
  for (let i = 0; i < sorted.length; i += 1) {
    const [key, digest] = sorted[i]!
    if (i > 0) hasher.update(',')
    hasher.update(JSON.stringify(key))
    hasher.update(':')
    hasher.update(digest)
  }
  hasher.update('}')
  return hasher.digest('hex')
}

export function buildCompactArgsFingerprint(
  rawRecord: Record<string, unknown>,
  stripToolSummary: boolean,
): CompactArgsFingerprint | undefined {
  const filtered: Array<[string, unknown]> = []
  let inspectedKeys = 0
  for (const key in rawRecord) {
    if (!Object.hasOwn(rawRecord, key)) continue
    inspectedKeys += 1
    if (inspectedKeys > AGY_CANONICAL_HASH_MAX_NODES) return undefined
    const val = rawRecord[key]
    if (val === undefined) continue
    if (stripToolSummary && key === 'toolSummary') continue
    if (key.length > 128) return undefined
    filtered.push([key, val])
    if (filtered.length > AGY_MCP_MAX_FINGERPRINT_KEYS) return undefined
  }
  const keyDigests = new Map<string, string>()
  let approxBytes = 128
  const budget = { remaining: AGY_CANONICAL_HASH_MAX_NODES }
  for (const [key, val] of filtered) {
    const hasher = createHash('sha256')
    if (!updateCanonicalJsonHash(hasher, val, 0, budget)) {
      return undefined
    }
    const digest = hasher.digest('hex')
    keyDigests.set(key, digest)
    approxBytes += Buffer.byteLength(key, 'utf8') + digest.length + 32
    if (approxBytes > AGY_MCP_MAX_FINGERPRINT_BYTES) return undefined
  }
  const fullDigest = computeFullDigestFromKeyDigests(keyDigests)
  return { fullDigest, keyDigests, approxBytes }
}

export function mergeArgsFingerprints(
  existing: CompactArgsFingerprint | undefined,
  incoming: CompactArgsFingerprint | undefined,
):
  | { readonly kind: 'ok'; readonly fingerprint: CompactArgsFingerprint | undefined }
  | { readonly kind: 'conflict' } {
  if (incoming === undefined) return { kind: 'ok', fingerprint: existing }
  if (existing === undefined) return { kind: 'ok', fingerprint: incoming }
  if (fingerprintsConflict(existing, incoming)) return { kind: 'conflict' }
  if (incoming.keyDigests.size === 0) {
    // Summary-only update retains all previously observed semantic keys!
    return { kind: 'ok', fingerprint: existing }
  }
  if (existing.keyDigests.size === 0) {
    return { kind: 'ok', fingerprint: incoming }
  }
  const merged = new Map<string, string>(existing.keyDigests)
  let approxBytes = existing.approxBytes
  for (const [key, digest] of incoming.keyDigests) {
    if (!merged.has(key)) {
      merged.set(key, digest)
      if (merged.size > AGY_MCP_MAX_FINGERPRINT_KEYS) return { kind: 'conflict' }
      approxBytes += Buffer.byteLength(key, 'utf8') + digest.length + 32
      if (approxBytes > AGY_MCP_MAX_FINGERPRINT_BYTES) return { kind: 'conflict' }
    }
  }
  return {
    kind: 'ok',
    fingerprint: {
      fullDigest: computeFullDigestFromKeyDigests(merged),
      keyDigests: merged,
      approxBytes,
    },
  }
}

export function mergePlainArgsRecords(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): { readonly kind: 'ok'; readonly args: Record<string, unknown> } | { readonly kind: 'conflict' } {
  if (!existing) return { kind: 'ok', args: { ...incoming } }
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    if (key === 'toolSummary') {
      merged[key] = value
      continue
    }
    if (Object.hasOwn(existing, key) && existing[key] !== undefined) {
      if (!isDeepStrictEqual(existing[key], value)) {
        return { kind: 'conflict' }
      }
    } else {
      merged[key] = value
    }
  }
  return { kind: 'ok', args: merged }
}

export function compareArgsFingerprints(
  acp: CompactArgsFingerprint | undefined,
  http: CompactArgsFingerprint,
): 'exact' | 'subset' | 'missing_acp_args' | 'mismatch' {
  if (acp === undefined) return 'missing_acp_args'
  if (acp.fullDigest === http.fullDigest) return 'exact'
  for (const [key, httpDigest] of http.keyDigests) {
    if (acp.keyDigests.get(key) !== httpDigest) {
      return 'mismatch'
    }
  }
  for (const key of acp.keyDigests.keys()) {
    if (!http.keyDigests.has(key) && PACT_SEMANTIC_ARG_KEYS.has(key)) {
      return 'mismatch'
    }
  }
  return 'subset'
}

export function fingerprintsConflict(
  a: CompactArgsFingerprint,
  b: CompactArgsFingerprint,
): boolean {
  for (const [key, hashA] of a.keyDigests) {
    const hashB = b.keyDigests.get(key)
    if (hashB !== undefined && hashB !== hashA) {
      return true
    }
  }
  return false
}

export function resolveFrameArgsEvidence(
  frameArgs: Record<string, unknown> | undefined,
  frameRawInput: Record<string, unknown> | undefined,
):
  | { readonly kind: 'none' }
  | { readonly kind: 'conflict' }
  | {
      readonly kind: 'present'
      readonly args: Record<string, unknown>
      readonly fingerprint: CompactArgsFingerprint
    } {
  if (frameArgs === undefined && frameRawInput === undefined) {
    return { kind: 'none' }
  }
  if (frameArgs !== undefined && frameRawInput === undefined) {
    const fpArgs = buildCompactArgsFingerprint(frameArgs, true)
    return fpArgs ? { kind: 'present', args: frameArgs, fingerprint: fpArgs } : { kind: 'conflict' }
  }
  if (frameArgs === undefined && frameRawInput !== undefined) {
    const fpRaw = buildCompactArgsFingerprint(frameRawInput, true)
    return fpRaw
      ? { kind: 'present', args: frameRawInput, fingerprint: fpRaw }
      : { kind: 'conflict' }
  }
  const fpArgs = buildCompactArgsFingerprint(frameArgs!, true)
  const fpRaw = buildCompactArgsFingerprint(frameRawInput!, true)
  if (!fpArgs || !fpRaw || fingerprintsConflict(fpArgs, fpRaw)) {
    return { kind: 'conflict' }
  }
  if (fpArgs.keyDigests.size > 0 && fpRaw.keyDigests.size > 0) {
    if (fpArgs.keyDigests.size !== fpRaw.keyDigests.size) {
      return { kind: 'conflict' }
    }
    for (const [key, digest] of fpArgs.keyDigests) {
      if (fpRaw.keyDigests.get(key) !== digest) {
        return { kind: 'conflict' }
      }
    }
  }
  const merged = { ...frameRawInput!, ...frameArgs! }
  const mergedFp = mergeArgsFingerprints(fpRaw, fpArgs)
  return mergedFp.kind === 'ok' && mergedFp.fingerprint
    ? { kind: 'present', args: merged, fingerprint: mergedFp.fingerprint }
    : { kind: 'conflict' }
}

export const TRAJECTORY_IDENTITY_KEYS = [
  'trajectoryId',
  'trajectory_id',
  'antigravity.google/trajectory_id',
  'root_trajectory_id',
  'antigravity.google/root_trajectory_id',
] as const

export const STEP_INDEX_KEYS = ['stepIdx', 'step_idx'] as const

export const SESSION_IDENTITY_KEYS = [
  'sessionId',
  'session_id',
  'antigravity.google/conversation_id',
  'conversation_id',
  'antigravity.google/root_conversation_id',
  'root_conversation_id',
] as const

export const EXECUTION_IDENTITY_KEYS = ['executionId', 'execution_id'] as const

export function extractSuppliedTrajectoryAndStepEvidence(
  containers: ReadonlyArray<Record<string, unknown> | undefined>,
): {
  readonly trajectoryId?: string
  readonly stepIdx?: number
  readonly contradicted: boolean
} {
  let trajectoryId: string | undefined
  let stepIdx: number | undefined
  let contradicted = false

  for (const container of containers) {
    if (!container) continue
    for (const key of TRAJECTORY_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || !isValidAgyTrajectoryId(raw)) {
        contradicted = true
        continue
      }
      if (trajectoryId !== undefined && trajectoryId !== raw) {
        contradicted = true
      } else {
        trajectoryId = raw
      }
    }
    for (const key of STEP_INDEX_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
        contradicted = true
        continue
      }
      if (stepIdx !== undefined && stepIdx !== raw) {
        contradicted = true
      } else {
        stepIdx = raw
      }
    }
  }

  return {
    ...(trajectoryId !== undefined ? { trajectoryId } : {}),
    ...(stepIdx !== undefined ? { stepIdx } : {}),
    contradicted,
  }
}

export function validateAgyFrame(
  ingress: Extract<AgyIngress, { kind: 'notification' | 'server_request' }>,
  expectedSessionId: string | undefined,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedAgyFrame {
  const message = ingress.message
  const method =
    ingress.kind === 'server_request'
      ? ingress.method
      : (asString(Reflect.get(message, 'method')) ?? '')
  const rawParams = Reflect.get(message, 'params')
  const params = isPlainObject(rawParams) ? rawParams : {}
  const rawParamsMeta = Reflect.get(params, '_meta')
  const paramsMeta = isPlainObject(rawParamsMeta) ? rawParamsMeta : undefined

  const isUpdate = ingress.kind === 'notification' && method === 'session/update'
  const isPermission = ingress.kind === 'server_request' && method === 'session/request_permission'
  const rawPayload = isUpdate
    ? Reflect.get(params, 'update')
    : isPermission
      ? Reflect.get(params, 'toolCall')
      : undefined
  const payload = isPlainObject(rawPayload) ? rawPayload : undefined
  const rawPayloadMeta = payload ? Reflect.get(payload, '_meta') : undefined
  const payloadMeta = isPlainObject(rawPayloadMeta) ? rawPayloadMeta : undefined
  const sessionUpdate = isUpdate && payload ? asString(payload.sessionUpdate) : undefined

  // 1. Full forensic session/root conversation identity check across params, payload, and _meta.
  let sawMatchingSessionId = false
  let sawForeignSessionId = false
  let sawMalformedSessionId = false
  if (rawParamsMeta !== undefined && !isPlainObject(rawParamsMeta)) {
    sawMalformedSessionId = true
  }
  if (payload && rawPayloadMeta !== undefined && !isPlainObject(rawPayloadMeta)) {
    sawMalformedSessionId = true
  }
  const suppliedSessionIds: string[] = []
  const sessionContainers: Array<Record<string, unknown> | undefined> = [
    params,
    paramsMeta,
    payload,
    payloadMeta,
  ]
  for (const container of sessionContainers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        sawMalformedSessionId = true
        continue
      }
      suppliedSessionIds.push(raw)
      if (expectedSessionId !== undefined) {
        if (raw === expectedSessionId) {
          sawMatchingSessionId = true
        } else {
          sawForeignSessionId = true
        }
      }
    }
  }
  for (let i = 1; i < suppliedSessionIds.length; i += 1) {
    if (suppliedSessionIds[i] !== suppliedSessionIds[0]) {
      sawMalformedSessionId = true
    }
  }
  const sessionAttribution: ValidatedAgyFrame['sessionAttribution'] = sawMalformedSessionId
    ? 'invalid_or_conflicting'
    : sawForeignSessionId && !sawMatchingSessionId
      ? 'pure_foreign'
      : sawForeignSessionId && sawMatchingSessionId
        ? 'invalid_or_conflicting'
        : sawMatchingSessionId
          ? 'matching'
          : 'absent'
  const isAttributableToCurrentSession =
    sessionAttribution === 'matching' || sessionAttribution === 'absent'
  const hasForeignOrInvalidSessionMeta =
    sessionAttribution === 'pure_foreign' || sessionAttribution === 'invalid_or_conflicting'

  // 2. Execution ID forensic extraction.
  let executionId: string | undefined
  let executionIdInvalid = false
  for (const container of [payload, payloadMeta, params, paramsMeta]) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        executionIdInvalid = true
        continue
      }
      if (executionId !== undefined && executionId !== raw) {
        executionIdInvalid = true
      } else {
        executionId = raw
      }
    }
  }

  // 3. Trajectory ID & Step Index forensic extraction across all containers.
  const trajStep = extractSuppliedTrajectoryAndStepEvidence([
    payload,
    payloadMeta,
    params,
    paramsMeta,
  ])

  // 4. Progress tokens: inspect EVERY container slot (never short-circuit with `??`)!
  const allCanonicalTokens: string[] = []
  let suppliedCount = 0
  let hasInvalidToken = false
  let hasConflictingTokens = false
  let firstParsedToken: CanonicalProgressToken | undefined
  for (const container of [payload, payloadMeta, params, paramsMeta]) {
    if (!container || !Object.hasOwn(container, 'progressToken')) continue
    const rawPt = container.progressToken
    if (rawPt === undefined) continue
    suppliedCount += 1
    const parsedPt = canonicalizeProgressToken(rawPt)
    if (!parsedPt) {
      hasInvalidToken = true
      continue
    }
    if (!allCanonicalTokens.includes(parsedPt.canonical)) {
      allCanonicalTokens.push(parsedPt.canonical)
    }
    if (parsedPt.structured?.hasLeadingZeros) {
      hasInvalidToken = true
    }
    if (firstParsedToken === undefined) {
      firstParsedToken = parsedPt
    } else if (firstParsedToken.canonical !== parsedPt.canonical) {
      hasConflictingTokens = true
    }
  }
  const resolvedToken =
    !hasInvalidToken && !hasConflictingTokens && firstParsedToken !== undefined
      ? firstParsedToken
      : undefined

  // 5. Intra-frame root consistency + pinned trajectory / minStepIdx check (BEFORE any pinning!).
  let rootEvidenceContradicted =
    trajStep.contradicted || executionIdInvalid || hasInvalidToken || hasConflictingTokens
  if (trajStep.trajectoryId !== undefined && pinnedTrajectory !== undefined) {
    if (trajStep.trajectoryId !== pinnedTrajectory) {
      rootEvidenceContradicted = true
    }
  }
  if (trajStep.stepIdx !== undefined && minStepIdx !== undefined) {
    if (trajStep.stepIdx < minStepIdx) {
      rootEvidenceContradicted = true
    }
  }
  if (resolvedToken?.structured) {
    if (
      trajStep.trajectoryId !== undefined &&
      resolvedToken.structured.trajectoryId !== trajStep.trajectoryId
    ) {
      rootEvidenceContradicted = true
    }
    if (trajStep.stepIdx !== undefined && resolvedToken.structured.stepIdx !== trajStep.stepIdx) {
      rootEvidenceContradicted = true
    }
    if (
      pinnedTrajectory !== undefined &&
      resolvedToken.structured.trajectoryId !== pinnedTrajectory
    ) {
      rootEvidenceContradicted = true
    }
    if (minStepIdx !== undefined && resolvedToken.structured.stepIdx < minStepIdx) {
      rootEvidenceContradicted = true
    }
  }
  // Even when a token is conflicted/leading-zero, check if any normalizable structured token conflicts
  // with trajectory/step to ensure full intra-frame contradiction detection.
  if (hasConflictingTokens || hasInvalidToken) {
    rootEvidenceContradicted = true
  }

  // 6. Tool call ID extraction.
  let toolCallId: string | undefined
  let toolCallIdInvalid = false
  if (payload) {
    const hasToolCallIdField =
      Object.hasOwn(payload, 'toolCallId') && payload.toolCallId !== undefined
    const hasIdField = Object.hasOwn(payload, 'id') && payload.id !== undefined
    const rawTcId = hasToolCallIdField ? payload.toolCallId : hasIdField ? payload.id : undefined
    if (rawTcId !== undefined) {
      if (
        typeof rawTcId !== 'string' ||
        rawTcId.length === 0 ||
        Buffer.byteLength(rawTcId, 'utf8') > AGY_MCP_MAX_TOOL_CALL_ID_BYTES
      ) {
        toolCallIdInvalid = true
      } else {
        toolCallId = rawTcId
      }
    }
    if (
      hasToolCallIdField &&
      hasIdField &&
      typeof payload.toolCallId === 'string' &&
      typeof payload.id === 'string' &&
      payload.toolCallId !== payload.id
    ) {
      toolCallIdInvalid = true
    }
  }

  // 7. Exact explicit tool name (strictly payload.name; NEVER display-only payload.kind!).
  let explicitToolName: string | undefined
  let explicitToolNameInvalid = false
  if (payload && Object.hasOwn(payload, 'name') && payload.name !== undefined) {
    if (typeof payload.name !== 'string' || payload.name.length === 0) {
      explicitToolNameInvalid = true
    } else {
      explicitToolName = payload.name.slice(0, 120)
    }
  }

  // 8. Tool status (checked on BOTH session/update AND session/request_permission!).
  const statusPresent = Boolean(
    payload && Object.hasOwn(payload, 'status') && payload.status !== undefined,
  )
  const status = statusPresent ? normalizeAcpToolStatus(payload!.status) : undefined
  const statusInvalid = statusPresent && status === undefined

  // 9. Args / rawInput forensic extraction (distinguish absent vs plain object vs explicit non-object!).
  const rawArgsPresent = Boolean(
    payload && Object.hasOwn(payload, 'args') && payload.args !== undefined,
  )
  const rawInputPresent = Boolean(
    payload && Object.hasOwn(payload, 'rawInput') && payload.rawInput !== undefined,
  )
  const frameArgs = rawArgsPresent && isPlainObject(payload!.args) ? payload!.args : undefined
  const frameRawInput =
    rawInputPresent && isPlainObject(payload!.rawInput) ? payload!.rawInput : undefined
  let argsEvidence: ValidatedAgyFrame['argsEvidence']
  if ((rawArgsPresent && !frameArgs) || (rawInputPresent && !frameRawInput)) {
    argsEvidence = { kind: 'invalid_or_conflict' }
  } else {
    const resolved = resolveFrameArgsEvidence(frameArgs, frameRawInput)
    argsEvidence =
      resolved.kind === 'none'
        ? { kind: 'absent' }
        : resolved.kind === 'present'
          ? { kind: 'present', args: resolved.args, fingerprint: resolved.fingerprint }
          : { kind: 'invalid_or_conflict' }
  }

  return {
    seq: ingress.seq,
    kind: ingress.kind,
    method,
    ...(ingress.kind === 'server_request' ? { rpcId: ingress.rpcId } : {}),
    message,
    params,
    payload,
    ...(sessionUpdate !== undefined ? { sessionUpdate } : {}),
    sessionAttribution,
    isAttributableToCurrentSession,
    hasForeignOrInvalidSessionMeta,
    ...(executionId !== undefined ? { executionId } : {}),
    executionIdInvalid,
    ...(trajStep.trajectoryId !== undefined ? { trajectoryId: trajStep.trajectoryId } : {}),
    ...(trajStep.stepIdx !== undefined ? { stepIdx: trajStep.stepIdx } : {}),
    rootEvidenceContradicted,
    tokens: {
      suppliedCount,
      allCanonicalTokens,
      hasInvalidToken,
      hasConflictingTokens,
      ...(resolvedToken !== undefined ? { resolvedToken } : {}),
    },
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    toolCallIdInvalid,
    ...(explicitToolName !== undefined ? { explicitToolName } : {}),
    explicitToolNameInvalid,
    ...(status !== undefined ? { status } : {}),
    statusPresent,
    statusInvalid,
    argsEvidence,
    rawArgsPresent,
    rawInputPresent,
    ...(frameArgs !== undefined ? { frameArgs } : {}),
    ...(frameRawInput !== undefined ? { frameRawInput } : {}),
  }
}

/**
 * Single-pass root-boundary recheck for staged pre-bind frames: reuses the already-validated
 * identity fields and argument fingerprint without re-parsing or re-hashing the raw frame.
 */
export function recheckValidatedFrameAgainstRootBoundary(
  validated: ValidatedAgyFrame,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedAgyFrame {
  if (validated.rootEvidenceContradicted) return validated
  let contradicted = false
  if (
    validated.trajectoryId !== undefined &&
    pinnedTrajectory !== undefined &&
    validated.trajectoryId !== pinnedTrajectory
  ) {
    contradicted = true
  }
  if (
    validated.stepIdx !== undefined &&
    minStepIdx !== undefined &&
    validated.stepIdx < minStepIdx
  ) {
    contradicted = true
  }
  const structured = validated.tokens.resolvedToken?.structured
  if (structured) {
    if (pinnedTrajectory !== undefined && structured.trajectoryId !== pinnedTrajectory) {
      contradicted = true
    }
    if (minStepIdx !== undefined && structured.stepIdx < minStepIdx) {
      contradicted = true
    }
  }
  if (!contradicted) return validated
  return { ...validated, rootEvidenceContradicted: true }
}

export type ParsedAgyPromptTerminalReply =
  | {
      readonly ok: true
      readonly stopReason: string
      readonly executionId?: string | undefined
    }
  | {
      readonly ok: false
      readonly reason: string
      readonly message: string
    }

export const AGY_MAX_EXECUTION_ID_BYTES = 256

/**
 * Extracts ONLY the public string `message` or bounded numeric `code` from a JSON-RPC
 * error object (discarding `data`, `headers`, and nested objects), then runs both
 * terminal failure sanitization and native permission text redaction.
 */
export function formatAgyRpcErrorMessage(rpcError: unknown, fallback: string): string {
  let rawText = ''
  if (typeof rpcError === 'string') {
    rawText = rpcError
  } else if (isPlainObject(rpcError)) {
    const msg = asString(rpcError.message)?.trim()
    const code = rpcError.code
    if (msg) {
      rawText = msg
    } else if (typeof code === 'number' && Number.isFinite(code)) {
      rawText = `Antigravity RPC error (${code}).`
    } else if (typeof code === 'string' && code.trim()) {
      rawText = `Antigravity RPC error (${code.trim().slice(0, 64)}).`
    }
  }
  const sanitized = safeNativePermissionText(
    sanitizeNativeTerminalFailure(rawText, 240),
    240,
  ).trim()
  return sanitized || fallback
}

export function parseAgyPromptTerminalReply(
  res: object | undefined,
  expectedSessionId: string | undefined,
): ParsedAgyPromptTerminalReply {
  const rpcError = res ? Reflect.get(res, 'error') : undefined
  const rpcResult = res ? Reflect.get(res, 'result') : undefined
  if (rpcError || !isPlainObject(rpcResult)) {
    return {
      ok: false,
      reason: 'Antigravity returned an invalid session/prompt response.',
      message: rpcError
        ? formatAgyRpcErrorMessage(rpcError, 'Antigravity returned a session/prompt error.')
        : 'Antigravity returned an invalid session/prompt result.',
    }
  }
  const rawStopReason = asString(rpcResult.stopReason)?.trim()
  if (!rawStopReason || !VALID_ACP_STOP_REASONS.has(rawStopReason)) {
    return {
      ok: false,
      reason: 'Antigravity returned a session/prompt result without a valid stopReason.',
      message: rawStopReason
        ? `Antigravity returned an unrecognized session/prompt stopReason "${safeNativePermissionText(rawStopReason, 80)}".`
        : 'Antigravity returned a session/prompt result without a stopReason.',
    }
  }
  const rawMeta: unknown = Object.hasOwn(rpcResult, '_meta')
    ? Reflect.get(rpcResult, '_meta')
    : undefined
  if (rawMeta !== undefined && !isPlainObject(rawMeta)) {
    return {
      ok: false,
      reason: 'Antigravity returned a session/prompt result with malformed _meta.',
      message: 'Antigravity returned a session/prompt result with malformed _meta.',
    }
  }
  const containers: Array<Record<string, unknown> | undefined> = [
    rpcResult,
    isPlainObject(rawMeta) ? rawMeta : undefined,
  ]
  let seenSessionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (typeof raw !== 'string' || raw.trim().length === 0) {
        return {
          ok: false,
          reason: 'Antigravity returned a session/prompt result with invalid session identity.',
          message: 'Antigravity returned a session/prompt result with invalid session identity.',
        }
      }
      if (expectedSessionId !== undefined && raw !== expectedSessionId) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result for a different native session identity.',
          message:
            'Antigravity returned a session/prompt result for a different native session identity.',
        }
      }
      if (seenSessionId !== undefined && seenSessionId !== raw) {
        return {
          ok: false,
          reason: 'Antigravity returned a session/prompt result with conflicting session aliases.',
          message: 'Antigravity returned a session/prompt result with conflicting session aliases.',
        }
      }
      seenSessionId = raw
    }
  }
  let executionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        Buffer.byteLength(raw, 'utf8') > AGY_MAX_EXECUTION_ID_BYTES
      ) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result with an invalid or oversized execution_id.',
          message:
            'Antigravity returned a session/prompt result with an invalid or oversized execution_id.',
        }
      }
      if (executionId !== undefined && executionId !== raw) {
        return {
          ok: false,
          reason:
            'Antigravity returned a session/prompt result with conflicting executionId / execution_id aliases.',
          message:
            'Antigravity returned a session/prompt result with conflicting executionId / execution_id aliases.',
        }
      }
      executionId = raw
    }
  }
  return {
    ok: true,
    stopReason: rawStopReason,
    ...(executionId !== undefined ? { executionId } : {}),
  }
}

export interface ValidatedBackgroundOwnership {
  readonly valid: boolean
  readonly executionId?: string | undefined
  readonly trajectoryId?: string | undefined
  readonly stepIdx?: number | undefined
}

export function validateBackgroundUpdateForRun(
  params: Record<string, unknown>,
  update: Record<string, unknown>,
  trackedRun: Pick<
    ActiveAgyRun,
    'nativeSessionId' | 'providerExecutionId' | 'knownForeignExecutionIds'
  >,
  pinnedTrajectory: string | undefined,
  minStepIdx: number | undefined,
): ValidatedBackgroundOwnership {
  const rawParamsMeta: unknown = Object.hasOwn(params, '_meta')
    ? Reflect.get(params, '_meta')
    : undefined
  const rawUpdateMeta: unknown = Object.hasOwn(update, '_meta')
    ? Reflect.get(update, '_meta')
    : undefined
  if (
    (rawParamsMeta !== undefined && !isPlainObject(rawParamsMeta)) ||
    (rawUpdateMeta !== undefined && !isPlainObject(rawUpdateMeta))
  ) {
    return { valid: false }
  }
  const paramsMeta = isPlainObject(rawParamsMeta) ? rawParamsMeta : undefined
  const updateMeta = isPlainObject(rawUpdateMeta) ? rawUpdateMeta : undefined
  const containers = [update, updateMeta, params, paramsMeta]
  for (const container of containers) {
    if (!container) continue
    for (const key of SESSION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        raw !== trackedRun.nativeSessionId
      ) {
        return { valid: false }
      }
    }
  }
  let executionId: string | undefined
  for (const container of containers) {
    if (!container) continue
    for (const key of EXECUTION_IDENTITY_KEYS) {
      if (!Object.hasOwn(container, key)) continue
      const raw = container[key]
      if (raw === undefined) continue
      if (
        typeof raw !== 'string' ||
        raw.trim().length === 0 ||
        Buffer.byteLength(raw, 'utf8') > AGY_MAX_EXECUTION_ID_BYTES
      ) {
        return { valid: false }
      }
      if (executionId !== undefined && executionId !== raw) {
        return { valid: false }
      }
      executionId = raw
    }
  }
  if (executionId !== undefined) {
    if (trackedRun.knownForeignExecutionIds.has(executionId)) {
      return { valid: false }
    }
    if (
      trackedRun.providerExecutionId !== undefined &&
      executionId !== trackedRun.providerExecutionId
    ) {
      return { valid: false }
    }
  }
  const trajStep = extractSuppliedTrajectoryAndStepEvidence(containers)
  if (trajStep.contradicted) {
    return { valid: false }
  }
  if (
    trajStep.trajectoryId !== undefined &&
    pinnedTrajectory !== undefined &&
    trajStep.trajectoryId !== pinnedTrajectory
  ) {
    return { valid: false }
  }
  if (trajStep.stepIdx !== undefined && minStepIdx !== undefined && trajStep.stepIdx < minStepIdx) {
    return { valid: false }
  }

  // Validate progressToken under the exact same rules as foreground frames.
  let firstParsedToken: CanonicalProgressToken | undefined
  for (const container of containers) {
    if (!container || !Object.hasOwn(container, 'progressToken')) continue
    const rawPt = container.progressToken
    if (rawPt === undefined) continue
    const parsedPt = canonicalizeProgressToken(rawPt)
    if (!parsedPt || parsedPt.structured?.hasLeadingZeros) {
      return { valid: false }
    }
    if (firstParsedToken === undefined) {
      firstParsedToken = parsedPt
    } else if (firstParsedToken.canonical !== parsedPt.canonical) {
      return { valid: false }
    }
  }
  if (firstParsedToken?.structured) {
    if (
      trajStep.trajectoryId !== undefined &&
      firstParsedToken.structured.trajectoryId !== trajStep.trajectoryId
    ) {
      return { valid: false }
    }
    if (
      trajStep.stepIdx !== undefined &&
      firstParsedToken.structured.stepIdx !== trajStep.stepIdx
    ) {
      return { valid: false }
    }
    if (
      pinnedTrajectory !== undefined &&
      firstParsedToken.structured.trajectoryId !== pinnedTrajectory
    ) {
      return { valid: false }
    }
    if (minStepIdx !== undefined && firstParsedToken.structured.stepIdx < minStepIdx) {
      return { valid: false }
    }
  }

  const effectiveTrajectoryId = trajStep.trajectoryId ?? firstParsedToken?.structured?.trajectoryId
  const effectiveStepIdx = trajStep.stepIdx ?? firstParsedToken?.structured?.stepIdx
  return {
    valid: true,
    ...(executionId !== undefined ? { executionId } : {}),
    ...(effectiveTrajectoryId !== undefined ? { trajectoryId: effectiveTrajectoryId } : {}),
    ...(effectiveStepIdx !== undefined ? { stepIdx: effectiveStepIdx } : {}),
  }
}

export interface CompactPostCutoffBackgroundRecord {
  readonly ownership: {
    readonly executionId?: string | undefined
    readonly trajectoryId?: string | undefined
    readonly stepIdx?: number | undefined
  }
  readonly sessionUpdate: string
  readonly status?: string | undefined
  readonly outOfTurn: boolean
  readonly taskId?: string | undefined
  readonly eventTaskId?: string | undefined
  readonly launchTaskId?: string | undefined
  readonly isDaemonLaunchMetadata: boolean
  readonly toolCallId?: string | undefined
  readonly explicitMsgId?: string | undefined
  readonly rawText?: string | undefined
}

export function buildCompactPostCutoffBackgroundRecord(
  update: Record<string, unknown>,
  ownership: ValidatedBackgroundOwnership,
): CompactPostCutoffBackgroundRecord | undefined {
  const sessionUpdate = asString(update.sessionUpdate)
  if (!sessionUpdate) return undefined
  const status = asString(update.status)
  const outOfTurn = update.outOfTurn === true
  const rawOutput = isPlainObject(update.rawOutput) ? update.rawOutput : undefined
  const rawArgs = isPlainObject(update.args)
    ? update.args
    : isPlainObject(update.rawInput)
      ? update.rawInput
      : undefined
  const toolName = asString(update.name ?? update.toolName)
  const eventTaskId = asString(update.taskId ?? update.backgroundTaskId)
  const launchTaskId = rawOutput
    ? asString(rawOutput.taskId ?? rawOutput.backgroundTaskId)
    : undefined
  const taskId = eventTaskId ?? launchTaskId
  const isDaemonLaunchMetadata =
    launchTaskId !== undefined ||
    (toolName === 'run_command' && rawArgs?.IsDaemon === true) ||
    toolName === 'schedule'
  const toolCallId = asString(update.toolCallId ?? update.id)
  const explicitMsgId = asString(update.messageId ?? update.stepId)
  const isOutOfTurnCompletion =
    (sessionUpdate === 'agent_message_chunk' && outOfTurn) ||
    sessionUpdate === 'background_task_completed' ||
    (sessionUpdate === 'tool_call_update' && status === 'completed' && outOfTurn)
  const rawText = isOutOfTurnCompletion
    ? isPlainObject(update.content)
      ? asString(update.content.text)
      : asString(update.text ?? update.summary)
    : undefined
  return {
    ownership: {
      ...(ownership.executionId !== undefined ? { executionId: ownership.executionId } : {}),
      ...(ownership.trajectoryId !== undefined ? { trajectoryId: ownership.trajectoryId } : {}),
      ...(ownership.stepIdx !== undefined ? { stepIdx: ownership.stepIdx } : {}),
    },
    sessionUpdate,
    ...(status !== undefined ? { status } : {}),
    outOfTurn,
    ...(taskId !== undefined ? { taskId } : {}),
    ...(eventTaskId !== undefined ? { eventTaskId } : {}),
    ...(launchTaskId !== undefined ? { launchTaskId } : {}),
    isDaemonLaunchMetadata,
    ...(toolCallId !== undefined ? { toolCallId } : {}),
    ...(explicitMsgId !== undefined ? { explicitMsgId } : {}),
    ...(rawText !== undefined ? { rawText } : {}),
  }
}

export function estimateCompactBackgroundRecordBytes(
  record: CompactPostCutoffBackgroundRecord,
): number {
  let bytes = 256
  const charge = (val: string | undefined): void => {
    if (val !== undefined) bytes += Buffer.byteLength(val, 'utf8') * 2 + 16
  }
  charge(record.ownership.executionId)
  charge(record.ownership.trajectoryId)
  charge(record.sessionUpdate)
  charge(record.status)
  charge(record.taskId)
  charge(record.toolCallId)
  charge(record.explicitMsgId)
  charge(record.rawText)
  return bytes
}

export type AcpMcpCallLifecycle = 'open' | 'completed' | 'failed' | 'revoked'

export interface ActiveAcpMcpCall {
  readonly toolCallId: string
  readonly toolName: string
  lifecycle: AcpMcpCallLifecycle
  sawPreTerminal: boolean
  promoted?: boolean | undefined
  trajectoryId?: string | undefined
  stepIdx?: number | undefined
  argsFingerprint: CompactArgsFingerprint | undefined
  explicitProgressToken: string | undefined
  correlatedProgressToken: string | undefined
  claimedViaTokenless?: boolean | undefined
  claimedHttpArgsFingerprint: CompactArgsFingerprint | undefined
}

export type TokenLedgerEntry =
  | { readonly kind: 'in_flight_http' }
  | { readonly kind: 'non_mcp' }
  | { readonly kind: 'claimed'; ownerKey: string }
  | { readonly kind: 'consumed' }

export interface ProvisionalTokenOwner {
  readonly toolName: string
  readonly httpFingerprint: CompactArgsFingerprint
}

export type StagedMcpOutcomeKind =
  | { type: 'title'; title: string }
  | {
      type: 'peer'
      targetAgentId: Exclude<RuntimeAgentId, 'agy'>
      proposalKind: 'supplement' | 'fact_check' | 'challenge' | 'review'
      reason?: string | undefined
    }
  | { type: 'review'; observation: CollaborationReviewObservation }
  | { type: 'input_result'; observation: CollaborationInputObservation }
  | { type: 'retain_plan' }
  | { type: 'publish_plan_chunk'; offset: number; byteLength: number; complete: boolean }

export interface StagedMcpOutcomeRecord {
  ownerKey: string
  readonly progressToken: string
  readonly httpFingerprint: CompactArgsFingerprint
  readonly kind: StagedMcpOutcomeKind
  readonly payloadBytes: number
}

export type PromotedMcpOutcome =
  | { type: 'title'; title: string }
  | {
      type: 'peer'
      targetAgentId: Exclude<RuntimeAgentId, 'agy'>
      proposalKind: 'supplement' | 'fact_check' | 'challenge' | 'review'
      reason?: string | undefined
    }
  | { type: 'review'; observation: CollaborationReviewObservation }
  | { type: 'input_result'; observation: CollaborationInputObservation }
  | { type: 'retain_plan' }
  | { type: 'publish_plan'; markdown: string; finalToolCallId: string }
  | { type: 'publish_plan_failed'; reason: string }

export function computePlanConversionWorkspaceBytes(totalPlanBytes: number): number {
  // Budget temporary merged UTF-8 buffer (`totalPlanBytes`) + worst-case UTF-16 decoded string (`totalPlanBytes * 2`) + header.
  return totalPlanBytes + totalPlanBytes * 2 + 64
}

export function computeRetainedPlanTextBytes(text: string): number {
  return text.length * 2 + 64
}

export interface PendingPlanChunk {
  ownerKey: string
  readonly offset: number
  readonly bytes: Buffer
  readonly hasNonWhitespace: boolean
  readonly complete: boolean
  confirmed: boolean
  confirmedToolCallId?: string | undefined
  invalidated: boolean
}

export function estimateStagedOutcomePayloadBytes(kind: StagedMcpOutcomeKind): number {
  switch (kind.type) {
    case 'title':
      return Buffer.byteLength(kind.title, 'utf8') + 32
    case 'peer':
      return (
        Buffer.byteLength(kind.targetAgentId, 'utf8') +
        Buffer.byteLength(kind.proposalKind, 'utf8') +
        (kind.reason ? Buffer.byteLength(kind.reason, 'utf8') : 0) +
        48
      )
    case 'review':
    case 'input_result':
      return Buffer.byteLength(JSON.stringify(kind.observation), 'utf8') + 32
    case 'retain_plan':
    case 'publish_plan_chunk':
      return 48
    default:
      return 48
  }
}

export type AcpToolCallAdmissionResult = 'admitted' | 'already_retired' | 'rejected_capacity'

export type RootProofCheckResult =
  | 'ok'
  | 'wait'
  | { readonly kind: 'reject'; readonly error: string }

export type HttpClaimAttempt =
  | { readonly kind: 'claimed'; readonly ownerKey: string }
  | { readonly kind: 'wait' }
  | { readonly kind: 'reject'; readonly error: string }
