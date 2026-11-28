import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { AgentExecutionError } from '../agent-execution-error'
import {
  type AgySqliteFileIdentity,
  checkSameVolume,
  identitiesExactMatch,
  openAnchoredLockedSqliteView,
  publishCandidateAtomically,
  verifyCandidateEmptyUnlocked,
} from '../agy-sqlite-file'
import {
  AgyHotRollbackJournalError,
  AgyInvalidSqliteImageError,
  type AgyPreScannedSqliteProof,
  type AgySchemaCatalogBudget,
  AgyTransientIdentityChurnError,
  MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
  SQLITE_WAL_INDEX_HEADER_BYTES,
  withAgyReadImage,
} from '../agy-sqlite-image'
import {
  AGY_MAX_HISTORY_BYTES,
  AGY_SUMMARIES_BUSY_TIMEOUT_MS,
  AGY_TEXT_BUDGET_BYTES,
  ensureSafeDirectoryChain,
  isInsideDirectory,
  isPlainObject,
  PROTOBUF_WIRE_BYTES,
  PROTOBUF_WIRE_VARINT,
  quoteSqlIdentifier,
  readExactBoundedBytesFromFd,
  resolveSnapshotParentTempDir,
  SAFE_ID_PATTERN,
  sha256Hex,
  statsMatch,
  writeAllSync,
} from './constants-and-types'
import { decodeCortexTrajectoryMetadata } from './cortex-codec'
import { decodeProtobufFields, decodeUtf8Strict } from './protobuf-wire'
import {
  assertProofHasOrdinaryTables,
  measureTableColumnsTotalBytes,
  readTableColumns,
  type ValidatedTrajectorySchema,
} from './sqlite-validator'

export interface CommittedSqliteSnapshotHandle {
  readonly db: Database.Database
  readonly proof: AgyPreScannedSqliteProof
  readonly fileIdentity: AgySqliteFileIdentity
  readonly walIdentity: AgySqliteFileIdentity | null
  readonly committedImageDigest: string
  readonly canonicalDbPath: string
  close(): void
}

export function openCommittedSqliteSnapshot(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly parentSegments: readonly string[]
  readonly leafName: string
  readonly maxSnapshotBytes?: number
  readonly schemaCatalogBudget?: AgySchemaCatalogBudget
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): CommittedSqliteSnapshotHandle {
  const { rootDir, canonicalRoot, parentSegments, leafName } = input
  const maxSnapshotBytes = input.maxSnapshotBytes ?? AGY_MAX_HISTORY_BYTES * 2
  const canonicalDbPath = join(canonicalRoot, ...parentSegments, leafName)
  const materialized = withAgyReadImage(
    { rootDir, parentSegments, leafName },
    {
      maxSnapshotBytes,
      snapshotParentTempDir: resolveSnapshotParentTempDir(),
      ...(input.schemaCatalogBudget !== undefined
        ? { schemaCatalogBudget: input.schemaCatalogBudget }
        : {}),
    },
    {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    },
    (image) => {
      const snap = image.materializePrivateSnapshot({
        maxSnapshotBytes,
        snapshotParentTempDir: resolveSnapshotParentTempDir(),
        ...(input.schemaCatalogBudget !== undefined
          ? { schemaCatalogBudget: input.schemaCatalogBudget }
          : {}),
      })
      return {
        snap,
        fileIdentity: image.fileIdentity,
        walIdentity: image.walIdentity,
        committedImageDigest: image.committedImageDigest,
      }
    },
  )

  let db: Database.Database
  try {
    db = materialized.snap.openReadOnlyDatabase()
  } catch (error) {
    materialized.snap.cleanup()
    throw error
  }
  return {
    db,
    proof: materialized.snap.proof,
    fileIdentity: materialized.fileIdentity,
    walIdentity: materialized.walIdentity,
    committedImageDigest: materialized.committedImageDigest,
    canonicalDbPath,
    close: () => {
      db.close()
    },
  }
}

export function assertAnchoredSourceUnchanged(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly parentSegments: readonly string[]
  readonly leafName: string
  readonly expectedIdentity: AgySqliteFileIdentity
  readonly expectedCommittedImageDigest: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): void {
  if (realpathSync(input.rootDir) !== input.canonicalRoot) {
    throw new Error('Antigravity storage root changed during inspection.')
  }
  withAgyReadImage(
    {
      rootDir: input.rootDir,
      parentSegments: input.parentSegments,
      leafName: input.leafName,
    },
    { maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES },
    {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    },
    (image) => {
      if (
        !identitiesExactMatch(image.fileIdentity, input.expectedIdentity) ||
        image.committedImageDigest !== input.expectedCommittedImageDigest
      ) {
        throw new Error('Antigravity trajectory database changed during inspection.')
      }
      image.verifyUnchanged()
    },
  )
}

/**
 * Verifies a closed zero-step empty candidate DB using the anchored native file module WITHOUT
 * ever opening a writable SQLite handle or creating sidefiles in `conversations/`.
 * If an active SQLite lock or uncleaned `-wal`/`-shm`/`-journal` remains, preserves the candidate
 * & original binding and throws an explicit `UNCERTAIN` error.
 */
function hasBlockingCandidateArtifacts(
  check: ReturnType<typeof verifyCandidateEmptyUnlocked>,
): boolean {
  if (check.hasActiveLock || check.hasJournal) return true
  if (check.hasWal && check.walByteLength !== 0) return true
  if (check.hasShm && !check.hasWal) return true
  return false
}

const STAGING_LEAF_NAME_PATTERN = /^\.pact-stage-[a-zA-Z0-9._-]{1,96}\.db$/u

export function publishStagedCandidateOrThrow(input: {
  readonly canonicalRoot: string
  readonly candidateSessionId: string
  readonly stagedLeafName: string
  readonly expectedTargetIdentity: AgySqliteFileIdentity
  readonly expectedStagedIdentity: AgySqliteFileIdentity
}): void {
  const result = publishCandidateAtomically({
    rootDir: input.canonicalRoot,
    targetParentSegments: ['conversations'],
    targetLeafName: `${input.candidateSessionId}.db`,
    stagedParentSegments: ['brain', input.candidateSessionId],
    stagedLeafName: input.stagedLeafName,
    expectedTargetIdentity: input.expectedTargetIdentity,
    expectedStagedIdentity: input.expectedStagedIdentity,
  })
  if (result.status === 'published') {
    return
  }
  if (result.status === 'exdev') {
    throw Object.assign(
      new Error(
        `Antigravity candidate staging and conversations directories are on different volumes (${result.reason}).`,
      ),
      { code: 'EXDEV' },
    )
  }
  throw Object.assign(
    new Error(
      `Antigravity candidate database could not be safely published (${result.reason}); publication is UNCERTAIN.`,
    ),
    { code: 'UNCERTAIN' },
  )
}

