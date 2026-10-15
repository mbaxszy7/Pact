/* oxlint-disable eslint/no-await-in-loop -- One SQLite archive sequences persistence, ACK reconciliation and recovery; parallel delivery would break its prefix proof. */
import { createHash } from 'node:crypto'

export function histogram() {
  return { bins: Array.from({ length: 1001 }, () => 0), count: 0, maximum: 0 }
}

/** Serialized into the proved Renderer before reload; retain counters, never React objects. */
export function installReactCommitProbe(key) {
  if (
    !/^__pactSoakReact_[a-f\d]{64}$/u.test(key) ||
    globalThis.top !== globalThis ||
    globalThis.location?.href !== 'app://bundle/index.html'
  )
    return
  const hookName = '__REACT_DEVTOOLS_GLOBAL_HOOK__'
  if (Object.hasOwn(globalThis, key)) return
  let injectedRenderers = 0,
    initialMountCommits = 0,
    workloadCommits = 0,
    workloadStarted = false,
    stopped = false,
    reason
  const block = (problem) => {
    reason ??= problem
  }
  const hook = Object.freeze({
    supportsFiber: true,
    inject: () => {
      if (stopped || reason) return 0
      if (injectedRenderers >= 16) {
        block('renderer-capacity')
        return 0
      }
      injectedRenderers++
      return injectedRenderers
    },
    onCommitFiberRoot: (rendererId) => {
      if (stopped || reason) return
      if (!Number.isSafeInteger(rendererId) || rendererId < 1 || rendererId > injectedRenderers) {
        block('unknown-renderer')
        return
      }
      if (initialMountCommits + workloadCommits >= 1_000_000) {
        block('commit-capacity')
        return
      }
      if (workloadStarted) workloadCommits++
      else initialMountCommits++
    },
  })
  const ownsHook = () => Object.getOwnPropertyDescriptor(globalThis, hookName)?.value === hook
  const snapshot = () => {
    if (!stopped && !reason && !ownsHook()) block('hook-replaced')
    return {
      schemaVersion: 1,
      status: reason ? 'blocked' : workloadStarted ? 'observed' : 'pending',
      injectedRenderers,
      initialMountCommits,
      workloadCommits,
      ...(reason ? { reason } : {}),
    }
  }
  const probe = Object.freeze({
    beginWorkload: () => {
      if (stopped || workloadStarted) block('invalid-phase')
      if (!injectedRenderers || !initialMountCommits) block('not-injected')
      if (!reason) workloadStarted = true
      return snapshot()
    },
    stop: () => {
      const observation = snapshot()
      stopped = true
      const released = !ownsHook() || Reflect.deleteProperty(globalThis, hookName)
      const ownedProbe = Object.getOwnPropertyDescriptor(globalThis, key)?.value === probe
      const removed = ownedProbe && Reflect.deleteProperty(globalThis, key)
      return { ...observation, cleanupVerified: released && removed }
    },
  })
  Object.defineProperty(globalThis, key, { configurable: true, value: probe })
  if (Reflect.has(globalThis, hookName)) block('unknown-existing-hook')
  else Object.defineProperty(globalThis, hookName, { configurable: true, value: hook })
}

export function reactCommitObservationComplete(observation) {
  if (
    !observation ||
    Object.keys(observation).length !== 6 ||
    observation.schemaVersion !== 1 ||
    observation.status !== 'observed' ||
    observation.cleanupVerified !== true ||
    !Number.isSafeInteger(observation.injectedRenderers) ||
    observation.injectedRenderers < 1 ||
    observation.injectedRenderers > 16 ||
    !Number.isSafeInteger(observation.initialMountCommits) ||
    observation.initialMountCommits < 1 ||
    !Number.isSafeInteger(observation.workloadCommits) ||
    observation.workloadCommits < 0 ||
    observation.initialMountCommits + observation.workloadCommits > 1_000_000
  )
    return false
  return true
}

const SQLITE_SCOPE = 'post-open-native-run-get-all-and-drizzle-transaction-attempts-v1'
const HASH = /^[a-f\d]{64}$/u
const EPOCH = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const exact = (value, required, optional = []) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const invalidSqlite = () => {
  throw new Error('Invalid or discontinuous SQLite observation')
}
const deadlineError = () =>
  Object.assign(new Error('SQLite transfer deadline exceeded'), {
    code: 'SQLITE_TRANSFER_DEADLINE',
  })
function planRecord(value) {
  if (
    !exact(value, ['recordSequence', 'schemaVersion', 'sqlSha256', 'details']) ||
    !integer(value.recordSequence) ||
    value.recordSequence < 1 ||
    !integer(value.schemaVersion) ||
    !HASH.test(value.sqlSha256 ?? '') ||
    !Array.isArray(value.details) ||
    value.details.length > 64 ||
    value.details.some((detail) => typeof detail !== 'string' || Buffer.byteLength(detail) > 512)
  )
    invalidSqlite()
  return {
    recordSequence: value.recordSequence,
    schemaVersion: value.schemaVersion,
    sqlSha256: value.sqlSha256,
    details: [...value.details],
  }
}
function ackValue(value) {
  if (
    !exact(value, ['observerEpoch', 'pageSequence', 'payloadDigest']) ||
    !EPOCH.test(value.observerEpoch ?? '') ||
    !integer(value.pageSequence) ||
    value.pageSequence < 1 ||
    !HASH.test(value.payloadDigest ?? '')
  )
    invalidSqlite()
  return {
    observerEpoch: value.observerEpoch,
    pageSequence: value.pageSequence,
    payloadDigest: value.payloadDigest,
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
export function sqlitePlanPagePayload(value) {
  return {
    observerEpoch: value.observerEpoch,
    pageSequence: value.pageSequence,
    firstRecordSequence: value.firstRecordSequence,
    lastRecordSequence: value.lastRecordSequence,
    operationWatermark: value.operationWatermark,
    recordWatermark: value.recordWatermark,
    records: value.records.map(planRecord),
  }
}
const producerRecordBytes = (records) =>
  1024 +
  records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record)) + 32, 0)

