import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import type { AgentPromptImage, AgyRebuildInitializationWitness } from '@pact/agent-runtime'
import type { ConversationImage } from '@pact/contracts/images'

import { agyRebuildInitializationWitnessSchema } from '@pact/contracts'

import { AgentExecutionError } from '../agent-execution-error'
import {
  type AgySqliteFileIdentity,
  identitiesExactMatch,
  openAnchoredLockedSqliteView,
} from '../agy-sqlite-file'
import { assertIdentityNotCancelledOrExpired } from '../agy-sqlite-image'
import { requireNativeImageReference } from '../native-image-content'
import {
  AGY_MAX_HISTORY_BYTES,
  AGY_MAX_REBUILD_CHUNKS,
  AGY_TEXT_BUDGET_BYTES,
  type AgyConfirmRebuildColdLoadInput,
  type AgyRebuildSeedChunk,
  type AgyRebuildSeedInput,
  type AgyRebuildSeedResult,
  type AgyRebuildSeedVerificationInput,
  assertValidSessionUuid,
  CORTEX_STEP_STATUS_DONE,
  CORTEX_STEP_TYPE_PLANNER_RESPONSE,
  CORTEX_STEP_TYPE_USER_INPUT,
  ensureSafeDirectoryChain,
  EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
  fsyncDirectoryBestEffort,
  isInsideDirectory,
  isPlainObject,
  quoteSqlIdentifier,
  resolveStorageRoot,
  sha256Hex,
  statsMatch,
  UUID_PATTERN,
  verifySafeDirectoryChainIfPresent,
} from './constants-and-types'
import {
  assertCompatibleStepRowFormat,
  decodeAgyStep,
  decodeExecutorMetadata,
  encodeAgyPlannerResponseStep,
  encodeAgyUserInputStep,
  encodeCortexStepMetadata,
  encodeExecutorMetadata,
  extractEffectiveStepMetadata,
  parseMediaUriToUploadedFile,
  readVerifiedUploadedMediaFile,
} from './cortex-codec'
import { decodeUtf8Strict } from './protobuf-wire'
import {
  assertAnchoredSourceUnchanged,
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
  measureTableColumnsTotalBytes,
  type ValidatedTrajectorySchema,
  validateTrajectoryDatabase,
} from './sqlite-validator'

export function serializeAgyRebuildSeed(input: {
  rebuildId: string
  sourceHash?: string
  chunks: readonly AgyRebuildSeedChunk[]
}): {
  expectedUserText: string
  expectedAssistantText: string
  seedHash: string
  chunkCount: number
  seedExecutionId: string
  userStepId: string
  assistantStepId: string
} {
  if (!UUID_PATTERN.test(input.rebuildId)) {
    throw new Error('Invalid Antigravity rebuildId UUID.')
  }
  if (input.chunks.length > AGY_MAX_REBUILD_CHUNKS) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild source exceeds the 4,096-chunk limit.',
      false,
    )
  }
  const hasImages = input.chunks.some((chunk) => chunk.kind === 'image')
  const manifest = JSON.stringify({
    pactContext: true,
    formatVersion: hasImages ? 'pact-agy-context-v2' : 'pact-agy-context-v1',
    pactRebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { pactSourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })
  if (Buffer.byteLength(manifest, 'utf8') > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild seed manifest exceeds the 8 MiB text budget; no history was truncated.',
      false,
    )
  }
  const seedHash = sha256Hex(manifest)
  const expectedAssistantText = 'No response requested.'
  const deriveUuid = (domain: string): string => {
    const hex = sha256Hex(`${input.rebuildId}:${domain}:${seedHash}`)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return {
    expectedUserText: manifest,
    expectedAssistantText,
    seedHash,
    chunkCount: input.chunks.length,
    seedExecutionId: deriveUuid('agy-seed-exec'),
    userStepId: deriveUuid('agy-seed-user-step'),
    assistantStepId: deriveUuid('agy-seed-assistant-step'),
  }
}

