import { SerializeAddon } from '@xterm/addon-serialize'
import { Terminal } from '@xterm/headless'
import { parentPort } from 'node:worker_threads'

import {
  MAX_TERMINAL_DELTA_RING_BYTES,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  MAX_TOTAL_TERMINALS,
  type TerminalDeltaChunk,
  type TerminalInputModes,
} from '@pact/contracts/terminal'

const MAX_SCROLLBACK_LINES = 2000
const MAX_SERIALIZED_SCROLLBACK_BYTES = 4 * 1024 * 1024
const MAX_INSTANCE_RESIDENT_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_RESIDENT_BYTES = 128 * 1024 * 1024
const MAX_JSON_EVENT_PAYLOAD_BYTES = 34 * 1024
const MAX_DELTA_RING_ENTRIES = 2048
const MAX_QUERY_REPLIES_PER_WINDOW = 64
const QUERY_WINDOW_MS = 1000
const PINNED_SNAPSHOT_TTL_MS = 10_000
const BYTES_PER_CELL_HEADLESS = 16
const BYTES_PER_CELL_RENDERER_ACTIVE = 16
const BYTES_PER_CELL_RENDERER_SCROLL = 8

export type TerminalWorkerRequest =
  | {
      id: number
      type: 'create'
      terminalId: string
      projectId: string
      cols: number
      rows: number
      visible: boolean
      rendererRetained: boolean
    }
  | {
      id: number
      type: 'set-visibility'
      terminalId: string
      visible: boolean
      rendererRetained: boolean
    }
  | {
      id: number
      type: 'feed'
      terminalId: string
      data: string
    }
  | {
      id: number
      type: 'resize'
      terminalId: string
      cols: number
      rows: number
    }
  | {
      id: number
      type: 'snapshot'
      terminalId: string
      fromSeq?: number | undefined
      offset?: number | undefined
      pinnedVersion?: number | undefined
    }
  | {
      id: number
      type: 'destroy'
      terminalId: string
    }

export type TerminalWorkerMessage =
  | {
      type: 'reply'
      id: number
      ok: true
      value: unknown
    }
  | {
      type: 'reply'
      id: number
      ok: false
      error: string
    }
  | {
      type: 'output'
      chunks: Array<{
        terminalId: string
        projectId: string
        seq: number
        previousSeq: number
        utf8Bytes: number
        data: string
        inputModes: TerminalInputModes
      }>
    }
  | {
      type: 'query-reply'
      terminalId: string
      data: string
    }

interface RingEntry extends TerminalDeltaChunk {
  utf8Bytes: number
}

interface PinnedSnapshot {
  version: number
  text: string
  totalBytes: number
  cols: number
  rows: number
  inputModes: TerminalInputModes
  expiresAt: number
}

interface WorkerTerminalInstance {
  terminalId: string
  projectId: string
  terminal: Terminal
  serialize: SerializeAddon
  cols: number
  rows: number
  visible: boolean
  rendererRetained: boolean
  seq: number
  earliestCoveredSeq: number
  ringUtf8Bytes: number
  deltaRing: RingEntry[]
  estimatedResidentBytes: number
  queryWindowStartedAt: number
  queryRepliesInWindow: number
  pending: Promise<void>
  pinnedSnapshot?: PinnedSnapshot | undefined
}

const instances = new Map<string, WorkerTerminalInstance>()

function postWorkerMessage(message: TerminalWorkerMessage): void {
  parentPort?.postMessage(message)
}

function clampUtf16BoundaryLeft(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return Math.max(0, Math.min(text.length, index))
  const prev = text.charCodeAt(index - 1)
  const curr = text.charCodeAt(index)
  if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) {
    return index - 1
  }
  return index
}

function measureJsonBytes(sample: unknown): number {
  return Buffer.byteLength(JSON.stringify(sample), 'utf8')
}