export function openCandidateShellSnapshotOrThrowUncertain(input: {
  readonly rootDir: string
  readonly canonicalRoot: string
  readonly candidateSessionId: string
  readonly maxSnapshotBytes: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): CommittedSqliteSnapshotHandle {
  try {
    return openCommittedSqliteSnapshot({
      rootDir: input.rootDir,
      canonicalRoot: input.canonicalRoot,
      parentSegments: ['conversations'],
      leafName: `${input.candidateSessionId}.db`,
      maxSnapshotBytes: input.maxSnapshotBytes,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
    })
  } catch (error) {
    if (
      error instanceof AgyTransientIdentityChurnError ||
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyInvalidSqliteImageError
    ) {
      let check: ReturnType<typeof verifyCandidateEmptyUnlocked> | undefined
      try {
        check = verifyCandidateEmptyUnlocked(
          input.canonicalRoot,
          ['conversations'],
          `${input.candidateSessionId}.db`,
        )
      } catch {
        check = undefined
      }
      if (check && hasBlockingCandidateArtifacts(check)) {
        throw Object.assign(
          new Error(
            'Antigravity candidate database retains an active lock or uncleaned WAL/SHM/journal sidefile; publication is UNCERTAIN.',
          ),
          { code: 'UNCERTAIN' },
        )
      }
    }
    throw error
  }
}

interface SameVolumeCandidateStage {
  readonly stagingPath: string
  readonly stagingLeafName: string
  readonly createdAnchoredIdentity: AgySqliteFileIdentity
  assertStagingBound(options?: { readonly expectedSize?: bigint }): BigIntStats
  fsyncVerifiedStaging(expectedSize: bigint): void
  assertAnchoredIdentityMatchesCreated(identity: AgySqliteFileIdentity, expectedSize: bigint): void
  cleanup(): void
}

/**
 * Allocates a same-volume private SQLite staging file under
 * `<canonicalRoot>/brain/<candidateSessionId>/.pact-stage-<uuid>.db` (`0o600`, `DELETE` journal mode)
 * and binds both the staging directory and exclusively created file identity across SQLite
 * initialization, mutation, verification, fsync, publication, and cleanup.
 */
export function createSameVolumeCandidateStagingDb(
  canonicalRoot: string,
  candidateSessionId: string,
  requestedStagingLeafName?: string,
): SameVolumeCandidateStage {
  const stagingLeafName = requestedStagingLeafName ?? `.pact-stage-${randomUUID()}.db`
  if (!STAGING_LEAF_NAME_PATTERN.test(stagingLeafName)) {
    throw new Error('Invalid Antigravity candidate staging filename.')
  }
  const brainCandidatePath = join(canonicalRoot, 'brain', candidateSessionId)
  let existedBefore = false
  try {
    const st = lstatSync(brainCandidatePath, { bigint: true })
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error('Antigravity candidate brain staging directory is linked or invalid.')
    }
    existedBefore = true
  } catch (error) {
    if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
      throw error
    }
  }
  const safeBrainDir = ensureSafeDirectoryChain(canonicalRoot, ['brain', candidateSessionId])
  const brainDirStat = lstatSync(safeBrainDir, { bigint: true })
  if (
    !brainDirStat.isDirectory() ||
    brainDirStat.isSymbolicLink() ||
    realpathSync(safeBrainDir) !== safeBrainDir
  ) {
    throw new Error('Antigravity candidate brain staging directory is linked or invalid.')
  }
  let brainDirFd: number | undefined
  if (process.platform !== 'win32') {
    brainDirFd = openSync(
      safeBrainDir,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const pinnedDirStat = fstatSync(brainDirFd, { bigint: true })
    if (
      !pinnedDirStat.isDirectory() ||
      pinnedDirStat.dev !== brainDirStat.dev ||
      pinnedDirStat.ino !== brainDirStat.ino
    ) {
      closeSync(brainDirFd)
      brainDirFd = undefined
      throw new Error('Antigravity candidate brain staging directory changed while opening.')
    }
  }
  const closeBrainDirFd = (): void => {
    if (brainDirFd !== undefined) {
      try {
        closeSync(brainDirFd)
      } catch {
        /* Best-effort close of pinned staging directory handle. */
      }
      brainDirFd = undefined
    }
  }
  const removeEmptyBrainDirIfCreated = (): void => {
    if (!existedBefore) {
      try {
        rmdirSync(safeBrainDir)
      } catch {
        /* Candidate brain directory may legitimately hold uploaded media or receipts. */
      }
    }
  }

  let sameVolume: boolean
  try {
    sameVolume = checkSameVolume(canonicalRoot, ['conversations'], ['brain', candidateSessionId])
  } catch (error) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  if (!sameVolume) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw Object.assign(
      new Error(
        'Antigravity candidate brain staging directory and conversations directory are on different volumes.',
      ),
      { code: 'EXDEV' },
    )
  }

  const assertStagingDirUnchanged = (): void => {
    if (realpathSync(canonicalRoot) !== canonicalRoot) {
      throw new Error('Antigravity storage root changed during candidate staging.')
    }
    const currentDirStat = lstatSync(safeBrainDir, { bigint: true })
    if (
      !currentDirStat.isDirectory() ||
      currentDirStat.isSymbolicLink() ||
      currentDirStat.dev !== brainDirStat.dev ||
      currentDirStat.ino !== brainDirStat.ino ||
      realpathSync(safeBrainDir) !== safeBrainDir ||
      !isInsideDirectory(canonicalRoot, safeBrainDir)
    ) {
      throw new Error('Antigravity candidate brain staging directory changed during staging.')
    }
    if (brainDirFd !== undefined) {
      const pinnedDirStat = fstatSync(brainDirFd, { bigint: true })
      if (
        !pinnedDirStat.isDirectory() ||
        pinnedDirStat.dev !== brainDirStat.dev ||
        pinnedDirStat.ino !== brainDirStat.ino
      ) {
        throw new Error('Antigravity candidate pinned brain directory identity changed.')
      }
    }
  }

  const stagingPath = join(safeBrainDir, stagingLeafName)
  let fd: number
  try {
    assertStagingDirUnchanged()
    fd = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  let createdStat: BigIntStats
  try {
    createdStat = fstatSync(fd, { bigint: true })
    if (
      !createdStat.isFile() ||
      createdStat.nlink !== 1n ||
      createdStat.size !== 0n ||
      createdStat.dev !== brainDirStat.dev
    ) {
      throw new Error('Antigravity candidate staging descriptor identity is invalid.')
    }
    assertStagingDirUnchanged()
    const liveCreatedStat = lstatSync(stagingPath, { bigint: true })
    if (
      !liveCreatedStat.isFile() ||
      liveCreatedStat.isSymbolicLink() ||
      liveCreatedStat.nlink !== 1n ||
      liveCreatedStat.dev !== createdStat.dev ||
      liveCreatedStat.ino !== createdStat.ino ||
      realpathSync(stagingPath) !== stagingPath
    ) {
      throw new Error('Antigravity candidate staging path changed immediately after creation.')
    }
  } catch (error) {
    closeSync(fd)
    try {
      const current = lstatSync(stagingPath, { bigint: true })
      if (!current.isSymbolicLink() && current.dev === brainDirStat.dev) {
        unlinkSync(stagingPath)
      }
    } catch {
      /* Best-effort cleanup of failed staging creation. */
    }
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }
  closeSync(fd)

  let createdAnchoredIdentity: AgySqliteFileIdentity
  try {
    createdAnchoredIdentity = readAnchoredFileIdentity(
      canonicalRoot,
      ['brain', candidateSessionId],
      stagingLeafName,
    )
    if (
      createdAnchoredIdentity.size !== '0' ||
      (process.platform !== 'win32' &&
        (createdAnchoredIdentity.dev !== String(createdStat.dev) ||
          createdAnchoredIdentity.ino !== String(createdStat.ino)))
    ) {
      throw new Error('Antigravity candidate staging anchored identity mismatch after creation.')
    }
  } catch (error) {
    try {
      const current = lstatSync(stagingPath, { bigint: true })
      if (
        !current.isSymbolicLink() &&
        current.dev === createdStat.dev &&
        current.ino === createdStat.ino
      ) {
        unlinkSync(stagingPath)
      }
    } catch {
      /* Best-effort cleanup of unverified staging file. */
    }
    closeBrainDirFd()
    removeEmptyBrainDirIfCreated()
    throw error
  }

  const assertStagingBound = (options?: { readonly expectedSize?: bigint }): BigIntStats => {
    assertStagingDirUnchanged()
    const current = lstatSync(stagingPath, { bigint: true })
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== createdStat.dev ||
      current.ino !== createdStat.ino ||
      realpathSync(stagingPath) !== stagingPath
    ) {
      throw new Error('Antigravity candidate staging file identity drifted during staging.')
    }
    if (options?.expectedSize !== undefined && current.size !== options.expectedSize) {
      throw new Error('Antigravity candidate staging file size drifted during staging.')
    }
    return current
  }

  const fsyncVerifiedStaging = (expectedSize: bigint): void => {
    assertStagingBound({ expectedSize })
    const syncFd = openSync(stagingPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(syncFd, { bigint: true })
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== createdStat.dev ||
        opened.ino !== createdStat.ino ||
        opened.size !== expectedSize
      ) {
        throw new Error('Antigravity candidate staging file changed while opening for fsync.')
      }
      assertStagingBound({ expectedSize })
      fsyncSync(syncFd)
      const afterSync = fstatSync(syncFd, { bigint: true })
      if (
        !afterSync.isFile() ||
        afterSync.nlink !== 1n ||
        afterSync.dev !== createdStat.dev ||
        afterSync.ino !== createdStat.ino ||
        afterSync.size !== expectedSize
      ) {
        throw new Error('Antigravity candidate staging file changed during fsync.')
      }
    } finally {
      closeSync(syncFd)
    }
  }

  const assertAnchoredIdentityMatchesCreated = (
    identity: AgySqliteFileIdentity,
    expectedSize: bigint,
  ): void => {
    if (
      identity.dev !== createdAnchoredIdentity.dev ||
      identity.ino !== createdAnchoredIdentity.ino ||
      identity.size !== String(expectedSize)
    ) {
      throw new Error('Antigravity candidate staging anchored identity drifted before publication.')
    }
  }

  return {
    stagingPath,
    stagingLeafName,
    createdAnchoredIdentity,
    assertStagingBound,
    fsyncVerifiedStaging,
    assertAnchoredIdentityMatchesCreated,
    cleanup: () => {
      try {
        const current = lstatSync(stagingPath, { bigint: true })
        if (
          !current.isSymbolicLink() &&
          current.isFile() &&
          current.dev === createdStat.dev &&
          current.ino === createdStat.ino
        ) {
          unlinkSync(stagingPath)
        }
      } catch {
        /* Staging file was already published or absent. */
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const sidePath = `${stagingPath}${suffix}`
          const sideStat = lstatSync(sidePath, { bigint: true })
          if (
            !sideStat.isSymbolicLink() &&
            sideStat.isFile() &&
            sideStat.nlink === 1n &&
            sideStat.dev === createdStat.dev
          ) {
            unlinkSync(sidePath)
          }
        } catch {
          /* Best-effort cleanup of verified staging sidefiles. */
        }
      }
      closeBrainDirFd()
      removeEmptyBrainDirIfCreated()
    },
  }
}

