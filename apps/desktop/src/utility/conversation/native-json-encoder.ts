import { setImmediate } from 'node:timers/promises'

import type { IpcTrafficMeasurement } from '@pact/contracts'

import { logicalIpcMeasurement } from '../../shared/logical-ipc-traffic'
import { AgentExecutionError } from './agent-execution-error'
import { NATIVE_FRAME_WRITE_CHUNK_BYTES } from './native-frame-writer'

const STRING_SLICE_CHARACTERS = 4_096
const MAX_CONTAINER_DEPTH = 64
const WORK_TOKENS_BEFORE_YIELD = 256
const CONTAINER_ESTIMATE_BYTES = 96
const PROPERTY_ESTIMATE_BYTES = 64
const ARRAY_SLOT_ESTIMATE_BYTES = 16
const STRING_ESTIMATE_BYTES = 48
const SYMBOL_ESTIMATE_BYTES = 48
const PRIMITIVE_ESTIMATE_BYTES = 16

const unsupported = (): AgentExecutionError =>
  new AgentExecutionError('protocol_error', 'The native request contains unsupported JSON.', false)

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new AgentExecutionError('user_stopped', 'Native request encoding was cancelled.', false)
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** One <=4096-character slice; fragments and escaped bytes never grow with the full string. */
function escapeStringSlice(slice: string): string {
  const fragments: string[] = []
  let spanStart = 0
  for (let index = 0; index < slice.length; index += 1) {
    const code = slice.charCodeAt(index)
    let escaped: string | undefined
    switch (code) {
      case 0x22:
        escaped = '\\"'
        break
      case 0x5c:
        escaped = '\\\\'
        break
      case 0x08:
        escaped = '\\b'
        break
      case 0x09:
        escaped = '\\t'
        break
      case 0x0a:
        escaped = '\\n'
        break
      case 0x0c:
        escaped = '\\f'
        break
      case 0x0d:
        escaped = '\\r'
        break
      default:
        if (isHighSurrogate(code) && isLowSurrogate(slice.charCodeAt(index + 1))) {
          index += 1
        } else if (code < 0x20 || isHighSurrogate(code) || isLowSurrogate(code)) {
          escaped = `\\u${code.toString(16).padStart(4, '0')}`
        }
    }
    if (escaped !== undefined) {
      if (spanStart < index) fragments.push(slice.slice(spanStart, index))
      fragments.push(escaped)
      spanStart = index + 1
    }
  }
  if (spanStart < slice.length) fragments.push(slice.slice(spanStart))
  return fragments.join('')
}

function* stringTokens(value: string): Generator<string, void> {
  yield '"'
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(value.length, offset + STRING_SLICE_CHARACTERS)
    if (
      end < value.length &&
      isHighSurrogate(value.charCodeAt(end - 1)) &&
      isLowSurrogate(value.charCodeAt(end))
    )
      end -= 1
    yield escapeStringSlice(value.slice(offset, end))
    offset = end
  }
  yield '"'
}

/** DTO accessors and toJSON hooks are outside the plain-JSON contract and must not run. */
function descriptorValue(descriptor: PropertyDescriptor): unknown {
  if ('get' in descriptor || 'set' in descriptor) throw unsupported()
  return descriptor.value as unknown
}

function prototypeOf(value: object): object | null {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && typeof prototype !== 'object') throw unsupported()
  return prototype
}

function plainContainer(value: object): void {
  const prototype = prototypeOf(value)
  if (
    Array.isArray(value)
      ? prototype !== Array.prototype && prototype !== null
      : prototype !== Object.prototype && prototype !== null
  )
    throw unsupported()
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON')
    if (descriptor) {
      if (typeof descriptorValue(descriptor) === 'function') throw unsupported()
      break
    }
    current = prototypeOf(current)
  }
}

function arrayValue(value: unknown[], index: number): unknown {
  const key = String(index)
  const own = Object.getOwnPropertyDescriptor(value, key)
  if (own) return descriptorValue(own)
  let current = prototypeOf(value)
  while (current !== null) {
    // An inherited index can change after freezing the DTO; it is outside the plain-array contract.
    if (Object.hasOwn(current, key)) throw unsupported()
    current = prototypeOf(current)
  }
  return undefined
}