function splitUtf16ByBudgets(
  text: string,
  startOffset: number,
  buildEnvelope: (slice: string) => unknown,
  maxJsonBytes: number,
  maxRawUtf8Bytes?: number,
): { slice: string; nextOffset: number } {
  if (startOffset >= text.length) {
    return { slice: '', nextOffset: text.length }
  }
  const remaining = text.slice(startOffset)
  const fits = (candidate: string): boolean =>
    (maxRawUtf8Bytes === undefined || Buffer.byteLength(candidate, 'utf8') <= maxRawUtf8Bytes) &&
    measureJsonBytes(buildEnvelope(candidate)) <= maxJsonBytes

  if (fits(remaining)) {
    return { slice: remaining, nextOffset: text.length }
  }

  let lo = 1
  let hi = remaining.length
  let best = 0
  while (lo <= hi) {
    const rawMid = Math.floor((lo + hi) / 2)
    const leftAligned = clampUtf16BoundaryLeft(remaining, rawMid)
    let probeLen: number
    if (leftAligned >= lo) {
      probeLen = leftAligned
    } else if (rawMid + 1 <= hi) {
      probeLen = rawMid + 1
    } else {
      break
    }
    const candidate = remaining.slice(0, probeLen)
    if (fits(candidate)) {
      best = probeLen
      lo = probeLen + 1
    } else {
      hi = probeLen - 1
    }
  }
  if (best < 1) {
    const first = remaining.charCodeAt(0)
    best = first >= 0xd800 && first <= 0xdbff && remaining.length > 1 ? 2 : 1
  }
  return {
    slice: remaining.slice(0, best),
    nextOffset: startOffset + best,
  }
}

function currentInputModes(instance: WorkerTerminalInstance): TerminalInputModes {
  return {
    bracketedPaste: instance.terminal.modes.bracketedPasteMode,
    applicationCursor: instance.terminal.modes.applicationCursorKeysMode,
  }
}

function computeInstanceResidentBytes(
  instance: WorkerTerminalInstance,
  extraQueueBytes = 0,
): number {
  const cols = Math.max(80, instance.cols)
  const normalLines = instance.terminal.buffer.normal.length
  const altActive = instance.terminal.buffer.active === instance.terminal.buffer.alternate
  const altLines = altActive ? instance.terminal.buffer.alternate.length : 0
  const headlessBytes = (normalLines + altLines) * cols * BYTES_PER_CELL_HEADLESS
  const rendererBytes = instance.rendererRetained
    ? instance.rows * cols * BYTES_PER_CELL_RENDERER_ACTIVE +
      Math.max(0, normalLines - instance.rows) * cols * BYTES_PER_CELL_RENDERER_SCROLL
    : 0
  const snapshotBytes = instance.pinnedSnapshot ? instance.pinnedSnapshot.totalBytes * 2 : 0
  return headlessBytes + rendererBytes + instance.ringUtf8Bytes + snapshotBytes + extraQueueBytes
}

function totalEstimatedResidentBytes(): number {
  let total = 0
  for (const instance of instances.values()) total += instance.estimatedResidentBytes
  return total
}

function dropExpiredSnapshot(instance: WorkerTerminalInstance, now = Date.now()): void {
  if (instance.pinnedSnapshot && instance.pinnedSnapshot.expiresAt < now) {
    instance.pinnedSnapshot = undefined
  }
}

function trimDeltaRing(instance: WorkerTerminalInstance): void {
  while (
    (instance.ringUtf8Bytes > MAX_TERMINAL_DELTA_RING_BYTES ||
      instance.deltaRing.length > MAX_DELTA_RING_ENTRIES) &&
    instance.deltaRing.length > 0
  ) {
    const removed = instance.deltaRing.shift()!
    instance.ringUtf8Bytes -= removed.utf8Bytes
  }
  instance.earliestCoveredSeq =
    instance.deltaRing.length > 0 ? instance.deltaRing[0]!.previousSeq : instance.seq
}

