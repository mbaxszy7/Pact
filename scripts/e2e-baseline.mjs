import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const baselinePath = fileURLToPath(new URL('../tests/e2e/baseline.json', import.meta.url))
const baselineSha256 = '400b39edb3f7fa6a276f066a2ea06fe453ae16bf8bcc22816008633386c66a1b'
const maxBaselineBytes = 1024 * 1024

/** Audited source evidence survives a fresh clone without importing private Git history. */
export function readE2EBaseline(path = baselinePath) {
  const buffer = Buffer.alloc(maxBaselineBytes + 1)
  const descriptor = openSync(path, 'r')
  let size = 0
  try {
    while (size < buffer.length) {
      const count = readSync(descriptor, buffer, size, buffer.length - size, null)
      if (!count) break
      size += count
    }
  } finally {
    closeSync(descriptor)
  }
  if (size > maxBaselineBytes) throw new Error('E2E baseline exceeds its byte bound')
  const bytes = buffer.subarray(0, size)
  if (createHash('sha256').update(bytes).digest('hex') !== baselineSha256)
    throw new Error('Immutable E2E baseline integrity check failed')
  const baseline = JSON.parse(bytes.toString('utf8'))
  if (
    baseline.version !== 1 ||
    baseline.revision !== '6fade3636a7d77060ec4b35a50cdd764e3726228' ||
    Object.keys(baseline.files).length !== 21 ||
    Object.entries(baseline.files).some(
      ([name, source]) =>
        !/^tests\/e2e\/[a-z0-9-]+\.spec\.ts$/u.test(name) ||
        typeof source !== 'string' ||
        Buffer.byteLength(source) > 512 * 1024,
    )
  )
    throw new Error('Immutable E2E baseline shape is invalid')
  return baseline
}
