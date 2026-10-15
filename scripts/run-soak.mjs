import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, lstat, opendir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { applicationContent } from './build-distribution.mjs'
import { ciEnvironment } from './ci.mjs'
import { readE2EJson } from './e2e-report.mjs'
import { prepareApplication, readDistributionManifest } from './package-smoke.mjs'
import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'
import { evaluateSoak, recoverSqlitePages, validateSqliteSpoolFrame } from './soak-statistics.mjs'

const number = (v) => Number.isFinite(v) && v >= 0,
  integer = (v) => Number.isSafeInteger(v) && v >= 0,
  boolean = (v) => typeof v === 'boolean',
  literal =
    (...allowed) =>
    (v) =>
      allowed.includes(v),
  text =
    (pattern, bytes = 128) =>
    (v) =>
      typeof v === 'string' && Buffer.byteLength(v) <= bytes && pattern.test(v),
  hash = text(/^[a-f\d]{64}$/u),
  epoch = text(/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/u),
  id = text(/^[a-zA-Z\d._:-]{1,128}$/u),
  label = text(/^[a-z][a-z\d-]{0,79}$/u),
  nullable = (schema) => (v) => v === null || schema(v),
  array = (schema, maximum) => (v) => Array.isArray(v) && v.length <= maximum && v.every(schema),
  object = (fields) => (v) =>
    v !== null &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.entries(v).every(([key, entry]) => Object.hasOwn(fields, key) && fields[key](entry)),
  numbers = (...keys) => Object.fromEntries(keys.map((key) => [key, number]))

