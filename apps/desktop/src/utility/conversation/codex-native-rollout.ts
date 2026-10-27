import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'

import type { NativeInitializationWitness } from '@pact/contracts'

import { nativeInitializationWitnessSchema } from '@pact/contracts'

import { AgentExecutionError } from './agent-execution-error'
import { nativeHistoryImageBytes } from './native-image-content'
import { NativeWorkingMemory, NATIVE_OWNER_WORKING_BYTES } from './native-working-memory'

const TEXT_BYTES = 8 * 1024 * 1024
const ROLLOUT_BYTES = 32 * 1024 * 1024
// A legal large message is one native record; the complete 8 MiB read remains bounded.
const LINE_BYTES = ROLLOUT_BYTES
const RECORDS = 10_000
const READ_DEADLINE_MS = 10_000

interface CodexInitializationRolloutInput {
  storageRoot: string
  path: string
  nativeSessionId: string
  rebuildId: string
  sourceHash?: string
  expectedSeedHashes: readonly string[]
  seedHash: string
  witness?: NativeInitializationWitness
}

const invalid = (message: string): AgentExecutionError =>
  new AgentExecutionError('protocol_error', message, false)

/** One metadata-selected immutable read: no directory discovery, model, native file writes or retained cache. */
export async function readCodexInitializationRollout(
  input: CodexInitializationRolloutInput,
  signal: AbortSignal,
  observePhysicalCompletion?: (completion: Promise<void>) => void,
): Promise<NativeInitializationWitness> {
  const reservation = new NativeWorkingMemory().reserve(NATIVE_OWNER_WORKING_BYTES)
  const physical = Promise.withResolvers<void>()
  observePhysicalCompletion?.(physical.promise)
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), READ_DEADLINE_MS)
  const observed = AbortSignal.any([signal, controller.signal])
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let handleClosed = false,
    readJoined = false,
    released = false
  const settlePhysical = (): void => {
    if (released || !readJoined || (handle && !handleClosed)) return
    released = true
    reservation.release()
    physical.resolve()
  }
  try {
    observed.throwIfAborted()
    if (
      !input.expectedSeedHashes.length ||
      input.expectedSeedHashes.length > 4096 ||
      !isAbsolute(input.path)
    )
      throw invalid('The native initialization rollout identity is incomplete.')
    const witness = input.witness
      ? nativeInitializationWitnessSchema.parse(input.witness)
      : undefined

    if (witness && witness.nativeSessionId !== input.nativeSessionId)
      throw invalid('The stored native initialization witness belongs to another Session.')
    const root = await realpath(input.storageRoot)
    const canonical = await realpath(input.path)
    const location = relative(root, canonical)
    if (
      !location ||
      location === '..' ||
      location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(location)
    )
      throw invalid('The native rollout path is outside the creating runtime storage root.')
    observed.throwIfAborted()
    const before = await lstat(canonical, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n)
      throw invalid('The native rollout must be one ordinary non-linked file.')
    if (before.size <= 0n || before.size > BigInt(ROLLOUT_BYTES))
      throw new AgentExecutionError(
        'response_too_large',
        'The complete native rollout exceeds its read budget.',
        false,
      )
    const bytes = Number(before.size)
    const prefixBytes = witness?.verifiedPrefixBytes ?? bytes
    if (prefixBytes > bytes)
      throw invalid('The stored native initialization prefix is no longer present.')
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat({ bigint: true })
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      (await realpath(input.path)) !== canonical
    )
      throw invalid('The native rollout changed while it was opened.')
    observed.throwIfAborted()
    const prefixHash = createHash('sha256')
    const seedHash = createHash('sha256')
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let position = 0,
      recordEnd = 0,
      recordCount = 0,
      prefixRecords = 0,
      seeds = 0,
      sessionMeta = false,
      imageBytes = 0
    let lineBytes = 0
    let parts: Buffer[] = []
    const inspect = (line: Buffer): void => {
      observed.throwIfAborted()
      if (++recordCount > RECORDS) throw invalid('The native rollout exceeds its record budget.')
      if (recordEnd > prefixBytes && recordEnd - line.length - 1 < prefixBytes)
        throw invalid('The stored native initialization prefix is not a complete record boundary.')
      const inPrefix = recordEnd <= prefixBytes
      if (inPrefix) prefixRecords += 1
      const record: unknown = JSON.parse(decoder.decode(line))
      if (!record || typeof record !== 'object' || Array.isArray(record))
        throw invalid('The native rollout contains an invalid record.')
      imageBytes += nativeHistoryImageBytes(record)
      const type = Reflect.get(record, 'type'),
        payload = Reflect.get(record, 'payload')
      if (!payload || typeof payload !== 'object' || Array.isArray(payload))
        throw invalid('The native rollout contains an invalid payload.')
      if (type === 'session_meta') {
        if (Reflect.get(payload, 'id') !== input.nativeSessionId)
          throw invalid('The native rollout Session identity did not match.')
        if (inPrefix) {
          if (sessionMeta) throw invalid('The native rollout repeats its Session identity.')
          sessionMeta = true
        }
        return
      }
      if (!sessionMeta) throw invalid('The native rollout has no preceding Session identity.')
      if (type !== 'response_item') {
        if (!inPrefix)
          throw invalid('An unclassified native record follows the confirmed initialization.')
        return
      }
      if (Reflect.get(payload, 'type') !== 'message')
        throw invalid('Native model or tool work contradicts the initialization readback.')
      const role = Reflect.get(payload, 'role')
      // Native base instructions may precede/refresh the imported reference history.
      if (role === 'developer' || role === 'system') return
      if (role !== 'user' || !inPrefix)
        throw invalid('Additional native user or model work follows the confirmed initialization.')
      const content = Reflect.get(payload, 'content')
      if (
        !Array.isArray(content) ||
        !content.length ||
        content.some(
          (part) =>
            !part ||
            typeof part !== 'object' ||
            !(['input_text', 'text'].includes(Reflect.get(part, 'type'))
              ? typeof Reflect.get(part, 'text') === 'string'
              : Reflect.get(part, 'type') === 'input_image' &&
                typeof Reflect.get(part, 'image_url') === 'string'),
        )
      )
        throw invalid('The native seed message contains unsupported content blocks.')
      const text = Reflect.get(content[0], 'text')
      if (typeof text !== 'string') throw invalid('The native seed text is missing.')
      let marker: unknown
      try {
        marker = JSON.parse(text)
      } catch {
        // The native AGENTS/environment prologue precedes the first injected
        // seed. It is sealed with the baseline, not mistaken for a task answer.
        if (!seeds && !text.startsWith('{"pactContext"')) return
        throw invalid('The native seed message is not valid JSON.')
      }
      if (
        !seeds &&
        !(marker && typeof marker === 'object' && Reflect.get(marker, 'pactContext') === true)
      )
        return
      if (
        !marker ||
        typeof marker !== 'object' ||
        Reflect.get(marker, 'pactContext') !== true ||
        Reflect.get(marker, 'pactRebuildId') !== input.rebuildId ||
        Reflect.get(marker, 'pactSourceHash') !== input.sourceHash ||
        Reflect.get(marker, 'chunkIndex') !== seeds ||
        input.expectedSeedHashes[seeds] !== createHash('sha256').update(text).digest('hex')
      )
        throw invalid('The complete frozen native seed did not match its rollout readback.')
      const imageSeed =
        Reflect.get(marker, 'formatVersion') === 'pact-native-context-v2' &&
        Reflect.get(marker, 'kind') === 'image'
      if (
        content.length !== (imageSeed ? 2 : 1) ||
        (imageSeed &&
          (Reflect.get(content[1], 'type') !== 'input_image' ||
            nativeHistoryImageBytes(record) === 0))
      )
        throw invalid('The native seed image blocks are missing or do not match the manifest.')
      seedHash.update(text)
      seeds += 1
    }
    // Keep one close owner. ReadStream destruction can initiate FileHandle.close itself,
    // after which a second close() may resolve before the first OS close has settled.
    const readBuffer = Buffer.allocUnsafe(64 * 1024)
    while (position < bytes) {
      observed.throwIfAborted()
      // oxlint-disable-next-line no-await-in-loop -- One bounded physical read at a time; no stream can close this handle.
      const { bytesRead } = await handle.read(
        readBuffer,
        0,
        Math.min(readBuffer.length, bytes - position),
        position,
      )
      if (bytesRead === 0) break
      const raw = readBuffer.subarray(0, bytesRead)
      observed.throwIfAborted()
      const prefixLength = Math.max(0, Math.min(raw.length, prefixBytes - position))
      if (prefixLength) prefixHash.update(raw.subarray(0, prefixLength))
      position += raw.length
      if (position > bytes || position > ROLLOUT_BYTES)
        throw invalid('The native rollout grew during inspection.')
      let offset = 0
      while (offset < raw.length) {
        const newline = raw.indexOf(10, offset)
        const end = newline < 0 ? raw.length : newline
        const part = raw.subarray(offset, end)
        lineBytes += part.length
        if (lineBytes > LINE_BYTES)
          throw new AgentExecutionError(
            'response_too_large',
            'A native rollout record exceeds the complete read budget.',
            false,
          )
        // An incomplete record survives the next reuse of the fixed read buffer.
        if (part.length) parts.push(Buffer.from(part))
        if (newline < 0) break
        recordEnd += lineBytes + 1
        inspect(Buffer.concat(parts, lineBytes))
        parts = []
        lineBytes = 0
        offset = end + 1
      }
    }
    if (
      lineBytes ||
      position - imageBytes > TEXT_BYTES ||
      position !== bytes ||
      !sessionMeta ||
      seeds !== input.expectedSeedHashes.length ||
      seedHash.digest('hex') !== input.seedHash
    )
      throw invalid('The complete native initialization rollout could not be verified.')
    const hash = prefixHash.digest('hex')
    if (witness && (hash !== witness.verifiedPrefixSha256 || prefixRecords !== witness.recordCount))
      throw invalid('The stored native initialization prefix was rewritten.')
    const after = await handle.stat({ bigint: true })
    const named = await lstat(canonical, { bigint: true })
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      (await realpath(input.path)) !== canonical ||
      (await realpath(input.storageRoot)) !== root
    )
      throw invalid('The native rollout changed during inspection.')
    observed.throwIfAborted()
    return (
      witness ?? {
        kind: 'codex_rollout_v1',
        nativeSessionId: input.nativeSessionId,
        verifiedPrefixBytes: bytes,
        verifiedPrefixSha256: hash,
        recordCount,
      }
    )
  } finally {
    clearTimeout(deadline)
    try {
      await handle?.close()
      handleClosed = true
    } finally {
      readJoined = true
      settlePhysical()
    }
  }
}
