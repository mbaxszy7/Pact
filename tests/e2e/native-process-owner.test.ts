import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'

import type { WindowsLaunchOwner, WindowsRootExit } from './windows-cli-launcher.js'

import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import { NativeProcessOwner } from '../native/native-harness.js'

// Real helper closure with controlled Job receipts tests the two-owner ordering.
// Only Windows CI can establish the corresponding kernel Job facts.
interface Scenario {
  name: string
  missing: boolean
  noGo: boolean
  outerFailure?: boolean
  missingClose?: boolean
  controlFailure?: boolean
  expectedError?: string
}
const scenarios: Scenario[] = [
  { name: 'delayed empty', missing: false, noGo: false },
  {
    name: 'missing empty after go zero',
    missing: true,
    noGo: false,
    expectedError: 'Missing authenticated inner empty receipt',
  },
  { name: 'cancel before late hello', missing: false, noGo: true },
  {
    name: 'unconfirmed outer close without go',
    missing: false,
    noGo: true,
    outerFailure: true,
    expectedError: 'Outer release unconfirmed',
  },
  {
    name: 'missing helper close without go',
    missing: false,
    noGo: true,
    missingClose: true,
    expectedError: 'Owned helper child close deadline',
  },
  {
    name: 'unconfirmed control close without go',
    missing: false,
    noGo: true,
    controlFailure: true,
    expectedError: 'Control disposal unconfirmed',
  },
]
it.each(scenarios)('joins the inner receipt before outer teardown: $name', async (scenario) => {
  const { missing, noGo } = scenario
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'pact-native-inner-owner-')))
  const marker = join(directory, 'private-marker')
  await writeFile(marker, 'retained fixture evidence')
  const generation = randomUUID(),
    events: string[] = []
  const empty = Promise.withResolvers<{ generation: string; active: 0; exitCode: number }>()
  void empty.promise.catch(() => undefined)
  const started = Promise.withResolvers<{ generation: string; pid: number }>()
  let child: ChildProcessWithoutNullStreams | undefined
  let nativeKill: (() => boolean) | undefined, closed: Promise<void> | undefined
  let innerEmpty = false,
    helperClosed = false,
    groupReleased = false
  let cancelled = false,
    go = false,
    lateHello = false
  let helloTimer: ReturnType<typeof setTimeout> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const windows: WindowsLaunchOwner = {
    executablePath: process.execPath,
    directory,
    generation,
    started: started.promise,
    empty: empty.promise,
    rootExit: new Promise<WindowsRootExit>(() => undefined),
    armStartup() {},
    cancel() {
      events.push('inner-cancel')
      cancelled = true
      if (noGo || timer || helperClosed) return
      timer = setTimeout(() => {
        if (missing) {
          events.push('inner-missing')
          empty.reject(new Error('Missing authenticated inner empty receipt'))
        } else {
          innerEmpty = true
          events.push('inner-empty')
          empty.resolve({ generation, active: 0, exitCode: 1 })
        }
        nativeKill?.()
      }, 350)
    },
    async disposeControl() {
      clearTimeout(timer)
      clearTimeout(helloTimer)
      if (scenario.controlFailure) throw new Error('Control disposal unconfirmed')
    },
    diagnostic() {
      const stages: Record<string, number> = {}
      if (go) stages.go = 0
      return { generation, stages }
    },
  }
  const group = new OwnedProcessGroup()
  vi.spyOn(group, 'spawn').mockImplementation((command, args, options) => {
    child = spawn(command, args, { cwd: options?.cwd, shell: false, stdio: 'pipe' })
    nativeKill = child.kill.bind(child)
    child.once('spawn', () => {
      if (!noGo) {
        go = true
        started.resolve({ generation, pid: child!.pid! })
      } else
        helloTimer = setTimeout(() => {
          lateHello = true
          if (!cancelled) {
            go = true
            started.resolve({ generation, pid: child!.pid! })
          }
        }, 50)
    })
    closed = new Promise((resolve) =>
      child!.once('close', () => {
        helperClosed = true
        if (!innerEmpty) empty.reject(new Error('Observed helper closed without its empty receipt'))
        resolve()
      }),
    )
    return child
  })
  vi.spyOn(group, 'released', 'get').mockImplementation(() => groupReleased)
  const outerClose = vi.spyOn(group, 'close').mockImplementation(async () => {
    events.push('outer-close')
    if (scenario.missingClose) {
      groupReleased = true
      return
    }
    if (!innerEmpty && !helperClosed) {
      await delay(250)
      nativeKill?.()
    }
    await closed
    if (scenario.outerFailure) throw new Error('Outer release unconfirmed')
    groupReleased = true
  })
  const owner = await NativeProcessOwner.prepare(
    process.execPath,
    directory,
    performance.now() + 10_000,
    group,
    windows,
  )
  try {
    const managed = owner.start(['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], {
      cwd: directory,
    })
    await once(managed, 'spawn')
    const snapshot = windows.diagnostic()
    if (noGo) snapshot.stages.go = 1
    else delete snapshot.stages.go
    const work = owner.close()
    let error: unknown
    try {
      await work
    } catch (failure) {
      error = failure
    }
    expect(error instanceof Error ? error.message : error).toBe(scenario.expectedError)
    expect(events).toEqual(
      noGo
        ? ['inner-cancel', 'outer-close']
        : ['inner-cancel', missing ? 'inner-missing' : 'inner-empty', 'outer-close'],
    )
    expect(go).toBe(!noGo)
    expect(lateHello).toBe(noGo)
    expect(owner.facts()).toMatchObject({
      childClosed: !scenario.missingClose,
      groupReleased: !scenario.outerFailure,
      windowsJobEmpty: noGo ? null : !missing,
      released: scenario.expectedError === undefined,
    })
    const retained = await readFile(marker, 'utf8').catch((failure: unknown) => {
      if (failure && typeof failure === 'object' && Reflect.get(failure, 'code') === 'ENOENT')
        return undefined
      throw failure
    })
    expect(retained).toBe(scenario.expectedError ? 'retained fixture evidence' : undefined)
    expect(outerClose).toHaveBeenCalledTimes(1)
  } finally {
    clearTimeout(timer)
    clearTimeout(helloTimer)
    nativeKill?.()
    await closed
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