/** The driver's private JSON is a trust boundary, including on failed runs. No open objects. */
export function validateSoakObservation(value) {
  const histogram = object({ bins: array(integer, 1001), count: integer, maximum: number })
  const conversation = object(
    numbers(
      'interestedSessions',
      'suppressedProgress',
      'publishedProgress',
      'activeExecutions',
      'pendingStreamItems',
      'preparingExecutions',
      'nativeRebuilds',
      'nativeForks',
      'forkPreparations',
      'adapterSlots',
      'completeReads',
    ),
  )
  const ack = object({ observerEpoch: epoch, pageSequence: integer, payloadDigest: hash })
  const counters = object({
    ...numbers(
      'operations',
      'transactions',
      'rowsReturned',
      'totalMs',
      'maxMs',
      'retainedPlanBytes',
      'highWaterPlanBytes',
      'highWaterPlans',
      'unacknowledgedPlans',
      'unacknowledgedHighWaterPlans',
      'recordWatermark',
      'retainedPlanCount',
    ),
    planOverflow: boolean,
    unsupportedOperations: boolean,
    firstPlanFailure: object({
      reason: literal(
        'statement-bytes',
        'plan-capacity',
        'plan-rows',
        'plan-detail',
        'plan-bytes',
        'explain-failed',
      ),
      sqlSha256: nullable(hash),
      sourceBytes: integer,
      operationIndex: integer,
      retainedPlans: integer,
      retainedPlanBytes: integer,
      planRows: nullable(integer),
    }),
  })
  const reference = object({ recordSequence: integer, queryPlanIndex: integer })
  const resourceNames = new Set([
    'Timeout',
    'Immediate',
    'MessagePort',
    'PipeWrap',
    'TCPServerWrap',
    'TCPSocketWrap',
    'UDPWrap',
    'FSReqCallback',
    'FSReqPromise',
    'FileHandle',
    'FileHandleCloseReq',
    'ProcessWrap',
    'SignalWrap',
    'TTYWrap',
    'ConnectWrap',
    'ShutdownWrap',
    'WriteWrap',
  ])
  const resources = (v) =>
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.entries(v).every(([key, count]) => resourceNames.has(key) && integer(count))
  const nativeMemory = object({
    unit: literal('native-working-reservations-v1'),
    observationsComplete: boolean,
    ...Object.fromEntries(
      [
        'chargedBytes',
        'reservationItems',
        'highWaterBytes',
        'highWaterItems',
        'acquiredBytes',
        'releasedBytes',
        'acquiredItems',
        'releasedItems',
      ].map((key) => [key, nullable(integer)]),
    ),
  })
  const utility = object({
    ...numbers(
      'eventLoopLagP95Ms',
      'eventLoopSamples',
      'databaseBytes',
      'walBytes',
      'resourceHighWater',
    ),
    activeResources: resources,
    resourceCapacityExceeded: boolean,
    nativeMemory,
    sqlite: counters,
  })
  const phase = label
  const page = object({
    observerEpoch: epoch,
    pageSequence: integer,
    firstRecordSequence: integer,
    lastRecordSequence: integer,
    operationWatermark: integer,
    recordWatermark: integer,
    payloadDigest: hash,
    records: array(reference, 64),
    persistenceVerified: boolean,
    acknowledgementVerified: boolean,
  })
  const final = object({
    schemaVersion: literal(1),
    scope: literal('post-open-native-run-get-all-and-drizzle-transaction-attempts-v1'),
    observerEpoch: epoch,
    observerPid: integer,
    recordWatermark: integer,
    acknowledgedThrough: integer,
    pageSequence: integer,
    lastAck: ack,
    tailRecords: array(reference, 64),
    counters,
    databaseClosed: boolean,
    writerClosed: boolean,
    collectionDisposed: boolean,
    physicalGroupGone: boolean,
    identityVerified: boolean,
  })
  const lane = object(
    numbers('messages', 'incompleteMessages', 'jsonBytes', 'binaryBytes', 'totalBytes'),
  )
  const ipcIssue = literal(
    'invalid_limits',
    'byte_limit',
    'node_limit',
    'depth_limit',
    'unsupported_value',
    'unsupported_prototype',
    'unsupported_binary',
    'accessor',
    'to_json',
    'cycle',
    'uninspectable',
    'counter_overflow',
    'epoch_limit',
    'invalid_epoch',
    'unvalidated_message',
    'transport_error',
    'unknown_category',
    'disposed',
    'cleanup_unavailable',
    'missing-observation',
    'incomplete-observation',
    'counter-regression',
    'epoch-changed',
  )
  const ipcUnit = literal(
    'json-utf8-regexp-source-flags-null-binary-skeleton-plus-visible-binary-bytes-v1',
  )
  const owners = [
    'renderer-bridge',
    'main-utility',
    'main-directory',
    'utility-markdown',
    'utility-image',
    'utility-native-json',
    'utility-native-fork',
    'main-diagnostic-log',
    'renderer-monaco',
  ]
  const uncovered = [
    'renderer-main-bridge',
    'main-utility-diagnostic-control',
    'main-directory-worker',
    'utility-markdown-worker',
    'utility-image-codec-worker',
    'utility-native-json-worker',
    'utility-native-fork-worker',
    'main-diagnostic-log-worker',
    'renderer-monaco-workers',
  ]
  const projectedIssue = (v) =>
    [
      'missing-or-invalid-ipc-observation',
      'ipc-total-overflow',
      'missing-ipc-owner',
      'partial-ipc-coverage',
    ].includes(v) ||
    uncovered.some((hop) => v === `uncovered:${hop}`) ||
    owners.some(
      (owner) =>
        typeof v === 'string' &&
        v.startsWith(`${owner}:`) &&
        (ipcIssue(v.slice(owner.length + 1)) ||
          ['epoch-reset', 'lifecycle-reset', 'counter-reset', 'missing-owner'].includes(
            v.slice(owner.length + 1),
          )),
    )
  const ipcSnapshot = object({
    schemaVersion: literal(1),
    unit: ipcUnit,
    complete: boolean,
    uncovered: array(literal(...uncovered), 9),
    owners: array(
      object({
        owner: literal(...owners),
        epoch: nullable(epoch),
        complete: boolean,
        ...numbers(
          'transportEpoch',
          'startedTransports',
          'settledTransports',
          'activeTransports',
          'highWaterTransports',
        ),
        issues: array(ipcIssue, 19),
        counters: array(
          object({ category: text(/^[a-z-]+\.[a-z-]+$/u), business: lane, control: lane }),
          9,
        ),
      }),
      9,
    ),
  })
  const schema = object({
    durationMs: integer,
    retainedMessages: integer,
    terminalEnable: histogram,
    utilityEventLoopLagP95Ms: nullable(number),
    cleanupVerified: boolean,
    recoveryVerified: boolean,
    resourceLifecycleVerified: boolean,
    missingObservations: array(label, 64),
    inputPaint: histogram,
    rendererEventLoop: histogram,
    frameIntervals: histogram,
    sustainedLongTasks: integer,
    unexplainedLongTasksOver200Ms: integer,
    ownedProcessHighWater: integer,
    ownedProcessFinal: nullable(integer),
    resourceHighWater: conversation,
    resourceFinal: conversation,
    resourceSamples: array(
      object({
        elapsedMs: integer,
        conversation,
        utility,
        processes: array(
          object({
            pid: integer,
            type: literal(
              'browser',
              'renderer',
              'GPU',
              'utility',
              'other',
              'network.mojom.NetworkService',
              'node.mojom.NodeService',
              'storage.mojom.StorageService',
              'audio.mojom.AudioService',
              'video_capture.mojom.VideoCaptureService',
            ),
            cpuSeconds: number,
            rssBytes: number,
          }),
          256,
        ),
      }),
      256,
    ),
    sqliteQueryPlanDictionary: array(
      object({
        schemaVersion: integer,
        sqlSha256: hash,
        details: array(text(/^[^\r\n\0]*$/u, 512), 64),
      }),
      4096,
    ),
    sqliteObservation: object({
      schemaVersion: literal(1),
      scope: literal('post-open-native-run-get-all-and-drizzle-transaction-attempts-v1'),
      failure: literal(
        'SQLITE_DICTIONARY_CAPACITY',
        'SQLITE_OBSERVATION_REPORT_CAPACITY',
        'SQLITE_TRANSFER_DEADLINE',
        'sqlite-stream-observation-incomplete',
      ),
      epochs: array(
        object({
          observerEpoch: epoch,
          observerPid: integer,
          savedThrough: integer,
          acknowledgedThrough: integer,
          lastAck: ack,
          pages: array(page, 4096),
          final,
          observations: array(
            object({
              phase,
              counters,
              firstCounters: counters,
              acknowledgedThrough: integer,
              readCount: integer,
            }),
            4096,
          ),
          drains: array(
            object({
              phase,
              recordWatermark: integer,
              acknowledgedThrough: integer,
              firstOperationWatermark: integer,
              operationWatermark: integer,
              occurrences: integer,
            }),
            4096,
          ),
        }),
        2,
      ),
    }),
    ipcTraffic: object({
      unit: ipcUnit,
      observed: boolean,
      complete: boolean,
      ...numbers(
        'observedDurationMs',
        'businessBytes',
        'controlBytes',
        'businessBytesPerSecond',
        'controlBytesPerSecond',
      ),
      issues: array(projectedIssue, 64),
      baseline: ipcSnapshot,
      snapshot: ipcSnapshot,
    }),
    reactCommits: object({
      schemaVersion: literal(1),
      status: literal('observed', 'pending', 'blocked'),
      injectedRenderers: integer,
      initialMountCommits: integer,
      workloadCommits: integer,
      cleanupVerified: boolean,
      reason: label,
    }),
    recovery: object({
      beforeHash: hash,
      afterHash: hash,
      latestRunId: id,
      nativeSessionId: id,
      nativeTurnId: id,
      changed: array(literal('runId', 'nativeSessionId', 'nativeTurnId', 'messages'), 4),
    }),
    rendererFailureState: object({
      previewMounted: boolean,
      previewUnavailable: boolean,
      monacoEditors: integer,
      monacoRows: integer,
      plainEditors: integer,
      composerEnabled: boolean,
    }),
    failureStage: phase,
    sqliteFinalFailure: boolean,
    failure: literal(
      'Continuous packaged workload or recovery observation failed',
      'SQLite final observation could not be verified',
      'Continuous observation report exceeded its byte bound',
    ),
  })
  if (!schema(value)) throw new Error('Soak observation has invalid or unrecognized fields')
  return structuredClone(value)
}

