/** Per-call observation bounds, not permission to admit or truncate a business payload. */
export interface LogicalPayloadByteLimits {
  maxBytes: number
  maxNodes: number
  maxDepth: number
}
export type LogicalPayloadProfile = 'plain-dto' | 'monaco-clone-data'

export type LogicalPayloadIncompleteReason =
  | 'invalid_limits'
  | 'byte_limit'
  | 'node_limit'
  | 'depth_limit'
  | 'unsupported_value'
  | 'unsupported_prototype'
  | 'unsupported_binary'
  | 'accessor'
  | 'to_json'
  | 'cycle'
  | 'uninspectable'

interface LogicalPayloadByteCounts {
  jsonBytes: number
  binaryBytes: number
  totalBytes: number
  visitedNodes: number
}

export type LogicalPayloadByteMeasurement = LogicalPayloadByteCounts &
  ({ complete: true } | { complete: false; reason: LogicalPayloadIncompleteReason })

// A caller supplies the smaller bound appropriate to its already validated transport. These
// hard observation ceilings cover 48 KiB pages, 16 MiB Native JSON frames and 64 MiB binary work
// within one existing 128 MiB owner; they do not change any of those admission budgets.
const MAX_OBSERVATION_BYTES = 128 * 1024 * 1024
const MAX_OBSERVATION_NODES = 262_144
const MAX_CONTAINER_DEPTH = 64