function checkedPage(value) {
  if (
    !exact(value, [
      'observerEpoch',
      'pageSequence',
      'firstRecordSequence',
      'lastRecordSequence',
      'operationWatermark',
      'recordWatermark',
      'payloadDigest',
      'records',
    ]) ||
    !EPOCH.test(value.observerEpoch ?? '') ||
    !HASH.test(value.payloadDigest ?? '') ||
    ![
      'pageSequence',
      'firstRecordSequence',
      'lastRecordSequence',
      'operationWatermark',
      'recordWatermark',
    ].every((key) => integer(value[key])) ||
    value.pageSequence < 1 ||
    !Array.isArray(value.records) ||
    !value.records.length ||
    value.records.length > 64
  )
    invalidSqlite()
  const payload = sqlitePlanPagePayload(value)
  if (producerRecordBytes(payload.records) > 16 * 1024) invalidSqlite()
  if (
    payload.firstRecordSequence < 1 ||
    payload.records.some(
      (record, index) => record.recordSequence !== payload.firstRecordSequence + index,
    ) ||
    payload.records.at(-1).recordSequence !== payload.lastRecordSequence ||
    payload.lastRecordSequence !== payload.recordWatermark ||
    payload.recordWatermark > payload.operationWatermark ||
    createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== value.payloadDigest
  )
    invalidSqlite()
  return { ...payload, payloadDigest: value.payloadDigest }
}
const counterNames = [
  'operations',
  'transactions',
  'rowsReturned',
  'totalMs',
  'maxMs',
  'planOverflow',
  'unsupportedOperations',
  'retainedPlanBytes',
  'highWaterPlanBytes',
  'highWaterPlans',
  'unacknowledgedPlans',
  'unacknowledgedHighWaterPlans',
  'recordWatermark',
]
function checkedCounters(raw) {
  if (
    !exact(raw, counterNames, ['firstPlanFailure']) ||
    !counterNames
      .filter((key) => !['totalMs', 'maxMs', 'planOverflow', 'unsupportedOperations'].includes(key))
      .every((key) => integer(raw[key])) ||
    ![raw.totalMs, raw.maxMs].every((value) => Number.isFinite(value) && value >= 0) ||
    raw.maxMs > raw.totalMs ||
    typeof raw.planOverflow !== 'boolean' ||
    typeof raw.unsupportedOperations !== 'boolean' ||
    raw.retainedPlanBytes > 16384 ||
    raw.highWaterPlanBytes > 16384 ||
    raw.highWaterPlanBytes < raw.retainedPlanBytes ||
    raw.highWaterPlans > 64 ||
    raw.unacknowledgedPlans > 64 ||
    raw.unacknowledgedHighWaterPlans > 64 ||
    raw.unacknowledgedHighWaterPlans < raw.unacknowledgedPlans ||
    raw.highWaterPlans < raw.unacknowledgedHighWaterPlans ||
    raw.recordWatermark > raw.operations
  )
    invalidSqlite()
  const value = structuredClone(raw)
  if (value.firstPlanFailure !== undefined) {
    const f = value.firstPlanFailure
    if (
      !exact(f, [
        'reason',
        'sqlSha256',
        'sourceBytes',
        'operationIndex',
        'retainedPlans',
        'retainedPlanBytes',
        'planRows',
      ]) ||
      ![
        'statement-bytes',
        'plan-capacity',
        'plan-rows',
        'plan-detail',
        'plan-bytes',
        'explain-failed',
      ].includes(f.reason) ||
      !['sourceBytes', 'operationIndex', 'retainedPlans', 'retainedPlanBytes'].every((key) =>
        integer(f[key]),
      ) ||
      f.operationIndex < 1 ||
      f.operationIndex > value.operations ||
      f.retainedPlans > 64 ||
      f.retainedPlanBytes > 16384 ||
      !(f.planRows === null || (integer(f.planRows) && f.planRows <= 0xffffffff)) ||
      (f.sourceBytes > 8192
        ? f.reason !== 'statement-bytes' || f.sqlSha256 !== null
        : f.reason === 'statement-bytes' || !HASH.test(f.sqlSha256 ?? ''))
    )
      invalidSqlite()
  }
  return value
}
function monotonicCounters(previous, next) {
  if (!previous) return
  for (const key of [
    'operations',
    'transactions',
    'rowsReturned',
    'totalMs',
    'maxMs',
    'highWaterPlanBytes',
    'highWaterPlans',
    'unacknowledgedHighWaterPlans',
    'recordWatermark',
  ])
    if (next[key] < previous[key]) invalidSqlite()
  if (
    (previous.planOverflow && !next.planOverflow) ||
    (previous.unsupportedOperations && !next.unsupportedOperations) ||
    (previous.firstPlanFailure && !same(previous.firstPlanFailure, next.firstPlanFailure))
  )
    invalidSqlite()
}
function checkedFinal(value) {
  if (
    !exact(
      value,
      [
        'schemaVersion',
        'scope',
        'observerEpoch',
        'observerPid',
        'recordWatermark',
        'acknowledgedThrough',
        'pageSequence',
        'tailRecords',
        'counters',
        'databaseClosed',
        'writerClosed',
        'collectionDisposed',
      ],
      ['lastAck'],
    ) ||
    value.schemaVersion !== 1 ||
    value.scope !== SQLITE_SCOPE ||
    !EPOCH.test(value.observerEpoch ?? '') ||
    !integer(value.observerPid) ||
    value.observerPid < 1 ||
    value.observerPid > 0xffffffff ||
    !['recordWatermark', 'acknowledgedThrough', 'pageSequence'].every((key) =>
      integer(value[key]),
    ) ||
    value.acknowledgedThrough > value.recordWatermark ||
    !Array.isArray(value.tailRecords) ||
    value.tailRecords.length > 64 ||
    !['databaseClosed', 'writerClosed', 'collectionDisposed'].every(
      (key) => typeof value[key] === 'boolean',
    )
  )
    invalidSqlite()
  if (producerRecordBytes(value.tailRecords.map(planRecord)) > 16 * 1024) invalidSqlite()
  const counters = checkedCounters(value.counters)
  if (counters.recordWatermark !== value.recordWatermark) invalidSqlite()
  return {
    ...structuredClone(value),
    counters,
    tailRecords: value.tailRecords.map(planRecord),
    ...(value.lastAck ? { lastAck: ackValue(value.lastAck) } : {}),
  }
}
export function validateSqliteFinalReceipt(
  value,
  { nonce, mainPid, utilityPid, observerEpoch, manifest },
) {
  if (
    !exact(value, [
      'schemaVersion',
      'nonce',
      'mainPid',
      'utilityPid',
      'sourceSha',
      'version',
      'channel',
      'platform',
      'arch',
      'sqliteFinal',
    ]) ||
    value.schemaVersion !== 1 ||
    value.nonce !== nonce ||
    value.mainPid !== mainPid ||
    value.utilityPid !== utilityPid ||
    !integer(utilityPid) ||
    utilityPid < 1
  )
    invalidSqlite()
  for (const key of ['sourceSha', 'version', 'channel', 'platform', 'arch'])
    if (value[key] !== manifest[key]) invalidSqlite()
  const final = checkedFinal(value.sqliteFinal)
  if (final.observerPid !== utilityPid || final.observerEpoch !== observerEpoch) invalidSqlite()
  return final
}

