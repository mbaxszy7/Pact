import type Database from 'better-sqlite3'

import { isAbsolute, resolve } from 'node:path'

import { AGY_STORAGE_MAX_RECORDS } from '@pact/contracts'

import { AgentExecutionError } from '../agent-execution-error'
import { AgyNativeLoaderError } from '../agy-sqlite-file'
import {
  AgyHotRollbackJournalError,
  AgyIdentityBudgetExceededError,
  AgyIdentityFallbackError,
  AgyInvalidSqliteImageError,
  AgyOperationalStorageError,
  AgyStorageMissingError,
  AgyTransientIdentityChurnError,
  AgyUnexpectedEofError,
  MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
  MAX_FALLBACK_TABLE_DDL_BYTES,
  assembleSqliteLeafPayload,
  assertIdentityNotCancelledOrExpired,
  decodeSqliteRecord,
  decodeSqliteRecordHeader,
  decodeSqliteVarint,
  isIdentityAbortOrTimeoutError,
  isOperationalFsError,
  isOperationalSqliteError,
  isSqliteBusyOrLockedError,
  isTransientFileLockError,
  withAgyReadImage,
  type AgyCommittedReadImage,
  type AgyPreScannedSqliteProof,
  type AgySchemaCatalogBudget,
  type AgyWalShrinkBudget,
} from '../agy-sqlite-image'
import {
  AGY_TEXT_BUDGET_BYTES,
  KNOWN_TRAJECTORY_TABLES,
  REQUIRED_TRAJECTORY_TABLES,
  SAFE_ID_PATTERN,
  isValidAgyTrajectoryId,
  quoteSqlIdentifier,
  resolveSnapshotParentTempDir,
} from './constants-and-types'
import { decodeCortexTrajectoryMetadata } from './cortex-codec'

interface SqliteMasterRow {
  name: string
  type: string
  sql: string | null
}

export interface ValidatedTrajectorySchema {
  tables: Map<string, SqliteMasterRow>
  indexes: SqliteMasterRow[]
  stepColumns: string[]
  stepPayloadColumn: 'step_payload' | 'data'
  hasStepFormatColumn: boolean
  genColumns: string[]
  execColumns: string[]
  metaColumns: string[]
  trajectoryId: string
  cascadeId: string
  stepFormat: number
  metaRow: Record<string, unknown>
  trajectoryMetadataRows: Array<Record<string, unknown>>
}

export function requireBufferField(row: Record<string, unknown>, field: string): Buffer {
  const value = row[field]
  if (!Buffer.isBuffer(value)) {
    throw new Error(`Expected SQLite BLOB Buffer in column "${field}".`)
  }
  return value
}

export function optionalBufferField(row: Record<string, unknown>, field: string): Buffer | null {
  const value = row[field]
  if (value === null || value === undefined) return null
  if (!Buffer.isBuffer(value)) {
    throw new Error(`Expected nullable SQLite BLOB Buffer in column "${field}".`)
  }
  return value
}

interface TableXColumnInfo {
  name: string
  type: string
  notnull: number
  pk: number
  hidden: number
}

export function readTableColumns(db: Database.Database, tableName: string): string[] {
  const rows = db
    .prepare<[], TableXColumnInfo>(`PRAGMA table_xinfo(${quoteSqlIdentifier(tableName)})`)
    .all()
  const names: string[] = []
  for (const row of rows) {
    if (row.hidden !== 0) {
      throw new Error(
        `Unsupported generated or hidden column (${row.name}) in Antigravity table ${tableName}.`,
      )
    }
    quoteSqlIdentifier(row.name)
    names.push(row.name)
  }
  return names
}

export function assertProofHasOrdinaryTables(
  proof: AgyPreScannedSqliteProof,
  requiredTables: readonly string[],
): void {
  for (const entry of proof.tables.values()) {
    if (entry.name.startsWith('sqlite_')) continue
    if (entry.isVirtual || entry.rootPage < 2) {
      throw new Error(`Unsupported virtual SQLite table (${entry.name}) in Antigravity trajectory.`)
    }
  }
  for (const tableName of requiredTables) {
    const entry = proof.tables.get(tableName)
    if (!entry || entry.isVirtual || entry.rootPage < 2) {
      throw new Error(`Missing required Antigravity table: ${tableName}.`)
    }
  }
}

export function measureTableColumnsTotalBytes(
  db: Database.Database,
  tableName: string,
  columns: readonly string[],
  whereClause?: { readonly sql: string; readonly params: readonly unknown[] },
): number {
  if (columns.length === 0) return 0
  const expr = columns
    .map((col) => `COALESCE(octet_length(${quoteSqlIdentifier(col)}), 0)`)
    .join(' + ')
  const sql = whereClause
    ? `SELECT COALESCE(SUM(${expr}), 0) AS totalBytes FROM ${quoteSqlIdentifier(tableName)} WHERE ${whereClause.sql}`
    : `SELECT COALESCE(SUM(${expr}), 0) AS totalBytes FROM ${quoteSqlIdentifier(tableName)}`
  const stmt = db.prepare<unknown[], { totalBytes: number | bigint | null }>(sql)
  const row = whereClause ? stmt.get(...whereClause.params) : stmt.get()
  const raw = row?.totalBytes ?? 0
  const bytes = typeof raw === 'bigint' ? Number(raw) : raw
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return bytes
}

interface BoundedTableXInfoRow {
  name: string
  hidden: number
}

const MAX_FALLBACK_VDBE_OPS = 160

const ALLOWED_FALLBACK_SCALAR_FUNCTIONS = new Set(['typeof(1)', 'octet_length(1)'])

const ALLOWED_FALLBACK_AGG_FUNCTIONS = new Set(['count(0)', 'sum(1)', 'max(1)'])

const DISALLOWED_FALLBACK_VDBE_OPCODES = new Set([
  'Concat',
  'Cast',
  'Blob',
  'SorterOpen',
  'OpenEphemeral',
  'OpenAutoindex',
  'MakeRecord',
  'RealAffinity',
  'VOpen',
  'VFilter',
  'VColumn',
  'VNext',
  'VBegin',
  'VCreate',
  'VDestroy',
  'VUpdate',
  'VRename',
])

const CONDITIONAL_GUARD_JUMP_OPCODES = new Set(['Lt', 'Gt', 'Le', 'Ge', 'Ne'])

const SQLITE_OPFLAG_LENGTHARG = 0x40

const SQLITE_OPFLAG_TYPEOFARG = 0x80

const SQLITE_OPFLAG_BYTELENARG = SQLITE_OPFLAG_LENGTHARG | SQLITE_OPFLAG_TYPEOFARG

export interface SqliteExplainRow {
  readonly addr: number
  readonly opcode: string
  readonly p1: number
  readonly p2: number
  readonly p3: number
  readonly p4: unknown
  readonly p5: number
}

function quoteArbitrarySqlIdentifier(identifier: string): string {
  if (identifier.length === 0 || identifier.length > 256 || hasNonPrintableAscii(identifier)) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity SQLite identifier exceeds safe bounded inspection rules.',
    )
  }
  return `"${identifier.replaceAll('"', '""')}"`
}

function readBoundedIdentityTableColumns(
  db: Database.Database,
  tableName: 'trajectory_meta' | 'steps',
  requiredColumns: readonly string[],
): Map<string, number> {
  const placeholders = requiredColumns.map(() => '?').join(', ')
  const rows = db
    .prepare<string[], BoundedTableXInfoRow>(
      `SELECT name, hidden FROM pragma_table_xinfo(?) WHERE hidden IN (0, 2, 3) AND name IN (${placeholders})`,
    )
    .all(tableName, ...requiredColumns)
  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row.name, row.hidden)
  }
  return result
}

function findStoredTableColumnName(
  db: Database.Database,
  tableName: 'trajectory_meta' | 'steps',
  candidateName: string,
): string | undefined {
  const row = db
    .prepare<[string, string], BoundedTableXInfoRow>(
      `SELECT name, hidden FROM pragma_table_xinfo(?) WHERE hidden IN (0, 3) AND lower(name) = lower(?) LIMIT 1`,
    )
    .get(tableName, candidateName)
  return row?.name
}

