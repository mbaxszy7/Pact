import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from 'node:fs'
import { join, resolve } from 'node:path'

// oxlint-disable-next-line eslint/no-underscore-dangle -- Build-time Vite define constant embedded inside ASAR bundle.
declare const __PACT_AGY_SQLITE_FILE_META__: unknown

export class AgyNativeLoaderError extends Error {
  readonly code = 'EAGY_NATIVE_LOADER' as const

  constructor(message: string) {
    super(message)
    this.name = 'AgyNativeLoaderError'
  }
}

export interface AgySqliteFileIdentity {
  readonly dev: string
  readonly ino: string
  readonly size: string
  readonly mtimeNs: string
  readonly ctimeNs: string
}

export interface AgyLockedViewVerifyResult {
  readonly unchanged: boolean
  readonly reason?: string
}

export interface AgyLockedSqliteView {
  readonly byteLength: number
  readonly walByteLength: number
  readonly shmByteLength: number
  readonly hasWal: boolean
  readonly hasShm: boolean
  readonly hasJournal: boolean
  readonly sharedLockHeld: boolean
  readonly fileIdentity: AgySqliteFileIdentity
  readonly walIdentity: AgySqliteFileIdentity | null
  readonly shmIdentity: AgySqliteFileIdentity | null
  readAt(offset: number, length: number): Buffer
  readWalAt(offset: number, length: number): Buffer
  readShmAt(offset: number, length: number): Buffer
  verifyUnchanged(): AgyLockedViewVerifyResult
  close(): void
}

export interface AgyCandidateEmptyCheckResult {
  readonly byteLength: number
  readonly hasActiveLock: boolean
  readonly hasJournal: boolean
  readonly hasWal: boolean
  readonly walByteLength: number
  readonly hasShm: boolean
  readonly fileIdentity: AgySqliteFileIdentity
}

export interface AgyOpenLockedViewOptions {
  readonly acquireSharedLock?: boolean
  readonly openWal?: boolean
  readonly openShm?: boolean
  readonly checkJournal?: boolean
}

export interface AgySqliteFileModuleIdentity {
  readonly version: 1
  readonly platform: string
  readonly architecture: string
  readonly sourceSha256: string
}

export type AgyAtomicPublishResult =
  | { readonly status: 'published' }
  | { readonly status: 'uncertain' | 'exdev'; readonly reason: string }

interface VerifiedAddonMetadata {
  readonly version: 1
  readonly platform: string
  readonly architecture: string
  readonly sourceSha256: string
  readonly binarySha256: string
  readonly binaryBytes: number
  readonly machoPreSigSha256?: string
}

interface NativeAgySqliteFileBinding {
  moduleIdentity(): AgySqliteFileModuleIdentity
  openAnchoredLockedView(
    rootDir: string,
    parentSegments: readonly string[],
    leafName: string,
    options?: AgyOpenLockedViewOptions,
  ): AgyLockedSqliteView
  verifyCandidateEmptyUnlocked(
    rootDir: string,
    parentSegments: readonly string[],
    leafName: string,
  ): AgyCandidateEmptyCheckResult
  publishCandidateAtomically(
    rootDir: string,
    targetParentSegments: readonly string[],
    targetLeafName: string,
    stagedParentSegments: readonly string[],
    stagedLeafName: string,
    expectedTargetIdentity: AgySqliteFileIdentity,
    expectedStagedIdentity: AgySqliteFileIdentity,
  ): AgyAtomicPublishResult
  checkSameVolume(
    rootDir: string,
    leftParentSegments: readonly string[],
    rightParentSegments: readonly string[],
  ): boolean
}

export interface AgySqliteFileTestHooks {
  readonly onBeforeOpen?: (args: {
    readonly rootDir: string
    readonly parentSegments: readonly string[]
    readonly leafName: string
  }) => void
  readonly onAfterOpen?: (args: {
    readonly rootDir: string
    readonly parentSegments: readonly string[]
    readonly leafName: string
    readonly view: AgyLockedSqliteView
  }) => void
  readonly onAfterRead?: (args: {
    readonly stream: 'db' | 'wal' | 'shm'
    readonly offset: number
    readonly length: number
    readonly leafName: string
  }) => void
  readonly onBeforeVerifyUnchanged?: (args: { readonly leafName: string }) => void
  readonly onClose?: (args: {
    readonly rootDir: string
    readonly parentSegments: readonly string[]
    readonly leafName: string
  }) => void
  readonly onBeforePublish?: (args: {
    readonly rootDir: string
    readonly targetParentSegments: readonly string[]
    readonly targetLeafName: string
    readonly stagedParentSegments: readonly string[]
    readonly stagedLeafName: string
  }) => void
  readonly onAfterPublish?: (args: {
    readonly targetLeafName: string
    readonly result: AgyAtomicPublishResult
  }) => void
}