export function readAnchoredFileIdentity(
  canonicalRoot: string,
  parentSegments: readonly string[],
  leafName: string,
): AgySqliteFileIdentity {
  const view = openAnchoredLockedSqliteView(canonicalRoot, parentSegments, leafName, {
    acquireSharedLock: false,
    openWal: false,
    openShm: false,
    checkJournal: false,
  })
  try {
    return view.fileIdentity
  } finally {
    view.close()
  }
}

export function computePhysicalDbDigest(
  canonicalRoot: string,
  sessionId: string,
  originalStorageRoot: string,
  expectedFileIdentity?: AgySqliteFileIdentity,
  expectedWalIdentity?: AgySqliteFileIdentity | null,
): { rawHash: string; rawBytes: number } {
  if (realpathSync(originalStorageRoot) !== canonicalRoot) {
    throw new Error('Antigravity storage root changed during digest computation.')
  }
  const view = openAnchoredLockedSqliteView(canonicalRoot, ['conversations'], `${sessionId}.db`, {
    acquireSharedLock: true,
    openWal: true,
    openShm: true,
    checkJournal: true,
  })
  try {
    if (expectedFileIdentity && !identitiesExactMatch(view.fileIdentity, expectedFileIdentity)) {
      throw new Error('Antigravity database file changed while opening physical digest.')
    }
    if (expectedWalIdentity !== undefined) {
      const walMatches =
        (expectedWalIdentity === null && view.walIdentity === null) ||
        (expectedWalIdentity !== null &&
          view.walIdentity !== null &&
          identitiesExactMatch(view.walIdentity, expectedWalIdentity))
      if (!walMatches) {
        throw new Error('Antigravity WAL file changed while opening physical digest.')
      }
    }
    if (view.hasJournal) {
      throw new AgyHotRollbackJournalError(
        `Antigravity SQLite rollback journal (${sessionId}.db-journal) is present during physical digest.`,
      )
    }
    const readShmHeader = (): Buffer => {
      try {
        return view.readShmAt(0, SQLITE_WAL_INDEX_HEADER_BYTES)
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ERR_UNEXPECTED_EOF') {
          throw new AgyTransientIdentityChurnError(
            'Antigravity SQLite wal-index header truncated during physical digest.',
          )
        }
        throw error
      }
    }
    let shmBefore: Buffer | undefined
    if (view.hasShm) {
      if (view.shmByteLength < SQLITE_WAL_INDEX_HEADER_BYTES) {
        throw new AgyTransientIdentityChurnError(
          'Antigravity SQLite wal-index file is still initializing during physical digest.',
        )
      }
      shmBefore = readShmHeader()
    }
    const hasher = createHash('sha256')
    hasher.update('pact-agy-sqlite-physical-v1\0')
    let totalBytes = 0
    const chunkSize = 64 * 1024

    const hashStream = (
      targetBytes: number,
      readFn: (off: number, len: number) => Buffer,
    ): void => {
      if (!Number.isSafeInteger(targetBytes) || targetBytes < 0) {
        throw new Error('Antigravity database file size exceeds safe integer bounds.')
      }
      let offset = 0
      while (offset < targetBytes) {
        const toRead = Math.min(chunkSize, targetBytes - offset)
        const buf = readFn(offset, toRead)
        offset += buf.byteLength
        totalBytes += buf.byteLength
        if (totalBytes > AGY_MAX_HISTORY_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity trajectory database exceeds its 32 MiB budget.',
            false,
          )
        }
        hasher.update(buf)
      }
      if (offset !== targetBytes) {
        throw new Error('Antigravity database read ended before expected EOF.')
      }
    }

    hasher.update('main\0')
    hashStream(view.byteLength, (off, len) => view.readAt(off, len))
    if (view.hasWal && view.walByteLength > 0) {
      hasher.update('\0wal\0')
      hashStream(view.walByteLength, (off, len) => view.readWalAt(off, len))
    }
    const verify = view.verifyUnchanged()
    if (!verify.unchanged) {
      if (verify.reason === 'journal_appeared') {
        throw new AgyHotRollbackJournalError(
          'Antigravity SQLite rollback journal appeared during physical digest.',
        )
      }
      throw new AgyTransientIdentityChurnError(
        `Antigravity database changed while computing physical digest (${verify.reason ?? 'unknown'}).`,
      )
    }
    if (shmBefore !== undefined) {
      const shmAfter = readShmHeader()
      if (!shmAfter.equals(shmBefore)) {
        throw new AgyTransientIdentityChurnError(
          'Antigravity SQLite wal-index header changed during physical digest.',
        )
      }
    }
    if (realpathSync(originalStorageRoot) !== canonicalRoot) {
      throw new Error('Antigravity storage root changed during digest computation.')
    }
    return { rawHash: hasher.digest('hex'), rawBytes: totalBytes }
  } finally {
    view.close()
  }
}

