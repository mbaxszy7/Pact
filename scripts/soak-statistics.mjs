export function histogram() {
  return { bins: Array.from({ length: 1001 }, () => 0), count: 0, maximum: 0 }
}

/** Preserve every plan and sample counter without repeating immutable plans for two hours. */
export function resourceReportProjection() {
  const queryPlans = [],
    indices = new Map()
  let bytes = 0
  return {
    queryPlans,
    project(utility) {
      if (!utility?.sqlite) return utility
      const { queryPlans: plans, ...sqlite } = utility.sqlite
      if (!Array.isArray(plans) || plans.length > 64)
        throw new Error('Incomplete SQLite plan observation')
      const queryPlanIndices = plans.map((plan) => {
        if (
          !plan ||
          Object.keys(plan).length !== 2 ||
          !/^[a-f\d]{64}$/u.test(plan.sqlSha256 ?? '') ||
          !Array.isArray(plan.details) ||
          plan.details.length > 64 ||
          plan.details.some(
            (detail) => typeof detail !== 'string' || Buffer.byteLength(detail) > 512,
          )
        )
          throw new Error('Invalid SQLite plan observation')
        const stored = { sqlSha256: plan.sqlSha256, details: [...plan.details] }
        const key = JSON.stringify(stored)
        if (indices.has(key)) return indices.get(key)
        const size = Buffer.byteLength(key)
        if (queryPlans.length >= 64 || bytes + size > 32 * 1024)
          throw new Error('SQLite report plan dictionary exceeds its count/byte bound')
        const index = queryPlans.length
        queryPlans.push(stored)
        indices.set(key, index)
        bytes += size
        return index
      })
      return { ...utility, sqlite: { ...sqlite, queryPlanIndices } }
    },
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

export function evaluateSoak(evidence, requestedDurationMs) {
  const unmet = []
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