function readVerifiedImmutableImage(image: AgentPromptImage): Buffer {
  const before = lstatSync(image.path, { bigint: true })
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size !== BigInt(image.bytes)
  ) {
    throw new AgentExecutionError('protocol_error', 'The saved Pact image is unavailable.', false)
  }
  const fd = openSync(image.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(before, opened)) {
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    const namedAfter = lstatSync(image.path, { bigint: true })
    if (
      bytes.byteLength !== image.bytes ||
      !statsMatch(before, after) ||
      !statsMatch(before, namedAfter) ||
      sha256Hex(bytes) !== image.sha256
    ) {
      throw new AgentExecutionError('protocol_error', 'The saved Pact image changed.', false)
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

const AGY_REBUILD_RECEIPT_FILENAME = '.pact-rebuild-verified-v1.json'

const AGY_REBUILD_RECEIPT_MAX_BYTES = 16 * 1024

function readRebuildColdLoadReceiptIfPresent(
  canonicalRoot: string,
  nativeSessionId: string,
  expected: {
    sourceHash?: string | undefined
    pbSha256: string
    pbBytes: number
  },
): AgyRebuildInitializationWitness | undefined {
  const brainChain = verifySafeDirectoryChainIfPresent(
    canonicalRoot,
    ['brain', nativeSessionId],
    'Antigravity rebuild receipt',
  )
  if (!brainChain.exists) return undefined
  const receiptPath = join(brainChain.canonicalDir, AGY_REBUILD_RECEIPT_FILENAME)
  let stat: BigIntStats
  try {
    stat = lstatSync(receiptPath, { bigint: true })
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return undefined
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Antigravity rebuild cold-load verification receipt is linked or unsupported.')
  }
  if (stat.size <= 0n || stat.size > BigInt(AGY_REBUILD_RECEIPT_MAX_BYTES)) {
    throw new Error('Antigravity rebuild cold-load verification receipt size is invalid.')
  }
  const realReceipt = realpathSync(receiptPath)
  if (realReceipt !== receiptPath || !isInsideDirectory(brainChain.canonicalDir, realReceipt)) {
    throw new Error('Antigravity rebuild cold-load verification receipt escaped its session brain.')
  }
  let rawText: string
  const fd = openSync(receiptPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (!statsMatch(stat, opened) || realpathSync(receiptPath) !== receiptPath) {
      throw new Error('Antigravity rebuild cold-load verification receipt changed while opening.')
    }
    const bytes = readFileSync(fd)
    const after = fstatSync(fd, { bigint: true })
    if (BigInt(bytes.byteLength) !== stat.size || !statsMatch(stat, after)) {
      throw new Error('Antigravity rebuild cold-load verification receipt changed while reading.')
    }
    rawText = decodeUtf8Strict(bytes)
  } finally {
    closeSync(fd)
  }

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(rawText)
  } catch {
    throw new Error('Antigravity rebuild cold-load verification receipt is not valid JSON.')
  }
  if (
    !isPlainObject(parsedJson) ||
    parsedJson['version'] !== 'pact-agy-rebuild-verified-v1' ||
    parsedJson['nativeSessionId'] !== nativeSessionId ||
    parsedJson['pbSha256'] !== expected.pbSha256 ||
    parsedJson['pbBytes'] !== expected.pbBytes ||
    parsedJson['stepCount'] !== 2 ||
    typeof parsedJson['sourceHash'] !== 'string' ||
    (expected.sourceHash !== undefined && parsedJson['sourceHash'] !== expected.sourceHash) ||
    typeof parsedJson['coldLoadVerifiedAt'] !== 'string'
  ) {
    throw new Error('Antigravity rebuild cold-load verification receipt does not match seed state.')
  }

  return agyRebuildInitializationWitnessSchema.parse({
    kind: 'agy_rebuild_v1',
    nativeSessionId,
    pbSha256: expected.pbSha256,
    pbBytes: expected.pbBytes,
    stepCount: 2,
    sourceHash: parsedJson['sourceHash'],
    coldLoadVerifiedAt: parsedJson['coldLoadVerifiedAt'],
  })
}

export function confirmAgyRebuildColdLoad(
  input: AgyConfirmRebuildColdLoadInput,
): AgyRebuildInitializationWitness {
  assertValidSessionUuid(input.nativeSessionId)
  if (!/^[a-f0-9]{64}$/u.test(input.sourceHash)) {
    throw new Error('Invalid Antigravity rebuild sourceHash.')
  }
  if (!/^[a-f0-9]{64}$/u.test(input.pbSha256)) {
    throw new Error('Invalid Antigravity rebuild pbSha256.')
  }
  if (
    typeof input.pbBytes !== 'number' ||
    !Number.isSafeInteger(input.pbBytes) ||
    input.pbBytes <= 0 ||
    input.pbBytes > 64 * 1024 * 1024 ||
    input.stepCount !== 2
  ) {
    throw new Error('Invalid Antigravity rebuild cold-load confirmation parameters.')
  }

  const configuredRoot = resolveStorageRoot(input.storageRoot ?? input.appDataDir)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${input.nativeSessionId}.db`,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)
    const preflightBytes =
      measureTableColumnsTotalBytes(db, 'steps', ['metadata', schema.stepPayloadColumn]) +
      measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild database exceeds the 32 MiB history budget.',
        false,
      )
    }
    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const stepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" ORDER BY idx ASC`
    const stepRows = db
      .prepare<
        [],
        {
          idx: number
          step_type: number
          status: number
          has_subtrajectory: number
          metadata: Buffer | null
          step_blob: Buffer | null
          step_format?: unknown
        }
      >(stepSelectSql)
      .all()
    const genCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
      .get()!
    const execRows = db
      .prepare<[], { idx: number; data: Buffer }>(
        'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
      )
      .all()

    if (stepRows.length !== 2 || genCountRow.count !== 0 || execRows.length !== 1) {
      throw new Error(
        'Additional native work prevents an initialization-only Antigravity rebuild confirmation.',
      )
    }
    const userRow = stepRows[0]!
    const assistantRow = stepRows[1]!
    const exec0 = execRows[0]!
    assertCompatibleStepRowFormat(userRow.step_format, schema.hasStepFormatColumn, 0)
    assertCompatibleStepRowFormat(assistantRow.step_format, schema.hasStepFormatColumn, 1)
    if (
      userRow.idx !== 0 ||
      userRow.step_type !== CORTEX_STEP_TYPE_USER_INPUT ||
      userRow.status !== CORTEX_STEP_STATUS_DONE ||
      userRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(userRow.step_blob) ||
      assistantRow.idx !== 1 ||
      assistantRow.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE ||
      assistantRow.status !== CORTEX_STEP_STATUS_DONE ||
      assistantRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(assistantRow.step_blob) ||
      exec0.idx !== 0 ||
      !Buffer.isBuffer(exec0.data)
    ) {
      throw new Error('Antigravity rebuild seeded step headers do not match expected structure.')
    }

    const decodedUser = decodeAgyStep(userRow.step_blob)
    const decodedExec0 = decodeExecutorMetadata(exec0.data)
    if (
      !decodedUser.userInput ||
      decodedExec0.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
      decodedExec0.numGeneratorInvocations !== 0 ||
      decodedExec0.lastStepIdx !== 1
    ) {
      throw new Error('Antigravity rebuild seed payload structure is invalid.')
    }

    let parsedManifest: unknown
    try {
      parsedManifest = JSON.parse(decodedUser.userInput.text)
    } catch {
      throw new Error('Antigravity rebuild user seed text is not a valid Pact manifest.')
    }
    if (
      !isPlainObject(parsedManifest) ||
      parsedManifest['pactContext'] !== true ||
      parsedManifest['pactSourceHash'] !== input.sourceHash
    ) {
      throw new Error('Antigravity rebuild seed pactSourceHash does not match expected sourceHash.')
    }

    const actualPbBytes =
      userRow.step_blob.byteLength + assistantRow.step_blob.byteLength + exec0.data.byteLength
    const actualPbSha256 = createHash('sha256')
      .update('pact-agy-seed-pb-v1\0')
      .update(userRow.step_blob)
      .update('\0')
      .update(assistantRow.step_blob)
      .update('\0')
      .update(exec0.data)
      .digest('hex')
    if (actualPbBytes !== input.pbBytes || actualPbSha256 !== input.pbSha256) {
      throw new Error('Antigravity rebuild Protobuf seed digest mismatch during cold-load confirm.')
    }

    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
    const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
    if (summary.stepCount !== 2) {
      throw new Error('Antigravity conversation_summaries.step_count is not synchronized.')
    }
  } finally {
    snapshotHandle.close()
  }

  const existingReceipt = readRebuildColdLoadReceiptIfPresent(
    canonicalRoot,
    input.nativeSessionId,
    {
      sourceHash: input.sourceHash,
      pbSha256: input.pbSha256,
      pbBytes: input.pbBytes,
    },
  )
  if (existingReceipt) return existingReceipt

  const brainSessionDir = ensureSafeDirectoryChain(canonicalRoot, ['brain', input.nativeSessionId])
  const receiptPath = join(brainSessionDir, AGY_REBUILD_RECEIPT_FILENAME)
  try {
    const existingStat = lstatSync(receiptPath, { bigint: true })
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error('Existing Antigravity rebuild receipt path is a symlink or non-file.')
    }
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') throw error
  }

  const coldLoadVerifiedAt = new Date().toISOString()
  const receiptPayload = JSON.stringify({
    version: 'pact-agy-rebuild-verified-v1',
    nativeSessionId: input.nativeSessionId,
    sourceHash: input.sourceHash,
    pbSha256: input.pbSha256,
    pbBytes: input.pbBytes,
    stepCount: 2 as const,
    coldLoadVerifiedAt,
  })
  const tmpReceiptPath = `${receiptPath}.tmp-${randomUUID()}`
  try {
    const fd = openSync(
      tmpReceiptPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
    try {
      writeFileSync(fd, receiptPayload, 'utf8')
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpReceiptPath, receiptPath)
    fsyncDirectoryBestEffort(brainSessionDir)
  } finally {
    try {
      rmSync(tmpReceiptPath, { force: true })
    } catch {
      /* Best-effort temp receipt cleanup. */
    }
  }

  return agyRebuildInitializationWitnessSchema.parse({
    kind: 'agy_rebuild_v1',
    nativeSessionId: input.nativeSessionId,
    pbSha256: input.pbSha256,
    pbBytes: input.pbBytes,
    stepCount: 2,
    sourceHash: input.sourceHash,
    coldLoadVerifiedAt,
  })
}

