import { mkdtemp, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'

import type { WindowsFixtureProcessScope } from './native-harness.js'

// A Vitest-isolated file owns one immutable default. Explicit fixture scopes
// remain independent, and macOS registers no extra hooks or native work.
if (process.platform === 'win32') {
  let root: string | undefined
  let scope: WindowsFixtureProcessScope | undefined
  beforeAll(async () => {
    // Load after test-module mocks are established so OS-seam tests retain
    // their existing observation boundary. The production owner is unchanged.
    const { createWindowsFixtureProcessScope } = await import('./native-harness.js')
    const { configureOwnedProcessGroups } =
      await import('../../apps/desktop/src/utility/owned-process-group.js')
    root = await mkdtemp(join(tmpdir(), 'pact-native-windows-process-owner-'))
    scope = await createWindowsFixtureProcessScope(root)
    if (!scope) throw new Error('The Windows native process fixture did not initialize.')
    configureOwnedProcessGroups(scope.configuration)
  })
  afterAll(async () => {
    if (!root) return
    if (!scope) {
      // Preparation admitted no process. A nonempty directory is preserved.
      await rmdir(root)
      return
    }
    const { nativeWorkingMemoryCapacities } =
      await import('../../apps/desktop/src/utility/conversation/native-working-memory.js')
    // The real Windows owner retains its reservation through physical cleanup.
    // Zero bytes alone never suffices: durable receipts must also be retired by
    // their actual test/runtime owners before this directory can be removed.
    if (nativeWorkingMemoryCapacities().chargedBytes !== 0)
      throw new Error(
        `Windows fixture cleanup is unconfirmed: native process reservations remain; recovery root retained at ${root}`,
      )
    await scope.assertReceiptsRetired()
    await rmdir(scope.configuration.receiptDirectory)
    await rmdir(root)
  })
}