export function verifyBoundedFallbackVdbeOps(
  ops: readonly SqliteExplainRow[],
  options?: { readonly allowGuardedVirtualEval?: boolean },
): void {
  if (ops.length === 0 || ops.length > MAX_FALLBACK_VDBE_OPS) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity fallback SQLite query plan exceeded bounded instruction limit.',
    )
  }
  const verifiedGuardRanges: Array<{
    readonly cursor: number
    readonly colIdx: number
    readonly fromAddr: number
    readonly untilAddr: number
  }> = []

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i]!
    if (DISALLOWED_FALLBACK_VDBE_OPCODES.has(op.opcode)) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity fallback SQLite query plan uses unbounded opcode (${op.opcode}).`,
      )
    }
    if (op.opcode === 'Function' || op.opcode === 'PureFunc') {
      if (typeof op.p4 !== 'string' || !ALLOWED_FALLBACK_SCALAR_FUNCTIONS.has(op.p4)) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan invokes an unbounded scalar function.',
        )
      }
      const isOctetLength = op.p4 === 'octet_length(1)'
      const argReg = op.p2
      const prev = i > 0 ? ops[i - 1] : undefined
      let provenMetadataOnly = false
      let metadataSource: { readonly cursor: number; readonly colIdx: number } | undefined

      const columnFlagsProven = (p5: number): boolean =>
        isOctetLength
          ? (p5 & SQLITE_OPFLAG_BYTELENARG) === SQLITE_OPFLAG_BYTELENARG
          : (p5 & SQLITE_OPFLAG_TYPEOFARG) === SQLITE_OPFLAG_TYPEOFARG

      if (prev && prev.opcode === 'Rowid' && prev.p2 === argReg) {
        provenMetadataOnly = true
      } else if (
        prev &&
        prev.opcode === 'Column' &&
        prev.p3 === argReg &&
        columnFlagsProven(prev.p5)
      ) {
        provenMetadataOnly = true
        metadataSource = { cursor: prev.p1, colIdx: prev.p2 }
      } else if (
        options?.allowGuardedVirtualEval &&
        i >= 3 &&
        prev &&
        prev.opcode === 'Affinity' &&
        prev.p1 === argReg &&
        prev.p2 === 1
      ) {
        const producer = ops[i - 2]!
        const guardNullRow = ops[i - 3]!
        if (producer.opcode === 'Rowid' && producer.p2 === argReg) {
          provenMetadataOnly = true
        } else if (
          producer.opcode === 'Column' &&
          producer.p3 === argReg &&
          guardNullRow.opcode === 'IfNullRow' &&
          guardNullRow.p1 === producer.p1 &&
          guardNullRow.p2 === op.addr &&
          verifiedGuardRanges.some(
            (range) =>
              range.cursor === producer.p1 &&
              range.colIdx === producer.p2 &&
              range.fromAddr < guardNullRow.addr &&
              range.untilAddr > op.addr,
          )
        ) {
          provenMetadataOnly = true
        }
      }

      if (!provenMetadataOnly) {
        throw new AgyIdentityBudgetExceededError(
          `Antigravity fallback SQLite query plan cannot prove metadata-only column access before ${op.p4}.`,
        )
      }

      if (metadataSource !== undefined) {
        for (let j = i + 1; j < Math.min(ops.length, i + 4); j += 1) {
          const jumpOp = ops[j]!
          if (!CONDITIONAL_GUARD_JUMP_OPCODES.has(jumpOp.opcode)) break
          if (jumpOp.p2 > op.addr) {
            verifiedGuardRanges.push({
              cursor: metadataSource.cursor,
              colIdx: metadataSource.colIdx,
              fromAddr: op.addr,
              untilAddr: jumpOp.p2,
            })
          }
        }
      }
    } else if (op.opcode === 'AggStep' || op.opcode === 'AggStep1' || op.opcode === 'AggFinal') {
      if (typeof op.p4 !== 'string' || !ALLOWED_FALLBACK_AGG_FUNCTIONS.has(op.p4)) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan invokes an unbounded aggregate function.',
        )
      }
    } else if (op.opcode === 'String8') {
      if (typeof op.p4 === 'string' && Buffer.byteLength(op.p4, 'utf8') > 1024) {
        throw new AgyIdentityBudgetExceededError(
          'Antigravity fallback SQLite query plan embeds an oversized string literal.',
        )
      }
    }
  }
}

function readBoundedExplainOps(db: Database.Database, sql: string): SqliteExplainRow[] {
  const stmt = db.prepare<[], SqliteExplainRow>(`EXPLAIN ${sql}`)
  const ops: SqliteExplainRow[] = []
  for (const op of stmt.iterate()) {
    ops.push(op)
    if (ops.length > MAX_FALLBACK_VDBE_OPS) {
      break
    }
  }
  return ops
}

function assertBoundedFallbackQueryPlan(
  db: Database.Database,
  sql: string,
  options?: { readonly allowGuardedVirtualEval?: boolean },
): void {
  const ops = readBoundedExplainOps(db, sql)
  verifyBoundedFallbackVdbeOps(ops, options)
}

export function validateTrajectoryDatabase(
  db: Database.Database,
  expectedSessionId: string,
  proof?: AgyPreScannedSqliteProof,
): ValidatedTrajectorySchema {
  if (proof) {
    assertProofHasOrdinaryTables(proof, REQUIRED_TRAJECTORY_TABLES)
  }

  const masterRows = db
    .prepare<[], SqliteMasterRow & { rootpage: number }>(
      `SELECT name, type, rootpage, sql FROM sqlite_master WHERE type IN ('table', 'index', 'view', 'trigger') AND substr(name, 1, 7) != 'sqlite_' ORDER BY type DESC, name ASC`,
    )
    .all()

  const tables = new Map<string, SqliteMasterRow>()
  const indexes: SqliteMasterRow[] = []
  for (const row of masterRows) {
    if (row.type === 'view' || row.type === 'trigger') {
      throw new Error(`Unsupported SQLite ${row.type} (${row.name}) in Antigravity trajectory.`)
    }
    if (row.type === 'table') {
      if (row.rootpage === 0 || (row.sql && /^\s*CREATE\s+VIRTUAL\s+TABLE\b/iu.test(row.sql))) {
        throw new Error(`Unsupported virtual SQLite table (${row.name}) in Antigravity trajectory.`)
      }
      quoteSqlIdentifier(row.name)
      tables.set(row.name, row)
    } else if (row.type === 'index' && row.sql) {
      indexes.push(row)
    }
  }

  for (const required of REQUIRED_TRAJECTORY_TABLES) {
    if (!tables.has(required)) {
      throw new Error(`Missing required Antigravity table: ${required}.`)
    }
  }

  for (const tableName of tables.keys()) {
    if (KNOWN_TRAJECTORY_TABLES.has(tableName)) continue
    const countRow = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(tableName)}`,
      )
      .get()
    if (!countRow || countRow.count > 0) {
      throw new Error(
        `Unsupported non-empty Antigravity table (${tableName}) prevents safe trajectory closure.`,
      )
    }
  }

  for (const closedEmptyTable of ['parent_references', 'battle_mode_infos'] as const) {
    if (!tables.has(closedEmptyTable)) continue
    const countRow = db
      .prepare<[], { count: number }>(
        `SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(closedEmptyTable)}`,
      )
      .get()
    if (!countRow || countRow.count > 0) {
      throw new Error(
        `Antigravity trajectory has unclosed rows in ${closedEmptyTable}; failing closed.`,
      )
    }
  }

  const metaColumns = readTableColumns(db, 'trajectory_meta')
  if (!metaColumns.includes('trajectory_id') || !metaColumns.includes('cascade_id')) {
    throw new Error('Antigravity trajectory_meta is missing trajectory_id or cascade_id columns.')
  }
  const metaRowCount = db
    .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "trajectory_meta"')
    .get()
  if (!metaRowCount || metaRowCount.count !== 1) {
    throw new Error('Antigravity trajectory_meta must contain exactly one row.')
  }
  if (measureTableColumnsTotalBytes(db, 'trajectory_meta', metaColumns) > AGY_TEXT_BUDGET_BYTES) {
    throw new AgentExecutionError(
      'response_too_large',
      'Antigravity trajectory_meta exceeds 8 MiB.',
      false,
    )
  }
  const metaSelectList = metaColumns.map(quoteSqlIdentifier).join(', ')
  const metaRows = db
    .prepare<[], Record<string, unknown>>(`SELECT ${metaSelectList} FROM "trajectory_meta" LIMIT 2`)
    .all()
  if (metaRows.length !== 1) {
    throw new Error('Antigravity trajectory_meta must contain exactly one row.')
  }
  const metaRow = metaRows[0]!
  const trajectoryId = metaRow['trajectory_id']
  const cascadeId = metaRow['cascade_id']
  const rawStepFormat = metaRow['step_format'] ?? 0
  if (
    typeof trajectoryId !== 'string' ||
    !SAFE_ID_PATTERN.test(trajectoryId) ||
    typeof cascadeId !== 'string' ||
    cascadeId !== expectedSessionId ||
    typeof rawStepFormat !== 'number' ||
    !Number.isSafeInteger(rawStepFormat) ||
    rawStepFormat !== 0
  ) {
    throw new Error('Antigravity trajectory_meta identity or step_format is incompatible.')
  }

  const stepColumns = readTableColumns(db, 'steps')
  for (const requiredCol of ['idx', 'step_type', 'status', 'has_subtrajectory', 'metadata']) {
    if (!stepColumns.includes(requiredCol)) {
      throw new Error(`Antigravity steps table is missing required column: ${requiredCol}.`)
    }
  }
  const stepPayloadColumn: 'step_payload' | 'data' | undefined = stepColumns.includes(
    'step_payload',
  )
    ? 'step_payload'
    : stepColumns.includes('data')
      ? 'data'
      : undefined
  if (!stepPayloadColumn) {
    throw new Error('Antigravity steps table is missing required column: step_payload.')
  }
  const hasStepFormatColumn = stepColumns.includes('step_format')
  const genColumns = readTableColumns(db, 'gen_metadata')
  for (const requiredCol of ['idx', 'data']) {
    if (!genColumns.includes(requiredCol)) {
      throw new Error(`Antigravity gen_metadata table is missing required column: ${requiredCol}.`)
    }
  }
  const execColumns = readTableColumns(db, 'executor_metadata')
  for (const requiredCol of ['idx', 'data']) {
    if (!execColumns.includes(requiredCol)) {
      throw new Error(
        `Antigravity executor_metadata table is missing required column: ${requiredCol}.`,
      )
    }
  }

  let trajectoryMetadataRows: Array<Record<string, unknown>> = []
  if (tables.has('trajectory_metadata_blob')) {
    const blobColumns = readTableColumns(db, 'trajectory_metadata_blob')
    const blobCountRow = db
      .prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM "trajectory_metadata_blob"')
      .get()
    if (blobCountRow && blobCountRow.count > 1) {
      throw new Error('Antigravity trajectory_metadata_blob has multiple rows.')
    }
    if (blobCountRow && blobCountRow.count === 1) {
      if (
        measureTableColumnsTotalBytes(db, 'trajectory_metadata_blob', blobColumns) >
        AGY_TEXT_BUDGET_BYTES
      ) {
        throw new AgentExecutionError(
          'response_too_large',
          'Antigravity trajectory_metadata_blob exceeds 8 MiB.',
          false,
        )
      }
      const blobSelectList = blobColumns.map(quoteSqlIdentifier).join(', ')
      trajectoryMetadataRows = db
        .prepare<[], Record<string, unknown>>(
          `SELECT ${blobSelectList} FROM "trajectory_metadata_blob" LIMIT 2`,
        )
        .all()
    }
    if (trajectoryMetadataRows.length > 1) {
      throw new Error('Antigravity trajectory_metadata_blob has multiple rows.')
    }
    if (trajectoryMetadataRows.length === 1) {
      const dataBlob = trajectoryMetadataRows[0]!['data']
      if (dataBlob != null) {
        if (!Buffer.isBuffer(dataBlob)) {
          throw new Error('Antigravity trajectory_metadata_blob.data must be a BLOB.')
        }
        if (dataBlob.length > AGY_TEXT_BUDGET_BYTES) {
          throw new AgentExecutionError(
            'response_too_large',
            'Antigravity trajectory_metadata_blob exceeds 8 MiB.',
            false,
          )
        }
        const decodedMeta = decodeCortexTrajectoryMetadata(dataBlob)
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
            'Antigravity trajectory_metadata_blob contains unclosed parent, battle, or subagent lineage.',
          )
        }
      }
    }
  }

  return {
    tables,
    indexes,
    stepColumns,
    stepPayloadColumn,
    hasStepFormatColumn,
    genColumns,
    execColumns,
    metaColumns,
    trajectoryId,
    cascadeId,
    stepFormat: rawStepFormat,
    metaRow,
    trajectoryMetadataRows,
  }
}