function verifyAgyRebuildSeedInternal(
  input: AgyRebuildSeedVerificationInput,
  options: {
    requireNoAdditionalWork: boolean
    requireColdLoadReceipt: boolean
    checkSummarySynchronized: boolean
    omitWitness?: boolean
  },
): AgyRebuildSeedResult {
  assertValidSessionUuid(input.nativeSessionId)
  const configuredRoot = resolveStorageRoot(input.storageRoot)
  const rootStat = lstatSync(configuredRoot, { bigint: true })
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Antigravity native storage root must be an ordinary directory.')
  }
  const canonicalRoot = realpathSync(configuredRoot)

  const serialized = serializeAgyRebuildSeed({
    rebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })
  if (input.expectedSeedHash && serialized.seedHash !== input.expectedSeedHash) {
    throw new Error('Antigravity rebuild seed manifest hash mismatch.')
  }

  const imageChunks = input.chunks.filter(
    (chunk): chunk is Extract<AgyRebuildSeedChunk, { kind: 'image' }> => chunk.kind === 'image',
  )

  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: configuredRoot,
    canonicalRoot,
    parentSegments: ['conversations'],
    leafName: `${input.nativeSessionId}.db`,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const db = snapshotHandle.db
  try {
    const schema = validateTrajectoryDatabase(db, input.nativeSessionId, snapshotHandle.proof)
    if (input.expectedTrajectoryId && schema.trajectoryId !== input.expectedTrajectoryId) {
      throw new Error('Antigravity rebuild trajectory_id changed.')
    }
    const preflightSeedBytes =
      measureTableColumnsTotalBytes(db, 'steps', ['metadata', schema.stepPayloadColumn]) +
      measureTableColumnsTotalBytes(db, 'executor_metadata', ['data'])
    if (preflightSeedBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild database exceeds the 32 MiB history budget.',
        false,
      )
    }

    const stepPayloadSql = quoteSqlIdentifier(schema.stepPayloadColumn)
    const stepSelectSql = schema.hasStepFormatColumn
      ? `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob, step_format FROM "steps" ORDER BY idx ASC`
      : `SELECT idx, step_type, status, has_subtrajectory, metadata, ${stepPayloadSql} AS step_blob FROM "steps" ORDER BY idx ASC`
    const stepRows = db
      .prepare<
        [],
        {
          idx: number
          step_type: number
          status: number
          has_subtrajectory: number
          metadata: Buffer | null
          step_blob: Buffer | null
          step_format?: unknown
        }
      >(stepSelectSql)
      .all()
    const genCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "gen_metadata"')
      .get()!
    const execRows = db
      .prepare<[], { idx: number; data: Buffer }>(
        'SELECT idx, data FROM "executor_metadata" ORDER BY idx ASC',
      )
      .all()

    if (stepRows.length < 2 || execRows.length < 1) {
      throw new Error('Antigravity rebuild candidate does not contain the complete seeded steps.')
    }
    if (options.requireNoAdditionalWork) {
      if (stepRows.length !== 2 || genCountRow.count !== 0 || execRows.length !== 1) {
        throw new Error(
          'Additional native work prevents an initialization-only Antigravity rebuild confirmation.',
        )
      }
    }

    const userRow = stepRows[0]!
    const assistantRow = stepRows[1]!
    assertCompatibleStepRowFormat(userRow.step_format, schema.hasStepFormatColumn, 0)
    assertCompatibleStepRowFormat(assistantRow.step_format, schema.hasStepFormatColumn, 1)
    if (
      userRow.idx !== 0 ||
      userRow.step_type !== CORTEX_STEP_TYPE_USER_INPUT ||
      userRow.status !== CORTEX_STEP_STATUS_DONE ||
      userRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(userRow.step_blob) ||
      assistantRow.idx !== 1 ||
      assistantRow.step_type !== CORTEX_STEP_TYPE_PLANNER_RESPONSE ||
      assistantRow.status !== CORTEX_STEP_STATUS_DONE ||
      assistantRow.has_subtrajectory !== 0 ||
      !Buffer.isBuffer(assistantRow.step_blob)
    ) {
      throw new Error('Antigravity rebuild seeded step headers do not match expected structure.')
    }

    const decodedUser = decodeAgyStep(userRow.step_blob)
    const decodedAssistant = decodeAgyStep(assistantRow.step_blob)
    const userMeta = extractEffectiveStepMetadata(userRow.metadata, decodedUser)
    const assistantMeta = extractEffectiveStepMetadata(assistantRow.metadata, decodedAssistant)

    if (
      !decodedUser.userInput ||
      decodedUser.userInput.userResponse !== serialized.expectedUserText ||
      decodedUser.userInput.itemsText !== serialized.expectedUserText ||
      sha256Hex(decodedUser.userInput.text) !== serialized.seedHash ||
      userMeta.executionId !== serialized.seedExecutionId ||
      userMeta.stepId !== serialized.userStepId ||
      userMeta.sourceTrajectoryStepInfo?.trajectoryId !== schema.trajectoryId ||
      userMeta.sourceTrajectoryStepInfo?.cascadeId !== input.nativeSessionId ||
      (userMeta.sourceTrajectoryStepInfo?.stepIndex ?? 0) !== 0
    ) {
      throw new Error(
        'Antigravity rebuild user seed step did not preserve complete source content.',
      )
    }

    if (decodedUser.userInput.media.length !== imageChunks.length) {
      throw new Error('Antigravity rebuild media count does not match image chunk manifest.')
    }
    for (const [imgIdx, imgChunk] of imageChunks.entries()) {
      const media = decodedUser.userInput.media[imgIdx]!
      if (
        media.mimeType !== imgChunk.image.mediaType ||
        !media.inlineData ||
        media.inlineData.byteLength !== imgChunk.image.bytes ||
        sha256Hex(media.inlineData) !== imgChunk.image.sha256 ||
        !media.uri
      ) {
        throw new Error('Antigravity rebuild inline media does not match immutable image digest.')
      }
      const plan = parseMediaUriToUploadedFile(
        media.uri,
        canonicalRoot,
        input.nativeSessionId,
        input.nativeSessionId,
        configuredRoot,
      )
      if (!plan) {
        throw new Error('Antigravity rebuild media URI is outside candidate .user_uploaded.')
      }
      const diskBytes = readVerifiedUploadedMediaFile(
        canonicalRoot,
        input.nativeSessionId,
        plan.sourceFilePath,
        AGY_MAX_HISTORY_BYTES,
      )
      if (
        diskBytes.byteLength !== imgChunk.image.bytes ||
        sha256Hex(diskBytes) !== imgChunk.image.sha256
      ) {
        throw new Error('Antigravity rebuild uploaded media file digest mismatch.')
      }
    }

    if (
      !decodedAssistant.plannerResponse ||
      decodedAssistant.plannerResponse.canonicalText !== serialized.expectedAssistantText ||
      assistantMeta.executionId !== serialized.seedExecutionId ||
      assistantMeta.stepId !== serialized.assistantStepId ||
      assistantMeta.sourceTrajectoryStepInfo?.trajectoryId !== schema.trajectoryId ||
      assistantMeta.sourceTrajectoryStepInfo?.cascadeId !== input.nativeSessionId ||
      assistantMeta.sourceTrajectoryStepInfo?.stepIndex !== 1
    ) {
      throw new Error('Antigravity rebuild assistant acknowledgement step mismatch.')
    }

    const exec0 = execRows[0]!
    if (exec0.idx !== 0 || !Buffer.isBuffer(exec0.data)) {
      throw new Error('Antigravity rebuild executor_metadata[0] is missing.')
    }
    const decodedExec0 = decodeExecutorMetadata(exec0.data)
    if (
      decodedExec0.executionId !== serialized.seedExecutionId ||
      decodedExec0.terminationReason !== EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL ||
      decodedExec0.numGeneratorInvocations !== 0 ||
      decodedExec0.lastStepIdx !== 1
    ) {
      throw new Error('Antigravity rebuild executor_metadata[0] linkage mismatch.')
    }

    assertAnchoredSourceUnchanged({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
      expectedIdentity: snapshotHandle.fileIdentity,
      expectedCommittedImageDigest: snapshotHandle.committedImageDigest,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })

    if (options.checkSummarySynchronized) {
      const summary = verifySummaryRowExistsReadOnly(canonicalRoot, input.nativeSessionId, false)
      if (options.requireNoAdditionalWork ? summary.stepCount !== 2 : summary.stepCount < 2) {
        throw new Error('Antigravity conversation_summaries.step_count is not synchronized.')
      }
    }

    const pbBytes =
      userRow.step_blob.byteLength + assistantRow.step_blob.byteLength + exec0.data.byteLength
    const pbSha256 = createHash('sha256')
      .update('pact-agy-seed-pb-v1\0')
      .update(userRow.step_blob)
      .update('\0')
      .update(assistantRow.step_blob)
      .update('\0')
      .update(exec0.data)
      .digest('hex')
    if (
      (input.expectedPbSha256 && pbSha256 !== input.expectedPbSha256) ||
      (input.expectedPbBytes !== undefined && pbBytes !== input.expectedPbBytes)
    ) {
      throw new Error('Antigravity rebuild Protobuf seed digest mismatch.')
    }

    const physical = computePhysicalDbDigest(
      canonicalRoot,
      input.nativeSessionId,
      configuredRoot,
      snapshotHandle.fileIdentity,
      snapshotHandle.walIdentity,
    )
    const recordCount = stepRows.length + genCountRow.count + execRows.length
    if (
      options.requireNoAdditionalWork &&
      ((input.expectedVerifiedPrefixSha256 &&
        physical.rawHash !== input.expectedVerifiedPrefixSha256) ||
        (input.expectedVerifiedPrefixBytes !== undefined &&
          physical.rawBytes !== input.expectedVerifiedPrefixBytes) ||
        (input.expectedRecordCount !== undefined && recordCount !== input.expectedRecordCount))
    ) {
      throw new Error('Antigravity rebuild physical database prefix changed after initialization.')
    }

    let initializationWitness: AgyRebuildInitializationWitness | undefined
    if (!options.omitWitness) {
      initializationWitness = readRebuildColdLoadReceiptIfPresent(
        canonicalRoot,
        input.nativeSessionId,
        {
          sourceHash: input.sourceHash,
          pbSha256,
          pbBytes,
        },
      )
      if (options.requireColdLoadReceipt && !initializationWitness) {
        throw new Error(
          'Antigravity rebuild cold-load verification receipt (.pact-rebuild-verified-v1.json) is missing.',
        )
      }
    }

    return {
      nativeSessionId: input.nativeSessionId,
      trajectoryId: schema.trajectoryId,
      seedHash: serialized.seedHash,
      chunkCount: serialized.chunkCount,
      stepCount: 2,
      pbSha256,
      pbBytes,
      verifiedPrefixBytes: physical.rawBytes,
      verifiedPrefixSha256: physical.rawHash,
      recordCount,
      nativeStorageRoot: canonicalRoot,
      nativePath: snapshotHandle.canonicalDbPath,
      ...(initializationWitness ? { initializationWitness } : {}),
    }
  } finally {
    snapshotHandle.close()
  }
}

