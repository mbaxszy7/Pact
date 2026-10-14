import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'

import {
  histogram,
  observe,
  percentile,
  evaluateSoak,
  validateReceipt,
  resourceReportProjection,
  installReactCommitProbe,
  reactCommitObservationComplete,
} from './soak-statistics.mjs'

const reactProbeKey = '__pactSoakReact_' + 'a'.repeat(64)
const zeroIpcCounts = () => ({
  messages: 0,
  incompleteMessages: 0,
  jsonBytes: 0,
  binaryBytes: 0,
  totalBytes: 0,
})
const evaluateIpcGate = (input) =>
  evaluateSoak({ durationMs: 7_200_000, missingObservations: [], ipcTraffic: input }, 7_200_000)
function completeIpcEvidence(durationMs = 7_200_000) {
  const unit = 'json-utf8-null-binary-skeleton-plus-visible-binary-bytes'
  const categories = {
    'renderer-bridge': [
      'renderer-main.invoke',
      'main-renderer.reply',
      'renderer-main.send',
      'main-renderer.event',
    ],
    'main-utility': [
      'main-utility.request',
      'utility-main.reply',
      'utility-main.event',
      'main-utility.control',
      'utility-main.control',
    ],
  }
  const snapshot = {
    schemaVersion: 1,
    unit,
    complete: true,
    uncovered: [],
    owners: Object.entries(categories).map(([owner, entries], index) => ({
      owner,
      epoch: `00000000-0000-4000-8000-00000000000${index + 1}`,
      transportEpoch: 1,
      complete: true,
      issues: [],
      counters: entries.map((category) => ({
        category,
        business: zeroIpcCounts(),
        control: zeroIpcCounts(),
      })),
    })),
  }
  return {
    observed: true,
    complete: true,
    unit,
    observedDurationMs: durationMs,
    issues: [],
    businessBytes: 0,
    controlBytes: 0,
    baseline: structuredClone(snapshot),
    snapshot,
  }
}

void test('IPC acceptance independently rejects missing, partial, overflowed and discontinuous report facts', () => {
  const ipcTraffic = completeIpcEvidence()
  assert.equal(
    evaluateIpcGate(ipcTraffic).unmetBudgets.includes('complete-logical-ipc-traffic'),
    false,
  )
  const invalid = [
    undefined,
    { ...ipcTraffic, complete: false },
    { ...ipcTraffic, issues: ['counter_overflow'] },
    { ...ipcTraffic, unit: 'wire-bytes' },
    { ...ipcTraffic, observedDurationMs: 7_199_999 },
    { ...ipcTraffic, baseline: undefined },
    { ...ipcTraffic, businessBytes: 1 },
  ]
  for (const mutate of [
    (value) => {
      value.snapshot.uncovered.push('main-directory-worker')
    },
    (value) => {
      value.snapshot.owners[0].complete = false
    },
    (value) => {
      value.snapshot.owners[0] = null
    },
    (value) => {
      value.snapshot.owners[0].owner = 'constructor'
    },
    (value) => {
      value.snapshot.owners[0].counters[0] = null
    },
    (value) => {
      value.snapshot.owners[0].issues.push('counter_overflow')
    },
    (value) => {
      value.snapshot.owners[0].epoch = '00000000-0000-4000-8000-000000000099'
    },
    (value) => {
      value.snapshot.owners[0].transportEpoch = 3
    },
    (value) => {
      value.snapshot.owners[0].counters.pop()
    },
    (value) => {
      value.snapshot.owners[0].counters[0].business.messages = 1_000_001
    },
    (value) => {
      value.snapshot.owners[0].counters[0].business.jsonBytes = Number.MAX_SAFE_INTEGER + 1
    },
    (value) => {
      value.snapshot.owners[0].counters[0].business.incompleteMessages = 1
    },
    (value) => {
      value.baseline.owners[0].counters[0].business.messages = 1
    },
  ]) {
    const value = structuredClone(ipcTraffic)
    mutate(value)
    invalid.push(value)
  }
  for (const value of invalid)
    assert(evaluateIpcGate(value).unmetBudgets.includes('complete-logical-ipc-traffic'))
})