function reduceInstanceFootprint(
  target: WorkerTerminalInstance,
  extraQueueBytes = 0,
): { withinBudget: boolean } {
  trimDeltaRing(target)
  target.estimatedResidentBytes = computeInstanceResidentBytes(target, extraQueueBytes)
  if (target.estimatedResidentBytes <= MAX_INSTANCE_RESIDENT_BYTES) {
    return { withinBudget: true }
  }

  // First drop retained scrollback lines while keeping current visible viewport intact.
  let currentScrollback = target.terminal.options.scrollback ?? MAX_SCROLLBACK_LINES
  while (target.estimatedResidentBytes > MAX_INSTANCE_RESIDENT_BYTES && currentScrollback > 0) {
    currentScrollback = currentScrollback <= 16 ? 0 : Math.floor(currentScrollback / 2)
    target.terminal.options.scrollback = currentScrollback
    target.estimatedResidentBytes = computeInstanceResidentBytes(target, extraQueueBytes)
  }

  while (
    target.estimatedResidentBytes > MAX_INSTANCE_RESIDENT_BYTES &&
    target.deltaRing.length > 0
  ) {
    const removed = target.deltaRing.shift()!
    target.ringUtf8Bytes -= removed.utf8Bytes
    target.earliestCoveredSeq =
      target.deltaRing.length > 0 ? target.deltaRing[0]!.previousSeq : target.seq
    target.estimatedResidentBytes = computeInstanceResidentBytes(target, extraQueueBytes)
  }

  return { withinBudget: target.estimatedResidentBytes <= MAX_INSTANCE_RESIDENT_BYTES }
}

function enforceGlobalMemoryBounds(activeInstance: WorkerTerminalInstance): boolean {
  const { withinBudget } = reduceInstanceFootprint(activeInstance)
  const now = Date.now()
  for (const instance of instances.values()) {
    dropExpiredSnapshot(instance, now)
    instance.estimatedResidentBytes = computeInstanceResidentBytes(instance)
  }

  while (totalEstimatedResidentBytes() > MAX_TOTAL_RESIDENT_BYTES) {
    let victim: WorkerTerminalInstance | undefined
    for (const candidate of instances.values()) {
      const canTrim =
        candidate.deltaRing.length > 0 || (candidate.terminal.options.scrollback ?? 0) > 0
      if (!canTrim) continue
      if (!victim || candidate.estimatedResidentBytes > victim.estimatedResidentBytes) {
        victim = candidate
      }
    }
    if (!victim) break

    const curScrollback = victim.terminal.options.scrollback ?? 0
    if (curScrollback > 0) {
      victim.terminal.options.scrollback = curScrollback <= 16 ? 0 : Math.floor(curScrollback / 2)
    } else if (victim.deltaRing.length > 0) {
      const removed = victim.deltaRing.shift()!
      victim.ringUtf8Bytes -= removed.utf8Bytes
      victim.earliestCoveredSeq =
        victim.deltaRing.length > 0 ? victim.deltaRing[0]!.previousSeq : victim.seq
    }
    victim.estimatedResidentBytes = computeInstanceResidentBytes(victim)
  }

  return withinBudget && totalEstimatedResidentBytes() <= MAX_TOTAL_RESIDENT_BYTES
}

function emitBoundedQueryReply(instance: WorkerTerminalInstance, reply: string): void {
  const now = Date.now()
  if (now - instance.queryWindowStartedAt >= QUERY_WINDOW_MS) {
    instance.queryWindowStartedAt = now
    instance.queryRepliesInWindow = 0
  }
  if (instance.queryRepliesInWindow >= MAX_QUERY_REPLIES_PER_WINDOW) return
  instance.queryRepliesInWindow += 1
  postWorkerMessage({
    type: 'query-reply',
    terminalId: instance.terminalId,
    data: reply,
  })
}

function firstParamValue(params: Array<number | number[]>): number | undefined {
  if (params.length === 0) return undefined
  const first = params[0]
  return Array.isArray(first) ? first[0] : first
}

