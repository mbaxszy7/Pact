import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { test, expect } from 'vitest'

import { PactDatabase } from './pact-database.js'

const require = createRequire(import.meta.url)
const migrationsFolder = resolve(import.meta.dirname, '../drizzle')
const worker = resolve(import.meta.dirname, '../scripts/database-owner-fixture.ts')

const close = async (child: ChildProcess, crash = false) => {
  const exited = once(child, 'exit')
  if (crash) child.kill('SIGKILL')
  else child.send('close')
  await exited
}

test('the primary database interface reserves the entire root across processes and releases after normal close or a crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pact-db-process-'))
  const filePath = join(root, 'pact.sqlite')
  const children: ChildProcess[] = []
  const start = async (file = filePath) => {
    const child = fork(worker, [file, migrationsFolder], {
      execArgv: ['--import', require.resolve('tsx')],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    children.push(child)
    const reply = await once(child, 'message')
    const message: unknown = reply[0]
    return { child, reply: message }
  }
  try {
    const first = await start()
    expect(first.reply).toEqual({ state: 'open' })
    // Different filenames in the same root must not defeat the root reservation.
    const blocked = await start(join(root, 'other.sqlite'))
    expect(blocked.reply).toEqual({ state: 'rejected', code: 'DATABASE_IN_USE' })
    await expect(PactDatabase.open({ filePath, migrationsFolder })).rejects.toMatchObject({
      code: 'DATABASE_IN_USE',
    })
    await close(first.child)
    const next = await start()
    expect(next.reply).toEqual({ state: 'open' })
    await close(next.child, true)
    const recovered = await PactDatabase.open({ filePath, migrationsFolder })
    recovered.close()
  } finally {
    await Promise.all(
      children
        .filter((child) => child.exitCode === null && child.signalCode === null)
        .map(async (child) => {
          const exited = once(child, 'exit')
          child.kill('SIGKILL')
          await exited
        }),
    )
    await rm(root, { recursive: true, force: true })
  }
}, 15_000)
