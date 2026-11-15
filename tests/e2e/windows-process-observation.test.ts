import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { expect, it } from 'vitest'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { within } from '../native/native-harness.js'
import {
  writeWindowsNodeLauncher,
  writeWindowsObservedLauncher,
  type WindowsLaunchOwner,
} from './windows-cli-launcher.js'
import {
  stopWindowsProcess,
  windowsChildPids,
  windowsProcessIdentity,
  findWindowsOwnedAgentProcess,
  stopWindowsOwnedAgentProcess,
} from './windows-process-observation.js'

await import('../native/windows-process-owner-setup.js')

async function observedTree(
  nested: boolean,
  count = 1,
  grandchild = false,
  extraChildren: 'node' | 'idle-command' = 'node',
) {
  const root = await mkdtemp(join(tmpdir(), 'pact-process-observer-'))
  const owner = new OwnedProcessGroup()
  let launch: WindowsLaunchOwner | undefined
  const close = async (removeRoot: boolean): Promise<void> => {
    const deadlineAt = Date.now() + 4_000
    let failure: unknown
    launch?.cancel()
    if (launch && launch.diagnostic().stages.go !== undefined) {
      try {
        const remaining = Math.floor(deadlineAt - Date.now())
        if (remaining <= 0) throw new Error('Owned launch empty receipt exceeded its deadline')
        await within(launch.empty, remaining, 'Owned launch empty receipt exceeded its deadline')
      } catch (error) {
        failure = error
      }
    }
    try {
      await owner.close(deadlineAt)
    } catch (error) {
      failure ??= error
    }
    try {
      await launch?.disposeControl()
    } catch (error) {
      failure ??= error
    }
    if (!owner.released)
      failure ??= new Error('Windows owned process observer release is unconfirmed')
    if (failure !== undefined) throw failure
    if (removeRoot) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
  }
  try {
    const report = join(root, 'utility-ready.json')
    const entry = join(root, 'utility.mjs')
    const grandchildReady = join(root, 'grandchild-ready')
    const candidateReady = join(root, 'candidate-ready')
    const commandInterpreter = process.env['ComSpec']
    if (
      extraChildren === 'idle-command' &&
      (!commandInterpreter || !isAbsolute(commandInterpreter))
    )
      throw new Error('An absolute Windows command interpreter is unavailable')
    const childSource = grandchild
      ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(grandchildReady)},String(process.pid));setInterval(()=>{},1000)`)}],{shell:false,windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000)`
      : 'setInterval(()=>{},1000)'
    const actual = nested
      ? await writeWindowsNodeLauncher(root, 'nested-target', [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(candidateReady)},String(process.pid));${childSource}`,
        ])
      : process.execPath
    await writeFile(
      entry,
      `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';const children=Array.from({length:${count}},(_,index)=>{const idle=${extraChildren === 'idle-command'}&&index>=2;return spawn(idle?${JSON.stringify(commandInterpreter)}:${JSON.stringify(actual)},idle?['/d','/q']:${nested ? '[]' : JSON.stringify(['-e', childSource])},{shell:false,detached:${extraChildren === 'idle-command'},windowsHide:true,stdio:idle?['pipe','ignore','ignore']:'ignore'})});writeFileSync(${JSON.stringify(report)},JSON.stringify({pid:process.pid,children:children.map(child=>child.pid)}));process.stdin.resume();setInterval(()=>{},1000);\n`,
    )
    launch = await writeWindowsObservedLauncher(root, process.execPath, 60_000)
    const startupDeadline = performance.now() + 15_000
    launch.armStartup(startupDeadline)
    const child = owner.spawn(launch.executablePath, [entry], {
      cwd: root,
      windowsHide: true,
    })
    child.stdout.resume()
    child.stderr.resume()
    await once(child, 'spawn')
    const started = await launch.started
    const remainingStartup = Math.floor(startupDeadline - performance.now())
    if (remainingStartup < 1)
      throw new Error('Owned observer fixture startup exceeded its deadline')
    let utility: { pid: number; children: number[] } | undefined
    let expectedTargetPid: number | undefined
    await expect
      .poll(
        async () => {
          utility = await readFile(report, 'utf8')
            .then((text) => JSON.parse(text))
            .catch(() => undefined)
          if (!utility) return false
          if (!nested) {
            expectedTargetPid = utility.children[0]
            return true
          }
          const candidate = await readFile(candidateReady, 'utf8')
            .then((text) => Number(text))
            .catch(() => Number.NaN)
          if (!Number.isSafeInteger(candidate) || candidate < 2) return false
          expectedTargetPid = candidate
          return true
        },
        { timeout: Math.min(5_000, remainingStartup) },
      )
      .toBe(true)
    if (performance.now() >= startupDeadline)
      throw new Error('Owned observer fixture startup exceeded its deadline')
    if (!utility || expectedTargetPid === undefined)
      throw new Error('Owned observer fixture did not start')
    if (started.pid !== utility.pid)
      throw new Error('The observed Job root is not the fixture Utility')
    const observed = launch
    return {
      ...utility,
      root,
      grandchildReady,
      expectedTargetPid,
      observeProcessTree: (pid: number, deadlineAt: number) =>
        observed.observeProcessTree(pid, deadlineAt),
      cancel: () => observed.cancel(),
      close: () => close(true),
    }
  } catch (error) {
    try {
      await close(false)
    } catch (cleanup) {
      // oxlint-disable-next-line eslint/preserve-caught-error -- The cleanup error is retained inside the aggregate while cause stays the startup failure.
      throw new AggregateError(
        [error, cleanup],
        'Windows observer fixture startup and cleanup failed',
        { cause: error },
      )
    }
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
      await expect(
        findWindowsOwnedAgentProcess(
          sentinel.pid!,
          process.execPath,
          'claude',
          tree.observeProcessTree,
        ),
      ).rejects.toMatchObject({ reason: 'query' })
      const owned = await findWindowsOwnedAgentProcess(
        tree.pid,
        process.execPath,
        'claude',
        tree.observeProcessTree,
      )
      expect(owned.chain).toHaveLength(nested ? 2 : 1)
      expect(owned.pid).toBe(tree.expectedTargetPid)
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
      try {
        await tree.close()
      } finally {
        sentinel.kill()
        await sentinelClosed
      }
    }
  },
  25_000,
)

