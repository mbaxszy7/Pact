import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import {
  buildBoundedNativePlanId,
  COLLABORATION_PUBLISHED_PLAN_MAX_BYTES,
  collaborationPublishPlanInputSchema,
  encodeBoundedCollaborationIdentity,
  encodeBoundedOpenPlanCallKey,
  encodeBoundedOpenPlanProgressToken,
} from '@pact/contracts'

import { AgentExecutionError } from '../agent-execution-error'
import {
  AgyHotRollbackJournalError,
  AgyStorageMissingError,
  AgyTransientIdentityChurnError,
  assertIdentityNotCancelledOrExpired,
  MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
} from '../agy-sqlite-image'
import { projectCollaborationAnswer } from '../collaboration-answer'
import {
  AGY_MAX_HISTORY_BYTES,
  AGY_MAX_RECORDS,
  AGY_TEXT_BUDGET_BYTES,
  type AgyColdInspectionInput,
  type AgyColdInspectionResult,
  type AgyCompletedPactPublishPlanCall,
  type AgyConsumedInputReceipt,
  assertValidSessionUuid,
  collectAllowedAppDataRoots,
  CORTEX_STEP_STATUS_CANCELED,
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_STATUS_ERROR,
  CORTEX_STEP_STATUS_GENERATING,
  CORTEX_STEP_STATUS_INTERRUPTED,
  CORTEX_STEP_STATUS_INVALID,
  CORTEX_STEP_STATUS_PENDING,
  CORTEX_STEP_STATUS_QUEUED,
  CORTEX_STEP_STATUS_RUNNING,
  CORTEX_STEP_STATUS_WAITING,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  type DecodedAgyStep,
  type DecodedCortexStepMetadata,
  type DecodedExecutorMetadata,
  EXECUTOR_TERMINATION_REASON_INJECTED_RESPONSE,
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
  EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK,
  EXECUTOR_TERMINATION_REASON_TERMINAL_STEP_TYPE,
  EXECUTOR_TERMINATION_REASON_UNSPECIFIED,
  EXECUTOR_TERMINATION_REASON_USER_CANCELED,
  isInsideDirectory,
  isPlainObject,
  parseLocalFileUriOrPath,
  quoteSqlIdentifier,
  readExactBoundedBytesFromFd,
  resolveStorageRoot,
  SAFE_ID_PATTERN,
  sha256Hex,
  statsMatch,
  verifySafeDirectoryChainIfPresent,
} from './constants-and-types'
import {
  assertCompatibleStepRowFormat,
  decodeAgyStep,
  decodeCortexStepMetadata,
  decodeExecutorMetadata,
  extractEffectiveStepMetadata,
  extractPactPromptIdentity,
  readBoundedStepMetadataAndUserIdentity,
} from './cortex-codec'
import { decodeUtf8Strict } from './protobuf-wire'
import { type CommittedSqliteSnapshotHandle, openCommittedSqliteSnapshot } from './sqlite-snapshot'
import { measureTableColumnsTotalBytes, validateTrajectoryDatabase } from './sqlite-validator'

interface ParsedArtifactStepOp {
  stepIndex: number
  executionId: string
  nativeId: string
  toolName: 'write_file' | 'edit_file'
  filePath: string
  hasArtifactMetadata: boolean
  completed: boolean
  content?: string
  append?: boolean
  target?: string
  replacement?: string
}

function resolveBrainMarkdownPath(
  rawPathOrUri: string,
  canonicalAppDataDir: string,
  sessionId: string,
  configuredAppDataDir?: string,
): string | undefined {
  const parsedPath = parseLocalFileUriOrPath(rawPathOrUri)
  if (!parsedPath) return undefined
  const resolvedCandidate = resolve(parsedPath.rawPath)
  const dir = dirname(resolvedCandidate)
  const name = basename(resolvedCandidate)
  if (
    !name.toLowerCase().endsWith('.md') ||
    name.startsWith('.') ||
    name.length > 255 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    return undefined
  }
  const allowedRoots = collectAllowedAppDataRoots(canonicalAppDataDir, configuredAppDataDir)
  const matchesSessionBrainLexically = allowedRoots.some(
    (root) => dir === join(root, 'brain', sessionId),
  )
  if (!matchesSessionBrainLexically) {
    return undefined
  }
  // Always walk and lstat + realpath-verify brain/<sessionId> (never skipping via lexical shortcut).
  const verifiedBrain = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sessionId],
    'Antigravity brain',
  )
  if (!verifiedBrain.exists) return undefined
  return join(verifiedBrain.canonicalDir, name)
}

