import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process'

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const observation = vi.hoisted(() => ({ rootPid: 0, reads: 0, zombieObserved: false }))
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
        if (file === '/bin/ps' && ++observation.reads >= 3) {
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
