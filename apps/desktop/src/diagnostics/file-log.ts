import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  LOG_FILE_BYTES,
  LOG_SLOT_BYTES,
  LOG_RECORD_BYTES,
  LOG_FILE_SLOTS,
  LOG_RETENTION_MS,
} from '@pact/contracts/diagnostics'

interface Owner {
  pid: number
  token: string
}
interface Slot {
  index: number
  handle: FileHandle
  bytes: number
  openedAt: number
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

/** Fixed slots reserve capacity across instances, including active files. */
export class FileLog {
  private readonly owner: Owner
  private slot: Slot | undefined

  constructor(
    private readonly directory: string,
    pid: number,
  ) {
    this.owner = { pid, token: randomUUID() }
  }

  async initialize(): Promise<number> {
    const incomplete = new Set<string>()
    const ended = new Set<string>()
    const parent = dirname(this.directory)
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const parentInfo = await lstat(parent)
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error('EACCES')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directoryInfo = await lstat(this.directory)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('EACCES')
    await chmod(this.directory, 0o700)
    // Inspect only the ten owned names; unrelated files never enter retention.
    for (let index = 0; index < LOG_FILE_SLOTS; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Fixed ten slots require sequential ownership claims.
      const info = await this.fileInfo(index)
      if (!info) continue
      // oxlint-disable-next-line no-await-in-loop -- Fixed owned slots only.
      if (!(await this.claim(index))) continue
      try {
        // oxlint-disable-next-line no-await-in-loop -- Recheck under ownership, after concurrent rotation.
        const ownedInfo = await this.fileInfo(index)
        if (!ownedInfo) continue
        if (Date.now() - ownedInfo.mtimeMs >= LOG_RETENTION_MS) {
          // oxlint-disable-next-line no-await-in-loop
          await unlink(this.path(index, 'jsonl'))
        } else {
          // oxlint-disable-next-line no-await-in-loop
          const handle = await open(
            this.path(index, 'jsonl'),
            constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
          )
          try {
            // oxlint-disable-next-line no-await-in-loop
            const current = await handle.stat()
            if (!current.isFile() || current.nlink !== 1 || current.size > LOG_SLOT_BYTES)
              throw new Error('EACCES')
            const buffer = Buffer.alloc(Math.min(current.size, LOG_RECORD_BYTES + 1))
            // oxlint-disable-next-line no-await-in-loop
            const result = await handle.read(buffer, 0, buffer.length, current.size - buffer.length)
            let tail = buffer.subarray(0, result.bytesRead)
            if (tail.length && tail[tail.length - 1] !== 10) {
              const newline = tail.lastIndexOf(10)
              if (newline < 0 && current.size > buffer.length) throw new Error('INVALID_RECORD')
              // oxlint-disable-next-line no-await-in-loop
              await handle.truncate(current.size - buffer.length + newline + 1)
              tail = tail.subarray(0, newline + 1)
            }
            if (tail.length) {
              const start = tail.lastIndexOf(10, tail.length - 2) + 1
              try {
                const record: unknown = JSON.parse(
                  tail.subarray(start, tail.length - 1).toString('utf8'),
                )
                if (record && typeof record === 'object') {
                  const identity = Reflect.get(record, 'identity')
                  const launchId =
                    identity && typeof identity === 'object'
                      ? Reflect.get(identity, 'launchId')
                      : undefined
                  const pid =
                    identity && typeof identity === 'object'
                      ? Reflect.get(identity, 'pid')
                      : undefined
                  if (typeof launchId === 'string' && /^[a-f\d-]{36}$/u.test(launchId)) {
                    if (
                      Reflect.get(record, 'operation') === 'shutdown' &&
                      Reflect.get(record, 'phase') === 'closed'
                    )
                      ended.add(launchId)
                    else if (Number.isInteger(pid) && pid > 0 && !alive(pid))
                      incomplete.add(launchId)
                  }
                }
              } catch {
                /* Historical diagnostics may be incomplete; never deserialize them into product state. */
              }
            }
          } finally {
            // oxlint-disable-next-line no-await-in-loop
            await handle.close()
          }
        }
      } finally {
        // oxlint-disable-next-line no-await-in-loop
        await this.release(index)
      }
    }
    return [...incomplete].filter((id) => !ended.has(id)).length
  }

  async maintain(): Promise<void> {
    if (this.slot && Date.now() - this.slot.openedAt >= LOG_RETENTION_MS) await this.close()
    await this.initialize()
  }