function checkArrayPrototypeIndices(value: unknown[], length: number): void {
  let current = prototypeOf(value)
  while (current !== null) {
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') continue
      const index = Number(key)
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index < length &&
        String(index) === key &&
        !Object.hasOwn(value, key)
      )
        throw unsupported()
    }
    current = prototypeOf(current)
  }
}

/**
 * Validates and freezes one strict plain DTO before admission, without scanning string characters.
 * Every own data field, including non-enumerable and symbol-keyed fields omitted from JSON, is
 * validated, counted and frozen through its reachable containers. Accessors, hooks and non-plain
 * values are rejected rather than invoked. Global prototypes are never frozen.
 * The conservative estimate covers held containers, slots and UTF-16 strings; encoded buffers and
 * pipe/worker capacity are accounted separately by the Connection. Shared containers count once.
 */
export function freezeNativeJsonFrame(value: unknown): number {
  const heights = new Map<object, number>()
  const ancestors = new Set<object>()
  let retainedBytes = 0
  const account = (bytes: number): void => {
    retainedBytes += bytes
    if (!Number.isSafeInteger(retainedBytes)) throw unsupported()
  }
  const visit = (item: unknown, depth: number): number => {
    if (item === null) {
      account(PRIMITIVE_ESTIMATE_BYTES)
      return 0
    }
    switch (typeof item) {
      case 'string':
        account(STRING_ESTIMATE_BYTES + item.length * 2)
        return 0
      case 'boolean':
      case 'number':
        account(PRIMITIVE_ESTIMATE_BYTES)
        return 0
      case 'object':
        break
      default:
        throw unsupported()
    }
    if (depth >= MAX_CONTAINER_DEPTH || ancestors.has(item)) throw unsupported()
    const knownHeight = heights.get(item)
    if (knownHeight !== undefined) {
      if (depth + knownHeight > MAX_CONTAINER_DEPTH) throw unsupported()
      return knownHeight
    }
    plainContainer(item)
    account(CONTAINER_ESTIMATE_BYTES)
    ancestors.add(item)
    let childHeight = 0
    try {
      if (Array.isArray(item)) {
        const length = item.length
        account(length * ARRAY_SLOT_ESTIMATE_BYTES)
        checkArrayPrototypeIndices(item, length)
      }
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (!descriptor) throw unsupported()
        const child = descriptorValue(descriptor)
        const keyLength = typeof key === 'string' ? key.length : (key.description?.length ?? 0)
        account(
          PROPERTY_ESTIMATE_BYTES +
            STRING_ESTIMATE_BYTES +
            keyLength * 2 +
            (typeof key === 'symbol' ? SYMBOL_ESTIMATE_BYTES : 0),
        )
        if (child === undefined) account(PRIMITIVE_ESTIMATE_BYTES)
        else childHeight = Math.max(childHeight, visit(child, depth + 1))
      }
    } finally {
      ancestors.delete(item)
    }
    const height = childHeight + 1
    heights.set(item, height)
    return height
  }
  try {
    visit(value, 0)
    // All JSON-value validation finishes before freezing starts.
    for (const container of heights.keys()) Object.freeze(container)
    return retainedBytes
  } catch {
    throw unsupported()
  }
}

function* valueTokens(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): Generator<string, void> {
  if (value === null) {
    yield 'null'
    return
  }
  switch (typeof value) {
    case 'string':
      yield* stringTokens(value)
      return
    case 'boolean':
      yield value ? 'true' : 'false'
      return
    case 'number':
      yield Number.isFinite(value) ? String(value) : 'null'
      return
    case 'object':
      break
    default:
      throw unsupported()
  }
  if (depth >= MAX_CONTAINER_DEPTH || ancestors.has(value)) throw unsupported()
  plainContainer(value)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      yield '['
      const length = value.length
      for (let index = 0; index < length; index += 1) {
        if (index > 0) yield ','
        const item = arrayValue(value, index)
        yield* valueTokens(item === undefined ? null : item, ancestors, depth + 1)
      }
      yield ']'
    } else {
      yield '{'
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) {
          yield ''
          continue
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor?.enumerable) {
          yield ''
          continue
        }
        const item = descriptorValue(descriptor)
        if (item === undefined) {
          // Omitted fields still advance the cooperative work budget.
          yield ''
          continue
        }
        if (!first) yield ','
        first = false
        yield* stringTokens(key)
        yield ':'
        yield* valueTokens(item, ancestors, depth + 1)
      }
      yield '}'
    }
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Encodes one stable, validated Native RPC DTO as a single JSONL frame.
 * The iterator owns one <=64 KiB output chunk, bounded escaped slices and at most 64 ancestors.
 * It never materializes the complete encoded frame; the Connection owns the exclusive pipe writer.
 */
