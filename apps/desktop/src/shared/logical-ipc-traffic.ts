import {
  IPC_TRAFFIC_UNIT,
  IPC_TRAFFIC_OWNER_CATEGORIES,
  ipcTrafficMeasurementSchema,
  ipcTrafficCategorySchema,
  ipcTrafficIssueSchema,
  ipcTrafficSchema,
  type IpcTraffic,
  type IpcTrafficCategory,
  type IpcTrafficIssue,
  type IpcTrafficOwnerSnapshot,
  type IpcTrafficMeasurement,
} from '@pact/contracts'

import { measureLogicalPayloadBytes, type LogicalPayloadProfile } from './logical-payload-bytes.js'

const LIMITS = { maxBytes: 128 * 1024 * 1024, maxNodes: 262_144, maxDepth: 64 }
const MAX_MESSAGES = 1_000_000
/** The E2E alias is generated internally by a credential-free, owned fixture. It never enables
 * the packaged inspector; Main independently requires a nonpackaged app and canonical data root. */
export function hasLogicalIpcFixtureNonce(
  environment: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    /^[a-f\d]{64}$/u.test(environment.PACT_SOAK_NONCE ?? '') ||
    (environment.NODE_ENV === 'test' && /^[a-f\d]{64}$/u.test(environment.PACT_E2E_IPC_NONCE ?? ''))
  )
}
const emptyCounts = () => ({
  messages: 0,
  incompleteMessages: 0,
  jsonBytes: 0,
  binaryBytes: 0,
  totalBytes: 0,
})

/** Existing transport owns this optional counter for one process/context lifetime. No timers,
 * callbacks, DTOs or unbounded keys are retained. <=9 fixed categories x two lanes, <=19 issues,
 * <=1,000,000 observations and <=64 transport epochs. Byte totals are safe integers. Limits
 * bound observation only; incomplete measurements leave business delivery and budgets unchanged.
 */
export class LogicalIpcTrafficCollector {
  private readonly counters: IpcTrafficOwnerSnapshot['counters']
  private readonly issues = new Set<IpcTrafficIssue>()
  private transportEpoch = 1
  private messages = 0
  private totalBytes = 0
  private disposed = false
  private startedTransports = 0
  private settledTransports = 0
  private activeTransports = 0
  private highWaterTransports = 0
  readonly owner: IpcTrafficOwnerSnapshot['owner']
  private readonly epoch: string | null

  constructor(owner: IpcTrafficOwnerSnapshot['owner'], epoch: string | null) {
    this.owner = owner
    this.epoch = epoch
    this.counters = IPC_TRAFFIC_OWNER_CATEGORIES[owner].map((category) => ({
      category,
      business: emptyCounts(),
      control: emptyCounts(),
    }))
    if (
      epoch === null ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/iu.test(epoch)
    )
      this.issues.add('invalid_epoch')
  }

  invalidate(issue: IpcTrafficIssue): void {
    const parsed = ipcTrafficIssueSchema.safeParse(issue)
    this.issues.add(parsed.success ? parsed.data : 'unknown_category')
  }

  advanceTransportEpoch(): void {
    if (this.disposed) this.invalidate('disposed')
    else if (this.transportEpoch >= 64) this.invalidate('epoch_limit')
    else this.transportEpoch += 1
  }

  /** Only actual exit/fulfilled Node Worker.terminate may call this receipt. */
  beginTransport(): () => void {
    if (this.startedTransports >= MAX_MESSAGES || this.activeTransports >= 64) {
      this.invalidate('counter_overflow')
      return () => undefined
    }
    this.startedTransports += 1
    this.activeTransports += 1
    this.highWaterTransports = Math.max(this.highWaterTransports, this.activeTransports)
    let settled = false
    return () => {
      if (settled) return
      settled = true
      this.settledTransports += 1
      this.activeTransports -= 1
    }
  }

  /** Call only after contract validation or the actual structured-clone receive seam, once per hop. */
  record(category: IpcTrafficCategory, lane: 'business' | 'control', payload: unknown): void {
    if (this.disposed || this.messages >= MAX_MESSAGES) {
      this.invalidate(this.disposed ? 'disposed' : 'counter_overflow')
      return
    }
    this.recordMeasurement(category, lane, logicalIpcMeasurement(payload))
  }

