import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveRealConfiguredModel } from '../tests/e2e/real-model-selection.ts'

const option = (id, resolvedModel = 'actual-wire', efforts = ['low', 'high']) => ({
  id,
  resolvedModel,
  displayName: id,
  supportedEfforts: efforts,
})
const catalog = (models) => ({
  agentId: 'claude',
  status: 'available',
  models,
  checkedAt: new Date().toISOString(),
})

await test('exact native ID wins without changing existing payloads', () => {
  const exact = { id: 'actual-wire', displayName: 'Configured', supportedEfforts: ['low'] }
  assert.equal(resolveRealConfiguredModel(catalog([option('alias'), exact]), 'actual-wire'), exact)
})
await test('equivalent aliases use stable native identity independent of list order', () => {
  const haiku = option('haiku'),
    opus = option('opus'),
    sonnet = option('sonnet')
  assert.equal(resolveRealConfiguredModel(catalog([opus, sonnet, haiku]), 'actual-wire'), haiku)
  assert.equal(resolveRealConfiguredModel(catalog([haiku, sonnet, opus]), 'actual-wire'), haiku)
  assert.equal(
    resolveRealConfiguredModel(catalog([haiku, sonnet, opus]), 'actual-wire', 'sonnet'),
    sonnet,
  )
})
await test('effort ordering does not create a false alias conflict', () => {
  assert.equal(
    resolveRealConfiguredModel(
      catalog([option('b'), option('a', 'actual-wire', ['high', 'low'])]),
      'actual-wire',
    ).id,
    'a',
  )
})
await test('missing and decorated wire identities cannot stand in for the configuration', () => {
  for (const model of [
    option('haiku', 'actual-wire[1m]'),
    { id: 'haiku', displayName: 'Haiku', supportedEfforts: ['low'] },
  ])
    assert.throws(() => resolveRealConfiguredModel(catalog([model]), 'actual-wire'), /absent/u)
})
await test('conflicting aliases fail instead of choosing another effort policy', () => {
  assert.throws(
    () =>
      resolveRealConfiguredModel(
        catalog([option('a'), option('b', 'actual-wire', ['high'])]),
        'actual-wire',
      ),
    /conflicting/u,
  )
  assert.throws(
    () =>
      resolveRealConfiguredModel(
        catalog([option('a'), { ...option('b'), defaultEffort: 'high' }]),
        'actual-wire',
      ),
    /conflicting/u,
  )
})
await test('duplicate native IDs and unavailable catalogs cannot authorize a selection', () => {
  assert.throws(
    () => resolveRealConfiguredModel(catalog([option('a'), option('a')]), 'actual-wire'),
    /duplicate/u,
  )
  assert.throws(
    () =>
      resolveRealConfiguredModel(
        { ...catalog([option('a')]), status: 'unavailable' },
        'actual-wire',
      ),
    /available/u,
  )
})