const MAX_BINARY_BYTES = 4 * 1024 * 1024
const MAX_METADATA_BYTES = 4096
const SHA256_RE = /^[a-f0-9]{64}$/u
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d
const MAX_MACHO_LOAD_COMMANDS = 1024
const LINKEDIT_SEGNAME = Buffer.from('__LINKEDIT\0\0\0\0\0\0', 'ascii')

function computeMachoPreSignatureSha256(bytes: Buffer, arch: string): string | null {
  if (bytes.byteLength < 32) return null
  const expectedCpu = arch === 'arm64' ? 0x0100000c : arch === 'x64' ? 0x01000007 : 0
  if (expectedCpu === 0) return null
  if (bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(4) !== expectedCpu) {
    return null
  }
  const ncmds = bytes.readUInt32LE(16)
  const sizeofcmds = bytes.readUInt32LE(20)
  if (
    ncmds === 0 ||
    ncmds > MAX_MACHO_LOAD_COMMANDS ||
    sizeofcmds < 16 ||
    sizeofcmds > bytes.byteLength - 32
  ) {
    return null
  }
  const commandsEnd = 32 + sizeofcmds
  let offset = 32
  let linkeditOffset = -1
  let linkeditFileoff = 0n
  let linkeditFilesize = 0n
  let codeSigOffset = -1
  let dataoff = 0
  let datasize = 0

  for (let i = 0; i < ncmds; i += 1) {
    if (offset + 8 > commandsEnd) return null
    const cmd = bytes.readUInt32LE(offset)
    const cmdsize = bytes.readUInt32LE(offset + 4)
    if (cmdsize < 8 || cmdsize % 8 !== 0 || cmdsize > commandsEnd - offset) return null
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) return null
      if (bytes.subarray(offset + 8, offset + 24).equals(LINKEDIT_SEGNAME)) {
        if (linkeditOffset !== -1) return null
        linkeditOffset = offset
        linkeditFileoff = bytes.readBigUInt64LE(offset + 40)
        linkeditFilesize = bytes.readBigUInt64LE(offset + 48)
      }
    } else if (cmd === LC_CODE_SIGNATURE) {
      if (cmdsize !== 16 || codeSigOffset !== -1) return null
      codeSigOffset = offset
      dataoff = bytes.readUInt32LE(offset + 8)
      datasize = bytes.readUInt32LE(offset + 12)
    }
    offset += cmdsize
  }

  if (linkeditOffset === -1 || codeSigOffset === -1) return null
  if (
    dataoff < commandsEnd ||
    datasize === 0 ||
    dataoff > bytes.byteLength ||
    datasize > bytes.byteLength - dataoff
  ) {
    return null
  }
  const totalBig = BigInt(bytes.byteLength)
  if (BigInt(dataoff) < linkeditFileoff || linkeditFileoff + linkeditFilesize !== totalBig) {
    return null
  }
  const trailing = bytes.byteLength - (dataoff + datasize)
  if (trailing < 0 || trailing >= 16) return null
  for (let i = dataoff + datasize; i < bytes.byteLength; i += 1) {
    if (bytes[i] !== 0) return null
  }

  const normalized = Buffer.from(bytes.subarray(0, dataoff))
  normalized.fill(0, linkeditOffset + 32, linkeditOffset + 40)
  normalized.fill(0, linkeditOffset + 48, linkeditOffset + 56)
  normalized.fill(0, codeSigOffset + 8, codeSigOffset + 16)
  return createHash('sha256').update(normalized).digest('hex')
}

let cachedBinding: NativeAgySqliteFileBinding | undefined
let cachedIdentity: AgySqliteFileModuleIdentity | undefined
let activeTestHooks: AgySqliteFileTestHooks | undefined
let activeOpenViewCount = 0
let embeddedMetaOverrideForTesting: unknown = Symbol.for('pact.agy.unconfigured')