  /** Measurement contains only scalars. Transfer senders measure before detachment and commit
   * after successful postMessage; large Native JSON is measured in its existing parser Worker. */
  recordMeasurement(
    category: IpcTrafficCategory,
    lane: 'business' | 'control',
    measurement: unknown,
  ): void {
    if (this.disposed) {
      this.invalidate('disposed')
      return
    }
    const categoryResult = ipcTrafficCategorySchema.safeParse(category)
    const row = categoryResult.success
      ? this.counters.find((value) => value.category === categoryResult.data)
      : undefined
    if (!row || (lane !== 'business' && lane !== 'control')) {
      this.invalidate('unknown_category')
      return
    }
    if (this.messages >= MAX_MESSAGES) {
      this.invalidate('counter_overflow')
      return
    }
    this.messages += 1
    const counts = row[lane]
    counts.messages += 1
    const parsedMeasurement = ipcTrafficMeasurementSchema.safeParse(measurement)
    const measured = parsedMeasurement.success ? parsedMeasurement.data : undefined
    if (!measured) {
      counts.incompleteMessages += 1
      this.invalidate('unvalidated_message')
      return
    }
    if (!measured.complete) {
      counts.incompleteMessages += 1
      this.invalidate(measured.reason ?? 'unvalidated_message')
      return
    }
    if (
      !Number.isSafeInteger(counts.totalBytes + measured.totalBytes) ||
      !Number.isSafeInteger(this.totalBytes + measured.totalBytes)
    ) {
      counts.incompleteMessages += 1
      this.invalidate('counter_overflow')
      return
    }
    counts.jsonBytes += measured.jsonBytes
    counts.binaryBytes += measured.binaryBytes
    counts.totalBytes += measured.totalBytes
    this.totalBytes += measured.totalBytes
  }

  snapshot(): IpcTrafficOwnerSnapshot {
    return {
      owner: this.owner,
      epoch: this.issues.has('invalid_epoch') ? null : this.epoch,
      transportEpoch: this.transportEpoch,
      startedTransports: this.startedTransports,
      settledTransports: this.settledTransports,
      activeTransports: this.activeTransports,
      highWaterTransports: this.highWaterTransports,
      complete: this.issues.size === 0,
      issues: [...this.issues],
      counters: this.counters.map((row) => ({
        category: row.category,
        business: { ...row.business },
        control: { ...row.control },
      })),
    }
  }

  dispose(): void {
    this.disposed = true
  }
}

/** Tap an existing Node Worker without replacing its business listeners or clone/transfer call.
 * One constant-sized tap is owned by that physical Worker and removed on its actual exit.
 * The caller supplies already admitted initialization bytes before transfer detaches them.
 */
export function observeWorkerTraffic(
  worker: {
    on(event: 'message', listener: (message: unknown) => void): unknown
    once(event: 'exit', listener: () => void): unknown
    off(event: 'message', listener: (message: unknown) => void): unknown
  },
  traffic: LogicalIpcTrafficCollector | undefined,
  inputCategory: IpcTrafficCategory,
  outputCategory: IpcTrafficCategory,
  lane: 'business' | 'control' = 'business',
  observeReplies = true,
): void {
  if (!traffic) return
  const settle = traffic.beginTransport()
  const receive = (message: unknown): void => traffic.record(outputCategory, lane, message)
  if (observeReplies) worker.on('message', receive)
  const original: unknown = Reflect.get(worker, 'postMessage')
  if (typeof original !== 'function') {
    traffic.invalidate('transport_error')
    return
  }
  const previous = Object.getOwnPropertyDescriptor(worker, 'postMessage')
  const post = function (this: unknown, ...args: unknown[]): unknown {
    if (this !== worker) return Reflect.apply(original, this, args)
    const measurement = logicalIpcMeasurement(args[0])
    try {
      const result: unknown = Reflect.apply(original, this, args)
      traffic.recordMeasurement(inputCategory, lane, measurement)
      return result
    } catch (error) {
      traffic.invalidate('transport_error')
      throw error
    }
  }
  Object.defineProperty(worker, 'postMessage', { value: post, configurable: true, writable: true })
  worker.once('exit', () => {
    settle()
    if (observeReplies) worker.off('message', receive)
    if (Reflect.get(worker, 'postMessage') === post) {
      if (previous) Object.defineProperty(worker, 'postMessage', previous)
      else Reflect.deleteProperty(worker, 'postMessage')
    }
  })
}