function deterministicMediaStagingLeafName(targetLeafName: string, expectedSha256: string): string {
  return `.pact-media-${sha256Hex(`${targetLeafName}\0${expectedSha256}`).slice(0, 32)}.tmp`
}

function readExactVerifiedSha256FromPath(
  filePath: string,
  expectedStat: {
    readonly dev: bigint
    readonly ino: bigint
    readonly size: bigint
    readonly nlink: bigint
  },
  expectedByteLength: number,
  expectedSha256: string,
): boolean {
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== expectedStat.dev ||
      opened.ino !== expectedStat.ino ||
      opened.size !== expectedStat.size ||
      opened.nlink !== expectedStat.nlink
    ) {
      return false
    }
    const content = readExactBoundedBytesFromFd(fd, expectedByteLength)
    const afterRead = fstatSync(fd, { bigint: true })
    if (
      !statsMatch(opened, afterRead) ||
      afterRead.nlink !== expectedStat.nlink ||
      content.byteLength !== expectedByteLength
    ) {
      return false
    }
    return sha256Hex(content) === expectedSha256
  } finally {
    closeSync(fd)
  }
}

export function writeIdempotentPrivateFile(
  targetPath: string,
  canonicalAppDataDir: string,
  bytes: Buffer,
  expectedSha256: string,
): void {
  const parentDir = dirname(targetPath)
  const parentBefore = lstatSync(parentDir, { bigint: true })
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('Antigravity uploaded media parent directory is linked or invalid.')
  }
  const canonicalParent = realpathSync(parentDir)
  if (canonicalParent !== parentDir || !isInsideDirectory(canonicalAppDataDir, canonicalParent)) {
    throw new Error('Antigravity uploaded media parent directory escaped its storage root.')
  }

  let parentDirFd: number | undefined
  if (process.platform !== 'win32') {
    parentDirFd = openSync(
      canonicalParent,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    )
    const pinnedDirStat = fstatSync(parentDirFd, { bigint: true })
    if (
      !pinnedDirStat.isDirectory() ||
      pinnedDirStat.dev !== parentBefore.dev ||
      pinnedDirStat.ino !== parentBefore.ino
    ) {
      closeSync(parentDirFd)
      throw new Error('Antigravity uploaded media parent directory changed while opening.')
    }
  }

  const assertParentUnchanged = (phase: string): void => {
    const parentNow = lstatSync(canonicalParent, { bigint: true })
    if (
      !parentNow.isDirectory() ||
      parentNow.isSymbolicLink() ||
      parentNow.dev !== parentBefore.dev ||
      parentNow.ino !== parentBefore.ino ||
      realpathSync(canonicalParent) !== canonicalParent ||
      !isInsideDirectory(canonicalAppDataDir, canonicalParent)
    ) {
      throw new Error(`Antigravity uploaded media parent directory changed ${phase}.`)
    }
    if (parentDirFd !== undefined) {
      const pinnedDirStat = fstatSync(parentDirFd, { bigint: true })
      if (
        !pinnedDirStat.isDirectory() ||
        pinnedDirStat.dev !== parentBefore.dev ||
        pinnedDirStat.ino !== parentBefore.ino
      ) {
        throw new Error(`Antigravity uploaded media pinned parent directory changed ${phase}.`)
      }
    }
  }

  const targetLeaf = basename(targetPath)
  const tmpPath = join(
    canonicalParent,
    deterministicMediaStagingLeafName(targetLeaf, expectedSha256),
  )
  let tmpCreated = false
  let stageStat: BigIntStats | undefined
  let existed = false
  try {
    // Deterministic crash recovery: if a prior attempt crashed between linkSync and unlinkSync
    // (leaving target + deterministic staging file at nlink === 2 with identical inode, size, and
    // sha256) or right before linkSync (verified exact-digest nlink === 1 staging file), recover
    // cleanly without ever deleting an unrelated file.
    let existingTmpStat: BigIntStats | undefined
    try {
      existingTmpStat = lstatSync(tmpPath, { bigint: true })
    } catch (error) {
      if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
        throw error
      }
    }

    if (existingTmpStat !== undefined) {
      assertParentUnchanged('during crash recovery')
      if (
        !existingTmpStat.isFile() ||
        existingTmpStat.isSymbolicLink() ||
        realpathSync(tmpPath) !== tmpPath
      ) {
        throw new Error(
          'Refusing to overwrite or delete unverified entry at Antigravity media staging path.',
        )
      }
      let existingTargetStat: BigIntStats | undefined
      try {
        existingTargetStat = lstatSync(targetPath, { bigint: true })
      } catch (error) {
        if (!(error instanceof Error) || Reflect.get(error, 'code') !== 'ENOENT') {
          throw error
        }
      }

      if (
        existingTargetStat !== undefined &&
        existingTargetStat.isFile() &&
        !existingTargetStat.isSymbolicLink() &&
        existingTargetStat.nlink === 2n &&
        existingTmpStat.nlink === 2n &&
        existingTargetStat.dev === existingTmpStat.dev &&
        existingTargetStat.ino === existingTmpStat.ino &&
        existingTargetStat.size === BigInt(bytes.byteLength) &&
        realpathSync(targetPath) === targetPath &&
        readExactVerifiedSha256FromPath(
          targetPath,
          existingTargetStat,
          bytes.byteLength,
          expectedSha256,
        ) &&
        readExactVerifiedSha256FromPath(tmpPath, existingTmpStat, bytes.byteLength, expectedSha256)
      ) {
        assertParentUnchanged('before unlinking recovered media staging link')
        const tmpBeforeUnlink = lstatSync(tmpPath, { bigint: true })
        if (
          tmpBeforeUnlink.isSymbolicLink() ||
          !tmpBeforeUnlink.isFile() ||
          tmpBeforeUnlink.nlink !== 2n ||
          tmpBeforeUnlink.dev !== existingTmpStat.dev ||
          tmpBeforeUnlink.ino !== existingTmpStat.ino
        ) {
          throw new Error('Antigravity media staging link changed during crash recovery.')
        }
        unlinkSync(tmpPath)
        if (parentDirFd !== undefined) {
          fsyncSync(parentDirFd)
        }
        const targetAfterRecovery = lstatSync(targetPath, { bigint: true })
        if (
          targetAfterRecovery.isSymbolicLink() ||
          !targetAfterRecovery.isFile() ||
          targetAfterRecovery.nlink !== 1n ||
          targetAfterRecovery.dev !== existingTargetStat.dev ||
          targetAfterRecovery.ino !== existingTargetStat.ino ||
          targetAfterRecovery.size !== existingTargetStat.size
        ) {
          throw new Error('Antigravity media target did not settle to single link after recovery.')
        }
        return
      }

      if (
        existingTargetStat === undefined &&
        existingTmpStat.nlink === 1n &&
        existingTmpStat.size === BigInt(bytes.byteLength) &&
        readExactVerifiedSha256FromPath(tmpPath, existingTmpStat, bytes.byteLength, expectedSha256)
      ) {
        const recoverSyncFd = openSync(tmpPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
        try {
          const opened = fstatSync(recoverSyncFd, { bigint: true })
          if (
            !opened.isFile() ||
            opened.nlink !== 1n ||
            opened.dev !== existingTmpStat.dev ||
            opened.ino !== existingTmpStat.ino ||
            opened.size !== existingTmpStat.size
          ) {
            throw new Error('Antigravity recovered media staging file changed before fsync.')
          }
          fsyncSync(recoverSyncFd)
        } finally {
          closeSync(recoverSyncFd)
        }
        assertParentUnchanged('before publishing recovered media staging file')
        let linkedRecovered = false
        try {
          linkSync(tmpPath, targetPath)
          linkedRecovered = true
        } catch (error) {
          const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
          if (code === 'EEXIST') {
            existed = true
          } else {
            throw Object.assign(
              new Error(
                `Atomic no-replace publication for Antigravity media is unavailable (${String(code ?? 'unknown')}).`,
              ),
              { code: typeof code === 'string' ? code : 'EIO' },
            )
          }
        }
        if (linkedRecovered) {
          const linkedTargetStat = lstatSync(targetPath, { bigint: true })
          if (
            linkedTargetStat.isSymbolicLink() ||
            !linkedTargetStat.isFile() ||
            linkedTargetStat.dev !== existingTmpStat.dev ||
            linkedTargetStat.ino !== existingTmpStat.ino ||
            linkedTargetStat.size !== existingTmpStat.size
          ) {
            throw new Error('Antigravity recovered media target identity mismatch after link.')
          }
          unlinkSync(tmpPath)
          if (parentDirFd !== undefined) {
            fsyncSync(parentDirFd)
          }
          return
        }
      } else {
        throw new Error(
          'Refusing to overwrite or delete unverified file at Antigravity media staging path.',
        )
      }
    }

    if (!existed) {
      assertParentUnchanged('before creating media staging file')
      const fd = openSync(
        tmpPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      )
      tmpCreated = true
      let writtenStat: BigIntStats
      try {
        stageStat = fstatSync(fd, { bigint: true })
        if (
          !stageStat.isFile() ||
          stageStat.nlink !== 1n ||
          stageStat.size !== 0n ||
          stageStat.dev !== parentBefore.dev
        ) {
          throw new Error('Antigravity uploaded media staging descriptor identity is invalid.')
        }
        assertParentUnchanged('before write')
        const liveStageStat = lstatSync(tmpPath, { bigint: true })
        if (
          liveStageStat.isSymbolicLink() ||
          !liveStageStat.isFile() ||
          liveStageStat.nlink !== 1n ||
          liveStageStat.dev !== stageStat.dev ||
          liveStageStat.ino !== stageStat.ino ||
          realpathSync(tmpPath) !== tmpPath
        ) {
          throw new Error('Antigravity uploaded media staging path changed before write.')
        }
        writeAllSync(fd, bytes, 0, bytes.byteLength)
        writtenStat = fstatSync(fd, { bigint: true })
        if (
          writtenStat.dev !== stageStat.dev ||
          writtenStat.ino !== stageStat.ino ||
          writtenStat.size !== BigInt(bytes.byteLength)
        ) {
          throw new Error('Antigravity private file byte length did not match expected size.')
        }
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }

      assertParentUnchanged('before publish')
      const prePublishStageStat = lstatSync(tmpPath, { bigint: true })
      if (
        prePublishStageStat.isSymbolicLink() ||
        !prePublishStageStat.isFile() ||
        prePublishStageStat.nlink !== 1n ||
        prePublishStageStat.dev !== writtenStat.dev ||
        prePublishStageStat.ino !== writtenStat.ino ||
        prePublishStageStat.size !== writtenStat.size
      ) {
        throw new Error('Antigravity uploaded media staging file changed before atomic publish.')
      }

      let linkedFresh = false
      try {
        linkSync(tmpPath, targetPath)
        linkedFresh = true
      } catch (error) {
        const code = error instanceof Error ? Reflect.get(error, 'code') : undefined
        if (code === 'EEXIST') {
          existed = true
        } else {
          throw Object.assign(
            new Error(
              `Atomic no-replace publication for Antigravity media is unavailable (${String(code ?? 'unknown')}).`,
            ),
            { code: typeof code === 'string' ? code : 'EIO' },
          )
        }
      }
      if (linkedFresh) {
        const publishedStat = lstatSync(targetPath, { bigint: true })
        if (
          publishedStat.isSymbolicLink() ||
          !publishedStat.isFile() ||
          publishedStat.dev !== writtenStat.dev ||
          publishedStat.ino !== writtenStat.ino ||
          publishedStat.size !== writtenStat.size
        ) {
          throw new Error('Antigravity uploaded media published target identity mismatch.')
        }
        unlinkSync(tmpPath)
        tmpCreated = false
        if (parentDirFd !== undefined) {
          fsyncSync(parentDirFd)
        }
        return
      }
    }
  } finally {
    if (tmpCreated && stageStat) {
      try {
        const currentTmp = lstatSync(tmpPath, { bigint: true })
        if (
          !currentTmp.isSymbolicLink() &&
          currentTmp.isFile() &&
          currentTmp.dev === stageStat.dev &&
          currentTmp.ino === stageStat.ino
        ) {
          unlinkSync(tmpPath)
        }
      } catch {
        /* Best-effort cleanup of owned temp media file. */
      }
    }
    if (parentDirFd !== undefined) {
      try {
        closeSync(parentDirFd)
      } catch {
        /* Best-effort close of pinned media parent directory handle. */
      }
    }
  }

  if (!existed) return
  const existingFd = openSync(targetPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(existingFd, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error('Existing Antigravity uploaded media target is linked or unsupported.')
    }
    const parentAfter = lstatSync(canonicalParent, { bigint: true })
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      !isInsideDirectory(canonicalParent, realpathSync(targetPath))
    ) {
      throw new Error('Existing Antigravity uploaded media target escaped its storage root.')
    }
    if (opened.size !== BigInt(bytes.byteLength)) {
      throw new Error(
        'Existing Antigravity uploaded media target differs from its expected content.',
      )
    }
    const currentBytes = readExactBoundedBytesFromFd(existingFd, bytes.byteLength)
    const afterRead = fstatSync(existingFd, { bigint: true })
    if (
      !statsMatch(opened, afterRead) ||
      currentBytes.byteLength !== bytes.byteLength ||
      sha256Hex(currentBytes) !== expectedSha256
    ) {
      throw new Error(
        'Existing Antigravity uploaded media target differs from its expected content.',
      )
    }
  } finally {
    closeSync(existingFd)
  }
}