export function setAgySqliteFileTestHooksForTesting(
  hooks: AgySqliteFileTestHooks | undefined,
): void {
  activeTestHooks = hooks
}

export function resetAgySqliteFileLoaderForTesting(): void {
  cachedBinding = undefined
  cachedIdentity = undefined
  embeddedMetaOverrideForTesting = Symbol.for('pact.agy.unconfigured')
}

export function setEmbeddedAgySqliteFileMetaForTesting(meta: unknown): void {
  embeddedMetaOverrideForTesting = meta
}

export function getOpenAgySqliteViewCountForTesting(): number {
  return activeOpenViewCount
}

export function identitiesExactMatch(
  left: AgySqliteFileIdentity,
  right: AgySqliteFileIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function isRunningInsideAsar(): boolean {
  return typeof __dirname === 'string' && __dirname.includes('.asar')
}

function isPackagedNativeMode(): boolean {
  if (isRunningInsideAsar()) return true
  const explicit = process.env['PACT_AGY_NATIVE_MODE']?.trim()
  if (explicit === 'packaged') return true
  if (explicit === 'development') return false
  return false
}

function parseMetadataRecord(raw: unknown, sourceLabel: string): VerifiedAddonMetadata {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new AgyNativeLoaderError(`agy-sqlite-file ${sourceLabel} must be a JSON object.`)
  }
  const version: unknown = Reflect.get(raw, 'version')
  const platform: unknown = Reflect.get(raw, 'platform')
  const architecture: unknown = Reflect.get(raw, 'architecture')
  const sourceSha256: unknown = Reflect.get(raw, 'sourceSha256')
  const binarySha256: unknown = Reflect.get(raw, 'binarySha256')
  const binaryBytes: unknown = Reflect.get(raw, 'binaryBytes')
  const machoPreSigSha256: unknown = Reflect.get(raw, 'machoPreSigSha256')
  if (
    version !== 1 ||
    platform !== process.platform ||
    architecture !== process.arch ||
    typeof sourceSha256 !== 'string' ||
    !SHA256_RE.test(sourceSha256) ||
    typeof binarySha256 !== 'string' ||
    !SHA256_RE.test(binarySha256) ||
    typeof binaryBytes !== 'number' ||
    !Number.isSafeInteger(binaryBytes) ||
    binaryBytes < 64 ||
    binaryBytes > MAX_BINARY_BYTES ||
    (machoPreSigSha256 !== undefined &&
      (typeof machoPreSigSha256 !== 'string' || !SHA256_RE.test(machoPreSigSha256)))
  ) {
    throw new AgyNativeLoaderError(
      `agy-sqlite-file ${sourceLabel} does not match the current platform/target.`,
    )
  }
  return {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    binarySha256,
    binaryBytes,
    ...(machoPreSigSha256 !== undefined ? { machoPreSigSha256 } : {}),
  }
}

function getEmbeddedMetadata(): VerifiedAddonMetadata | null {
  const raw =
    embeddedMetaOverrideForTesting !== Symbol.for('pact.agy.unconfigured')
      ? embeddedMetaOverrideForTesting
      : typeof __PACT_AGY_SQLITE_FILE_META__ !== 'undefined'
        ? __PACT_AGY_SQLITE_FILE_META__
        : null
  if (raw === null || raw === undefined) return null
  return parseMetadataRecord(raw, 'embedded metadata')
}

