import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

import type { AgyNativeForkCutMetadata } from '@pact/agent-runtime'

import { AgentExecutionError } from '../agent-execution-error'
import {
  type AgySqliteFileIdentity,
  identitiesExactMatch,
  openAnchoredLockedSqliteView,
} from '../agy-sqlite-file'
import {
  type AgyPreScannedSqliteProof,
  AgyStorageMissingError,
  assertIdentityNotCancelledOrExpired,
} from '../agy-sqlite-image'
import { projectCollaborationAnswer } from '../collaboration-answer'
import {
  AGY_MAX_HISTORY_BYTES,
  AGY_MAX_RECORDS,
  AGY_TEXT_BUDGET_BYTES,
  type AgyConsumedInputReceipt,
  type AgyForkInput,
  type AgyForkOperationResult,
  type AgyIdentityRemap,
  type AgyMediaCopyPlan,
  assertValidSessionUuid,
  CORTEX_STEP_STATUS_CANCELED,
  CORTEX_STEP_STATUS_CLEARED,
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_STATUS_GENERATING,
  CORTEX_STEP_STATUS_INTERRUPTED,
  CORTEX_STEP_STATUS_PENDING,
  CORTEX_STEP_STATUS_QUEUED,
  CORTEX_STEP_STATUS_RUNNING,
  CORTEX_STEP_STATUS_WAITING,
  CORTEX_STEP_TYPE_BROWSER_SUBAGENT,
  CORTEX_STEP_TYPE_CHECKPOINT,
  CORTEX_STEP_TYPE_CONVERSATION_HISTORY,
  CORTEX_STEP_TYPE_INVOKE_SUBAGENT,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  type DecodedExecutorMetadata,
  ensureSafeDirectoryChain,
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
  EXECUTOR_TERMINATION_REASON_UNSPECIFIED,
  fsyncDirectoryBestEffort,
  quoteSqlIdentifier,
  REQUIRED_TRAJECTORY_TABLES,
  resolveStorageRoot,
  SAFE_ID_PATTERN,
  sha256CanonicalJson,
  sha256Hex,
} from './constants-and-types'
import {
  assertCompatibleStepRowFormat,
  decodeAgyStep,
  decodeCortexStepGeneratorMetadata,
  decodeCortexStepMetadata,
  decodeExecutorMetadata,
  extractEffectiveStepMetadata,
  extractPactPromptIdentity,
  readBoundedStepMetadataAndUserIdentity,
  readVerifiedUploadedMediaFile,
  remapAgyStep,
  remapCortexStepGeneratorMetadata,
  remapCortexStepMetadata,
  remapCortexTrajectoryMetadata,
} from './cortex-codec'
import {
  assertAnchoredSourceUnchanged,
  type CommittedSqliteSnapshotHandle,
  computePhysicalDbDigest,
  createSameVolumeCandidateStagingDb,
  ensureSummaryStepCountCas,
  initializeStagingFromShell,
  measureOpenSqliteExpectedBytes,
  openCandidateShellSnapshotOrThrowUncertain,
  openCommittedSqliteSnapshot,
  publishStagedCandidateOrThrow,
  readAnchoredFileIdentity,
  verifySqliteIntegrityOk,
  verifySummaryRowExistsReadOnly,
  writeIdempotentPrivateFile,
} from './sqlite-snapshot'
import {
  assertProofHasOrdinaryTables,
  measureTableColumnsTotalBytes,
  optionalBufferField,
  readTableColumns,
  requireBufferField,
  type ValidatedTrajectorySchema,
  validateTrajectoryDatabase,
} from './sqlite-validator'

interface DerivedAgyPrefix {
  schema: ValidatedTrajectorySchema
  canonicalRoot: string
  canonicalDbPath: string
  resolvedExecutionId: string
  cutStep: number
  cutGenIdx: number
  cutExecIdx: number
  lastUserStepIdx: number
  prefixMediaCount: number
  mediaDigestsByFileName: ReadonlyMap<string, { byteLength: number; sha256: string }>
  prefixExecutionIds: string[]
  stepPrefixRows: Array<Record<string, unknown>>
  genPrefixRows: Array<Record<string, unknown>>
  execPrefixRows: Array<Record<string, unknown>>
  prefixHash: string
  prefixBytes: number
  prefixRecords: number
  idMap: Array<[string, string]>
}

function buildAgyForkCutMetadata(
  trajectoryId: string,
  executionId: string,
  derived: Pick<
    DerivedAgyPrefix,
    'cutStep' | 'genPrefixRows' | 'execPrefixRows' | 'prefixMediaCount'
  >,
): AgyNativeForkCutMetadata {
  return {
    version: 'pact-agy-fork-cut-v1',
    trajectoryId,
    executionId,
    cutStepIdx: derived.cutStep,
    genMetadataCount: derived.genPrefixRows.length,
    executorMetadataCount: derived.execPrefixRows.length,
    mediaCount: derived.prefixMediaCount,
  }
}

function canonicalColumnValueDigest(
  row: Record<string, unknown>,
  colName: string,
): {
  digest: unknown
  extraBytes: number
} {
  const val = row[colName]
  if (val === undefined || val === null) {
    return { digest: null, extraBytes: 0 }
  }
  if (Buffer.isBuffer(val)) {
    return {
      digest: { type: 'blob', byteLength: val.byteLength, sha256: sha256Hex(val) },
      extraBytes: val.byteLength,
    }
  }
  if (typeof val === 'string') {
    const byteLength = Buffer.byteLength(val, 'utf8')
    return {
      digest: { type: 'text', byteLength, sha256: sha256Hex(val) },
      extraBytes: byteLength,
    }
  }
  if (typeof val === 'number') {
    return { digest: { type: 'number', value: val }, extraBytes: 0 }
  }
  if (typeof val === 'bigint') {
    return { digest: { type: 'bigint', value: val.toString() }, extraBytes: 0 }
  }
  throw new Error(`Unsupported SQLite value type for Antigravity step column (${colName}).`)
}

function resolveVerifiedForkMedia(
  canonicalRoot: string,
  sessionId: string,
  plan: AgyMediaCopyPlan,
  requireExternalPresent: boolean,
): { bytes: Buffer; sha256: string; hadExternalFile: boolean } {
  try {
    const externalBytes = readVerifiedUploadedMediaFile(
      canonicalRoot,
      sessionId,
      plan.sourceFilePath,
      AGY_MAX_HISTORY_BYTES,
    )
    const externalSha256 = sha256Hex(externalBytes)
    if (plan.inlineData !== undefined && plan.inlineData.byteLength > 0) {
      if (
        externalBytes.byteLength !== plan.inlineData.byteLength ||
        externalSha256 !== sha256Hex(plan.inlineData)
      ) {
        throw new Error(
          'Antigravity step inline media and external .user_uploaded media bytes disagree.',
        )
      }
    }
    return { bytes: externalBytes, sha256: externalSha256, hadExternalFile: true }
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
      if (requireExternalPresent || !plan.inlineData || plan.inlineData.byteLength === 0) {
        throw new Error('Referenced Antigravity uploaded media file is missing.', {
          cause: error,
        })
      }
      const inlineCopy = Buffer.from(plan.inlineData)
      return { bytes: inlineCopy, sha256: sha256Hex(inlineCopy), hadExternalFile: false }
    }
    throw error
  }
}