/** Recover only verified, non-secret pages after a driver crash; never invent ACKs or final seals. */
export async function recoverSoakSqlitePrefix(root, manifest) {
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('SQLite recovery root identity invalid')
  const directory = join(await realpath(root), 'fixture')
  try {
    await lstat(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  const info = await lstat(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error('SQLite recovery directory identity invalid')
  const entries = await opendir(directory)
  const frames = []
  let bytes = 0,
    count = 0
  for await (const entry of entries) {
    if (++count > 4096) throw new Error('SQLite recovery directory exceeds its entry bound')
    if (!entry.name.startsWith('sqlite-page-')) continue
    const match =
      /^sqlite-page-([a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})-([1-9]\d{0,15})\.json$/u.exec(
        entry.name,
      )
    if (!match || !entry.isFile() || entry.isSymbolicLink())
      throw new Error('SQLite recovery file identity invalid')
    const path = join(directory, entry.name)
    const file = await lstat(path)
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      file.size < 1 ||
      file.size > 32 * 1024 ||
      bytes + file.size > 768 * 1024
    )
      throw new Error('SQLite recovery prefix exceeds its evidence budget')
    const frame = await readE2EJson(path, 32 * 1024)
    validateSqliteSpoolFrame(frame, manifest)
    if (frame.page.observerEpoch !== match[1] || String(frame.page.pageSequence) !== match[2])
      throw new Error('SQLite recovery filename does not bind its page')
    frames.push(frame)
    bytes += file.size
  }
  if (!frames.length) return null
  return recoverSqlitePages(frames, manifest)
}

export function soakArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    if (
      !['--manifest', '--duration-ms', '--report'].includes(key) ||
      !args[index + 1] ||
      values[key]
    )
      throw new Error('Soak requires unique manifest, duration-ms and report arguments')
    values[key] = args[index + 1]
  }
  const durationMs = Number(values['--duration-ms'])
  if (
    !values['--manifest'] ||
    !values['--report'] ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 7_200_000
  )
    throw new Error(
      'Soak duration must be between one second and two hours; acceptance requires at least one hour',
    )
  return {
    manifestPath: resolve(values['--manifest']),
    reportPath: resolve(values['--report']),
    durationMs,
  }
}

