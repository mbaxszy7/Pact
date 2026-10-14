import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  histogram,
  observe,
  percentile,
  evaluateSoak,
  validateReceipt,
  resourceReportProjection,
} from './soak-statistics.mjs'

void test('two-hour resource samples preserve exact plans and counters inside the report byte bound', () => {
  const projection = resourceReportProjection()
  const plans = Array.from({ length: 64 }, (_, index) => ({
    sqlSha256: index.toString(16).padStart(64, '0'),
    details: ['SEARCH owned_fixture USING INDEX owned_fixture_id ' + 'x'.repeat(150)],
  }))
  const samples = Array.from({ length: 240 }, (_, index) =>
    projection.project({
      eventLoopLagP95Ms: 12,
      sqlite: { operations: index, planOverflow: false, queryPlans: plans },
    }),
  )
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.sqlite.operations, index)
    assert.deepEqual(
      sample.sqlite.queryPlanIndices.map((id) => projection.queryPlans[id]),
      plans,
    )
  }
  assert.equal(projection.queryPlans.length, 64)
  assert(
    Buffer.byteLength(
      JSON.stringify({ samples, sqliteQueryPlanDictionary: projection.queryPlans }),
    ) <
      768 * 1024,
  )
  assert.throws(
    () =>
      projection.project({
        sqlite: { queryPlans: [{ sqlSha256: 'f'.repeat(64), details: ['different'] }] },
      }),
    /dictionary/,
  )
  assert.throws(
    () =>
      resourceReportProjection().project({
        sqlite: { queryPlans: [{ sqlSha256: 'bad', details: [] }] },
      }),
    /Invalid/,
  )
  assert.equal(resourceReportProjection().project(undefined), undefined)
})

void test('bounded histograms retain percentile tails instead of replacing missing observations with zero', () => {
  const values = histogram()
  assert.equal(percentile(values, 95), null)
  for (let index = 0; index < 95; index++) observe(values, 49.2)
  for (let index = 0; index < 5; index++) observe(values, 101)
  assert.equal(percentile(values, 95), 50)
  assert.equal(percentile(values, 99), 101)
  assert.throws(() => observe(values, NaN))
})

void test('missing performance/lifecycle evidence cannot satisfy the budget gate', () => {
  const result = evaluateSoak(
    {
      durationMs: 7_200_000,
      cleanupVerified: true,
      resourceLifecycleVerified: false,
      missingObservations: ['retained-listeners'],
    },
    7_200_000,
  )
  assert.equal(result.budgetPass, false)
  assert(result.unmetBudgets.includes('utility-event-loop-p95-50ms'))
  assert(result.unmetBudgets.includes('unobserved:retained-listeners'))
  assert(result.unmetBudgets.includes('complete-owned-resource-lifecycle'))
})

void test('continuous two-hour duration is actual elapsed evidence, not an E2E timeout', () => {
  const input = histogram(),
    eventLoop = histogram(),
    terminal = histogram()
  for (let index = 0; index < 100; index++) {
    observe(input, 25)
    observe(eventLoop, 5)
    observe(terminal, 40)
  }
  const evidence = {
    durationMs: 7_200_000,
    retainedMessages: 1000,
    inputPaint: input,
    rendererEventLoop: eventLoop,
    terminalEnable: terminal,
    utilityEventLoopLagP95Ms: 10,
    sustainedLongTasks: 0,
    unexplainedLongTasksOver200Ms: 0,
    cleanupVerified: true,
    recoveryVerified: true,
    resourceLifecycleVerified: true,
    missingObservations: [],
  }
  assert.equal(evaluateSoak(evidence, 7_200_000).budgetPass, true)
  assert.equal(evaluateSoak({ ...evidence, durationMs: 7_199_999 }, 7_200_000).budgetPass, false)
  assert.equal(evaluateSoak(evidence, 1000).budgetPass, false)
})

void test('CDP receipts bind a private nonce to exact Main PID, renderer target and packaged content identity', () => {
  const manifest = {
    sourceSha: 'a'.repeat(40),
    version: '0.1.0',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
  }
  const receipt = {
    schemaVersion: 1,
    nonce: 'b'.repeat(64),
    mainPid: 100,
    port: 32100,
    windowId: 1,
    webContentsId: 1,
    targetId: 'c'.repeat(32),
    url: 'app://bundle/index.html',
    ...manifest,
  }
  const expected = { nonce: receipt.nonce, mainPid: 100, port: 32100, manifest }
  validateReceipt(receipt, expected)
  for (const change of [
    { nonce: 'd'.repeat(64) },
    { mainPid: 101 },
    { targetId: '' },
    { sourceSha: 'd'.repeat(40) },
    { url: 'https://example.invalid' },
  ])
    assert.throws(() => validateReceipt({ ...receipt, ...change }, expected))
})