export function validateSqliteSpoolFrame(value, manifest) {
  if (
    !exact(value, [
      'schemaVersion',
      'sourceSha',
      'version',
      'channel',
      'platform',
      'arch',
      'observerPid',
      'page',
    ]) ||
    value.schemaVersion !== 1 ||
    !integer(value.observerPid) ||
    value.observerPid < 1 ||
    value.observerPid > 0xffffffff ||
    Buffer.byteLength(JSON.stringify(value)) > 32768
  )
    invalidSqlite()
  for (const key of ['sourceSha', 'version', 'channel', 'platform', 'arch'])
    if (value[key] !== manifest[key]) invalidSqlite()
  return {
    schemaVersion: 1,
    sourceSha: value.sourceSha,
    version: value.version,
    channel: value.channel,
    platform: value.platform,
    arch: value.arch,
    observerPid: value.observerPid,
    page: checkedPage(value.page),
  }
}

/** One report owner retains the complete stream; producer/page residency remains 64, dictionary 32 KiB. */
export function resourceReportProjection({ reserve } = {}) {
  const queryPlans = [],
    indices = new Map()
  const sqliteObservation = { schemaVersion: 1, scope: SQLITE_SCOPE, epochs: [] }
  let draining = false
  const fit = (dictionary, epochs) => {
    if (Buffer.byteLength(JSON.stringify(dictionary)) > 32 * 1024)
      throw Object.assign(new Error('SQLite report plan dictionary exceeds its byte bound'), {
        code: 'SQLITE_DICTIONARY_CAPACITY',
      })
    if (
      Buffer.byteLength(
        JSON.stringify({
          queryPlans: dictionary,
          sqliteObservation: { ...sqliteObservation, epochs },
        }),
      ) >
      768 * 1024
    )
      throw Object.assign(new Error('SQLite observation report exceeds its byte bound'), {
        code: 'SQLITE_OBSERVATION_REPORT_CAPACITY',
      })
    if (
      Buffer.byteLength(
        JSON.stringify(
          { queryPlans: dictionary, sqliteObservation: { ...sqliteObservation, epochs } },
          null,
          2,
        ),
      ) +
        4096 >
      1024 * 1024
    )
      throw Object.assign(new Error('SQLite observation report exceeds its final byte bound'), {
        code: 'SQLITE_OBSERVATION_REPORT_CAPACITY',
      })
    reserve?.({ queryPlans: dictionary, sqliteObservation: { ...sqliteObservation, epochs } })
  }
  const commit = (dictionary, epochs) => {
    fit(dictionary, epochs)
    queryPlans.splice(0, queryPlans.length, ...dictionary)
    sqliteObservation.epochs.splice(0, sqliteObservation.epochs.length, ...epochs)
    indices.clear()
    for (const [index, record] of queryPlans.entries()) indices.set(JSON.stringify(record), index)
  }
  const withRecords = (records) => {
    const dictionary = [...queryPlans],
      planned = new Map(indices)
    const references = records.map((record) => {
      const stored = {
        schemaVersion: record.schemaVersion,
        sqlSha256: record.sqlSha256,
        details: [...record.details],
      }
      const key = JSON.stringify(stored)
      let index = planned.get(key)
      if (index === undefined) {
        index = dictionary.length
        dictionary.push(stored)
        planned.set(key, index)
      }
      return { recordSequence: record.recordSequence, queryPlanIndex: index }
    })
    return { dictionary, references }
  }
  const epochAt = (index) => {
    const epoch = sqliteObservation.epochs[index]
    if (!epoch || epoch.final) invalidSqlite()
    return epoch
  }
  const recordAt = (epoch, sequence) => {
    for (const page of epoch.pages) {
      const reference = page.records.find((record) => record.recordSequence === sequence)
      if (reference) return { recordSequence: sequence, ...queryPlans[reference.queryPlanIndex] }
    }
    return undefined
  }
  const acknowledge = (epoch, through, lastAck) => {
    if (through < epoch.acknowledgedThrough || through > epoch.savedThrough) invalidSqlite()
    if (!through) {
      if (lastAck !== undefined) invalidSqlite()
      return epoch
    }
    const ack = ackValue(lastAck)
    const page = epoch.pages.find((value) => value.pageSequence === ack.pageSequence)
    if (
      ack.observerEpoch !== epoch.observerEpoch ||
      !page ||
      page.payloadDigest !== ack.payloadDigest ||
      page.lastRecordSequence !== through
    )
      invalidSqlite()
    return {
      ...epoch,
      acknowledgedThrough: through,
      lastAck: ack,
      pages: epoch.pages.map((value) =>
        value.lastRecordSequence <= through ? { ...value, acknowledgementVerified: true } : value,
      ),
    }
  }
  const health = (response, phase, index) => {
    if (
      !response?.ok ||
      !integer(response.value?.pid) ||
      response.value.pid < 1 ||
      response.value.status !== 'ready' ||
      response.value.database !== 'ready' ||
      !/^[a-z-]{1,64}$/u.test(phase)
    )
      invalidSqlite()
    const raw = response.value.performance?.sqlite
    if (!raw || !Array.isArray(raw.queryPlans) || raw.queryPlans.length > 64) invalidSqlite()
    const { queryPlans: _inventory, planTransfer: transfer, ...rawCounters } = raw
    const counters = checkedCounters(rawCounters)
    if (
      !exact(
        transfer,
        ['observerEpoch', 'recordWatermark', 'acknowledgedThrough'],
        ['lastAck', 'page'],
      ) ||
      !EPOCH.test(transfer.observerEpoch ?? '') ||
      !integer(transfer.recordWatermark) ||
      !integer(transfer.acknowledgedThrough) ||
      transfer.acknowledgedThrough > transfer.recordWatermark ||
      transfer.recordWatermark !== counters.recordWatermark
    )
      invalidSqlite()
    if (
      counters.unacknowledgedPlans !== transfer.recordWatermark - transfer.acknowledgedThrough ||
      counters.highWaterPlans < raw.queryPlans.length
    )
      invalidSqlite()
    let epoch
    if (index === undefined) {
      if (
        sqliteObservation.epochs.length >= 2 ||
        sqliteObservation.epochs.some((value) => value.observerEpoch === transfer.observerEpoch) ||
        sqliteObservation.epochs.some((value) => !value.final)
      )
        invalidSqlite()
      index = sqliteObservation.epochs.length
      epoch = {
        observerEpoch: transfer.observerEpoch,
        observerPid: response.value.pid,
        savedThrough: 0,
        acknowledgedThrough: 0,
        pages: [],
        observations: [],
        drains: [],
      }
    } else epoch = epochAt(index)
    if (epoch.observerEpoch !== transfer.observerEpoch || epoch.observerPid !== response.value.pid)
      invalidSqlite()
    monotonicCounters(epoch.observations.at(-1)?.counters, counters)
    epoch = acknowledge(epoch, transfer.acknowledgedThrough, transfer.lastAck)
    const page = transfer.page === undefined ? undefined : checkedPage(transfer.page)
    if (
      page &&
      (page.observerEpoch !== epoch.observerEpoch ||
        page.firstRecordSequence !== transfer.acknowledgedThrough + 1 ||
        page.recordWatermark > transfer.recordWatermark ||
        page.operationWatermark > counters.operations)
    )
      invalidSqlite()
    if (!page && transfer.acknowledgedThrough !== transfer.recordWatermark) invalidSqlite()
    const prior = epoch.observations.at(-1)
    const mergeEmptyReads =
      !page &&
      prior?.phase === phase &&
      prior.acknowledgedThrough === transfer.acknowledgedThrough &&
      prior.counters.recordWatermark === counters.recordWatermark &&
      prior.counters.planOverflow === counters.planOverflow &&
      prior.counters.unsupportedOperations === counters.unsupportedOperations &&
      same(prior.counters.firstPlanFailure, counters.firstPlanFailure)
    const sample = mergeEmptyReads
      ? {
          ...prior,
          firstCounters: prior.firstCounters ?? prior.counters,
          counters,
          readCount: prior.readCount + 1,
        }
      : { phase, counters, acknowledgedThrough: transfer.acknowledgedThrough, readCount: 1 }
    if (!integer(sample.readCount)) invalidSqlite()
    epoch = {
      ...epoch,
      observations: mergeEmptyReads
        ? [...epoch.observations.slice(0, -1), sample]
        : [...epoch.observations, sample],
    }
    const epochs = [...sqliteObservation.epochs]
    epochs[index] = epoch
    commit(queryPlans, epochs)
    return { index, page, counters, transfer }
  }
  const storePage = async (index, page, persist) => {
    const epoch = epochAt(index)
    const known = epoch.pages.find((value) => value.pageSequence === page.pageSequence)
    if (known) {
      const records = known.records.map((reference) => ({
        recordSequence: reference.recordSequence,
        ...queryPlans[reference.queryPlanIndex],
      }))
      const { persistenceVerified: _p, acknowledgementVerified: _a, ...saved } = known
      if (!same(checkedPage({ ...saved, records }), page)) invalidSqlite()
      return
    }
    if (
      page.pageSequence !== epoch.pages.length + 1 ||
      page.firstRecordSequence !== epoch.savedThrough + 1
    )
      invalidSqlite()
    const { dictionary, references } = withRecords(page.records)
    const saved = {
      ...page,
      records: references,
      persistenceVerified: true,
      acknowledgementVerified: false,
    }
    const epochs = [...sqliteObservation.epochs]
    epochs[index] = {
      ...epoch,
      savedThrough: page.lastRecordSequence,
      pages: [...epoch.pages, saved],
    }
    fit(dictionary, epochs)
    if ((await persist(page)) !== true) throw new Error('SQLite page persistence was not confirmed')
    commit(dictionary, epochs)
  }
  const fail = (error) => {
    sqliteObservation.failure ??= [
      'SQLITE_DICTIONARY_CAPACITY',
      'SQLITE_OBSERVATION_REPORT_CAPACITY',
      'SQLITE_TRANSFER_DEADLINE',
    ].includes(error?.code)
      ? error.code
      : 'sqlite-stream-observation-incomplete'
  }
  return {
    queryPlans,
    sqliteObservation,
    project(utility) {
      if (!utility?.sqlite) return utility
      const { queryPlans: plans, planTransfer: _transfer, ...sqlite } = utility.sqlite
      if (
        !Array.isArray(plans) ||
        plans.length > 64 ||
        plans.some(
          (plan) =>
            !exact(plan, ['sqlSha256', 'details']) ||
            !HASH.test(plan.sqlSha256 ?? '') ||
            !Array.isArray(plan.details) ||
            plan.details.length > 64 ||
            plan.details.some(
              (detail) => typeof detail !== 'string' || Buffer.byteLength(detail) > 512,
            ),
        )
      )
        throw new Error('Invalid SQLite plan observation')
      return { ...utility, sqlite: { ...sqlite, retainedPlanCount: plans.length } }
    },
    async drainSqlite({ read, persist, phase, epochIndex, deadline = performance.now() + 5000 }) {
      if (draining) throw new Error('SQLite observation already has an active reader')
      draining = true
      let index = epochIndex,
        pending
      const boundedOperation = async (work) => {
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw deadlineError()
        let timer
        try {
          const result = await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(deadlineError()), remaining)
            }),
          ])
          if (performance.now() > deadline) throw deadlineError()
          return result
        } finally {
          clearTimeout(timer)
        }
      }
      const boundedRead = (ack) => boundedOperation(() => read({ sqlitePlans: ack ? { ack } : {} }))
      try {
        for (let round = 0; round < 64; round++) {
          let response
          try {
            response = await boundedRead(pending)
          } catch (error) {
            if (!pending) throw error
            response = await boundedRead()
          }
          if (
            response?.ok === false &&
            pending &&
            ['TIMEOUT', 'RUNTIME_UNAVAILABLE'].includes(response.error?.code)
          )
            response = await boundedRead()
          const observed = health(response, phase, index)
          index = observed.index
          const epoch = epochAt(index)
          if (
            pending &&
            observed.transfer.acknowledgedThrough <
              epoch.pages.find((page) => page.pageSequence === pending.pageSequence)
                .lastRecordSequence
          ) {
            if (
              !observed.page ||
              observed.page.pageSequence !== pending.pageSequence ||
              observed.page.payloadDigest !== pending.payloadDigest
            )
              invalidSqlite()
          }
          if (observed.page) {
            await storePage(index, observed.page, (page) => boundedOperation(() => persist(page)))
            pending = {
              observerEpoch: observed.page.observerEpoch,
              pageSequence: observed.page.pageSequence,
              payloadDigest: observed.page.payloadDigest,
            }
          } else {
            if (
              observed.counters.planOverflow ||
              observed.counters.unsupportedOperations ||
              observed.counters.firstPlanFailure
            )
              throw new Error('SQLite producer reported incomplete collection')
            const current = epochAt(index),
              epochs = [...sqliteObservation.epochs]
            const lastDrain = current.drains.at(-1)
            const mergeDrains =
              lastDrain?.phase === phase &&
              lastDrain.recordWatermark === observed.transfer.recordWatermark &&
              lastDrain.acknowledgedThrough === observed.transfer.acknowledgedThrough
            const drain = {
              phase,
              recordWatermark: observed.transfer.recordWatermark,
              acknowledgedThrough: observed.transfer.acknowledgedThrough,
              firstOperationWatermark: mergeDrains
                ? lastDrain.firstOperationWatermark
                : observed.counters.operations,
              operationWatermark: observed.counters.operations,
              occurrences: mergeDrains ? lastDrain.occurrences + 1 : 1,
            }
            if (!integer(drain.occurrences)) invalidSqlite()
            epochs[index] = {
              ...current,
              drains: mergeDrains
                ? [...current.drains.slice(0, -1), drain]
                : [...current.drains, drain],
            }
            commit(queryPlans, epochs)
            return index
          }
          if (
            observed.counters.planOverflow ||
            observed.counters.unsupportedOperations ||
            observed.counters.firstPlanFailure
          )
            throw new Error('SQLite producer reported incomplete collection')
        }
        throw new Error('SQLite transfer round bound exceeded')
      } catch (error) {
        fail(error)
        // oxlint-disable-next-line eslint/preserve-caught-error -- Raw transport/filesystem errors may contain private receipt paths or the CDP capability.
        throw new Error('SQLite observation transfer is incomplete')
      } finally {
        draining = false
      }
    },
    async recoverPage(frame, manifest) {
      const recovered = validateSqliteSpoolFrame(frame, manifest)
      let index = sqliteObservation.epochs.findIndex(
        (epoch) => epoch.observerEpoch === recovered.page.observerEpoch,
      )
      if (index < 0) {
        if (sqliteObservation.epochs.length >= 2) invalidSqlite()
        index = sqliteObservation.epochs.length
        commit(queryPlans, [
          ...sqliteObservation.epochs,
          {
            observerEpoch: recovered.page.observerEpoch,
            observerPid: recovered.observerPid,
            savedThrough: 0,
            acknowledgedThrough: 0,
            pages: [],
            observations: [],
            drains: [],
            recoveryOnly: true,
          },
        ])
      }
      const epoch = epochAt(index)
      if (!epoch.recoveryOnly || epoch.observerPid !== recovered.observerPid) invalidSqlite()
      await storePage(index, recovered.page, async () => true)
    },
    sealSqlite(index, value, { physicalGroupGone, identityVerified }) {
      try {
        const final = checkedFinal(value),
          current = epochAt(index)
        if (
          !physicalGroupGone ||
          !identityVerified ||
          final.observerEpoch !== current.observerEpoch ||
          final.observerPid !== current.observerPid ||
          final.pageSequence !== current.pages.length
        )
          invalidSqlite()
        monotonicCounters(current.observations.at(-1)?.counters, final.counters)
        let epoch = acknowledge(current, final.acknowledgedThrough, final.lastAck)
        if (
          final.tailRecords.length !== final.recordWatermark - final.acknowledgedThrough ||
          final.tailRecords.some(
            (record, offset) => record.recordSequence !== final.acknowledgedThrough + offset + 1,
          )
        )
          invalidSqlite()
        for (const record of final.tailRecords)
          if (
            record.recordSequence <= epoch.savedThrough &&
            !same(recordAt(epoch, record.recordSequence), record)
          )
            invalidSqlite()
        const { dictionary, references } = withRecords(final.tailRecords)
        const { tailRecords: _tail, ...metadata } = final
        const epochs = [...sqliteObservation.epochs]
        epochs[index] = {
          ...epoch,
          final: {
            ...metadata,
            tailRecords: references,
            physicalGroupGone: true,
            identityVerified: true,
          },
        }
        commit(dictionary, epochs)
      } catch (error) {
        fail(error)
        // oxlint-disable-next-line eslint/preserve-caught-error -- Final receipt failures must retain only the fixed safe diagnostic category.
        throw new Error('SQLite final observation is incomplete')
      }
    },
  }
}