void test('actual logical IPC projections keep partial hops, failed owners and resets blocking', async () => {
  await import('./soak-module-loader.mjs')
  const { LogicalIpcTrafficCollector, logicalIpcTrafficSnapshot, projectLogicalIpcTraffic } =
    await import('../apps/desktop/src/shared/logical-ipc-traffic.ts')
  const main = new LogicalIpcTrafficCollector(
    'main-utility',
    '00000000-0000-4000-8000-000000000001',
  )
  const preload = new LogicalIpcTrafficCollector(
    'renderer-bridge',
    '00000000-0000-4000-8000-000000000002',
  )
  main.record('main-utility.request', 'business', { input: 'fixture' })
  preload.record('renderer-main.invoke', 'control', [])
  const observation = logicalIpcTrafficSnapshot(main.snapshot())
  observation.owners.push(preload.snapshot())
  observation.uncovered = observation.uncovered.filter((hop) => hop !== 'renderer-main-bridge')
  const projected = projectLogicalIpcTraffic(observation)
  assert.equal(projected.observed, true)
  assert.equal(projected.businessBytes, Buffer.byteLength('{"input":"fixture"}'))
  assert.equal(projected.controlBytes, 2)
  assert.equal(projected.complete, false)
  assert(projected.issues.includes('uncovered:main-directory-worker'))
  const budget = evaluateSoak(
    { durationMs: 3_600_000, missingObservations: ['complete-ipc-traffic'] },
    3_600_000,
  )
  assert(budget.unmetBudgets.includes('unobserved:complete-ipc-traffic'))
  assert.equal(budget.budgetPass, false)
  main.invalidate('transport_error')
  observation.owners[0] = main.snapshot()
  assert(projectLogicalIpcTraffic(observation).issues.includes('main-utility:transport_error'))
  const previous = structuredClone(observation)
  observation.owners[0] = new LogicalIpcTrafficCollector(
    'main-utility',
    '00000000-0000-4000-8000-000000000003',
  ).snapshot()
  assert(
    projectLogicalIpcTraffic(observation, previous).issues.includes('main-utility:epoch-reset'),
  )
  assert.equal(projectLogicalIpcTraffic(undefined).observed, false)
})
function reactRealm(before) {
  const realm = createContext({ location: { href: 'app://bundle/index.html' } })
  runInContext('globalThis.top = globalThis', realm)
  before?.(realm)
  runInContext(`(${installReactCommitProbe.toString()})(${JSON.stringify(reactProbeKey)})`, realm)
  return realm
}

void test('React probe counts mount and workload commits without reading or retaining React facts', () => {
  const realm = reactRealm(),
    hook = Reflect.get(realm, '__REACT_DEVTOOLS_GLOBAL_HOOK__'),
    probe = realm[reactProbeKey]
  const renderer = hook.inject({ privateMetadata: 'never-recorded' })
  const root = Object.defineProperty({}, 'privateBody', {
    get() {
      throw new Error('React objects must not be inspected')
    },
  })
  hook.onCommitFiberRoot(renderer, root)
  assert.equal(probe.beginWorkload().status, 'observed')
  hook.onCommitFiberRoot(renderer, root)
  hook.onCommitFiberRoot(renderer, root)
  const measured = probe.stop()
  assert.deepEqual(JSON.parse(JSON.stringify(measured)), {
    schemaVersion: 1,
    status: 'observed',
    injectedRenderers: 1,
    initialMountCommits: 1,
    workloadCommits: 2,
    cleanupVerified: true,
  })
  assert.equal(reactCommitObservationComplete(measured), true)
  assert.equal(Object.hasOwn(realm, '__REACT_DEVTOOLS_GLOBAL_HOOK__'), false)
  assert.equal(Object.hasOwn(realm, reactProbeKey), false)
  hook.onCommitFiberRoot(renderer, root)
  assert.equal(measured.workloadCommits, 2)
  assert.equal(JSON.stringify(measured).includes('private'), false)
})

void test('React probe preserves an unknown hook, including accessors, and blocks missing injection', () => {
  const realm = reactRealm((context) => {
    Object.defineProperty(context, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
      configurable: true,
      get() {
        throw new Error('An unknown hook must not be invoked or inspected')
      },
    })
  })
  const original = Object.getOwnPropertyDescriptor(realm, '__REACT_DEVTOOLS_GLOBAL_HOOK__')
  const unknown = realm[reactProbeKey].stop()
  assert.equal(unknown.reason, 'unknown-existing-hook')
  assert.equal(reactCommitObservationComplete(unknown), false)
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(realm, '__REACT_DEVTOOLS_GLOBAL_HOOK__'),
    original,
  )
  const absent = reactRealm()[reactProbeKey]
  assert.equal(absent.beginWorkload().reason, 'not-injected')
  assert.equal(reactCommitObservationComplete(absent.stop()), false)
})