function isTransientAgySnapshotChurn(error: unknown): boolean {
  if (error instanceof AgyHotRollbackJournalError) return true
  if (error instanceof AgyTransientIdentityChurnError) return true
  if (isTransientFileLockError(error)) return true
  if (!(error instanceof Error)) return false
  return (
    error.message.includes('changed while') ||
    error.message.includes('changed after') ||
    error.message.includes('changed during') ||
    error.message.includes('did not match expected size')
  )
}

export type AgyTrajectoryIdentityResult =
  | {
      readonly status: 'ok'
      readonly trajectoryId: string
      readonly stepCount: number
    }
  | {
      readonly status:
        | 'no_storage_root'
        | 'missing'
        | 'transient_churn'
        | 'invalid'
        | 'budget_exceeded'
      readonly reason?: string
    }

const MAX_IDENTITY_REASON_BYTES = 512

const FALLBACK_STEP_SCAN_CHECK_INTERVAL = 256

function boundIdentityReason(reason: string): string {
  const trimmed = reason.trim()
  if (!trimmed) return 'Antigravity trajectory identity read exceeded its budget.'
  const encoded = Buffer.from(trimmed, 'utf8')
  if (encoded.byteLength <= MAX_IDENTITY_REASON_BYTES) return trimmed
  let end = trimmed.length
  while (end > 0 && Buffer.byteLength(trimmed.slice(0, end), 'utf8') > MAX_IDENTITY_REASON_BYTES) {
    end -= 1
  }
  return trimmed.slice(0, end)
}

function unquoteSqlIdent(token: string): string {
  const trimmed = token.trim()
  if (trimmed.length >= 2) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replaceAll('""', '"')
    }
    if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
      return trimmed.slice(1, -1).replaceAll('``', '`')
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

const QUOTED_SQL_IDENT_SOURCE = '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\])'

const UNQUOTED_SQL_IDENT_SOURCE = '[a-z_][a-z0-9_$]*(?=$|[\\s,()])'

const SQL_IDENT_PATTERN_SOURCE = `(?:${QUOTED_SQL_IDENT_SOURCE}|${UNQUOTED_SQL_IDENT_SOURCE})`

const QUOTED_LEADING_SQL_IDENT_RE = new RegExp(`^${QUOTED_SQL_IDENT_SOURCE}`, 'u')

const UNQUOTED_LEADING_SQL_IDENT_RE = /^[a-z_][a-z0-9_$]*/iu

const TABLE_PK_CONSTRAINT_RE = new RegExp(
  `^(?:CONSTRAINT\\s+${SQL_IDENT_PATTERN_SOURCE}\\s+)?PRIMARY\\s+KEY\\s*\\(([^)]+)\\)(?:\\s+ON\\s+CONFLICT\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?$`,
  'iu',
)

const SINGLE_PK_COLUMN_RE = new RegExp(`^(${SQL_IDENT_PATTERN_SOURCE})(?:\\s+ASC)?$`, 'iu')

const COLUMN_CONSTRAINT_STARTERS = new Set([
  'CONSTRAINT',
  'PRIMARY',
  'NOT',
  'UNIQUE',
  'CHECK',
  'DEFAULT',
  'COLLATE',
  'REFERENCES',
  'GENERATED',
  'AS',
])

const TABLE_CONSTRAINT_STARTERS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN'])

interface LexedSqlToken {
  readonly raw: string
  readonly quoted: boolean
  readonly value: string
  readonly nextOffset: number
}

function lexLeadingSqlToken(text: string): LexedSqlToken | undefined {
  if (text.length === 0) return undefined
  const first = text[0]!
  if (first === '"' || first === '`' || first === '[') {
    const match = QUOTED_LEADING_SQL_IDENT_RE.exec(text)
    if (!match) return undefined
    const raw = match[0]
    const nextChar = text[raw.length]
    if (nextChar !== undefined && !/[\s,()]/u.test(nextChar)) {
      return undefined
    }
    return {
      raw,
      quoted: true,
      value: unquoteSqlIdent(raw),
      nextOffset: raw.length,
    }
  }
  const match = UNQUOTED_LEADING_SQL_IDENT_RE.exec(text)
  if (!match) return undefined
  const raw = match[0]
  const nextChar = text[raw.length]
  if (nextChar !== undefined && !/[\s,()]/u.test(nextChar)) {
    return undefined
  }
  return {
    raw,
    quoted: false,
    value: raw,
    nextOffset: raw.length,
  }
}