function parseArtifactOperationFromStep(
  stepIndex: number,
  rowStatus: number,
  decodedStep: DecodedAgyStep,
  meta: DecodedCortexStepMetadata,
  canonicalAppDataDir: string,
  sessionId: string,
  configuredAppDataDir?: string,
): ParsedArtifactStepOp | undefined {
  const call = meta.modifiedToolCall ?? meta.toolCall
  let toolName: string | undefined = call?.name
  let argsRecord: Record<string, unknown> | undefined

  if (call?.argumentsJson) {
    try {
      const parsed: unknown = JSON.parse(call.argumentsJson)
      if (isPlainObject(parsed)) argsRecord = parsed
    } catch {
      return undefined
    }
  } else if (decodedStep.genericArgs && decodedStep.genericArgs.size > 0) {
    const entries: Record<string, unknown> = {}
    for (const [key, value] of decodedStep.genericArgs) {
      entries[key] = value
    }
    if ('Content' in entries || 'content' in entries) toolName ??= 'write_file'
    else if ('Replacement' in entries || 'Target' in entries) toolName ??= 'edit_file'
    argsRecord = entries
  }

  if (toolName !== 'write_file' && toolName !== 'edit_file') return undefined
  const rawPath =
    (typeof argsRecord?.['Path'] === 'string' ? argsRecord['Path'] : undefined) ??
    (typeof argsRecord?.['path'] === 'string' ? argsRecord['path'] : undefined) ??
    (typeof argsRecord?.['TargetFile'] === 'string' ? argsRecord['TargetFile'] : undefined) ??
    (typeof argsRecord?.['targetFile'] === 'string' ? argsRecord['targetFile'] : undefined) ??
    decodedStep.writeToFileUri
  if (!rawPath) return undefined

  const resolvedBrainMd = resolveBrainMarkdownPath(
    rawPath,
    canonicalAppDataDir,
    sessionId,
    configuredAppDataDir,
  )
  if (!resolvedBrainMd) return undefined

  const rawArtifactMeta =
    argsRecord?.['ArtifactMetadata'] ??
    argsRecord?.['artifactMetadata'] ??
    argsRecord?.['artifact_metadata']
  let hasArtifactMetadata = isPlainObject(rawArtifactMeta)
  if (
    !hasArtifactMetadata &&
    typeof rawArtifactMeta === 'string' &&
    rawArtifactMeta.trim().startsWith('{')
  ) {
    try {
      hasArtifactMetadata = isPlainObject(JSON.parse(rawArtifactMeta))
    } catch {
      hasArtifactMetadata = false
    }
  }

  const completed =
    rowStatus === CORTEX_STEP_STATUS_DONE &&
    decodedStep.status === CORTEX_STEP_STATUS_DONE &&
    !decodedStep.hasError &&
    !decodedStep.genericHasError

  const rawPlanSuffixId = call?.id || meta.stepId || `step:${stepIndex}`
  const nativeId = buildBoundedNativePlanId(sessionId, rawPlanSuffixId)
  const content =
    typeof argsRecord?.['Content'] === 'string'
      ? argsRecord['Content']
      : typeof argsRecord?.['content'] === 'string'
        ? argsRecord['content']
        : undefined
  const append =
    argsRecord?.['Append'] === true ||
    argsRecord?.['append'] === true ||
    argsRecord?.['Append'] === 'true'
  const target =
    typeof argsRecord?.['Target'] === 'string'
      ? argsRecord['Target']
      : typeof argsRecord?.['target'] === 'string'
        ? argsRecord['target']
        : typeof argsRecord?.['TargetContent'] === 'string'
          ? argsRecord['TargetContent']
          : typeof argsRecord?.['targetContent'] === 'string'
            ? argsRecord['targetContent']
            : undefined
  const replacement =
    typeof argsRecord?.['Replacement'] === 'string'
      ? argsRecord['Replacement']
      : typeof argsRecord?.['replacement'] === 'string'
        ? argsRecord['replacement']
        : typeof argsRecord?.['ReplacementContent'] === 'string'
          ? argsRecord['ReplacementContent']
          : typeof argsRecord?.['replacementContent'] === 'string'
            ? argsRecord['replacementContent']
            : undefined

  return {
    stepIndex,
    executionId: meta.executionId ?? '',
    nativeId,
    toolName,
    filePath: resolvedBrainMd,
    hasArtifactMetadata,
    completed,
    ...(content !== undefined ? { content } : {}),
    ...(append ? { append: true } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
  }
}

function readVerifiedBrainMarkdownFile(
  filePath: string,
  canonicalAppDataDir: string,
  sessionId: string,
): string {
  const verifiedBrainBefore = verifySafeDirectoryChainIfPresent(
    canonicalAppDataDir,
    ['brain', sessionId],
    'Antigravity brain',
  )
  if (!verifiedBrainBefore.exists) {
    throw Object.assign(new Error('Antigravity session brain directory is missing.'), {
      code: 'ENOENT',
    })
  }
  const leafName = basename(filePath)
  const expectedPath = join(verifiedBrainBefore.canonicalDir, leafName)
  if (
    resolve(filePath) !== expectedPath ||
    leafName === '.' ||
    leafName === '..' ||
    leafName.includes('/') ||
    leafName.includes('\\')
  ) {
    throw new Error('Antigravity plan artifact escaped its pinned session brain directory.')
  }
  const before = lstatSync(expectedPath, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error('Antigravity plan artifact is linked or not an ordinary file.')
  }
  if (before.size > BigInt(AGY_TEXT_BUDGET_BYTES)) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity plan artifact exceeds its 8 MiB read budget.',
      false,
    )
  }
  const canonicalPath = realpathSync(expectedPath)
  if (
    canonicalPath !== expectedPath ||
    !isInsideDirectory(verifiedBrainBefore.canonicalDir, canonicalPath)
  ) {
    throw new Error('Antigravity plan artifact escaped its pinned session brain directory.')
  }
  const fd = openSync(expectedPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    const verifiedBrainAfter = verifySafeDirectoryChainIfPresent(
      canonicalAppDataDir,
      ['brain', sessionId],
      'Antigravity brain',
    )
    if (
      !verifiedBrainAfter.exists ||
      verifiedBrainAfter.canonicalDir !== verifiedBrainBefore.canonicalDir ||
      verifiedBrainAfter.stat.dev !== verifiedBrainBefore.stat.dev ||
      verifiedBrainAfter.stat.ino !== verifiedBrainBefore.stat.ino ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !statsMatch(before, opened) ||
      realpathSync(expectedPath) !== expectedPath
    ) {
      throw new Error('Antigravity plan artifact changed while opening.')
    }
    const bytes = readExactBoundedBytesFromFd(fd, Number(opened.size))
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(expectedPath, { bigint: true })
    if (
      BigInt(bytes.byteLength) !== before.size ||
      !statsMatch(before, after) ||
      !statsMatch(before, namedAfter)
    ) {
      throw new Error('Antigravity plan artifact changed during inspection.')
    }
    return decodeUtf8Strict(bytes)
  } finally {
    closeSync(fd)
  }
}