function readPinnedFileBounded(
  filePath: string,
  minBytes: number,
  maxBytes: number,
  label: string,
): { readonly bytes: Buffer; readonly stat: BigIntStats } {
  const preStat = lstatSync(filePath, { bigint: true })
  if (!preStat.isFile() || preStat.isSymbolicLink()) {
    throw new AgyNativeLoaderError(`agy-sqlite-file ${label} must be an ordinary file.`)
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const fd = openSync(filePath, fsConstants.O_RDONLY | noFollow)
  try {
    const stat = fstatSync(fd, { bigint: true })
    if (!stat.isFile()) {
      throw new AgyNativeLoaderError(`agy-sqlite-file ${label} is not a regular file.`)
    }
    const size = Number(stat.size)
    if (!Number.isSafeInteger(size) || size < minBytes || size > maxBytes) {
      throw new AgyNativeLoaderError(`agy-sqlite-file ${label} exceeds its byte bound.`)
    }
    const buf = Buffer.allocUnsafe(size + 1)
    let offset = 0
    while (offset < buf.byteLength) {
      const read = readSync(fd, buf, offset, buf.byteLength - offset, offset)
      if (read === 0) break
      offset += read
    }
    if (offset !== size || offset > maxBytes) {
      throw new AgyNativeLoaderError(`agy-sqlite-file ${label} changed during integrity read.`)
    }
    return { bytes: buf.subarray(0, size), stat }
  } finally {
    closeSync(fd)
  }
}

function bigIntStatsMatch(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function candidateNativeDirectories(packaged: boolean): string[] {
  const explicitDir = process.env['PACT_AGY_NATIVE_DIR']?.trim()
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: unknown }).resourcesPath
  const resourcesNativeDir =
    typeof resourcesPath === 'string' && resourcesPath.length > 0
      ? join(resourcesPath, 'native')
      : undefined

  if (packaged) {
    if (isRunningInsideAsar() && resourcesNativeDir) {
      return [resolve(resourcesNativeDir)]
    }
    if (explicitDir && explicitDir.length > 0) {
      return [resolve(explicitDir)]
    }
    if (resourcesNativeDir) {
      return [resolve(resourcesNativeDir)]
    }
    throw new AgyNativeLoaderError('Packaged agy-sqlite-file native directory is unavailable.')
  }

  const dirs: string[] = []
  if (explicitDir && explicitDir.length > 0) {
    dirs.push(resolve(explicitDir))
  }
  if (resourcesNativeDir) {
    dirs.push(resolve(resourcesNativeDir))
  }
  const baseDir = typeof __dirname === 'string' ? __dirname : ''
  if (baseDir.length > 0) {
    dirs.push(resolve(baseDir, '../../../out/native'))
    dirs.push(resolve(baseDir, '../../../../out/native'))
    dirs.push(resolve(baseDir, '../../out/native'))
    dirs.push(resolve(baseDir, '../native'))
  }
  dirs.push(resolve(process.cwd(), 'apps/desktop/out/native'))
  dirs.push(resolve(process.cwd(), 'out/native'))
  return [...new Set(dirs)]
}

function verifyBinaryAgainstMetadata(
  binaryBytes: Buffer,
  expected: VerifiedAddonMetadata,
  packaged: boolean,
): void {
  const actualSha256 = createHash('sha256').update(binaryBytes).digest('hex')
  const exactMatch =
    binaryBytes.byteLength === expected.binaryBytes && actualSha256 === expected.binarySha256
  if (exactMatch) return

  if (process.platform === 'darwin' && packaged) {
    if (!expected.machoPreSigSha256) {
      throw new AgyNativeLoaderError(
        'Packaged macOS agy-sqlite-file metadata lacks machoPreSigSha256.',
      )
    }
    const actualPreSig = computeMachoPreSignatureSha256(binaryBytes, process.arch)
    if (!actualPreSig || actualPreSig !== expected.machoPreSigSha256) {
      throw new AgyNativeLoaderError(
        'Packaged macOS agy-sqlite-file pre-signature SHA-256 does not match ASAR metadata.',
      )
    }
    return
  }

  throw new AgyNativeLoaderError(
    binaryBytes.byteLength !== expected.binaryBytes
      ? 'agy-sqlite-file binary size does not match expected metadata.'
      : 'agy-sqlite-file binary SHA-256 does not match expected metadata.',
  )
}

