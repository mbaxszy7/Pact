import { NATIVE_PERMISSION_TIMEOUT_MS } from '@pact/contracts'

/** Pauses only the Adapter's silence deadline while a real native approval is pending. */
export class NativePermissionWait {
  private count = 0
  private readonly listeners = new Set<() => void>()
  get waiting(): boolean {
    return this.count > 0
  }
  begin(): () => void {
    this.count += 1
    for (const listener of this.listeners) listener()
    let ended = false
    return () => {
      if (ended) return
      ended = true
      this.count -= 1
      for (const listener of this.listeners) listener()
    }
  }
  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= 65) throw new Error('Native wait listener capacity exceeded.')
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  /** The parent UI owns its own deadline; this bound also covers a lost callback. */
  static async decision<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted)
      throw new Error('The native interaction was interrupted without a user decision.')
    let timeout: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    const stopped = new Promise<T>((_resolve, reject) => {
      abort = () =>
        reject(new Error('The native interaction was interrupted without a user decision.'))
      signal.addEventListener('abort', abort, { once: true })
      timeout = setTimeout(
        () => reject(new Error('The native interaction expired without a user decision.')),
        NATIVE_PERMISSION_TIMEOUT_MS,
      )
    })
    try {
      return await Promise.race([work, stopped])
    } finally {
      if (timeout) clearTimeout(timeout)
      if (abort) signal.removeEventListener('abort', abort)
    }
  }
}

function redactNativePermissionText(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/-]+/giu, '$1[redacted]')
    .replace(
      /((?:api[_-]?key|auth(?:orization)?|cookie|password|secret|token)\s*[:=]\s*)([^\s,;]+)/giu,
      '$1[redacted]',
    )
    .replace(
      /(--(?:api[-_]key|access[-_]token|token|password|secret|authorization|cookie)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/giu,
      '$1[redacted]',
    )
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1[redacted]@')
}

export function nativeApprovalDisplayFits(value: string, maximum = 4096): boolean {
  return Buffer.byteLength(redactNativePermissionText(value)) <= maximum - 16
}

export function safeNativePermissionText(value: string, maximum = 4096): string {
  const redacted = redactNativePermissionText(value)
  let result = '',
    bytes = 0
  for (const character of redacted) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maximum - 16) return `${result}\n[truncated]`
    result += character
    bytes += size
  }
  return result
}

/** Session approval is omitted when its exact native rule cannot be displayed safely. */
export function exactNativeSessionScope(lines: string[]): string | undefined {
  if (!lines.length) return undefined
  const raw = lines.join('\n')
  return nativeApprovalDisplayFits(raw, 1024) && redactNativePermissionText(raw) === raw
    ? raw
    : undefined
}