function evaluateColdPlanArtifact(
  ops: readonly ParsedArtifactStepOp[],
  targetExecutionId: string,
  canonicalAppDataDir: string,
  sessionId: string,
): { plan?: { nativeId: string; text: string }; planUnavailable?: true } {
  const boundPaths = new Set<string>()
  const simulatedBodies = new Map<string, { text: string; byteLength: number; complete: boolean }>()

  const targetOps: ParsedArtifactStepOp[] = []
  const postTargetTouchedPaths = new Set<string>()
  let seenTargetExecution = false

  for (const op of ops) {
    const isTarget = op.executionId === targetExecutionId
    if (isTarget) seenTargetExecution = true

    const bindsArtifact =
      op.hasArtifactMetadata ||
      boundPaths.has(op.filePath) ||
      (op.toolName === 'edit_file' &&
        basename(op.filePath).toLowerCase() === 'implementation_plan.md')
    if (!bindsArtifact) continue
    boundPaths.add(op.filePath)

    if (seenTargetExecution && !isTarget) {
      postTargetTouchedPaths.add(op.filePath)
      continue
    }

    if (isTarget) targetOps.push(op)

    if (!op.completed) {
      simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      continue
    }

    if (op.toolName === 'write_file') {
      if (op.content === undefined) {
        simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      } else if (op.append) {
        const previous = simulatedBodies.get(op.filePath)
        const contentBytes = Buffer.byteLength(op.content, 'utf8')
        if (
          !previous ||
          !previous.complete ||
          previous.byteLength + contentBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
        ) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          const nextText = `${previous.text}${op.content}`
          const nextBytes = Buffer.byteLength(nextText, 'utf8')
          if (nextBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
            simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
          } else {
            simulatedBodies.set(op.filePath, {
              text: nextText,
              byteLength: nextBytes,
              complete: true,
            })
          }
        }
      } else {
        const contentBytes = Buffer.byteLength(op.content, 'utf8')
        if (contentBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          simulatedBodies.set(op.filePath, {
            text: op.content,
            byteLength: contentBytes,
            complete: true,
          })
        }
      }
    } else {
      const previous = simulatedBodies.get(op.filePath)
      if (!previous || !previous.complete || !op.target || op.replacement === undefined) {
        simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
      } else {
        let matchCount = 0
        let searchFrom = 0
        for (;;) {
          const found = previous.text.indexOf(op.target, searchFrom)
          if (found < 0) break
          matchCount += 1
          searchFrom = found + op.target.length
        }
        const targetBytes = Buffer.byteLength(op.target, 'utf8')
        const replacementBytes = Buffer.byteLength(op.replacement, 'utf8')
        const projectedBytes = previous.byteLength + matchCount * (replacementBytes - targetBytes)
        if (
          matchCount === 0 ||
          projectedBytes < 0 ||
          projectedBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES
        ) {
          simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
        } else {
          const literalReplacement = op.replacement
          const nextText = previous.text.replaceAll(op.target, () => literalReplacement)
          const nextBytes = Buffer.byteLength(nextText, 'utf8')
          if (nextBytes > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
            simulatedBodies.set(op.filePath, { text: '', byteLength: 0, complete: false })
          } else {
            simulatedBodies.set(op.filePath, {
              text: nextText,
              byteLength: nextBytes,
              complete: true,
            })
          }
        }
      }
    }
  }

  if (targetOps.length === 0) return {}
  if (targetOps.some((op) => !op.completed)) return { planUnavailable: true }

  const distinctTargetPaths = new Set(targetOps.map((op) => op.filePath))
  if (distinctTargetPaths.size !== 1) return { planUnavailable: true }

  const lastOp = targetOps.at(-1)!
  if (postTargetTouchedPaths.has(lastOp.filePath)) return { planUnavailable: true }

  // Require a completely replayable baseline (no partial/substring or empty-replacement bypass).
  const simulated = simulatedBodies.get(lastOp.filePath)
  if (!simulated?.complete || simulated.byteLength > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES) {
    return { planUnavailable: true }
  }

  let diskText: string
  try {
    diskText = readVerifiedBrainMarkdownFile(lastOp.filePath, canonicalAppDataDir, sessionId)
  } catch {
    return { planUnavailable: true }
  }
  if (
    !diskText ||
    Buffer.byteLength(diskText, 'utf8') > COLLABORATION_PUBLISHED_PLAN_MAX_BYTES ||
    diskText !== simulated.text
  ) {
    return { planUnavailable: true }
  }

  return { plan: { nativeId: lastOp.nativeId, text: diskText } }
}

