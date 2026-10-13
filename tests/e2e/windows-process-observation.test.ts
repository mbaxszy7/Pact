import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { writeWindowsNodeLauncher } from './windows-cli-launcher.js'
import {
  stopWindowsProcess,
  windowsChildPids,
  windowsProcessIdentity,
  findWindowsOwnedAgentProcess,
  stopWindowsOwnedAgentProcess,
} from './windows-process-observation.js'

async function observedTree(nested: boolean, count = 1) {
  const root = await mkdtemp(join(tmpdir(), 'pact-process-observer-'))
  const owner = new OwnedProcessGroup()
  try {
    const report = join(root, 'utility-ready.json')
    const entry = join(root, 'utility.mjs')
    const actual = nested
      ? await writeWindowsNodeLauncher(root, 'nested-target', ['-e', 'setInterval(()=>{},1000)'])
      : process.execPath
    await writeFile(
      entry,
      `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const children=Array.from({length:${count}},()=>spawn(${JSON.stringify(actual)},${nested ? '[]' : JSON.stringify(['-e', 'setInterval(()=>{},1000)'])},{shell:false,windowsHide:true,stdio:'ignore'}));writeFileSync(${JSON.stringify(report)},JSON.stringify({pid:process.pid,children:children.map(child=>child.pid)}));process.stdin.resume();setInterval(()=>{},1000);\n`,
    )
    const launcher = await writeWindowsNodeLauncher(root, 'utility', [entry])
    const child = owner.spawn(launcher, [], { cwd: root, windowsHide: true })
    child.stdout.resume()
    child.stderr.resume()
    let utility: { pid: number; children: number[] } | undefined
    await expect
      .poll(
        async () => {
          utility = await readFile(report, 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => undefined)
          return Boolean(utility)
        },
        { timeout: 5_000 },
      )
      .toBe(true)
    if (!utility) throw new Error('Owned observer fixture did not start')
    return {
      ...utility,
      root,
      close: async () => {
        await owner.close()
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
      },
    }
  } catch (error) {
    await owner.close()
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    throw error
  }
}

it.skipIf(process.platform !== 'win32').each([false, true])(
  'batched Windows ownership validates the complete chain before termination (nested: %s)',
  async (nested) => {
    const tree = await observedTree(nested)
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    const sentinelClosed = once(sentinel, 'close')
    try {
      const owned = await findWindowsOwnedAgentProcess(tree.pid, process.execPath, 'claude')
      expect(owned.chain).toHaveLength(nested ? 2 : 1)
      await expect(stopWindowsOwnedAgentProcess({ ...owned, utilityStarted: '1' })).rejects.toThrow(
        'observation did not complete',
      )
      const wrongBirth = structuredClone(owned)
      wrongBirth.chain[0]!.started = '1'
      await expect(stopWindowsOwnedAgentProcess(wrongBirth)).rejects.toThrow(
        'observation did not complete',
      )
      const wrongPath = structuredClone(owned)
      wrongPath.chain.at(-1)!.executable += '.other'
      await expect(stopWindowsOwnedAgentProcess(wrongPath)).rejects.toThrow(
        'observation did not complete',
      )
      const wrongParent = structuredClone(owned)
      wrongParent.chain.at(-1)!.parentPid = sentinel.pid!
      await expect(stopWindowsOwnedAgentProcess(wrongParent)).rejects.toThrow(
        'Invalid owned Agent ancestry',
      )
      expect(await windowsProcessIdentity(owned.pid)).not.toBeNull()
      await stopWindowsOwnedAgentProcess(owned)
      expect(await windowsProcessIdentity(owned.pid)).toBeNull()
      await expect(stopWindowsOwnedAgentProcess(owned)).rejects.toThrow(
        'observation did not complete',
      )
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      await tree.close()
      sentinel.kill()
      await sentinelClosed
    }
  },
  25_000,
)

it.skipIf(process.platform !== 'win32').each([2, 33])(
  'batched Windows discovery refuses ambiguous or oversized owned trees (%s children)',
  async (count) => {
    const tree = await observedTree(false, count)
    try {
      await expect(
        findWindowsOwnedAgentProcess(tree.pid, process.execPath, 'claude'),
      ).rejects.toThrow('observation did not complete')
      expect(
        tree.children.every((pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch {
            return false
          }
        }),
      ).toBe(true)
    } finally {
      await tree.close()
    }
  },
  25_000,
)

it.skipIf(process.platform !== 'win32')(
  'Windows observes and terminates only the matching owned process handle',
  async () => {
    const child = spawn(
      process.execPath,
      ['-e', "process.send('ready');setInterval(()=>{},1000)"],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true, shell: false },
    )
    const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    })
    const closed = once(child, 'close'),
      sentinelClosed = once(sentinel, 'close')
    try {
      await once(child, 'message')
      const identity = await windowsProcessIdentity(child.pid!)
      expect(identity?.parentPid).toBe(process.pid)
      expect(await windowsChildPids(process.pid)).toContain(child.pid)
      if (!identity) throw new Error('Owned fixture identity is unavailable')
      await expect(stopWindowsProcess({ ...identity, started: '1' })).rejects.toThrow(
        'Owned Windows process observation did not complete',
      )
      expect(child.exitCode).toBeNull()
      await stopWindowsProcess(identity)
      await closed
      expect(await windowsProcessIdentity(child.pid!)).toBeNull()
      expect(sentinel.exitCode).toBeNull()
      expect(sentinel.signalCode).toBeNull()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      sentinel.kill()
      await Promise.all([closed, sentinelClosed])
    }
  },
  15_000,
)

it.skipIf(process.platform !== 'win32').each([NaN, -1, 1, 0x100000000])(
  'Windows process queries reject invalid PID %s before execution',
  async (pid) => {
    await expect(windowsChildPids(pid)).rejects.toThrow('Invalid owned process identity')
    await expect(windowsProcessIdentity(pid)).rejects.toThrow('Invalid owned process identity')
  },
)