void test('React probe fences unknown renderers, duplicate phases, hook replacement and count overflow', () => {
  const unknown = reactRealm()
  Reflect.get(unknown, '__REACT_DEVTOOLS_GLOBAL_HOOK__').onCommitFiberRoot(1)
  assert.equal(unknown[reactProbeKey].stop().reason, 'unknown-renderer')

  const phase = reactRealm(),
    phaseHook = Reflect.get(phase, '__REACT_DEVTOOLS_GLOBAL_HOOK__'),
    phaseProbe = phase[reactProbeKey]
  phaseHook.onCommitFiberRoot(phaseHook.inject())
  phaseProbe.beginWorkload()
  assert.equal(phaseProbe.beginWorkload().reason, 'invalid-phase')
  assert.equal(reactCommitObservationComplete(phaseProbe.stop()), false)

  const replaced = reactRealm(),
    replacement = { ownedElsewhere: true }
  Object.defineProperty(replaced, '__REACT_DEVTOOLS_GLOBAL_HOOK__', {
    configurable: true,
    value: replacement,
  })
  assert.equal(replaced[reactProbeKey].stop().reason, 'hook-replaced')
  assert.equal(Reflect.get(replaced, '__REACT_DEVTOOLS_GLOBAL_HOOK__'), replacement)

  const overflow = reactRealm()
  runInContext(
    `const renderer = __REACT_DEVTOOLS_GLOBAL_HOOK__.inject();
     for (let index = 0; index < 1000001; index++)
       __REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(renderer);`,
    overflow,
  )
  const measured = overflow[reactProbeKey].stop()
  assert.equal(measured.reason, 'commit-capacity')
  assert.equal(measured.initialMountCommits, 1_000_000)
  assert.equal(reactCommitObservationComplete(measured), false)
})

void test('React evidence requires real injection and verified cleanup without imposing a workload threshold', () => {
  const observed = {
    schemaVersion: 1,
    status: 'observed',
    injectedRenderers: 1,
    initialMountCommits: 1,
    workloadCommits: 0,
    cleanupVerified: true,
  }
  assert.equal(reactCommitObservationComplete(observed), true)
  for (const changed of [
    { status: 'pending' },
    { injectedRenderers: 0 },
    { initialMountCommits: 0 },
    { workloadCommits: -1 },
    { workloadCommits: 1_000_000 },
    { cleanupVerified: false },
    { privateBody: 'must-not-export' },
  ])
    assert.equal(reactCommitObservationComplete({ ...observed, ...changed }), false)
})

void test('React probe installs only in the exact top trusted document and bounds Renderer registrations', () => {
  for (const change of [
    (realm) => {
      realm.location.href = 'https://example.invalid/'
    },
    (realm) => {
      realm.top = {}
    },
  ]) {
    const rejected = reactRealm(change)
    assert.equal(Object.hasOwn(rejected, reactProbeKey), false)
    assert.equal(Object.hasOwn(rejected, '__REACT_DEVTOOLS_GLOBAL_HOOK__'), false)
  }
  const realm = reactRealm(),
    hook = Reflect.get(realm, '__REACT_DEVTOOLS_GLOBAL_HOOK__')
  for (let index = 0; index < 17; index++) hook.inject()
  const measured = realm[reactProbeKey].stop()
  assert.equal(measured.injectedRenderers, 16)
  assert.equal(measured.reason, 'renderer-capacity')
  assert.equal(reactCommitObservationComplete(measured), false)
})

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
    reactCommits: {
      schemaVersion: 1,
      status: 'observed',
      injectedRenderers: 1,
      initialMountCommits: 1,
      workloadCommits: 100,
      cleanupVerified: true,
    },
    missingObservations: [],
    ipcTraffic: completeIpcEvidence(),
  }
  assert.equal(evaluateSoak(evidence, 7_200_000).budgetPass, true)
  assert.equal(evaluateSoak({ ...evidence, durationMs: 7_199_999 }, 7_200_000).budgetPass, false)
  assert.equal(evaluateSoak(evidence, 1000).budgetPass, false)
  assert.equal(evaluateSoak({ ...evidence, reactCommits: undefined }, 7_200_000).budgetPass, false)
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
