import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  LOG_DIRECTORY_BYTES,
  LOG_FILE_SLOTS,
  LOG_RETENTION_MS,
  LOG_SLOT_BYTES,
} from '@pact/contracts/diagnostics'

import { FileLog } from './file-log'

const roots = new Set<string>()
const writers = new Set<FileLog>()
afterEach(async () => {
  await Promise.all([...writers].map((writer) => writer.close().catch(() => undefined)))
  writers.clear()
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pact-log-test-'))
  roots.add(root)
  const directory = join(root, 'logs', 'development')
  const writer = new FileLog(directory, process.pid)
  writers.add(writer)
  await writer.initialize()
  return { root, directory, writer }
}
const line = (launchId = randomUUID()): string =>
  `${JSON.stringify({ timestamp: new Date().toISOString(), operation: 'app', phase: 'started', level: 'info', identity: { launchId, appVersion: '0.0.0', process: 'main', pid: process.pid } })}\n`

describe('Fixed shared file-log ownership', () => {
  it('keeps active files independent across concurrent owners and refuses an eleventh owner', async () => {
    const { directory, writer } = await fixture()
    const owners = [
      writer,
      ...Array.from({ length: LOG_FILE_SLOTS - 1 }, () => new FileLog(directory, process.pid)),
    ]
    for (const owner of owners) writers.add(owner)
    const lines = owners.map(() => line())
    await Promise.all(owners.map((owner, index) => owner.append(lines[index]!)))
    const extra = new FileLog(directory, process.pid)
    writers.add(extra)
    await expect(extra.append(line())).rejects.toThrow('NO_SLOT')
    const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(LOG_FILE_SLOTS)
    expect(
      new Set(await Promise.all(files.map((name) => readFile(join(directory, name), 'utf8')))),
    ).toEqual(new Set(lines))
    await Promise.all(owners.map((owner) => owner.close()))
    expect((await readdir(directory)).filter((name) => name.startsWith('.'))).toHaveLength(0)
  })

  it('rotates before overflowing a single slot and keeps all owned bytes under the directory cap', async () => {
    const { directory, writer } = await fixture()
    const largeLine = `${JSON.stringify({ fixture: 'bounded', padding: 'x'.repeat(3900) })}\n`
    const writes = Math.ceil(LOG_SLOT_BYTES / Buffer.byteLength(largeLine)) + 1
    // oxlint-disable-next-line no-await-in-loop -- Exercise one real sequential append owner until the exact byte boundary.
    for (let i = 0; i < writes; i++) await writer.append(largeLine)
    const files = (await readdir(directory)).filter((name) => name.endsWith('.jsonl'))
    expect(files).toHaveLength(2)
    const sizes = await Promise.all(
      files.map(async (name) => (await stat(join(directory, name))).size),
    )
    expect(sizes.every((size) => size <= LOG_SLOT_BYTES)).toBe(true)
    const owned = await Promise.all(
      (await readdir(directory)).map(async (name) => (await stat(join(directory, name))).size),
    )
    expect(owned.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(LOG_DIRECTORY_BYTES)
  })

  it('prunes expired inactive slots without touching a live writer or unrelated file', async () => {
    const { directory, writer } = await fixture()
    await writer.append(line())
    const activeFile = join(directory, 'pact-0.jsonl')
    const expiredFile = join(directory, 'pact-1.jsonl')
    const old = new Date(Date.now() - LOG_RETENTION_MS - 1000)
    await writeFile(expiredFile, line())
    await writeFile(join(directory, 'user-file.txt'), 'preserve user file')
    await utimes(activeFile, old, old)
    await utimes(expiredFile, old, old)
    const other = new FileLog(directory, process.pid)
    writers.add(other)
    await other.initialize()
    expect(await readFile(activeFile, 'utf8')).not.toBe('')
    await expect(stat(expiredFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'user-file.txt'), 'utf8')).toBe('preserve user file')
  })

  it('repairs only a partial inactive tail, then protects complete records', async () => {
    const { directory, writer } = await fixture()
    const complete = line()
    const file = join(directory, 'pact-0.jsonl')
    await writeFile(file, complete + '{"partial":')
    await writer.initialize()
    expect(await readFile(file, 'utf8')).toBe(complete)
  })

  it('reclaims a proven dead owner, reports missing close evidence and keeps unknown ownership intact', async () => {
    const { directory, writer } = await fixture()
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      shell: false,
      stdio: 'ignore',
    })
    if (!child.pid) throw new Error('Owned process has no PID')
    await once(child, 'exit')
    const token = randomUUID(),
      launchId = randomUUID()
    const file = join(directory, 'pact-0.jsonl')
    await writeFile(
      file,
      JSON.stringify({
        operation: 'app',
        phase: 'started',
        identity: { launchId, pid: child.pid },
      }) + '\n',
    )
    await writeFile(join(directory, '.pact-0.owner'), JSON.stringify({ pid: child.pid, token }))
    await link(join(directory, '.pact-0.owner'), join(directory, '.pact-0.lock'))
    expect(await writer.initialize()).toBe(1)
    expect((await readdir(directory)).filter((name) => name.startsWith('.'))).toHaveLength(0)
    await writeFile(join(directory, '.pact-0.owner'), '')
    const original = await readFile(file, 'utf8')
    await writer.initialize()
    await writer.append(line())
    expect(await readFile(file, 'utf8')).toBe(original)
    expect(await readFile(join(directory, '.pact-0.owner'), 'utf8')).toBe('')
  })

  it('refuses a symlink or hardlink before mutating its external target', async () => {
    const { root, directory, writer } = await fixture()
    const target = join(root, 'original.txt')
    await writeFile(target, 'must remain intact')
    await symlink(target, join(directory, 'pact-0.jsonl'))
    await expect(writer.append(line())).rejects.toThrow('EACCES')
    expect(await readFile(target, 'utf8')).toBe('must remain intact')
    await rm(join(directory, 'pact-0.jsonl'))
    await link(target, join(directory, 'pact-0.jsonl'))
    await expect(writer.append(line())).rejects.toThrow('EACCES')
    expect(await readFile(target, 'utf8')).toBe('must remain intact')
  })

  it('keeps private permissions and releases ownership after one hundred open/close cycles', async () => {
    const { directory, writer } = await fixture()
    for (let i = 0; i < 100; i++) {
      // oxlint-disable-next-line no-await-in-loop -- The same owner must release before reacquiring its next slot.
      await writer.append(line())
      // oxlint-disable-next-line no-await-in-loop
      await writer.close()
    }
    const names = await readdir(directory)
    expect(names.filter((name) => name.startsWith('.'))).toHaveLength(0)
    expect(names.filter((name) => name.endsWith('.jsonl'))).toHaveLength(LOG_FILE_SLOTS)
  })
  it.runIf(process.platform !== 'win32')(
    'uses private POSIX directory and file permissions',
    async () => {
      const { directory, writer } = await fixture()
      await writer.append(line())
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(directory, 'pact-0.jsonl'))).mode & 0o777).toBe(0o600)
    },
  )
})