function locateAndVerifyNativeBinary(): {
  readonly binaryPath: string
  readonly binaryBytes: Buffer
  readonly pinnedStat: BigIntStats
  readonly expectedIdentity: AgySqliteFileModuleIdentity
  readonly packaged: boolean
} {
  const filename = `agy-sqlite-file-${process.platform}-${process.arch}.node`
  const packaged = isPackagedNativeMode()
  const embeddedMeta = getEmbeddedMetadata()
  if (packaged && !embeddedMeta) {
    throw new AgyNativeLoaderError(
      'Packaged agy-sqlite-file loader requires ASAR-embedded build integrity metadata.',
    )
  }

  const candidates = candidateNativeDirectories(packaged)
  let lastError: unknown

  for (const dir of candidates) {
    const binaryPath = join(dir, filename)
    const metaPath = `${binaryPath}.json`

    let binaryRead: { readonly bytes: Buffer; readonly stat: BigIntStats }
    try {
      binaryRead = readPinnedFileBounded(binaryPath, 64, MAX_BINARY_BYTES, 'native binary')
    } catch (error) {
      if (packaged) {
        throw error instanceof AgyNativeLoaderError
          ? error
          : new AgyNativeLoaderError(
              `Packaged native module ${filename} could not be read (${error instanceof Error ? error.message : String(error)}).`,
            )
      }
      if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
        continue
      }
      lastError = error
      continue
    }

    let expectedMeta: VerifiedAddonMetadata
    if (packaged) {
      expectedMeta = embeddedMeta!
    } else {
      let metaRead: { readonly bytes: Buffer; readonly stat: BigIntStats }
      try {
        metaRead = readPinnedFileBounded(metaPath, 1, MAX_METADATA_BYTES, 'metadata')
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') {
          continue
        }
        throw error instanceof AgyNativeLoaderError
          ? error
          : new AgyNativeLoaderError(
              `Unable to read agy-sqlite-file metadata (${error instanceof Error ? error.message : String(error)}).`,
            )
      }
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(metaRead.bytes.toString('utf8'))
      } catch {
        throw new AgyNativeLoaderError('agy-sqlite-file metadata is not valid JSON.')
      }
      expectedMeta = parseMetadataRecord(parsedJson, 'metadata')
    }

    verifyBinaryAgainstMetadata(binaryRead.bytes, expectedMeta, packaged)

    return {
      binaryPath,
      binaryBytes: binaryRead.bytes,
      pinnedStat: binaryRead.stat,
      packaged,
      expectedIdentity: {
        version: 1,
        platform: process.platform,
        architecture: process.arch,
        sourceSha256: expectedMeta.sourceSha256,
      },
    }
  }

  const suffix = lastError instanceof Error ? ` (${lastError.message})` : ''
  throw new AgyNativeLoaderError(
    `Unable to locate verified native module ${filename}; run "node scripts/build-agy-sqlite-file.mjs" first.${suffix}`,
  )
}

