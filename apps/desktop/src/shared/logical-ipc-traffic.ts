import {
  IPC_TRAFFIC_UNIT,
  ipcTrafficCategorySchema,
  ipcTrafficIssueSchema,
  ipcTrafficSchema,
  type IpcTraffic,
  type IpcTrafficCategory,
  type IpcTrafficIssue,
  type IpcTrafficOwnerSnapshot,
} from '@pact/contracts'

import { measureLogicalPayloadBytes } from './logical-payload-bytes.js'

const LIMITS = { maxBytes: 128 * 1024 * 1024, maxNodes: 262_144, maxDepth: 64 }
const MAX_MESSAGES = 1_000_000
const emptyCounts = () => ({
  messages: 0,
  incompleteMessages: 0,
  jsonBytes: 0,
  binaryBytes: 0,
  totalBytes: 0,
})
const rendererCategories: readonly IpcTrafficCategory[] = [
  'renderer-main.invoke',
  'main-renderer.reply',
  'renderer-main.send',
  'main-renderer.event',
]
const utilityCategories: readonly IpcTrafficCategory[] = [
  'main-utility.request',
  'utility-main.reply',
  'utility-main.event',
  'main-utility.control',
  'utility-main.control',
]

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
  private readonly owner: IpcTrafficOwnerSnapshot['owner']
  private readonly epoch: string | null

  constructor(owner: IpcTrafficOwnerSnapshot['owner'], epoch: string | null) {
    this.owner = owner
    this.epoch = epoch
    this.counters = (owner === 'renderer-bridge' ? rendererCategories : utilityCategories).map(
      (category) => ({ category, business: emptyCounts(), control: emptyCounts() }),
    )
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

  /** Call only after contract validation or the actual structured-clone receive seam, once per hop. */
  record(category: IpcTrafficCategory, lane: 'business' | 'control', payload: unknown): void {
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
    const measured = measureLogicalPayloadBytes(payload, LIMITS)
    if (!measured.complete) {
      counts.incompleteMessages += 1
      this.invalidate(measured.reason)
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

/** Partial coverage remains explicit even if every observed DTO was countable. */
export function logicalIpcTrafficSnapshot(main: IpcTrafficOwnerSnapshot): IpcTraffic {
  return {
    schemaVersion: 1,
    unit: IPC_TRAFFIC_UNIT,
    complete: false,
    owners: [main],
    uncovered: [
      'renderer-main-bridge',
      'main-utility-diagnostic-control',
      'main-directory-worker',
      'utility-markdown-worker',
      'utility-image-codec-worker',
      'utility-native-json-worker',
      'utility-native-fork-worker',
      'main-diagnostic-log-worker',
      'renderer-monaco-workers',
    ],
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
    for (const row of owner.counters) {
      const before = prior?.counters.find((value) => value.category === row.category)
      for (const lane of ['business', 'control'] as const) {
        if (
          before &&
          (row[lane].messages < before[lane].messages ||
            row[lane].totalBytes < before[lane].totalBytes)
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
  if (current.owners.length !== 2) issues.add('missing-ipc-owner')
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