function validateFreshTrajectorySummaryBlob(
  rawSummary: Buffer,
  expectedSessionId: string,
  expectedTrajectoryId?: string,
): void {
  if (rawSummary.byteLength > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity conversation_summaries.raw_summary exceeds 8 MiB.',
      false,
    )
  }
  const fields = decodeProtobufFields(rawSummary)
  let sawTrajectoryId = false
  for (const field of fields) {
    if (field.fieldNumber === 1) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error('Antigravity TrajectorySummary.summary (field 1) wire type is invalid.')
      }
      if (field.bytes.byteLength > 0) {
        throw new Error(
          'Antigravity candidate raw_summary already carries a non-empty summary title.',
        )
      }
    } else if (field.fieldNumber === 2) {
      if (field.wireType !== PROTOBUF_WIRE_VARINT) {
        throw new Error('Antigravity TrajectorySummary.step_count (field 2) wire type is invalid.')
      }
      if (field.varint !== 0n) {
        throw new Error('Antigravity candidate raw_summary already carries non-zero step_count.')
      }
    } else if (field.fieldNumber === 4) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error(
          'Antigravity TrajectorySummary.trajectory_id (field 4) wire type is invalid.',
        )
      }
      const summaryTrajectoryId = decodeUtf8Strict(field.bytes)
      if (!SAFE_ID_PATTERN.test(summaryTrajectoryId)) {
        throw new Error('Antigravity candidate raw_summary has an invalid trajectory_id.')
      }
      if (expectedTrajectoryId !== undefined && summaryTrajectoryId !== expectedTrajectoryId) {
        throw new Error(
          'Antigravity candidate raw_summary trajectory_id disagrees with trajectory_meta.',
        )
      }
      sawTrajectoryId = true
    } else if (field.fieldNumber === 17) {
      if (field.wireType !== PROTOBUF_WIRE_BYTES) {
        throw new Error(
          'Antigravity TrajectorySummary.trajectory_metadata (field 17) wire type is invalid.',
        )
      }
      const decodedMeta = decodeCortexTrajectoryMetadata(field.bytes)
      if (
        (decodedMeta.parentConversationId && decodedMeta.parentConversationId.length > 0) ||
        decodedMeta.hasSubagentSpec ||
        decodedMeta.isBattleModeFork ||
        decodedMeta.nestingDepth !== 0 ||
        (decodedMeta.rootConversationId &&
          decodedMeta.rootConversationId.length > 0 &&
          decodedMeta.rootConversationId !== expectedSessionId)
      ) {
        throw new Error(
          'Antigravity candidate raw_summary metadata contains unclosed parent or subagent lineage.',
        )
      }
    }
  }
  if (expectedTrajectoryId !== undefined && !sawTrajectoryId) {
    throw new Error('Antigravity candidate raw_summary is missing trajectory_id (field 4).')
  }
}

