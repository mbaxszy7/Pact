import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  checkArchitectureBudgets,
  countLines,
  LEGACY_FILE_LINE_RATCHET,
  MAX_PRODUCTION_FILE_LINES,
} from './check-architecture-budgets.mjs'
import pactPlugin from './oxlint-pact-plugin.mjs'

void test('countLines handles empty, LF-terminated, and non-terminated strings', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a\n'), 1)
  assert.equal(countLines('a\nb'), 2)
  assert.equal(countLines('a\nb\n'), 2)
})

void test('checkArchitectureBudgets passes on current repository', () => {
  const result = checkArchitectureBudgets()
  assert.equal(result.problems.length, 0, result.problems.join('\n'))
  assert.ok(result.checkedFiles > 0)
})

void test('checkArchitectureBudgets rejects new files exceeding MAX_PRODUCTION_FILE_LINES', () => {
  const root = mkdtempSync(join(tmpdir(), 'pact-arch-budget-'))
  try {
    mkdirSync(join(root, 'apps'), { recursive: true })
    mkdirSync(join(root, 'packages'), { recursive: true })
    const oversized = 'const x = 1\n'.repeat(MAX_PRODUCTION_FILE_LINES + 5)
    writeFileSync(join(root, 'packages', 'too-big.ts'), oversized)
    const result = checkArchitectureBudgets(root)
    assert.ok(
      result.problems.some((problem) => problem.includes('packages/too-big.ts')),
      `Expected packages/too-big.ts violation, got: ${result.problems.join('\n')}`,
    )
    assert.equal(
      result.problems.filter((problem) => problem.includes('no longer exists')).length,
      Object.keys(LEGACY_FILE_LINE_RATCHET).length,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

void test('oxlint pact plugin reports async transaction callbacks and deterministic timer waits', () => {
  const reports = []
  const asyncRule = pactPlugin.rules['no-async-transaction-callback'].create({
    report: (item) => reports.push(item),
  })
  asyncRule.CallExpression({
    callee: {
      type: 'MemberExpression',
      computed: false,
      property: { type: 'Identifier', name: 'transaction' },
    },
    arguments: [{ type: 'ArrowFunctionExpression', async: true }],
  })
  asyncRule.CallExpression({
    callee: {
      type: 'MemberExpression',
      computed: false,
      property: { type: 'Identifier', name: 'transaction' },
    },
    arguments: [{ type: 'ArrowFunctionExpression', async: false }],
  })
  assert.equal(reports.length, 1)

  const timerReports = []
  const timerRule = pactPlugin.rules['no-real-time-wait-in-deterministic-tests'].create({
    report: (item) => timerReports.push(item),
  })
  timerRule.CallExpression({ callee: { type: 'Identifier', name: 'setTimeout' } })
  timerRule.CallExpression({ callee: { type: 'Identifier', name: 'queueMicrotask' } })
  assert.equal(timerReports.length, 1)
})