const PACT_PUBLISH_PLAN_NAME_RE =
  /^(?:mcp_(pact_peer_[a-f0-9]{16,32})_|mcp__(pact_peer_[a-f0-9]{16,32})__|(pact_peer_[a-f0-9]{16,32})\/)publish_plan$/u

const MAX_PACT_PUBLISH_PLAN_RAW_ID_BYTES = 1024

function normalizePublishPlanRawId(raw: unknown): string | undefined {
  const normalized =
    typeof raw === 'string'
      ? raw.trim()
      : typeof raw === 'number' && Number.isSafeInteger(raw)
        ? String(raw)
        : ''
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > MAX_PACT_PUBLISH_PLAN_RAW_ID_BYTES
  ) {
    return undefined
  }
  return normalized
}

function extractCompletedPactPublishPlanStepCall(
  meta: DecodedCortexStepMetadata,
  rowStatus: number,
  decodedStep: DecodedAgyStep,
  columnPayloadMatches: boolean,
): { readonly call: AgyCompletedPactPublishPlanCall; readonly legacyTokens: string[] } | undefined {
  if (
    !columnPayloadMatches ||
    rowStatus !== CORTEX_STEP_STATUS_DONE ||
    decodedStep.status !== CORTEX_STEP_STATUS_DONE ||
    decodedStep.hasError ||
    decodedStep.genericHasError
  ) {
    return undefined
  }
  const call = meta.modifiedToolCall ?? meta.toolCall
  if (!call?.name) {
    return undefined
  }
  const nameMatch = PACT_PUBLISH_PLAN_NAME_RE.exec(call.name)
  const serverName = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3]
  if (!serverName) {
    return undefined
  }
  if (!call.argumentsJson) {
    return undefined
  }
  let argsRecord: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(call.argumentsJson)
    if (!isPlainObject(parsed)) return undefined
    argsRecord = parsed
  } catch {
    return undefined
  }
  const nestedMeta = argsRecord['_meta']
  const { _meta: _ignoredMeta, ...toolArgs } = argsRecord
  const parsedArgs = collaborationPublishPlanInputSchema.safeParse(toolArgs)
  if (!parsedArgs.success) {
    return undefined
  }
  const complete = parsedArgs.data.complete ?? parsedArgs.data.offset === undefined
  if (!complete) {
    return undefined
  }

  const rawCallId = normalizePublishPlanRawId(call.id)
  const rawProgressToken = isPlainObject(nestedMeta)
    ? normalizePublishPlanRawId(nestedMeta['progressToken'])
    : undefined
  const rawStepId = normalizePublishPlanRawId(meta.stepId)

  const callId =
    rawCallId !== undefined ? encodeBoundedOpenPlanCallKey(`call:${rawCallId}`) : undefined
  const progressToken =
    rawProgressToken !== undefined
      ? encodeBoundedOpenPlanProgressToken(rawProgressToken)
      : undefined
  const stepId = rawStepId !== undefined ? encodeBoundedCollaborationIdentity(rawStepId) : undefined

  const legacyTokens: string[] = []
  const pushLegacyToken = (token: string | undefined): void => {
    if (!token || legacyTokens.includes(token)) return
    legacyTokens.push(token)
  }
  if (rawCallId !== undefined) {
    pushLegacyToken(rawCallId.length <= 256 ? rawCallId : callId)
  }
  pushLegacyToken(progressToken)
  pushLegacyToken(stepId)

  return {
    call: {
      serverName,
      ...(callId !== undefined ? { callId } : {}),
      ...(progressToken !== undefined ? { progressToken } : {}),
      ...(stepId !== undefined ? { stepId } : {}),
    },
    legacyTokens,
  }
}

