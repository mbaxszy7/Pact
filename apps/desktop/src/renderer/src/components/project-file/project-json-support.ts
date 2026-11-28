// oxlint-disable-next-line import/default
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js'

const activeMode = jsonDefaults.modeConfiguration
let leases = 0

function createJsonWorker(): Worker {
  return new JsonWorker()
}

export interface JsonSupportLifecycleHooks {
  beforeEnable?: ((createWorker: () => Worker) => void) | undefined
  afterDisable?: (() => void) | undefined
}

export function acquireJsonSupport(hooks?: JsonSupportLifecycleHooks): {
  createWorker: () => Worker
  release: () => void
} {
  hooks?.beforeEnable?.(createJsonWorker)
  try {
    if (leases === 0) jsonDefaults.setModeConfiguration(activeMode)
  } catch (error) {
    hooks?.afterDisable?.()
    throw error
  }
  leases += 1
  let released = false
  return {
    createWorker: createJsonWorker,
    release: () => {
      if (released) return
      released = true
      leases -= 1
      // The JSON mode installs diagnostics listeners for every Model, including non-JSON
      // Models. Remove providers and invalidate its WorkerManager when no JSON view owns it.
      try {
        if (leases === 0) jsonDefaults.setModeConfiguration({})
      } finally {
        hooks?.afterDisable?.()
      }
    },
  }
}