  async append(line: string): Promise<void> {
    const bytes = Buffer.byteLength(line)
    if (bytes > LOG_FILE_BYTES) throw new Error('INVALID_RECORD')
    if (
      this.slot &&
      (this.slot.bytes + bytes > LOG_SLOT_BYTES ||
        Date.now() - this.slot.openedAt >= LOG_RETENTION_MS)
    )
      await this.close()
    if (!this.slot) await this.rotate()
    const slot = this.slot!
    const buffer = Buffer.from(line)
    let written = 0
    while (written < buffer.length) {
      // oxlint-disable-next-line no-await-in-loop -- Partial filesystem writes must finish before acknowledging a record.
      const result = await slot.handle.write(buffer, written, buffer.length - written, null)
      if (!result.bytesWritten) throw new Error('EIO')
      written += result.bytesWritten
      slot.bytes += result.bytesWritten
    }
  }

  async close(): Promise<void> {
    const slot = this.slot
    this.slot = undefined
    if (!slot) return
    try {
      await slot.handle.close()
    } finally {
      await this.release(slot.index)
    }
  }

  private path(index: number, suffix: string): string {
    return join(this.directory, `${suffix === 'jsonl' ? '' : '.'}pact-${index}.${suffix}`)
  }

  private async fileInfo(index: number) {
    try {
      const info = await lstat(this.path(index, 'jsonl'))
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > LOG_SLOT_BYTES)
        throw new Error('EACCES')
      return info
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
  }

  private async readOwner(path: string): Promise<Owner | undefined> {
    try {
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.size > 256) return undefined
        const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
        if (!parsed || typeof parsed !== 'object') return undefined
        const pid = Reflect.get(parsed, 'pid')
        const token = Reflect.get(parsed, 'token')
        return Number.isInteger(pid) &&
          pid > 0 &&
          pid <= 0x7fffffff &&
          typeof token === 'string' &&
          /^[a-f\d-]{36}$/u.test(token)
          ? { pid, token }
          : undefined
      } finally {
        await handle.close()
      }
    } catch {
      return undefined
    }
  }

  private async claim(index: number): Promise<boolean> {
    const prepared = this.path(index, 'owner')
    const lock = this.path(index, 'lock')
    const existing = await this.readOwner(prepared)
    if (existing && !alive(existing.pid)) {
      // Serialize reapers. Unknown/partial ownership fails closed, never age-reclaims a live owner.
      let reaper: FileHandle | undefined
      try {
        reaper = await open(this.path(index, 'reap'), 'wx', 0o600)
        const current = await this.readOwner(prepared)
        const locked = await this.readOwner(lock)
        if (
          current?.token === existing.token &&
          !alive(current.pid) &&
          (!locked || locked.token === current.token)
        ) {
          await unlink(prepared)
          if (locked) await unlink(lock)
        }
      } catch {
        /* Another reaper, or ownership cannot be proved. */
      } finally {
        if (reaper) {
          await reaper.close()
          await unlink(this.path(index, 'reap')).catch(() => undefined)
        }
      }
    }
    let handle: FileHandle | undefined
    let installed = false
    try {
      handle = await open(prepared, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(this.owner))
      await handle.close()
      handle = undefined
      // The fixed lock appears atomically with complete identity on macOS and NTFS.
      await link(prepared, lock)
      installed = true
      return true
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    } finally {
      if (handle) await handle.close().catch(() => undefined)
      if (!installed && (await this.readOwner(prepared))?.token === this.owner.token)
        await unlink(prepared).catch(() => undefined)
    }
  }

  private async release(index: number): Promise<void> {
    const lock = this.path(index, 'lock')
    if ((await this.readOwner(lock))?.token === this.owner.token) await unlink(lock)
    if ((await this.readOwner(this.path(index, 'owner')))?.token === this.owner.token)
      await unlink(this.path(index, 'owner'))
  }

  private async rotate(): Promise<void> {
    const candidates = await Promise.all(
      Array.from({ length: LOG_FILE_SLOTS }, async (_, index) => ({
        index,
        info: await this.fileInfo(index),
      })),
    )
    candidates.sort((a, b) => (a.info?.mtimeMs ?? 0) - (b.info?.mtimeMs ?? 0))
    for (const { index } of candidates) {
      // oxlint-disable-next-line no-await-in-loop -- Claim one oldest available fixed slot without touching a live writer.
      if (!(await this.claim(index))) continue
      let handle: FileHandle | undefined
      try {
        // Opening without truncation lets us refuse symlinks/hardlinks before mutation.
        // oxlint-disable-next-line no-await-in-loop
        handle = await open(
          this.path(index, 'jsonl'),
          constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
        // oxlint-disable-next-line no-await-in-loop
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1) throw new Error('EACCES')
        // oxlint-disable-next-line no-await-in-loop
        await handle.chmod(0o600)
        // oxlint-disable-next-line no-await-in-loop
        await handle.truncate(0)
        this.slot = { index, handle, bytes: 0, openedAt: Date.now() }
        return
      } catch (error) {
        // oxlint-disable-next-line no-await-in-loop
        await handle?.close().catch(() => undefined)
        // oxlint-disable-next-line no-await-in-loop
        await this.release(index)
        throw error
      }
    }
    throw new Error('NO_SLOT')
  }
}