function deriveVerifiedAgyPrefix(
  db: Database.Database,
  sessionId: string,
  canonicalRoot: string,
  canonicalDbPath: string,
  nativeTurnId: string,
  options: {
    nativeInputIds?: readonly string[]
    responseHash?: string
    requireNoPostCutRows?: boolean
    proof?: AgyPreScannedSqliteProof
    configuredRoot?: string
  },
): DerivedAgyPrefix {
  if (!SAFE_ID_PATTERN.test(nativeTurnId)) {
    throw new Error('Invalid Antigravity nativeTurnId (execution_id).')
  }

  const schema = validateTrajectoryDatabase(db, sessionId, options.proof)

  const execCountRow = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "executor_metadata"')
    .get()
  if (execCountRow && execCountRow.count > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds 10,000 records.',
      false,
    )
  }
  if (
    measureTableColumnsTotalBytes(db, 'executor_metadata', schema.execColumns) >
    AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds the 32 MiB history budget.',
      false,
    )
  }
  const execSelectList = schema.execColumns.map(quoteSqlIdentifier).join(', ')
  const execRows = db
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${execSelectList} FROM "executor_metadata" ORDER BY idx ASC LIMIT ?`,
    )
    .all(AGY_MAX_RECORDS + 1)
  if (execRows.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity executor_metadata exceeds 10,000 records.',
      false,
    )
  }

  const decodedExecRows: Array<{ expectedIdx: number; decoded: DecodedExecutorMetadata }> = []
  let hasDirectExecMatch = false
  for (const [expectedIdx, row] of execRows.entries()) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity executor_metadata has non-contiguous idx values.')
    }
    const data = row['data']
    if (!Buffer.isBuffer(data)) {
      throw new Error('Antigravity executor_metadata.data must be a BLOB.')
    }
    const decoded = decodeExecutorMetadata(data)
    if (!decoded.executionId || !SAFE_ID_PATTERN.test(decoded.executionId)) {
      throw new Error('Antigravity executor_metadata row is missing a valid execution_id.')
    }
    if (decoded.executionId === nativeTurnId) {
      hasDirectExecMatch = true
    }
    decodedExecRows.push({ expectedIdx, decoded })
  }

  const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
  const userHeaderSelectSql = schema.hasStepFormatColumn
    ? `SELECT idx, status, metadata, LENGTH(${stepPayloadSql}) AS blob_len, step_format FROM "steps" WHERE step_type = ? ORDER BY idx ASC LIMIT ?`
    : `SELECT idx, status, metadata, LENGTH(${stepPayloadSql}) AS blob_len FROM "steps" WHERE step_type = ? ORDER BY idx ASC LIMIT ?`
  const userHeaderStmt = db.prepare<
    [number, number],
    {
      idx: number
      status: number
      metadata: Buffer | null
      blob_len: number | null
      step_format?: unknown
    }
  >(userHeaderSelectSql)

  const rootUserSeenExecutions = new Set<string>()
  const pactRunMatchedExecutions = new Set<string>()
  const remainingLargeUserTextBudget = { bytes: AGY_TEXT_BUDGET_BYTES }
  let seenUserRowCount = 0
  for (const uRow of userHeaderStmt.iterate(CORTEX_STEP_TYPE_USER_INPUT, AGY_MAX_RECORDS + 1)) {
    seenUserRowCount += 1
    if (seenUserRowCount > AGY_MAX_RECORDS) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity user input steps exceed 10,000 records.',
        false,
      )
    }
    assertCompatibleStepRowFormat(uRow.step_format, schema.hasStepFormatColumn, uRow.idx)
    if (
      typeof uRow.blob_len !== 'number' ||
      uRow.blob_len <= 0 ||
      uRow.blob_len > AGY_MAX_HISTORY_BYTES
    ) {
      throw new Error(
        `Antigravity user input step ${uRow.idx} has missing or oversized ${schema.stepPayloadColumn} BLOB.`,
      )
    }
    const colMeta =
      uRow.metadata && uRow.metadata.length > 0
        ? decodeCortexStepMetadata(uRow.metadata)
        : undefined
    const bounded = readBoundedStepMetadataAndUserIdentity(
      db,
      stepPayloadSql,
      uRow.idx,
      uRow.blob_len,
      uRow.status === CORTEX_STEP_STATUS_DONE,
      remainingLargeUserTextBudget,
    )
    if (
      colMeta?.executionId &&
      bounded.payloadMeta?.executionId &&
      colMeta.executionId !== bounded.payloadMeta.executionId
    ) {
      throw new Error(
        'Antigravity step column metadata and payload metadata execution_id disagree.',
      )
    }
    const execId = colMeta?.executionId ?? bounded.payloadMeta?.executionId
    if (uRow.status === CORTEX_STEP_STATUS_DONE && execId) {
      const pactRunId = bounded.userIdentity?.pactRunId
      if (!rootUserSeenExecutions.has(execId)) {
        rootUserSeenExecutions.add(execId)
        if (pactRunId === nativeTurnId) {
          pactRunMatchedExecutions.add(execId)
        }
      } else if (pactRunId === nativeTurnId) {
        throw new Error('Antigravity non-root user input unexpectedly carries root pactRunId.')
      }
    }
  }

  if (pactRunMatchedExecutions.size > 1) {
    throw new Error('Multiple Antigravity executions match pactRunId; failing closed.')
  }
  const directExecMatch = hasDirectExecMatch ? nativeTurnId : undefined
  const pactRunExecMatch =
    pactRunMatchedExecutions.size === 1 ? [...pactRunMatchedExecutions][0] : undefined
  if (directExecMatch && pactRunExecMatch && directExecMatch !== pactRunExecMatch) {
    throw new Error(
      'Antigravity trajectory has conflicting direct execution_id and pactRunId matches.',
    )
  }
  const resolvedExecutionId = directExecMatch ?? pactRunExecMatch
  if (!resolvedExecutionId) {
    throw new Error('Antigravity trajectory has no completed execution matching nativeTurnId.')
  }

  let cutExecIdx = -1
  let cutStep = -1
  let targetExecDecoded: DecodedExecutorMetadata | undefined
  const prefixExecutionIds: string[] = []
  const prefixExecutionSet = new Set<string>()
  let prevLastStep = -1

  for (const { expectedIdx, decoded } of decodedExecRows) {
    if (cutExecIdx < 0) {
      if (prefixExecutionSet.has(decoded.executionId!)) {
        throw new Error('Antigravity executor_metadata contains duplicate execution_id in prefix.')
      }
      if (decoded.terminationReason === EXECUTOR_TERMINATION_REASON_UNSPECIFIED) {
        throw new Error('Antigravity prefix contains an unfinished execution.')
      }
      const rowLastStep = decoded.lastStepIdx ?? 0
      if (rowLastStep <= prevLastStep) {
        throw new Error('Antigravity executor_metadata last_step_idx is not strictly increasing.')
      }
      prevLastStep = rowLastStep
      prefixExecutionIds.push(decoded.executionId!)
      prefixExecutionSet.add(decoded.executionId!)

      if (decoded.executionId === resolvedExecutionId) {
        if (
          decoded.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
          Boolean(decoded.executionError)
        ) {
          throw new Error(
            'Antigravity selected Fork Turn did not complete with normal termination_reason = 4.',
          )
        }
        if (decoded.lastStepIdx === undefined || decoded.lastStepIdx < 1) {
          throw new Error('Antigravity selected Fork Turn has an invalid last_step_idx.')
        }
        cutExecIdx = expectedIdx
        cutStep = decoded.lastStepIdx
        targetExecDecoded = decoded
      }
    } else {
      if (options.requireNoPostCutRows) {
        throw new Error(
          'Antigravity Fork candidate contains extra executor_metadata rows after its frozen cutoff.',
        )
      }
      if (prefixExecutionSet.has(decoded.executionId!)) {
        throw new Error('Antigravity post-cut executor_metadata reuses a prefix execution_id.')
      }
      if ((decoded.lastStepIdx ?? 0) <= cutStep) {
        throw new Error(
          'Antigravity post-cut executor_metadata references a step at or before cutStep.',
        )
      }
    }
  }

  if (cutExecIdx < 0 || cutStep < 1 || !targetExecDecoded) {
    throw new Error('Antigravity trajectory has no completed execution matching nativeTurnId.')
  }
  if (cutStep + 1 > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity trajectory prefix exceeds the 10,000-record budget.',
      false,
    )
  }

  const genCountRow = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
    .get()
  if (genCountRow && genCountRow.count > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds 10,000 records.',
      false,
    )
  }
  if (
    measureTableColumnsTotalBytes(db, 'gen_metadata', schema.genColumns) > AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds the 32 MiB history budget.',
      false,
    )
  }
  const genSelectList = schema.genColumns.map(quoteSqlIdentifier).join(', ')
  const genRows = db
    .prepare<[number], Record<string, unknown>>(
      `SELECT ${genSelectList} FROM "gen_metadata" ORDER BY idx ASC LIMIT ?`,
    )
    .all(AGY_MAX_RECORDS + 1)
  if (genRows.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity gen_metadata exceeds 10,000 records.',
      false,
    )
  }

  let cutGenIdx = -1
  let postCutGenStarted = false
  let targetGenCount = 0
  const genExpectedStepOwner = new Map<number, string>()

  for (const [expectedIdx, row] of genRows.entries()) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity gen_metadata has non-contiguous idx values.')
    }
    const data = row['data']
    if (!Buffer.isBuffer(data)) {
      throw new Error('Antigravity gen_metadata.data must be a BLOB.')
    }
    const decoded = decodeCortexStepGeneratorMetadata(data)
    if (!decoded.executionId || !SAFE_ID_PATTERN.test(decoded.executionId)) {
      throw new Error('Antigravity gen_metadata row is missing a valid execution_id.')
    }

    const inPrefix = prefixExecutionSet.has(decoded.executionId)
    if (inPrefix) {
      if (postCutGenStarted) {
        throw new Error('Antigravity gen_metadata interleaves prefix and post-cut executions.')
      }
      if (decoded.hasCompactionCheckpoint) {
        throw new Error(
          'Antigravity gen_metadata indicates /compact checkpoint coverage in prefix.',
        )
      }
      for (const entry of decoded.customMetadata) {
        if (entry.key === 'trajectory_id' && entry.value && entry.value !== schema.trajectoryId) {
          throw new Error('Antigravity gen_metadata has mismatched trajectory_id.')
        }
        if (
          (entry.key === 'cascade_id' || entry.key === 'root_cascade_id') &&
          entry.value &&
          entry.value !== sessionId
        ) {
          throw new Error(`Antigravity gen_metadata has mismatched ${entry.key}.`)
        }
      }
      for (const sIdx of decoded.stepIndices) {
        if (sIdx < 0 || sIdx > cutStep) {
          throw new Error('Antigravity prefix gen_metadata references a step_index beyond cutStep.')
        }
        genExpectedStepOwner.set(sIdx, decoded.executionId)
      }
      if (decoded.executionId === resolvedExecutionId) targetGenCount += 1
      cutGenIdx = expectedIdx
    } else {
      if (options.requireNoPostCutRows) {
        throw new Error(
          'Antigravity Fork candidate contains extra gen_metadata rows after its frozen cutoff.',
        )
      }
      postCutGenStarted = true
      for (const sIdx of decoded.stepIndices) {
        if (sIdx <= cutStep) {
          throw new Error(
            'Antigravity post-cut gen_metadata references a step_index inside the prefix.',
          )
        }
      }
    }
  }

  if (
    targetExecDecoded.numGeneratorInvocations > 0 &&
    targetGenCount !== targetExecDecoded.numGeneratorInvocations
  ) {
    throw new Error(
      'Antigravity gen_metadata invocation count does not match executor_metadata.num_generator_invocations.',
    )
  }

  const totalStepBounds = db
    .prepare<[], { minIdx: number | null; maxIdx: number | null; count: number }>(
      'SELECT MIN(idx) AS minIdx, MAX(idx) AS maxIdx, COUNT(*) AS count FROM "steps"',
    )
    .get()!
  if (
    totalStepBounds.count <= 0 ||
    totalStepBounds.minIdx !== 0 ||
    totalStepBounds.maxIdx === null ||
    totalStepBounds.maxIdx < cutStep
  ) {
    throw new Error('Antigravity steps table bounds are incomplete or missing 0..cutStep.')
  }
  if (
    options.requireNoPostCutRows &&
    (totalStepBounds.maxIdx > cutStep || totalStepBounds.count !== cutStep + 1)
  ) {
    throw new Error('Antigravity Fork candidate contains extra steps after its frozen cutoff.')
  }

  if (totalStepBounds.maxIdx > cutStep) {
    const postCutHeaderSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, LENGTH(${stepPayloadSql}) AS payload_len, step_format FROM "steps" WHERE idx > ? ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" WHERE idx > ? ORDER BY idx ASC`
    const postCutHeaderStmt = db.prepare<
      [number],
      {
        idx: number
        step_type: number
        status: number
        has_subtrajectory: number
        metadata: Buffer | null
        payload_len: number | null
        step_format?: unknown
      }
    >(postCutHeaderSelectSql)
    let checkedHeaders = 0
    for (const rawHeader of postCutHeaderStmt.iterate(cutStep)) {
      checkedHeaders += 1
      if (checkedHeaders > AGY_MAX_RECORDS * 10) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity post-cut header verification exceeded safety bound.',
          false,
        )
      }
      assertCompatibleStepRowFormat(
        rawHeader.step_format,
        schema.hasStepFormatColumn,
        rawHeader.idx,
      )
      if (
        typeof rawHeader.payload_len !== 'number' ||
        rawHeader.payload_len <= 0 ||
        rawHeader.payload_len > AGY_MAX_HISTORY_BYTES
      ) {
        throw new Error(
          `Antigravity post-cut step ${rawHeader.idx} is missing verifiable step_payload attribution.`,
        )
      }
      const columnMeta =
        rawHeader.metadata && rawHeader.metadata.length > 0
          ? decodeCortexStepMetadata(rawHeader.metadata)
          : undefined
      const boundedPost = readBoundedStepMetadataAndUserIdentity(
        db,
        stepPayloadSql,
        rawHeader.idx,
        rawHeader.payload_len,
        false,
        { bytes: 0 },
      )
      if (
        columnMeta?.executionId &&
        boundedPost.payloadMeta?.executionId &&
        columnMeta.executionId !== boundedPost.payloadMeta.executionId
      ) {
        throw new Error(
          'Antigravity post-cut step column metadata and payload metadata execution_id disagree.',
        )
      }
      const effectivePostExecId = columnMeta?.executionId ?? boundedPost.payloadMeta?.executionId
      if (!effectivePostExecId || !SAFE_ID_PATTERN.test(effectivePostExecId)) {
        throw new Error(
          `Antigravity post-cut step ${rawHeader.idx} is missing verifiable execution_id attribution.`,
        )
      }
      if (prefixExecutionSet.has(effectivePostExecId)) {
        throw new Error(
          'Antigravity post-cut step carries an execution_id belonging to the frozen prefix.',
        )
      }
    }
  }

  // Stream LENGTH checks on 0..cutStep first so oversized BLOBs fail before allocation!
  const prefixLengthStmt = db.prepare<
    [number],
    { idx: number; meta_len: number | null; payload_len: number | null }
  >(
    `SELECT idx, LENGTH(metadata) AS meta_len, LENGTH(${stepPayloadSql}) AS payload_len FROM "steps" WHERE idx >= 0 AND idx <= ? ORDER BY idx ASC`,
  )
  let checkedPrefixCount = 0
  for (const lenRow of prefixLengthStmt.iterate(cutStep)) {
    if (lenRow.idx !== checkedPrefixCount) {
      throw new Error(
        'Antigravity steps prefix 0..cutStep has missing step indices (gap detected).',
      )
    }
    if ((lenRow.meta_len ?? 0) > AGY_TEXT_BUDGET_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork step metadata exceeds the 8 MiB budget.',
        false,
      )
    }
    if (typeof lenRow.payload_len !== 'number' || lenRow.payload_len <= 0) {
      throw new Error(
        `Antigravity step ${lenRow.idx} is missing its ${schema.stepPayloadColumn} BLOB.`,
      )
    }
    if (lenRow.payload_len > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork prefix exceeds the 32 MiB history budget.',
        false,
      )
    }
    checkedPrefixCount += 1
  }
  if (checkedPrefixCount !== cutStep + 1) {
    throw new Error('Antigravity steps prefix 0..cutStep has missing step indices (gap detected).')
  }

  const genPrefixRows = cutGenIdx >= 0 ? genRows.slice(0, cutGenIdx + 1) : []
  const execPrefixRows = execRows.slice(0, cutExecIdx + 1)
  const prefixRecords = checkedPrefixCount + genPrefixRows.length + execPrefixRows.length
  if (prefixRecords > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity closed Fork prefix exceeds the 10,000-record budget.',
      false,
    )
  }

  const normalizeRemap: AgyIdentityRemap = {
    sourceTrajectoryId: schema.trajectoryId,
    targetTrajectoryId: '$trajectory',
    sourceCascadeId: sessionId,
    targetCascadeId: '$cascade',
    canonicalAppDataDir: canonicalRoot,
    ...(options.configuredRoot !== undefined
      ? { configuredAppDataDir: options.configuredRoot }
      : {}),
  }

  let prefixBytes = 0
  let prefixImageBytes = 0
  let prefixMediaCount = 0
  let maxSeenExecRank = 0
  let lastUserStepIdx = -1
  let targetSectionStarted = false
  const execRankMap = new Map(prefixExecutionIds.map((id, rank) => [id, rank]))

  const targetUserSteps: AgyConsumedInputReceipt[] = []
  const prefixInputIdentityCandidates: string[] = []
  const targetPlannerItems: Array<{ id: string; text: string }> = []
  const stepPrefixRows: Array<Record<string, unknown>> = []
  const normalizedStepsDigest: Array<Record<string, unknown>> = []
  const mediaDigestsByFileName = new Map<string, { byteLength: number; sha256: string }>()
  const extraNonStandardCols = schema.stepColumns.filter(
    (col) =>
      ![
        'idx',
        'step_type',
        'status',
        'has_subtrajectory',
        'metadata',
        schema.stepPayloadColumn,
        'step_format',
        'size',
        'error_details',
        'permissions',
        'task_details',
        'render_info',
      ].includes(col),
  )

  if (
    measureTableColumnsTotalBytes(db, 'steps', schema.stepColumns, {
      sql: 'idx >= 0 AND idx <= ?',
      params: [cutStep],
    }) > AGY_MAX_HISTORY_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork prefix exceeds the 32 MiB history budget.',
      false,
    )
  }
  const stepPrefixSelectList = schema.stepColumns.map(quoteSqlIdentifier).join(', ')
  const stepPrefixStmt = db.prepare<[number], Record<string, unknown>>(
    `SELECT ${stepPrefixSelectList} FROM "steps" WHERE idx >= 0 AND idx <= ? ORDER BY idx ASC`,
  )
  let expectedIdx = 0
  for (const row of stepPrefixStmt.iterate(cutStep)) {
    if (row['idx'] !== expectedIdx) {
      throw new Error('Antigravity steps prefix 0..cutStep has a step index gap.')
    }
    const stepType = row['step_type']
    const status = row['status']
    const hasSubtrajectory = row['has_subtrajectory']
    const rawMeta = optionalBufferField(row, 'metadata')
    assertCompatibleStepRowFormat(row['step_format'], schema.hasStepFormatColumn, expectedIdx)
    const rawData = row[schema.stepPayloadColumn]

    if (typeof stepType !== 'number' || typeof status !== 'number' || !Buffer.isBuffer(rawData)) {
      throw new Error(`Antigravity step ${expectedIdx} has invalid column types.`)
    }
    if (
      hasSubtrajectory !== 0 &&
      hasSubtrajectory !== false &&
      hasSubtrajectory !== null &&
      hasSubtrajectory !== undefined
    ) {
      throw new Error(`Antigravity step ${expectedIdx} has an unclosed subtrajectory.`)
    }
    if (status === CORTEX_STEP_STATUS_CLEARED) {
      throw new Error(
        `Antigravity step ${expectedIdx} has status CLEARED; /compact prefix rewrite rejected.`,
      )
    }
    if (
      stepType === CORTEX_STEP_TYPE_CHECKPOINT ||
      stepType === CORTEX_STEP_TYPE_CONVERSATION_HISTORY
    ) {
      throw new Error(
        `Antigravity step ${expectedIdx} is a compaction/history step; /compact prefix rejected.`,
      )
    }
    if (
      stepType === CORTEX_STEP_TYPE_INVOKE_SUBAGENT ||
      stepType === CORTEX_STEP_TYPE_BROWSER_SUBAGENT
    ) {
      throw new Error(`Antigravity step ${expectedIdx} invokes a subagent; failing closed.`)
    }

    const decodedStep = decodeAgyStep(rawData)
    if (decodedStep.type !== stepType || decodedStep.status !== status) {
      throw new Error(`Antigravity step ${expectedIdx} header columns disagree with Step payload.`)
    }
    if (decodedStep.hasSubtrajectoryField) {
      throw new Error(`Antigravity step ${expectedIdx} payload embeds an unclosed subtrajectory.`)
    }
    if (decodedStep.hasCompaction) {
      throw new Error(
        `Antigravity step ${expectedIdx} payload contains compaction data; /compact rejected.`,
      )
    }

    const meta = extractEffectiveStepMetadata(rawMeta, decodedStep)
    if (!meta.executionId || !execRankMap.has(meta.executionId)) {
      throw new Error(
        `Antigravity step ${expectedIdx} carries an unknown or post-cut execution_id.`,
      )
    }
    const rank = execRankMap.get(meta.executionId)!
    if (rank < maxSeenExecRank) {
      throw new Error(
        `Antigravity step ${expectedIdx} rewrites an earlier prefix position out of execution order.`,
      )
    }
    maxSeenExecRank = rank

    const expectedGenOwner = genExpectedStepOwner.get(expectedIdx)
    if (expectedGenOwner !== undefined && expectedGenOwner !== meta.executionId) {
      throw new Error(
        `Antigravity step ${expectedIdx} execution_id disagrees with gen_metadata.step_indices.`,
      )
    }

    if (stepType === CORTEX_STEP_TYPE_USER_INPUT) {
      lastUserStepIdx = expectedIdx
      if (decodedStep.userInput) prefixMediaCount += decodedStep.userInput.media.length
      if (status === CORTEX_STEP_STATUS_DONE && decodedStep.userInput) {
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        for (const candidateId of [
          meta.stepId,
          decodedStep.userInput.clientMessageId,
          pactIdentity.messageId,
          pactIdentity.pactRunId,
        ]) {
          if (candidateId && candidateId.length > 0 && candidateId.length <= 1024) {
            prefixInputIdentityCandidates.push(candidateId)
          }
        }
      }
    }

    const normalizedMeta = rawMeta
      ? remapCortexStepMetadata(rawMeta, normalizeRemap, expectedIdx)
      : Buffer.alloc(0)
    const normalizedStep = remapAgyStep(rawData, normalizeRemap, expectedIdx)

    const hasSubDigest = canonicalColumnValueDigest(row, 'has_subtrajectory')
    const errorDetailsDigest = canonicalColumnValueDigest(row, 'error_details')
    const permissionsDigest = canonicalColumnValueDigest(row, 'permissions')
    const taskDetailsDigest = canonicalColumnValueDigest(row, 'task_details')
    const renderInfoDigest = canonicalColumnValueDigest(row, 'render_info')
    const extraColumnDigests: Record<string, unknown> = {}
    let extraColumnBytes =
      errorDetailsDigest.extraBytes +
      permissionsDigest.extraBytes +
      taskDetailsDigest.extraBytes +
      renderInfoDigest.extraBytes
    for (const col of extraNonStandardCols) {
      const colRes = canonicalColumnValueDigest(row, col)
      if (colRes.digest !== null) {
        extraColumnDigests[col] = colRes.digest
        extraColumnBytes += colRes.extraBytes
      }
    }

    const stepMediaDigest: Array<{
      targetUri: string
      fileName: string
      byteLength: number
      sha256: string
    }> = []
    for (const plan of normalizedStep.copiedMedia) {
      const verifiedMedia = resolveVerifiedForkMedia(
        canonicalRoot,
        sessionId,
        plan,
        Boolean(options.requireNoPostCutRows),
      )
      const prevDigest = mediaDigestsByFileName.get(plan.fileName)
      if (
        prevDigest &&
        (prevDigest.byteLength !== verifiedMedia.bytes.byteLength ||
          prevDigest.sha256 !== verifiedMedia.sha256)
      ) {
        throw new Error(
          'Antigravity Fork uploaded media digest changed across steps in the same prefix.',
        )
      }
      mediaDigestsByFileName.set(plan.fileName, {
        byteLength: verifiedMedia.bytes.byteLength,
        sha256: verifiedMedia.sha256,
      })
      if (!plan.inlineData || plan.inlineData.byteLength === 0) {
        prefixBytes += verifiedMedia.bytes.byteLength
        prefixImageBytes += verifiedMedia.bytes.byteLength
      }
      stepMediaDigest.push({
        targetUri: plan.targetUri,
        fileName: plan.fileName,
        byteLength: verifiedMedia.bytes.byteLength,
        sha256: verifiedMedia.sha256,
      })
    }

    prefixBytes += normalizedMeta.byteLength + normalizedStep.buffer.byteLength + extraColumnBytes
    prefixImageBytes += normalizedStep.inlineImageBytes
    if (prefixBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork prefix exceeds the 32 MiB history budget.',
        false,
      )
    }
    if (prefixBytes - prefixImageBytes > AGY_TEXT_BUDGET_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork text/metadata prefix exceeds the 8 MiB budget.',
        false,
      )
    }

    normalizedStepsDigest.push({
      idx: expectedIdx,
      stepType,
      status,
      hasSubtrajectory: hasSubDigest.digest,
      stepFormat: schema.hasStepFormatColumn ? row['step_format'] : 0,
      errorDetails: errorDetailsDigest.digest,
      permissions: permissionsDigest.digest,
      taskDetails: taskDetailsDigest.digest,
      renderInfo: renderInfoDigest.digest,
      ...(Object.keys(extraColumnDigests).length > 0 ? { extraColumns: extraColumnDigests } : {}),
      metaBytes: normalizedMeta.byteLength,
      metaSha256: sha256Hex(normalizedMeta),
      dataBytes: normalizedStep.buffer.byteLength,
      dataSha256: sha256Hex(normalizedStep.buffer),
      media: stepMediaDigest,
    })

    if (meta.executionId === resolvedExecutionId) {
      targetSectionStarted = true
      if (
        [
          CORTEX_STEP_STATUS_PENDING,
          CORTEX_STEP_STATUS_RUNNING,
          CORTEX_STEP_STATUS_GENERATING,
          CORTEX_STEP_STATUS_WAITING,
          CORTEX_STEP_STATUS_QUEUED,
          CORTEX_STEP_STATUS_CANCELED,
          CORTEX_STEP_STATUS_INTERRUPTED,
        ].includes(status)
      ) {
        throw new Error(
          `Antigravity selected Turn step ${expectedIdx} is not in a settled terminal state.`,
        )
      }
      if (stepType === CORTEX_STEP_TYPE_USER_INPUT) {
        if (status !== CORTEX_STEP_STATUS_DONE || !decodedStep.userInput || decodedStep.hasError) {
          throw new Error(`Antigravity selected Turn user input step ${expectedIdx} is incomplete.`)
        }
        const pactIdentity = extractPactPromptIdentity(decodedStep.userInput.text)
        targetUserSteps.push({
          stepIndex: expectedIdx,
          ...(meta.stepId ? { stepId: meta.stepId } : {}),
          ...(decodedStep.userInput.clientMessageId
            ? { clientMessageId: decodedStep.userInput.clientMessageId }
            : {}),
          ...(pactIdentity.messageId ? { pactMessageId: pactIdentity.messageId } : {}),
          ...(pactIdentity.pactRunId ? { pactRunId: pactIdentity.pactRunId } : {}),
          textSha256: sha256Hex(decodedStep.userInput.text),
        })
      } else if (stepType === CORTEX_STEP_TYPE_PLANNER_RESPONSE) {
        if (
          status !== CORTEX_STEP_STATUS_DONE ||
          !decodedStep.plannerResponse ||
          decodedStep.hasError
        ) {
          throw new Error(
            `Antigravity selected Turn planner response step ${expectedIdx} is incomplete.`,
          )
        }
        if (decodedStep.plannerResponse.canonicalText.length > 0) {
          targetPlannerItems.push({
            id: meta.stepId ?? `step:${expectedIdx}`,
            text: decodedStep.plannerResponse.canonicalText,
          })
        }
      }
    } else if (targetSectionStarted) {
      throw new Error('Antigravity selected Turn steps are not contiguous through cutStep.')
    }

    stepPrefixRows.push(row)
    expectedIdx += 1
  }

  if (targetUserSteps.length < 1) {
    throw new Error('Antigravity selected Turn contains no consumed CortexStepUserInput.')
  }

  if (options.nativeInputIds !== undefined) {
    if (options.nativeInputIds.length !== targetUserSteps.length) {
      throw new Error(
        `Antigravity consumed input count (${targetUserSteps.length}) does not match expected nativeInputIds (${options.nativeInputIds.length}).`,
      )
    }
    for (const [inputOrdinal, expectedId] of options.nativeInputIds.entries()) {
      const actual = targetUserSteps[inputOrdinal]!
      const matchesRootTurnId =
        inputOrdinal === 0 &&
        (expectedId === actual.pactRunId ||
          (!actual.pactRunId && expectedId === resolvedExecutionId))
      const matchesStepIdentity =
        expectedId === actual.stepId ||
        expectedId === actual.clientMessageId ||
        expectedId === actual.pactMessageId
      if (!matchesRootTurnId && !matchesStepIdentity) {
        throw new Error(
          `Antigravity consumed input at ordinal ${inputOrdinal} does not match expected nativeInputIds.`,
        )
      }
    }
  } else if (targetUserSteps.length !== 1 && !options.requireNoPostCutRows) {
    throw new Error(
      'Antigravity Turn consumed multiple Steer inputs without explicit nativeInputIds authorization.',
    )
  }

  if (options.responseHash !== undefined) {
    const canonicalAnswer = projectCollaborationAnswer(targetPlannerItems)
    if (sha256Hex(canonicalAnswer) !== options.responseHash) {
      throw new Error(
        'Antigravity complete native planner response does not match the selected Pact answer.',
      )
    }
  }

  const normalizedGenDigest = genPrefixRows.map((row, genIdx) => {
    const rawData = requireBufferField(row, 'data')
    const normalized = remapCortexStepGeneratorMetadata(rawData, normalizeRemap)
    prefixBytes += normalized.byteLength
    return { idx: genIdx, dataSha256: sha256Hex(normalized) }
  })

  const normalizedExecDigest = execPrefixRows.map((row, execIdx) => {
    const rawData = requireBufferField(row, 'data')
    prefixBytes += rawData.byteLength
    return { idx: execIdx, dataSha256: sha256Hex(rawData) }
  })

  if (
    prefixBytes > AGY_MAX_HISTORY_BYTES ||
    prefixBytes - prefixImageBytes > AGY_TEXT_BUDGET_BYTES
  ) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork prefix metadata exceeds its byte budget.',
      false,
    )
  }

  const prefixHash = sha256CanonicalJson({
    domain: 'agy-native-prefix-v1',
    cutStep,
    cutGenIdx,
    cutExecIdx,
    steps: normalizedStepsDigest,
    genMetadata: normalizedGenDigest,
    executorMetadata: normalizedExecDigest,
  })

  const seenIdMapKeys = new Set<string>()
  const idMap: Array<[string, string]> = []
  for (const id of [...prefixExecutionIds, ...prefixInputIdentityCandidates]) {
    if (!id || id.length > 1024 || seenIdMapKeys.has(id)) continue
    seenIdMapKeys.add(id)
    idMap.push([id, id])
  }
  if (idMap.length > AGY_MAX_RECORDS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity Fork identity map exceeds the 10,000-record budget.',
      false,
    )
  }

  return {
    schema,
    canonicalRoot,
    canonicalDbPath,
    resolvedExecutionId,
    cutStep,
    cutGenIdx,
    cutExecIdx,
    lastUserStepIdx,
    prefixMediaCount,
    mediaDigestsByFileName,
    prefixExecutionIds,
    stepPrefixRows,
    genPrefixRows,
    execPrefixRows,
    prefixHash,
    prefixBytes: Math.max(1, prefixBytes),
    prefixRecords,
    idMap,
  }
}