export function verifySummaryRowExistsReadOnly(
  canonicalAppDataDir: string,
  sessionId: string,
  requireEmptyFreshSummary: boolean,
  expectedTrajectoryId?: string,
): { stepCount: number } {
  const snapshotHandle = openCommittedSqliteSnapshot({
    rootDir: canonicalAppDataDir,
    canonicalRoot: canonicalAppDataDir,
    parentSegments: [],
    leafName: 'conversation_summaries.db',
    maxSnapshotBytes: AGY_MAX_HISTORY_BYTES,
  })
  const db = snapshotHandle.db
  try {
    assertProofHasOrdinaryTables(snapshotHandle.proof, ['conversation_summaries'])
    const cols = readTableColumns(db, 'conversation_summaries')
    if (!cols.includes('conversation_id') || !cols.includes('step_count')) {
      throw new Error('Antigravity conversation_summaries table is missing required columns.')
    }
    const selectColsList = [
      'conversation_id',
      'step_count',
      ...(cols.includes('title') ? ['title'] : []),
      ...(cols.includes('raw_summary') ? ['raw_summary'] : []),
      ...(cols.includes('parent_conversation_id') ? ['parent_conversation_id'] : []),
    ]
    if (
      measureTableColumnsTotalBytes(db, 'conversation_summaries', selectColsList, {
        sql: '"conversation_id" = ?',
        params: [sessionId],
      }) > AGY_TEXT_BUDGET_BYTES
    ) {
      throw new AgentExecutionError(
        'response_too_large',
        'Antigravity conversation_summaries row exceeds 8 MiB.',
        false,
      )
    }
    const selectCols = selectColsList.map(quoteSqlIdentifier).join(', ')
    const row = db
      .prepare<[string], Record<string, unknown>>(
        `SELECT ${selectCols} FROM "conversation_summaries" WHERE "conversation_id" = ?`,
      )
      .get(sessionId)
    if (!row) {
      throw new Error(
        'Antigravity candidate session is not registered in conversation_summaries.db.',
      )
    }
    const stepCount = row['step_count']
    if (typeof stepCount !== 'number' || !Number.isSafeInteger(stepCount) || stepCount < 0) {
      throw new Error('Antigravity conversation_summaries.step_count is invalid.')
    }
    if (
      typeof row['parent_conversation_id'] === 'string' &&
      row['parent_conversation_id'].length > 0
    ) {
      throw new Error('Antigravity candidate summary row has unexpected parent_conversation_id.')
    }
    if (requireEmptyFreshSummary) {
      if (stepCount !== 0) {
        throw new Error('Antigravity candidate summary row is not a fresh zero-Turn shell.')
      }
      if (typeof row['title'] === 'string' && row['title'].length > 0) {
        throw new Error('Antigravity candidate summary row already carries a non-empty title.')
      }
      const rawSummary = row['raw_summary']
      if (rawSummary !== null && rawSummary !== undefined) {
        if (!Buffer.isBuffer(rawSummary)) {
          throw new Error('Antigravity candidate raw_summary must be a BLOB.')
        }
        if (rawSummary.byteLength > 0) {
          validateFreshTrajectorySummaryBlob(rawSummary, sessionId, expectedTrajectoryId)
        }
      }
    }
    return { stepCount }
  } finally {
    snapshotHandle.close()
  }
}

