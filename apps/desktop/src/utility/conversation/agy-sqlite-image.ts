import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { endianness, tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentExecutionError } from './agent-execution-error'
import {
  AgyNativeLoaderError,
  openAnchoredLockedSqliteView,
  type AgyLockedSqliteView,
  type AgySqliteFileIdentity,
} from './agy-sqlite-file'

export const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'ascii')
export const SQLITE_WAL_INDEX_HEADER_BYTES = 136
export const SQLITE_WAL_VERSION = 3_007_000
export const SQLITE_MAX_SCHEMA_FORMAT = 4

export const MAX_IDENTITY_WAL_SCAN_BYTES = 64 * 1024 * 1024
export const MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES = 256 * 1024 * 1024
export const MAX_TRAJECTORY_METADATA_PAGES = 256
export const MAX_TRAJECTORY_RECORD_BYTES = 1024 * 1024
export const MAX_TRAJECTORY_OVERFLOW_HOPS = 64
export const MAX_FALLBACK_TABLE_DDL_BYTES = 64 * 1024
export const MAX_SCHEMA_CATALOG_TOTAL_BYTES = 512 * 1024
export const MAX_SCHEMA_CATALOG_ENTRIES = 1024
export const MAX_STAT_ROWS = 4_096
export const MAX_IDENTITY_WAL_SHRINK_PRUNE_WORK = 262_144

export interface AgySchemaCatalogBudget {
  readonly maxItemSqlBytes?: number
  readonly maxTotalBytes?: number
  readonly maxEntries?: number
  readonly maxPages?: number
  readonly maxStatBytes?: number
  readonly maxStatRows?: number
}

export interface AgyWalShrinkBudget {
  readonly maxWork?: number
  readonly onPruneWork?: (totalWork: number) => void
}

const OPERATIONAL_FS_ERROR_CODES = new Set([
  'ENOSPC',
  'EDQUOT',
  'EROFS',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'EIO',
])
const STAGING_OPERATIONAL_FS_ERROR_CODES = new Set([
  ...OPERATIONAL_FS_ERROR_CODES,
  'EACCES',
  'EPERM',
])

export class AgyOperationalStorageError extends Error {
  readonly code?: string

  constructor(message: string, code?: string) {
    super(message)
    this.name = 'AgyOperationalStorageError'
    if (code !== undefined) {
      this.code = code
    }
  }
}

export class AgyHotRollbackJournalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgyHotRollbackJournalError'
  }
}

export class AgyTransientIdentityChurnError extends Error {
  readonly reason?: string

  constructor(message: string, reason?: string) {
    super(message)
    this.name = 'AgyTransientIdentityChurnError'
    if (reason !== undefined) {
      this.reason = reason
    }
  }
}

export class AgyIdentityFallbackError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgyIdentityFallbackError'
  }
}

export class AgyIdentityBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgyIdentityBudgetExceededError'
  }
}

export class AgyInvalidSqliteImageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgyInvalidSqliteImageError'
  }
}

export class AgyStorageMissingError extends Error {
  readonly stage: 'root' | 'parent' | 'leaf'
  readonly code = 'ENOENT'

  constructor(stage: 'root' | 'parent' | 'leaf', message: string) {
    super(message)
    this.name = 'AgyStorageMissingError'
    this.stage = stage
  }
}

export class AgyUnexpectedEofError extends Error {
  constructor(message = 'Unexpected EOF while reading SQLite bytes.') {
    super(message)
    this.name = 'AgyUnexpectedEofError'
  }
}

export function isTransientFileLockError(
  error: unknown,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!(error instanceof Error)) return false
  const code = Reflect.get(error, 'code')
  if (code === 'EBUSY' || code === 'EAGAIN') return true
  if (platform === 'win32' && (code === 'EACCES' || code === 'EPERM')) return true
  return false
}

export function isOperationalFsError(error: unknown, includePermission = false): boolean {
  if (!(error instanceof Error)) return false
  const code = Reflect.get(error, 'code')
  if (typeof code !== 'string') return false
  return includePermission
    ? STAGING_OPERATIONAL_FS_ERROR_CODES.has(code)
    : OPERATIONAL_FS_ERROR_CODES.has(code)
}

/**
 * Classifies SQLite primary AND extended operational error codes (`SQLITE_IOERR`,
 * `SQLITE_IOERR_READ`, `SQLITE_IOERR_FSTAT`, `SQLITE_FULL_*`, `SQLITE_NOMEM_*`).
 */
export function isOperationalSqliteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = Reflect.get(error, 'code')
  if (typeof code !== 'string') return false
  return (
    code === 'SQLITE_IOERR' ||
    code.startsWith('SQLITE_IOERR_') ||
    code === 'SQLITE_FULL' ||
    code.startsWith('SQLITE_FULL_') ||
    code === 'SQLITE_NOMEM' ||
    code.startsWith('SQLITE_NOMEM_')
  )
}

export function isSqliteBusyOrLockedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = Reflect.get(error, 'code')
  if (
    typeof code === 'string' &&
    (code === 'SQLITE_BUSY' ||
      code.startsWith('SQLITE_BUSY_') ||
      code === 'SQLITE_LOCKED' ||
      code.startsWith('SQLITE_LOCKED_'))
  ) {
    return true
  }
  return /\bdatabase is locked\b/iu.test(error.message)
}

export function wrapOperationalStagingError(error: unknown, context: string): Error {
  if (error instanceof AgyOperationalStorageError) return error
  if (error instanceof Error) {
    const rawCode = Reflect.get(error, 'code')
    const code = typeof rawCode === 'string' ? rawCode : undefined
    if (
      isOperationalFsError(error, true) ||
      isOperationalSqliteError(error) ||
      code === 'SQLITE_CANTOPEN' ||
      (code !== undefined && code.startsWith('SQLITE_CANTOPEN_'))
    ) {
      return new AgyOperationalStorageError(`${context}: ${error.message}`, code)
    }
    return error
  }
  return new Error(`${context}: ${String(error)}`)
}

export function isIdentityAbortOrTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || error.name === 'TimeoutError'
}

export function assertIdentityNotCancelledOrExpired(
  signal?: AbortSignal,
  deadlineAt?: number,
): void {
  if (signal?.aborted) {
    if (signal.reason instanceof Error) {
      if (signal.reason.name === 'AbortError' || signal.reason.name === 'TimeoutError') {
        throw signal.reason
      }
      throw Object.assign(new Error(signal.reason.message || 'Operation was cancelled.'), {
        name: 'AbortError',
      })
    }
    throw Object.assign(new Error('Antigravity trajectory identity inspection was cancelled.'), {
      name: 'AbortError',
    })
  }
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw Object.assign(
      new Error('Antigravity trajectory identity inspection exceeded its deadline.'),
      { name: 'TimeoutError' },
    )
  }
}

function writeAllSync(
  fd: number,
  buffer: Buffer,
  offset = 0,
  length = buffer.byteLength - offset,
): void {
  let writtenTotal = 0
  while (writtenTotal < length) {
    const written = writeSync(fd, buffer, offset + writtenTotal, length - writtenTotal)
    if (written <= 0) {
      throw new Error('Short or zero-byte write while staging Antigravity file.')
    }
    writtenTotal += written
  }
}

function readExactBytesFromFd(fd: number, target: Buffer, length: number, offset: number): void {
  let totalRead = 0
  while (totalRead < length) {
    const n = readSync(fd, target, totalRead, length - totalRead, offset + totalRead)
    if (n <= 0) {
      throw new AgyUnexpectedEofError()
    }
    totalRead += n
  }
}

function readUInt32Native(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset)
}

function readUInt16Native(buf: Buffer, offset: number, littleEndian: boolean): number {
  return littleEndian ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset)
}

export function walChecksumStep(
  buf: Buffer,
  offset: number,
  length: number,
  littleEndian: boolean,
  s1Init: number,
  s2Init: number,
): [number, number] {
  let s1 = s1Init >>> 0
  let s2 = s2Init >>> 0
  for (let i = 0; i < length; i += 8) {
    const x0 = littleEndian ? buf.readUInt32LE(offset + i) : buf.readUInt32BE(offset + i)
    const x1 = littleEndian ? buf.readUInt32LE(offset + i + 4) : buf.readUInt32BE(offset + i + 4)
    s1 = (s1 + x0 + s2) >>> 0
    s2 = (s2 + x1 + s1) >>> 0
  }
  return [s1, s2]
}

export function decodeSqliteVarint(
  buf: Buffer,
  start: number,
  end = buf.byteLength,
): { value: bigint; nextOffset: number } {
  let value = 0n
  for (let i = 0; i < 9; i += 1) {
    const pos = start + i
    if (pos >= end) throw new Error('Truncated SQLite varint.')
    const byte = buf[pos]!
    if (i === 8) {
      value = (value << 8n) | BigInt(byte)
      return { value: BigInt.asIntN(64, value), nextOffset: pos + 1 }
    }
    value = (value << 7n) | BigInt(byte & 0x7f)
    if ((byte & 0x80) === 0) {
      return { value, nextOffset: pos + 1 }
    }
  }
  throw new Error('Malformed SQLite varint.')
}

export function sqliteSerialTypeByteLengthBig(serialType: bigint): bigint {
  if (serialType <= 0n || serialType === 8n || serialType === 9n) return 0n
  if (serialType === 1n) return 1n
  if (serialType === 2n) return 2n
  if (serialType === 3n) return 3n
  if (serialType === 4n) return 4n
  if (serialType === 5n) return 6n
  if (serialType === 6n || serialType === 7n) return 8n
  if (serialType === 10n || serialType === 11n) {
    throw new Error('Unsupported internal SQLite serial type.')
  }
  if (serialType >= 12n) {
    return (serialType - (serialType % 2n === 0n ? 12n : 13n)) / 2n
  }
  throw new Error('Invalid SQLite serial type.')
}

export function sqliteSerialTypeByteLength(serialType: bigint): number {
  const byteLen = sqliteSerialTypeByteLengthBig(serialType)
  if (byteLen < 0n || byteLen > BigInt(MAX_TRAJECTORY_RECORD_BYTES)) {
    throw new AgyIdentityFallbackError('SQLite record column exceeds fast-path byte budget.')
  }
  return Number(byteLen)
}

