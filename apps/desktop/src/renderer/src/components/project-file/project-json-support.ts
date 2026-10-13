// oxlint-disable-next-line import/default
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js'

const activeMode = jsonDefaults.modeConfiguration
let leases = 0

export function acquireJsonSupport(): {
  createWorker: () => Worker
  release: () => void
} {
  if (leases === 0) jsonDefaults.setModeConfiguration(activeMode)
  leases += 1
  let released = false
  return {
    createWorker: () => new JsonWorker(),
    release: () => {
      if (released) return
      released = true
      leases -= 1
      // The JSON mode installs diagnostics listeners for every Model, including non-JSON
      // Models. Remove providers and invalidate its WorkerManager when no JSON view owns it.
      if (leases === 0) jsonDefaults.setModeConfiguration({})
    },
  }
}