export function ensureSummaryStepCountCas(
  canonicalAppDataDir: string,
  sessionId: string,
  stepCount: number,
  lastUserInputStepIndex: number,
  expectedTrajectoryId?: string,
): void {
  const summariesPath = join(canonicalAppDataDir, 'conversation_summaries.db')
  const stat = lstatSync(summariesPath, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) {
    throw new Error('Antigravity conversation_summaries.db must be an ordinary non-linked file.')
  }
  const canonicalSummariesPath = realpathSync(summariesPath)
  if (!isInsideDirectory(canonicalAppDataDir, canonicalSummariesPath)) {
    throw new Error('Antigravity conversation_summaries.db escaped its storage root.')
  }
  const db = new Database(canonicalSummariesPath, {
    fileMustExist: true,
    timeout: AGY_SUMMARIES_BUSY_TIMEOUT_MS,
  })
  try {
    db.pragma(`busy_timeout = ${AGY_SUMMARIES_BUSY_TIMEOUT_MS}`)
    const summaryTableRow = db
      .prepare<[], { rootpage: number; sql: string | null }>(
        `SELECT rootpage, sql FROM sqlite_master WHERE type = 'table' AND name = 'conversation_summaries' LIMIT 1`,
      )
      .get()
    if (
      !summaryTableRow ||
      summaryTableRow.rootpage < 2 ||
      (summaryTableRow.sql && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(summaryTableRow.sql))
    ) {
      throw new Error('Antigravity conversation_summaries is missing or not an ordinary table.')
    }
    const cols = readTableColumns(db, 'conversation_summaries')
    if (!cols.includes('conversation_id') || !cols.includes('step_count')) {
      throw new Error('Antigravity conversation_summaries table is missing required columns.')
    }
    const hasTitle = cols.includes('title')
    const hasRawSummary = cols.includes('raw_summary')
    const hasParent = cols.includes('parent_conversation_id')
    const hasLastUserStep = cols.includes('last_user_input_step_index')
    const selectCols = [
      'conversation_id',
      'step_count',
      ...(hasTitle ? ['title'] : []),
      ...(hasRawSummary ? ['raw_summary'] : []),
      ...(hasParent ? ['parent_conversation_id'] : []),
      ...(hasLastUserStep ? ['last_user_input_step_index'] : []),
    ]
      .map(quoteSqlIdentifier)
      .join(', ')

    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db
        .prepare<[string], Record<string, unknown>>(
          `SELECT ${selectCols} FROM "conversation_summaries" WHERE "conversation_id" = ?`,
        )
        .get(sessionId)
      if (!row) {
        throw new Error(
          'Antigravity candidate session disappeared from conversation_summaries.db before commit.',
        )
      }
      const currentStepCount = row['step_count']
      if (
        typeof currentStepCount !== 'number' ||
        !Number.isSafeInteger(currentStepCount) ||
        currentStepCount < 0
      ) {
        throw new Error('Antigravity conversation_summaries.step_count is invalid.')
      }
      if (
        hasParent &&
        typeof row['parent_conversation_id'] === 'string' &&
        row['parent_conversation_id'].length > 0
      ) {
        throw new Error('Antigravity candidate summary row has unexpected parent_conversation_id.')
      }
      const currentTitle = hasTitle ? row['title'] : undefined
      if (typeof currentTitle === 'string' && currentTitle.length > 0) {
        throw new Error(
          'Antigravity candidate summary row already carries a title from external native progress.',
        )
      }
      const rawSummary = hasRawSummary ? row['raw_summary'] : null
      if (rawSummary !== null && rawSummary !== undefined) {
        if (!Buffer.isBuffer(rawSummary)) {
          throw new Error('Antigravity candidate raw_summary must be a BLOB.')
        }
        if (rawSummary.byteLength > 0) {
          validateFreshTrajectorySummaryBlob(rawSummary, sessionId, expectedTrajectoryId)
        }
      }

      // Idempotent re-entry: already synchronized to the exact expected state with no external title/parent.
      if (
        currentStepCount === stepCount &&
        (!hasLastUserStep || row['last_user_input_step_index'] === lastUserInputStepIndex)
      ) {
        db.exec('COMMIT')
        return
      }

      if (currentStepCount !== 0) {
        throw new Error(
          'Antigravity candidate summary row advanced externally; refusing to overwrite native progress.',
        )
      }

      const whereClauses: string[] = ['"conversation_id" = ?', '"step_count" = 0']
      const whereParams: unknown[] = [sessionId]
      if (hasTitle) {
        whereClauses.push('("title" IS NULL OR "title" = \'\')')
      }
      if (hasParent) {
        whereClauses.push('("parent_conversation_id" IS NULL OR "parent_conversation_id" = \'\')')
      }
      if (hasRawSummary) {
        if (rawSummary === null || rawSummary === undefined) {
          whereClauses.push('"raw_summary" IS NULL')
        } else {
          whereClauses.push('"raw_summary" = ?')
          whereParams.push(rawSummary)
        }
      }

      const result = hasLastUserStep
        ? db
            .prepare(
              `UPDATE "conversation_summaries" SET "step_count" = ?, "last_user_input_step_index" = ? WHERE ${whereClauses.join(' AND ')}`,
            )
            .run(stepCount, lastUserInputStepIndex, ...whereParams)
        : db
            .prepare(
              `UPDATE "conversation_summaries" SET "step_count" = ? WHERE ${whereClauses.join(' AND ')}`,
            )
            .run(stepCount, ...whereParams)
      if (result.changes !== 1) {
        throw new Error('Antigravity candidate summary CAS failed due to concurrent modification.')
      }
      db.exec('COMMIT')
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
  }
}

