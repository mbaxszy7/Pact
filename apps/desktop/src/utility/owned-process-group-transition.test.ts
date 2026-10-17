import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const observation = vi.hoisted(() => ({
  rootPid: 0,
  rootRow: '',
  reads: 0,
  injectZombie: true,
  zombieObserved: false,
  replaceLeader: false,
  leaderReplaced: false,
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: ExecFileOptionsWithStringEncoding,
      callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
    ) =>
      actual.execFile(file, args, options, (error, output, stderr) => {
        if (file === '/bin/ps') {
          observation.reads++
          observation.rootRow ||=
            output
              .split('\n')
              .find((line) => Number(/^\s*(\d+)/u.exec(line)?.[1]) === observation.rootPid) ?? ''
        }
        if (file === '/bin/ps' && observation.replaceLeader) {
          observation.replaceLeader = false
          observation.leaderReplaced = true
          // Bounded OS-observation fault injection, not an actual PID-reuse claim.
          // Preserve every real row, then model a changed birth for the old leader.
          output =
            output.trimEnd() +
            '\n' +
            observation.rootRow.replace(
              /^(\s*\d+\s+\d+\s+\d+\s+).+?(\s+\S+\s*)$/u,
              '$1Thu Jan 01 00:00:00 1970$2',
            )
        } else if (file === '/bin/ps' && observation.injectZombie && observation.reads >= 3) {
          output = output
            .split('\n')
            .map((line) => {
              if (Number(/^\s*(\d+)/u.exec(line)?.[1]) !== observation.rootPid) return line
              observation.zombieObserved = true
              // Keep actual PID/PPID/PGID/start. Only model the observed XNU exit state.
              return line.replace(/\S+\s*$/u, 'Z')
            })
            .join('\n')
        }
        callback(error, output, stderr)
      }),
  }
})
import { OwnedProcessGroup } from './owned-process-group'

let rootPid = 0,
  helperPid = 0