function registerQueryResponders(instance: WorkerTerminalInstance): void {
  const { parser } = instance.terminal
  parser.registerCsiHandler({ final: 'c' }, (params) => {
    const code = firstParamValue(params) ?? 0
    if (code === 0) {
      emitBoundedQueryReply(instance, '\u001b[?1;2c')
    }
    return true
  })
  parser.registerCsiHandler({ prefix: '>', final: 'c' }, (params) => {
    const code = firstParamValue(params) ?? 0
    if (code === 0) {
      emitBoundedQueryReply(instance, '\u001b[>0;276;0c')
    }
    return true
  })
  parser.registerCsiHandler({ final: 'n' }, (params) => {
    const code = firstParamValue(params)
    if (code === 5) {
      emitBoundedQueryReply(instance, '\u001b[0n')
      return true
    }
    if (code === 6) {
      const buf = instance.terminal.buffer.active
      const row = buf.cursorY + 1
      const col = buf.cursorX + 1
      emitBoundedQueryReply(instance, `\u001b[${row};${col}R`)
      return true
    }
    return false
  })
}

function trimSerializedScrollback(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_SERIALIZED_SCROLLBACK_BYTES) return text
  let approxChars = Math.floor(
    text.length * (MAX_SERIALIZED_SCROLLBACK_BYTES / Buffer.byteLength(text, 'utf8')),
  )
  approxChars = Math.min(text.length, Math.max(1, approxChars))
  let start = clampUtf16BoundaryLeft(text, text.length - approxChars)
  while (
    start < text.length &&
    Buffer.byteLength(text.slice(start), 'utf8') > MAX_SERIALIZED_SCROLLBACK_BYTES
  ) {
    start = clampUtf16BoundaryLeft(
      text,
      start + Math.max(256, Math.floor((text.length - start) / 16)),
    )
  }
  const newline = text.indexOf('\n', start)
  if (newline >= 0 && newline - start < 4096) {
    start = newline + 1
  }
  return text.slice(start)
}

function handleCreate(req: Extract<TerminalWorkerRequest, { type: 'create' }>): unknown {
  if (instances.has(req.terminalId)) {
    throw new Error('Terminal instance already exists in worker.')
  }
  if (instances.size >= MAX_TOTAL_TERMINALS) {
    throw new Error('Terminal worker capacity limit reached.')
  }
  const terminal = new Terminal({
    cols: req.cols,
    rows: req.rows,
    scrollback: MAX_SCROLLBACK_LINES,
    allowProposedApi: true,
    convertEol: false,
  })
  const serialize = new SerializeAddon()
  terminal.loadAddon(serialize)
  const instance: WorkerTerminalInstance = {
    terminalId: req.terminalId,
    projectId: req.projectId,
    terminal,
    serialize,
    cols: req.cols,
    rows: req.rows,
    visible: req.visible,
    rendererRetained: req.rendererRetained,
    seq: 0,
    earliestCoveredSeq: 0,
    ringUtf8Bytes: 0,
    deltaRing: [],
    estimatedResidentBytes: 0,
    queryWindowStartedAt: Date.now(),
    queryRepliesInWindow: 0,
    pending: Promise.resolve(),
  }
  registerQueryResponders(instance)
  instances.set(req.terminalId, instance)
  if (!enforceGlobalMemoryBounds(instance)) {
    serialize.dispose()
    terminal.dispose()
    instances.delete(req.terminalId)
    throw new Error('Terminal memory budget exceeded before opening.')
  }
  return { seq: 0, inputModes: currentInputModes(instance) }
}

function handleSetVisibility(
  req: Extract<TerminalWorkerRequest, { type: 'set-visibility' }>,
): unknown {
  const instance = instances.get(req.terminalId)
  if (!instance) return { updated: false }
  instance.visible = req.visible
  instance.rendererRetained = req.rendererRetained
  instance.estimatedResidentBytes = computeInstanceResidentBytes(instance)
  return { updated: true }
}

