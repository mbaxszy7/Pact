import type Database from 'better-sqlite3'

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'

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
  private readonly plans = new Map<string, string[]>()
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
    if (Buffer.byteLength(source) > 8192) {
      this.planOverflow = true
      return
    }
    const key = createHash('sha256').update(source).digest('hex')
    if (this.plans.has(key)) return
    if (this.plans.size >= 64) {
      this.planOverflow = true
      return
    }
    try {
      const statement = prepare(`EXPLAIN QUERY PLAN ${source}`)
      const rows: unknown = Reflect.apply(statement.all.bind(statement), statement, args)
      if (!Array.isArray(rows) || rows.length > 64) {
        this.planOverflow = true
        return
      }
      const details: string[] = []
      let bytes = 64
      for (const row of rows) {
        const detail: unknown =
          row && typeof row === 'object' ? Reflect.get(row, 'detail') : undefined
        if (typeof detail !== 'string' || Buffer.byteLength(detail) > 512) {
          this.planOverflow = true
          return
        }
        details.push(detail)
        bytes += Buffer.byteLength(detail)
      }
      if (this.planBytes + bytes > 16 * 1024) {
        this.planOverflow = true
        return
      }
      this.planBytes += bytes
      this.plans.set(key, details)
    } catch {
      this.unsupportedOperations = true
    }
  }

  snapshot() {
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
        queryPlans: [...this.plans].map(([sqlSha256, details]) => ({ sqlSha256, details })),
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
  }
}
