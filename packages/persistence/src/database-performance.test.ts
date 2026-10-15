import { sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { sqliteFinalSchema, sqlitePlanPageSchema } from '@pact/contracts'

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
        retainedPlanBytes: before.retainedPlanBytes,
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

  it('keeps pages immutable until their exact ACK, then evicts only confirmed plans across more than 64 identities', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    const received: number[] = []
    try {
      for (let index = 0; index < 39; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      const first = sqlitePlanPageSchema.parse(
        db.performanceDiagnostics({})!.sqlite.planTransfer!.page,
      )
      received.push(...first.records.map((record) => record.recordSequence))
      for (let index = 39; index < 46; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      expect(db.performanceDiagnostics({})!.sqlite.planTransfer!.page).toEqual(first)
      const ack = {
        observerEpoch: first.observerEpoch,
        pageSequence: first.pageSequence,
        payloadDigest: first.payloadDigest,
      }
      const afterAck = db.performanceDiagnostics({ ack })!.sqlite.planTransfer!
      expect(afterAck.acknowledgedThrough).toBe(39)
      expect(afterAck.page!.firstRecordSequence).toBe(40)
      expect(db.performanceDiagnostics({ ack })!.sqlite.planTransfer).toEqual(afterAck)
      for (let index = 46; index < 90; index++)
        expect(db.drizzle.get(sql.raw(`SELECT ${index} AS value`))).toEqual({ value: index })
      const afterBurst = db.performanceDiagnostics()!.sqlite
      expect(afterBurst.planOverflow).toBe(false)
      expect(afterBurst.firstPlanFailure).toBeUndefined()
      expect(afterBurst.queryPlans.length).toBeLessThanOrEqual(64)
      expect(afterBurst.retainedPlanBytes + 1024).toBeLessThanOrEqual(16 * 1024)
      const second = sqlitePlanPageSchema.parse(afterAck.page)
      received.push(...second.records.map((record) => record.recordSequence))
      const third = db.performanceDiagnostics({
        ack: {
          observerEpoch: second.observerEpoch,
          pageSequence: second.pageSequence,
          payloadDigest: second.payloadDigest,
        },
      })!.sqlite.planTransfer!.page!
      received.push(...third.records.map((record) => record.recordSequence))
      expect(third.lastRecordSequence).toBe(90)
      // Lost reply recovery reads the confirmed prefix without releasing this next page.
      expect(db.performanceDiagnostics({})!.sqlite.planTransfer!.acknowledgedThrough).toBe(
        second.lastRecordSequence,
      )
      expect(received).toEqual(Array.from({ length: 90 }, (_, index) => index + 1))
      db.close()
      const final = sqliteFinalSchema.parse(db.performanceFinal())
      expect(final.databaseClosed && final.writerClosed && final.collectionDisposed).toBe(true)
      expect(final.acknowledgedThrough).toBe(second.lastRecordSequence)
      expect(final.tailRecords).toEqual(third.records)
      expect(final.recordWatermark).toBe(90)
    } finally {
      db.close()
    }
  })

  it('rejects another epoch or digest atomically, retains cancellation ownership, and preserves failures after ACK', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    const other = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      expect(db.drizzle.get(sql`SELECT 1 AS value`)).toEqual({ value: 1 })
      expect(other.drizzle.get(sql`SELECT 1 AS value`)).toEqual({ value: 1 })
      const page = db.performanceDiagnostics({})!.sqlite.planTransfer!.page!
      const otherPage = other.performanceDiagnostics({})!.sqlite.planTransfer!.page!
      expect(() =>
        db.performanceDiagnostics({
          ack: {
            observerEpoch: otherPage.observerEpoch,
            pageSequence: page.pageSequence,
            payloadDigest: page.payloadDigest,
          },
        }),
      ).toThrow('epoch mismatch')
      expect(() =>
        db.performanceDiagnostics({
          ack: {
            observerEpoch: page.observerEpoch,
            pageSequence: page.pageSequence,
            payloadDigest: '0'.repeat(64),
          },
        }),
      ).toThrow('acknowledgement mismatch')
      expect(db.performanceDiagnostics({})!.sqlite.planTransfer!.page).toEqual(page)
      const clone = db.performanceDiagnostics({})!.sqlite.planTransfer!.page!
      clone.records[0]!.details.push('untrusted mutation')
      expect(db.performanceDiagnostics({})!.sqlite.planTransfer!.page).toEqual(page)
      expect(() => db.drizzle.get(sql.raw('SELECT ? AS value'))).toThrow('Too few parameter values')
      const failure = db.performanceDiagnostics()!.sqlite.firstPlanFailure
      db.performanceDiagnostics({
        ack: {
          observerEpoch: page.observerEpoch,
          pageSequence: page.pageSequence,
          payloadDigest: page.payloadDigest,
        },
      })
      expect(db.performanceDiagnostics()!.sqlite.firstPlanFailure).toEqual(failure)
      expect(db.performanceDiagnostics()!.sqlite.unsupportedOperations).toBe(true)
      db.close()
      const final = sqliteFinalSchema.parse(db.performanceFinal())
      expect(final.counters.firstPlanFailure).toEqual(failure)
      expect(final.counters.unsupportedOperations).toBe(true)
      expect(final.tailRecords).toHaveLength(0)
      expect(() => db.performanceDiagnostics({})).toThrow('sealed')
    } finally {
      db.close()
      other.close()
    }
  })

  it('does not treat the same SQL after a schema change as an old confirmed plan', async () => {
    const db = await PactDatabase.open({
      filePath: ':memory:',
      migrationsFolder,
      measurePerformance: true,
    })
    try {
      db.drizzle.run(sql.raw('CREATE TABLE plan_schema_fixture (value INTEGER)'))
      expect(db.drizzle.all(sql.raw('SELECT * FROM plan_schema_fixture WHERE value = 1'))).toEqual(
        [],
      )
      const first = db.performanceDiagnostics({})!.sqlite.planTransfer!.page!
      db.performanceDiagnostics({
        ack: {
          observerEpoch: first.observerEpoch,
          pageSequence: first.pageSequence,
          payloadDigest: first.payloadDigest,
        },
      })
      db.drizzle.run(
        sql.raw('CREATE INDEX plan_schema_fixture_value ON plan_schema_fixture(value)'),
      )
      expect(db.drizzle.all(sql.raw('SELECT * FROM plan_schema_fixture WHERE value = 1'))).toEqual(
        [],
      )
      const next = db.performanceDiagnostics({})!.sqlite.planTransfer!.page!
      expect(next.records[0]!.sqlSha256).toBe(first.records[0]!.sqlSha256)
      expect(next.records[0]!.schemaVersion).toBeGreaterThan(first.records[0]!.schemaVersion)
      expect(next.records[0]!.details.join(' ')).toContain('plan_schema_fixture_value')
      expect(next.records[0]!.recordSequence).toBe(2)
    } finally {
      db.close()
    }
  })
})
