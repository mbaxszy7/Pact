/* oxlint-disable eslint/no-await-in-loop -- Protocol cases deliberately preserve ordered page, ACK, epoch and final transitions through the primary owner. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
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
  completeSqliteObservation,
  validateSqliteFinalReceipt,
  validateSqliteSpoolFrame,
  recoverSqlitePages,
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
  const unit = 'json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1'
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
    'main-directory': ['main-directory.request', 'directory-main.reply'],
    'utility-markdown': ['utility-markdown.request', 'markdown-utility.reply'],
    'utility-image': ['utility-image.init', 'image-utility.reply'],
    'utility-native-json': ['utility-native-json.init', 'native-json-utility.reply'],
    'utility-native-fork': [
      'utility-native-fork.init',
      'utility-native-fork.control',
      'native-fork-utility.reply',
    ],
    'main-diagnostic-log': [
      'main-diagnostic-log.init',
      'main-diagnostic-log.request',
      'diagnostic-log-main.reply',
    ],
    'renderer-monaco': ['renderer-monaco.request', 'monaco-renderer.reply'],
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
      startedTransports: 0,
      settledTransports: 0,
      activeTransports: 0,
      highWaterTransports: 0,
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
    { ...ipcTraffic, unit: 'json-utf8-null-binary-skeleton-plus-visible-binary-bytes' },
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
      delete value.snapshot.owners[0].startedTransports
    },
    (value) => {
      value.snapshot.owners[0].activeTransports = 1
    },
    (value) => {
      value.baseline.owners[0].startedTransports = 1
      value.baseline.owners[0].settledTransports = 1
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

const sqliteEpoch = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
function sqliteRecord(
  sequence,
  schemaVersion = 1,
  details = ['SEARCH owned_fixture USING INDEX owned_fixture_id'],
) {
  return {
    recordSequence: sequence,
    schemaVersion,
    sqlSha256: sequence.toString(16).padStart(64, '0'),
    details,
  }
}
function sqlLedger(epoch = sqliteEpoch(1), initial = [sqliteRecord(1)]) {
  const records = [...initial]
  let acknowledgedThrough = 0,
    pageSequence = 0,
    page,
    lastAck,
    loseBefore = false,
    loseAfter = false
  const persisted = new Set(),
    calls = []
  const counters = (closed = false) => ({
    operations: records.length + 100,
    transactions: 0,
    rowsReturned: records.length,
    totalMs: records.length,
    maxMs: records.length ? 1 : 0,
    planOverflow: false,
    unsupportedOperations: false,
    retainedPlanBytes: closed ? 0 : Math.min(records.length, 64) * 100,
    highWaterPlanBytes: 15360,
    highWaterPlans: 64,
    unacknowledgedPlans: closed ? 0 : records.length - acknowledgedThrough,
    unacknowledgedHighWaterPlans: 64,
    recordWatermark: records.length,
  })
  const read = async (input) => {
    const ack = input.sqlitePlans.ack
    calls.push(ack ? 'ack' : 'read')
    if (ack) {
      assert(persisted.has(ack.payloadDigest), 'ACK must follow confirmed persistence')
      if (loseBefore) {
        loseBefore = false
        throw new Error('unconfirmed transport before delivery')
      }
      if (JSON.stringify(ack) !== JSON.stringify(lastAck)) {
        assert.equal(ack.observerEpoch, epoch)
        assert.equal(ack.pageSequence, page.pageSequence)
        assert.equal(ack.payloadDigest, page.payloadDigest)
        acknowledgedThrough = page.lastRecordSequence
        lastAck = structuredClone(ack)
        page = undefined
      }
      if (loseAfter) {
        loseAfter = false
        throw new Error('unconfirmed transport after delivery')
      }
    }
    if (!page && records.length > acknowledgedThrough) {
      const payload = {
        observerEpoch: epoch,
        pageSequence: ++pageSequence,
        firstRecordSequence: acknowledgedThrough + 1,
        lastRecordSequence: records.length,
        operationWatermark: records.length + 100,
        recordWatermark: records.length,
        records: records.slice(acknowledgedThrough),
      }
      page = {
        ...payload,
        payloadDigest: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      }
    }
    return {
      ok: true,
      value: {
        status: 'ready',
        database: 'ready',
        pid: 41000 + Number(epoch.slice(-2)),
        performance: {
          sqlite: {
            ...counters(),
            queryPlans: records
              .slice(-64)
              .map(({ sqlSha256, details }) => ({ sqlSha256, details })),
            planTransfer: {
              observerEpoch: epoch,
              recordWatermark: records.length,
              acknowledgedThrough,
              ...(lastAck ? { lastAck } : {}),
              ...(page ? { page: structuredClone(page) } : {}),
            },
          },
        },
      },
    }
  }
  return {
    records,
    persisted,
    calls,
    read,
    loseNextAckBeforeDelivery: () => {
      loseBefore = true
    },
    loseNextAckAfterDelivery: () => {
      loseAfter = true
    },
    persist: async (savedPage) => {
      persisted.add(savedPage.payloadDigest)
      return true
    },
    final: () => ({
      schemaVersion: 1,
      scope: 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1',
      observerEpoch: epoch,
      observerPid: 41000 + Number(epoch.slice(-2)),
      recordWatermark: records.length,
      acknowledgedThrough,
      pageSequence,
      ...(lastAck ? { lastAck } : {}),
      tailRecords: records.slice(acknowledgedThrough),
      counters: counters(true),
      databaseClosed: true,
      writerClosed: true,
      collectionDisposed: true,
    }),
  }
}
async function completeSqliteFixture() {
  const archive = resourceReportProjection()
  for (let index = 1; index <= 2; index++) {
    const ledger = sqlLedger(sqliteEpoch(index), [sqliteRecord(1), sqliteRecord(2)])
    const epochIndex = await archive.drainSqlite({
      read: ledger.read,
      persist: ledger.persist,
      phase: index === 1 ? 'before-send' : 'cold-admission',
    })
    archive.sealSqlite(epochIndex, ledger.final(), {
      physicalGroupGone: true,
      identityVerified: true,
    })
  }
  return {
    sqliteQueryPlanDictionary: archive.queryPlans,
    sqliteObservation: archive.sqliteObservation,
  }
}

void test('SQLite pages survive lost ACKs only after checking the current prefix/frozen page or lastAck', async () => {
  for (const mode of ['before', 'after']) {
    const archive = resourceReportProjection(),
      ledger = sqlLedger()
    if (mode === 'before') ledger.loseNextAckBeforeDelivery()
    else ledger.loseNextAckAfterDelivery()
    let writes = 0
    const index = await archive.drainSqlite({
      read: ledger.read,
      persist: async (page) => {
        writes++
        return ledger.persist(page)
      },
      phase: 'before-send',
    })
    assert.equal(writes, 1)
    assert.deepEqual(
      ledger.calls,
      mode === 'before' ? ['read', 'ack', 'read', 'ack'] : ['read', 'ack', 'read'],
    )
    assert.equal(archive.sqliteObservation.epochs[index].acknowledgedThrough, 1)
    archive.sealSqlite(index, ledger.final(), { physicalGroupGone: true, identityVerified: true })
  }
})

void test('SQLite archive preserves schema-aware records beyond 64 total plans within the same dictionary byte bound', async () => {
  const archive = resourceReportProjection(),
    ledger = sqlLedger(
      sqliteEpoch(1),
      Array.from({ length: 40 }, (_, index) => sqliteRecord(index + 1)),
    )
  const index = await archive.drainSqlite({
    read: ledger.read,
    persist: ledger.persist,
    phase: 'before-send',
  })
  ledger.records.push(...Array.from({ length: 40 }, (_, offset) => sqliteRecord(offset + 41)))
  await archive.drainSqlite({
    read: ledger.read,
    persist: ledger.persist,
    phase: 'after-workload-cycle',
    epochIndex: index,
  })
  ledger.records.push({ ...sqliteRecord(81, 2), sqlSha256: sqliteRecord(1).sqlSha256 })
  await archive.drainSqlite({
    read: ledger.read,
    persist: ledger.persist,
    phase: 'before-shutdown',
    epochIndex: index,
  })
  assert.equal(archive.queryPlans.length, 81)
  assert.equal(archive.queryPlans.at(-1).schemaVersion, 2)
  assert.equal(archive.queryPlans[0].sqlSha256, archive.queryPlans.at(-1).sqlSha256)
  assert.equal(archive.sqliteObservation.epochs[index].savedThrough, 81)
  const samples = Array.from({ length: 240 }, (_, offset) =>
    archive.project({
      eventLoopLagP95Ms: 12,
      sqlite: {
        operations: offset,
        planOverflow: false,
        queryPlans: ledger.records
          .slice(-64)
          .map(({ sqlSha256, details }) => ({ sqlSha256, details })),
      },
    }),
  )
  assert(
    samples.every(
      (sample, offset) =>
        sample.sqlite.operations === offset && sample.sqlite.retainedPlanCount === 64,
    ),
  )
  assert(
    Buffer.byteLength(
      JSON.stringify({
        samples,
        sqliteQueryPlanDictionary: archive.queryPlans,
        sqliteObservation: archive.sqliteObservation,
      }),
    ) <
      768 * 1024,
  )
  assert.throws(
    () => archive.project({ sqlite: { queryPlans: [{ sqlSha256: 'bad', details: [] }] } }),
    /Invalid/,
  )
  assert.equal(archive.project(undefined), undefined)
})

void test('page conflicts, wrong epochs and changed payload digests fail before an ACK', async () => {
  for (const mutate of [
    (page) => {
      page.observerEpoch = sqliteEpoch(9)
    },
    (page) => {
      page.records[0].schemaVersion++
    },
    (page) => {
      page.payloadDigest = 'f'.repeat(64)
    },
    (page) => {
      page.records[0].recordSequence++
    },
  ]) {
    const archive = resourceReportProjection(),
      ledger = sqlLedger()
    await assert.rejects(
      archive.drainSqlite({
        read: async (input) => {
          const response = await ledger.read(input)
          mutate(response.value.performance.sqlite.planTransfer.page)
          return response
        },
        persist: ledger.persist,
        phase: 'before-send',
      }),
      /incomplete/,
    )
    assert.equal(ledger.calls.includes('ack'), false)
  }
  const archive = resourceReportProjection(),
    ledger = sqlLedger()
  ledger.loseNextAckBeforeDelivery()
  let reads = 0
  await assert.rejects(
    archive.drainSqlite({
      read: async (input) => {
        const response = await ledger.read(input)
        if (++reads === 2) {
          const page = response.value.performance.sqlite.planTransfer.page
          page.operationWatermark++
          const { payloadDigest: _digest, ...payload } = page
          page.payloadDigest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
        }
        return response
      },
      persist: ledger.persist,
      phase: 'before-send',
    }),
    /incomplete/,
  )
  assert.equal(archive.sqliteObservation.epochs[0].pages.length, 1)
})

void test('failed persistence and report capacity preserve earlier evidence and never acknowledge the rejected page', async () => {
  const archive = resourceReportProjection(),
    ledger = sqlLedger()
  await assert.rejects(
    archive.drainSqlite({ read: ledger.read, persist: async () => false, phase: 'before-send' }),
    /incomplete/,
  )
  assert.equal(ledger.calls.includes('ack'), false)
  assert.equal(archive.queryPlans.length, 0)
  const limited = resourceReportProjection({
      reserve: (candidate) => {
        if (candidate.queryPlans.length > 1) throw new Error('fixed receiver capacity')
      },
    }),
    source = sqlLedger()
  const epochIndex = await limited.drainSqlite({
    read: source.read,
    persist: source.persist,
    phase: 'before-send',
  })
  source.records.push(sqliteRecord(2))
  const before = JSON.stringify(limited.queryPlans)
  await assert.rejects(
    limited.drainSqlite({
      read: source.read,
      persist: source.persist,
      phase: 'before-shutdown',
      epochIndex,
    }),
    /incomplete/,
  )
  assert.equal(JSON.stringify(limited.queryPlans), before)
  assert.equal(source.calls.at(-1), 'read')
  assert.equal(limited.sqliteObservation.epochs[0].pages[0].persistenceVerified, true)
})

void test('the real 32-KiB dictionary limit rejects additions without erasing acknowledged prefixes', async () => {
  const archive = resourceReportProjection(),
    ledger = sqlLedger(sqliteEpoch(1), [])
  let index
  for (let batch = 0; batch < 2; batch++) {
    ledger.records.push(
      ...Array.from({ length: 20 }, (_, offset) =>
        sqliteRecord(batch * 20 + offset + 1, 1, ['x'.repeat(512)]),
      ),
    )
    index = await archive.drainSqlite({
      read: ledger.read,
      persist: ledger.persist,
      phase: 'before-send',
      epochIndex: index,
    })
  }
  const preserved = JSON.stringify(archive.queryPlans),
    saved = archive.sqliteObservation.epochs[0].savedThrough
  ledger.records.push(
    ...Array.from({ length: 20 }, (_, offset) => sqliteRecord(41 + offset, 1, ['x'.repeat(512)])),
  )
  await assert.rejects(
    archive.drainSqlite({
      read: ledger.read,
      persist: ledger.persist,
      phase: 'before-shutdown',
      epochIndex: index,
    }),
    /incomplete/,
  )
  assert.equal(archive.sqliteObservation.failure, 'SQLITE_DICTIONARY_CAPACITY')
  assert.equal(JSON.stringify(archive.queryPlans), preserved)
  assert.equal(archive.sqliteObservation.epochs[0].savedThrough, saved)
  assert.equal(ledger.calls.at(-1), 'read')
})

void test('a persistence deadline never commits or ACKs a late write result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const archive = resourceReportProjection(),
    ledger = sqlLedger()
  let finish, entered
  const writing = new Promise((resolve) => {
    entered = resolve
  })
  const pending = archive.drainSqlite({
    read: ledger.read,
    persist: () =>
      new Promise((resolve) => {
        finish = resolve
        entered()
      }),
    phase: 'before-send',
    deadline: performance.now() + 5000,
  })
  const checked = assert.rejects(pending, /incomplete/)
  await writing
  t.mock.timers.tick(5000)
  await checked
  assert.equal(archive.sqliteObservation.failure, 'SQLITE_TRANSFER_DEADLINE')
  finish(true)
  await Promise.resolve()
  assert.equal(archive.sqliteObservation.epochs[0].pages.length, 0)
  assert.equal(ledger.calls.includes('ack'), false)
  t.mock.timers.reset()
})

void test('unacknowledged saved-page overlap is preserved at final seal and missing/conflicting tail blocks', async () => {
  for (const mode of ['same', 'missing', 'conflict']) {
    const archive = resourceReportProjection(),
      ledger = sqlLedger(sqliteEpoch(1), [sqliteRecord(1), sqliteRecord(2)])
    let reads = 0
    await assert.rejects(
      archive.drainSqlite({
        read: async (input) => {
          if (++reads > 1) throw new Error('transport unavailable')
          return ledger.read(input)
        },
        persist: ledger.persist,
        phase: 'before-send',
      }),
      /incomplete/,
    )
    const final = ledger.final()
    if (mode === 'missing') final.tailRecords.pop()
    if (mode === 'conflict') final.tailRecords[0].schemaVersion++
    if (mode === 'same') {
      archive.sealSqlite(0, final, { physicalGroupGone: true, identityVerified: true })
      assert.equal(archive.sqliteObservation.epochs[0].final.tailRecords.length, 2)
      assert.equal(archive.queryPlans.length, 2)
    } else
      assert.throws(
        () => archive.sealSqlite(0, final, { physicalGroupGone: true, identityVerified: true }),
        /incomplete/,
      )
  }
})

void test('SQLite gate independently validates every epoch, final closure, continuity, counters, digests and ACK prefix', async () => {
  const valid = await completeSqliteFixture()
  assert.equal(completeSqliteObservation(valid), true)
  for (const mutate of [
    (value) => {
      delete value.sqliteObservation
    },
    (value) => {
      value.sqliteObservation.epochs.pop()
    },
    (value) => {
      value.sqliteObservation.epochs[1].observerEpoch =
        value.sqliteObservation.epochs[0].observerEpoch
    },
    (value) => {
      delete value.sqliteObservation.epochs[0].final
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.databaseClosed = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.writerClosed = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.collectionDisposed = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.physicalGroupGone = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.identityVerified = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.planOverflow = true
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.firstPlanFailure = {
        reason: 'plan-capacity',
        sqlSha256: 'a'.repeat(64),
        sourceBytes: 171,
        operationIndex: 1,
        retainedPlans: 64,
        retainedPlanBytes: 1024,
        planRows: null,
      }
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.unsupportedOperations = true
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.retainedPlanBytes = 1
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.highWaterPlanBytes = 16385
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.counters.highWaterPlans = 65
    },
    (value) => {
      value.sqliteObservation.epochs[0].pages[0].records.pop()
    },
    (value) => {
      value.sqliteObservation.epochs[0].pages[0].payloadDigest = 'a'.repeat(64)
    },
    (value) => {
      value.sqliteObservation.epochs[0].pages[0].persistenceVerified = false
    },
    (value) => {
      value.sqliteObservation.epochs[0].final.lastAck.payloadDigest = 'a'.repeat(64)
    },
    (value) => {
      value.sqliteObservation.epochs[0].observations[0].acknowledgedThrough = -1
    },
    (value) => {
      value.sqliteObservation.epochs[0].drains[0].acknowledgedThrough = 0
    },
  ]) {
    const changed = structuredClone(valid)
    mutate(changed)
    assert.equal(completeSqliteObservation(changed), false)
    assert(
      evaluateSoak({ ...changed, missingObservations: [] }, 7_200_000).unmetBudgets.includes(
        'complete-sqlite-observation',
      ),
    )
  }
  assert.equal(completeSqliteObservation({ sqliteQueryPlanDictionary: [] }), false)
})

void test('two hours of empty-page polling retain phase/read counts and first/last counters within the unchanged report limits', async () => {
  const archive = resourceReportProjection(),
    ledger = sqlLedger()
  const epochIndex = await archive.drainSqlite({
    read: ledger.read,
    persist: ledger.persist,
    phase: 'before-send',
  })
  for (let iteration = 0; iteration < 1440; iteration++) {
    if (iteration % 12 === 0)
      await archive.drainSqlite({
        read: ledger.read,
        persist: ledger.persist,
        phase: 'before-send',
        epochIndex,
      })
    await archive.drainSqlite({
      read: ledger.read,
      persist: ledger.persist,
      phase: 'after-workload-cycle',
      epochIndex,
    })
  }
  const epoch = archive.sqliteObservation.epochs[0]
  assert.equal(
    epoch.drains
      .filter((value) => value.phase === 'after-workload-cycle')
      .reduce((sum, value) => sum + value.occurrences, 0),
    1440,
  )
  assert.equal(
    epoch.observations.reduce((sum, value) => sum + value.readCount, 0),
    ledger.calls.length,
  )
  assert.equal(epoch.pages.length, 1)
  assert(epoch.observations.length < 250)
  assert(
    Buffer.byteLength(
      JSON.stringify(
        {
          sqliteQueryPlanDictionary: archive.queryPlans,
          sqliteObservation: archive.sqliteObservation,
        },
        null,
        2,
      ),
    ) <
      768 * 1024,
  )
})

void test('raw final receipts bind the sealed observer to nonce, actual process IDs, epoch and immutable distribution', async () => {
  const manifest = {
    sourceSha: 'a'.repeat(40),
    version: '0.1.0',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
  }
  const ledger = sqlLedger(),
    archive = resourceReportProjection()
  await archive.drainSqlite({ read: ledger.read, persist: ledger.persist, phase: 'before-send' })
  const final = ledger.final(),
    raw = {
      schemaVersion: 1,
      nonce: 'b'.repeat(64),
      mainPid: 100,
      utilityPid: final.observerPid,
      ...manifest,
      sqliteFinal: final,
    }
  const expected = {
    nonce: raw.nonce,
    mainPid: raw.mainPid,
    utilityPid: raw.utilityPid,
    observerEpoch: final.observerEpoch,
    manifest,
  }
  assert.deepEqual(validateSqliteFinalReceipt(raw, expected), final)
  for (const change of [
    { nonce: 'c'.repeat(64) },
    { utilityPid: 999 },
    { mainPid: 999 },
    { sourceSha: 'd'.repeat(40) },
    { sqliteFinal: { ...final, observerEpoch: sqliteEpoch(9) } },
  ])
    assert.throws(() => validateSqliteFinalReceipt({ ...raw, ...change }, expected))
})

void test('durable spool recovery shares page/dictionary validation without creating ACKs or final seals', async () => {
  const manifest = {
    sourceSha: 'a'.repeat(40),
    version: '0.1.0',
    channel: 'stable',
    platform: 'darwin',
    arch: 'arm64',
  }
  const ledger = sqlLedger(),
    response = await ledger.read({ sqlitePlans: {} })
  const frame = {
    schemaVersion: 1,
    ...manifest,
    observerPid: response.value.pid,
    page: response.value.performance.sqlite.planTransfer.page,
  }
  assert.deepEqual(validateSqliteSpoolFrame(frame, manifest), frame)
  const recovered = await recoverSqlitePages([frame, structuredClone(frame)], manifest)
  assert.equal(recovered.status, 'unsealed-recovered-prefix')
  assert.equal(recovered.sqliteObservation.epochs[0].savedThrough, 1)
  assert.equal(recovered.sqliteObservation.epochs[0].acknowledgedThrough, 0)
  assert.equal(recovered.sqliteObservation.epochs[0].final, undefined)
  assert.equal(completeSqliteObservation(recovered), false)
  await assert.rejects(recoverSqlitePages([{ ...frame, sourceSha: 'f'.repeat(40) }], manifest))
  await assert.rejects(recoverSqlitePages([{ ...frame, nonce: 'must-not-be-in-spool' }], manifest))
})

void test('actual producer DTOs and schema changes transfer through durable pages and close receipts', async () => {
  const source = `
    import assert from 'node:assert/strict';
    import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { fileURLToPath } from 'node:url';
    import { sql } from ${JSON.stringify(new URL('../packages/persistence/node_modules/drizzle-orm/index.js', import.meta.url).href)};
    import { PactDatabase } from ${JSON.stringify(new URL('../packages/persistence/src/pact-database.ts', import.meta.url).href)};
    import { sqlitePlanPageSchema, sqliteFinalSchema } from ${JSON.stringify(new URL('../packages/contracts/src/index.ts', import.meta.url).href)};
    import { resourceReportProjection, completeSqliteObservation } from ${JSON.stringify(new URL('./soak-statistics.mjs', import.meta.url).href)};
    import { validateSoakObservation } from ${JSON.stringify(new URL('./run-soak.mjs', import.meta.url).href)};
    const root = await mkdtemp(join(tmpdir(), 'pact-sqlite-page-dto-'));
    const archive = resourceReportProjection(); let db;
    try {
      for (let generation = 0; generation < 2; generation++) {
        db = await PactDatabase.open({ filePath: ':memory:', migrationsFolder: ${JSON.stringify(fileURLToPath(new URL('../packages/persistence/drizzle', import.meta.url)))}, measurePerformance: true });
        let epochIndex;
        const drain = phase => archive.drainSqlite({
          read: async input => ({ ok: true, value: { status:'ready', database:'ready', pid:process.pid, performance:db.performanceDiagnostics(input.sqlitePlans) } }),
          persist: async page => {
            sqlitePlanPageSchema.parse(page);
            const file = join(root, page.observerEpoch + '-' + page.pageSequence + '.json');
            await writeFile(file, JSON.stringify(page), { flag:'wx', mode:0o600, flush:true });
            assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), page);
            return true;
          }, phase, epochIndex,
        });
        for (let index=0; index<70; index++) {
          db.drizzle.get(sql.raw('SELECT ' + index + ' AS value'));
          if ((index+1)%30===0) epochIndex = await drain(generation===0 ? 'before-send' : 'cold-admission');
        }
        epochIndex = await drain('before-shutdown');
        db.drizzle.get(sql.raw('SELECT 1 AS value'));
        db.drizzle.run(sql.raw('CREATE TABLE schema_variant_fixture(id INTEGER PRIMARY KEY)'));
        db.drizzle.get(sql.raw('SELECT 1 AS value'));
        await drain('before-shutdown');
        db.close(); const final = db.performanceFinal(); sqliteFinalSchema.parse(final);
        archive.sealSqlite(epochIndex, final, { physicalGroupGone:true, identityVerified:true }); db=undefined;
      }
      const evidence = { sqliteQueryPlanDictionary: archive.queryPlans, sqliteObservation: archive.sqliteObservation };
      const serializedEvidence = JSON.parse(JSON.stringify(evidence));
      assert.deepEqual(validateSoakObservation(serializedEvidence), serializedEvidence);
      assert.equal(completeSqliteObservation(evidence), true);
      const variants = archive.queryPlans.filter(plan => plan.sqlSha256 === archive.queryPlans[1].sqlSha256);
      assert(new Set(variants.map(plan => plan.schemaVersion)).size >= 2);
      console.log(JSON.stringify({ producerDtoValidated:true, dictionaryEntries:archive.queryPlans.length, epochs:archive.sqliteObservation.epochs.length, completeSchemaVariant:true }));
    } catch { console.error('Bounded real SQLite DTO fixture failed.'); process.exitCode=1; }
    finally { db?.close(); await rm(root,{ recursive:true,force:true }); }
  `
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--experimental-transform-types',
      '--import',
      fileURLToPath(new URL('./soak-module-loader.mjs', import.meta.url)),
      '--input-type=module',
      '--eval',
      source,
    ],
    { timeout: 30000, maxBuffer: 4096, shell: false },
  )
  const result = JSON.parse(stdout)
  assert.equal(result.producerDtoValidated, true)
  assert.equal(result.epochs, 2)
  assert.equal(result.completeSchemaVariant, true)
  assert(result.dictionaryEntries > 64)
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

void test('continuous two-hour duration is actual elapsed evidence, not an E2E timeout', async () => {
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
    ...(await completeSqliteFixture()),
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