export function decodeSqliteRecordHeader(
  payload: Buffer,
  totalPayloadLen: number,
  maxNeededColumnIndex?: number,
): bigint[] {
  const hdrSizeDec = decodeSqliteVarint(payload, 0, payload.byteLength)
  const hdrSize = Number(hdrSizeDec.value)
  if (
    hdrSizeDec.value < 1n ||
    !Number.isSafeInteger(hdrSize) ||
    hdrSize < hdrSizeDec.nextOffset ||
    hdrSize > totalPayloadLen
  ) {
    throw new Error('Invalid SQLite record header length.')
  }
  const truncatedByPrefix = hdrSize > payload.byteLength
  const availableHdrEnd = truncatedByPrefix ? payload.byteLength : hdrSize
  let hdrPos = hdrSizeDec.nextOffset
  const serialTypes: bigint[] = []
  while (hdrPos < availableHdrEnd) {
    if (maxNeededColumnIndex !== undefined && serialTypes.length > maxNeededColumnIndex) {
      return serialTypes
    }
    let st: { value: bigint; nextOffset: number }
    try {
      st = decodeSqliteVarint(payload, hdrPos, availableHdrEnd)
    } catch (error) {
      if (truncatedByPrefix) {
        throw new AgyIdentityFallbackError('SQLite record header exceeded fast-path prefix.')
      }
      throw error
    }
    serialTypes.push(st.value)
    hdrPos = st.nextOffset
    if (serialTypes.length > 2048) {
      throw new AgyIdentityFallbackError('SQLite record column count exceeded fast-path bound.')
    }
  }
  if (truncatedByPrefix) {
    if (maxNeededColumnIndex !== undefined && serialTypes.length > maxNeededColumnIndex) {
      return serialTypes
    }
    throw new AgyIdentityFallbackError('SQLite record header exceeded fast-path prefix.')
  }
  return serialTypes
}

const utf16beDecoder = new TextDecoder('utf-16be')

export function decodeSqliteRecord(
  payload: Buffer,
  maxNeededColumns: number,
  textEncoding = 1,
): { serialTypes: bigint[]; values: unknown[] } {
  const hdrSizeDec = decodeSqliteVarint(payload, 0, payload.byteLength)
  const hdrSize = Number(hdrSizeDec.value)
  if (
    hdrSizeDec.value < 1n ||
    !Number.isSafeInteger(hdrSize) ||
    hdrSize > payload.byteLength ||
    hdrSize < hdrSizeDec.nextOffset
  ) {
    throw new Error('Invalid SQLite record header length.')
  }
  let hdrPos = hdrSizeDec.nextOffset
  const serialTypes: bigint[] = []
  while (hdrPos < hdrSize) {
    const st = decodeSqliteVarint(payload, hdrPos, hdrSize)
    serialTypes.push(st.value)
    hdrPos = st.nextOffset
    if (serialTypes.length > 2048) {
      throw new AgyIdentityFallbackError('SQLite record column count exceeded fast-path bound.')
    }
  }
  const values: unknown[] = []
  let dataPos = hdrSize
  const limit = Math.min(serialTypes.length, maxNeededColumns)
  for (let i = 0; i < limit; i += 1) {
    const st = serialTypes[i]!
    const byteLen = sqliteSerialTypeByteLength(st)
    if (dataPos + byteLen > payload.byteLength) {
      throw new Error('Truncated SQLite record payload.')
    }
    if (st === 0n) {
      values.push(null)
    } else if (st === 8n) {
      values.push(0n)
    } else if (st === 9n) {
      values.push(1n)
    } else if (st >= 1n && st <= 6n) {
      let intVal = 0n
      for (let b = 0; b < byteLen; b += 1) {
        intVal = (intVal << 8n) | BigInt(payload[dataPos + b]!)
      }
      const bits = BigInt(byteLen * 8)
      const signBit = 1n << (bits - 1n)
      if ((intVal & signBit) !== 0n) {
        intVal -= 1n << bits
      }
      values.push(intVal)
    } else if (st === 7n) {
      values.push(payload.readDoubleBE(dataPos))
    } else if (st >= 12n && st % 2n === 0n) {
      values.push(Buffer.from(payload.subarray(dataPos, dataPos + byteLen)))
    } else {
      const slice = payload.subarray(dataPos, dataPos + byteLen)
      if (textEncoding === 2) {
        values.push(slice.toString('utf16le'))
      } else if (textEncoding === 3) {
        values.push(utf16beDecoder.decode(slice))
      } else {
        values.push(slice.toString('utf8'))
      }
    }
    dataPos += byteLen
  }
  return { serialTypes, values }
}

export function assembleSqliteLeafPayload(
  readPage: (pageNo: number) => Buffer,
  usableSize: number,
  pageBuf: Buffer,
  payloadStart: number,
  payloadLen: number,
  maxPrefixBytes?: number,
): Buffer {
  if (payloadLen < 0 || !Number.isSafeInteger(payloadLen)) {
    throw new Error('SQLite record payload length invalid.')
  }
  if (maxPrefixBytes === undefined && payloadLen > MAX_TRAJECTORY_RECORD_BYTES) {
    throw new AgyIdentityFallbackError('SQLite record payload exceeds fast-path limit.')
  }
  const targetLen = maxPrefixBytes !== undefined ? Math.min(payloadLen, maxPrefixBytes) : payloadLen
  const xMax = usableSize - 35
  if (payloadLen <= xMax) {
    if (payloadStart + payloadLen > usableSize) {
      throw new Error('Inline SQLite cell payload exceeded usable page size.')
    }
    return pageBuf.subarray(payloadStart, payloadStart + targetLen)
  }
  const mMin = Math.floor(((usableSize - 12) * 32) / 255) - 23
  const kMod = mMin + ((payloadLen - mMin) % (usableSize - 4))
  const localLen = kMod <= xMax ? kMod : mMin
  if (payloadStart + localLen + 4 > usableSize) {
    throw new Error('Overflow SQLite cell local payload exceeded usable page size.')
  }
  const takeLocal = Math.min(localLen, targetLen)
  const chunks: Buffer[] = [pageBuf.subarray(payloadStart, payloadStart + takeLocal)]
  let collected = takeLocal
  let nextOverflowPage = pageBuf.readUInt32BE(payloadStart + localLen)
  let hops = 0
  while (collected < targetLen) {
    if (nextOverflowPage === 0 || hops >= MAX_TRAJECTORY_OVERFLOW_HOPS) {
      throw new AgyIdentityFallbackError('SQLite overflow page chain exceeded fast-path limit.')
    }
    hops += 1
    const ovBuf = readPage(nextOverflowPage)
    const take = Math.min(targetLen - collected, usableSize - 4)
    chunks.push(ovBuf.subarray(4, 4 + take))
    collected += take
    nextOverflowPage = ovBuf.readUInt32BE(0)
  }
  return Buffer.concat(chunks, collected)
}

interface ValidatedWalIndexHeader {
  readonly bytes: Buffer
  readonly bigEndCksum: number
  readonly mxFrame: number
  readonly nPage: number
  readonly aFrameCksum0: number
  readonly aFrameCksum1: number
  readonly aSaltRaw: Buffer
}

export function parseValidatedWalIndexHeader(
  shmBuf: Buffer,
  expectedPageSize: number,
  nativeLittleEndian: boolean,
): ValidatedWalIndexHeader {
  if (shmBuf.byteLength < SQLITE_WAL_INDEX_HEADER_BYTES) {
    throw new AgyTransientIdentityChurnError('SQLite wal-index header is incomplete.')
  }
  const hdr1 = shmBuf.subarray(0, 48)
  const hdr2 = shmBuf.subarray(48, 96)
  if (!hdr1.equals(hdr2)) {
    throw new AgyTransientIdentityChurnError('SQLite wal-index dual header is being updated.')
  }
  const iVersion = readUInt32Native(hdr1, 0, nativeLittleEndian)
  const isInit = hdr1[12]!
  const bigEndCksum = hdr1[13]!
  const rawSzPage = readUInt16Native(hdr1, 14, nativeLittleEndian)
  const szPage = rawSzPage === 1 ? 65_536 : rawSzPage
  const mxFrame = readUInt32Native(hdr1, 16, nativeLittleEndian)
  const nPage = readUInt32Native(hdr1, 20, nativeLittleEndian)
  const aFrameCksum0 = readUInt32Native(hdr1, 24, nativeLittleEndian)
  const aFrameCksum1 = readUInt32Native(hdr1, 28, nativeLittleEndian)
  const aSaltRaw = Buffer.from(hdr1.subarray(32, 40))
  const aCksum0 = readUInt32Native(hdr1, 40, nativeLittleEndian)
  const aCksum1 = readUInt32Native(hdr1, 44, nativeLittleEndian)

  const pageSizeValid =
    mxFrame === 0 ? szPage === 0 || szPage === expectedPageSize : szPage === expectedPageSize
  if (
    iVersion !== SQLITE_WAL_VERSION ||
    isInit !== 1 ||
    (bigEndCksum !== 0 && bigEndCksum !== 1) ||
    !pageSizeValid
  ) {
    throw new AgyTransientIdentityChurnError('SQLite wal-index header is not initialized.')
  }
  const [ck0, ck1] = walChecksumStep(hdr1, 0, 40, nativeLittleEndian, 0, 0)
  if (ck0 !== aCksum0 || ck1 !== aCksum1) {
    throw new AgyTransientIdentityChurnError('SQLite wal-index header checksum mismatch.')
  }
  const nBackfill = readUInt32Native(shmBuf, 96, nativeLittleEndian)
  const nBackfillAttempted = readUInt32Native(shmBuf, 128, nativeLittleEndian)
  if (nBackfill > mxFrame || nBackfillAttempted > mxFrame) {
    throw new AgyTransientIdentityChurnError(
      'SQLite wal-index backfill count exceeds published mxFrame.',
    )
  }
  return {
    bytes: Buffer.from(shmBuf.subarray(0, SQLITE_WAL_INDEX_HEADER_BYTES)),
    bigEndCksum,
    mxFrame,
    nPage,
    aFrameCksum0,
    aFrameCksum1,
    aSaltRaw,
  }
}

interface CommittedWalState {
  readonly committedWalPages: Map<number, number>
  committedDbPageCount: number
  maxCommittedWalPage: number
  shrinkPruneWork: number
}

function applyCommittedWalTransaction(
  state: CommittedWalState,
  pendingTx: Map<number, number>,
  dbSizeAfterCommit: number,
  walShrinkBudget?: AgyWalShrinkBudget,
): void {
  const prevPageCount = state.committedDbPageCount
  if (dbSizeAfterCommit < prevPageCount && state.committedWalPages.size > 0) {
    const maxWork = walShrinkBudget?.maxWork ?? MAX_IDENTITY_WAL_SHRINK_PRUNE_WORK
    const upperBound = Math.min(prevPageCount, state.maxCommittedWalPage)
    const rangeSteps = upperBound > dbSizeAfterCommit ? upperBound - dbSizeAfterCommit : 0
    if (rangeSteps <= state.committedWalPages.size) {
      for (let p = dbSizeAfterCommit + 1; p <= upperBound; p += 1) {
        state.shrinkPruneWork += 1
        if (state.shrinkPruneWork > maxWork) {
          throw new AgyIdentityBudgetExceededError(
            'Active Antigravity WAL shrink pruning exceeded its bounded work budget.',
          )
        }
        state.committedWalPages.delete(p)
      }
    } else {
      for (const existingPage of state.committedWalPages.keys()) {
        state.shrinkPruneWork += 1
        if (state.shrinkPruneWork > maxWork) {
          throw new AgyIdentityBudgetExceededError(
            'Active Antigravity WAL shrink pruning exceeded its bounded work budget.',
          )
        }
        if (existingPage > dbSizeAfterCommit) {
          state.committedWalPages.delete(existingPage)
        }
      }
    }
    if (state.maxCommittedWalPage > dbSizeAfterCommit) {
      state.maxCommittedWalPage = dbSizeAfterCommit
    }
    walShrinkBudget?.onPruneWork?.(state.shrinkPruneWork)
  }
  for (const [p, off] of pendingTx) {
    if (p <= dbSizeAfterCommit) {
      state.committedWalPages.set(p, off)
      if (p > state.maxCommittedWalPage) {
        state.maxCommittedWalPage = p
      }
    }
  }
  state.committedDbPageCount = dbSizeAfterCommit
  pendingTx.clear()
}