/** Recovery uses the same archive but cannot manufacture observations, ACKs or a final seal. */
export async function recoverSqlitePages(frames, manifest) {
  if (!Array.isArray(frames) || Buffer.byteLength(JSON.stringify(frames)) > 768 * 1024)
    invalidSqlite()
  const normalized = frames.map((frame) => validateSqliteSpoolFrame(frame, manifest))
  normalized.sort(
    (a, b) =>
      a.page.observerEpoch.localeCompare(b.page.observerEpoch) ||
      a.page.pageSequence - b.page.pageSequence,
  )
  const archive = resourceReportProjection()
  for (const frame of normalized) await archive.recoverPage(frame, manifest)
  return {
    schemaVersion: 1,
    status: 'unsealed-recovered-prefix',
    sourceSha: manifest.sourceSha,
    ordering: 'per-epoch-prefix-without-global-lifecycle-order',
    sqliteQueryPlanDictionary: archive.queryPlans,
    sqliteObservation: archive.sqliteObservation,
  }
}

export function completeSqliteObservation(evidence) {
  try {
    const dictionary = evidence.sqliteQueryPlanDictionary,
      observation = evidence.sqliteObservation
    if (
      !Array.isArray(dictionary) ||
      !dictionary.length ||
      Buffer.byteLength(JSON.stringify(dictionary)) > 32768 ||
      !exact(observation, ['schemaVersion', 'scope', 'epochs'], ['failure']) ||
      observation.schemaVersion !== 1 ||
      observation.scope !== SQLITE_SCOPE ||
      observation.failure ||
      !Array.isArray(observation.epochs) ||
      observation.epochs.length !== 2
    )
      return false
    dictionary.forEach((record) => {
      if (!exact(record, ['schemaVersion', 'sqlSha256', 'details'])) invalidSqlite()
      planRecord({ recordSequence: 1, ...record })
    })
    if (
      new Set(
        dictionary.map((record) =>
          JSON.stringify({
            schemaVersion: record.schemaVersion,
            sqlSha256: record.sqlSha256,
            details: record.details,
          }),
        ),
      ).size !== dictionary.length
    )
      return false
    const epochs = new Set()
    for (const epoch of observation.epochs) {
      if (
        !EPOCH.test(epoch.observerEpoch ?? '') ||
        epochs.has(epoch.observerEpoch) ||
        !integer(epoch.observerPid) ||
        epoch.observerPid < 1 ||
        !Array.isArray(epoch.pages) ||
        !Array.isArray(epoch.observations) ||
        !epoch.observations.length ||
        !Array.isArray(epoch.drains) ||
        !epoch.drains.length ||
        !integer(epoch.savedThrough) ||
        !integer(epoch.acknowledgedThrough)
      )
        return false
      epochs.add(epoch.observerEpoch)
      let through = 0,
        ackedThrough = 0,
        previousCounters
      const records = new Map()
      const expand = (references) =>
        references.map((reference) => {
          if (
            !exact(reference, ['recordSequence', 'queryPlanIndex']) ||
            !integer(reference.queryPlanIndex) ||
            reference.queryPlanIndex >= dictionary.length
          )
            invalidSqlite()
          return planRecord({
            recordSequence: reference.recordSequence,
            ...dictionary[reference.queryPlanIndex],
          })
        })
      for (const [index, page] of epoch.pages.entries()) {
        const { persistenceVerified, acknowledgementVerified, ...metadata } = page
        if (persistenceVerified !== true || typeof acknowledgementVerified !== 'boolean')
          return false
        const payload = checkedPage({ ...metadata, records: expand(page.records) })
        if (
          payload.observerEpoch !== epoch.observerEpoch ||
          payload.pageSequence !== index + 1 ||
          payload.firstRecordSequence !== through + 1
        )
          return false
        through = payload.lastRecordSequence
        for (const record of payload.records) records.set(record.recordSequence, record)
        if (acknowledgementVerified) ackedThrough = through
      }
      if (
        through !== epoch.savedThrough ||
        ackedThrough !== epoch.acknowledgedThrough ||
        epoch.pages.some(
          (page) =>
            page.acknowledgementVerified !== page.lastRecordSequence <= epoch.acknowledgedThrough,
        )
      )
        return false
      let observedAckThrough = 0
      for (const sample of epoch.observations) {
        if (
          !exact(
            sample,
            ['phase', 'counters', 'acknowledgedThrough', 'readCount'],
            ['firstCounters'],
          ) ||
          !/^[a-z-]{1,64}$/u.test(sample.phase) ||
          !integer(sample.acknowledgedThrough) ||
          sample.acknowledgedThrough < observedAckThrough ||
          sample.acknowledgedThrough > epoch.acknowledgedThrough ||
          (sample.acknowledgedThrough &&
            !epoch.pages.some((page) => page.lastRecordSequence === sample.acknowledgedThrough))
        )
          return false
        observedAckThrough = sample.acknowledgedThrough
        const counters = checkedCounters(sample.counters)
        if (
          !integer(sample.readCount) ||
          sample.readCount < 1 ||
          (sample.readCount === 1
            ? sample.firstCounters !== undefined
            : sample.firstCounters === undefined)
        )
          return false
        if (sample.firstCounters) {
          const first = checkedCounters(sample.firstCounters)
          monotonicCounters(previousCounters, first)
          monotonicCounters(first, counters)
          if (
            first.recordWatermark !== counters.recordWatermark ||
            first.planOverflow !== counters.planOverflow ||
            first.unsupportedOperations !== counters.unsupportedOperations ||
            !same(first.firstPlanFailure, counters.firstPlanFailure)
          )
            return false
        }
        monotonicCounters(previousCounters, counters)
        previousCounters = counters
        if (counters.planOverflow || counters.unsupportedOperations || counters.firstPlanFailure)
          return false
      }
      const rawFinal = epoch.final
      if (!rawFinal || rawFinal.physicalGroupGone !== true || rawFinal.identityVerified !== true)
        return false
      const { physicalGroupGone: _group, identityVerified: _identity, ...fields } = rawFinal
      const final = checkedFinal({ ...fields, tailRecords: expand(rawFinal.tailRecords) })
      monotonicCounters(previousCounters, final.counters)
      if (
        final.observerEpoch !== epoch.observerEpoch ||
        final.observerPid !== epoch.observerPid ||
        final.pageSequence !== epoch.pages.length ||
        !final.databaseClosed ||
        !final.writerClosed ||
        !final.collectionDisposed ||
        final.counters.retainedPlanBytes !== 0 ||
        final.counters.unacknowledgedPlans !== 0 ||
        final.counters.planOverflow ||
        final.counters.unsupportedOperations ||
        final.counters.firstPlanFailure ||
        final.recordWatermark < 1 ||
        final.acknowledgedThrough !== epoch.acknowledgedThrough
      )
        return false
      if (!same(epoch.lastAck, final.lastAck)) return false
      if (final.acknowledgedThrough) {
        const ack = ackValue(final.lastAck),
          page = epoch.pages[ack.pageSequence - 1]
        if (
          ack.observerEpoch !== epoch.observerEpoch ||
          !page ||
          page.payloadDigest !== ack.payloadDigest ||
          page.lastRecordSequence !== final.acknowledgedThrough
        )
          return false
      } else if (final.lastAck) return false
      if (final.tailRecords.length !== final.recordWatermark - final.acknowledgedThrough)
        return false
      for (const [offset, record] of final.tailRecords.entries()) {
        if (
          record.recordSequence !== final.acknowledgedThrough + offset + 1 ||
          (records.has(record.recordSequence) && !same(records.get(record.recordSequence), record))
        )
          return false
        records.set(record.recordSequence, record)
      }
      if (
        records.size !== final.recordWatermark ||
        [...records.keys()].some((sequence, index) => sequence !== index + 1)
      )
        return false
      for (const drain of epoch.drains)
        if (
          !exact(drain, [
            'phase',
            'recordWatermark',
            'acknowledgedThrough',
            'firstOperationWatermark',
            'operationWatermark',
            'occurrences',
          ]) ||
          !/^[a-z-]{1,64}$/u.test(drain.phase) ||
          ![
            drain.recordWatermark,
            drain.acknowledgedThrough,
            drain.firstOperationWatermark,
            drain.operationWatermark,
            drain.occurrences,
          ].every(integer) ||
          drain.occurrences < 1 ||
          drain.firstOperationWatermark > drain.operationWatermark ||
          drain.recordWatermark !== drain.acknowledgedThrough ||
          drain.operationWatermark > final.counters.operations ||
          drain.recordWatermark > final.recordWatermark
        )
          return false
    }
    return observation.epochs[0].drains.some(
      (value) => value.phase === 'before-send' && value.recordWatermark > 0,
    )
  } catch {
    return false
  }
}