export function logicalIpcMeasurement(
  payload: unknown,
  profile: LogicalPayloadProfile = 'plain-dto',
): IpcTrafficMeasurement {
  const { visitedNodes: _visitedNodes, ...measurement } = measureLogicalPayloadBytes(
    payload,
    LIMITS,
    profile,
  )
  return measurement
}

/** Monaco 0.56's five protocol classes contain only these own data fields. Project only this
 * small outer envelope into the same plain own-data shape produced by structured clone. All
 * nested DTOs retain the strict meter profile; no getter, clone of a body or toJSON is invoked. */
export function measureMonacoWorkerMessage(payload: unknown): IpcTrafficMeasurement {
  const direct = logicalIpcMeasurement(payload, 'monaco-clone-data')
  if (
    direct.complete ||
    direct.reason !== 'unsupported_prototype' ||
    !payload ||
    typeof payload !== 'object'
  )
    return direct
  try {
    const prototype: unknown = Object.getPrototypeOf(payload)
    if (
      !prototype ||
      typeof prototype !== 'object' ||
      Object.getPrototypeOf(prototype) !== Object.prototype
    )
      return direct
    const constructor: unknown = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value
    const name: unknown =
      typeof constructor === 'function'
        ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value
        : undefined
    const profiles: Record<string, readonly string[]> = {
      RequestMessage: ['vsWorker', 'req', 'channel', 'method', 'args', 'type'],
      ReplyMessage: ['vsWorker', 'seq', 'res', 'err', 'type'],
      SubscribeEventMessage: ['vsWorker', 'req', 'channel', 'eventName', 'arg', 'type'],
      EventMessage: ['vsWorker', 'req', 'event', 'type'],
      UnsubscribeEventMessage: ['vsWorker', 'req', 'type'],
    }
    if (typeof name !== 'string' || !Object.hasOwn(profiles, name)) return direct
    const expected = profiles[name]
    if (!expected) return direct
    let fields = 0
    for (const key in payload) {
      if (!Object.hasOwn(payload, key)) continue
      fields += 1
      if (fields > expected.length || !expected.includes(key)) return direct
    }
    if (fields !== expected.length) return direct
    const envelope: Record<string, unknown> = {}
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(payload, key)
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
        return { complete: false, jsonBytes: 0, binaryBytes: 0, totalBytes: 0, reason: 'accessor' }
      Object.defineProperty(envelope, key, { value: descriptor.value, enumerable: true })
    }
    return logicalIpcMeasurement(envelope, 'monaco-clone-data')
  } catch {
    return { complete: false, jsonBytes: 0, binaryBytes: 0, totalBytes: 0, reason: 'uninspectable' }
  }
}

/** Fixed process-lifetime groups. Creating another Worker never resets its counters/epoch. */
export class LogicalIpcWorkerTraffic {
  private readonly collectors: readonly LogicalIpcTrafficCollector[]
  constructor(owners: readonly IpcTrafficOwnerSnapshot['owner'][], epoch: string) {
    this.collectors = owners.map((owner) => new LogicalIpcTrafficCollector(owner, epoch))
  }
  collector(owner: IpcTrafficOwnerSnapshot['owner']): LogicalIpcTrafficCollector | undefined {
    return this.collectors.find((value) => value.owner === owner)
  }
  snapshots(): IpcTrafficOwnerSnapshot[] {
    return this.collectors.map((value) => value.snapshot())
  }
}