export function prepareAgyFork(input: AgyForkInput): AgyForkOperationResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const sourceSessionId = input.source?.nativeSessionId ?? input.nativeSessionId
  const nativeTurnId = input.source?.nativeTurnId ?? input.nativeTurnId
  const effectiveInputIds = input.nativeInputIds ?? input.source?.nativeInputIds
  assertValidSessionUuid(sourceSessionId, 'Antigravity source Session UUID')
  if (!nativeTurnId) {
    throw new Error('Antigravity Fork preparation requires nativeTurnId (execution_id).')
  }
  if (!input.source && !input.responseHash) {
    throw new Error('Antigravity Fork preparation requires expected responseHash.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${sourceSessionId}.db`,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  try {
    const derived = deriveVerifiedAgyPrefix(
      snapshotHandle.db,
      sourceSessionId,
      canonicalRoot,
      snapshotHandle.canonicalDbPath,
      nativeTurnId,
      {
        proof: snapshotHandle.proof,
        configuredRoot,
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })

    if (
      input.source &&
      (input.source.nativeCutId !== derived.resolvedExecutionId ||
        input.source.prefixHash !== derived.prefixHash ||
        (input.source.agyCut !== undefined &&
          (input.source.agyCut.trajectoryId !== derived.schema.trajectoryId ||
            input.source.agyCut.executionId !== derived.resolvedExecutionId ||
            input.source.agyCut.cutStepIdx !== derived.cutStep)))
    ) {
      throw new Error('Prepared Antigravity native prefix changed before Fork.')
    }

    return {
      nativeSessionId: sourceSessionId,
      nativeCutId: derived.resolvedExecutionId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: '',
      rawBytes: 0,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: derived.schema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: buildAgyForkCutMetadata(
        derived.schema.trajectoryId,
        derived.resolvedExecutionId,
        derived,
      ),
    }
  } finally {
    snapshotHandle.close()
  }
}