function splitCreateTableBodyParts(
  strippedSql: string,
): { readonly parts: string[]; readonly trailing: string } | undefined {
  const openParen = strippedSql.indexOf('(')
  if (openParen < 0) return undefined
  let depth = 0
  let closeParen = -1
  let k = openParen
  const parts: string[] = []
  let partStart = openParen + 1
  while (k < strippedSql.length) {
    const ch = strippedSql[k]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      k += 1
      while (k < strippedSql.length) {
        if (strippedSql[k] === quote) {
          if (strippedSql[k + 1] === quote) k += 2
          else {
            k += 1
            break
          }
        } else {
          k += 1
        }
      }
      continue
    }
    if (ch === '[') {
      k += 1
      while (k < strippedSql.length && strippedSql[k] !== ']') k += 1
      k += 1
      continue
    }
    if (ch === '(') {
      depth += 1
    } else if (ch === ')') {
      depth -= 1
      if (depth === 0) {
        parts.push(strippedSql.slice(partStart, k))
        closeParen = k
        break
      }
    } else if (ch === ',' && depth === 1) {
      parts.push(strippedSql.slice(partStart, k))
      partStart = k + 1
    }
    k += 1
  }
  if (closeParen < 0) return undefined
  return { parts, trailing: strippedSql.slice(closeParen + 1).trim() }
}

function extractVirtualColumnDirectSourceAlias(
  tableSql: string,
  targetColumnName: string,
): string | undefined {
  const { cleaned } = stripSqlCommentsAndMaskQuotes(tableSql)
  const split = splitCreateTableBodyParts(cleaned)
  if (!split) return undefined
  for (const rawPart of split.parts) {
    const item = rawPart.trim()
    if (!item) continue
    const colTok = lexLeadingSqlToken(item)
    if (!colTok) continue
    if (!colTok.quoted && TABLE_CONSTRAINT_STARTERS.has(colTok.value.toUpperCase())) {
      continue
    }
    if (colTok.value.toLowerCase() !== targetColumnName.toLowerCase()) {
      continue
    }
    const rest = item.slice(colTok.nextOffset)
    let depth = 0
    let i = 0
    while (i < rest.length) {
      const ch = rest[i]!
      if (ch === "'" || ch === '"' || ch === '`') {
        const quote = ch
        i += 1
        while (i < rest.length) {
          if (rest[i] === quote) {
            if (rest[i + 1] === quote) i += 2
            else {
              i += 1
              break
            }
          } else {
            i += 1
          }
        }
        continue
      }
      if (ch === '[') {
        i += 1
        while (i < rest.length && rest[i] !== ']') i += 1
        i += 1
        continue
      }
      if (ch === '(') {
        depth += 1
        i += 1
        continue
      }
      if (ch === ')') {
        depth = Math.max(0, depth - 1)
        i += 1
        continue
      }
      if (depth === 0 && /[a-z_]/iu.test(ch)) {
        const start = i
        while (i < rest.length && /[a-z0-9_$]/iu.test(rest[i]!)) i += 1
        if (rest.slice(start, i).toUpperCase() === 'AS') {
          let j = i
          while (j < rest.length && /\s/u.test(rest[j]!)) j += 1
          if (rest[j] !== '(') continue
          let exprDepth = 0
          let exprEnd = -1
          for (let m = j; m < rest.length; m += 1) {
            const ech = rest[m]!
            if (ech === "'" || ech === '"' || ech === '`') {
              const eq = ech
              m += 1
              while (m < rest.length) {
                if (rest[m] === eq) {
                  if (rest[m + 1] === eq) m += 2
                  else break
                } else {
                  m += 1
                }
              }
              continue
            }
            if (ech === '[') {
              m += 1
              while (m < rest.length && rest[m] !== ']') m += 1
              continue
            }
            if (ech === '(') exprDepth += 1
            else if (ech === ')') {
              exprDepth -= 1
              if (exprDepth === 0) {
                exprEnd = m
                break
              }
            }
          }
          if (exprEnd < 0) return undefined
          let inner = rest.slice(j + 1, exprEnd).trim()
          while (inner.startsWith('(') && inner.endsWith(')')) {
            // Strip redundant outer parens only if they wrap the entire expression.
            let pDepth = 0
            let wrapsAll = true
            for (let p = 0; p < inner.length; p += 1) {
              const pch = inner[p]!
              if (pch === '(') pDepth += 1
              else if (pch === ')') {
                pDepth -= 1
                if (pDepth === 0 && p < inner.length - 1) {
                  wrapsAll = false
                  break
                }
              }
            }
            if (!wrapsAll) break
            inner = inner.slice(1, -1).trim()
          }
          const aliasTok = lexLeadingSqlToken(inner)
          if (!aliasTok || inner.slice(aliasTok.nextOffset).trim().length > 0) {
            return undefined
          }
          return aliasTok.value
        }
        continue
      }
      i += 1
    }
    return undefined
  }
  return undefined
}

function stripSqlCommentsAndMaskQuotes(sql: string): { cleaned: string; unquoted: string } {
  let cleaned = ''
  let unquoted = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i += 1
      cleaned += ' '
      unquoted += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1
      i += 2
      cleaned += ' '
      unquoted += ' '
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      cleaned += ch
      unquoted += ' '
      i += 1
      while (i < sql.length) {
        const qch = sql[i]!
        cleaned += qch
        i += 1
        if (qch === quote) {
          if (sql[i] === quote) {
            cleaned += sql[i]!
            i += 1
          } else {
            break
          }
        }
      }
      unquoted += ' '
      continue
    }
    if (ch === '[') {
      cleaned += ch
      unquoted += ' '
      i += 1
      while (i < sql.length) {
        const bch = sql[i]!
        cleaned += bch
        i += 1
        if (bch === ']') break
      }
      unquoted += ' '
      continue
    }
    cleaned += ch
    unquoted += ch
    i += 1
  }
  return { cleaned, unquoted }
}

function splitColumnTypeAndConstraints(rest: string): {
  typeText: string
  constraintsText: string
} {
  let depth = 0
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]!
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < rest.length) {
        if (rest[i] === quote) {
          if (rest[i + 1] === quote) i += 2
          else {
            i += 1
            break
          }
        } else {
          i += 1
        }
      }
      continue
    }
    if (ch === '[') {
      i += 1
      while (i < rest.length && rest[i] !== ']') i += 1
      i += 1
      continue
    }
    if (ch === '(') {
      depth += 1
      i += 1
      continue
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1)
      i += 1
      continue
    }
    if (depth === 0 && /[a-z_]/iu.test(ch)) {
      const start = i
      while (i < rest.length && /[a-z0-9_$]/iu.test(rest[i]!)) i += 1
      const word = rest.slice(start, i).toUpperCase()
      if (COLUMN_CONSTRAINT_STARTERS.has(word)) {
        return {
          typeText: rest.slice(0, start).trim(),
          constraintsText: rest.slice(start).trim(),
        }
      }
      continue
    }
    i += 1
  }
  return { typeText: rest.trim(), constraintsText: '' }
}

function hasOnlyWhitelistedIntegerConstraints(
  constraintsText: string,
  allowPrimaryKey: boolean,
): boolean {
  let remaining = constraintsText.trim()
  while (remaining.length > 0) {
    const pkMatch = allowPrimaryKey
      ? /^PRIMARY\s+KEY(?:\s+ASC)?(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?:\s+AUTOINCREMENT)?(?=\s|$)/iu.exec(
          remaining,
        )
      : null
    if (pkMatch) {
      remaining = remaining.slice(pkMatch[0].length).trim()
      continue
    }
    const notNullMatch =
      /^NOT\s+NULL(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?=\s|$)/iu.exec(
        remaining,
      )
    if (notNullMatch) {
      remaining = remaining.slice(notNullMatch[0].length).trim()
      continue
    }
    const uniqueMatch =
      /^UNIQUE(?:\s+ON\s+CONFLICT\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE))?(?=\s|$)/iu.exec(
        remaining,
      )
    if (uniqueMatch) {
      remaining = remaining.slice(uniqueMatch[0].length).trim()
      continue
    }
    return false
  }
  return true
}

function hasNonAsciiCodeUnit(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return true
  }
  return false
}

function hasNonPrintableAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return true
  }
  return false
}