export function initializeStagingFromShell(
  stagingDb: Database.Database,
  shellDb: Database.Database,
  shellSchema: ValidatedTrajectorySchema,
): void {
  const pageSize = Number(shellDb.pragma('page_size', { simple: true }) || 32768)
  const userVersion = Number(shellDb.pragma('user_version', { simple: true }) || 0)
  stagingDb.pragma(`page_size = ${pageSize}`)
  stagingDb.pragma('journal_mode = DELETE')
  stagingDb.pragma('synchronous = FULL')
  if (userVersion > 0) stagingDb.pragma(`user_version = ${userVersion}`)

  stagingDb.exec('BEGIN IMMEDIATE')
  try {
    for (const table of shellSchema.tables.values()) {
      if (!table.sql) throw new Error(`Missing DDL for table ${table.name} in candidate shell.`)
      stagingDb.exec(table.sql)
    }
    for (const idx of shellSchema.indexes) {
      if (idx.sql) stagingDb.exec(idx.sql)
    }

    const metaCols = shellSchema.metaColumns
    const metaPlaceholders = metaCols.map(() => '?').join(', ')
    stagingDb
      .prepare(
        `INSERT INTO "trajectory_meta" (${metaCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${metaPlaceholders})`,
      )
      .run(...metaCols.map((col) => shellSchema.metaRow[col] ?? null))

    if (
      shellSchema.tables.has('trajectory_metadata_blob') &&
      shellSchema.trajectoryMetadataRows.length > 0
    ) {
      const blobCols = readTableColumns(shellDb, 'trajectory_metadata_blob')
      const blobPlaceholders = blobCols.map(() => '?').join(', ')
      const insertBlob = stagingDb.prepare(
        `INSERT INTO "trajectory_metadata_blob" (${blobCols.map(quoteSqlIdentifier).join(', ')}) VALUES (${blobPlaceholders})`,
      )
      for (const row of shellSchema.trajectoryMetadataRows) {
        insertBlob.run(...blobCols.map((col) => row[col] ?? null))
      }
    }
    stagingDb.exec('COMMIT')
  } catch (error) {
    if (stagingDb.inTransaction) stagingDb.exec('ROLLBACK')
    throw error
  }
}

export function verifySqliteIntegrityOk(db: Database.Database): void {
  const rows: unknown = db.pragma('integrity_check')
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !isPlainObject(rows[0]) ||
    rows[0]['integrity_check'] !== 'ok'
  ) {
    throw new Error('Antigravity staging SQLite database failed PRAGMA integrity_check.')
  }
}

export function measureOpenSqliteExpectedBytes(db: Database.Database): bigint {
  const pageCount = Number(db.pragma('page_count', { simple: true }) || 0)
  const pageSize = Number(db.pragma('page_size', { simple: true }) || 0)
  if (
    !Number.isSafeInteger(pageCount) ||
    pageCount <= 0 ||
    !Number.isSafeInteger(pageSize) ||
    pageSize <= 0
  ) {
    throw new Error('Antigravity staged SQLite database has invalid page geometry.')
  }
  return BigInt(pageCount) * BigInt(pageSize)
}
