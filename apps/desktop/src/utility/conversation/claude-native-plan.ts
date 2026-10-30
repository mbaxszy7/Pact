import { createHash } from 'node:crypto'

import type { CollaborationRetainedPlan } from '@pact/contracts'

export interface ClaudePlanBinding {
  promptId: string
  path: string
}

type Value = Record<string, unknown>
const isObject = (value: unknown): value is Value =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const object = (value: unknown): Value => (isObject(value) ? value : {})
function fingerprint(fields: readonly unknown[]): string {
  const hash = createHash('sha256')
  for (const field of fields) {
    if (typeof field === 'string') hash.update(`string:${field.length}:`).update(field)
    else hash.update(`${typeof field}:${String(field)};`)
  }
  return hash.digest('hex')
}
export interface ClaudePlanOperation {
  kind: 'write' | 'submission'
  input: string
  acknowledgement?: string
  failed: boolean
}

export interface ClaudePlanState {
  text?: string
  complete: boolean
  lastId?: string
  unavailable: boolean
  overlapped: boolean
  operations: Array<[string, ClaudePlanOperation]>
  pending: string[]
}

export function claudePlanInputFingerprint(name: string, input: unknown): string {
  const value = object(input)
  return fingerprint([
    name,
    value.file_path,
    value.content,
    value.old_string,
    value.new_string,
    value.replace_all ?? false,
  ])
}

/** Full ExitPlanMode intent, distinct from the Write/Edit prefix identity. No body is retained. */
export function claudePlanSubmissionFingerprint(input: unknown): string {
  const hash = createHash('sha256').update('pact-claude-plan-submission-v1;')
  let bytes = 0,
    nodes = 0
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 32)
      throw new Error('Native plan submission input is too complex.')
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value)
      if (bytes > 8 * 1024 * 1024)
        throw new Error('Native plan submission exceeds the native text bound.')
      hash.update(`string:${value.length}:`).update(value)
    } else if (value === null) hash.update('null;')
    else if (typeof value === 'boolean') hash.update(`boolean:${value};`)
    else if (typeof value === 'number' && Number.isFinite(value)) hash.update(`number:${value};`)
    else if (Array.isArray(value)) {
      hash.update(`array:${value.length}:[`)
      for (const item of value) visit(item, depth + 1)
      hash.update(']')
    } else if (isObject(value)) {
      const keys = Object.keys(value).toSorted()
      hash.update(`object:${keys.length}:{`)
      for (const key of keys) {
        visit(key, depth + 1)
        visit(value[key], depth + 1)
      }
      hash.update('}')
    } else throw new Error('Native plan submission is not a JSON value.')
  }
  if (!isObject(input)) throw new Error('Native plan submission must be an object.')
  visit(input, 0)
  return hash.digest('hex')
}

export function isClaudePlanState(value: unknown): value is ClaudePlanState {
  if (
    !isObject(value) ||
    (value.text !== undefined && typeof value.text !== 'string') ||
    !['complete', 'unavailable', 'overlapped'].every((key) => typeof value[key] === 'boolean') ||
    !Array.isArray(value.operations) ||
    value.operations.length > 64 ||
    !Array.isArray(value.pending) ||
    value.pending.length > 64
  )
    return false
  const ids = new Set<string>()
  for (const pair of value.operations) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      !pair[0] ||
      pair[0].length > 1024 ||
      ids.has(pair[0]) ||
      !isObject(pair[1]) ||
      typeof pair[1].input !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(pair[1].input) ||
      !['write', 'submission'].includes(String(pair[1].kind)) ||
      typeof pair[1].failed !== 'boolean' ||
      (pair[1].acknowledgement !== undefined &&
        (typeof pair[1].acknowledgement !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(pair[1].acknowledgement)))
    )
      return false
    ids.add(pair[0])
  }
  if (
    new Set(value.pending).size !== value.pending.length ||
    value.pending.some((id) => typeof id !== 'string' || !ids.has(id))
  )
    return false
  if (value.lastId !== undefined && (typeof value.lastId !== 'string' || !ids.has(value.lastId)))
    return false
  return (
    !value.complete ||
    (typeof value.text === 'string' &&
      Boolean(value.text.trim()) &&
      !value.unavailable &&
      value.pending.length === 0)
  )
}

/** Interprets acknowledged native operations; never opens a tool-selected path. */
export class ClaudeNativePlan {
  private text: string | undefined
  private complete = false
  private overlapped = false
  private lastId: string | undefined
  private readonly operations = new Map<string, ClaudePlanOperation>()
  private readonly pending = new Set<string>()
  unavailable = false

  constructor(
    readonly binding: ClaudePlanBinding,
    private readonly reserve: (bytes: number) => void = () => {},
    base?: string,
  ) {
    if (base !== undefined) {
      this.reserve(4096 + Buffer.byteLength(base) * 4 + base.length * 2)
      this.text = base
      this.complete = Boolean(base.trim())
    }
  }

  /** Only verified ancestor text seeds a new root; it supplies no current submission identity. */
  get completeText(): string | undefined {
    return this.complete ? this.text : undefined
  }

  snapshot(): ClaudePlanState {
    return {
      ...(this.text !== undefined ? { text: this.text } : {}),
      complete: this.complete,
      ...(this.lastId ? { lastId: this.lastId } : {}),
      unavailable: this.unavailable,
      overlapped: this.overlapped,
      operations: [...this.operations].map(([id, operation]) => [id, { ...operation }]),
      pending: [...this.pending],
    }
  }