function intrinsicGetter(
  prototype: unknown,
  key: string,
): ((value: object) => unknown) | undefined {
  if (prototype === null || typeof prototype !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
  // Descriptor objects are created by the engine; apply the captured intrinsic with its branded owner.
  const getter: unknown = descriptor ? Reflect.get(descriptor, 'get') : undefined
  return typeof getter === 'function'
    ? (value: object): unknown => Reflect.apply(getter, value, [])
    : undefined
}

const arrayBufferByteLength = intrinsicGetter(ArrayBuffer.prototype, 'byteLength')
const arrayBufferResizable = intrinsicGetter(ArrayBuffer.prototype, 'resizable')
const typedArrayPrototype: unknown = Object.getPrototypeOf(Uint8Array.prototype)
const typedArrayByteLength = intrinsicGetter(typedArrayPrototype, 'byteLength')
const typedArrayBuffer = intrinsicGetter(typedArrayPrototype, 'buffer')
const dataViewByteLength = intrinsicGetter(DataView.prototype, 'byteLength')
const dataViewBuffer = intrinsicGetter(DataView.prototype, 'buffer')
const regexpSource = intrinsicGetter(RegExp.prototype, 'source')
const regexpFlags = [
  ['hasIndices', 'd'],
  ['global', 'g'],
  ['ignoreCase', 'i'],
  ['multiline', 'm'],
  ['dotAll', 's'],
  ['unicode', 'u'],
  ['unicodeSets', 'v'],
  ['sticky', 'y'],
] as const
const regexpFlagGetters = regexpFlags.map(([name, flag]) => ({
  flag,
  get: intrinsicGetter(RegExp.prototype, name),
}))

function hasArrayBufferBrand(value: object): value is ArrayBuffer {
  try {
    return typeof arrayBufferByteLength?.(value) === 'number'
  } catch {
    return false
  }
}

/** Brand checks and lengths use intrinsics, never a payload's byteLength/buffer getters. */
function binaryLength(value: object): number | 'unsupported' | undefined {
  let bytes: unknown
  let buffer: unknown
  if (ArrayBuffer.isView(value)) {
    try {
      buffer = dataViewBuffer?.(value)
      bytes = dataViewByteLength?.(value)
    } catch {
      try {
        buffer = typedArrayBuffer?.(value)
        bytes = typedArrayByteLength?.(value)
      } catch {
        return 'unsupported'
      }
    }
  } else {
    if (!hasArrayBufferBrand(value)) return undefined
    bytes = arrayBufferByteLength?.(value)
    buffer = value
  }
  try {
    if (buffer === null || typeof buffer !== 'object' || !hasArrayBufferBrand(buffer))
      return 'unsupported'
    const capacity: unknown = arrayBufferByteLength?.(buffer)
    if (
      typeof capacity !== 'number' ||
      typeof bytes !== 'number' ||
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      bytes > capacity ||
      arrayBufferResizable?.(buffer) === true
    )
      return 'unsupported'
    // A detached fixed buffer reports zero byteLength. This zero-length view checks attachment
    // without reading/copying bytes; SharedArrayBuffer failed the ArrayBuffer brand check above.
    if (new Uint8Array(buffer, 0, 0).length !== 0) return 'unsupported'
    return bytes
  } catch {
    return 'unsupported'
  }
}

/**
 * Counts one already validated plain DTO without serializing it or retaining any payload reference.
 * Pure JSON bytes equal UTF-8 JSON.stringify(value), including syntax, escapes, nonfinite numbers,
 * omitted object undefined and null array holes/undefined. Unsupported values never count as a
 * successful zero. Binary leaves (ArrayBuffer, DataView and typed views, including Node Buffer)
 * become null in the JSON skeleton; binaryBytes counts each leaf's visible byteLength separately.
 * The opt-in Monaco clone-data profile also projects the confirmed native RegExp leaf to the
 * canonical {$regexp:{source,flags}} JSON token, without adding virtual input nodes/containers.
 * totalBytes is jsonBytes + binaryBytes, NOT Electron/structured-clone wire or resident-memory bytes.
 * Repeated references count per occurrence; only the current ancestor chain identifies cycles.
 *
 * Scope is contract-validated/structured-cloned plain containers, not arbitrary executable objects.
 * No accessor or toJSON hook is invoked. Standard JS cannot identify a Proxy without reflection
 * traps: callers must not pass raw user objects. Nonenumerable/symbol-keyed object fields and extra
 * array properties are ignored as JSON does. Own enumerable symbol/function/BigInt VALUES reject.
 * Enumeration creates no whole-object key/descriptor array; only <=64 ancestors are retained by
 * this function. The JS engine's enumeration setup is not a proved constant-workspace operation
 * for arbitrary oversized objects: validation/admission must bound the input before this counter.
 * On incomplete measurement, counts are a bounded partial observation, never a full payload size.
 * All per-call state is released on return; failures do not throw into the business operation.
 */
export function measureLogicalPayloadBytes(
  payload: unknown,
  limits: LogicalPayloadByteLimits,
  profile: LogicalPayloadProfile = 'plain-dto',
): LogicalPayloadByteMeasurement {
  let jsonBytes = 0
  let binaryBytes = 0
  let visitedNodes = 0
  let reason: LogicalPayloadIncompleteReason | undefined
  const incomplete = (cause: LogicalPayloadIncompleteReason): false => {
    reason ??= cause
    return false
  }
  const result = (): LogicalPayloadByteMeasurement => {
    const counts = { jsonBytes, binaryBytes, totalBytes: jsonBytes + binaryBytes, visitedNodes }
    return reason ? { ...counts, complete: false, reason } : { ...counts, complete: true }
  }
  try {
    if (
      limits === null ||
      typeof limits !== 'object' ||
      !['plain-dto', 'monaco-clone-data'].includes(profile)
    ) {
      incomplete('invalid_limits')
      return result()
    }
    // Read caller-owned limits through data descriptors too, so a malformed options object cannot
    // cause an observation to invoke getters or evade its work bound.
    const readLimit = (
      name: keyof LogicalPayloadByteLimits,
      ceiling: number,
    ): number | undefined => {
      const descriptor = Object.getOwnPropertyDescriptor(limits, name)
      const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
      return typeof value === 'number' &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= ceiling
        ? value
        : undefined
    }
    const maxBytes = readLimit('maxBytes', MAX_OBSERVATION_BYTES)
    const maxNodes = readLimit('maxNodes', MAX_OBSERVATION_NODES)
    const maxDepth = readLimit('maxDepth', MAX_CONTAINER_DEPTH)
    if (
      maxBytes === undefined ||
      maxNodes === undefined ||
      maxNodes < 1 ||
      maxDepth === undefined
    ) {
      incomplete('invalid_limits')
      return result()
    }
    const ancestors = new Set<object>()
    const node = (): boolean => {
      if (visitedNodes >= maxNodes) return incomplete('node_limit')
      visitedNodes += 1
      return true
    }
    const add = (bytes: number, binary = false): boolean => {
      if (bytes > maxBytes - jsonBytes - binaryBytes) return incomplete('byte_limit')
      if (binary) binaryBytes += bytes
      else jsonBytes += bytes
      return true
    }
    const string = (value: string): boolean => {
      if (!add(2)) return false
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index)
        let bytes: number
        if (code === 0x22 || code === 0x5c) bytes = 2
        else if (code < 0x20) {
          bytes =
            code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d
              ? 2
              : 6
        } else if (code < 0x80) bytes = 1
        else if (code < 0x800) bytes = 2
        else if (code >= 0xd800 && code <= 0xdbff) {
          const next = value.charCodeAt(index + 1)
          if (next >= 0xdc00 && next <= 0xdfff) {
            bytes = 4
            index += 1
          } else bytes = 6 // Well-formed JSON.stringify escapes unpaired surrogates, not U+FFFD.
        } else bytes = code >= 0xdc00 && code <= 0xdfff ? 6 : 3
        if (!add(bytes)) return false
      }
      return true
    }
    const visit = (value: unknown, depth: number, omittedUndefined = false): boolean => {
      if (!node()) return false
      if (value === null) return add(4)
      switch (typeof value) {
        case 'undefined':
          return omittedUndefined || incomplete('unsupported_value')
        case 'boolean':
          return add(value ? 4 : 5)
        case 'number':
          return add(Number.isFinite(value) ? String(value).length : 4)
        case 'string':
          return string(value)
        case 'object':
          break
        default:
          return incomplete('unsupported_value')
      }
      const bytes = binaryLength(value)
      if (bytes === 'unsupported') return incomplete('unsupported_binary')
      if (bytes !== undefined) return add(4) && add(bytes, true)
      if (profile === 'monaco-clone-data' && Object.getPrototypeOf(value) === RegExp.prototype) {
        // Actual installed Monaco sends native RegExp in its clone-data initialization. Clone
        // preserves source/flags, drops custom own properties and resets lastIndex. Read internal
        // slots only: the native flags getter itself would consult user-overridable properties.
        let source: unknown
        let flags = ''
        try {
          source = regexpSource?.(value)
          for (const entry of regexpFlagGetters) {
            if (!entry.get) return incomplete('unsupported_prototype')
            const enabled = entry.get(value)
            if (typeof enabled !== 'boolean') return incomplete('unsupported_prototype')
            if (enabled) flags += entry.flag
          }
        } catch {
          return incomplete('unsupported_prototype')
        }
        if (typeof source !== 'string') return incomplete('unsupported_prototype')
        // A constant-sized canonical skeleton makes hidden clone state visible in the declared
        // metric. No pattern/body copy, serialization hook or payload reference is retained.
        return (
          add('{"$regexp":{"source":'.length) &&
          string(source) &&
          add(',"flags":'.length) &&
          string(flags) &&
          add(2)
        )
      }
      if (depth >= maxDepth) return incomplete('depth_limit')
      if (ancestors.has(value)) return incomplete('cycle')
      const isArray = Array.isArray(value)
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== null && prototype !== (isArray ? Array.prototype : Object.prototype))
        return incomplete('unsupported_prototype')
      if (
        prototype === Array.prototype &&
        Object.getPrototypeOf(Array.prototype) !== Object.prototype &&
        Object.getPrototypeOf(Array.prototype) !== null
      )
        return incomplete('unsupported_prototype')
      let current: object | null = value
      while (current !== null) {
        const hook = Object.getOwnPropertyDescriptor(current, 'toJSON')
        if (hook) {
          if (!('value' in hook)) return incomplete('accessor')
          if (typeof hook.value === 'function') return incomplete('to_json')
          break
        }
        const next: unknown = Object.getPrototypeOf(current)
        if (next !== null && typeof next !== 'object') return incomplete('unsupported_prototype')
        current = next
      }
      ancestors.add(value)
      try {
        if (isArray) {
          const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
          const length: unknown = lengthDescriptor?.value
          if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0)
            return incomplete('uninspectable')
          if (length > maxNodes - visitedNodes) return incomplete('node_limit')
          if (!add(2)) return false
          for (let index = 0; index < length; index += 1) {
            if (index > 0 && !add(1)) return false
            const key = String(index)
            const descriptor = Object.getOwnPropertyDescriptor(value, key)
            if (descriptor && !('value' in descriptor)) return incomplete('accessor')
            if (
              !descriptor &&
              prototype !== null &&
              (Object.getOwnPropertyDescriptor(Array.prototype, key) ||
                Object.getOwnPropertyDescriptor(Object.prototype, key))
            )
              return incomplete('unsupported_value')
            const item: unknown = descriptor?.value
            if (!visit(item === undefined ? null : item, depth + 1)) return false
          }
          return true
        }
        if (!add(2)) return false
        let first = true
        for (const key in value) {
          if (!Object.hasOwn(value, key)) {
            if (!node()) return false
            continue
          }
          const descriptor = Object.getOwnPropertyDescriptor(value, key)
          if (!descriptor) return incomplete('uninspectable')
          if (!('value' in descriptor)) return incomplete('accessor')
          const item: unknown = descriptor.value
          if (item === undefined) {
            if (!visit(item, depth + 1, true)) return false
            continue
          }
          if ((!first && !add(1)) || !string(key) || !add(1) || !visit(item, depth + 1))
            return false
          first = false
        }
        return true
      } finally {
        ancestors.delete(value)
      }
    }
    visit(payload, 0)
  } catch {
    incomplete('uninspectable')
  }
  return result()
}