export function observe(histogramValue, milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || histogramValue.count >= 1_000_000)
    throw new Error('Soak observation is invalid or exceeds its sample bound')
  histogramValue.bins[Math.min(1000, Math.ceil(milliseconds))]++
  histogramValue.count++
  histogramValue.maximum = Math.max(histogramValue.maximum, milliseconds)
}

export function percentile(histogramValue, percent) {
  if (
    !histogramValue ||
    !Number.isSafeInteger(histogramValue.count) ||
    histogramValue.count < 1 ||
    histogramValue.bins.length !== 1001 ||
    percent <= 0 ||
    percent > 100
  )
    return null
  const target = Math.ceil((histogramValue.count * percent) / 100)
  let total = 0
  for (let index = 0; index < histogramValue.bins.length; index++) {
    const count = histogramValue.bins[index]
    if (!Number.isSafeInteger(count) || count < 0) return null
    total += count
    if (total >= target) return index === 1000 ? Math.max(index, histogramValue.maximum) : index
  }
  return null
}

// Report JSON is a distinct trust seam from the application's typed health contract. Validate
// fixed owner/category metadata again, including the warm-start baseline; a missing[] assertion
// cannot supply evidence. Current producers deliberately remain incomplete for unobserved hops.
function completeLogicalIpcTraffic(evidence, requestedDurationMs) {
  const ipc = evidence.ipcTraffic
  const unit = 'json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1'
  if (
    !ipc ||
    ipc.unit !== unit ||
    ipc.observed !== true ||
    ipc.complete !== true ||
    !Array.isArray(ipc.issues) ||
    ipc.issues.length !== 0 ||
    !Number.isSafeInteger(ipc.observedDurationMs) ||
    ipc.observedDurationMs < requestedDurationMs
  )
    return false
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
  const totals = (snapshot) => {
    if (
      !snapshot ||
      snapshot.schemaVersion !== 1 ||
      snapshot.unit !== unit ||
      snapshot.complete !== true ||
      !Array.isArray(snapshot.uncovered) ||
      snapshot.uncovered.length !== 0 ||
      !Array.isArray(snapshot.owners) ||
      snapshot.owners.length !== 9
    )
      return undefined
    const owners = new Set(),
      sum = { business: 0, control: 0 }
    for (const owner of snapshot.owners) {
      if (
        !owner ||
        typeof owner !== 'object' ||
        Array.isArray(owner) ||
        typeof owner.owner !== 'string' ||
        !Object.hasOwn(categories, owner.owner)
      )
        return undefined
      const allowed = categories[owner.owner]
      if (
        !allowed ||
        owners.has(owner.owner) ||
        owner.complete !== true ||
        typeof owner.epoch !== 'string' ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(
          owner.epoch,
        ) ||
        !Number.isSafeInteger(owner.transportEpoch) ||
        owner.transportEpoch < 1 ||
        owner.transportEpoch > 64 ||
        ![
          'startedTransports',
          'settledTransports',
          'activeTransports',
          'highWaterTransports',
        ].every((key) => Number.isSafeInteger(owner[key]) && owner[key] >= 0) ||
        owner.startedTransports > 1_000_000 ||
        owner.settledTransports > 1_000_000 ||
        owner.activeTransports > 64 ||
        owner.highWaterTransports > 64 ||
        owner.startedTransports - owner.settledTransports !== owner.activeTransports ||
        owner.highWaterTransports < owner.activeTransports ||
        !Array.isArray(owner.issues) ||
        owner.issues.length !== 0 ||
        !Array.isArray(owner.counters) ||
        owner.counters.length !== allowed.length
      )
        return undefined
      owners.add(owner.owner)
      const seen = new Set()
      let messages = 0
      for (const row of owner.counters) {
        if (
          !row ||
          typeof row !== 'object' ||
          Array.isArray(row) ||
          !allowed.includes(row.category) ||
          seen.has(row.category)
        )
          return undefined
        seen.add(row.category)
        for (const lane of ['business', 'control']) {
          const counts = row[lane]
          if (
            !counts ||
            !['messages', 'incompleteMessages', 'jsonBytes', 'binaryBytes', 'totalBytes'].every(
              (key) => Number.isSafeInteger(counts[key]) && counts[key] >= 0,
            ) ||
            counts.incompleteMessages !== 0 ||
            counts.totalBytes !== counts.jsonBytes + counts.binaryBytes
          )
            return undefined
          messages += counts.messages
          sum[lane] += counts.totalBytes
          if (messages > 1_000_000 || !Number.isSafeInteger(sum[lane])) return undefined
        }
      }
    }
    return Number.isSafeInteger(sum.business + sum.control) ? sum : undefined
  }
  const before = totals(ipc.baseline),
    after = totals(ipc.snapshot)
  if (!before || !after) return false
  for (const owner of ipc.snapshot.owners) {
    const initial = ipc.baseline.owners.find((value) => value.owner === owner.owner)
    // A generation change needs per-generation coverage proof that this report does not yet
    // carry. Refuse the window instead of inferring continuity from a later cumulative number.
    if (
      !initial ||
      initial.epoch !== owner.epoch ||
      initial.transportEpoch !== owner.transportEpoch ||
      owner.startedTransports < initial.startedTransports ||
      owner.settledTransports < initial.settledTransports ||
      owner.highWaterTransports < initial.highWaterTransports
    )
      return false
    for (const row of owner.counters) {
      const previous = initial.counters.find((value) => value.category === row.category)
      if (!previous) return false
      for (const lane of ['business', 'control'])
        for (const key of ['messages', 'jsonBytes', 'binaryBytes', 'totalBytes'])
          if (row[lane][key] < previous[lane][key]) return false
    }
  }
  return (
    Number.isSafeInteger(ipc.businessBytes) &&
    Number.isSafeInteger(ipc.controlBytes) &&
    ipc.businessBytes === after.business - before.business &&
    ipc.controlBytes === after.control - before.control
  )
}