function parseCreateTableDdl(
  sql: string,
): { columns: string[]; rowidAliasCol: string | undefined } | undefined {
  const { cleaned: stripped, unquoted } = stripSqlCommentsAndMaskQuotes(sql)
  if (
    hasNonAsciiCodeUnit(unquoted) ||
    /\bVIRTUAL\s+TABLE\b/iu.test(unquoted) ||
    /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b[\s\S]*\bAS\s+SELECT\b/iu.test(unquoted) ||
    /\b(?:WITHOUT\s+ROWID|VIRTUAL|GENERATED|STORED)\b/iu.test(unquoted) ||
    /\bAS\s*\(/iu.test(unquoted)
  ) {
    return undefined
  }

  const split = splitCreateTableBodyParts(stripped)
  if (!split || split.trailing.length > 0) {
    return undefined
  }
  const { parts } = split

  const columns: string[] = []
  const colNameByLower = new Map<string, string>()
  const exactIntegerForTablePk = new Map<string, boolean>()
  const nonExactIntegerCols = new Set<string>()
  let inlineRowidCol: string | undefined
  let tablePkCol: string | undefined
  let pkCount = 0

  const handleTablePrimaryKeyConstraint = (constraintText: string): boolean => {
    const pkMatch = TABLE_PK_CONSTRAINT_RE.exec(constraintText)
    if (!pkMatch) return false
    pkCount += 1
    if (pkCount > 1) return false
    const pkExpr = pkMatch[1]!.trim()
    if (pkExpr.includes(',') || /\bDESC\b/iu.test(pkExpr)) {
      return false
    }
    const singleCol = SINGLE_PK_COLUMN_RE.exec(pkExpr)
    if (!singleCol) return false
    tablePkCol = unquoteSqlIdent(singleCol[1]!)
    return true
  }

  for (const rawPart of parts) {
    const item = rawPart.trim()
    if (!item) return undefined
    const leadingTok = lexLeadingSqlToken(item)
    if (!leadingTok) return undefined

    if (!leadingTok.quoted && TABLE_CONSTRAINT_STARTERS.has(leadingTok.value.toUpperCase())) {
      const keyword = leadingTok.value.toUpperCase()
      let constraintHead = keyword
      let afterHead = item.slice(leadingTok.nextOffset).trim()
      if (keyword === 'CONSTRAINT') {
        const nameTok = lexLeadingSqlToken(afterHead)
        if (!nameTok) return undefined
        const afterName = afterHead.slice(nameTok.nextOffset).trim()
        const bodyKwTok = lexLeadingSqlToken(afterName)
        if (!bodyKwTok || bodyKwTok.quoted) return undefined
        constraintHead = bodyKwTok.value.toUpperCase()
        afterHead = afterName.slice(bodyKwTok.nextOffset).trim()
      }
      if (constraintHead === 'PRIMARY') {
        const keyTok = lexLeadingSqlToken(afterHead)
        if (!keyTok || keyTok.quoted || keyTok.value.toUpperCase() !== 'KEY') return undefined
        if (!handleTablePrimaryKeyConstraint(item)) return undefined
        continue
      }
      if (constraintHead === 'UNIQUE' || constraintHead === 'CHECK') {
        if (!afterHead.startsWith('(')) return undefined
        continue
      }
      if (constraintHead === 'FOREIGN') {
        const keyTok = lexLeadingSqlToken(afterHead)
        if (!keyTok || keyTok.quoted || keyTok.value.toUpperCase() !== 'KEY') return undefined
        const afterKey = afterHead.slice(keyTok.nextOffset).trim()
        if (!afterKey.startsWith('(')) return undefined
        continue
      }
      return undefined
    }

    const colName = leadingTok.value
    if (!colName || hasNonPrintableAscii(colName)) return undefined
    const colKey = colName.toLowerCase()
    if (colNameByLower.has(colKey)) return undefined
    colNameByLower.set(colKey, colName)
    columns.push(colName)

    const rest = item.slice(leadingTok.nextOffset).trim()
    const { typeText, constraintsText } = splitColumnTypeAndConstraints(rest)
    const constraintsUnquoted = stripSqlCommentsAndMaskQuotes(constraintsText).unquoted
    if (/(?:REAL|FLOA|DOUB)/iu.test(typeText)) {
      return undefined
    }
    const isExactIntegerType = /^INTEGER$/iu.test(typeText)
    const isIntegerLikeType = /^INT(?:EGER|\b)/iu.test(typeText)

    if (/\bPRIMARY\s+KEY\b/iu.test(constraintsUnquoted)) {
      pkCount += 1
      if (pkCount > 1) return undefined
      if (/\bPRIMARY\s+KEY\s+DESC\b/iu.test(constraintsUnquoted)) {
        return undefined
      }
      if (isExactIntegerType) {
        if (!hasOnlyWhitelistedIntegerConstraints(constraintsText, true)) {
          return undefined
        }
        inlineRowidCol = colName
      } else if (isIntegerLikeType) {
        // Non-exact single-token INTEGER primary key (e.g. `INTEGER VARYING PRIMARY KEY`, `INT PRIMARY KEY`).
        return undefined
      }
    } else if (isExactIntegerType) {
      exactIntegerForTablePk.set(
        colKey,
        hasOnlyWhitelistedIntegerConstraints(constraintsText, false),
      )
    } else if (isIntegerLikeType) {
      nonExactIntegerCols.add(colKey)
    }
  }

  let rowidAliasCol: string | undefined
  if (pkCount === 1) {
    if (inlineRowidCol !== undefined) {
      rowidAliasCol = inlineRowidCol
    } else if (tablePkCol !== undefined) {
      const pkKey = tablePkCol.toLowerCase()
      const canonicalCol = colNameByLower.get(pkKey)
      if (!canonicalCol) return undefined
      if (nonExactIntegerCols.has(pkKey)) return undefined
      if (exactIntegerForTablePk.get(pkKey) === true) {
        rowidAliasCol = canonicalCol
      }
    }
  }
  return { columns, rowidAliasCol }
}

function queryBoundedIdentityFromOpenSqlite(
  db: Database.Database,
  expectedSessionId: string,
  proof: AgyPreScannedSqliteProof,
  options?: {
    readonly signal?: AbortSignal
    readonly deadlineAt?: number
    readonly maxTableDdlBytes?: number
  },
):
  | { readonly kind: 'ok'; readonly trajectoryId: string; readonly stepCount: number }
  | { readonly kind: 'invalid' } {
  const signal = options?.signal
  const deadlineAt = options?.deadlineAt
  const maxTableDdlBytes = options?.maxTableDdlBytes ?? MAX_FALLBACK_TABLE_DDL_BYTES
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)

  // Prove BOTH target tables are ordinary storage tables from the pre-scan proof BEFORE any
  // `pragma_table_xinfo` or SQL prepare, blocking virtual-table `xConnect` side-reads (e.g. FTS5).
  const metaEntry = proof.tables.get('trajectory_meta')
  const stepsEntry = proof.tables.get('steps')
  if (
    !metaEntry ||
    !stepsEntry ||
    metaEntry.isVirtual ||
    stepsEntry.isVirtual ||
    metaEntry.rootPage < 2 ||
    stepsEntry.rootPage < 2
  ) {
    return { kind: 'invalid' }
  }
  if (
    Buffer.byteLength(metaEntry.sql, 'utf8') > maxTableDdlBytes ||
    Buffer.byteLength(stepsEntry.sql, 'utf8') > maxTableDdlBytes
  ) {
    throw new AgyIdentityBudgetExceededError(
      'Antigravity table DDL exceeds bounded schema inspection limit.',
    )
  }

  const metaColHidden = readBoundedIdentityTableColumns(db, 'trajectory_meta', [
    'trajectory_id',
    'cascade_id',
  ])
  const stepColHidden = readBoundedIdentityTableColumns(db, 'steps', ['idx'])
  const trajectoryHidden = metaColHidden.get('trajectory_id')
  const cascadeHidden = metaColHidden.get('cascade_id')
  const idxHidden = stepColHidden.get('idx')
  if (trajectoryHidden === undefined || cascadeHidden === undefined || idxHidden === undefined) {
    return { kind: 'invalid' }
  }

  const resolveBoundedVirtualSource = (
    tableName: 'trajectory_meta' | 'steps',
    colName: string,
  ): string => {
    const entry = proof.tables.get(tableName)
    if (!entry || entry.isVirtual || !entry.sql) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} cannot be bounded safely.`,
      )
    }
    const aliasTarget = extractVirtualColumnDirectSourceAlias(entry.sql, colName)
    if (!aliasTarget) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} expression cannot be bounded safely within memory limits.`,
      )
    }
    const storedName = findStoredTableColumnName(db, tableName, aliasTarget)
    if (!storedName) {
      throw new AgyIdentityBudgetExceededError(
        `Generated Antigravity column ${tableName}.${colName} does not map to a bounded stored column.`,
      )
    }
    return quoteArbitrarySqlIdentifier(storedName)
  }

  const buildBoundedTextIdentityProjection = (
    colName: 'trajectory_id' | 'cascade_id',
    aliasPrefix: 'trajectory' | 'cascade',
    hidden: number,
  ): string => {
    const quotedCol = `"${colName}"`
    if (hidden === 2) {
      const quotedSource = resolveBoundedVirtualSource('trajectory_meta', colName)
      return `
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
          THEN typeof(${quotedCol})
          ELSE NULL
        END AS ${aliasPrefix}Type,
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
          THEN octet_length(${quotedCol})
          ELSE NULL
        END AS ${aliasPrefix}ByteLength,
        CASE
          WHEN octet_length(${quotedSource}) BETWEEN 1 AND 1024
            AND typeof(${quotedCol}) = 'text'
            AND octet_length(${quotedCol}) BETWEEN 1 AND 1024
          THEN ${quotedCol}
          ELSE NULL
        END AS ${aliasPrefix}Id`
    }
    return `
      typeof(${quotedCol}) AS ${aliasPrefix}Type,
      octet_length(${quotedCol}) AS ${aliasPrefix}ByteLength,
      CASE
        WHEN typeof(${quotedCol}) = 'text'
          AND octet_length(${quotedCol}) BETWEEN 1 AND 1024
        THEN ${quotedCol}
        ELSE NULL
      END AS ${aliasPrefix}Id`
  }

  const metaQuerySql = `SELECT
    ${buildBoundedTextIdentityProjection('trajectory_id', 'trajectory', trajectoryHidden)},
    ${buildBoundedTextIdentityProjection('cascade_id', 'cascade', cascadeHidden)}
  FROM "trajectory_meta" NOT INDEXED
  LIMIT 2`
  assertBoundedFallbackQueryPlan(db, metaQuerySql, {
    allowGuardedVirtualEval: trajectoryHidden === 2 || cascadeHidden === 2,
  })
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)
  const metaRows = db
    .prepare<
      [],
      {
        trajectoryType: unknown
        trajectoryByteLength: unknown
        trajectoryId: unknown
        cascadeType: unknown
        cascadeByteLength: unknown
        cascadeId: unknown
      }
    >(metaQuerySql)
    .all()
  if (metaRows.length !== 1) {
    return { kind: 'invalid' }
  }
  const row = metaRows[0]!
  const trajectoryId = row.trajectoryId
  const cascadeId = row.cascadeId
  if (
    row.trajectoryType !== 'text' ||
    row.cascadeType !== 'text' ||
    typeof row.trajectoryByteLength !== 'number' ||
    typeof row.cascadeByteLength !== 'number' ||
    !isValidAgyTrajectoryId(trajectoryId) ||
    cascadeId !== expectedSessionId
  ) {
    return { kind: 'invalid' }
  }

  if (idxHidden === 0) {
    const probeOps = readBoundedExplainOps(db, `SELECT "idx" FROM "steps" NOT INDEXED LIMIT 1`)
    const isProvenRowidAlias =
      probeOps.length <= MAX_FALLBACK_VDBE_OPS &&
      probeOps.some((op) => op.opcode === 'Rowid') &&
      probeOps.every(
        (op) => op.opcode !== 'Column' && !DISALLOWED_FALLBACK_VDBE_OPCODES.has(op.opcode),
      )
    if (isProvenRowidAlias) {
      const minSql = `SELECT "idx" AS idxVal FROM "steps" ORDER BY "idx" ASC LIMIT 1`
      const maxSql = `SELECT "idx" AS idxVal FROM "steps" ORDER BY "idx" DESC LIMIT 1`
      assertBoundedFallbackQueryPlan(db, minSql)
      assertBoundedFallbackQueryPlan(db, maxSql)
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
      const minStmt = db.prepare<[], { idxVal: unknown }>(minSql)
      minStmt.safeIntegers(true)
      const minRow = minStmt.get()
      if (!minRow) {
        return { kind: 'ok', trajectoryId, stepCount: 0 }
      }
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
      const maxStmt = db.prepare<[], { idxVal: unknown }>(maxSql)
      maxStmt.safeIntegers(true)
      const maxRow = maxStmt.get()
      if (
        !maxRow ||
        typeof minRow.idxVal !== 'bigint' ||
        typeof maxRow.idxVal !== 'bigint' ||
        minRow.idxVal < 0n ||
        maxRow.idxVal < 0n ||
        maxRow.idxVal >= BigInt(Number.MAX_SAFE_INTEGER)
      ) {
        return { kind: 'invalid' }
      }
      return {
        kind: 'ok',
        trajectoryId,
        stepCount: Number(maxRow.idxVal) + 1,
      }
    }
  }

  const stepQuerySql =
    idxHidden === 2
      ? (() => {
          const quotedSource = resolveBoundedVirtualSource('steps', 'idx')
          const safeSourceGuard = `(typeof(${quotedSource}) = 'integer' OR typeof(${quotedSource}) = 'real' OR (typeof(${quotedSource}) = 'text' AND octet_length(${quotedSource}) BETWEEN 1 AND 32))`
          return `SELECT
            CASE
              WHEN typeof(${quotedSource}) IN ('text', 'blob') AND octet_length(${quotedSource}) > 32
              THEN 1
              ELSE 0
            END AS oversized,
            CASE
              WHEN ${safeSourceGuard}
              THEN typeof("idx")
              ELSE NULL
            END AS idxType,
            CASE
              WHEN ${safeSourceGuard} AND typeof("idx") = 'integer'
              THEN "idx"
              ELSE NULL
            END AS idxVal
          FROM "steps" NOT INDEXED`
        })()
      : `SELECT
          0 AS oversized,
          typeof("idx") AS idxType,
          CASE WHEN typeof("idx") = 'integer' THEN "idx" ELSE NULL END AS idxVal
        FROM "steps" NOT INDEXED`
  assertBoundedFallbackQueryPlan(db, stepQuerySql, {
    allowGuardedVirtualEval: idxHidden === 2,
  })
  const stepStmt = db.prepare<[], { oversized: unknown; idxType: unknown; idxVal: unknown }>(
    stepQuerySql,
  )
  stepStmt.safeIntegers(true)

  let rowCount = 0
  let maxIdx: bigint | undefined
  for (const stepRow of stepStmt.iterate()) {
    if (rowCount % FALLBACK_STEP_SCAN_CHECK_INTERVAL === 0) {
      assertIdentityNotCancelledOrExpired(signal, deadlineAt)
    }
    rowCount += 1
    if (rowCount > AGY_STORAGE_MAX_RECORDS) {
      throw new AgyIdentityBudgetExceededError(
        `Antigravity fallback steps scan exceeded the ${AGY_STORAGE_MAX_RECORDS}-row record budget.`,
      )
    }
    if (stepRow.oversized === 1n || stepRow.oversized === 1) {
      throw new AgyIdentityBudgetExceededError(
        'Antigravity VIRTUAL steps.idx source value exceeded bounded evaluation size.',
      )
    }
    if (
      stepRow.idxType !== 'integer' ||
      typeof stepRow.idxVal !== 'bigint' ||
      stepRow.idxVal < 0n ||
      stepRow.idxVal >= BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      return { kind: 'invalid' }
    }
    if (maxIdx === undefined || stepRow.idxVal > maxIdx) {
      maxIdx = stepRow.idxVal
    }
  }
  assertIdentityNotCancelledOrExpired(signal, deadlineAt)
  if (rowCount === 0) {
    return { kind: 'ok', trajectoryId, stepCount: 0 }
  }
  if (maxIdx === undefined) {
    return { kind: 'invalid' }
  }
  return {
    kind: 'ok',
    trajectoryId,
    stepCount: Number(maxIdx) + 1,
  }
}