interface ScannedPublishedWalResult {
  readonly invalidWalMagic: boolean
  readonly committedWalPages: Map<number, number>
  readonly committedDbPageCount: number
  readonly walCopyByteLimit: number | undefined
  readonly initialWalHeaderDigest: string | undefined
  readonly walHeaderLen: number
  readonly stoppedWalFrameOffset: number | undefined
  readonly stoppedWalFrameHdrDigest: string | undefined
}

function scanPublishedWalBoundaryFromView(input: {
  readonly view: AgyLockedSqliteView
  readonly shmHeader: ValidatedWalIndexHeader | undefined
  readonly pageSize: number
  readonly initialDbPageCount: number
  readonly maxWalScanBytes: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly walShrinkBudget?: AgyWalShrinkBudget
}): ScannedPublishedWalResult {
  const { view, shmHeader, pageSize, initialDbPageCount, maxWalScanBytes, signal, deadlineAt } =
    input
  const frameSize = 24 + pageSize
  const walState: CommittedWalState = {
    committedWalPages: new Map<number, number>(),
    committedDbPageCount: initialDbPageCount,
    maxCommittedWalPage: 0,
    shrinkPruneWork: 0,
  }
  let walCopyByteLimit: number | undefined
  let initialWalHeaderDigest: string | undefined
  let walHeaderLen = 0
  let stoppedWalFrameOffset: number | undefined
  let stoppedWalFrameHdrDigest: string | undefined

  const hasWal = view.hasWal
  const walByteLength = view.walByteLength

  if (shmHeader !== undefined) {
    if (shmHeader.mxFrame === 0) {
      walCopyByteLimit = 0
      if (hasWal && walByteLength >= 32) {
        if (!Number.isSafeInteger(walByteLength)) {
          throw new AgyIdentityBudgetExceededError(
            'Antigravity WAL file size exceeds safe integer bounds.',
          )
        }
        const walHdr = view.readWalAt(0, 32)
        initialWalHeaderDigest = createHash('sha256').update(walHdr).digest('hex')
        walHeaderLen = 32
        const magic = walHdr.readUInt32BE(0)
        const walLittleEndian = magic === 0x377f0682
        const walFormatVersion = walHdr.readUInt32BE(4)
        const walPageSize = walHdr.readUInt32BE(8)
        if (
          (walLittleEndian || magic === 0x377f0683) &&
          walFormatVersion === SQLITE_WAL_VERSION &&
          walPageSize === pageSize
        ) {
          const salt1 = walHdr.readUInt32BE(16)
          const salt2 = walHdr.readUInt32BE(20)
          const hdrCk1 = walHdr.readUInt32BE(24)
          const hdrCk2 = walHdr.readUInt32BE(28)
          let [s1, s2] = walChecksumStep(walHdr, 0, 24, walLittleEndian, 0, 0)
          if (s1 === hdrCk1 && s2 === hdrCk2) {
            let probePos = 32
            let probedBytes = 0
            let probedFrames = 0
            while (probePos + frameSize <= walByteLength) {
              if ((probedFrames & 0xff) === 0) {
                assertIdentityNotCancelledOrExpired(signal, deadlineAt)
              }
              probedFrames += 1
              const frameBuf = view.readWalAt(probePos, frameSize)
              const pageNo = frameBuf.readUInt32BE(0)
              const dbSizeAfterCommit = frameBuf.readUInt32BE(4)
              const fSalt1 = frameBuf.readUInt32BE(8)
              const fSalt2 = frameBuf.readUInt32BE(12)
              if (fSalt1 !== salt1 || fSalt2 !== salt2 || pageNo === 0) {
                stoppedWalFrameOffset = probePos
                stoppedWalFrameHdrDigest = createHash('sha256')
                  .update(frameBuf.subarray(0, 24))
                  .digest('hex')
                break
              }
              const fCk1 = frameBuf.readUInt32BE(16)
              const fCk2 = frameBuf.readUInt32BE(20)
              ;[s1, s2] = walChecksumStep(frameBuf, 0, 8, walLittleEndian, s1, s2)
              ;[s1, s2] = walChecksumStep(frameBuf, 24, pageSize, walLittleEndian, s1, s2)
              if (s1 !== fCk1 || s2 !== fCk2) {
                stoppedWalFrameOffset = probePos
                stoppedWalFrameHdrDigest = createHash('sha256')
                  .update(frameBuf.subarray(0, 24))
                  .digest('hex')
                break
              }
              if (dbSizeAfterCommit > 0) {
                throw new AgyTransientIdentityChurnError(
                  'WAL contains a valid committed transaction beyond published wal-index mxFrame=0.',
                  'wal_exceeds_published_shm_boundary',
                )
              }
              probedBytes += frameSize
              if (probedBytes > maxWalScanBytes) {
                throw new AgyIdentityBudgetExceededError(
                  'Active Antigravity WAL scan beyond published mxFrame=0 exceeded the 64 MiB budget.',
                )
              }
              probePos += frameSize
            }
          }
        }
      }
    } else {
      if (shmHeader.nPage === 0) {
        throw new AgyTransientIdentityChurnError(
          'Online wal-index has zero nPage with mxFrame > 0.',
        )
      }
      if (!hasWal || walByteLength < 32) {
        throw new AgyTransientIdentityChurnError(
          'WAL file is missing or incomplete for published wal-index mxFrame.',
        )
      }
      const walHdr = view.readWalAt(0, 32)
      initialWalHeaderDigest = createHash('sha256').update(walHdr).digest('hex')
      walHeaderLen = 32
      const magic = walHdr.readUInt32BE(0)
      const walLittleEndian = magic === 0x377f0682
      if ((!walLittleEndian && magic !== 0x377f0683) || shmHeader.bigEndCksum !== (magic & 1)) {
        throw new AgyTransientIdentityChurnError('WAL magic disagrees with online wal-index.')
      }
      const walFormatVersion = walHdr.readUInt32BE(4)
      const walPageSize = walHdr.readUInt32BE(8)
      if (
        walFormatVersion !== SQLITE_WAL_VERSION ||
        walPageSize !== pageSize ||
        !walHdr.subarray(16, 24).equals(shmHeader.aSaltRaw)
      ) {
        throw new AgyTransientIdentityChurnError(
          'WAL header salt or geometry does not match online wal-index.',
        )
      }
      const salt1 = walHdr.readUInt32BE(16)
      const salt2 = walHdr.readUInt32BE(20)
      const hdrCk1 = walHdr.readUInt32BE(24)
      const hdrCk2 = walHdr.readUInt32BE(28)
      let [s1, s2] = walChecksumStep(walHdr, 0, 24, walLittleEndian, 0, 0)
      if (s1 !== hdrCk1 || s2 !== hdrCk2) {
        throw new AgyTransientIdentityChurnError('WAL header checksum mismatch.')
      }

      const activeWalScanBytesBig = BigInt(shmHeader.mxFrame) * BigInt(frameSize)
      const requiredWalBytesBig = 32n + activeWalScanBytesBig
      if (BigInt(walByteLength) < requiredWalBytesBig) {
        throw new AgyTransientIdentityChurnError(
          'WAL file is missing or shorter than published wal-index mxFrame.',
        )
      }
      if (activeWalScanBytesBig > BigInt(maxWalScanBytes)) {
        throw new AgyIdentityBudgetExceededError(
          `Active Antigravity WAL scan (${activeWalScanBytesBig.toString()} bytes) exceeded the 64 MiB budget.`,
        )
      }
      const activeWalScanBytes = Number(activeWalScanBytesBig)
      const requiredWalBytes = Number(requiredWalBytesBig)
      if (!Number.isSafeInteger(walByteLength)) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity WAL file size exceeds safe integer bounds.',
        )
      }
      walCopyByteLimit = requiredWalBytes

      const pendingTx = new Map<number, number>()
      for (let frameIdx = 0; frameIdx < shmHeader.mxFrame; frameIdx += 1) {
        if ((frameIdx & 0xff) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        const walPos = 32 + frameIdx * frameSize
        const frameBuf = view.readWalAt(walPos, frameSize)
        const pageNo = frameBuf.readUInt32BE(0)
        const dbSizeAfterCommit = frameBuf.readUInt32BE(4)
        const fSalt1 = frameBuf.readUInt32BE(8)
        const fSalt2 = frameBuf.readUInt32BE(12)
        if (fSalt1 !== salt1 || fSalt2 !== salt2 || pageNo === 0) {
          throw new AgyTransientIdentityChurnError(
            'Published WAL frame salt mismatch before mxFrame.',
          )
        }
        const fCk1 = frameBuf.readUInt32BE(16)
        const fCk2 = frameBuf.readUInt32BE(20)
        ;[s1, s2] = walChecksumStep(frameBuf, 0, 8, walLittleEndian, s1, s2)
        ;[s1, s2] = walChecksumStep(frameBuf, 24, pageSize, walLittleEndian, s1, s2)
        if (s1 !== fCk1 || s2 !== fCk2) {
          throw new AgyTransientIdentityChurnError(
            'Published WAL frame checksum mismatch before mxFrame.',
          )
        }
        pendingTx.set(pageNo, walPos + 24)
        if (dbSizeAfterCommit > 0) {
          applyCommittedWalTransaction(
            walState,
            pendingTx,
            dbSizeAfterCommit,
            input.walShrinkBudget,
          )
        }
      }
      if (
        pendingTx.size !== 0 ||
        s1 !== shmHeader.aFrameCksum0 ||
        s2 !== shmHeader.aFrameCksum1 ||
        walState.committedDbPageCount !== shmHeader.nPage
      ) {
        throw new AgyTransientIdentityChurnError(
          'Published wal-index frame checksum or nPage disagrees with WAL prefix.',
        )
      }

      let probePos = requiredWalBytes
      let probedBytes = activeWalScanBytes
      let probedFrames = 0
      while (probePos + frameSize <= walByteLength) {
        if ((probedFrames & 0xff) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        probedFrames += 1
        const frameBuf = view.readWalAt(probePos, frameSize)
        const pageNo = frameBuf.readUInt32BE(0)
        const dbSizeAfterCommit = frameBuf.readUInt32BE(4)
        const fSalt1 = frameBuf.readUInt32BE(8)
        const fSalt2 = frameBuf.readUInt32BE(12)
        if (fSalt1 !== salt1 || fSalt2 !== salt2 || pageNo === 0) {
          stoppedWalFrameOffset = probePos
          stoppedWalFrameHdrDigest = createHash('sha256')
            .update(frameBuf.subarray(0, 24))
            .digest('hex')
          break
        }
        const fCk1 = frameBuf.readUInt32BE(16)
        const fCk2 = frameBuf.readUInt32BE(20)
        ;[s1, s2] = walChecksumStep(frameBuf, 0, 8, walLittleEndian, s1, s2)
        ;[s1, s2] = walChecksumStep(frameBuf, 24, pageSize, walLittleEndian, s1, s2)
        if (s1 !== fCk1 || s2 !== fCk2) {
          stoppedWalFrameOffset = probePos
          stoppedWalFrameHdrDigest = createHash('sha256')
            .update(frameBuf.subarray(0, 24))
            .digest('hex')
          break
        }
        if (dbSizeAfterCommit > 0) {
          throw new AgyTransientIdentityChurnError(
            'WAL contains a valid committed transaction beyond published wal-index mxFrame.',
            'wal_exceeds_published_shm_boundary',
          )
        }
        probedBytes += frameSize
        if (probedBytes > maxWalScanBytes) {
          throw new AgyIdentityBudgetExceededError(
            'Active Antigravity WAL scan beyond published mxFrame exceeded the 64 MiB budget.',
          )
        }
        probePos += frameSize
      }
    }
  } else if (hasWal) {
    if (!Number.isSafeInteger(walByteLength)) {
      throw new AgyIdentityBudgetExceededError(
        'Antigravity WAL file size exceeds safe integer bounds.',
      )
    }
    if (walByteLength < 32) {
      walCopyByteLimit = 0
    } else {
      const walHdr = view.readWalAt(0, 32)
      initialWalHeaderDigest = createHash('sha256').update(walHdr).digest('hex')
      walHeaderLen = 32
      const magic = walHdr.readUInt32BE(0)
      const walLittleEndian = magic === 0x377f0682
      if (!walLittleEndian && magic !== 0x377f0683) {
        return {
          invalidWalMagic: true,
          committedWalPages: walState.committedWalPages,
          committedDbPageCount: walState.committedDbPageCount,
          walCopyByteLimit: undefined,
          initialWalHeaderDigest,
          walHeaderLen,
          stoppedWalFrameOffset: undefined,
          stoppedWalFrameHdrDigest: undefined,
        }
      }
      const walFormatVersion = walHdr.readUInt32BE(4)
      const walPageSize = walHdr.readUInt32BE(8)
      if (walFormatVersion !== SQLITE_WAL_VERSION || walPageSize !== pageSize) {
        throw new AgyTransientIdentityChurnError('WAL header mismatch or checkpointing.')
      }
      const salt1 = walHdr.readUInt32BE(16)
      const salt2 = walHdr.readUInt32BE(20)
      const hdrCk1 = walHdr.readUInt32BE(24)
      const hdrCk2 = walHdr.readUInt32BE(28)
      let [s1, s2] = walChecksumStep(walHdr, 0, 24, walLittleEndian, 0, 0)
      if (s1 !== hdrCk1 || s2 !== hdrCk2) {
        throw new AgyTransientIdentityChurnError('WAL header checksum mismatch.')
      }
      const pendingTx = new Map<number, number>()
      let walPos = 32
      let activeWalScannedBytes = 0
      let scannedFrames = 0
      while (walPos + frameSize <= walByteLength) {
        if ((scannedFrames & 0xff) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        scannedFrames += 1
        const frameBuf = view.readWalAt(walPos, frameSize)
        const pageNo = frameBuf.readUInt32BE(0)
        const dbSizeAfterCommit = frameBuf.readUInt32BE(4)
        const fSalt1 = frameBuf.readUInt32BE(8)
        const fSalt2 = frameBuf.readUInt32BE(12)
        if (fSalt1 !== salt1 || fSalt2 !== salt2 || pageNo === 0) {
          stoppedWalFrameOffset = walPos
          stoppedWalFrameHdrDigest = createHash('sha256')
            .update(frameBuf.subarray(0, 24))
            .digest('hex')
          break
        }
        const fCk1 = frameBuf.readUInt32BE(16)
        const fCk2 = frameBuf.readUInt32BE(20)
        ;[s1, s2] = walChecksumStep(frameBuf, 0, 8, walLittleEndian, s1, s2)
        ;[s1, s2] = walChecksumStep(frameBuf, 24, pageSize, walLittleEndian, s1, s2)
        if (s1 !== fCk1 || s2 !== fCk2) {
          stoppedWalFrameOffset = walPos
          stoppedWalFrameHdrDigest = createHash('sha256')
            .update(frameBuf.subarray(0, 24))
            .digest('hex')
          break
        }
        activeWalScannedBytes += frameSize
        if (activeWalScannedBytes > maxWalScanBytes) {
          throw new AgyIdentityBudgetExceededError(
            'Active Antigravity cold WAL scan exceeded the 64 MiB budget.',
          )
        }
        pendingTx.set(pageNo, walPos + 24)
        if (dbSizeAfterCommit > 0) {
          applyCommittedWalTransaction(
            walState,
            pendingTx,
            dbSizeAfterCommit,
            input.walShrinkBudget,
          )
        }
        walPos += frameSize
      }
      if (stoppedWalFrameOffset !== undefined) {
        walCopyByteLimit = stoppedWalFrameOffset === 32 ? 0 : stoppedWalFrameOffset
      } else {
        walCopyByteLimit = walPos === 32 ? 0 : walPos
      }
    }
  } else {
    walCopyByteLimit = 0
  }

  return {
    invalidWalMagic: false,
    committedWalPages: walState.committedWalPages,
    committedDbPageCount: walState.committedDbPageCount,
    walCopyByteLimit,
    initialWalHeaderDigest,
    walHeaderLen,
    stoppedWalFrameOffset,
    stoppedWalFrameHdrDigest,
  }
}

/**
 * Validates SQLite's page-1 header on the effective committed page 1.
 * Note: Bundled SQLite maps `schemaFormat === 0` to format `1` in `sqlite3InitOne` even on
 * non-empty catalogs, so `0..4` are all treated as valid and MUST undergo full catalog pre-scan
 * (never silently skipped!). Only `schemaFormat > 4` is rejected as unsupported.
 */
export function validateEffectivePageOneHeader(
  effectivePage1: Buffer,
  expectedPageSize: number,
):
  | { readonly valid: true; readonly usableSize: number; readonly effectiveSchemaFormat: number }
  | { readonly valid: false } {
  if (
    effectivePage1.byteLength < 108 ||
    !effectivePage1.subarray(0, 16).equals(SQLITE_HEADER_MAGIC)
  ) {
    return { valid: false }
  }
  const effectiveRawPageSize = effectivePage1.readUInt16BE(16)
  const effectivePageSize = effectiveRawPageSize === 1 ? 65_536 : effectiveRawPageSize
  const effectiveWriteVersion = effectivePage1[18]!
  const effectiveReadVersion = effectivePage1[19]!
  const effectiveReserved = effectivePage1[20]!
  const effectiveUsableSize = effectivePageSize - effectiveReserved
  const schemaFormat = effectivePage1.readUInt32BE(44)
  if (
    effectivePageSize !== expectedPageSize ||
    (effectiveWriteVersion !== 1 && effectiveWriteVersion !== 2) ||
    (effectiveReadVersion !== 1 && effectiveReadVersion !== 2) ||
    effectiveUsableSize < 480 ||
    effectivePage1[21] !== 64 ||
    effectivePage1[22] !== 32 ||
    effectivePage1[23] !== 32 ||
    schemaFormat > SQLITE_MAX_SCHEMA_FORMAT
  ) {
    return { valid: false }
  }
  return {
    valid: true,
    usableSize: effectiveUsableSize,
    effectiveSchemaFormat: schemaFormat === 0 ? 1 : schemaFormat,
  }
}

function isCreateVirtualTableSql(sql: string): boolean {
  // Strip leading whitespace and SQL comments (`-- ...` and `/* ... */`) then check CREATE VIRTUAL TABLE.
  let pos = 0
  const len = sql.length
  const tokens: string[] = []
  while (pos < len && tokens.length < 3) {
    const ch = sql[pos]!
    if (ch <= ' ') {
      pos += 1
      continue
    }
    if (ch === '-' && sql[pos + 1] === '-') {
      pos += 2
      while (pos < len && sql[pos] !== '\n') pos += 1
      continue
    }
    if (ch === '/' && sql[pos + 1] === '*') {
      pos += 2
      while (pos + 1 < len && !(sql[pos] === '*' && sql[pos + 1] === '/')) pos += 1
      pos = Math.min(len, pos + 2)
      continue
    }
    const start = pos
    while (pos < len && /[A-Za-z0-9_]/u.test(sql[pos]!)) pos += 1
    if (pos === start) break
    tokens.push(sql.slice(start, pos).toUpperCase())
  }
  return tokens[0] === 'CREATE' && tokens[1] === 'VIRTUAL' && tokens[2] === 'TABLE'
}

function estimateCommaSeparatedColumnsInDdl(sql: string): number {
  const openIdx = sql.indexOf('(')
  const closeIdx = sql.lastIndexOf(')')
  if (openIdx < 0 || closeIdx <= openIdx) return 1
  let commas = 0
  for (let i = openIdx + 1; i < closeIdx; i += 1) {
    if (sql[i] === ',') commas += 1
  }
  return Math.min(2048, commas + 1)
}

export interface AgyPreScannedTableInfo {
  readonly name: string
  readonly rootPage: number
  readonly sql: string
  readonly isVirtual: boolean
}

export interface AgyCatalogScanSummary {
  readonly tables: ReadonlyMap<string, AgyPreScannedTableInfo>
  readonly hasStat1: boolean
  readonly hasStat4: boolean
}

function preScanSqliteStatBtree(input: {
  readonly tableName: 'sqlite_stat1' | 'sqlite_stat4'
  readonly rootPage: number
  readonly readPage: (pageNo: number) => Buffer
  readonly usableSize: number
  readonly maxIndexColumns: number
  readonly maxPages: number
  readonly maxRows: number
  readonly remainingBytes: number
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): number {
  const {
    tableName,
    rootPage,
    readPage,
    usableSize,
    maxIndexColumns,
    maxPages,
    maxRows,
    remainingBytes,
    signal,
    deadlineAt,
  } = input
  if (!Number.isSafeInteger(rootPage) || rootPage < 2) {
    throw new AgyIdentityBudgetExceededError(
      `Antigravity ${tableName} root page is invalid or virtual and cannot be bounded safely.`,
    )
  }

  if (maxPages < 1) {
    throw new AgyIdentityBudgetExceededError(
      `Antigravity ${tableName} B-tree exceeded page pre-scan budget.`,
    )
  }

  const visited = new Set<number>()
  const scheduled = new Set<number>([rootPage])
  const stack: number[] = [rootPage]
  let rowCount = 0
  let chargedBytes = 0
  const xMax = usableSize - 35
  const mMin = Math.floor(((usableSize - 12) * 32) / 255) - 23

  const enqueueChild = (childPageNo: number): void => {
    if (scheduled.has(childPageNo)) {
      throw new Error(`SQLite ${tableName} B-tree cycle or duplicate child page detected.`)
    }
    if (visited.size + stack.length >= maxPages) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity ${tableName} B-tree exceeded page pre-scan budget.`,
      )
    }
    scheduled.add(childPageNo)
    stack.push(childPageNo)
  }

  while (stack.length > 0) {
    assertIdentityNotCancelledOrExpired(signal, deadlineAt)
    const pageNo = stack.pop()!
    if (visited.has(pageNo)) {
      throw new Error(`SQLite ${tableName} B-tree cycle detected.`)
    }
    if (visited.size >= maxPages) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity ${tableName} B-tree exceeded page pre-scan budget.`,
      )
    }
    visited.add(pageNo)
    let page: Buffer
    try {
      page = readPage(pageNo)
    } catch (error) {
      if (error instanceof AgyIdentityFallbackError) {
        throw new AgyIdentityBudgetExceededError(
          `Antigravity ${tableName} B-tree exceeded page pre-scan budget.`,
        )
      }
      throw error
    }
    const bhdr = pageNo === 1 ? 100 : 0
    const pageType = page[bhdr]!
    const cellCount = page.readUInt16BE(bhdr + 3)

    if (pageType === 0x05) {
      const rightChild = page.readUInt32BE(bhdr + 8)
      const ptrBase = bhdr + 12
      if (ptrBase + cellCount * 2 > usableSize) {
        throw new Error(`SQLite ${tableName} interior cell pointer array out of bounds.`)
      }
      enqueueChild(rightChild)
      for (let c = cellCount - 1; c >= 0; c -= 1) {
        if ((c & 0x3f) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        const cellOff = page.readUInt16BE(ptrBase + c * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
          throw new Error(`SQLite ${tableName} interior cell offset out of bounds.`)
        }
        enqueueChild(page.readUInt32BE(cellOff))
      }
    } else if (pageType === 0x0d) {
      const ptrBase = bhdr + 8
      if (ptrBase + cellCount * 2 > usableSize) {
        throw new Error(`SQLite ${tableName} leaf cell pointer array out of bounds.`)
      }
      for (let c = 0; c < cellCount; c += 1) {
        if ((rowCount & 0x3f) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        rowCount += 1
        if (rowCount > maxRows) {
          throw new AgyIdentityBudgetExceededError(
            `Antigravity ${tableName} sample row count exceeded pre-scan budget.`,
          )
        }
        const cellOff = page.readUInt16BE(ptrBase + c * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
          throw new Error(`SQLite ${tableName} leaf cell offset out of bounds.`)
        }
        const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
        const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
        const payloadLen = Number(lenDec.value)
        if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
          throw new AgyIdentityBudgetExceededError(
            `Antigravity ${tableName} row payload length is unbounded.`,
          )
        }

        // Compute exact overflow page count and check remaining byte budget BEFORE assembling payload.
        let overflowPages = 0
        if (payloadLen > xMax) {
          const kMod = mMin + ((payloadLen - mMin) % (usableSize - 4))
          const localLen = kMod <= xMax ? kMod : mMin
          if (rowIdDec.nextOffset + localLen + 4 > usableSize) {
            throw new Error(`SQLite ${tableName} overflow cell out of bounds.`)
          }
          const overflowBytes = payloadLen - localLen
          overflowPages = Math.ceil(overflowBytes / (usableSize - 4))
          if (overflowPages > MAX_TRAJECTORY_OVERFLOW_HOPS) {
            throw new AgyIdentityBudgetExceededError(
              `Antigravity ${tableName} overflow chain exceeded bounded pre-scan hops.`,
            )
          }
        }

        // Charge real payload bytes + overflow page footprint + SQLite Stat4Sample column-count
        // allocation amplification (anEq/anLt/anDLt arrays = 3 * 8B per index column + decode).
        let rowAmplification = 64
        if (tableName === 'sqlite_stat4') {
          let estimatedCols = Math.max(8, maxIndexColumns)
          try {
            const prefix = assembleSqliteLeafPayload(
              readPage,
              usableSize,
              page,
              rowIdDec.nextOffset,
              payloadLen,
              Math.min(payloadLen, 256),
            )
            const serialTypes = decodeSqliteRecordHeader(prefix, payloadLen, 5)
            // Column 2 is `neq` (space-separated integers, >= 1 char + space per index column).
            const neqBytes =
              serialTypes.length > 2 ? Number(sqliteSerialTypeByteLengthBig(serialTypes[2]!)) : 0
            if (Number.isSafeInteger(neqBytes) && neqBytes > 0) {
              estimatedCols = Math.max(estimatedCols, Math.ceil(neqBytes / 2))
            }
          } catch (error) {
            if (error instanceof AgyIdentityFallbackError) {
              throw new AgyIdentityBudgetExceededError(
                `Antigravity ${tableName} sample header could not be bounded safely.`,
              )
            }
            throw error
          }
          rowAmplification = 128 + estimatedCols * 48
        }

        const rowCost = payloadLen + overflowPages * usableSize + rowAmplification
        chargedBytes += rowCost
        if (chargedBytes > remainingBytes) {
          throw new AgyIdentityBudgetExceededError(
            `Antigravity ${tableName} optimizer statistics exceeded pre-scan memory budget.`,
          )
        }
      }
    } else {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity ${tableName} uses unsupported B-tree page type (${pageType}).`,
      )
    }
  }
  return chargedBytes
}

export function preScanSqliteSchemaCatalog(
  readPage: (pageNo: number) => Buffer,
  usableSize: number,
  budget?: AgySchemaCatalogBudget,
  signal?: AbortSignal,
  deadlineAt?: number,
  textEncoding = 1,
): AgyCatalogScanSummary {
  const maxItemSqlBytes = budget?.maxItemSqlBytes ?? MAX_FALLBACK_TABLE_DDL_BYTES
  const maxTotalBytes = budget?.maxTotalBytes ?? MAX_SCHEMA_CATALOG_TOTAL_BYTES
  const maxEntries = budget?.maxEntries ?? MAX_SCHEMA_CATALOG_ENTRIES
  const maxPages = budget?.maxPages ?? MAX_TRAJECTORY_METADATA_PAGES
  const maxStatRows = budget?.maxStatRows ?? MAX_STAT_ROWS
  const maxStatBytes = budget?.maxStatBytes ?? maxTotalBytes

  if (maxPages < 1) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity sqlite_schema catalog exceeded page pre-scan budget.',
    )
  }

  const visited = new Set<number>()
  const scheduled = new Set<number>([1])
  const stack: number[] = [1]
  let entryCount = 0
  let totalCatalogBytes = 0
  let maxIndexColumns = 8
  const tables = new Map<string, AgyPreScannedTableInfo>()
  let stat1RootPage: number | undefined
  let stat4RootPage: number | undefined

  const enqueueChild = (childPageNo: number): void => {
    if (scheduled.has(childPageNo)) {
      throw new Error('SQLite sqlite_schema B-tree cycle or duplicate child page detected.')
    }
    if (visited.size + stack.length >= maxPages) {
      throw new AgyIdentityBudgetExceededError(
        'Antigravity sqlite_schema catalog exceeded page pre-scan budget.',
      )
    }
    scheduled.add(childPageNo)
    stack.push(childPageNo)
  }

  while (stack.length > 0) {
    assertIdentityNotCancelledOrExpired(signal, deadlineAt)
    const pageNo = stack.pop()!
    if (visited.has(pageNo)) {
      throw new Error('SQLite sqlite_schema B-tree cycle detected.')
    }
    if (visited.size >= maxPages) {
      throw new AgyIdentityBudgetExceededError(
        'Antigravity sqlite_schema catalog exceeded page pre-scan budget.',
      )
    }
    visited.add(pageNo)
    let page: Buffer
    try {
      page = readPage(pageNo)
    } catch (error) {
      if (error instanceof AgyIdentityFallbackError) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity sqlite_schema catalog exceeded page pre-scan budget.',
        )
      }
      throw error
    }
    const bhdr = pageNo === 1 ? 100 : 0
    const pageType = page[bhdr]!
    const cellCount = page.readUInt16BE(bhdr + 3)
    if (pageType === 0x05) {
      const rightChild = page.readUInt32BE(bhdr + 8)
      const ptrBase = bhdr + 12
      if (ptrBase + cellCount * 2 > usableSize) {
        throw new Error('SQLite sqlite_schema interior cell pointer array out of bounds.')
      }
      enqueueChild(rightChild)
      for (let c = cellCount - 1; c >= 0; c -= 1) {
        if ((c & 0x3f) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        const cellOff = page.readUInt16BE(ptrBase + c * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
          throw new Error('SQLite sqlite_schema interior cell offset out of bounds.')
        }
        enqueueChild(page.readUInt32BE(cellOff))
      }
    } else if (pageType === 0x0d) {
      const ptrBase = bhdr + 8
      if (ptrBase + cellCount * 2 > usableSize) {
        throw new Error('SQLite sqlite_schema leaf cell pointer array out of bounds.')
      }
      for (let c = 0; c < cellCount; c += 1) {
        if ((entryCount & 0x3f) === 0) {
          assertIdentityNotCancelledOrExpired(signal, deadlineAt)
        }
        entryCount += 1
        if (entryCount > maxEntries) {
          throw new AgyIdentityBudgetExceededError(
            'Antigravity sqlite_schema entry count exceeded pre-scan budget.',
          )
        }
        const cellOff = page.readUInt16BE(ptrBase + c * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
          throw new Error('SQLite sqlite_schema leaf cell offset out of bounds.')
        }
        const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
        const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
        const payloadLen = Number(lenDec.value)
        if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
          throw new Error('Invalid SQLite sqlite_schema payload length.')
        }
        if (payloadLen > maxItemSqlBytes + 4096) {
          throw new AgyIdentityBudgetExceededError(
            'Antigravity sqlite_schema DDL entry exceeded bounded schema pre-scan limit.',
          )
        }
        let headerPrefix: Buffer
        let serialTypes: bigint[]
        try {
          headerPrefix = assembleSqliteLeafPayload(
            readPage,
            usableSize,
            page,
            rowIdDec.nextOffset,
            payloadLen,
            256,
          )
          serialTypes = decodeSqliteRecordHeader(headerPrefix, payloadLen)
        } catch (error) {
          if (error instanceof AgyIdentityFallbackError) {
            throw new AgyIdentityBudgetExceededError(
              'Antigravity sqlite_schema record header could not be pre-verified within budget.',
            )
          }
          throw error
        }
        let sqlBytes = 0n
        let entryContentBytes = 0n
        for (let colIdx = 0; colIdx < serialTypes.length; colIdx += 1) {
          const colBytes = sqliteSerialTypeByteLengthBig(serialTypes[colIdx]!)
          entryContentBytes += colBytes
          if (colIdx === 4) {
            sqlBytes = colBytes
          }
        }
        if (
          sqlBytes > BigInt(maxItemSqlBytes) ||
          entryContentBytes > BigInt(maxItemSqlBytes + 4096)
        ) {
          throw new AgyIdentityBudgetExceededError(
            'Antigravity sqlite_schema DDL entry exceeded bounded schema pre-scan limit.',
          )
        }
        const accountedBytes = Number(entryContentBytes > sqlBytes ? entryContentBytes : sqlBytes)
        totalCatalogBytes += accountedBytes
        if (totalCatalogBytes > maxTotalBytes) {
          throw new AgyIdentityBudgetExceededError(
            'Antigravity sqlite_schema total catalog size exceeded pre-scan budget.',
          )
        }

        // Decode the bounded catalog record to identify ordinary vs virtual tables and sqlite_stat1/4.
        let fullPayload: Buffer
        try {
          fullPayload = assembleSqliteLeafPayload(
            readPage,
            usableSize,
            page,
            rowIdDec.nextOffset,
            payloadLen,
          )
        } catch (error) {
          if (error instanceof AgyIdentityFallbackError) {
            throw new AgyIdentityBudgetExceededError(
              'Antigravity sqlite_schema entry could not be decoded within budget.',
            )
          }
          throw error
        }
        const decoded = decodeSqliteRecord(fullPayload, 5, textEncoding)
        const objType = decoded.values[0]
        const objName = decoded.values[1]
        const rootPageRaw = decoded.values[3]
        const ddl = decoded.values[4]
        if (typeof ddl === 'string' && (objType === 'index' || objType === 'table')) {
          const cols = estimateCommaSeparatedColumnsInDdl(ddl)
          if (cols > maxIndexColumns) maxIndexColumns = cols
        }
        if (objType === 'table' && typeof objName === 'string') {
          const rootPage =
            typeof rootPageRaw === 'bigint' &&
            rootPageRaw >= 0n &&
            rootPageRaw <= BigInt(Number.MAX_SAFE_INTEGER)
              ? Number(rootPageRaw)
              : 0
          const ddlText = typeof ddl === 'string' ? ddl : ''
          const isVirtual = rootPage === 0 || isCreateVirtualTableSql(ddlText)
          tables.set(objName, { name: objName, rootPage, sql: ddlText, isVirtual })
          const lowerName = objName.toLowerCase()
          if (lowerName === 'sqlite_stat1') {
            stat1RootPage = isVirtual ? 0 : rootPage
          } else if (lowerName === 'sqlite_stat4') {
            stat4RootPage = isVirtual ? 0 : rootPage
          }
        }
      }
    } else {
      throw new Error('SQLite sqlite_schema root page is not a valid table B-tree.')
    }
  }

  let statBytesRemaining = Math.min(maxStatBytes, Math.max(0, maxTotalBytes - totalCatalogBytes))
  if (stat1RootPage !== undefined) {
    const used = preScanSqliteStatBtree({
      tableName: 'sqlite_stat1',
      rootPage: stat1RootPage,
      readPage,
      usableSize,
      maxIndexColumns,
      maxPages,
      maxRows: maxStatRows,
      remainingBytes: statBytesRemaining,
      ...(signal !== undefined ? { signal } : {}),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    })
    statBytesRemaining = Math.max(0, statBytesRemaining - used)
  }
  if (stat4RootPage !== undefined) {
    preScanSqliteStatBtree({
      tableName: 'sqlite_stat4',
      rootPage: stat4RootPage,
      readPage,
      usableSize,
      maxIndexColumns,
      maxPages,
      maxRows: maxStatRows,
      remainingBytes: statBytesRemaining,
      ...(signal !== undefined ? { signal } : {}),
      ...(deadlineAt !== undefined ? { deadlineAt } : {}),
    })
  }

  return {
    tables,
    hasStat1: stat1RootPage !== undefined,
    hasStat4: stat4RootPage !== undefined,
  }
}

const PRE_SCAN_PROOF_BRAND = Symbol('AgyPreScannedSqliteProof')

export interface AgyPreScannedSqliteProof {
  readonly [PRE_SCAN_PROOF_BRAND]: true
  readonly stagedDbPath: string
  readonly pageSize: number
  readonly usableSize: number
  readonly committedDbPageCount: number
  readonly tables: ReadonlyMap<string, AgyPreScannedTableInfo>
  readonly hasStat1: boolean
  readonly hasStat4: boolean
}

/**
 * Pre-scans a self-contained materialized staged SQLite file (`DELETE` mode, exact page count)
 * and returns a typed proof token required to construct a read-only `better-sqlite3` connection.
 * NEVER silently returns on invalid page-1 headers or format-0 non-empty catalogs!
 */
export function preScanStagedSqliteSchemaCatalog(
  stagedDbPath: string,
  budget?: AgySchemaCatalogBudget,
  signal?: AbortSignal,
  deadlineAt?: number,
): AgyPreScannedSqliteProof {
  let dbFd: number | undefined
  try {
    dbFd = openSync(stagedDbPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const dbStat = fstatSync(dbFd, { bigint: true })
    if (dbStat.size < 100n) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image is smaller than header size.')
    }
    const hdrBuf = Buffer.allocUnsafe(100)
    readExactBytesFromFd(dbFd, hdrBuf, 100, 0)
    if (!hdrBuf.subarray(0, 16).equals(SQLITE_HEADER_MAGIC)) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image has invalid header magic.')
    }
    const rawPageSize = hdrBuf.readUInt16BE(16)
    const pageSize = rawPageSize === 1 ? 65_536 : rawPageSize
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image has invalid page size.')
    }
    const reserved = hdrBuf[20]!
    if (pageSize - reserved < 480) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image has invalid usable size.')
    }
    const dbByteLength = Number(dbStat.size)
    if (!Number.isSafeInteger(dbByteLength) || dbByteLength < pageSize) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image is smaller than one page.')
    }
    const physicalDbPageCount = Math.floor(dbByteLength / pageSize)
    const dbChangeCounter = hdrBuf.readUInt32BE(24)
    const dbHeaderPageCount = hdrBuf.readUInt32BE(28)
    const dbVersionValidFor = hdrBuf.readUInt32BE(92)
    if (
      dbHeaderPageCount > 0 &&
      dbChangeCounter === dbVersionValidFor &&
      dbHeaderPageCount > physicalDbPageCount
    ) {
      throw new AgyInvalidSqliteImageError(
        'Staged SQLite page 1 header page count exceeds physical image size.',
      )
    }
    const committedDbPageCount =
      dbHeaderPageCount > 0 && dbChangeCounter === dbVersionValidFor
        ? dbHeaderPageCount
        : physicalDbPageCount

    const openDbFd = dbFd
    const pageCache = new Map<number, Buffer>()
    const maxPages = budget?.maxPages ?? MAX_TRAJECTORY_METADATA_PAGES
    const readStagedPage = (pageNo: number): Buffer => {
      const cached = pageCache.get(pageNo)
      if (cached) return cached
      if (pageCache.size >= maxPages) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity sqlite_schema catalog exceeded page pre-scan budget.',
        )
      }
      if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > committedDbPageCount) {
        throw new AgyInvalidSqliteImageError(
          'Requested staged SQLite page exceeds committed bounds.',
        )
      }
      const offset = (pageNo - 1) * pageSize
      if (!Number.isSafeInteger(offset) || offset + pageSize > dbByteLength) {
        throw new AgyInvalidSqliteImageError('Staged SQLite page offset exceeded image EOF.')
      }
      const buf = Buffer.allocUnsafe(pageSize)
      readExactBytesFromFd(openDbFd, buf, pageSize, offset)
      pageCache.set(pageNo, buf)
      return buf
    }

    const effectivePage1 = readStagedPage(1)
    const page1Check = validateEffectivePageOneHeader(effectivePage1, pageSize)
    if (!page1Check.valid) {
      throw new AgyInvalidSqliteImageError('Staged SQLite image failed page-1 header validation.')
    }
    const effectiveTextEncoding = effectivePage1.readUInt32BE(56)
    const summary = preScanSqliteSchemaCatalog(
      readStagedPage,
      page1Check.usableSize,
      budget,
      signal,
      deadlineAt,
      effectiveTextEncoding,
    )
    return {
      [PRE_SCAN_PROOF_BRAND]: true,
      stagedDbPath,
      pageSize,
      usableSize: page1Check.usableSize,
      committedDbPageCount,
      tables: summary.tables,
      hasStat1: summary.hasStat1,
      hasStat4: summary.hasStat4,
    }
  } finally {
    if (dbFd !== undefined) {
      try {
        closeSync(dbFd)
      } catch {
        /* Best-effort close on staged DB descriptor. */
      }
    }
  }
}

export function openPreScannedReadOnlyDatabase(
  proof: AgyPreScannedSqliteProof,
  tempDirToCleanOnClose?: string,
): Database.Database {
  if (!proof || !proof[PRE_SCAN_PROOF_BRAND]) {
    throw new Error('Cannot open Antigravity SQLite snapshot without a valid pre-scan proof token.')
  }
  let db: Database.Database
  try {
    db = new Database(proof.stagedDbPath, { readonly: true, fileMustExist: true })
  } catch (error) {
    throw wrapOperationalStagingError(error, 'Failed to open staged Antigravity SQLite snapshot')
  }
  if (tempDirToCleanOnClose !== undefined) {
    const origClose = db.close.bind(db)
    let cleaned = false
    db.close = (): Database.Database => {
      try {
        return origClose()
      } finally {
        if (!cleaned) {
          cleaned = true
          try {
            rmSync(tempDirToCleanOnClose, { recursive: true, force: true })
          } catch {
            /* Best-effort cleanup of private temp snapshot directory. */
          }
        }
      }
    }
  }
  return db
}

export interface AgyReadImageSource {
  readonly rootDir: string
  readonly parentSegments: readonly string[]
  readonly leafName: string
}

export interface AgyReadImageLimits {
  readonly maxWalScanBytes?: number
  readonly maxSnapshotBytes?: number
  readonly maxPageCacheEntries?: number
  readonly walShrinkBudget?: AgyWalShrinkBudget
  readonly schemaCatalogBudget?: AgySchemaCatalogBudget
  readonly snapshotParentTempDir?: string
}

export interface AgyReadImageControl {
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly onLeafObserved?: () => void
}

export interface AgyMaterializedSnapshot {
  readonly stagedDbPath: string
  readonly tempDir: string
  readonly proof: AgyPreScannedSqliteProof
  readonly openReadOnlyDatabase: () => Database.Database
  readonly cleanup: () => void
}

export interface AgyCommittedReadImage {
  readonly pageSize: number
  readonly usableSize: number
  readonly committedDbPageCount: number
  readonly physicalDbPageCount: number
  readonly totalPages: number
  readonly hasWal: boolean
  readonly hasShm: boolean
  readonly hasJournal: boolean
  readonly walCommittedPages: ReadonlyMap<number, number>
  readonly readVersion: number
  readonly writeVersion: number
  readonly effectivePage1: Buffer
  readonly fileIdentity: AgySqliteFileIdentity
  readonly walIdentity: AgySqliteFileIdentity | null
  readonly committedImageDigest: string
  readPage(pageNo: number): Buffer
  verifyUnchanged(options?: { readonly includeAccessedPages?: boolean }): void
  preScanCatalog(budget?: AgySchemaCatalogBudget): AgyCatalogScanSummary
  materializePrivateSnapshot(options?: {
    readonly maxSnapshotBytes?: number
    readonly schemaCatalogBudget?: AgySchemaCatalogBudget
    readonly snapshotParentTempDir?: string
  }): AgyMaterializedSnapshot
}

function isAgyNativeLoaderError(error: unknown): boolean {
  if (typeof AgyNativeLoaderError === 'function' && error instanceof AgyNativeLoaderError) {
    return true
  }
  return (
    error instanceof Error &&
    (error.name === 'AgyNativeLoaderError' || Reflect.get(error, 'code') === 'EAGY_NATIVE_LOADER')
  )
}

function mapNativeOpenError(error: unknown): never {
  if (isAgyNativeLoaderError(error)) {
    throw error
  }
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code')
    const stage = Reflect.get(error, 'stage')
    if (code === 'ENOENT') {
      const normalizedStage =
        stage === 'root' || stage === 'parent' || stage === 'leaf' ? stage : 'leaf'
      throw new AgyStorageMissingError(normalizedStage, error.message)
    }
    if (isOperationalFsError(error)) {
      throw new AgyOperationalStorageError(
        error.message,
        typeof code === 'string' ? code : undefined,
      )
    }
    if (code === 'EBUSY' || code === 'EAGAIN') {
      throw new AgyTransientIdentityChurnError(
        'Antigravity SQLite file is locked by an active writer.',
      )
    }
  }
  throw error
}

function mapNativeReadError(error: unknown): never {
  if (isAgyNativeLoaderError(error)) {
    throw error
  }
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code')
    if (code === 'ERR_UNEXPECTED_EOF') {
      throw new AgyUnexpectedEofError(error.message)
    }
    if (code === 'EBUSY' || code === 'EAGAIN') {
      throw new AgyTransientIdentityChurnError(
        'Antigravity SQLite file encountered a transient lock conflict during read.',
      )
    }
    if (isOperationalFsError(error)) {
      throw new AgyOperationalStorageError(
        error.message,
        typeof code === 'string' ? code : undefined,
      )
    }
  }
  throw error
}

/**
 * Single unified committed SQLite page view shared across identity fast-read, cold inspection,
 * Fork preparation, Fork verification, Rebuild verification, and summary checks.
 *
 * Acquires the anchored native SQLite SHARED lock BEFORE reading page 1 and keeps the SAME
 * pinned handles alive until `consume` finishes (including final `verifyUnchanged()` or
 * private snapshot seal). NEVER opens/closes a second aliasing fd to the main DB while locked,
 * and NEVER lets SQLite open a source path or create `-shm` in `conversations/`.
 */
export function withAgyReadImage<T>(
  source: AgyReadImageSource,
  limits: AgyReadImageLimits,
  control: AgyReadImageControl,
  consume: (image: AgyCommittedReadImage) => T,
): T {
  const signal = control.signal
  const deadlineAt = control.deadlineAt
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)

  let view: AgyLockedSqliteView
  try {
    view = openAnchoredLockedSqliteView(source.rootDir, source.parentSegments, source.leafName, {
      acquireSharedLock: true,
      openWal: true,
      openShm: true,
      checkJournal: true,
    })
  } catch (error) {
    if (isAgyNativeLoaderError(error)) {
      throw error
    }
    if (error instanceof Error) {
      const stage = Reflect.get(error, 'stage')
      const code = Reflect.get(error, 'code')
      if (
        stage === 'lock' ||
        stage === 'wal' ||
        stage === 'shm' ||
        (stage === 'leaf' && (code === 'EBUSY' || code === 'EAGAIN'))
      ) {
        control.onLeafObserved?.()
      }
    }
    mapNativeOpenError(error)
  }

  try {
    control.onLeafObserved?.()
    if (view.hasJournal) {
      throw new AgyHotRollbackJournalError(
        `Antigravity SQLite rollback journal (${source.leafName}-journal) is present; trajectory state is unconfirmed.`,
      )
    }

    const dbByteLength = view.byteLength
    const maxWalScanBytes = limits.maxWalScanBytes ?? MAX_IDENTITY_WAL_SCAN_BYTES
    const maxPageCacheEntries = limits.maxPageCacheEntries ?? MAX_TRAJECTORY_METADATA_PAGES
    let shmHeader: ValidatedWalIndexHeader | undefined
    let initialWalHeaderDigest: string | undefined
    let walHeaderLen = 0
    let stoppedWalFrameOffset: number | undefined
    let stoppedWalFrameHdrDigest: string | undefined
    let pageSize = 0
    const accessedPages = new Map<
      number,
      { source: 'db' | 'wal'; offset: number; sha256: string; buf: Buffer }
    >()

    const verifyUnchanged = (options?: { readonly includeAccessedPages?: boolean }): void => {
      const check = view.verifyUnchanged()
      if (!check.unchanged) {
        if (check.reason === 'journal_appeared') {
          throw new AgyHotRollbackJournalError(
            'Antigravity SQLite rollback journal appeared during read.',
          )
        }
        if (check.reason === 'root_changed' || check.reason === 'parent_changed') {
          throw new AgyInvalidSqliteImageError(
            'Antigravity storage directory identity escaped its canonical boundary.',
          )
        }
        throw new AgyTransientIdentityChurnError(
          `Antigravity SQLite source changed during read (${check.reason ?? 'unknown'}).`,
        )
      }
      if (shmHeader !== undefined) {
        let shmAfter: Buffer
        try {
          shmAfter = view.readShmAt(0, SQLITE_WAL_INDEX_HEADER_BYTES)
        } catch (error) {
          mapNativeReadError(error)
        }
        if (!shmAfter.equals(shmHeader.bytes)) {
          throw new AgyTransientIdentityChurnError('SQLite wal-index header changed during read.')
        }
      }
      if (view.hasWal && initialWalHeaderDigest !== undefined && walHeaderLen > 0) {
        let hdrNow: Buffer
        try {
          hdrNow = view.readWalAt(0, walHeaderLen)
        } catch (error) {
          mapNativeReadError(error)
        }
        if (createHash('sha256').update(hdrNow).digest('hex') !== initialWalHeaderDigest) {
          throw new AgyTransientIdentityChurnError('WAL header changed during read.')
        }
        if (stoppedWalFrameOffset !== undefined && stoppedWalFrameHdrDigest !== undefined) {
          let stopNow: Buffer
          try {
            stopNow = view.readWalAt(stoppedWalFrameOffset, 24)
          } catch (error) {
            mapNativeReadError(error)
          }
          if (createHash('sha256').update(stopNow).digest('hex') !== stoppedWalFrameHdrDigest) {
            throw new AgyTransientIdentityChurnError('WAL boundary frame changed during read.')
          }
        }
      }
      if (options?.includeAccessedPages && pageSize > 0) {
        for (const [, pageRec] of accessedPages) {
          let verifyBuf: Buffer
          try {
            verifyBuf =
              pageRec.source === 'wal'
                ? view.readWalAt(pageRec.offset, pageSize)
                : view.readAt(pageRec.offset, pageSize)
          } catch (error) {
            mapNativeReadError(error)
          }
          if (createHash('sha256').update(verifyBuf).digest('hex') !== pageRec.sha256) {
            throw new AgyTransientIdentityChurnError('Accessed SQLite page changed during read.')
          }
        }
      }
    }

    const throwInvalidIfStable: (message: string) => never = (message) => {
      verifyUnchanged({ includeAccessedPages: true })
      throw new AgyInvalidSqliteImageError(message)
    }

    if (dbByteLength < 100) {
      throw new AgyTransientIdentityChurnError('SQLite database header incomplete.')
    }
    let hdrBuf: Buffer
    try {
      hdrBuf = view.readAt(0, 100)
    } catch (error) {
      mapNativeReadError(error)
    }
    if (!hdrBuf.subarray(0, 16).equals(SQLITE_HEADER_MAGIC)) {
      throwInvalidIfStable('Antigravity trajectory database does not have a valid SQLite header.')
    }
    const rawPageSize = hdrBuf.readUInt16BE(16)
    pageSize = rawPageSize === 1 ? 65_536 : rawPageSize
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0) {
      throwInvalidIfStable('Antigravity trajectory database has an invalid SQLite page size.')
    }
    const reserved = hdrBuf[20]!
    if (pageSize - reserved < 480) {
      throwInvalidIfStable(
        'Antigravity trajectory database has an invalid SQLite usable page size.',
      )
    }
    if (!Number.isSafeInteger(dbByteLength) || dbByteLength < pageSize) {
      throw new AgyTransientIdentityChurnError('Database smaller than one page.')
    }

    const physicalDbPageCount = Math.floor(dbByteLength / pageSize)
    const dbChangeCounter = hdrBuf.readUInt32BE(24)
    const dbHeaderPageCount = hdrBuf.readUInt32BE(28)
    const dbVersionValidFor = hdrBuf.readUInt32BE(92)
    const initialDbPageCount =
      dbHeaderPageCount > 0 && dbChangeCounter === dbVersionValidFor
        ? dbHeaderPageCount
        : physicalDbPageCount

    if (view.hasShm) {
      if (view.shmByteLength < SQLITE_WAL_INDEX_HEADER_BYTES) {
        throw new AgyTransientIdentityChurnError('SQLite wal-index file is still initializing.')
      }
      let shmBeforeBuf: Buffer
      try {
        shmBeforeBuf = view.readShmAt(0, SQLITE_WAL_INDEX_HEADER_BYTES)
      } catch (error) {
        mapNativeReadError(error)
      }
      shmHeader = parseValidatedWalIndexHeader(shmBeforeBuf, pageSize, endianness() === 'LE')
    }

    let scannedWal: ScannedPublishedWalResult
    try {
      scannedWal = scanPublishedWalBoundaryFromView({
        view,
        shmHeader,
        pageSize,
        initialDbPageCount,
        maxWalScanBytes,
        ...(signal !== undefined ? { signal } : {}),
        ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        ...(limits.walShrinkBudget !== undefined
          ? { walShrinkBudget: limits.walShrinkBudget }
          : {}),
      })
    } catch (error) {
      if (
        error instanceof AgyTransientIdentityChurnError ||
        error instanceof AgyIdentityBudgetExceededError ||
        isIdentityAbortOrTimeoutError(error)
      ) {
        throw error
      }
      mapNativeReadError(error)
    }

    initialWalHeaderDigest = scannedWal.initialWalHeaderDigest
    walHeaderLen = scannedWal.walHeaderLen
    stoppedWalFrameOffset = scannedWal.stoppedWalFrameOffset
    stoppedWalFrameHdrDigest = scannedWal.stoppedWalFrameHdrDigest
    if (scannedWal.invalidWalMagic) {
      throwInvalidIfStable('Antigravity trajectory WAL header magic is invalid.')
    }

    const committedWalPages = scannedWal.committedWalPages
    const committedDbPageCount = scannedWal.committedDbPageCount
    if (
      committedDbPageCount < 1 ||
      (committedWalPages.size === 0 && committedDbPageCount > physicalDbPageCount)
    ) {
      throw new AgyTransientIdentityChurnError('Database header page count exceeds file size.')
    }

    const readPage = (pageNo: number): Buffer => {
      const cached = accessedPages.get(pageNo)
      if (cached) return cached.buf
      if (accessedPages.size >= maxPageCacheEntries) {
        throw new AgyIdentityFallbackError('SQLite trajectory metadata exceeded page read budget.')
      }
      if (!Number.isSafeInteger(pageNo) || pageNo < 1 || pageNo > committedDbPageCount) {
        throw new AgyTransientIdentityChurnError('Requested SQLite page exceeds committed bounds.')
      }
      const walOffset = committedWalPages.get(pageNo)
      let sourceKind: 'db' | 'wal'
      let offset: number
      let buf: Buffer
      if (walOffset !== undefined && view.hasWal) {
        sourceKind = 'wal'
        offset = walOffset
        try {
          buf = view.readWalAt(offset, pageSize)
        } catch (error) {
          mapNativeReadError(error)
        }
      } else {
        sourceKind = 'db'
        offset = (pageNo - 1) * pageSize
        if (!Number.isSafeInteger(offset) || offset + pageSize > dbByteLength) {
          throw new AgyTransientIdentityChurnError('SQLite page offset exceeded database EOF.')
        }
        try {
          buf = view.readAt(offset, pageSize)
        } catch (error) {
          mapNativeReadError(error)
        }
      }
      const sha256 = createHash('sha256').update(buf).digest('hex')
      accessedPages.set(pageNo, { source: sourceKind, offset, sha256, buf })
      return buf
    }

    const effectivePage1 = readPage(1)
    const page1Check = validateEffectivePageOneHeader(effectivePage1, pageSize)
    if (!page1Check.valid) {
      throwInvalidIfStable('Antigravity trajectory database failed effective page-1 validation.')
    }
    const usableSize = page1Check.usableSize

    // Effective page 1 non-zero header pageCount (when changeCounter === versionValidFor) MUST NOT
    // exceed the WAL view's committed page count (`nPage > nPageFile` in SQLite `lockBtree`).
    // Stable sample -> `invalid`; mutating sample -> `transient_churn`.
    const effChangeCounter = effectivePage1.readUInt32BE(24)
    const effHeaderPageCount = effectivePage1.readUInt32BE(28)
    const effVersionValidFor = effectivePage1.readUInt32BE(92)
    if (
      effHeaderPageCount > 0 &&
      effChangeCounter === effVersionValidFor &&
      effHeaderPageCount > committedDbPageCount
    ) {
      throwInvalidIfStable(
        'Effective SQLite page 1 header page count exceeds committed WAL page count.',
      )
    }

    const effectiveTextEncoding = effectivePage1.readUInt32BE(56)
    let cachedCatalogScan: AgyCatalogScanSummary | undefined
    const preScanCatalog = (budget?: AgySchemaCatalogBudget): AgyCatalogScanSummary => {
      if (cachedCatalogScan && budget === undefined) return cachedCatalogScan
      const effectiveBudget = budget ?? limits.schemaCatalogBudget
      const summary = preScanSqliteSchemaCatalog(
        readPage,
        usableSize,
        effectiveBudget,
        signal,
        deadlineAt,
        effectiveTextEncoding,
      )
      if (budget === undefined) cachedCatalogScan = summary
      return summary
    }

    const materializePrivateSnapshot = (options?: {
      readonly maxSnapshotBytes?: number
      readonly schemaCatalogBudget?: AgySchemaCatalogBudget
      readonly snapshotParentTempDir?: string
    }): AgyMaterializedSnapshot => {
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
      const maxSnapshotBytes =
        options?.maxSnapshotBytes ?? limits.maxSnapshotBytes ?? MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES
      const totalImageBytes = BigInt(committedDbPageCount) * BigInt(pageSize)
      if (totalImageBytes > BigInt(maxSnapshotBytes)) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity trajectory database exceeds its read byte budget.',
          false,
        )
      }

      // Pre-scan sqlite_schema + sqlite_stat1/4 BEFORE creating any temp dir or staging file so
      // unbounded schemas / optimizer statistics fail closed before any staging I/O!
      const effectiveBudget = options?.schemaCatalogBudget ?? limits.schemaCatalogBudget
      preScanCatalog(effectiveBudget)

      const parentDir = options?.snapshotParentTempDir ?? limits.snapshotParentTempDir ?? tmpdir()
      let tempDir: string
      try {
        tempDir = mkdtempSync(join(parentDir, 'pact-agy-ro-'))
        chmodSync(tempDir, 0o700)
      } catch (error) {
        throw wrapOperationalStagingError(error, 'Failed to prepare Antigravity staging directory')
      }

      const stagedDbPath = join(tempDir, 'snapshot.db')
      try {
        let dstFd: number
        try {
          dstFd = openSync(
            stagedDbPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
            0o600,
          )
        } catch (error) {
          throw wrapOperationalStagingError(
            error,
            'Failed to create staged Antigravity snapshot file',
          )
        }

        const copyHasher = createHash('sha256')
        try {
          for (let pageNo = 1; pageNo <= committedDbPageCount; pageNo += 1) {
            if ((pageNo & 0x3f) === 0) {
              assertIdentityNotCancelledOrExpired(signal, deadlineAt)
            }
            const walOffset = committedWalPages.get(pageNo)
            let pageBuf: Buffer
            if (walOffset !== undefined && view.hasWal) {
              try {
                pageBuf = view.readWalAt(walOffset, pageSize)
              } catch (error) {
                mapNativeReadError(error)
              }
            } else {
              const offset = (pageNo - 1) * pageSize
              if (!Number.isSafeInteger(offset) || offset + pageSize > dbByteLength) {
                throw new AgyTransientIdentityChurnError(
                  'SQLite page offset exceeded database EOF while materializing snapshot.',
                )
              }
              try {
                pageBuf = view.readAt(offset, pageSize)
              } catch (error) {
                mapNativeReadError(error)
              }
            }
            copyHasher.update(pageBuf)
            if (pageNo === 1) {
              const patched = Buffer.from(pageBuf)
              // Materialize a pure self-contained committed DELETE-mode image: zero -wal/-shm!
              patched[18] = 1
              patched[19] = 1
              // Ensure page 1 header pageCount reflects committedDbPageCount if truncated/grown via WAL.
              const chg = patched.readUInt32BE(24)
              const ver = patched.readUInt32BE(92)
              if (chg === ver && patched.readUInt32BE(28) !== committedDbPageCount) {
                patched.writeUInt32BE(committedDbPageCount, 28)
              }
              try {
                writeAllSync(dstFd, patched, 0, pageSize)
              } catch (error) {
                throw wrapOperationalStagingError(
                  error,
                  'Failed to write staged Antigravity snapshot file',
                )
              }
            } else {
              try {
                writeAllSync(dstFd, pageBuf, 0, pageSize)
              } catch (error) {
                throw wrapOperationalStagingError(
                  error,
                  'Failed to write staged Antigravity snapshot file',
                )
              }
            }
          }
          const dstStat = fstatSync(dstFd, { bigint: true })
          if (dstStat.size !== totalImageBytes) {
            throw new AgyTransientIdentityChurnError(
              'Staged Antigravity SQLite snapshot byte length did not match committed page count.',
            )
          }
        } finally {
          closeSync(dstFd)
        }

        // Re-verify source identity, SHM boundary, and (for WAL/SHM sources where writers may
        // concurrently append/checkpoint) exact second-pass digest over the SAME pinned view!
        verifyUnchanged({ includeAccessedPages: true })
        if (view.hasWal || view.hasShm) {
          const recheckHasher = createHash('sha256')
          for (let pageNo = 1; pageNo <= committedDbPageCount; pageNo += 1) {
            if ((pageNo & 0x3f) === 0) {
              assertIdentityNotCancelledOrExpired(signal, deadlineAt)
            }
            const walOffset = committedWalPages.get(pageNo)
            let pageBuf: Buffer
            if (walOffset !== undefined && view.hasWal) {
              try {
                pageBuf = view.readWalAt(walOffset, pageSize)
              } catch (error) {
                mapNativeReadError(error)
              }
            } else {
              const offset = (pageNo - 1) * pageSize
              try {
                pageBuf = view.readAt(offset, pageSize)
              } catch (error) {
                mapNativeReadError(error)
              }
            }
            recheckHasher.update(pageBuf)
          }
          if (recheckHasher.digest('hex') !== copyHasher.digest('hex')) {
            throw new AgyTransientIdentityChurnError(
              'Antigravity SQLite committed bytes changed while materializing snapshot.',
            )
          }
          verifyUnchanged({ includeAccessedPages: true })
        }

        // Produce the typed pre-scan proof bound to the exact materialized snapshot on disk.
        const proof = preScanStagedSqliteSchemaCatalog(
          stagedDbPath,
          effectiveBudget,
          signal,
          deadlineAt,
        )

        let cleaned = false
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          try {
            rmSync(tempDir, { recursive: true, force: true })
          } catch {
            /* Best-effort cleanup of private temp snapshot directory. */
          }
        }

        return {
          stagedDbPath,
          tempDir,
          proof,
          openReadOnlyDatabase: () => openPreScannedReadOnlyDatabase(proof, tempDir),
          cleanup,
        }
      } catch (error) {
        try {
          rmSync(tempDir, { recursive: true, force: true })
        } catch {
          /* Best-effort cleanup on failed materialization. */
        }
        throw error
      }
    }

    const committedImageHasher = createHash('sha256')
    committedImageHasher.update('agy-committed-image-v1\0')
    committedImageHasher.update(
      JSON.stringify({
        pageSize,
        committedDbPageCount,
        fileIdentity: view.fileIdentity,
        walIdentity: view.walIdentity,
        hasWal: view.hasWal,
        hasShm: view.hasShm,
        initialWalHeaderDigest: initialWalHeaderDigest ?? null,
        walCommittedPages: [...committedWalPages.entries()].toSorted(([a], [b]) => a - b),
      }),
    )
    committedImageHasher.update('\0')
    if (shmHeader !== undefined) {
      committedImageHasher.update(shmHeader.bytes)
    }
    const committedImageDigest = committedImageHasher.digest('hex')

    const image: AgyCommittedReadImage = {
      pageSize,
      usableSize,
      committedDbPageCount,
      physicalDbPageCount,
      totalPages: committedDbPageCount,
      hasWal: view.hasWal,
      hasShm: view.hasShm,
      hasJournal: view.hasJournal,
      walCommittedPages: committedWalPages,
      readVersion: effectivePage1[19]!,
      writeVersion: effectivePage1[18]!,
      effectivePage1,
      fileIdentity: view.fileIdentity,
      walIdentity: view.walIdentity,
      committedImageDigest,
      readPage,
      verifyUnchanged,
      preScanCatalog,
      materializePrivateSnapshot,
    }

    return consume(image)
  } finally {
    view.close()
  }
}
