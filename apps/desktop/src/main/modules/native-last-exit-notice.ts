import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  MAX_TERMINAL_LAST_EXIT_NOTICE_BYTES,
  MAX_TOTAL_TERMINALS,
  terminalLastExitNoticeSchema,
  type TerminalLastExitNotice,
} from '@pact/contracts'

const MAX_NOTICE_FILE_BYTES = MAX_TERMINAL_LAST_EXIT_NOTICE_BYTES

export interface NativeLastExitNoticeStore {
  record(reason: TerminalLastExitNotice['reason'], unconfirmedCount: number): Promise<boolean>
  consume(): Promise<TerminalLastExitNotice | null>
}

function fitNoticeToBudget(
  reason: TerminalLastExitNotice['reason'],
  rawCount: number,
): TerminalLastExitNotice {
  const unconfirmedCount = Math.max(1, Math.min(MAX_TOTAL_TERMINALS, Math.floor(rawCount || 1)))
  const createdAt = new Date().toISOString()
  const candidate: TerminalLastExitNotice = {
    version: 1,
    createdAt,
    unconfirmedCount,
    reason,
  }
  const serialized = `${JSON.stringify(candidate)}\n`
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NOTICE_FILE_BYTES) {
    throw new Error('Terminal last-exit notice exceeds 1 KiB budget.')
  }
  return terminalLastExitNoticeSchema.parse(candidate)
}

/**
 * Owns the bounded (<= 1 KiB) count-only one-time last-exit notice file persisted in `userData`
 * when Pact shuts down with unconfirmed terminal processes.
 */
export function createNativeLastExitNoticeStore(databaseFile: string): NativeLastExitNoticeStore {
  const filePath =
    databaseFile === ':memory:' ? undefined : join(dirname(databaseFile), 'last-exit-notice.json')
  let memoryFallback: TerminalLastExitNotice | null = null

  return {
    async record(reason, unconfirmedCount) {
      if (!Number.isFinite(unconfirmedCount) || unconfirmedCount <= 0) return true
      const notice = fitNoticeToBudget(reason, unconfirmedCount)
      if (!filePath) {
        memoryFallback = notice
        return true
      }
      const tempPath = `${filePath}.tmp.${randomUUID()}`
      try {
        await writeFile(tempPath, `${JSON.stringify(notice)}\n`, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        })
        await rename(tempPath, filePath)
        return true
      } catch {
        await rm(tempPath, { force: true }).catch(() => undefined)
        return false
      }
    },

    async consume() {
      if (!filePath) {
        const value = memoryFallback
        memoryFallback = null
        return value
      }
      try {
        const info = await lstat(filePath)
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size < 1 ||
          info.size > MAX_NOTICE_FILE_BYTES
        ) {
          await rm(filePath, { force: true }).catch(() => undefined)
          return null
        }
        const raw = await readFile(filePath, 'utf8')
        await rm(filePath, { force: true }).catch(() => undefined)
        const parsed = terminalLastExitNoticeSchema.safeParse(JSON.parse(raw))
        return parsed.success ? parsed.data : null
      } catch {
        await rm(filePath, { force: true }).catch(() => undefined)
        return null
      }
    },
  }
}