export function evaluateSoak(evidence, requestedDurationMs) {
  const unmet = []
  if (!completeSqliteObservation(evidence)) unmet.push('complete-sqlite-observation')
  if (!completeLogicalIpcTraffic(evidence, requestedDurationMs))
    unmet.push('complete-logical-ipc-traffic')
  const threshold = (name, value, maximum) => {
    if (!Number.isFinite(value) || value > maximum) unmet.push(name)
  }
  if (
    !Number.isFinite(evidence.durationMs) ||
    evidence.durationMs < requestedDurationMs ||
    requestedDurationMs < 3_600_000
  )
    unmet.push('continuous-required-duration')
  if (
    !Number.isSafeInteger(evidence.retainedMessages) ||
    evidence.retainedMessages < 1000 ||
    (evidence.inputPaint?.count ?? 0) < 100
  )
    unmet.push('1000-retained-message-composer-fixture')
  threshold('composer-p95-50ms', percentile(evidence.inputPaint, 95), 50)
  threshold('composer-p99-100ms', percentile(evidence.inputPaint, 99), 100)
  threshold('renderer-event-loop-p95-50ms', percentile(evidence.rendererEventLoop, 95), 50)
  if ((evidence.rendererEventLoop?.count ?? 0) < 100) unmet.push('renderer-event-loop-sample-count')
  threshold('utility-event-loop-p95-50ms', evidence.utilityEventLoopLagP95Ms, 50)
  threshold('native-terminal-to-composer-p95-100ms', percentile(evidence.terminalEnable, 95), 100)
  if ((evidence.terminalEnable?.count ?? 0) < 30) unmet.push('terminal-enable-sample-count')
  if (evidence.sustainedLongTasks !== 0 || evidence.unexplainedLongTasksOver200Ms !== 0)
    unmet.push('long-task-budget')
  if (evidence.cleanupVerified !== true) unmet.push('physical-process-and-temporary-cleanup')
  if (evidence.recoveryVerified !== true) unmet.push('cold-restart-durable-recovery')
  if (evidence.resourceLifecycleVerified !== true) unmet.push('complete-owned-resource-lifecycle')
  if (!reactCommitObservationComplete(evidence.reactCommits)) unmet.push('react-commit-counts')
  for (const missing of evidence.missingObservations ?? []) unmet.push(`unobserved:${missing}`)
  return { budgetPass: unmet.length === 0, unmetBudgets: [...new Set(unmet)] }
}

export function validateReceipt(receipt, { nonce, mainPid, port, manifest }) {
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    receipt.nonce !== nonce ||
    receipt.mainPid !== mainPid ||
    receipt.port !== port ||
    !Number.isSafeInteger(receipt.windowId) ||
    !Number.isSafeInteger(receipt.webContentsId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(receipt.targetId ?? '') ||
    receipt.url !== 'app://bundle/index.html'
  )
    throw new Error('Soak receipt does not prove the exact owned Main/window/target')
  for (const key of ['sourceSha', 'version', 'channel', 'platform', 'arch'])
    if (receipt[key] !== manifest[key])
      throw new Error('Soak receipt distribution identity mismatch')
}