export function verifyAgyRebuildSeed(input: AgyRebuildSeedVerificationInput): AgyRebuildSeedResult {
  return verifyAgyRebuildSeedInternal(input, {
    requireNoAdditionalWork: input.rejectAdditionalWork !== false,
    requireColdLoadReceipt: input.rejectAdditionalWork === true,
    checkSummarySynchronized: true,
  })
}

export function writeAgyRebuildSeed(input: AgyRebuildSeedInput): AgyRebuildSeedResult {
  assertValidSessionUuid(input.nativeSessionId)
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

  const serialized = serializeAgyRebuildSeed({
    rebuildId: input.rebuildId,
    ...(input.sourceHash !== undefined ? { sourceHash: input.sourceHash } : {}),
    chunks: input.chunks,
  })

  const imageChunks = input.chunks.filter(
    (chunk): chunk is Extract<AgyRebuildSeedChunk, { kind: 'image' }> => chunk.kind === 'image',
  )
  const providedImages = input.images ?? []
  if (imageChunks.length > 0 && providedImages.length < imageChunks.length) {
    throw new AgentExecutionError(
      'protocol_error',
      'Antigravity rebuild image sources are incomplete.',
      false,
    )
  }

  let imageById = new Map<string, AgentPromptImage>()
  for (const img of providedImages) imageById.set(img.id, img)

  const userTextBytes = Buffer.byteLength(serialized.expectedUserText, 'utf8')
  const assistantTextBytes = Buffer.byteLength(serialized.expectedAssistantText, 'utf8')
  // Preflight accounts for BOTH user_response and items (2x expectedUserText) plus assistant text & images.
  if (userTextBytes * 2 + assistantTextBytes > AGY_MAX_HISTORY_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild encoded text exceeds the 32 MiB history budget.',
      false,
    )
  }

  let totalMediaBytes = 0
  const verifiedMediaPayloads: Array<{
    chunkImage: ConversationImage
    bytes: Buffer
    ext: string
  }> = []
  for (const imgChunk of imageChunks) {
    const resolved = imageById.get(imgChunk.image.id)
    if (!resolved) {
      throw new AgentExecutionError(
        'protocol_error',
        'Antigravity rebuild image source is missing.',
        false,
      )
    }
    requireNativeImageReference(resolved, imgChunk.image)
    const bytes = readVerifiedImmutableImage(resolved)
    totalMediaBytes += bytes.byteLength
    if (userTextBytes * 2 + assistantTextBytes + totalMediaBytes > AGY_MAX_HISTORY_BYTES) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity rebuild text and images exceed the 32 MiB history budget.',
        false,
      )
    }
    const ext =
      imgChunk.image.mediaType === 'image/png'
        ? 'png'
        : imgChunk.image.mediaType === 'image/jpeg'
          ? 'jpg'
          : 'webp'
    verifiedMediaPayloads.push({ chunkImage: imgChunk.image, bytes, ext })
  }

  const shellHandle = openCandidateShellSnapshotOrThrowUncertain({
    rootDir: configuredRoot,
    canonicalRoot,
    candidateSessionId: input.nativeSessionId,
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
  })
  const shellIdentity = shellHandle.fileIdentity
  let alreadySeeded = false
  let shellSchema: ValidatedTrajectorySchema
  try {
    shellSchema = validateTrajectoryDatabase(
      shellHandle.db,
      input.nativeSessionId,
      shellHandle.proof,
    )
    const counts = shellHandle.db
      .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
        `SELECT
          (SELECT COUNT(*) FROM "steps") AS stepCount,
          (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
          (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
      )
      .get()!

    if (counts.stepCount === 2 && counts.genCount === 0 && counts.execCount === 1) {
      alreadySeeded = true
    } else if (counts.stepCount !== 0 || counts.genCount !== 0 || counts.execCount !== 0) {
      throw new Error('Antigravity rebuild candidate database is not an empty zero-Turn shell.')
    }
  } finally {
    shellHandle.close()
  }

  if (alreadySeeded) {
    // Read-only verify candidate seed content FIRST before touching conversation_summaries!
    verifyAgyRebuildSeedInternal(
      {
        ...input,
        expectedSeedHash: serialized.seedHash,
        expectedTrajectoryId: shellSchema.trajectoryId,
      },
      {
        requireNoAdditionalWork: true,
        requireColdLoadReceipt: false,
        checkSummarySynchronized: false,
        omitWitness: true,
      },
    )
    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    ensureSummaryStepCountCas(canonicalRoot, input.nativeSessionId, 2, 0, shellSchema.trajectoryId)
    return verifyAgyRebuildSeedInternal(
      {
        ...input,
        expectedSeedHash: serialized.seedHash,
        expectedTrajectoryId: shellSchema.trajectoryId,
      },
      {
        requireNoAdditionalWork: true,
        requireColdLoadReceipt: false,
        checkSummarySynchronized: true,
        omitWitness: true,
      },
    )
  }

  verifySummaryRowExistsReadOnly(
    canonicalRoot,
    input.nativeSessionId,
    true,
    shellSchema.trajectoryId,
  )

  const expectedUploadedDir = join(canonicalRoot, 'brain', input.nativeSessionId, '.user_uploaded')
  const plannedMediaItems: Array<{
    mimeType: string
    inlineData: Buffer
    uri: string
    fileName: string
    sha256: string
  }> = verifiedMediaPayloads.map((item, idx) => {
    const fileName = `${idx}-${item.chunkImage.id}.${item.ext}`
    const targetMediaPath = join(expectedUploadedDir, fileName)
    return {
      mimeType: item.chunkImage.mediaType,
      inlineData: item.bytes,
      uri: targetMediaPath,
      fileName,
      sha256: item.chunkImage.sha256,
    }
  })

  // Pre-encode exact Protobuf payloads (including BOTH user_response and items) BEFORE writing media or staging SQLite!
  const seedTimestampSec = 1_700_000_000n
  const userMetadata = encodeCortexStepMetadata({
    createdAtSeconds: seedTimestampSec,
    source: 1,
    executionId: serialized.seedExecutionId,
    trajectoryId: shellSchema.trajectoryId,
    stepIndex: 0,
    cascadeId: input.nativeSessionId,
    stepId: serialized.userStepId,
  })
  const userData = encodeAgyUserInputStep({
    metadata: userMetadata,
    text: serialized.expectedUserText,
    media: plannedMediaItems,
  })
  const assistantMetadata = encodeCortexStepMetadata({
    createdAtSeconds: seedTimestampSec,
    createdAtNanos: 1_000_000,
    source: 2,
    executionId: serialized.seedExecutionId,
    trajectoryId: shellSchema.trajectoryId,
    stepIndex: 1,
    cascadeId: input.nativeSessionId,
    stepId: serialized.assistantStepId,
  })
  const assistantData = encodeAgyPlannerResponseStep({
    metadata: assistantMetadata,
    response: serialized.expectedAssistantText,
  })
  const execData = encodeExecutorMetadata({
    terminationReason: EXECUTOR_TERMINATION_REASON_NO_TOOL_CALL,
    numGeneratorInvocations: 0,
    lastStepIdx: 1,
    executionId: serialized.seedExecutionId,
  })
  const encodedTotalBytes =
    userMetadata.byteLength +
    userData.byteLength +
    assistantMetadata.byteLength +
    assistantData.byteLength +
    execData.byteLength
  if (encodedTotalBytes > AGY_MAX_HISTORY_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity rebuild encoded Protobuf payload exceeds the 32 MiB history budget.',
      false,
    )
  }

  // Verify same-volume staging (conversations vs brain/<sid>) BEFORE writing any uploaded media!
  const sameVolumeStage = createSameVolumeCandidateStagingDb(
    canonicalRoot,
    input.nativeSessionId,
    input.stagingLeafName,
  )
  const stagingPath = sameVolumeStage.stagingPath
  let expectedStagedIdentity: AgySqliteFileIdentity

  try {
    if (plannedMediaItems.length > 0) {
      const uploadedDir = ensureSafeDirectoryChain(canonicalRoot, [
        'brain',
        input.nativeSessionId,
        '.user_uploaded',
      ])
      for (const item of plannedMediaItems) {
        const targetMediaPath = join(uploadedDir, item.fileName)
        writeIdempotentPrivateFile(targetMediaPath, canonicalRoot, item.inlineData, item.sha256)
      }
      fsyncDirectoryBestEffort(uploadedDir)
    }

    let expectedDbBytes: bigint
    const reopenShellHandle = openCommittedSqliteSnapshot({
      rootDir: configuredRoot,
      canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.nativeSessionId}.db`,
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

        stagingDb.exec('BEGIN IMMEDIATE')
        try {
          const hasStepSize = shellSchema.stepColumns.includes('size')
          const hasStepFormat = shellSchema.hasStepFormatColumn
          const insertStepCols = [
            'idx',
            'step_type',
            'status',
            'has_subtrajectory',
            'metadata',
            shellSchema.stepPayloadColumn,
            ...(hasStepFormat ? ['step_format'] : []),
            ...(hasStepSize ? ['size'] : []),
          ]
          const insertStep = stagingDb.prepare(
            `INSERT INTO "steps" (${insertStepCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${insertStepCols.map(() => '?').join(', ')})`,
          )
          insertStep.run(
            0,
            CORTEX_STEP_TYPE_USER_INPUT,
            CORTEX_STEP_STATUS_DONE,
            0,
            userMetadata,
            userData,
            ...(hasStepFormat ? [0] : []),
            ...(hasStepSize ? [userData.byteLength] : []),
          )
          insertStep.run(
            1,
            CORTEX_STEP_TYPE_PLANNER_RESPONSE,
            CORTEX_STEP_STATUS_DONE,
            0,
            assistantMetadata,
            assistantData,
            ...(hasStepFormat ? [0] : []),
            ...(hasStepSize ? [assistantData.byteLength] : []),
          )

          const hasExecSize = shellSchema.execColumns.includes('size')
          const insertExecCols = ['idx', 'data', ...(hasExecSize ? ['size'] : [])]
          stagingDb
            .prepare(
              `INSERT INTO "executor_metadata" (${insertExecCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${insertExecCols.map(() => '?').join(', ')})`,
            )
            .run(0, execData, ...(hasExecSize ? [execData.byteLength] : []))

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
        'Antigravity rebuild staged SQLite database exceeds the 32 MiB history budget.',
        false,
      )
    }
    sameVolumeStage.fsyncVerifiedStaging(expectedDbBytes)

    // Pin expectedStagedIdentity directly from an anchored, locked, integrity-checked snapshot of
    // the exact inode we created (zero stale pathname re-stat drift after SQLite closes).
    const stagedSnapshot = openCommittedSqliteSnapshot({
      rootDir: canonicalRoot,
      canonicalRoot,
      parentSegments: ['brain', input.nativeSessionId],
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
      verifySqliteIntegrityOk(stagedSnapshot.db)
      const stagedSchema = validateTrajectoryDatabase(
        stagedSnapshot.db,
        input.nativeSessionId,
        stagedSnapshot.proof,
      )
      if (stagedSchema.trajectoryId !== shellSchema.trajectoryId) {
        throw new Error('Antigravity rebuild staged trajectoryId disagrees with candidate shell.')
      }
      const stagedCounts = stagedSnapshot.db
        .prepare<[], { stepCount: number; genCount: number; execCount: number }>(
          `SELECT
            (SELECT COUNT(*) FROM "steps") AS stepCount,
            (SELECT COUNT(*) FROM "gen_metadata") AS genCount,
            (SELECT COUNT(*) FROM "executor_metadata") AS execCount`,
        )
        .get()!
      if (
        stagedCounts.stepCount !== 2 ||
        stagedCounts.genCount !== 0 ||
        stagedCounts.execCount !== 1
      ) {
        throw new Error('Antigravity rebuild staged database row count failed verification.')
      }
      expectedStagedIdentity = stagedSnapshot.fileIdentity
    } finally {
      stagedSnapshot.close()
    }

    const stagedView = openAnchoredLockedSqliteView(
      canonicalRoot,
      ['brain', input.nativeSessionId],
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
        throw new Error(
          'Antigravity rebuild staged database changed or acquired sidefiles before publication.',
        )
      }
    } finally {
      stagedView.close()
    }

    assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
    publishStagedCandidateOrThrow({
      canonicalRoot,
      candidateSessionId: input.nativeSessionId,
      stagedLeafName: sameVolumeStage.stagingLeafName,
      expectedTargetIdentity: shellIdentity,
      expectedStagedIdentity,
    })
    fsyncDirectoryBestEffort(conversationsDir)
  } finally {
    sameVolumeStage.cleanup()
  }

  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  const publishedIdentity = readAnchoredFileIdentity(
    canonicalRoot,
    ['conversations'],
    `${input.nativeSessionId}.db`,
  )
  if (
    publishedIdentity.dev !== expectedStagedIdentity.dev ||
    publishedIdentity.ino !== expectedStagedIdentity.ino ||
    publishedIdentity.size !== expectedStagedIdentity.size ||
    publishedIdentity.mtimeNs !== expectedStagedIdentity.mtimeNs
  ) {
    throw Object.assign(
      new Error('Antigravity rebuild published candidate database changed after atomic rename.'),
      { code: 'UNCERTAIN' },
    )
  }
  ensureSummaryStepCountCas(canonicalRoot, input.nativeSessionId, 2, 0, shellSchema.trajectoryId)

  return verifyAgyRebuildSeedInternal(
    {
      ...input,
      expectedSeedHash: serialized.seedHash,
      expectedTrajectoryId: shellSchema.trajectoryId,
    },
    {
      requireNoAdditionalWork: true,
      requireColdLoadReceipt: false,
      checkSummarySynchronized: true,
      omitWitness: true,
    },
  )
}
