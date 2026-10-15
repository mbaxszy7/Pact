import type Database from 'better-sqlite3'

import { createHash, randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'

import type {
  RuntimeHealth,
  SqlitePlanRecord,
  SqlitePlanPage,
  SqlitePlanReadInput,
  SqliteFinal,
} from '@pact/contracts'

type FirstPlanFailure = NonNullable<
  NonNullable<RuntimeHealth['performance']>['sqlite']['firstPlanFailure']
>
type PlanEntry = SqlitePlanRecord & { bytes: number; acknowledged: boolean; lastAccess: number }
type FrozenPage = Omit<SqlitePlanPage, 'records'>

/** Opt-in isolated measurements: no SQL text, bindings or database contents leave this owner. */
export class DatabasePerformance {
  private operations = 0
  private transactions = 0
  private rowsReturned = 0
  private totalMs = 0
  private maxMs = 0
  private planBytes = 0
  private planOverflow = false
  private unsupportedOperations = false
  private firstPlanFailure: FirstPlanFailure | undefined
  private readonly plans = new Map<string, PlanEntry>()
  private readonly observerEpoch = randomUUID()
  private recordWatermark = 0
  private acknowledgedThrough = 0
  private pageSequence = 0
  private highWaterPlanBytes = 1024
  private highWaterPlans = 0
  private unacknowledgedHighWaterPlans = 0
  private page: FrozenPage | undefined
  private lastAck: NonNullable<SqlitePlanReadInput['ack']> | undefined
  private final: SqliteFinal | undefined
  private schemaVersionStatement: Database.Statement | undefined
  // One current page descriptor and one ACK receipt share this reservation with
  // the sole cache; no second pending/in-flight plan dictionary is admitted.
  private readonly metadataReservation = 1024
  private readonly originalPrepare: Database.Database['prepare']
  private readonly originalTransaction: import('./drizzle-database.js').PactDrizzleDatabase['transaction']

  constructor(
    private readonly sqlite: Database.Database,
    database: import('./drizzle-database.js').PactDrizzleDatabase,
    private readonly filePath: string,
  ) {
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the exact method for restoration on its original SQLite owner.
    this.originalPrepare = sqlite.prepare
    const prepare = sqlite.prepare.bind(sqlite)
    this.schemaVersionStatement = prepare('PRAGMA schema_version')
    Object.defineProperty(sqlite, 'prepare', {
      configurable: true,
      writable: true,
      value: (source: string) => {
        const statement = prepare(source)
        for (const name of ['run', 'get', 'all'] as const) {
          const original = statement[name].bind(statement)
          Object.defineProperty(statement, name, {
            configurable: true,
            writable: true,
            value: (...args: unknown[]): unknown => {
              const start = performance.now()
              let result: unknown
              try {
                result = Reflect.apply(original, statement, args)
                return result
              } finally {
                const elapsed = performance.now() - start
                this.operations++
                this.totalMs += elapsed
                this.maxMs = Math.max(this.maxMs, elapsed)
                this.rowsReturned +=
                  name === 'all' && Array.isArray(result)
                    ? result.length
                    : name === 'get' && result !== undefined
                      ? 1
                      : 0
                if (/^\s*(SELECT|WITH)\b/iu.test(source)) this.observePlan(source, args, prepare)
              }
            },
          })
        }
        // Iterator consumption and pre-bound parameters have different lifetimes; never invent timings.
        for (const name of ['iterate', 'bind'] as const) {
          const original = statement[name].bind(statement)
          Object.defineProperty(statement, name, {
            configurable: true,
            writable: true,
            value: (...args: unknown[]): unknown => {
              this.unsupportedOperations = true
              return Reflect.apply(original, statement, args)
            },
          })
        }
        return statement
      },
    })
    // oxlint-disable-next-line typescript/unbound-method -- Restore this exact method on the same Drizzle owner when disposing.
    this.originalTransaction = database.transaction
    const transact = database.transaction.bind(database)
    database.transaction = (work, config) => {
      this.transactions++
      return transact(work, config)
    }
  }

  private observePlan(
    source: string,
    args: unknown[],
    prepare: Database.Database['prepare'],
  ): void {
    const sourceBytes = Buffer.byteLength(source)
    if (sourceBytes > 8192) {
      this.planOverflow = true
      this.recordFirstPlanFailure('statement-bytes', sourceBytes, null, null)
      return
    }
    const key = createHash('sha256').update(source).digest('hex')
    let schemaRow: unknown
    try {
      schemaRow = this.schemaVersionStatement?.get()
    } catch {
      this.unsupportedOperations = true
      this.recordFirstPlanFailure('explain-failed', sourceBytes, key, null)
      return
    }
    const schemaVersion: unknown =
      schemaRow && typeof schemaRow === 'object'
        ? Reflect.get(schemaRow, 'schema_version')
        : undefined
    if (
      typeof schemaVersion !== 'number' ||
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 0
    ) {
      this.unsupportedOperations = true
      this.recordFirstPlanFailure('explain-failed', sourceBytes, key, null)
      return
    }
    const cacheKey = `${schemaVersion}:${key}`
    const cached = this.plans.get(cacheKey)
    if (cached) {
      cached.lastAccess = this.operations
      return
    }
    if (!this.makeRoom(0, true)) {
      this.planOverflow = true
      this.recordFirstPlanFailure('plan-capacity', sourceBytes, key, null)
      return
    }
    let planRows: number | null = null
    try {
      const statement = prepare(`EXPLAIN QUERY PLAN ${source}`)
      const rows: unknown = Reflect.apply(statement.all.bind(statement), statement, args)
      if (Array.isArray(rows)) planRows = rows.length
      if (!Array.isArray(rows) || rows.length > 64) {
        this.planOverflow = true
        this.recordFirstPlanFailure('plan-rows', sourceBytes, key, planRows)
        return
      }
      const details: string[] = []
      for (const row of rows) {
        const detail: unknown =
          row && typeof row === 'object' ? Reflect.get(row, 'detail') : undefined
        if (typeof detail !== 'string' || Buffer.byteLength(detail) > 512) {
          this.planOverflow = true
          this.recordFirstPlanFailure('plan-detail', sourceBytes, key, planRows)
          return
        }
        details.push(detail)
      }
      const record: SqlitePlanRecord = {
        recordSequence: this.recordWatermark + 1,
        schemaVersion,
        sqlSha256: key,
        details,
      }
      // Include JSON escaping and per-entry confirmation/LRU bookkeeping.
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 32
      if (!this.makeRoom(bytes, true)) {
        this.planOverflow = true
        this.recordFirstPlanFailure('plan-bytes', sourceBytes, key, planRows)
        return
      }
      this.planBytes += bytes
      this.recordWatermark++
      this.plans.set(cacheKey, {
        ...record,
        bytes,
        acknowledged: false,
        lastAccess: this.operations,
      })
      this.highWaterPlanBytes = Math.max(
        this.highWaterPlanBytes,
        this.planBytes + this.metadataReservation,
      )
      this.highWaterPlans = Math.max(this.highWaterPlans, this.plans.size)
      this.unacknowledgedHighWaterPlans = Math.max(
        this.unacknowledgedHighWaterPlans,
        [...this.plans.values()].filter((entry) => !entry.acknowledged).length,
      )
    } catch {
      this.unsupportedOperations = true
      this.recordFirstPlanFailure('explain-failed', sourceBytes, key, planRows)
    }
  }

  private makeRoom(bytes: number, entry: boolean): boolean {
    while (
      this.plans.size + (entry ? 1 : 0) > 64 ||
      this.planBytes + bytes + this.metadataReservation > 16 * 1024
    ) {
      let oldest: [string, PlanEntry] | undefined
      for (const item of this.plans)
        if (item[1].acknowledged && (!oldest || item[1].lastAccess < oldest[1].lastAccess))
          oldest = item
      if (!oldest) return false
      this.planBytes -= oldest[1].bytes
      this.plans.delete(oldest[0])
    }
    return true
  }

  private records(through = this.recordWatermark): SqlitePlanRecord[] {
    return [...this.plans.values()]
      .filter((entry) => !entry.acknowledged && entry.recordSequence <= through)
      .map(({ recordSequence, schemaVersion, sqlSha256, details }) => ({
        recordSequence,
        schemaVersion,
        sqlSha256,
        details: [...details],
      }))
  }

  private transfer(input: SqlitePlanReadInput) {
    if (this.final) throw new Error('SQLite observations are sealed')
    const ack = input.ack
    if (ack) {
      if (ack.observerEpoch !== this.observerEpoch)
        throw new Error('SQLite observation epoch mismatch')
      const previous = this.lastAck
      if (
        !(
          previous &&
          previous.pageSequence === ack.pageSequence &&
          previous.payloadDigest === ack.payloadDigest
        )
      ) {
        if (
          !this.page ||
          this.page.pageSequence !== ack.pageSequence ||
          this.page.payloadDigest !== ack.payloadDigest
        )
          throw new Error('SQLite observation acknowledgement mismatch')
        for (const entry of this.plans.values())
          if (entry.recordSequence <= this.page.lastRecordSequence) entry.acknowledged = true
        this.acknowledgedThrough = this.page.lastRecordSequence
        this.lastAck = { ...ack }
        this.page = undefined
      }
    }
    if (!this.page) {
      const records = this.records()
      if (records.length) {
        const metadata = {
          observerEpoch: this.observerEpoch,
          pageSequence: ++this.pageSequence,
          firstRecordSequence: records[0]!.recordSequence,
          lastRecordSequence: records.at(-1)!.recordSequence,
          operationWatermark: this.operations,
          recordWatermark: this.recordWatermark,
        }
        const payloadDigest = createHash('sha256')
          .update(JSON.stringify({ ...metadata, records }))
          .digest('hex')
        this.page = { ...metadata, payloadDigest }
      }
    }
    return {
      observerEpoch: this.observerEpoch,
      recordWatermark: this.recordWatermark,
      acknowledgedThrough: this.acknowledgedThrough,
      ...(this.lastAck ? { lastAck: { ...this.lastAck } } : {}),
      ...(this.page
        ? { page: { ...this.page, records: this.records(this.page.lastRecordSequence) } }
        : {}),
    }
  }

  private recordFirstPlanFailure(
    reason: FirstPlanFailure['reason'],
    sourceBytes: number,
    sqlSha256: string | null,
    planRows: number | null,
  ): void {
    if (this.firstPlanFailure) return
    this.firstPlanFailure = {
      reason,
      sqlSha256,
      sourceBytes,
      operationIndex: this.operations,
      retainedPlans: this.plans.size,
      retainedPlanBytes: this.planBytes,
      planRows,
    }
  }

  snapshot(input?: SqlitePlanReadInput) {
    const planTransfer = input ? this.transfer(input) : undefined
    let databaseBytes: number | undefined, walBytes: number | undefined
    if (this.filePath !== ':memory:') {
      try {
        databaseBytes = statSync(this.filePath).size
      } catch {
        /* Missing storage is not zero usage. */
      }
      try {
        walBytes = statSync(`${this.filePath}-wal`).size
      } catch (error) {
        if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT')
          walBytes = 0
      }
    }
    return {
      databaseBytes,
      walBytes,
      sqlite: {
        operations: this.operations,
        transactions: this.transactions,
        rowsReturned: this.rowsReturned,
        totalMs: this.totalMs,
        maxMs: this.maxMs,
        planOverflow: this.planOverflow,
        unsupportedOperations: this.unsupportedOperations,
        firstPlanFailure: this.firstPlanFailure && { ...this.firstPlanFailure },
        retainedPlanBytes: this.planBytes,
        highWaterPlanBytes: this.highWaterPlanBytes,
        highWaterPlans: this.highWaterPlans,
        unacknowledgedHighWaterPlans: this.unacknowledgedHighWaterPlans,
        unacknowledgedPlans: [...this.plans.values()].filter((entry) => !entry.acknowledged).length,
        recordWatermark: this.recordWatermark,
        ...(planTransfer ? { planTransfer } : {}),
        queryPlans: [...this.plans.values()].map(({ sqlSha256, details }) => ({
          sqlSha256,
          details: [...details],
        })),
      },
    }
  }

  dispose(database: import('./drizzle-database.js').PactDrizzleDatabase): void {
    Object.defineProperty(this.sqlite, 'prepare', {
      configurable: true,
      writable: true,
      value: this.originalPrepare,
    })
    database.transaction = this.originalTransaction
    this.plans.clear()
    this.planBytes = 0
    this.page = undefined
  }

  seal(
    database: import('./drizzle-database.js').PactDrizzleDatabase,
    databaseClosed: boolean,
    writerClosed: boolean,
  ): SqliteFinal {
    if (this.final) return this.final
    const { queryPlans: _plans, planTransfer: _transfer, ...counters } = this.snapshot().sqlite
    const tailRecords = this.records()
    this.dispose(database)
    if (databaseClosed) this.schemaVersionStatement = undefined
    this.final = {
      schemaVersion: 1,
      scope: 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1',
      observerEpoch: this.observerEpoch,
      observerPid: process.pid,
      recordWatermark: this.recordWatermark,
      acknowledgedThrough: this.acknowledgedThrough,
      pageSequence: this.pageSequence,
      ...(this.lastAck ? { lastAck: { ...this.lastAck } } : {}),
      tailRecords,
      counters: { ...counters, retainedPlanBytes: 0, unacknowledgedPlans: 0 },
      databaseClosed,
      writerClosed,
      collectionDisposed: true,
    }
    return this.final
  }

  sealedReceipt(): SqliteFinal | undefined {
    return this.final && structuredClone(this.final)
  }
}