export async function* encodeNativeJsonFrame(
  value: unknown,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  let output = new Uint8Array(NATIVE_FRAME_WRITE_CHUNK_BYTES)
  let used = 0
  let workBytes = 0
  let workTokens = 0
  try {
    checkCancelled(signal)
    const tokens = (function* (): Generator<string, void> {
      yield* valueTokens(value, new Set<object>(), 0)
      yield '\n'
    })()
    for (const token of tokens) {
      checkCancelled(signal)
      workTokens += 1
      let offset = 0
      while (offset < token.length) {
        const encoded = encoder.encodeInto(token.slice(offset), output.subarray(used))
        offset += encoded.read
        used += encoded.written
        workBytes += encoded.written
        if (used === output.length || encoded.read === 0) {
          yield output.subarray(0, used)
          checkCancelled(signal)
          output = new Uint8Array(NATIVE_FRAME_WRITE_CHUNK_BYTES)
          used = 0
        }
      }
      if (workBytes >= NATIVE_FRAME_WRITE_CHUNK_BYTES || workTokens >= WORK_TOKENS_BEFORE_YIELD) {
        // oxlint-disable-next-line no-await-in-loop -- Encoding yields regularly without advancing a second frame.
        await setImmediate()
        checkCancelled(signal)
        workBytes = 0
        workTokens = 0
      }
    }
    if (used > 0) yield output.subarray(0, used)
  } catch {
    checkCancelled(signal)
    throw unsupported()
  }
}

/** Existing Native Worker owns large admitted bodies and this measurement's <=64 KiB chunk.
 * Count each fixed outer field separately so an already legal depth-64 body is not rejected
 * solely because its structured-clone reply adds an envelope. Observation failure is a scalar
 * incomplete receipt; it never changes or replaces a successful business reply. */
export async function measureNativeWorkerReply(
  reply: Record<string, unknown>,
): Promise<IpcTrafficMeasurement> {
  try {
    let jsonBytes = 2,
      fields = 0
    for (const key in reply) {
      if (!Object.hasOwn(reply, key)) continue
      const descriptor = Object.getOwnPropertyDescriptor(reply, key)
      if (!descriptor || !('value' in descriptor)) throw new Error('Unsupported observation field.')
      if (descriptor.value === undefined) continue
      fields += 1
      if (fields > 32) throw new Error('Observation envelope exceeds its fixed field bound.')
      const keyBytes = logicalIpcMeasurement(key)
      if (!keyBytes.complete) throw new Error('Unsupported observation key.')
      jsonBytes += keyBytes.jsonBytes + 1 + (fields > 1 ? 1 : 0) - 1 // value encoder's LF
      // oxlint-disable-next-line no-await-in-loop -- The existing Worker encoder yields bounded chunks and preserves field order.
      for await (const chunk of encodeNativeJsonFrame(descriptor.value))
        jsonBytes += chunk.byteLength
      if (!Number.isSafeInteger(jsonBytes) || jsonBytes > 128 * 1024 * 1024)
        return {
          complete: false,
          jsonBytes: 0,
          binaryBytes: 0,
          totalBytes: 0,
          reason: 'byte_limit',
        }
    }
    let receipt: IpcTrafficMeasurement = {
      complete: true,
      jsonBytes,
      binaryBytes: 0,
      totalBytes: jsonBytes,
    }
    for (let index = 0; index < 8; index += 1) {
      const scalar = logicalIpcMeasurement({ ipcMeasurement: receipt })
      if (!scalar.complete) throw new Error('Unsupported observation receipt.')
      const total = jsonBytes + scalar.totalBytes - 1
      if (total === receipt.totalBytes) return receipt
      receipt = { complete: true, jsonBytes: total, binaryBytes: 0, totalBytes: total }
    }
  } catch {
    /* Leave the original business reply intact and block measurement completeness. */
  }
  return { complete: false, jsonBytes: 0, binaryBytes: 0, totalBytes: 0, reason: 'uninspectable' }
}