export async function main(args = process.argv.slice(2), source = process.env, dependencies = {}) {
  const readManifest = dependencies.readManifest ?? readDistributionManifest,
    prepare = dependencies.prepare ?? prepareApplication,
    runDriver = dependencies.runDriver ?? run,
    inspectContent = dependencies.inspectContent ?? applicationContent
  const genuineDependencies =
    readManifest === readDistributionManifest &&
    prepare === prepareApplication &&
    runDriver === run &&
    inspectContent === applicationContent
  const { manifestPath, reportPath, durationMs } = soakArguments(args)
  try {
    await lstat(reportPath)
    throw new Error('An existing soak report cannot be overwritten')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const manifest = await readManifest(manifestPath)
  const root = await mkdtemp(join(source.RUNNER_TEMP ?? tmpdir(), 'pact-soak-'))
  let application,
    workerState,
    evidence = {
      durationMs: 0,
      cleanupVerified: false,
      resourceLifecycleVerified: false,
      recoveryVerified: false,
      missingObservations: ['driver-did-not-complete'],
    }
  let problem
  let driverStarted = false,
    observationLoaded = false,
    observationInvalid = false,
    recoveryEvidenceRetained = false
  let recoverySnapshot
  try {
    application = await prepare({
      manifest,
      manifestPath,
      root,
      environment: ciEnvironment(source),
      unpacked: false,
    })
    if (!application.installationVerified)
      throw new Error('A packaged soak requires an actual installation or artifact extraction')
    const dataRoot = join(root, 'fixture')
    await mkdir(dataRoot, { mode: 0o700 })
    const settings = join(root, 'settings.json'),
      observation = join(root, 'observations.json')
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        dataRoot,
        executable: application.executable,
        observation,
        durationMs,
        manifest: {
          sourceSha: manifest.sourceSha,
          version: manifest.version,
          channel: manifest.channel,
          platform: manifest.platform,
          arch: manifest.arch,
        },
      }),
      { flag: 'wx', mode: 0o600 },
    )
    driverStarted = true
    const code = await runDriver(
      [
        '--experimental-transform-types',
        '--import',
        join(import.meta.dirname, 'soak-module-loader.mjs'),
        join(import.meta.dirname, 'soak-driver.mjs'),
        settings,
      ],
      durationMs + 20 * 60_000,
      {
        executable: process.execPath,
        cwd: resolve(import.meta.dirname, '..'),
        env: ciEnvironment(source),
        onState: (state) => {
          workerState = state
        },
      },
    )
    try {
      evidence = validateSoakObservation(await readE2EJson(observation, 768 * 1024))
    } catch (error) {
      // A missing report may recover a verified spool; an existing invalid file stays private.
      observationInvalid = error?.code !== 'ENOENT'
      throw error
    }
    observationLoaded = true
    if (code !== 0) problem = 'The continuous driver or its verified process ownership failed'
    const content = await inspectContent(application.applicationPath, manifest.platform, {
      allowedExtraFiles:
        manifest.platform === 'win32' ? [`Uninstall ${manifest.productName}.exe`] : [],
    })
    if (
      content.sha256 !== manifest.application.contentSha256 ||
      JSON.stringify(content.entries) !== JSON.stringify(manifest.application.entries)
    )
      throw new Error('The installed application content changed during soak')
  } catch (error) {
    recoveryEvidenceRetained ||= error?.preserveRoot === true || observationInvalid
    if (recoveryEvidenceRetained) evidence.recoveryEvidenceRetained = true
    problem = 'Packaged soak preparation, continuous observation or identity verification failed'
  } finally {
    const processesReleased = workerState?.groupGone === true && workerState.ownedProcessCount === 0
    if (processesReleased || !driverStarted) {
      try {
        await application?.dispose()
      } catch {
        problem = 'Packaged soak installer cleanup could not be confirmed'
        recoveryEvidenceRetained = true
        evidence.recoveryEvidenceRetained = true
      }
    } else {
      problem =
        'Unconfirmed owned processes retain their installation and private recovery directory'
      recoveryEvidenceRetained = true
      evidence.recoveryEvidenceRetained = true
    }
    if (!observationLoaded && !observationInvalid && (processesReleased || !driverStarted)) {
      try {
        const prefix = await recoverSoakSqlitePrefix(root, manifest)
        if (prefix) evidence.sqlitePlanRecovery = prefix
      } catch {
        recoveryEvidenceRetained = true
        evidence.recoveryEvidenceRetained = true
        problem = 'Unreported SQLite observations retain their private recovery directory'
      }
    }
    if ((processesReleased || !driverStarted) && !recoveryEvidenceRetained) {
      if (observationLoaded || evidence.sqlitePlanRecovery) {
        try {
          const snapshot =
            JSON.stringify({
              ...evidence,
              schemaVersion: 1,
              status: 'blocked',
              cleanupVerified: false,
              sourceSha: manifest.sourceSha,
              version: manifest.version,
              channel: manifest.channel,
              platform: manifest.platform,
              arch: manifest.arch,
              appContentHash: manifest.application.contentSha256,
              requestedDurationMs: durationMs,
              failure: 'Recovery snapshot; cleanup and final report publication are not committed',
            }) + '\n'
          if (Buffer.byteLength(snapshot) > 1024 * 1024) {
            recoveryEvidenceRetained = true
            evidence.recoveryEvidenceRetained = true
            problem =
              'Measured observations retain their private recovery directory after evidence overflow'
          } else {
            await mkdir(dirname(reportPath), { recursive: true })
            recoverySnapshot = `${reportPath}.recovery-${randomUUID()}.json`
            await writeFile(recoverySnapshot, snapshot, { flag: 'wx', mode: 0o600, flush: true })
          }
        } catch {
          recoveryEvidenceRetained = true
          evidence.recoveryEvidenceRetained = true
          problem =
            'Measured observations retain their private recovery directory until a report can be preserved'
        }
      }
    }
    if ((processesReleased || !driverStarted) && !recoveryEvidenceRetained) {
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      } catch {
        problem = 'Packaged soak temporary data cleanup could not be confirmed'
      }
    } else if (!recoveryEvidenceRetained)
      problem = 'Unconfirmed owned processes retain their private recovery directory'
    try {
      await lstat(root)
      evidence.cleanupVerified = false
    } catch (error) {
      evidence.cleanupVerified =
        error.code === 'ENOENT' && Object.is(evidence.cleanupVerified, true) && processesReleased
    }
  }
  if (!genuineDependencies)
    problem = 'Injected dependencies cannot provide genuine installed soak acceptance'
  const budgets = evaluateSoak(evidence, durationMs)
  const report = {
    ...evidence,
    ...budgets,
    schemaVersion: 1,
    status: !problem && budgets.budgetPass ? 'passed' : 'blocked',
    sourceSha: manifest.sourceSha,
    version: manifest.version,
    channel: manifest.channel,
    platform: manifest.platform,
    arch: manifest.arch,
    appContentHash: manifest.application.contentSha256,
    artifacts: manifest.artifacts,
    installationVerified: application?.installationVerified === true,
    verificationMode: application?.verificationMode ?? 'unconfirmed',
    requestedDurationMs: durationMs,
    ...(problem ? { failure: problem } : {}),
  }
  const bytes = JSON.stringify(report, null, 2) + '\n'
  if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('Soak report exceeds 1 MiB')
  await mkdir(dirname(reportPath), { recursive: true })
  await writeFile(reportPath, bytes, { flag: 'wx', mode: 0o600, flush: true })
  if (recoverySnapshot) await rm(recoverySnapshot)
  if (report.status !== 'passed')
    throw new Error(
      'Packaged soak lacks complete passing duration, performance or resource evidence; inspect its bounded report',
    )
  return report
}

if (isScriptEntry(import.meta.url))
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