// COUNT-BOUNDARY VARIANT: detached spawned members each occupy one Job member
// slot and the Utility's own console host is the extra first descendant, so the
// 32-descendant boundary and the 33-descendant refusal sit at 31/32 children;
// the count-32 tree-limit refusal and the count-31 32-member boundary are both
// checked here.
it.skipIf(process.platform !== 'win32').each([2, 31, 32])(
  'batched Windows discovery refuses ambiguous or oversized owned trees (%s children)',
  async (count) => {
    const tree = await observedTree(false, count, false, count >= 31 ? 'idle-command' : 'node')
    try {
      expect(tree.children).toHaveLength(count)
      /* oxlint-disable vitest/no-conditional-expect -- Only the 31-child boundary row asserts the exact 32-member Job snapshot. */
      if (count === 31) {
        const snapshot = await tree.observeProcessTree(tree.pid, performance.now() + 2_000)
        expect(snapshot.descendants).toHaveLength(32)
        const members = new Set([
          snapshot.root.pid,
          ...snapshot.descendants.map((identity) => identity.pid),
        ])
        expect(tree.children.every((pid) => members.has(pid))).toBe(true)
      }
      /* oxlint-enable vitest/no-conditional-expect */
      const discovery = findWindowsOwnedAgentProcess(
        tree.pid,
        process.execPath,
        'claude',
        tree.observeProcessTree,
      )
      await expect(discovery).rejects.toThrow('observation did not complete')
      await expect(discovery).rejects.toMatchObject({
        reason: count === 32 ? 'tree-limit' : 'ambiguous',
      })
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
  'checks later ancestry levels after finding the first matching Agent',
  async () => {
    const tree = await observedTree(false, 1, true)
    try {
      await expect
        .poll(
          () =>
            readFile(tree.grandchildReady, 'utf8')
              .then(() => true)
              .catch(() => false),
          {
            timeout: 5_000,
          },
        )
        .toBe(true)
      const descendant = Number(await readFile(tree.grandchildReady, 'utf8'))
      const discovery = findWindowsOwnedAgentProcess(
        tree.pid,
        process.execPath,
        'claude',
        tree.observeProcessTree,
      )
      await expect(discovery).rejects.toThrow('observation did not complete')
      await expect(discovery).rejects.toMatchObject({ reason: 'ambiguous' })
      expect(await windowsProcessIdentity(tree.children[0]!)).not.toBeNull()
      expect(await windowsProcessIdentity(descendant)).not.toBeNull()
    } finally {
      await tree.close()
    }
  },
  25_000,
)

it.skipIf(process.platform !== 'win32')(
  'rejects an in-flight tree observation on cancel without a late result',
  async () => {
    const tree = await observedTree(false)
    try {
      const pending = tree.observeProcessTree(tree.pid, performance.now() + 2_000)
      // oxlint-disable-next-line vitest/valid-expect -- The rejection is awaited immediately after the synchronous cancel.
      const rejection = expect(pending).rejects.toMatchObject({ reason: 'query' })
      tree.cancel()
      await rejection
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
