import { sql } from 'drizzle-orm'
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
      for (let index = 0; index < 70; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      const observed = db.performanceDiagnostics()!
      expect(observed.sqlite.queryPlans.length).toBeLessThanOrEqual(64)
      expect(observed.sqlite.planOverflow).toBe(true)
      expect(db.drizzle.get(sql`SELECT 999 AS value`)).toEqual({ value: 999 })
    } finally {
      db.close()
    }
  })

  it('adds no observation owner to ordinary application connections', async () => {
    const db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder })
    try {
      expect(db.performanceDiagnostics()).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