/** Partial coverage remains explicit even if every observed DTO was countable. */
export function logicalIpcTrafficSnapshot(
  main: IpcTrafficOwnerSnapshot,
  additional: readonly IpcTrafficOwnerSnapshot[] = [],
): IpcTraffic {
  const owners = [main, ...additional]
  const covered = new Set(owners.map((owner) => owner.owner))
  const uncovered: IpcTraffic['uncovered'] = []
  const coverage: readonly (readonly [
    IpcTraffic['uncovered'][number],
    IpcTrafficOwnerSnapshot['owner'],
  ])[] = [
    ['renderer-main-bridge', 'renderer-bridge'],
    ['main-utility-diagnostic-control', 'main-utility'],
    ['main-directory-worker', 'main-directory'],
    ['utility-markdown-worker', 'utility-markdown'],
    ['utility-image-codec-worker', 'utility-image'],
    ['utility-native-json-worker', 'utility-native-json'],
    ['utility-native-fork-worker', 'utility-native-fork'],
    ['main-diagnostic-log-worker', 'main-diagnostic-log'],
    ['renderer-monaco-workers', 'renderer-monaco'],
  ]
  for (const [hop, owner] of coverage)
    if (
      !covered.has(owner) ||
      (hop === 'main-utility-diagnostic-control' && !covered.has('main-diagnostic-log'))
    )
      uncovered.push(hop)
  return {
    schemaVersion: 1,
    unit: IPC_TRAFFIC_UNIT,
    complete: uncovered.length === 0 && owners.every((owner) => owner.complete),
    owners,
    uncovered,
  }
}

/** Bounded report projection; it never removes uncovered work or accepts an owner reset as progress. */
export function projectLogicalIpcTraffic(
  raw: unknown,
  previous?: IpcTraffic,
): {
  observed: boolean
  complete: boolean
  businessBytes: number
  controlBytes: number
  issues: string[]
  snapshot?: IpcTraffic
} {
  const parsed = ipcTrafficSchema.safeParse(raw)
  if (!parsed.success)
    return {
      observed: false,
      complete: false,
      businessBytes: 0,
      controlBytes: 0,
      issues: ['missing-or-invalid-ipc-observation'],
    }
  const current = parsed.data
  let businessBytes = 0,
    controlBytes = 0
  const issues = new Set<string>()
  for (const owner of current.owners) {
    for (const issue of owner.issues) issues.add(`${owner.owner}:${issue}`)
    const prior = previous?.owners.find((value) => value.owner === owner.owner)
    if (prior && (prior.epoch !== owner.epoch || owner.transportEpoch < prior.transportEpoch))
      issues.add(`${owner.owner}:epoch-reset`)
    if (
      prior &&
      (owner.startedTransports < prior.startedTransports ||
        owner.settledTransports < prior.settledTransports ||
        owner.highWaterTransports < prior.highWaterTransports)
    )
      issues.add(`${owner.owner}:lifecycle-reset`)
    for (const row of owner.counters) {
      const before = prior?.counters.find((value) => value.category === row.category)
      for (const lane of ['business', 'control'] as const) {
        if (
          before &&
          (row[lane].messages < before[lane].messages ||
            row[lane].totalBytes < before[lane].totalBytes ||
            row[lane].jsonBytes < before[lane].jsonBytes ||
            row[lane].binaryBytes < before[lane].binaryBytes ||
            row[lane].incompleteMessages < before[lane].incompleteMessages)
        )
          issues.add(`${owner.owner}:counter-reset`)
      }
      businessBytes += row.business.totalBytes
      controlBytes += row.control.totalBytes
    }
  }
  if (
    !Number.isSafeInteger(businessBytes) ||
    !Number.isSafeInteger(controlBytes) ||
    !Number.isSafeInteger(businessBytes + controlBytes)
  )
    issues.add('ipc-total-overflow')
  for (const owner of previous?.owners ?? [])
    if (!current.owners.some((value) => value.owner === owner.owner))
      issues.add(`${owner.owner}:missing-owner`)
  if (current.owners.length !== 9) issues.add('missing-ipc-owner')
  if (!current.complete) issues.add('partial-ipc-coverage')
  for (const hop of current.uncovered) issues.add(`uncovered:${hop}`)
  return {
    observed: true,
    complete: current.complete && issues.size === 0,
    businessBytes,
    controlBytes,
    issues: [...issues],
    snapshot: current,
  }
}