function dlopenVerifiedBinary(
  moduleShim: { exports: Partial<NativeAgySqliteFileBinding> },
  binaryPath: string,
  binaryBytes: Buffer,
  pinnedStat: BigIntStats,
  packaged: boolean,
): void {
  const privateTempDir = process.env['PACT_AGY_PRIVATE_TEMP_DIR']?.trim()
  if (packaged && (!privateTempDir || privateTempDir.length === 0)) {
    throw new AgyNativeLoaderError(
      'Packaged agy-sqlite-file loader requires a job-owned PACT_AGY_PRIVATE_TEMP_DIR.',
    )
  }
  if (privateTempDir && privateTempDir.length > 0) {
    let dirStat: BigIntStats
    try {
      dirStat = lstatSync(privateTempDir, { bigint: true })
    } catch {
      throw new AgyNativeLoaderError('Private native staging directory is inaccessible.')
    }
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
      throw new AgyNativeLoaderError('Private native staging directory must be an ordinary dir.')
    }
    if (process.platform !== 'win32') {
      if ((Number(dirStat.mode) & 0o077) !== 0) {
        throw new AgyNativeLoaderError('Private native staging directory must have 0o700 mode.')
      }
      if (typeof process.getuid === 'function' && Number(dirStat.uid) !== process.getuid()) {
        throw new AgyNativeLoaderError(
          'Private native staging directory must be owned by the current user.',
        )
      }
    }

    const stagedPath = join(
      privateTempDir,
      `agy-sqlite-file-${randomBytes(8).toString('hex')}.node`,
    )
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    const fd = openSync(
      stagedPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
      0o500,
    )
    let stagedStat: BigIntStats
    try {
      let written = 0
      while (written < binaryBytes.byteLength) {
        written += writeSync(fd, binaryBytes, written, binaryBytes.byteLength - written)
      }
      fsyncSync(fd)
      stagedStat = fstatSync(fd, { bigint: true })
    } catch (error) {
      closeSync(fd)
      try {
        unlinkSync(stagedPath)
      } catch {
        /* Best-effort cleanup of failed stage file. */
      }
      throw new AgyNativeLoaderError(
        `Failed to stage verified native binary (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
    closeSync(fd)

    try {
      const currentDirStat = lstatSync(privateTempDir, { bigint: true })
      const currentStagedStat = lstatSync(stagedPath, { bigint: true })
      if (
        !currentDirStat.isDirectory() ||
        currentDirStat.isSymbolicLink() ||
        currentDirStat.dev !== dirStat.dev ||
        currentDirStat.ino !== dirStat.ino ||
        !currentStagedStat.isFile() ||
        currentStagedStat.isSymbolicLink() ||
        (process.platform !== 'win32' && currentStagedStat.nlink !== 1n) ||
        !bigIntStatsMatch(currentStagedStat, stagedStat)
      ) {
        throw new AgyNativeLoaderError(
          'Staged agy-sqlite-file binary or private directory changed before dlopen.',
        )
      }
      process.dlopen(moduleShim, stagedPath)
    } catch (error) {
      if (error instanceof AgyNativeLoaderError) throw error
      throw new AgyNativeLoaderError(
        `Failed to load staged native module (${error instanceof Error ? error.message : String(error)}).`,
      )
    } finally {
      if (process.platform !== 'win32') {
        try {
          unlinkSync(stagedPath)
        } catch {
          /* Best-effort unlink after POSIX dlopen. */
        }
      }
    }
    return
  }

  let currentStat: BigIntStats
  try {
    currentStat = lstatSync(binaryPath, { bigint: true })
  } catch {
    throw new AgyNativeLoaderError('agy-sqlite-file binary vanished before dlopen.')
  }
  if (
    !currentStat.isFile() ||
    currentStat.isSymbolicLink() ||
    !bigIntStatsMatch(currentStat, pinnedStat)
  ) {
    throw new AgyNativeLoaderError(
      'agy-sqlite-file binary identity changed between integrity check and dlopen.',
    )
  }
  try {
    process.dlopen(moduleShim, binaryPath)
  } catch (error) {
    throw new AgyNativeLoaderError(
      `Failed to load native module (${error instanceof Error ? error.message : String(error)}).`,
    )
  }
}

function loadNativeBinding(): NativeAgySqliteFileBinding {
  if (cachedBinding) return cachedBinding
  const { binaryPath, binaryBytes, pinnedStat, expectedIdentity, packaged } =
    locateAndVerifyNativeBinary()
  const moduleShim = { exports: {} as Partial<NativeAgySqliteFileBinding> }
  dlopenVerifiedBinary(moduleShim, binaryPath, binaryBytes, pinnedStat, packaged)
  const exportsObj = moduleShim.exports
  if (
    typeof exportsObj.moduleIdentity !== 'function' ||
    typeof exportsObj.openAnchoredLockedView !== 'function' ||
    typeof exportsObj.verifyCandidateEmptyUnlocked !== 'function' ||
    typeof exportsObj.publishCandidateAtomically !== 'function' ||
    typeof exportsObj.checkSameVolume !== 'function'
  ) {
    throw new AgyNativeLoaderError(
      'agy-sqlite-file native module did not export its required N-API symbols.',
    )
  }
  const binding: NativeAgySqliteFileBinding = {
    moduleIdentity: exportsObj.moduleIdentity,
    openAnchoredLockedView: exportsObj.openAnchoredLockedView,
    verifyCandidateEmptyUnlocked: exportsObj.verifyCandidateEmptyUnlocked,
    publishCandidateAtomically: exportsObj.publishCandidateAtomically,
    checkSameVolume: exportsObj.checkSameVolume,
  }
  const observed = binding.moduleIdentity()
  if (
    observed.version !== expectedIdentity.version ||
    observed.platform !== expectedIdentity.platform ||
    observed.architecture !== expectedIdentity.architecture ||
    observed.sourceSha256 !== expectedIdentity.sourceSha256
  ) {
    throw new AgyNativeLoaderError(
      'agy-sqlite-file native module rejected its verified source identity.',
    )
  }
  cachedBinding = binding
  cachedIdentity = observed
  return binding
}

export function getAgySqliteFileModuleIdentity(): AgySqliteFileModuleIdentity {
  loadNativeBinding()
  return cachedIdentity!
}

export function openAnchoredLockedSqliteView(
  rootDir: string,
  parentSegments: readonly string[],
  leafName: string,
  options?: AgyOpenLockedViewOptions,
): AgyLockedSqliteView {
  const hooks = activeTestHooks
  hooks?.onBeforeOpen?.({ rootDir, parentSegments, leafName })
  const binding = loadNativeBinding()
  const rawView = binding.openAnchoredLockedView(rootDir, parentSegments, leafName, options)
  activeOpenViewCount += 1
  let closed = false

  const releaseView = (): void => {
    if (closed) return
    closed = true
    activeOpenViewCount = Math.max(0, activeOpenViewCount - 1)
    try {
      rawView.close()
    } finally {
      hooks?.onClose?.({ rootDir, parentSegments, leafName })
    }
  }

  const wrapped: AgyLockedSqliteView = {
    get byteLength() {
      return rawView.byteLength
    },
    get walByteLength() {
      return rawView.walByteLength
    },
    get shmByteLength() {
      return rawView.shmByteLength
    },
    get hasWal() {
      return rawView.hasWal
    },
    get hasShm() {
      return rawView.hasShm
    },
    get hasJournal() {
      return rawView.hasJournal
    },
    get sharedLockHeld() {
      return rawView.sharedLockHeld
    },
    get fileIdentity() {
      return rawView.fileIdentity
    },
    get walIdentity() {
      return rawView.walIdentity
    },
    get shmIdentity() {
      return rawView.shmIdentity
    },
    readAt(offset: number, length: number): Buffer {
      const buf = rawView.readAt(offset, length)
      hooks?.onAfterRead?.({ stream: 'db', offset, length, leafName })
      return buf
    },
    readWalAt(offset: number, length: number): Buffer {
      const buf = rawView.readWalAt(offset, length)
      hooks?.onAfterRead?.({ stream: 'wal', offset, length, leafName })
      return buf
    },
    readShmAt(offset: number, length: number): Buffer {
      const buf = rawView.readShmAt(offset, length)
      hooks?.onAfterRead?.({ stream: 'shm', offset, length, leafName })
      return buf
    },
    verifyUnchanged(): AgyLockedViewVerifyResult {
      hooks?.onBeforeVerifyUnchanged?.({ leafName })
      return rawView.verifyUnchanged()
    },
    close(): void {
      releaseView()
    },
  }

  if (hooks?.onAfterOpen) {
    try {
      hooks.onAfterOpen({ rootDir, parentSegments, leafName, view: wrapped })
    } catch (error) {
      releaseView()
      throw error
    }
  }
  return wrapped
}

export function verifyCandidateEmptyUnlocked(
  rootDir: string,
  parentSegments: readonly string[],
  leafName: string,
): AgyCandidateEmptyCheckResult {
  const binding = loadNativeBinding()
  return binding.verifyCandidateEmptyUnlocked(rootDir, parentSegments, leafName)
}

export function publishCandidateAtomically(input: {
  readonly rootDir: string
  readonly targetParentSegments: readonly string[]
  readonly targetLeafName: string
  readonly stagedParentSegments: readonly string[]
  readonly stagedLeafName: string
  readonly expectedTargetIdentity: AgySqliteFileIdentity
  readonly expectedStagedIdentity: AgySqliteFileIdentity
}): AgyAtomicPublishResult {
  const hooks = activeTestHooks
  hooks?.onBeforePublish?.({
    rootDir: input.rootDir,
    targetParentSegments: input.targetParentSegments,
    targetLeafName: input.targetLeafName,
    stagedParentSegments: input.stagedParentSegments,
    stagedLeafName: input.stagedLeafName,
  })
  const binding = loadNativeBinding()
  const result = binding.publishCandidateAtomically(
    input.rootDir,
    input.targetParentSegments,
    input.targetLeafName,
    input.stagedParentSegments,
    input.stagedLeafName,
    input.expectedTargetIdentity,
    input.expectedStagedIdentity,
  )
  hooks?.onAfterPublish?.({ targetLeafName: input.targetLeafName, result })
  return result
}

export function checkSameVolume(
  rootDir: string,
  leftParentSegments: readonly string[],
  rightParentSegments: readonly string[],
): boolean {
  const binding = loadNativeBinding()
  return binding.checkSameVolume(rootDir, leftParentSegments, rightParentSegments)
}