const cleanupIdentities: Array<{ pid: number; group: number; started: string }> = []
const directories: string[] = []
beforeEach(() => {
  rootPid = 0
  helperPid = 0
  cleanupIdentities.length = 0
  Object.assign(observation, {
    rootPid: 0,
    rootRow: '',
    reads: 0,
    injectZombie: true,
    zombieObserved: false,
    replaceLeader: false,
    leaderReplaced: false,
  })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const known of cleanupIdentities) {
    let row: string
    try {
      row = execFileSync('/bin/ps', ['-p', String(known.pid), '-o', 'pid=,pgid=,lstart='], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      continue
    }
    const current = /^(\d+)\s+(\d+)\s+(.+)$/u.exec(row)
    if (!current || Number(current[2]) !== known.group || current[3] !== known.started)
      throw new Error('The private transition fixture identity changed; no signal was sent.')
    try {
      process.kill(known.pid, 'SIGKILL')
    } catch (error) {
      if (typeof error !== 'object' || error === null || Reflect.get(error, 'code') !== 'ESRCH')
        throw error
    }
  }
  if (rootPid)
    await vi.waitFor(
      () => {
        try {
          process.kill(-rootPid, 0)
          throw new Error('Private transition group is still present.')
        } catch (error) {
          assert.equal(
            typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined,
            'ESRCH',
          )
        }
      },
      { timeout: 2000, interval: 20 },
    )
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

it.skipIf(process.platform === 'win32')(
  'uses a verified live helper when the unchanged root identity is reported as zombie',
  async () => {
    const helper = "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"
    const script = [
      "const {spawn}=require('node:child_process')",
      "process.on('SIGTERM',()=>{})",
      "const helper=spawn(process.execPath,['-e',process.argv[1]],{stdio:['ignore','pipe','ignore'],shell:false})",
      "helper.stdout.once('data',()=>console.log(helper.pid))",
      'setInterval(()=>{},1000)',
    ].join(';')
    const owner = new OwnedProcessGroup()
    const child = owner.spawn(process.execPath, ['-e', script, helper])
    rootPid = child.pid!
    observation.rootPid = rootPid
    const [data] = await once(child.stdout, 'data')
    helperPid = Number(String(data).trim())
    expect(Number.isSafeInteger(helperPid)).toBe(true)
    const rows = execFileSync(
      '/bin/ps',
      ['-p', `${rootPid},${helperPid}`, '-o', 'pid=,ppid=,pgid=,lstart='],
      { encoding: 'utf8', timeout: 1000 },
    )
    for (const row of rows.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/u.exec(row)!
      const pid = Number(match[1])
      expect(Number(match[2])).toBe(pid === rootPid ? process.pid : rootPid)
      expect(Number(match[3])).toBe(rootPid)
      cleanupIdentities.push({ pid, group: rootPid, started: match[4]! })
    }
    expect(cleanupIdentities).toHaveLength(2)
    await expect(owner.close()).resolves.toBeUndefined()
    expect(observation.zombieObserved).toBe(true)
    expect(owner.released).toBe(true)
    expect(() => process.kill(-rootPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(
      execFileSync('/bin/ps', ['-axo', 'pid='], { encoding: 'utf8', timeout: 1000 })
        .split(/\s+/u)
        .map(Number),
    ).not.toContain(helperPid)
  },
)

it.skipIf(process.platform === 'win32')(
  'rejects a changed leader observation before passively waiting on a closed root',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-group-identity-'))
    directories.push(directory)
    observation.injectZombie = false
    const helper = [
      "const {existsSync}=require('node:fs')",
      "const {join}=require('node:path')",
      "process.on('SIGTERM',()=>{})",
      "console.log('ready')",
      "setInterval(()=>{if(existsSync(join(process.argv[1],'release')))process.exit(0)},10)",
      'setTimeout(()=>process.exit(5),15000)',
    ].join(';')
    const script = [
      "const {spawn}=require('node:child_process')",
      "process.stdin.once('data',()=>{const helper=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:['ignore','pipe','ignore'],shell:false});helper.stdout.once('data',()=>{console.log(helper.pid);process.exit(0)})})",
      "console.log('root ready')",
      'setTimeout(()=>process.exit(5),15000)',
    ].join(';')
    const closeInput = vi.fn<() => Promise<void>>(async () =>
      writeFile(join(directory, 'release'), ''),
    )
    const owner = new OwnedProcessGroup({ onCloseInput: closeInput })
    const child = owner.spawn(process.execPath, ['-e', script, helper, directory])
    const closed = once(child, 'close')
    rootPid = child.pid!
    observation.rootPid = rootPid
    await once(child.stdout, 'data')
    await owner.observe()
    const root = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+\S+\s*$/u.exec(observation.rootRow)
    assert(root, 'A real root identity is required before observation fault injection.')
    cleanupIdentities.push({ pid: rootPid, group: rootPid, started: root[4]! })
    child.stdin.write('spawn\n')
    const [data] = await once(child.stdout, 'data')
    helperPid = Number(String(data).trim())
    expect(Number.isSafeInteger(helperPid)).toBe(true)
    const helperRow = execFileSync(
      '/bin/ps',
      ['-p', String(helperPid), '-o', 'pid=,pgid=,lstart='],
      {
        encoding: 'utf8',
        timeout: 1000,
      },
    )
    const knownHelper = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(helperRow)
    assert(knownHelper && Number(knownHelper[2]) === rootPid)
    cleanupIdentities.push({ pid: helperPid, group: rootPid, started: knownHelper[3]! })
    await closed
    observation.replaceLeader = true
    const signals: Array<Parameters<typeof process.kill>[1]> = []
    const actualKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === -rootPid && signal !== 0) signals.push(signal)
      return actualKill(pid, signal)
    })
    const closing = owner.close()
    await expect(closing).rejects.toThrow('The owned group identity changed.')
    await vi.waitFor(() => {
      expect(() => actualKill(-rootPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    })
    expect(observation.leaderReplaced).toBe(true)
    expect(signals).toEqual([])
    expect(owner.released).toBe(false)
    expect(owner.close()).toBe(closing)
    await expect(owner.close()).rejects.toThrow('The owned group identity changed.')
    expect(closeInput).toHaveBeenCalledOnce()
  },
)