export function inspectAgyTrajectory(input: AgyColdInspectionInput): AgyColdInspectionResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  assertValidSessionUuid(input.nativeSessionId)
  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const defaultPath = join(configuredRoot, 'conversations', `${input.nativeSessionId}.db`)

  let canonicalRoot: string
  try {
    const rootStat = lstatSync(configuredRoot, { bigint: true })
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error('Antigravity native storage root must be an ordinary directory.')
    }
    canonicalRoot = realpathSync(configuredRoot)
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      return {
        exists: false,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: configuredRoot,
        nativePath: defaultPath,
        stepCount: 0,
      }
    }
    throw error
  }

  const dbPath = join(canonicalRoot, 'conversations', `${input.nativeSessionId}.db`)
  let snapshotHandle: CommittedSqliteSnapshotHandle
  try {
    snapshotHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (error instanceof AgyStorageMissingError) {
      return {
        exists: false,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: canonicalRoot,
        nativePath: dbPath,
        stepCount: 0,
      }
    }
    if (
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyTransientIdentityChurnError
    ) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        nativeStorageRoot: canonicalRoot,
        nativePath: dbPath,
        stepCount: 0,
      }
    }
    throw error
  }
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)

    const counts = db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!

    if (counts.stepCount + counts.genCount + counts.execCount > AGY_MAX_RECORDS) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity trajectory exceeds its 10,000-record inspection budget.',
        false,
      )
    }

    if (!input.nativeTurnId) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    if (!SAFE_ID_PATTERN.test(input.nativeTurnId)) {
      throw new Error('Invalid Antigravity execution_id.')
    }

    // Enforce executor_metadata BLOB budget BEFORE hydration, while streaming steps
    // per-execution instead of charging all historical turns against the 8 MiB text budget.
    const preflightExecBytes = measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightExecBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity executor_metadata exceeds read budget.',
        false,
      )
    }

    let totalExecBytes = 0
    const execStmt = db.prepare<[], { idx: number; data: Buffer }>(
      'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
    )
    const execByExecutionId = new Map<string, DecodedExecutorMetadata>()
    for (const row of execStmt.iterate()) {
      if (!Buffer.isBuffer(row.data)) throw new Error('Invalid executor_metadata.data BLOB.')
      totalExecBytes += row.data.byteLength
      if (totalExecBytes > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity executor_metadata exceeds read budget.',
          false,
        )
      }
      const decoded = decodeExecutorMetadata(row.data)
      if (decoded.executionId) {
        if (execByExecutionId.has(decoded.executionId)) {
          throw new Error('Duplicate executor_metadata rows found for execution_id.')
        }
        execByExecutionId.set(decoded.executionId, decoded)
      }
    }

    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const headerSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, metadata, typeof(${stepPayloadSql}) AS payload_type, LENGTH(${stepPayloadSql}) AS payload_len, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, metadata, typeof(${stepPayloadSql}) AS payload_type, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" ORDER BY idx ASC`
    const headerStmt = db.prepare<
      [],
      {
        idx: number
        step_type: number
        status: number
        metadata: Buffer | null
        payload_type: string
        payload_len: number | null
        step_format?: unknown
      }
    >(headerSelectSql)

    const fullStepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" WHERE idx = ?`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" WHERE idx = ?`
    const fullStepByIdxStmt = db.prepare<
      [number],
      {
        idx: number
        step_type: number
        status: number
        has_subtrajectory: number
        metadata: Buffer | null
        step_blob: Buffer | null
        step_format?: unknown
      }
    >(fullStepSelectSql)

    const artifactOps: ParsedArtifactStepOp[] = []
    let retainedArtifactOpBytes = 0
    const seenStepExecutionIds = new Set<string>()
    const stepExecutionIds: Array<string | undefined> = []
    const stepPayloadLengths: number[] = []
    const rootUserSeenExecutions = new Set<string>()
    const pactRunMatchedExecutions = new Set<string>()

    let expectedIdx = 0
    for (const row of headerStmt.iterate()) {
      if ((expectedIdx & 0x3f) === 0) {
        assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      }
      if (row.idx !== expectedIdx) {
        throw new Error('Antigravity steps table has a non-contiguous step index gap.')
      }
      assertCompatibleStepRowFormat(row.step_format, schema.hasStepFormatColumn, row.idx)
      if (
        row.payload_type !== 'blob' ||
        typeof row.payload_len !== 'number' ||
        row.payload_len < 0
      ) {
        throw new Error(
          `Antigravity step ${row.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
        )
      }
      if ((row.metadata?.byteLength ?? 0) > AGY_TEXT_BUDGET_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
          false,
        )
      }

      const columnMeta =
        row.metadata && row.metadata.length > 0 ? decodeCortexStepMetadata(row.metadata) : undefined
      const isUserInput = row.step_type === CORTEX_STEP_TYPE_USER_INPUT
      const needsPayloadMeta = !columnMeta?.executionId

      let execId: string | undefined
      if (isUserInput || needsPayloadMeta) {
        if (row.payload_len > AGY_MAX_HISTORY_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity steps exceed the 32 MiB history budget.',
            false,
          )
        }
        const bounded =
          row.payload_len > 0
            ? readBoundedStepMetadataAndUserIdentity(
                db,
                stepPayloadSql,
                row.idx,
                row.payload_len,
                isUserInput,
                { bytes: AGY_TEXT_BUDGET_BYTES },
              )
            : {}
        const payloadMeta = bounded.payloadMeta
        if (!columnMeta && !payloadMeta) {
          throw new Error('Antigravity step is missing CortexStepMetadata.')
        }
        if (
          columnMeta?.executionId &&
          payloadMeta?.executionId &&
          columnMeta.executionId !== payloadMeta.executionId
        ) {
          throw new Error(
            'Antigravity step column metadata and payload metadata execution_id disagree.',
          )
        }
        if (columnMeta?.stepId && payloadMeta?.stepId && columnMeta.stepId !== payloadMeta.stepId) {
          throw new Error('Antigravity step column metadata and payload metadata step_id disagree.')
        }
        execId = columnMeta?.executionId ?? payloadMeta?.executionId
        if (
          isUserInput &&
          bounded.stepType === CORTEX_STEP_TYPE_USER_INPUT &&
          bounded.hasUserInput
        ) {
          const pactRunId = bounded.userIdentity?.pactRunId
          if (execId && !rootUserSeenExecutions.has(execId)) {
            rootUserSeenExecutions.add(execId)
            if (pactRunId === input.nativeTurnId) {
              pactRunMatchedExecutions.add(execId)
            }
          } else if (execId && pactRunId === input.nativeTurnId) {
            throw new Error('Antigravity non-root user input unexpectedly carries root pactRunId.')
          }
        }
      } else {
        execId = columnMeta.executionId
      }

      stepExecutionIds.push(execId)
      stepPayloadLengths.push(row.payload_len)
      if (execId) {
        seenStepExecutionIds.add(execId)
      }

      if (input.includePlan) {
        const colCall = columnMeta?.modifiedToolCall ?? columnMeta?.toolCall
        let isPlanCandidate = false
        if (colCall !== undefined) {
          if (colCall.name === 'write_file' || colCall.name === 'edit_file') {
            if (!colCall.argumentsJson) {
              isPlanCandidate = true
            } else {
              let parsedArgs: unknown
              try {
                parsedArgs = JSON.parse(colCall.argumentsJson)
              } catch {
                parsedArgs = undefined
              }
              if (isPlainObject(parsedArgs)) {
                const rawPath =
                  (typeof parsedArgs['Path'] === 'string' ? parsedArgs['Path'] : undefined) ??
                  (typeof parsedArgs['path'] === 'string' ? parsedArgs['path'] : undefined) ??
                  (typeof parsedArgs['TargetFile'] === 'string'
                    ? parsedArgs['TargetFile']
                    : undefined) ??
                  (typeof parsedArgs['targetFile'] === 'string'
                    ? parsedArgs['targetFile']
                    : undefined)
                isPlanCandidate =
                  rawPath === undefined ||
                  resolveBrainMarkdownPath(
                    rawPath,
                    canonicalRoot,
                    input.nativeSessionId,
                    configuredRoot,
                  ) !== undefined
              }
            }
          }
        } else {
          isPlanCandidate =
            row.step_type !== CORTEX_STEP_TYPE_USER_INPUT &&
            row.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE
        }
        if (isPlanCandidate) {
          if (row.payload_len > AGY_MAX_HISTORY_BYTES) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity steps exceed the 32 MiB history budget.',
              false,
            )
          }
          const fullRow = fullStepByIdxStmt.get(row.idx)
          if (!fullRow || !Buffer.isBuffer(fullRow.step_blob)) {
            throw new Error(
              `Antigravity step ${row.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
            )
          }
          const decodedStep = decodeAgyStep(fullRow.step_blob)
          let stepImageBytes = 0
          if (decodedStep.userInput) {
            for (const media of decodedStep.userInput.media) {
              stepImageBytes += media.inlineData?.byteLength ?? 0
            }
          }
          if (
            fullRow.step_blob.byteLength + (fullRow.metadata?.byteLength ?? 0) - stepImageBytes >
            AGY_TEXT_BUDGET_BYTES
          ) {
            throw new AgentExecutionError(
              'response_too_large',
              'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
              false,
            )
          }
          const columnPayloadMatches =
            decodedStep.type === fullRow.step_type && decodedStep.status === fullRow.status
          const meta = extractEffectiveStepMetadata(fullRow.metadata, decodedStep)
          if (columnPayloadMatches) {
            const parsedOp = parseArtifactOperationFromStep(
              fullRow.idx,
              fullRow.status,
              decodedStep,
              meta,
              canonicalRoot,
              input.nativeSessionId,
              configuredRoot,
            )
            if (parsedOp) {
              retainedArtifactOpBytes +=
                Buffer.byteLength(parsedOp.executionId, 'utf8') +
                Buffer.byteLength(parsedOp.nativeId, 'utf8') +
                Buffer.byteLength(parsedOp.filePath, 'utf8') +
                Buffer.byteLength(parsedOp.content ?? '', 'utf8') +
                Buffer.byteLength(parsedOp.target ?? '', 'utf8') +
                Buffer.byteLength(parsedOp.replacement ?? '', 'utf8') +
                128
              if (retainedArtifactOpBytes > AGY_TEXT_BUDGET_BYTES) {
                throw new AgentExecutionError(
                  'response_too_large',
                  'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
                  false,
                )
              }
              artifactOps.push(parsedOp)
            }
          }
        }
      }

      expectedIdx += 1
    }

    if (pactRunMatchedExecutions.size > 1) {
      throw new Error('Multiple Antigravity executions match pactRunId; failing closed.')
    }
    const directExecMatch =
      execByExecutionId.has(input.nativeTurnId) || seenStepExecutionIds.has(input.nativeTurnId)
        ? input.nativeTurnId
        : undefined
    const pactRunExecMatch =
      pactRunMatchedExecutions.size === 1 ? [...pactRunMatchedExecutions][0] : undefined
    if (directExecMatch && pactRunExecMatch && directExecMatch !== pactRunExecMatch) {
      throw new Error(
        'Antigravity trajectory has conflicting direct execution_id and pactRunId matches.',
      )
    }
    const resolvedExecutionId = directExecMatch ?? pactRunExecMatch

    if (!resolvedExecutionId) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const matchedExec = execByExecutionId.get(resolvedExecutionId)
    const lastStepIdx = matchedExec?.lastStepIdx
    const targetStepIndices: number[] = []
    for (let idx = 0; idx < expectedIdx; idx += 1) {
      if (stepExecutionIds[idx] === resolvedExecutionId || idx === lastStepIdx) {
        targetStepIndices.push(idx)
      }
    }

    const consumedInputs: AgyConsumedInputReceipt[] = []
    const plannerItems: Array<{ id: string; text: string }> = []
    let retainedPlannerBytes = 0
    let hasCompletedPactPublishPlan = false
    const completedPactPublishPlanTokens: string[] = []
    const completedPactPublishPlanCalls: AgyCompletedPactPublishPlanCall[] = []
    let seenExecutionSteps = 0
    let maxSeenExecutionStepIdx = -1
    let hasActiveStep = false
    let hasCanceledStep = false
    let hasFailedCoreStep = false
    let hasMetadataContradiction = false
    let lastStepSummary:
      | {
          readonly columnPayloadMatches: boolean
          readonly executionId: string | undefined
          readonly status: number
          readonly decodedStatus: number
          readonly hasError: boolean
          readonly genericHasError: boolean
        }
      | undefined

    for (let pos = 0; pos < targetStepIndices.length; pos += 1) {
      if ((pos & 0x3f) === 0) {
        assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      }
      const idx = targetStepIndices[pos]!
      const payloadLen = stepPayloadLengths[idx] ?? 0
      if (payloadLen > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity steps exceed the 32 MiB history budget.',
          false,
        )
      }
      const fullRow = fullStepByIdxStmt.get(idx)
      if (!fullRow || !Buffer.isBuffer(fullRow.step_blob)) {
        throw new Error(`Antigravity step ${idx} is missing its ${schema.stepPayloadColumn} BLOB.`)
      }
      const decodedStep = decodeAgyStep(fullRow.step_blob)
      let stepImageBytes = 0
      if (decodedStep.userInput) {
        for (const media of decodedStep.userInput.media) {
          stepImageBytes += media.inlineData?.byteLength ?? 0
        }
      }
      if (
        fullRow.step_blob.byteLength + (fullRow.metadata?.byteLength ?? 0) - stepImageBytes >
        AGY_TEXT_BUDGET_BYTES
      ) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
          false,
        )
      }
      const columnPayloadMatches =
        decodedStep.type === fullRow.step_type && decodedStep.status === fullRow.status
      const meta = extractEffectiveStepMetadata(fullRow.metadata, decodedStep)

      if (idx === lastStepIdx) {
        lastStepSummary = {
          columnPayloadMatches,
          executionId: meta.executionId,
          status: fullRow.status,
          decodedStatus: decodedStep.status,
          hasError: decodedStep.hasError,
          genericHasError: decodedStep.genericHasError,
        }
      }
      if (meta.executionId !== resolvedExecutionId) continue

      seenExecutionSteps += 1
      if (fullRow.idx > maxSeenExecutionStepIdx) maxSeenExecutionStepIdx = fullRow.idx

      const publishPlanEntry = extractCompletedPactPublishPlanStepCall(
        meta,
        fullRow.status,
        decodedStep,
        columnPayloadMatches,
      )
      if (publishPlanEntry !== undefined) {
        hasCompletedPactPublishPlan = true
        const existingCallIdx = completedPactPublishPlanCalls.findIndex(
          (entry) =>
            entry.serverName === publishPlanEntry.call.serverName &&
            entry.callId === publishPlanEntry.call.callId &&
            entry.progressToken === publishPlanEntry.call.progressToken &&
            entry.stepId === publishPlanEntry.call.stepId,
        )
        if (existingCallIdx >= 0) {
          completedPactPublishPlanCalls.splice(existingCallIdx, 1)
        }
        completedPactPublishPlanCalls.push(publishPlanEntry.call)
        if (completedPactPublishPlanCalls.length > 256) {
          completedPactPublishPlanCalls.splice(0, completedPactPublishPlanCalls.length - 256)
        }
        for (const token of publishPlanEntry.legacyTokens) {
          const existingIdx = completedPactPublishPlanTokens.indexOf(token)
          if (existingIdx >= 0) {
            completedPactPublishPlanTokens.splice(existingIdx, 1)
          }
          completedPactPublishPlanTokens.push(token)
        }
        if (completedPactPublishPlanTokens.length > 256) {
          completedPactPublishPlanTokens.splice(0, completedPactPublishPlanTokens.length - 256)
        }
      }

      if (!columnPayloadMatches) {
        hasMetadataContradiction = true
        hasActiveStep = true
      }

      if (
        [
          CORTEX_STEP_STATUS_PENDING,
          CORTEX_STEP_STATUS_RUNNING,
          CORTEX_STEP_STATUS_GENERATING,
          CORTEX_STEP_STATUS_WAITING,
          CORTEX_STEP_STATUS_QUEUED,
        ].includes(fullRow.status)
      ) {
        hasActiveStep = true
      } else if (
        fullRow.status === CORTEX_STEP_STATUS_CANCELED ||
        fullRow.status === CORTEX_STEP_STATUS_INTERRUPTED
      ) {
        hasCanceledStep = true
      } else if (
        (fullRow.step_type === CORTEX_STEP_TYPE_USER_INPUT ||
          fullRow.step_type === CORTEX_STEP_TYPE_PLANNER_RESPONSE) &&
        (fullRow.status === CORTEX_STEP_STATUS_ERROR ||
          fullRow.status === CORTEX_STEP_STATUS_INVALID ||
          decodedStep.hasError)
      ) {
        hasFailedCoreStep = true
      }

      if (
        columnPayloadMatches &&
        fullRow.step_type === CORTEX_STEP_TYPE_USER_INPUT &&
        fullRow.status === CORTEX_STEP_STATUS_DONE &&
        decodedStep.userInput
      ) {
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        consumedInputs.push({
          stepIndex: fullRow.idx,
          ...(meta.stepId ? { stepId: meta.stepId } : {}),
          ...(decodedStep.userInput.clientMessageId
            ? { clientMessageId: decodedStep.userInput.clientMessageId }
            : {}),
          ...(pactIdentity.messageId ? { pactMessageId: pactIdentity.messageId } : {}),
          ...(pactIdentity.pactRunId ? { pactRunId: pactIdentity.pactRunId } : {}),
          textSha256: sha256Hex(decodedStep.userInput.text),
        })
      } else if (
        fullRow.step_type === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        decodedStep.type === CORTEX_STEP_TYPE_PLANNER_RESPONSE &&
        decodedStep.plannerResponse &&
        decodedStep.plannerResponse.canonicalText.length > 0 &&
        fullRow.status !== CORTEX_STEP_STATUS_INVALID &&
        decodedStep.status !== CORTEX_STEP_STATUS_INVALID
      ) {
        retainedPlannerBytes +=
          Buffer.byteLength(decodedStep.plannerResponse.canonicalText, 'utf8') + 128
        if (retainedPlannerBytes > AGY_TEXT_BUDGET_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity text/metadata exceeds the 8 MiB inspection budget.',
            false,
          )
        }
        plannerItems.push({
          id: meta.stepId ?? `step:${fullRow.idx}`,
          text: decodedStep.plannerResponse.canonicalText,
        })
      }
    }

    if (!matchedExec && seenExecutionSteps === 0) {
      return {
        exists: true,
        nativeSessionId: input.nativeSessionId,
        trajectoryId: schema.trajectoryId,
        nativeStorageRoot: canonicalRoot,
        nativePath: snapshotHandle.canonicalDbPath,
        stepCount: counts.stepCount,
      }
    }

    const storedTerminalComplete =
      !hasMetadataContradiction &&
      seenExecutionSteps > 0 &&
      consumedInputs.length > 0 &&
      lastStepIdx !== undefined &&
      lastStepSummary !== undefined &&
      lastStepSummary.columnPayloadMatches &&
      lastStepSummary.executionId === resolvedExecutionId &&
      maxSeenExecutionStepIdx === lastStepIdx &&
      lastStepSummary.status === CORTEX_STEP_STATUS_DONE &&
      lastStepSummary.decodedStatus === CORTEX_STEP_STATUS_DONE &&
      !lastStepSummary.hasError &&
      !lastStepSummary.genericHasError

    let status: 'completed' | 'failed' | 'canceled' | 'running'
    if (hasMetadataContradiction) {
      status = 'running'
    } else if (
      !matchedExec ||
      matchedExec.terminationReason === EXECUTOR_TERMINATION_REASON_UNSPECIFIED
    ) {
      status = hasCanceledStep ? 'canceled' : hasFailedCoreStep ? 'failed' : 'running'
    } else if (matchedExec.terminationReason === EXECUTOR_TERMINATION_REASON_USER_CANCELED) {
      status = 'canceled'
    } else if (
      [
        EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
        EXECUTOR_TERMINATION_REASON_TERMINAL_STEP_TYPE,
        EXECUTOR_TERMINATION_REASON_TERMINAL_CUSTOM_HOOK,
        EXECUTOR_TERMINATION_REASON_INJECTED_RESPONSE,
      ].includes(matchedExec.terminationReason) &&
      !matchedExec.executionError &&
      !hasCanceledStep &&
      !hasFailedCoreStep
    ) {
      status = !hasActiveStep && storedTerminalComplete ? 'completed' : 'running'
    } else {
      status = 'failed'
    }

    const answer = projectCollaborationAnswer(plannerItems)
    const responseHash = sha256Hex(answer)
    const planOutcome = input.includePlan
      ? evaluateColdPlanArtifact(
          artifactOps,
          resolvedExecutionId,
          canonicalRoot,
          input.nativeSessionId,
        )
      : {}

    const consumedInputStepIds = consumedInputs.map(
      (entry) =>
        entry.stepId ??
        entry.clientMessageId ??
        entry.pactMessageId ??
        entry.pactRunId ??
        `step:${entry.stepIndex}`,
    )

    return {
      exists: true,
      nativeSessionId: input.nativeSessionId,
      trajectoryId: schema.trajectoryId,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      stepCount: counts.stepCount,
      terminalState: {
        executionId: resolvedExecutionId,
        status,
        ...(matchedExec !== undefined ? { terminationReason: matchedExec.terminationReason } : {}),
        ...(matchedExec?.lastStepIdx !== undefined ? { lastStepIdx: matchedExec.lastStepIdx } : {}),
        consumedInputStepIds,
        consumedInputs,
        answer,
        responseHash,
        ...(planOutcome.plan ? { plan: planOutcome.plan } : {}),
        ...(planOutcome.planUnavailable ? { planUnavailable: true } : {}),
        ...(hasCompletedPactPublishPlan
          ? {
              hasCompletedPactPublishPlan: true,
              completedPactPublishPlanTokens,
              completedPactPublishPlanCalls,
            }
          : {}),
      },
    }
  } finally {
    snapshotHandle.close()
  }
}