export function inspectAgyFork(input: AgyForkInput): AgyForkOperationResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const witness = input.witness
  if (!witness || witness.nativeSessionId !== input.nativeSessionId || !witness.idMap.length) {
    throw new Error('Antigravity Fork witness is missing.')
  }
  assertValidSessionUuid(input.nativeSessionId, 'Antigravity candidate Session UUID')
  assertValidSessionUuid(witness.sourceNativeSessionId, 'Antigravity source Session UUID')

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)
  if (witness.nativeStorageRoot && canonicalRoot !== witness.nativeStorageRoot) {
    throw new Error('The effective Antigravity native storage root changed.')
  }

  const checkSourceStillValid = (): void => {
    if (!input.source) return
    prepareAgyFork({
      ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
      cwd: input.cwd,
      nativeSessionId: input.source.nativeSessionId,
      nativeTurnId: input.source.nativeTurnId,
      source: input.source,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  }

  let snapshotHandle: CommittedSqliteSnapshotHandle
  try {
    snapshotHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (error instanceof AgyStorageMissingError) {
      if (input.lastDispatchedPhase === 'fork' && input.source) {
        checkSourceStillValid()
        throw Object.assign(
          new Error(
            'The recorded Antigravity Fork candidate database is absent; the original source cut remains intact.',
          ),
          { code: 'native_file_fork_candidate_missing' },
        )
      }
      throw new Error('Antigravity Fork candidate database does not exist.', { cause: error })
    }
    throw error
  }
  if (witness.nativePath && snapshotHandle.canonicalDbPath !== witness.nativePath) {
    snapshotHandle.close()
    throw new Error('The recorded Antigravity native Fork path changed.')
  }

  let derived: DerivedAgyPrefix
  try {
    // Proof-first table verification BEFORE preparing ANY SQL on business tables!
    assertProofHasOrdinaryTables(snapshotHandle.proof, REQUIRED_TRAJECTORY_TABLES)
    const counts = snapshotHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!
    if (counts.stepCount === 0 && counts.genCount === 0 && counts.execCount === 0) {
      validateTrajectoryDatabase(snapshotHandle.db, input.nativeSessionId, snapshotHandle.proof)
      assertAnchoredSourceUnchanged({
        rootDir: configuredRoot,
        canonicalRoot,
        parentSegments: ['conversations'],
        leafName: `${input.nativeSessionId}.db`,
        expectedIdentity: snapshotHandle.fileIdentity,
        expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      })
      if (input.lastDispatchedPhase === 'fork' && input.source) {
        checkSourceStillValid()
        assertAnchoredSourceUnchanged({
          rootDir: configuredRoot,
          canonicalRoot,
          parentSegments: ['conversations'],
          leafName: `${input.nativeSessionId}.db`,
          expectedIdentity: snapshotHandle.fileIdentity,
          expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
        })
        throw Object.assign(
          new Error(
            'Antigravity Fork candidate is still an unpopulated zero-Turn shell; the original source cut remains intact.',
          ),
          { code: 'native_file_fork_candidate_missing' },
        )
      }
      throw new Error(
        'Antigravity Fork candidate is still an unpopulated zero-Turn shell; publication did not complete.',
      )
    }
    const inspectInputIds = input.nativeInputIds ?? input.source?.nativeInputIds
    derived = deriveVerifiedAgyPrefix(
      snapshotHandle.db,
      input.nativeSessionId,
      canonicalRoot,
      snapshotHandle.canonicalDbPath,
      witness.sourceCutId,
      {
        proof: snapshotHandle.proof,
        configuredRoot,
        requireNoPostCutRows: true,
        ...(inspectInputIds !== undefined ? { nativeInputIds: inspectInputIds } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
    })
  } finally {
    snapshotHandle.close()
  }

  if (
    derived.prefixHash !== witness.candidatePrefixHash ||
    derived.prefixHash !== witness.sourcePrefixHash ||
    (input.source && derived.prefixHash !== input.source.prefixHash)
  ) {
    throw new Error('Antigravity Fork prefix hash differs from its frozen witness.')
  }
  if (JSON.stringify(derived.idMap) !== JSON.stringify(witness.idMap)) {
    throw new Error('Antigravity Fork execution_id map differs from its witness.')
  }
  if (
    witness.candidatePrefixRecords !== undefined &&
    derived.prefixRecords !== witness.candidatePrefixRecords
  ) {
    throw new Error('Antigravity Fork candidate record count differs from its witness.')
  }
  if (witness.cutStepIdx !== undefined && derived.cutStep !== witness.cutStepIdx) {
    throw new Error('Antigravity Fork candidate cutStepIdx differs from its witness.')
  }
  if (
    witness.candidateTrajectoryId !== undefined &&
    derived.schema.trajectoryId !== witness.candidateTrajectoryId
  ) {
    throw new Error('Antigravity Fork candidate trajectory_id differs from its witness.')
  }
  if (
    witness.agyCut !== undefined &&
    (witness.agyCut.cutStepIdx !== derived.cutStep ||
      witness.agyCut.executionId !== witness.sourceCutId)
  ) {
    throw new Error('Antigravity Fork candidate agyCut metadata differs from its witness.')
  }

  const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
  if (summary.stepCount !== derived.cutStep + 1) {
    if (summary.stepCount === 0 && input.lastDispatchedPhase === 'fork' && input.source) {
      checkSourceStillValid()
      assertAnchoredSourceUnchanged({
        rootDir: configuredRoot,
        canonicalRoot,
        parentSegments: ['conversations'],
        leafName: `${input.nativeSessionId}.db`,
        expectedIdentity: snapshotHandle.fileIdentity,
        expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      })
      throw Object.assign(
        new Error(
          'Antigravity Fork candidate summary step_count is still zero; continue Fork to finalize publication.',
        ),
        { code: 'native_file_fork_candidate_missing' },
      )
    }
    throw new Error('Antigravity Fork candidate summary step_count is not synchronized.')
  }

  const physical = computePhysicalDbDigest(
    canonicalRoot,
    input.nativeSessionId,
    configuredRoot,
    snapshotHandle.fileIdentity,
    snapshotHandle.walIdentity,
  )
  const initializedVerified =
    Boolean(witness.initializedAt) &&
    physical.rawHash === witness.initializedPrefixHash &&
    physical.rawBytes === witness.initializedPrefixBytes &&
    derived.prefixRecords === witness.initializedPrefixRecords

  return {
    initializedVerified,
    nativeSessionId: input.nativeSessionId,
    nativeCutId: witness.sourceCutId,
    prefixHash: derived.prefixHash,
    prefixBytes: derived.prefixBytes,
    prefixRecords: derived.prefixRecords,
    idMap: derived.idMap,
    rawHash: physical.rawHash,
    rawBytes: physical.rawBytes,
    rawRecords: derived.prefixRecords,
    nativeStorageRoot: canonicalRoot,
    nativePath: snapshotHandle.canonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(derived.schema.trajectoryId, witness.sourceCutId, derived),
  }
}

export async function executeAgyFork(
  input: AgyForkInput,
  onBeforeAtomicPublish?: (candidate: AgyForkOperationResult) => Promise<void> | void,
): Promise<AgyForkOperationResult> {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const beforePublishHook = onBeforeAtomicPublish ?? input.beforePublish
  if (!input.source) {
    throw new Error('Antigravity Fork execution requires a prepared AgentNativeForkBoundary.')
  }
  const sourceSessionId = input.source.nativeSessionId
  const candidateSessionId =
    input.candidateNativeSessionId ??
    (input.nativeSessionId !== sourceSessionId ? input.nativeSessionId : undefined)
  if (!candidateSessionId) {
    throw new Error(
      'Antigravity Fork requires a pre-allocated zero-Turn candidate nativeSessionId.',
    )
  }
  if (
    input.candidateNativeSessionId &&
    input.nativeSessionId !== sourceSessionId &&
    input.nativeSessionId !== candidateSessionId
  ) {
    throw new Error('Antigravity Fork nativeSessionId disagrees with source and candidate IDs.')
  }
  assertValidSessionUuid(sourceSessionId, 'Antigravity source Session UUID')
  assertValidSessionUuid(candidateSessionId, 'Antigravity candidate Session UUID')
  if (candidateSessionId === sourceSessionId) {
    throw new Error('Antigravity Fork candidate Session UUID must differ from source Session UUID.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)
  const conversationsDir = join(canonicalRoot, 'conversations')
  const convStat = lstatSync(conversationsDir, { bigint: true })
  if (!convStat.isDirectory() || convStat.isSymbolicLink()) {
    throw new Error('Antigravity conversations directory must be an ordinary directory.')
  }

  const sourceHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${sourceSessionId}.db`,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const sourceIdentity = sourceHandle.fileIdentity
  const sourceCommittedImageDigest = sourceHandle.committedImageDigest
  const effectiveInputIds = input.nativeInputIds ?? input.source.nativeInputIds
  let derived: DerivedAgyPrefix
  try {
    derived = deriveVerifiedAgyPrefix(
      sourceHandle.db,
      sourceSessionId,
      canonicalRoot,
      sourceHandle.canonicalDbPath,
      input.source.nativeTurnId,
      {
        proof: sourceHandle.proof,
        configuredRoot,
        ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        ...(input.responseHash !== undefined ? { responseHash: input.responseHash } : {}),
      },
    )
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: sourceIdentity,
      expectedCommittedImageDigest: sourceCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } finally {
    sourceHandle.close()
  }

  if (
    derived.prefixHash !== input.source.prefixHash ||
    input.source.nativeCutId !== derived.resolvedExecutionId ||
    (input.source.agyCut !== undefined &&
      (input.source.agyCut.trajectoryId !== derived.schema.trajectoryId ||
        input.source.agyCut.executionId !== derived.resolvedExecutionId ||
        input.source.agyCut.cutStepIdx !== derived.cutStep))
  ) {
    throw new Error('Prepared Antigravity native prefix changed before Fork.')
  }

  const shellHandle = openCandidateShellSnapshotOrThrowUncertain({
    rootDir: configuredRoot,
    canonicalRoot,
    candidateSessionId,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const shellIdentity = shellHandle.fileIdentity
  const shellWalIdentity = shellHandle.walIdentity
  const shellCommittedImageDigest = shellHandle.committedImageDigest
  const shellCanonicalDbPath = shellHandle.canonicalDbPath
  let shellSchema: ValidatedTrajectorySchema
  let candidateAlreadyPopulated = false
  try {
    shellSchema = validateTrajectoryDatabase(shellHandle.db, candidateSessionId, shellHandle.proof)
    const counts = shellHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!
    if (
      counts.stepCount === derived.cutStep + 1 &&
      counts.genCount === derived.genPrefixRows.length &&
      counts.execCount === derived.execPrefixRows.length
    ) {
      const existingDerived = deriveVerifiedAgyPrefix(
        shellHandle.db,
        candidateSessionId,
        canonicalRoot,
        shellCanonicalDbPath,
        input.source.nativeCutId,
        {
          proof: shellHandle.proof,
          configuredRoot,
          requireNoPostCutRows: true,
          ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        },
      )
      if (
        existingDerived.prefixHash === derived.prefixHash &&
        JSON.stringify(existingDerived.idMap) === JSON.stringify(derived.idMap)
      ) {
        candidateAlreadyPopulated = true
      } else {
        throw new Error('Antigravity Fork candidate database already contains foreign history.')
      }
    } else if (counts.stepCount !== 0 || counts.genCount !== 0 || counts.execCount !== 0) {
      throw new Error('Antigravity Fork candidate database is not a clean zero-Turn shell.')
    }
  } finally {
    shellHandle.close()
  }

  if (candidateAlreadyPopulated) {
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      expectedIdentity: shellIdentity,
      expectedCommittedImageDigest: shellCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    const physical = computePhysicalDbDigest(
      canonicalRoot,
      candidateSessionId,
      configuredRoot,
      shellIdentity,
      shellWalIdentity,
    )
    const completedResult: AgyForkOperationResult = {
      nativeSessionId: candidateSessionId,
      nativeCutId: input.source.nativeCutId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: physical.rawHash,
      rawBytes: physical.rawBytes,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: shellCanonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: shellSchema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
    }
    // Always await witness commit acknowledgement BEFORE mutating conversation_summaries.db!
    if (beforePublishHook) await beforePublishHook(completedResult)
    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      expectedIdentity: shellIdentity,
      expectedCommittedImageDigest: shellCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    ensureSummaryStepCountCas(
      canonicalRoot,
      candidateSessionId,
      derived.cutStep + 1,
      derived.lastUserStepIdx,
      shellSchema.trajectoryId,
    )
    return completedResult
  }

  verifySummaryRowExistsReadOnly(canonicalRoot, candidateSessionId, true, shellSchema.trajectoryId)

  for (const col of derived.schema.stepColumns) {
    if (!shellSchema.stepColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell steps table lacks source column (${col}); failing closed.`,
      )
    }
  }
  for (const col of derived.schema.genColumns) {
    if (!shellSchema.genColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell gen_metadata table lacks source column (${col}); failing closed.`,
      )
    }
  }
  for (const col of derived.schema.execColumns) {
    if (!shellSchema.execColumns.includes(col)) {
      throw new Error(
        `Antigravity candidate shell executor_metadata table lacks source column (${col}); failing closed.`,
      )
    }
  }

  const remap: AgyIdentityRemap = {
    sourceTrajectoryId: derived.schema.trajectoryId,
    targetTrajectoryId: shellSchema.trajectoryId,
    sourceCascadeId: sourceSessionId,
    targetCascadeId: candidateSessionId,
    canonicalAppDataDir: canonicalRoot,
    configuredAppDataDir: configuredRoot,
  }

  const mediaCopies: Array<{ plan: AgyMediaCopyPlan; bytes: Buffer; sha256: string }> = []
  const seenTargetMediaPaths = new Set<string>()
  let copiedMediaBytes = 0

  const remappedSteps = derived.stepPrefixRows.map((row, stepIdx): Record<string, unknown> => {
    const rawMeta = optionalBufferField(row, 'metadata')
    const rawData = requireBufferField(row, derived.schema.stepPayloadColumn)
    const nextMeta = rawMeta ? remapCortexStepMetadata(rawMeta, remap, stepIdx) : null
    const nextStep = remapAgyStep(rawData, remap, stepIdx)

    for (const plan of nextStep.copiedMedia) {
      if (seenTargetMediaPaths.has(plan.targetFilePath)) continue
      seenTargetMediaPaths.add(plan.targetFilePath)

      const verifiedMedia = resolveVerifiedForkMedia(canonicalRoot, sourceSessionId, plan, false)
      const expectedMedia = derived.mediaDigestsByFileName.get(plan.fileName)
      if (
        !expectedMedia ||
        verifiedMedia.bytes.byteLength !== expectedMedia.byteLength ||
        verifiedMedia.sha256 !== expectedMedia.sha256
      ) {
        throw new Error(
          'Antigravity source uploaded media changed between prefix verification and Fork copy.',
        )
      }
      copiedMediaBytes += verifiedMedia.bytes.byteLength
      if (copiedMediaBytes > AGY_MAX_HISTORY_BYTES) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity Fork uploaded media exceeds the 32 MiB history budget.',
          false,
        )
      }
      mediaCopies.push({ plan, bytes: verifiedMedia.bytes, sha256: verifiedMedia.sha256 })
    }

    return {
      ...row,
      metadata: nextMeta,
      [shellSchema.stepPayloadColumn]: nextStep.buffer,
      ...(shellSchema.hasStepFormatColumn ? { step_format: 0 } : {}),
      ...(shellSchema.stepColumns.includes('size') ? { size: nextStep.buffer.byteLength } : {}),
    }
  })

  const remappedGens = derived.genPrefixRows.map((row): Record<string, unknown> => {
    const rawData = requireBufferField(row, 'data')
    const nextData = remapCortexStepGeneratorMetadata(rawData, remap)
    return {
      ...row,
      data: nextData,
      ...(shellSchema.genColumns.includes('size') ? { size: nextData.byteLength } : {}),
    }
  })

  // Verifies same-volume staging (conversations vs brain/<candidateSessionId>) BEFORE any media writes or beforePublishHook!
  const sameVolumeStage = createSameVolumeCandidateStagingDb(
    canonicalRoot,
    candidateSessionId,
    input.stagingLeafName,
  )
  const stagingPath = sameVolumeStage.stagingPath
  let expectedStagedIdentity: AgySqliteFileIdentity
  let stagedPhysical: { rawHash: string; rawBytes: number }

  try {
    let expectedDbBytes: bigint
    const reopenShellHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${candidateSessionId}.db`,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertStagingBound({ expectedSize: 0n })
      const stagingDb = new Database(stagingPath, { fileMustExist: true })
      try {
        sameVolumeStage.assertStagingBound({ expectedSize: 0n })
        initializeStagingFromShell(stagingDb, reopenShellHandle.db, shellSchema)

        if (
          shellSchema.tables.has('trajectory_metadata_blob') &&
          shellSchema.trajectoryMetadataRows.length === 0 &&
          derived.schema.trajectoryMetadataRows.length === 1
        ) {
          const srcBlobRow = derived.schema.trajectoryMetadataRows[0]!
          const srcBlob = srcBlobRow['data']
          if (Buffer.isBuffer(srcBlob)) {
            const remappedBlob = remapCortexTrajectoryMetadata(srcBlob, remap)
            const blobCols = readTableColumns(stagingDb, 'trajectory_metadata_blob')
            const nextBlobRow: Record<string, unknown> = { ...srcBlobRow, data: remappedBlob }
            stagingDb
              .prepare(
                `INSERT INTO "trajectory_metadata_blob" (${blobCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${blobCols.map(() => '?').join(', ')})`,
              )
              .run(...blobCols.map((col) => nextBlobRow[col] ?? null))
          }
        }

        stagingDb.exec('BEGIN IMMEDIATE')
        try {
          const stepCols = shellSchema.stepColumns
          const insertStep = stagingDb.prepare(
            `INSERT INTO "steps" (${stepCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${stepCols.map(() => '?').join(', ')})`,
          )
          for (const row of remappedSteps) {
            insertStep.run(...stepCols.map((col) => row[col] ?? null))
          }

          if (remappedGens.length > 0) {
            const genCols = shellSchema.genColumns
            const insertGen = stagingDb.prepare(
              `INSERT INTO "gen_metadata" (${genCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${genCols.map(() => '?').join(', ')})`,
            )
            for (const row of remappedGens) {
              insertGen.run(...genCols.map((col) => row[col] ?? null))
            }
          }

          const execCols = shellSchema.execColumns
          const insertExec = stagingDb.prepare(
            `INSERT INTO "executor_metadata" (${execCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${execCols.map(() => '?').join(', ')})`,
          )
          for (const row of derived.execPrefixRows) {
            insertExec.run(...execCols.map((col) => row[col] ?? null))
          }

          stagingDb.exec('COMMIT')
        } catch (error) {
          if (stagingDb.inTransaction) stagingDb.exec('ROLLBACK')
          throw error
        }

        verifySqliteIntegrityOk(stagingDb)
        expectedDbBytes = measureOpenSqliteExpectedBytes(stagingDb)
        sameVolumeStage.assertStagingBound({ expectedSize: expectedDbBytes })
      } finally {
        stagingDb.close()
      }
    } finally {
      reopenShellHandle.close()
    }

    if (expectedDbBytes > BigInt(AGY_MAX_HISTORY_BYTES)) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity Fork staged SQLite database exceeds the 32 MiB history budget.',
        false,
      )
    }
    sameVolumeStage.fsyncVerifiedStaging(expectedDbBytes)

    const candidateCutMeta = buildAgyForkCutMetadata(
      shellSchema.trajectoryId,
      input.source.nativeCutId,
      derived,
    )
    const prePublishCandidate: AgyForkOperationResult = {
      nativeSessionId: candidateSessionId,
      nativeCutId: input.source.nativeCutId,
      prefixHash: derived.prefixHash,
      prefixBytes: derived.prefixBytes,
      prefixRecords: derived.prefixRecords,
      idMap: derived.idMap,
      rawHash: '',
      rawBytes: 0,
      rawRecords: derived.prefixRecords,
      nativeStorageRoot: canonicalRoot,
      nativePath: shellCanonicalDbPath,
      cutStep: derived.cutStep,
      trajectoryId: shellSchema.trajectoryId,
      sourceTrajectoryId: derived.schema.trajectoryId,
      agyCut: candidateCutMeta,
    }

    if (mediaCopies.length > 0) {
      const uploadedDir = ensureSafeDirectoryChain(canonicalRoot, [
        'brain',
        candidateSessionId,
        '.user_uploaded',
      ])
      for (const item of mediaCopies) {
        writeIdempotentPrivateFile(item.plan.targetFilePath, canonicalRoot, item.bytes, item.sha256)
        const copiedBytes = readVerifiedUploadedMediaFile(
          canonicalRoot,
          candidateSessionId,
          item.plan.targetFilePath,
          AGY_MAX_HISTORY_BYTES,
        )
        const expectedMedia = derived.mediaDigestsByFileName.get(item.plan.fileName)
        if (
          !expectedMedia ||
          copiedBytes.byteLength !== expectedMedia.byteLength ||
          sha256Hex(copiedBytes) !== expectedMedia.sha256
        ) {
          throw new Error(
            'Antigravity copied candidate uploaded media failed frozen digest verification.',
          )
        }
      }
      fsyncDirectoryBestEffort(uploadedDir)
    }

    // Verify staged candidate DB produces the exact frozen normalized prefixHash AND pin its fileIdentity before publishing!
    const stagedSnapshot = openCommittedSqliteSnapshot({
      rootDir: canonicalRoot,
      canonicalRoot,
      parentSegments: ['brain', candidateSessionId],
      leafName: sameVolumeStage.stagingLeafName,
      maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    try {
      sameVolumeStage.assertAnchoredIdentityMatchesCreated(
        stagedSnapshot.fileIdentity,
        expectedDbBytes,
      )
      const stagedDerived = deriveVerifiedAgyPrefix(
        stagedSnapshot.db,
        candidateSessionId,
        canonicalRoot,
        stagedSnapshot.canonicalDbPath,
        input.source.nativeCutId,
        {
          proof: stagedSnapshot.proof,
          configuredRoot,
          requireNoPostCutRows: true,
          ...(effectiveInputIds !== undefined ? { nativeInputIds: effectiveInputIds } : {}),
        },
      )
      if (stagedDerived.prefixHash !== derived.prefixHash) {
        throw new Error(
          'Antigravity Fork staged candidate prefixHash disagrees with frozen source prefixHash.',
        )
      }
      expectedStagedIdentity = stagedSnapshot.fileIdentity
    } finally {
      stagedSnapshot.close()
    }

    // Compute pinned staged physical digest before rename so post-publish physical digest is strictly bound.
    const stagedView = openAnchoredLockedSqliteView(
      canonicalRoot,
      ['brain', candidateSessionId],
      sameVolumeStage.stagingLeafName,
      { acquireSharedLock: true, openWal: true, openShm: true, checkJournal: true },
    )
    try {
      if (
        stagedView.hasWal ||
        stagedView.hasShm ||
        stagedView.hasJournal ||
        !identitiesExactMatch(stagedView.fileIdentity, expectedStagedIdentity)
      ) {
        throw new Error('Antigravity Fork staged database changed before publication.')
      }
      const stagedHasher = createHash('sha256')
      stagedHasher.update('pact-agy-sqlite-physical-v1\0')
      stagedHasher.update('main\0')
      let offset = 0
      while (offset < stagedView.byteLength) {
        const chunk = stagedView.readAt(offset, Math.min(64 * 1024, stagedView.byteLength - offset))
        offset += chunk.byteLength
        stagedHasher.update(chunk)
      }
      const verify = stagedView.verifyUnchanged()
      if (!verify.unchanged) {
        throw new Error('Antigravity Fork staged database changed during digest verification.')
      }
      stagedPhysical = { rawHash: stagedHasher.digest('hex'), rawBytes: stagedView.byteLength }
    } finally {
      stagedView.close()
    }

    if (beforePublishHook) {
      await beforePublishHook(prePublishCandidate)
    }

    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${sourceSessionId}.db`,
      expectedIdentity: sourceIdentity,
      expectedCommittedImageDigest: sourceCommittedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    publishStagedCandidateOrThrow({
      canonicalRoot,
      candidateSessionId,
      stagedLeafName: sameVolumeStage.stagingLeafName,
      expectedTargetIdentity: shellIdentity,
      expectedStagedIdentity,
    })
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    sameVolumeStage.cleanup()
  }

  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  // Verify the published file is the exact renamed staged inode (dev/ino/size/mtimeNs; rename may update ctimeNs)
  // and bind computePhysicalDbDigest strictly to that published identity + exact staged rawHash/rawBytes
  // BEFORE advancing the summary CAS!
  const publishedIdentity = readAnchoredFileIdentity(
    canonicalRoot,
    ['conversations'],
    `${candidateSessionId}.db`,
  )
  if (
    publishedIdentity.dev !== expectedStagedIdentity.dev ||
    publishedIdentity.ino !== expectedStagedIdentity.ino ||
    publishedIdentity.size !== expectedStagedIdentity.size ||
    publishedIdentity.mtimeNs !== expectedStagedIdentity.mtimeNs
  ) {
    throw Object.assign(
      new Error('Antigravity Fork published candidate database changed after atomic rename.'),
      { code: 'UNCERTAIN' },
    )
  }
  const physical = computePhysicalDbDigest(
    canonicalRoot,
    candidateSessionId,
    configuredRoot,
    publishedIdentity,
    null,
  )
  if (
    physical.rawHash !== stagedPhysical.rawHash ||
    physical.rawBytes !== stagedPhysical.rawBytes
  ) {
    throw Object.assign(
      new Error('Antigravity Fork published candidate digest disagrees with verified staging.'),
      { code: 'UNCERTAIN' },
    )
  }
  ensureSummaryStepCountCas(
    canonicalRoot,
    candidateSessionId,
    derived.cutStep + 1,
    derived.lastUserStepIdx,
    shellSchema.trajectoryId,
  )
  return {
    nativeSessionId: candidateSessionId,
    nativeCutId: input.source.nativeCutId,
    prefixHash: derived.prefixHash,
    prefixBytes: derived.prefixBytes,
    prefixRecords: derived.prefixRecords,
    idMap: derived.idMap,
    rawHash: physical.rawHash,
    rawBytes: physical.rawBytes,
    rawRecords: derived.prefixRecords,
    nativeStorageRoot: canonicalRoot,
    nativePath: shellCanonicalDbPath,
    cutStep: derived.cutStep,
    trajectoryId: shellSchema.trajectoryId,
    sourceTrajectoryId: derived.schema.trajectoryId,
    agyCut: buildAgyForkCutMetadata(shellSchema.trajectoryId, input.source.nativeCutId, derived),
  }
}
