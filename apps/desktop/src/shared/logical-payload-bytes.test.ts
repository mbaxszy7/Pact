import { Buffer } from 'node:buffer'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

import {
  measureLogicalPayloadBytes,
  type LogicalPayloadByteLimits,
} from './logical-payload-bytes.js'

const LIMITS: LogicalPayloadByteLimits = {
  maxBytes: 32 * 1024 * 1024,
  maxNodes: 100_000,
  maxDepth: 64,
}

function jsonBytes(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('The oracle requires a JSON root value.')
  return Buffer.byteLength(encoded, 'utf8')
}

function jsonCounts(value: unknown) {
  const expected = jsonBytes(value)
  return {
    complete: true,
    jsonBytes: expected,
    binaryBytes: 0,
    totalBytes: expected,
  }
}

describe('logical payload byte measurement', () => {
  it('counts a genuine RegExp clone leaf without adding virtual nodes or containers', () => {
    const value = /a/g
    const expected = Buffer.byteLength(
      JSON.stringify({
        $regexp: { source: structuredClone(value).source, flags: structuredClone(value).flags },
      }),
    )
    expect(expected).toBe(38)
    const limits = { maxBytes: expected, maxNodes: 1, maxDepth: 0 }
    expect(measureLogicalPayloadBytes(value, limits, 'monaco-clone-data')).toEqual({
      complete: true,
      jsonBytes: expected,
      binaryBytes: 0,
      totalBytes: expected,
      visitedNodes: 1,
    })
    expect(
      measureLogicalPayloadBytes(value, { ...limits, maxBytes: expected - 1 }, 'monaco-clone-data'),
    ).toMatchObject({ complete: false, reason: 'byte_limit' })
    expect(measureLogicalPayloadBytes(value, limits)).toMatchObject({ complete: false })
    let nested: unknown = value
    for (let index = 0; index < 64; index += 1) nested = [nested]
    expect(
      measureLogicalPayloadBytes(nested, { ...LIMITS, maxNodes: 65 }, 'monaco-clone-data'),
    ).toMatchObject({ complete: true, visitedNodes: 65, totalBytes: expected + 128 })
    expect(measureLogicalPayloadBytes([nested], LIMITS, 'monaco-clone-data')).toMatchObject({
      complete: false,
      reason: 'depth_limit',
    })
    expect(
      measureLogicalPayloadBytes([value, value], { ...LIMITS, maxNodes: 2 }, 'monaco-clone-data'),
    ).toMatchObject({ complete: false, reason: 'node_limit' })
  })

  it('matches independent structuredClone source/flags oracles for Unicode, escapes and legal flags', () => {
    for (const source of ['', 'é😀', '\ud800', 'a\\\\b', '\n', '[A-Z]']) {
      for (let bits = 0; bits < 256; bits += 1) {
        const flags = Array.from('dgimsuvy')
          .filter((_flag, index) => (bits & (1 << index)) !== 0)
          .join('')
        if (flags.includes('u') && flags.includes('v')) continue // ECMAScript rejects this combination.
        const value = new RegExp(source, flags),
          clone = structuredClone(value)
        const expected = Buffer.byteLength(
          JSON.stringify({ $regexp: { source: clone.source, flags: clone.flags } }),
        )
        expect(
          measureLogicalPayloadBytes(value, { ...LIMITS, maxNodes: 1 }, 'monaco-clone-data'),
        ).toMatchObject({
          complete: true,
          jsonBytes: expected,
          totalBytes: expected,
          binaryBytes: 0,
          visitedNodes: 1,
        })
      }
    }
  })

  it('does not run custom RegExp properties or hooks that actual structured clone discards', () => {
    const value = /é😀/gims
    const clone = structuredClone(value)
    const getter = vi.fn<() => string>(() => 'private data')
    for (const name of [
      'source',
      'flags',
      'hasIndices',
      'global',
      'ignoreCase',
      'multiline',
      'dotAll',
      'unicode',
      'unicodeSets',
      'sticky',
      'toJSON',
      'custom',
    ])
      Object.defineProperty(value, name, { enumerable: true, get: getter })
    value.lastIndex = 55
    const expected = Buffer.byteLength(
      JSON.stringify({ $regexp: { source: clone.source, flags: clone.flags } }),
    )
    expect(measureLogicalPayloadBytes(value, LIMITS, 'monaco-clone-data')).toMatchObject({
      complete: true,
      totalBytes: expected,
    })
    expect(getter).not.toHaveBeenCalled()
    expect(structuredClone(value).lastIndex).toBe(0)
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects fake brands, unknown classes and unavailable native flag intrinsics', async () => {
    class Unknown {
      marker = true
    }
    for (const value of [Object.create(RegExp.prototype), new Date(0), new Map(), new Unknown()])
      expect(measureLogicalPayloadBytes(value, LIMITS, 'monaco-clone-data')).toMatchObject({
        complete: false,
        reason: 'unsupported_prototype',
      })
    const original = Object.getOwnPropertyDescriptor.bind(Object)
    const missing = vi
      .spyOn(Object, 'getOwnPropertyDescriptor')
      .mockImplementation((value, key) =>
        value === RegExp.prototype && key === 'unicodeSets' ? undefined : original(value, key),
      )
    try {
      vi.resetModules()
      const { measureLogicalPayloadBytes: unavailable } = await import('./logical-payload-bytes.js')
      expect(unavailable(/a/g, LIMITS, 'monaco-clone-data')).toMatchObject({
        complete: false,
        reason: 'unsupported_prototype',
      })
    } finally {
      missing.mockRestore()
    }
  })
  it.each([
    null,
    true,
    false,
    0,
    -0,
    1.25,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    -1e-7,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    'ASCII with "quotes", \\ and /',
    '\b\t\n\f\r\0\u0001\u001f',
    'é Ελληνικά 中文 😀 \u2028\u2029 �',
    '\ud800x\udfff\ud800\udfff\udfff\ud800',
    [],
    {},
    [null, true, 17, undefined, ['nested', null]],
    { missing: undefined, present: null, values: [undefined, false] },
    { '\n"\\😀\udfff': 'escaped keys also count', '': 1 },
  ])('matches the independent JSON UTF-8 oracle for %j', (value) => {
    expect(measureLogicalPayloadBytes(value, LIMITS)).toMatchObject(jsonCounts(value))
  })

  it('matches every UTF-16 code unit and deterministic mixed Unicode strings', () => {
    const units = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).join('')
    expect(measureLogicalPayloadBytes(units, LIMITS)).toMatchObject(jsonCounts(units))
    let seed = 0x4c0f7
    for (let fixture = 0; fixture < 80; fixture += 1) {
      let text = ''
      for (let index = 0; index < 127; index += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        text += String.fromCharCode(seed & 0xffff)
      }
      const value = { [text.slice(0, 7)]: [text, fixture / 7, undefined] }
      expect(measureLogicalPayloadBytes(value, LIMITS)).toMatchObject(jsonCounts(value))
    }
  })

  it('counts sparse/null-prototype containers and omitted JSON fields without invoking them', () => {
    const sparse: unknown[] = []
    sparse.length = 4
    sparse[2] = undefined
    sparse[3] = 'last'
    Object.setPrototypeOf(sparse, null)
    const object: unknown = Object.create(null)
    if (object === null || typeof object !== 'object') throw new Error('Expected plain object.')
    Object.assign(object, { array: sparse, omitted: undefined })
    const ignored = vi.fn<() => string>(() => 'not serialized')
    Object.defineProperty(object, 'hidden', { get: ignored })
    Object.defineProperty(object, Symbol('ignored by JSON'), { get: ignored, enumerable: true })
    expect(measureLogicalPayloadBytes(object, LIMITS)).toMatchObject(jsonCounts(object))
    expect(ignored).not.toHaveBeenCalled()
  })

  it('does not serialize or mutate a representative 48 KiB page or 16 MiB Native string', () => {
    const page = Object.freeze({ content: 'x'.repeat(48 * 1024 - 14) })
    const frame = Object.freeze({ content: 'x'.repeat(16 * 1024 * 1024 - 14) })
    const expected = [jsonBytes(page), jsonBytes(frame)]
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => {
      throw new Error('Counter must not serialize the payload.')
    })
    let actual
    try {
      actual = [measureLogicalPayloadBytes(page, LIMITS), measureLogicalPayloadBytes(frame, LIMITS)]
    } finally {
      stringify.mockRestore()
    }
    expect(actual?.map((item) => item.totalBytes)).toEqual(expected)
    expect(actual?.every((item) => item.complete)).toBe(true)
    expect(page.content.length).toBe(48 * 1024 - 14)
    expect(frame.content.length).toBe(16 * 1024 * 1024 - 14)
    expect(Object.isFrozen(page)).toBe(true)
    expect(Object.isFrozen(frame)).toBe(true)
  })

  it('counts repeated references per JSON occurrence while refusing ancestor cycles', () => {
    const shared = { text: 'same object', array: [1, 2] }
    const repeated = { first: shared, second: shared, array: [shared, shared] }
    expect(measureLogicalPayloadBytes(repeated, LIMITS)).toMatchObject(jsonCounts(repeated))
    const object: Record<string, unknown> = {}
    object['self'] = object
    expect(measureLogicalPayloadBytes(object, LIMITS)).toMatchObject({
      complete: false,
      reason: 'cycle',
    })
    const array: unknown[] = []
    array.push({ parent: array })
    expect(measureLogicalPayloadBytes(array, LIMITS)).toMatchObject({
      complete: false,
      reason: 'cycle',
    })
    expect(measureLogicalPayloadBytes(shared, LIMITS)).toMatchObject(jsonCounts(shared))
  })

  it.each([
    undefined,
    Symbol('unsupported'),
    () => undefined,
    1n,
    { value: 1n },
    [Symbol('value')],
    { value: () => 1 },
  ])('marks unsupported values incomplete instead of a successful zero', (value) => {
    expect(measureLogicalPayloadBytes(value, LIMITS)).toMatchObject({
      complete: false,
      reason: 'unsupported_value',
    })
  })

  it.each([new Date(0), new Map(), new Set(), new Number(1), Object.create({ inherited: 1 })])(
    'refuses nonplain prototypes',
    (value) => {
      expect(measureLogicalPayloadBytes(value, LIMITS)).toMatchObject({
        complete: false,
        reason: 'unsupported_prototype',
      })
    },
  )

  it('never invokes object/array accessors or toJSON methods/accessors', () => {
    const getter = vi.fn<() => string>(() => 'sensitive value')
    const hook = vi.fn<() => { replacement: boolean }>(() => ({ replacement: true }))
    const object = Object.defineProperty({}, 'visible', { get: getter, enumerable: true })
    const array = Object.defineProperty([null], '0', { get: getter, enumerable: true })
    const hookAccessor = Object.defineProperty({}, 'toJSON', { get: getter })
    expect(measureLogicalPayloadBytes(object, LIMITS)).toMatchObject({
      complete: false,
      reason: 'accessor',
    })
    expect(measureLogicalPayloadBytes(array, LIMITS)).toMatchObject({
      complete: false,
      reason: 'accessor',
    })
    expect(measureLogicalPayloadBytes(hookAccessor, LIMITS)).toMatchObject({
      complete: false,
      reason: 'accessor',
    })
    expect(measureLogicalPayloadBytes({ toJSON: hook }, LIMITS)).toMatchObject({
      complete: false,
      reason: 'to_json',
    })
    expect(getter).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
    const data = { toJSON: 'a data field, not a method' }
    expect(measureLogicalPayloadBytes(data, LIMITS)).toMatchObject(jsonCounts(data))
  })

  it('uses intrinsic binary brands and visible lengths with a null JSON skeleton', () => {
    const backing = new ArrayBuffer(29)
    const typed = new Uint16Array(backing, 2, 5)
    const view = new DataView(backing, 7, 11)
    const buffer = Buffer.from([1, 2, 3, 4])
    const getter = vi.fn<() => never>(() => {
      throw new Error('Payload getter must not run.')
    })
    const hook = vi.fn<() => never>(() => {
      throw new Error('Opaque binary toJSON must not run.')
    })
    for (const value of [backing, typed, view, buffer]) {
      Object.defineProperty(value, 'byteLength', { get: getter })
      Object.defineProperty(value, 'buffer', { get: getter })
      Object.defineProperty(value, 'constructor', { get: getter })
      Object.defineProperty(value, 'toJSON', { value: hook })
    }
    const payload = { backing, typed, view, buffer, duplicate: typed }
    const skeleton = { backing: null, typed: null, view: null, buffer: null, duplicate: null }
    const expectedJson = jsonBytes(skeleton)
    const expectedBinary = 29 + 10 + 11 + 4 + 10
    expect(measureLogicalPayloadBytes(payload, LIMITS)).toMatchObject({
      complete: true,
      jsonBytes: expectedJson,
      binaryBytes: expectedBinary,
      totalBytes: expectedJson + expectedBinary,
    })
    expect(getter).not.toHaveBeenCalled()
    expect(hook).not.toHaveBeenCalled()
    expect(measureLogicalPayloadBytes(new ArrayBuffer(0), LIMITS)).toMatchObject({
      complete: true,
      jsonBytes: 4,
      binaryBytes: 0,
      totalBytes: 4,
    })
  })

  it('does not mistake binary lookalike metadata for an opaque buffer', () => {
    const fake = { byteLength: 17, buffer: { byteLength: 17 } }
    const tag = vi.fn<() => string>(() => 'ArrayBuffer')
    Object.defineProperty(fake, Symbol.toStringTag, { get: tag })
    expect(measureLogicalPayloadBytes(fake, LIMITS)).toMatchObject(jsonCounts(fake))
    expect(tag).not.toHaveBeenCalled()
  })

  it('recognizes cross-realm binary without instanceof, including typed-array and DataView slices', () => {
    const foreign: unknown = runInNewContext(
      '({ buffer: new ArrayBuffer(19), typed: new Uint8Array(new ArrayBuffer(31), 3, 7), view: new DataView(new ArrayBuffer(31), 4, 13) })',
    )
    if (foreign === null || typeof foreign !== 'object')
      throw new Error('Expected foreign binary fixture.')
    const items = ['buffer', 'typed', 'view'].map((key) => {
      const value: unknown = Reflect.get(foreign, key)
      return value
    })
    expect(measureLogicalPayloadBytes(items, LIMITS)).toMatchObject({
      complete: true,
      jsonBytes: jsonBytes([null, null, null]),
      binaryBytes: 39,
    })
  })

  it('marks detached, resizable and shared binary incomplete without copying or changing it', () => {
    const detached = new ArrayBuffer(8)
    const detachedView = new Uint8Array(detached)
    const detachedDataView = new DataView(detached)
    structuredClone(detached, { transfer: [detached] })
    const resizable = new ArrayBuffer(8, { maxByteLength: 16 })
    for (const binary of [
      detached,
      detachedView,
      detachedDataView,
      resizable,
      new Uint8Array(new SharedArrayBuffer(8)),
    ]) {
      expect(measureLogicalPayloadBytes(binary, LIMITS)).toMatchObject({
        complete: false,
        reason: 'unsupported_binary',
      })
    }
    expect(measureLogicalPayloadBytes(new SharedArrayBuffer(8), LIMITS).complete).toBe(false)
    expect(resizable.byteLength).toBe(8)
  })

  it('enforces exact caller byte limits without truncating JSON or binary input', () => {
    const payload = { text: 'é😀\ud800', data: new Uint8Array(9) }
    const total = jsonBytes({ text: payload.text, data: null }) + 9
    expect(measureLogicalPayloadBytes(payload, { ...LIMITS, maxBytes: total })).toMatchObject({
      complete: true,
      totalBytes: total,
    })
    const overflow = measureLogicalPayloadBytes(payload, { ...LIMITS, maxBytes: total - 1 })
    expect(overflow).toMatchObject({ complete: false, reason: 'byte_limit' })
    expect(overflow.totalBytes).toBeLessThanOrEqual(total - 1)
    expect(payload.text).toBe('é😀\ud800')
    expect(payload.data.byteLength).toBe(9)
  })

  it('bounds omitted fields, sparse arrays, repeated expansion and container depth per invocation', () => {
    const payload = { list: [1, 2, 3], omitted: undefined }
    expect(measureLogicalPayloadBytes(payload, { ...LIMITS, maxNodes: 6 })).toMatchObject({
      complete: true,
      visitedNodes: 6,
    })
    expect(measureLogicalPayloadBytes(payload, { ...LIMITS, maxNodes: 5 })).toMatchObject({
      complete: false,
      reason: 'node_limit',
      visitedNodes: 5,
    })
    const sparse: unknown[] = []
    sparse.length = 1_000_000
    expect(measureLogicalPayloadBytes(sparse, { ...LIMITS, maxNodes: 9 })).toMatchObject({
      complete: false,
      reason: 'node_limit',
      visitedNodes: 1,
    })
    let nested: unknown = 0
    for (let depth = 0; depth < 64; depth += 1) nested = [nested]
    expect(measureLogicalPayloadBytes(nested, LIMITS)).toMatchObject(jsonCounts(nested))
    expect(measureLogicalPayloadBytes([nested], LIMITS)).toMatchObject({
      complete: false,
      reason: 'depth_limit',
    })
    expect(measureLogicalPayloadBytes(1, { ...LIMITS, maxDepth: 0 }).complete).toBe(true)
    expect(measureLogicalPayloadBytes([], { ...LIMITS, maxDepth: 0 })).toMatchObject({
      complete: false,
      reason: 'depth_limit',
    })
    let repeated: unknown = 'leaf'
    for (let depth = 0; depth < 20; depth += 1) repeated = [repeated, repeated]
    const bounded = measureLogicalPayloadBytes(repeated, { ...LIMITS, maxNodes: 31 })
    expect(bounded).toMatchObject({
      complete: false,
      reason: 'node_limit',
    })
    expect(bounded.visitedNodes).toBeGreaterThan(0)
    expect(bounded.visitedNodes).toBeLessThanOrEqual(31)
    const afterFailure = { afterFailure: [1, 2] }
    expect(measureLogicalPayloadBytes(afterFailure, LIMITS)).toMatchObject(jsonCounts(afterFailure))
  })

  it.each([
    { ...LIMITS, maxBytes: -1 },
    { ...LIMITS, maxBytes: 128 * 1024 * 1024 + 1 },
    { ...LIMITS, maxNodes: 262_145 },
    { ...LIMITS, maxNodes: 0 },
    { ...LIMITS, maxDepth: 65 },
    { ...LIMITS, maxBytes: Number.NaN },
    { ...LIMITS, maxNodes: 1.5 },
  ])('rejects invalid/over-ceiling observation limits', (limits) => {
    expect(measureLogicalPayloadBytes(null, limits)).toEqual({
      complete: false,
      reason: 'invalid_limits',
      jsonBytes: 0,
      binaryBytes: 0,
      totalBytes: 0,
      visitedNodes: 0,
    })
  })

  it('does not read a limits getter and contains thrown reflection failures', () => {
    const getter = vi.fn<() => number>(() => 1000)
    const limits = Object.defineProperty({ ...LIMITS }, 'maxBytes', { get: getter })
    expect(measureLogicalPayloadBytes(null, limits)).toMatchObject({
      complete: false,
      reason: 'invalid_limits',
    })
    expect(getter).not.toHaveBeenCalled()
    const reflection = vi.fn<() => never>(() => {
      throw new Error('Unknown raw input cannot be inspected.')
    })
    const raw = new Proxy({}, { getPrototypeOf: reflection })
    expect(measureLogicalPayloadBytes(raw, LIMITS)).toMatchObject({
      complete: false,
      reason: 'uninspectable',
    })
    expect(reflection).toHaveBeenCalledTimes(1)
  })
})