type FastIdentityImageOutcome =
  | { readonly kind: 'ok'; readonly trajectoryId: string; readonly stepCount: number }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'fallback' }

function readFastIdentityFromCommittedImage(
  image: AgyCommittedReadImage,
  expectedSessionId: string,
  schemaCatalogBudget?: AgySchemaCatalogBudget,
): FastIdentityImageOutcome {
  const usableSize = image.usableSize
  const readPage = (pageNo: number): Buffer => image.readPage(pageNo)

  const returnInvalidIfStable = (): FastIdentityImageOutcome => {
    image.verifyUnchanged({ includeAccessedPages: true })
    return { kind: 'invalid' }
  }

  // Always pre-scan sqlite_schema + sqlite_stat1/4 within budget BEFORE fast decode or fallback!
  const catalog = image.preScanCatalog(schemaCatalogBudget)
  const metaEntry = catalog.tables.get('trajectory_meta')
  const stepsEntry = catalog.tables.get('steps')
  if (!metaEntry || !stepsEntry) {
    return returnInvalidIfStable()
  }
  if (
    metaEntry.isVirtual ||
    stepsEntry.isVirtual ||
    metaEntry.rootPage < 2 ||
    stepsEntry.rootPage < 2
  ) {
    return returnInvalidIfStable()
  }

  const textEncoding = image.effectivePage1.readUInt32BE(56)
  if (textEncoding !== 1) {
    return { kind: 'fallback' }
  }

  const metaDdl = parseCreateTableDdl(metaEntry.sql)
  const stepsDdl = parseCreateTableDdl(stepsEntry.sql)
  if (!metaDdl || !stepsDdl) {
    return { kind: 'fallback' }
  }
  const trajColIdx = metaDdl.columns.indexOf('trajectory_id')
  const cascadeColIdx = metaDdl.columns.indexOf('cascade_id')
  if (trajColIdx < 0 || cascadeColIdx < 0) {
    return returnInvalidIfStable()
  }
  const stepsIdxCol = stepsDdl.columns.indexOf('idx')
  if (stepsIdxCol < 0) {
    return returnInvalidIfStable()
  }

  const assembleLeafPayload = (
    pageBuf: Buffer,
    payloadStart: number,
    payloadLen: number,
    maxPrefixBytes?: number,
  ): Buffer =>
    assembleSqliteLeafPayload(
      readPage,
      usableSize,
      pageBuf,
      payloadStart,
      payloadLen,
      maxPrefixBytes,
    )

  const collectTableRows = (
    rootPageNo: number,
    maxRows: number,
    neededColumns: number,
  ):
    | {
        kind: 'ok'
        rows: Array<{ rowId: bigint; serialTypes: bigint[]; values: unknown[] }>
        truncated: boolean
      }
    | { kind: 'fallback' } => {
    const rows: Array<{ rowId: bigint; serialTypes: bigint[]; values: unknown[] }> = []
    const visited = new Set<number>()
    const stack: number[] = [rootPageNo]
    let truncated = false
    while (stack.length > 0) {
      const pageNo = stack.pop()!
      if (visited.has(pageNo)) throw new Error('SQLite B-tree cycle detected.')
      visited.add(pageNo)
      const page = readPage(pageNo)
      const bhdr = pageNo === 1 ? 100 : 0
      const pageType = page[bhdr]!
      const cellCount = page.readUInt16BE(bhdr + 3)
      if (pageType === 0x05) {
        const rightChild = page.readUInt32BE(bhdr + 8)
        const ptrBase = bhdr + 12
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite interior cell pointer array out of bounds.')
        }
        stack.push(rightChild)
        for (let c = cellCount - 1; c >= 0; c -= 1) {
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
            throw new Error('SQLite interior cell offset out of bounds.')
          }
          stack.push(page.readUInt32BE(cellOff))
        }
      } else if (pageType === 0x0d) {
        const ptrBase = bhdr + 8
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite leaf cell pointer array out of bounds.')
        }
        for (let c = 0; c < cellCount; c += 1) {
          if (rows.length >= maxRows) {
            truncated = true
            break
          }
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
            throw new Error('SQLite leaf cell offset out of bounds.')
          }
          const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
          const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
          const payloadLen = Number(lenDec.value)
          if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
            throw new Error('Invalid SQLite leaf payload length.')
          }
          const payload = assembleLeafPayload(page, rowIdDec.nextOffset, payloadLen)
          const decoded = decodeSqliteRecord(payload, neededColumns)
          rows.push({ rowId: rowIdDec.value, ...decoded })
        }
        if (truncated) break
      } else {
        return { kind: 'fallback' }
      }
    }
    return { kind: 'ok', rows, truncated }
  }

  const readExtremeRowId = (
    rootPageNo: number,
    side: 'min' | 'max',
    idxColIndex: number,
  ):
    | { kind: 'empty' }
    | { kind: 'row'; rowId: bigint; idxSerialType: bigint }
    | { kind: 'fallback' } => {
    const visited = new Set<number>()
    const walk = (
      pageNo: number,
    ):
      | { kind: 'empty' }
      | { kind: 'row'; rowId: bigint; idxSerialType: bigint }
      | { kind: 'fallback' } => {
      if (visited.has(pageNo)) throw new Error('SQLite B-tree cycle detected.')
      visited.add(pageNo)
      const page = readPage(pageNo)
      const bhdr = pageNo === 1 ? 100 : 0
      const pageType = page[bhdr]!
      const cellCount = page.readUInt16BE(bhdr + 3)
      if (pageType === 0x0d) {
        if (cellCount === 0) return { kind: 'empty' }
        const ptrBase = bhdr + 8
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite leaf cell pointers out of bounds.')
        }
        const cellIndex = side === 'min' ? 0 : cellCount - 1
        const cellOff = page.readUInt16BE(ptrBase + cellIndex * 2)
        if (cellOff < ptrBase + cellCount * 2 || cellOff >= usableSize) {
          throw new Error('SQLite leaf cell offset out of bounds.')
        }
        const lenDec = decodeSqliteVarint(page, cellOff, usableSize)
        const rowIdDec = decodeSqliteVarint(page, lenDec.nextOffset, usableSize)
        const payloadLen = Number(lenDec.value)
        if (lenDec.value < 0n || !Number.isSafeInteger(payloadLen)) {
          throw new Error('Invalid SQLite leaf payload length.')
        }
        const payloadPrefix = assembleLeafPayload(page, rowIdDec.nextOffset, payloadLen, 4096)
        const serialTypes = decodeSqliteRecordHeader(payloadPrefix, payloadLen, idxColIndex)
        const idxSerialType = serialTypes[idxColIndex]
        if (idxSerialType === undefined) {
          return { kind: 'fallback' }
        }
        return { kind: 'row', rowId: rowIdDec.value, idxSerialType }
      }
      if (pageType === 0x05) {
        const rightChild = page.readUInt32BE(bhdr + 8)
        const ptrBase = bhdr + 12
        if (ptrBase + cellCount * 2 > usableSize) {
          throw new Error('SQLite interior cell pointers out of bounds.')
        }
        const childPages: number[] = []
        for (let c = 0; c < cellCount; c += 1) {
          const cellOff = page.readUInt16BE(ptrBase + c * 2)
          if (cellOff < ptrBase + cellCount * 2 || cellOff + 4 > usableSize) {
            throw new Error('SQLite interior cell offset out of bounds.')
          }
          childPages.push(page.readUInt32BE(cellOff))
        }
        childPages.push(rightChild)
        const start = side === 'min' ? 0 : childPages.length - 1
        const step = side === 'min' ? 1 : -1
        for (let idx = start; idx >= 0 && idx < childPages.length; idx += step) {
          const res = walk(childPages[idx]!)
          if (res.kind !== 'empty') return res
        }
        return { kind: 'empty' }
      }
      return { kind: 'fallback' }
    }
    return walk(rootPageNo)
  }

  let trajectoryId: string
  let stepCount: number
  try {
    const metaRowsRes = collectTableRows(
      metaEntry.rootPage,
      2,
      Math.max(trajColIdx, cascadeColIdx) + 1,
    )
    if (metaRowsRes.kind === 'fallback') return { kind: 'fallback' }
    if (metaRowsRes.rows.length !== 1) {
      return returnInvalidIfStable()
    }
    const metaRow = metaRowsRes.rows[0]!
    if (metaDdl.rowidAliasCol === 'trajectory_id' || metaDdl.rowidAliasCol === 'cascade_id') {
      return { kind: 'fallback' }
    }
    if (metaRow.serialTypes.length <= trajColIdx || metaRow.serialTypes.length <= cascadeColIdx) {
      return { kind: 'fallback' }
    }
    const rawTrajectoryId = metaRow.values[trajColIdx]
    const cascadeId = metaRow.values[cascadeColIdx]
    if (!isValidAgyTrajectoryId(rawTrajectoryId) || cascadeId !== expectedSessionId) {
      return returnInvalidIfStable()
    }
    trajectoryId = rawTrajectoryId

    if (stepsDdl.rowidAliasCol !== 'idx') {
      const emptyProbe = collectTableRows(stepsEntry.rootPage, 1, 0)
      if (emptyProbe.kind === 'fallback') return { kind: 'fallback' }
      if (emptyProbe.rows.length === 0) {
        stepCount = 0
      } else {
        return { kind: 'fallback' }
      }
    } else {
      const minRes = readExtremeRowId(stepsEntry.rootPage, 'min', stepsIdxCol)
      if (minRes.kind === 'fallback') return { kind: 'fallback' }
      if (minRes.kind === 'empty') {
        stepCount = 0
      } else {
        const maxRes = readExtremeRowId(stepsEntry.rootPage, 'max', stepsIdxCol)
        if (maxRes.kind !== 'row') {
          if (maxRes.kind === 'fallback') return { kind: 'fallback' }
          throw new AgyTransientIdentityChurnError('B-tree extreme rowId mismatch.')
        }
        if (minRes.idxSerialType !== 0n || maxRes.idxSerialType !== 0n) {
          return { kind: 'fallback' }
        }
        if (
          minRes.rowId < 0n ||
          maxRes.rowId < 0n ||
          maxRes.rowId >= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          return returnInvalidIfStable()
        }
        stepCount = Number(maxRes.rowId) + 1
      }
    }
  } catch (error) {
    if (error instanceof AgyIdentityFallbackError) {
      return { kind: 'fallback' }
    }
    if (
      error instanceof AgyIdentityBudgetExceededError ||
      error instanceof AgyTransientIdentityChurnError ||
      error instanceof AgyHotRollbackJournalError ||
      error instanceof AgyOperationalStorageError ||
      isOperationalFsError(error) ||
      isIdentityAbortOrTimeoutError(error)
    ) {
      throw error
    }
    // Re-verify source stability before classifying any decode failure as `invalid`.
    image.verifyUnchanged({ includeAccessedPages: true })
    if (error instanceof AgyUnexpectedEofError) {
      throw new AgyTransientIdentityChurnError(
        'SQLite file experienced unexpected EOF during bounded read.',
      )
    }
    throw error
  }

  image.verifyUnchanged({ includeAccessedPages: true })
  return { kind: 'ok', trajectoryId, stepCount }
}