  static restore(
    binding: ClaudePlanBinding,
    state: ClaudePlanState,
    reserve: (bytes: number) => void,
  ): ClaudeNativePlan {
    if (!isClaudePlanState(state)) throw new Error('The native plan prefix is invalid.')
    const plan = new ClaudeNativePlan(binding, reserve, state.text)
    plan.complete = state.complete
    plan.lastId = state.lastId
    plan.unavailable = state.unavailable
    plan.overlapped = state.overlapped
    for (const [id, operation] of state.operations) plan.operations.set(id, { ...operation })
    for (const id of state.pending) plan.pending.add(id)
    return plan
  }

  get plan(): { nativeId: string; text: string } | undefined {
    return this.complete && this.lastId && this.text?.trim()
      ? { nativeId: this.lastId, text: this.text }
      : undefined
  }

  isPending(id: string): boolean {
    return this.pending.has(id)
  }

  get hasPendingOperations(): boolean {
    return this.pending.size > 0
  }

  begin(name: string, id: string, input: unknown): boolean {
    const value = object(input)
    if (value.file_path !== this.binding.path) {
      if (this.operations.has(id)) this.reject(id)
      return false
    }
    if (!id || id.length > 1024 || (!this.operations.has(id) && this.operations.size >= 64))
      throw new Error('Native plan operation identity exceeds its bound.')
    const signature = claudePlanInputFingerprint(name, input)
    const previous = this.operations.get(id)
    if (previous) {
      if (previous.input !== signature) this.reject(id)
      return true
    }
    this.operations.set(id, { kind: 'write', input: signature, failed: false })
    if (this.pending.size) {
      this.overlapped = true
      this.fail()
    }
    this.pending.add(id)
    this.complete = false
    return true
  }

  noteSubmission(id: string, input: unknown): void {
    if (!id || id.length > 1024 || (!this.operations.has(id) && this.operations.size >= 64))
      throw new Error('Native plan submission identity exceeds its bound.')
    const signature = claudePlanInputFingerprint('ExitPlanMode', input)
    const existing = this.operations.get(id)
    if (existing) {
      if (existing.kind !== 'submission' || existing.input !== signature) this.reject(id)
    } else this.operations.set(id, { kind: 'submission', input: signature, failed: false })
  }

  retained(id: string): CollaborationRetainedPlan | undefined {
    const submission = this.operations.get(id)
    if (
      !submission ||
      submission.kind !== 'submission' ||
      submission.failed ||
      !this.complete ||
      !this.text ||
      this.unavailable ||
      this.pending.size ||
      [...this.operations.values()].some((operation) => operation.kind === 'write')
    )
      return undefined
    return {
      nativeId: id,
      sha256: createHash('sha256').update(this.text).digest('hex'),
      bytes: Buffer.byteLength(this.text),
      chars: this.text.length,
    }
  }

  reject(id: string): void {
    const operation = this.operations.get(id)
    if (operation) operation.failed = true
    this.pending.delete(id)
    if (!this.pending.size) this.overlapped = false
    this.fail()
  }

  fail(): void {
    this.complete = false
    this.unavailable = true
  }

  acknowledge(name: string, id: string, input: unknown, response: unknown): void {
    const value = object(input),
      result = object(response)
    if (!this.begin(name, id, input)) return
    const operation = this.operations.get(id)
    if (!operation || operation.failed) {
      this.fail()
      return
    }
    const receipt = fingerprint([
      operation.input,
      result.filePath,
      result.content,
      result.oldString,
      result.newString,
      result.replaceAll,
      result.userModified,
      result.originalFile,
    ])
    if (operation.acknowledgement) {
      if (operation.acknowledgement !== receipt) this.reject(id)
      return
    }
    operation.acknowledgement = receipt
    this.pending.delete(id)
    const overlapped = this.overlapped
    if (!this.pending.size) this.overlapped = false
    if (
      overlapped ||
      this.pending.size ||
      result.filePath !== this.binding.path ||
      result.userModified !== false
    ) {
      this.fail()
      return
    }
    let next: string | undefined
    const base =
      this.text ?? (typeof result.originalFile === 'string' ? result.originalFile : undefined)
    if (name === 'Write' && typeof value.content === 'string' && result.content === value.content) {
      next = value.content
    } else if (
      name === 'Edit' &&
      !this.unavailable &&
      base !== undefined &&
      typeof value.old_string === 'string' &&
      value.old_string.length > 0 &&
      typeof value.new_string === 'string' &&
      result.oldString === value.old_string &&
      result.newString === value.new_string &&
      typeof result.replaceAll === 'boolean' &&
      result.replaceAll === (value.replace_all ?? false) &&
      (result.originalFile == null || result.originalFile === base)
    ) {
      const old = value.old_string,
        replacement = value.new_string
      let count = 0,
        cursor = 0
      while ((cursor = base.indexOf(old, cursor)) >= 0) {
        count++
        cursor += old.length
      }
      if (count && (result.replaceAll || count === 1)) {
        const replacements = result.replaceAll ? count : 1
        const bytes =
          Buffer.byteLength(base) +
          replacements * (Buffer.byteLength(replacement) - Buffer.byteLength(old))
        const chars = base.length + replacements * (replacement.length - old.length)
        this.reserve(
          4096 +
            (Buffer.byteLength(base) + Math.max(0, bytes)) * 4 +
            (base.length + Math.max(0, chars)) * 2,
        )
        // A callback keeps replacement strings literal (including $& and $').
        next = result.replaceAll
          ? base.split(old).join(replacement)
          : base.replace(old, () => replacement)
      }
    }
    if (next === undefined || !next.trim()) {
      this.fail()
      return
    }
    this.reserve(4096 + Buffer.byteLength(next) * 4 + next.length * 2)
    this.text = next
    this.lastId = id
    this.complete = true
    this.unavailable = false
  }

  finish(): void {
    if (this.pending.size) this.fail()
  }
}
