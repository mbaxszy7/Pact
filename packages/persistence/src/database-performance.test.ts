import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { PactDatabase } from './pact-database.js'

const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
describe('isolated database performance observations', () => {
  it('preserves real transaction and read outcomes while withholding SQL and bindings', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      db.drizzle.transaction((tx) => {
        tx.run(
          sql`INSERT INTO pact_schema_meta(key,value) VALUES ('performance-fixture','private-fixture-body')`,
        )
      })
      expect(
        db.drizzle.get(
          sql`SELECT value FROM pact_schema_meta WHERE key = ${'performance-fixture'}`,
        ),
      ).toEqual({ value: 'private-fixture-body' })
      const observed = db.performanceDiagnostics()!
      expect(observed.sqlite.operations).toBeGreaterThan(0)
      expect(observed.sqlite.transactions).toBe(1)
      expect(observed.sqlite.rowsReturned).toBeGreaterThan(0)
      expect(observed.sqlite.totalMs).toBeGreaterThanOrEqual(observed.sqlite.maxMs)
      expect(observed.sqlite.queryPlans.length).toBeGreaterThan(0)
      expect(observed.sqlite.planOverflow).toBe(false)
      expect(observed.sqlite.firstPlanFailure).toBeUndefined()
      expect(JSON.stringify(observed)).not.toContain('private-fixture-body')
      expect(JSON.stringify(observed)).not.toContain('SELECT value')
    } finally {
      db.close()
    }
    expect(db.isHealthy()).toBe(false)
    expect(db.performanceDiagnostics()!.sqlite.queryPlans).toHaveLength(0)
  })

  it('marks exhausted plan capacity without changing or truncating business results', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      for (let index = 0; index < 64; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      const source = 'SELECT 64 AS value'
      const before = db.performanceDiagnostics()!.sqlite
      expect(db.drizzle.get(sql.raw(source))).toEqual({ value: 64 })
      const observed = db.performanceDiagnostics()!
      expect(observed.sqlite.queryPlans).toHaveLength(64)
      expect(observed.sqlite.planOverflow).toBe(true)
      expect(observed.sqlite.firstPlanFailure).toEqual({
        reason: 'plan-capacity',
        sqlSha256: createHash('sha256').update(source).digest('hex'),
        sourceBytes: Buffer.byteLength(source),
        operationIndex: before.operations + 1,
        retainedPlans: 64,
        retainedPlanBytes: before.queryPlans.reduce(
          (bytes, plan) =>
            bytes + 64 + plan.details.reduce((sum, detail) => sum + Buffer.byteLength(detail), 0),
          0,
        ),
        planRows: null,
      })
      const firstFailure = { ...observed.sqlite.firstPlanFailure! }
      for (let index = 65; index < 70; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      expect(db.drizzle.get(sql`SELECT 999 AS value`)).toEqual({ value: 999 })
      expect(
        db.drizzle.get(sql.raw(`SELECT 1 AS value /* ${'private-sql'.repeat(1000)} */`)),
      ).toEqual({ value: 1 })
      expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure).toEqual(firstFailure)
      observed.sqlite.firstPlanFailure!.reason = 'explain-failed'
      expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure).toEqual(firstFailure)
    } finally {
      db.close()
    }
    expect(db.performanceDiagnostics()!.sqlite.queryPlans).toHaveLength(0)
    expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure?.reason).toBe('plan-capacity')
    expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure?.retainedPlans).toBe(64)
    expect(db.performanceDiagnostics()!.sqlite.planOverflow).toBe(true)
  })

  it('records overlong source only as a byte count without hashing or exporting it', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      const source = `SELECT 7 AS value /* ${'private-sql-body'.repeat(600)} */`
      const before = db.performanceDiagnostics()!.sqlite
      expect(db.drizzle.get(sql.raw(source))).toEqual({ value: 7 })
      const observed = db.performanceDiagnostics()!
      expect(observed.sqlite.firstPlanFailure).toEqual({
        reason: 'statement-bytes',
        sqlSha256: null,
        sourceBytes: Buffer.byteLength(source),
        operationIndex: before.operations + 1,
        retainedPlans: 0,
        retainedPlanBytes: 0,
        planRows: null,
      })
      expect(observed.sqlite.planOverflow).toBe(true)
      expect(observed.sqlite.unsupportedOperations).toBe(false)
      expect(JSON.stringify(observed)).not.toContain('private-sql-body')
      expect(JSON.stringify(observed)).not.toContain('SELECT 7')
      expect(JSON.stringify(observed)).not.toContain(
        createHash('sha256').update(source).digest('hex'),
      )
    } finally {
      db.close()
    }
  })

  it('keeps the original failed query exception and reports unsupported explain separately', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      const source = 'SELECT ? AS value'
      const before = db.performanceDiagnostics()!.sqlite
      expect(() => db.drizzle.get(sql.raw(source))).toThrow('Too few parameter values')
      const observed = db.performanceDiagnostics()!.sqlite
      expect(observed.firstPlanFailure).toEqual({
        reason: 'explain-failed',
        sqlSha256: createHash('sha256').update(source).digest('hex'),
        sourceBytes: Buffer.byteLength(source),
        operationIndex: before.operations + 1,
        retainedPlans: 0,
        retainedPlanBytes: 0,
        planRows: null,
      })
      expect(observed.unsupportedOperations).toBe(true)
      expect(observed.planOverflow).toBe(false)
      expect(db.drizzle.get(sql`SELECT 17 AS value`)).toEqual({ value: 17 })
      expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure).toEqual(
        observed.firstPlanFailure,
      )
    } finally {
      db.close()
    }
  })

  it('records real explain row overflow without changing the complete query result', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      const source = Array.from({ length: 40 }, (_, index) => `SELECT ${index} AS value`).join(
        ' UNION ALL ',
      )
      expect(db.drizzle.all(sql.raw(source))).toEqual(
        Array.from({ length: 40 }, (_, value) => ({ value })),
      )
      const observed = db.performanceDiagnostics()!.sqlite
      expect(observed.firstPlanFailure?.reason).toBe('plan-rows')
      expect(observed.firstPlanFailure?.planRows).toBeGreaterThan(64)
      expect(observed.firstPlanFailure?.sqlSha256).toBe(
        createHash('sha256').update(source).digest('hex'),
      )
      expect(observed.planOverflow).toBe(true)
      expect(observed.unsupportedOperations).toBe(false)
      expect(observed.queryPlans).toHaveLength(0)
    } finally {
      db.close()
    }
  })

  it('records overlong real plan details without exporting an oversized alias', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      const alias = 'private_plan_alias'.repeat(32)
      const source = `SELECT value FROM (SELECT 1 AS value) AS "${alias}"`
      expect(db.drizzle.get(sql.raw(source))).toEqual({ value: 1 })
      const observed = db.performanceDiagnostics()!.sqlite
      expect(observed.firstPlanFailure?.reason).toBe('plan-detail')
      expect(observed.firstPlanFailure?.planRows).toBeGreaterThan(0)
      expect(observed.planOverflow).toBe(true)
      expect(observed.unsupportedOperations).toBe(false)
      expect(observed.queryPlans).toHaveLength(0)
      expect(JSON.stringify(observed)).not.toContain(alias)
    } finally {
      db.close()
    }
  })

  it('records exhausted retained plan bytes without raising the entry or detail budgets', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      for (
        let index = 0;
        index < 64 && !db.performanceDiagnostics()!.sqlite.firstPlanFailure;
        index++
      ) {
        const alias = `fixture_alias_${index}_${'x'.repeat(350)}`
        expect(
          db.drizzle.get(sql.raw(`SELECT value FROM (SELECT 1 AS value) AS "${alias}"`)),
        ).toEqual({ value: 1 })
      }
      const observed = db.performanceDiagnostics()!.sqlite
      expect(observed.firstPlanFailure?.reason).toBe('plan-bytes')
      expect(observed.firstPlanFailure?.retainedPlans).toBeLessThan(64)
      expect(observed.firstPlanFailure?.retainedPlanBytes).toBeLessThanOrEqual(16384)
      expect(observed.firstPlanFailure?.planRows).toBeGreaterThan(0)
      expect(observed.planOverflow).toBe(true)
      expect(observed.unsupportedOperations).toBe(false)
      expect(
        observed.queryPlans.every((plan) =>
          plan.details.every((detail) => Buffer.byteLength(detail) <= 512),
        ),
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('adds no observation owner to ordinary application connections', async () => {
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      expect(
        db.drizzle.get(sql.raw(`SELECT 3 AS value /* ${'unobserved-sql'.repeat(1000)} */`)),
      ).toEqual({ value: 3 })
      expect(db.performanceDiagnostics()).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