/**
 * Safely reads the host-assigned `trajectory_id` and committed step count from an
 * Antigravity session SQLite database via the single unified anchored `withAgyReadImage`
 * view — acquiring SQLite-VFS-compatible SHARED lock before reading page 1, NEVER creating
 * `-wal` or `-shm` sidefiles in `conversations/`, and NEVER opening `new Database(sourcePath)`.
 */
export function readAgyTrajectoryIdentityDetailed(input: {
  readonly appDataDir: string
  readonly nativeSessionId: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly schemaCatalogBudget?: AgySchemaCatalogBudget
  readonly walShrinkBudget?: AgyWalShrinkBudget
}): AgyTrajectoryIdentityResult {
  assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
  if (
    !isValidAgyTrajectoryId(input.nativeSessionId) ||
    input.nativeSessionId === 'conversation_summaries' ||
    !isAbsolute(input.appDataDir)
  ) {
    return { status: 'invalid' }
  }
  const configuredRoot = resolve(input.appDataDir)
  let dbObservedPresent = false

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let db: Database.Database | undefined
    try {
      assertIdentityNotCancelledOrExpired(input.signal, input.deadlineAt)
      const imageOutcome = withAgyReadImage(
        {
          rootDir: configuredRoot,
          parentSegments: ['conversations'],
          leafName: `${input.nativeSessionId}.db`,
        },
        {
          maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
          snapshotParentTempDir: resolveSnapshotParentTempDir(),
          ...(input.schemaCatalogBudget !== undefined
            ? { schemaCatalogBudget: input.schemaCatalogBudget }
            : {}),
          ...(input.walShrinkBudget !== undefined
            ? { walShrinkBudget: input.walShrinkBudget }
            : {}),
        },
        {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
          onLeafObserved: () => {
            dbObservedPresent = true
          },
        },
        (image) => {
          dbObservedPresent = true
          const fast = readFastIdentityFromCommittedImage(
            image,
            input.nativeSessionId,
            input.schemaCatalogBudget,
          )
          if (fast.kind === 'ok' || fast.kind === 'invalid') {
            return fast
          }
          const snapshot = image.materializePrivateSnapshot({
            maxSnapshotBytes: MAX_FALLBACK_SNAPSHOT_TOTAL_BYTES,
            snapshotParentTempDir: resolveSnapshotParentTempDir(),
            ...(input.schemaCatalogBudget !== undefined
              ? { schemaCatalogBudget: input.schemaCatalogBudget }
              : {}),
          })
          return { kind: 'materialized' as const, snapshot }
        },
      )

      if (imageOutcome.kind === 'ok') {
        return {
          status: 'ok',
          trajectoryId: imageOutcome.trajectoryId,
          stepCount: imageOutcome.stepCount,
        }
      }
      if (imageOutcome.kind === 'invalid') {
        return { status: 'invalid' }
      }

      const { snapshot } = imageOutcome
      try {
        db = snapshot.openReadOnlyDatabase()
      } catch (openError) {
        snapshot.cleanup()
        throw openError
      }
      const queried = queryBoundedIdentityFromOpenSqlite(
        db,
        input.nativeSessionId,
        snapshot.proof,
        {
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
          ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
          ...(input.schemaCatalogBudget?.maxItemSqlBytes !== undefined
            ? { maxTableDdlBytes: input.schemaCatalogBudget.maxItemSqlBytes }
            : {}),
        },
      )
      if (queried.kind === 'invalid') {
        return { status: 'invalid' }
      }
      return {
        status: 'ok',
        trajectoryId: queried.trajectoryId,
        stepCount: queried.stepCount,
      }
    } catch (error) {
      if (
        (typeof AgyNativeLoaderError === 'function' && error instanceof AgyNativeLoaderError) ||
        (error instanceof Error &&
          (error.name === 'AgyNativeLoaderError' ||
            Reflect.get(error, 'code') === 'EAGY_NATIVE_LOADER')) ||
        error instanceof AgyOperationalStorageError ||
        isOperationalFsError(error) ||
        isOperationalSqliteError(error) ||
        isIdentityAbortOrTimeoutError(error)
      ) {
        throw error
      }
      if (
        error instanceof AgyIdentityBudgetExceededError ||
        (error instanceof AgentExecutionError && error.kind === 'response_too_large')
      ) {
        return {
          status: 'budget_exceeded',
          reason: boundIdentityReason(error.message),
        }
      }
      if (error instanceof AgyStorageMissingError) {
        if (error.stage === 'root' || error.stage === 'parent') {
          return { status: 'no_storage_root' }
        }
        if (!dbObservedPresent) {
          return { status: 'missing' }
        }
        if (attempt < 2) continue
        return { status: 'transient_churn' }
      }
      if (error instanceof AgyInvalidSqliteImageError) {
        return { status: 'invalid' }
      }
      const isTransient =
        isTransientAgySnapshotChurn(error) ||
        isSqliteBusyOrLockedError(error) ||
        error instanceof AgyUnexpectedEofError
      const attemptTransientReason =
        isTransient && error instanceof AgyTransientIdentityChurnError ? error.reason : undefined
      if (isTransient) {
        if (attempt < 2) continue
        return {
          status: 'transient_churn',
          ...(attemptTransientReason !== undefined
            ? { reason: boundIdentityReason(attemptTransientReason) }
            : {}),
        }
      }
      return { status: 'invalid' }
    } finally {
      try {
        db?.close()
      } catch {
        /* Best-effort close on read-only staged snapshot. */
      }
    }
  }
  return { status: 'invalid' }
}

export function readAgyTrajectoryIdentity(input: {
  readonly appDataDir: string
  readonly nativeSessionId: string
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
}): { readonly trajectoryId: string; readonly stepCount: number } | undefined {
  const res = readAgyTrajectoryIdentityDetailed(input)
  return res.status === 'ok'
    ? { trajectoryId: res.trajectoryId, stepCount: res.stepCount }
    : undefined
}