function handleFeed(req: Extract<TerminalWorkerRequest, { type: 'feed' }>): Promise<unknown> {
  const instance = instances.get(req.terminalId)
  if (!instance) {
    return Promise.reject(new Error('Terminal instance not found.'))
  }
  const task = instance.pending.then(
    () =>
      new Promise<unknown>((resolve) => {
        if (!instances.has(req.terminalId)) {
          resolve({ seq: instance.seq, inputModes: currentInputModes(instance) })
          return
        }
        instance.terminal.write(req.data, () => {
          const emitted: Array<{
            terminalId: string
            projectId: string
            seq: number
            previousSeq: number
            utf8Bytes: number
            data: string
            inputModes: TerminalInputModes
          }> = []
          const modes = currentInputModes(instance)
          let offset = 0
          let budgetOk = true
          while (offset < req.data.length) {
            const previousSeq = instance.seq
            const { slice, nextOffset } = splitUtf16ByBudgets(
              req.data,
              offset,
              (candidate) => ({
                terminalId: instance.terminalId,
                projectId: instance.projectId,
                seq: previousSeq + 1,
                previousSeq,
                utf8Bytes: Buffer.byteLength(candidate, 'utf8'),
                data: candidate,
              }),
              MAX_JSON_EVENT_PAYLOAD_BYTES,
              MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
            )
            offset = nextOffset
            if (!slice.length) break
            const nextSeq = previousSeq + 1
            instance.seq = nextSeq
            const utf8Bytes = Buffer.byteLength(slice, 'utf8')
            instance.deltaRing.push({ seq: nextSeq, previousSeq, data: slice, utf8Bytes })
            instance.ringUtf8Bytes += utf8Bytes
            if (!enforceGlobalMemoryBounds(instance)) {
              budgetOk = false
            }
            if (instance.visible) {
              emitted.push({
                terminalId: instance.terminalId,
                projectId: instance.projectId,
                seq: nextSeq,
                previousSeq,
                utf8Bytes,
                data: slice,
                inputModes: modes,
              })
            }
          }
          if (emitted.length > 0 && instance.visible) {
            postWorkerMessage({ type: 'output', chunks: emitted })
          }
          resolve({
            seq: instance.seq,
            inputModes: modes,
            ...(!budgetOk
              ? { resourceError: 'Terminal memory limit exceeded (12 MiB per terminal).' }
              : {}),
          })
        })
      }),
  )
  instance.pending = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function handleResize(req: Extract<TerminalWorkerRequest, { type: 'resize' }>): Promise<unknown> {
  const instance = instances.get(req.terminalId)
  if (!instance) return Promise.reject(new Error('Terminal instance not found.'))
  const task = instance.pending.then(() => {
    instance.cols = req.cols
    instance.rows = req.rows
    instance.terminal.resize(req.cols, req.rows)
    instance.pinnedSnapshot = undefined
    const budgetOk = enforceGlobalMemoryBounds(instance)
    if (!budgetOk) {
      throw new Error('Terminal resize exceeds its 12 MiB memory budget.')
    }
    return { seq: instance.seq, inputModes: currentInputModes(instance) }
  })
  instance.pending = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function handleSnapshot(
  req: Extract<TerminalWorkerRequest, { type: 'snapshot' }>,
): Promise<unknown> {
  const instance = instances.get(req.terminalId)
  if (!instance) return Promise.reject(new Error('Terminal instance not found.'))
  const task = instance.pending.then(() => {
    const modes = currentInputModes(instance)
    if (
      req.fromSeq !== undefined &&
      req.offset === undefined &&
      req.fromSeq >= instance.earliestCoveredSeq &&
      req.fromSeq <= instance.seq
    ) {
      const matching = instance.deltaRing.filter((chunk) => chunk.seq > req.fromSeq!)
      const deltaPayload = {
        kind: 'delta' as const,
        fromSeq: req.fromSeq,
        toSeq: instance.seq,
        chunks: matching.map(({ seq, previousSeq, data }) => ({ seq, previousSeq, data })),
        inputModes: modes,
      }
      if (measureJsonBytes(deltaPayload) <= MAX_JSON_EVENT_PAYLOAD_BYTES) {
        return deltaPayload
      }
    }

    const now = Date.now()
    const requestingNextPage = req.offset !== undefined && req.offset > 0
    if (requestingNextPage) {
      if (
        !instance.pinnedSnapshot ||
        instance.pinnedSnapshot.expiresAt < now ||
        (req.pinnedVersion !== undefined && instance.pinnedSnapshot.version !== req.pinnedVersion)
      ) {
        throw new Error('Terminal snapshot expired; restart recovery from offset 0.')
      }
    } else {
      const rawSerialized = trimSerializedScrollback(
        instance.serialize.serialize({
          scrollback: instance.terminal.options.scrollback ?? MAX_SCROLLBACK_LINES,
        }),
      )
      instance.pinnedSnapshot = {
        version: instance.seq,
        text: rawSerialized,
        totalBytes: Buffer.byteLength(rawSerialized, 'utf8'),
        cols: instance.cols,
        rows: instance.rows,
        inputModes: modes,
        expiresAt: now + PINNED_SNAPSHOT_TTL_MS,
      }
      void enforceGlobalMemoryBounds(instance)
    }

    const snap = instance.pinnedSnapshot
    const startOffset = clampUtf16BoundaryLeft(
      snap.text,
      Math.min(req.offset ?? 0, snap.text.length),
    )
    const { slice, nextOffset } = splitUtf16ByBudgets(
      snap.text,
      startOffset,
      (candidate) => ({
        kind: 'snapshot',
        snapshotVersion: snap.version,
        cols: snap.cols,
        rows: snap.rows,
        offset: startOffset,
        totalBytes: snap.totalBytes,
        text: candidate,
        nextOffset: null,
        inputModes: snap.inputModes,
      }),
      MAX_JSON_EVENT_PAYLOAD_BYTES,
    )
    const hasMore = nextOffset < snap.text.length
    if (!hasMore) {
      instance.pinnedSnapshot = undefined
      void enforceGlobalMemoryBounds(instance)
    }
    return {
      kind: 'snapshot' as const,
      snapshotVersion: snap.version,
      cols: snap.cols,
      rows: snap.rows,
      offset: startOffset,
      totalBytes: snap.totalBytes,
      text: slice,
      nextOffset: hasMore ? nextOffset : null,
      inputModes: snap.inputModes,
    }
  })
  instance.pending = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function handleDestroy(req: Extract<TerminalWorkerRequest, { type: 'destroy' }>): unknown {
  const instance = instances.get(req.terminalId)
  if (instance) {
    instance.pinnedSnapshot = undefined
    instance.deltaRing.length = 0
    instance.serialize.dispose()
    instance.terminal.dispose()
    instances.delete(req.terminalId)
  }
  return { destroyed: true, remaining: instances.size }
}

parentPort?.on('message', (message: TerminalWorkerRequest) => {
  void (async () => {
    try {
      let value: unknown
      switch (message.type) {
        case 'create':
          value = handleCreate(message)
          break
        case 'set-visibility':
          value = handleSetVisibility(message)
          break
        case 'feed':
          value = await handleFeed(message)
          break
        case 'resize':
          value = await handleResize(message)
          break
        case 'snapshot':
          value = await handleSnapshot(message)
          break
        case 'destroy':
          value = handleDestroy(message)
          break
      }
      postWorkerMessage({ type: 'reply', id: message.id, ok: true, value })
    } catch (error) {
      postWorkerMessage({
        type: 'reply',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Terminal worker operation failed.',
      })
    }
  })()
})
