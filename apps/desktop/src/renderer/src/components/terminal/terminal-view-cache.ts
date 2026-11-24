import type { FitAddon } from '@xterm/addon-fit'
import type { ITheme, Terminal } from '@xterm/xterm'

import {
  MAX_TERMINAL_INPUT_BYTES,
  type TerminalOutputEvent,
  type TerminalSnapshotResult,
  type TerminalSummary,
} from '@pact/contracts'

interface TerminalViewCallbacks {
  onInputReady?: (() => void) | undefined
  onInputError?: ((message: string | undefined) => void) | undefined
}

interface DesiredAttachment {
  slot: HTMLDivElement
  summary: TerminalSummary
  platform?: string | undefined
  callbacks: TerminalViewCallbacks
}

interface CachedTerminalView {
  terminalId: string
  projectId: string
  hostElement: HTMLDivElement
  term: Terminal
  fitAddon: FitAddon
  summary: TerminalSummary
  appliedSeq: number
  lastCols: number
  lastRows: number
  inputReady: boolean
  attached: boolean
  subscriptionId?: string | undefined
  syncEpoch: number
  syncingPromise?: Promise<void> | undefined
  bufferedLiveEvents: TerminalOutputEvent[]
  activeDisposables: Array<() => void>
  activeInputChain: Promise<void>
  inputHaltedError?: string | undefined
  pendingAckSeq: number
  pendingAckBytes: number
  ackTimer?: ReturnType<typeof setTimeout> | undefined
  selectionCleanupFrame?: number | undefined
  callbacks: TerminalViewCallbacks
}

interface XtermRuntime {
  Terminal: typeof Terminal
  FitAddon: typeof FitAddon
}

const views = new Map<string, CachedTerminalView>()
const desiredAttachments = new Map<string, DesiredAttachment>()
const inFlightCreations = new Map<string, Promise<CachedTerminalView | undefined>>()
let xtermRuntimePromise: Promise<XtermRuntime> | undefined
let globalOutputUnsubscribe: (() => void) | undefined
let globalThemeObserver: MutationObserver | undefined

const utf8Encoder = new TextEncoder()
const ACK_FLUSH_THRESHOLD_BYTES = 32 * 1024
const ACK_FLUSH_DELAY_MS = 16

async function loadXtermRuntime(): Promise<XtermRuntime> {
  xtermRuntimePromise ??= (async () => {
    const [xtermMod, fitMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ])
    return { Terminal: xtermMod.Terminal, FitAddon: fitMod.FitAddon }
  })().catch((error) => {
    xtermRuntimePromise = undefined
    throw error
  })
  return xtermRuntimePromise
}

function isDarkThemeActive(): boolean {
  const root = document.documentElement
  const attr = root.getAttribute('data-theme')
  if (attr === 'dark') return true
  if (attr === 'light') return false
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
}

function readHexColorVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const raw = style.getPropertyValue(name).trim()
  return /^#[\da-f]{6}$/i.test(raw) ? raw : fallback
}

export function readComputedXtermTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  const dark = isDarkThemeActive()
  const foreground = readHexColorVar(style, '--pact-code-foreground', dark ? '#edf5fc' : '#101b29')

  if (dark) {
    // Non-zero RGB with 00 alpha keeps canvas transparent while making SGR 7 inverse text
    // and xterm's opaque selection blend resolve against midnight slate rather than #000000.
    return {
      background: '#0e162000',
      foreground,
      cursor: '#cbd8e6',
      cursorAccent: '#0e1620',
      selectionBackground: 'rgba(103, 177, 255, 0.28)',
      selectionInactiveBackground: 'rgba(148, 163, 184, 0.20)',
      black: '#1e293b',
      red: '#ff8a80',
      green: '#5ee58a',
      yellow: '#f4c753',
      blue: '#67b1ff',
      magenta: '#c4b5fd',
      cyan: '#7ad7f0',
      white: '#e2e8f0',
      brightBlack: '#64748b',
      brightRed: '#ffa8a0',
      brightGreen: '#86efac',
      brightYellow: '#fde047',
      brightBlue: '#93c5fd',
      brightMagenta: '#ddd6fe',
      brightCyan: '#a5f3fc',
      brightWhite: '#ffffff',
    }
  }

  return {
    background: '#f3f7fb00',
    foreground,
    cursor: '#2c3a4b',
    cursorAccent: '#f3f7fb',
    selectionBackground: 'rgba(0, 105, 224, 0.22)',
    selectionInactiveBackground: 'rgba(15, 23, 42, 0.11)',
    black: '#1e293b',
    red: '#b42318',
    green: '#157347',
    yellow: '#a15c07',
    blue: '#0069e0',
    magenta: '#7c3aed',
    cyan: '#0e7490',
    white: '#e2e8f0',
    brightBlack: '#64748b',
    brightRed: '#d92d20',
    brightGreen: '#16883f',
    brightYellow: '#b4690e',
    brightBlue: '#1d4ed8',
    brightMagenta: '#9333ea',
    brightCyan: '#0891b2',
    brightWhite: '#ffffff',
  }
}

export function syncAllTerminalThemes(): void {
  if (views.size === 0) return
  const theme = readComputedXtermTheme()
  const style = getComputedStyle(document.documentElement)
  const fontFamily =
    style.getPropertyValue('--pact-font-mono').trim() ||
    "'JetBrains Mono Variable', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"

  for (const view of views.values()) {
    view.term.options.theme = theme
    view.term.options.fontFamily = fontFamily
  }
}

function ensureThemeWatcher(): void {
  if (globalThemeObserver || typeof document === 'undefined') return
  const observer = new MutationObserver(() => {
    syncAllTerminalThemes()
  })
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-material', 'style'],
  })
  const media = window.matchMedia?.('(prefers-color-scheme: dark)')
  media?.addEventListener?.('change', () => syncAllTerminalThemes())
  globalThemeObserver = observer
}

function isSurrogateSplitAt(text: string, splitIndex: number): boolean {
  if (splitIndex <= 0 || splitIndex >= text.length) return false
  const prev = text.charCodeAt(splitIndex - 1)
  const curr = text.charCodeAt(splitIndex)
  return prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff
}

function splitUtf16ByUtf8Limit(text: string, maxUtf8Bytes: number): string[] {
  if (!text) return []
  if (utf8Encoder.encode(text).byteLength <= maxUtf8Bytes) return [text]
  const slices: string[] = []
  let start = 0
  while (start < text.length) {
    let low = start + 1
    let high = Math.min(text.length, start + maxUtf8Bytes)
    let best = start + 1
    if (isSurrogateSplitAt(text, best) && best + 1 <= text.length) {
      best = start + 2
      low = best
    }
    const fits = (end: number): boolean =>
      utf8Encoder.encode(text.slice(start, end)).byteLength <= maxUtf8Bytes

    while (low <= high) {
      const mid = (low + high) >>> 1
      if (isSurrogateSplitAt(text, mid)) {
        const left = mid - 1
        const right = mid + 1
        if (left <= start) {
          if (right <= text.length && fits(right)) {
            best = right
            low = right + 1
            continue
          }
          best = Math.min(text.length, start + 2)
          break
        }
        if (!fits(left)) {
          high = left - 1
          continue
        }
        best = left
        if (right <= high && fits(right)) {
          best = right
          low = right + 1
          continue
        }
        break
      }
      if (fits(mid)) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    slices.push(text.slice(start, best))
    start = best
  }
  return slices
}

function flushAckNow(view: CachedTerminalView): void {
  if (view.ackTimer !== undefined) {
    clearTimeout(view.ackTimer)
    view.ackTimer = undefined
  }
  const bytes = view.pendingAckBytes
  const seq = view.pendingAckSeq
  const subId = view.subscriptionId
  if (!subId || bytes <= 0) {
    view.pendingAckBytes = 0
    return
  }
  view.pendingAckBytes = 0
  void window.pact
    .ackTerminalOutput({
      subscriptionId: subId,
      terminalId: view.terminalId,
      ackedSeq: seq,
      ackedBytes: bytes,
    })
    .catch(() => undefined)
}

function queueAck(view: CachedTerminalView, seq: number, utf8Bytes: number): void {
  if (!view.subscriptionId || utf8Bytes <= 0) return
  view.pendingAckSeq = Math.max(view.pendingAckSeq, seq)
  view.pendingAckBytes += utf8Bytes
  if (view.pendingAckBytes >= ACK_FLUSH_THRESHOLD_BYTES) {
    flushAckNow(view)
    return
  }
  if (view.ackTimer === undefined) {
    view.ackTimer = setTimeout(() => {
      flushAckNow(view)
    }, ACK_FLUSH_DELAY_MS)
  }
}

function writeToXtermAsync(
  view: CachedTerminalView,
  data: string,
  syncEpoch: number,
): Promise<boolean> {
  if (!data) {
    return Promise.resolve(view.syncEpoch === syncEpoch && views.has(view.terminalId))
  }
  return new Promise((resolve) => {
    view.term.write(data, () => {
      resolve(view.syncEpoch === syncEpoch && views.has(view.terminalId))
    })
  })
}

function cancelSelectionCleanupFrame(view: CachedTerminalView): void {
  if (view.selectionCleanupFrame !== undefined) {
    cancelAnimationFrame(view.selectionCleanupFrame)
    view.selectionCleanupFrame = undefined
  }
}

function resetXtermSelectionRenderModel(view: CachedTerminalView): void {
  // Upstream @xterm/xterm DomRenderer.handleSelectionChanged returns early on empty
  // selection without resetting _selectionRenderModel.selectionStart/End, causing
  // subsequent resize events to resurrect stale selection overlays. Queuing a
  // zero-length selection at (0, 0) runs SelectionRenderModel.update()->clear(),
  // then clearing in the same animation frame drops the Shift+Click anchor at (0, 0).
  view.term.select(0, 0, 0)
  cancelSelectionCleanupFrame(view)
  view.selectionCleanupFrame = requestAnimationFrame(() => {
    view.selectionCleanupFrame = undefined
    if (!views.has(view.terminalId)) return
    if (!view.term.hasSelection()) {
      view.term.clearSelection()
    }
  })
}

function clearSelectionWithDom(view: CachedTerminalView): void {
  if (view.term.hasSelection()) {
    resetXtermSelectionRenderModel(view)
  }
  const domSelection = typeof window !== 'undefined' ? window.getSelection() : null
  if (!domSelection || domSelection.isCollapsed) return
  const container = view.hostElement ?? view.term.element
  if (!container) return
  const anchor = domSelection.anchorNode
  const focus = domSelection.focusNode
  if ((anchor && container.contains(anchor)) || (focus && container.contains(focus))) {
    domSelection.removeAllRanges()
  }
}

function installKeyHandler(view: CachedTerminalView, platform?: string): void {
  const { term } = view
  const isMac = platform === 'darwin'
  term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
    if (
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      (event.code === 'Backquote' || event.key === '`')
    ) {
      return false
    }

    if (event.type !== 'keydown') return true

    if (isMac) {
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'c') {
        if (term.hasSelection()) {
          void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
          clearSelectionWithDom(view)
          return false
        }
        return true
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'k') {
        term.clear()
        return false
      }
      if (event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'v') {
        clearSelectionWithDom(view)
        return true
      }
      return true
    }

    // Windows / Linux: Ctrl+Shift+C/V and Ctrl+C copies when selection exists, or sends \x03 when empty.
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'c') {
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
        clearSelectionWithDom(view)
      }
      return false
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'v') {
      clearSelectionWithDom(view)
      void navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text)
          return undefined
        })
        .catch(() => undefined)
      return false
    }
    if (
      platform === 'win32' &&
      event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === 'c'
    ) {
      if (term.hasSelection()) {
        void navigator.clipboard?.writeText(term.getSelection()).catch(() => undefined)
        clearSelectionWithDom(view)
        return false
      }
      return true
    }
    return true
  })
}

function sendTerminalInput(view: CachedTerminalView, data: string): void {
  if (!data || !view.inputReady || view.summary.state !== 'running') return
  const chunks = splitUtf16ByUtf8Limit(data, MAX_TERMINAL_INPUT_BYTES)
  if (chunks.length === 0) return

  const streamId = crypto.randomUUID()
  const expectedEpoch = view.summary.inputEpoch

  const sendChunkAt = async (chunkSeq: number): Promise<void> => {
    if (chunkSeq >= chunks.length) {
      if (view.inputHaltedError) {
        view.inputHaltedError = undefined
        view.callbacks.onInputError?.(undefined)
      }
      return
    }
    if (
      !views.has(view.terminalId) ||
      !view.inputReady ||
      view.summary.state !== 'running' ||
      view.summary.inputEpoch !== expectedEpoch
    ) {
      const message =
        view.summary.inputEpoch !== expectedEpoch
          ? 'Terminal state changed; remaining input halted without replay.'
          : 'Terminal became unavailable; remaining input halted.'
      view.inputHaltedError = message
      view.callbacks.onInputError?.(message)
      return
    }
    const res = await window.pact.writeTerminal({
      terminalId: view.terminalId,
      streamId,
      chunkSeq,
      expectedEpoch,
      data: chunks[chunkSeq]!,
    })
    if (!res.ok) {
      view.inputHaltedError = res.error.message
      view.callbacks.onInputError?.(res.error.message)
      return
    }
    await sendChunkAt(chunkSeq + 1)
  }

  view.activeInputChain = view.activeInputChain.catch(() => undefined).then(() => sendChunkAt(0))
}

function ensureGlobalOutputSubscription(): void {
  if (globalOutputUnsubscribe) return
  globalOutputUnsubscribe = window.pact.onTerminalOutput((event: TerminalOutputEvent) => {
    const view = views.get(event.terminalId)
    if (!view || !view.attached || !view.subscriptionId) return

    if (view.syncingPromise) {
      view.bufferedLiveEvents.push(event)
      return
    }

    if (event.seq <= view.appliedSeq) {
      queueAck(view, event.seq, event.utf8Bytes)
      return
    }

    if (event.previousSeq !== view.appliedSeq) {
      view.bufferedLiveEvents.push(event)
      void startSubscribedSync(view)
      return
    }

    view.appliedSeq = event.seq
    const syncEpoch = view.syncEpoch
    view.term.write(event.data, () => {
      if (view.syncEpoch === syncEpoch) {
        queueAck(view, event.seq, event.utf8Bytes)
      }
    })
  })
}

async function applySnapshotPages(
  view: CachedTerminalView,
  firstPage: Extract<TerminalSnapshotResult, { kind: 'snapshot' }>,
  syncEpoch: number,
  retryCount: number,
): Promise<'ok' | 'retry' | 'aborted'> {
  if (view.syncEpoch !== syncEpoch || !views.has(view.terminalId)) return 'aborted'
  view.term.reset()
  resetXtermSelectionRenderModel(view)
  const pinnedVersion = firstPage.snapshotVersion
  let latestSummary = firstPage.terminal

  const applyRemaining = async (
    nextOffset: number | null,
    firstText: string | undefined,
    guard: number,
  ): Promise<'ok' | 'retry' | 'aborted'> => {
    if (view.syncEpoch !== syncEpoch || !views.has(view.terminalId)) return 'aborted'
    if (firstText !== undefined) {
      const ok = await writeToXtermAsync(view, firstText, syncEpoch)
      if (!ok) return 'aborted'
    }
    if (nextOffset === null || guard >= 256) {
      view.appliedSeq = Math.max(view.appliedSeq, latestSummary.seq)
      view.summary = latestSummary
      return 'ok'
    }
    const nextRes = await window.pact.readTerminalSnapshot({
      terminalId: view.terminalId,
      offset: nextOffset,
      pinnedVersion,
    })
    if (view.syncEpoch !== syncEpoch || !views.has(view.terminalId)) return 'aborted'
    if (!nextRes.ok || nextRes.value.kind !== 'snapshot') return 'aborted'
    if (nextRes.value.snapshotVersion !== pinnedVersion) {
      return retryCount < 2 ? 'retry' : 'aborted'
    }
    latestSummary = nextRes.value.terminal
    const ok = await writeToXtermAsync(view, nextRes.value.text, syncEpoch)
    if (!ok) return 'aborted'
    return applyRemaining(nextRes.value.nextOffset, undefined, guard + 1)
  }

  return applyRemaining(firstPage.nextOffset, firstPage.text, 0)
}

function startSubscribedSync(view: CachedTerminalView, forceSubscribe = false): Promise<void> {
  if (view.syncingPromise) return view.syncingPromise

  const mySyncEpoch = ++view.syncEpoch
  view.inputReady = false

  const task = (async () => {
    if (forceSubscribe || !view.subscriptionId) {
      const subscriptionId = crypto.randomUUID()
      view.subscriptionId = subscriptionId
      view.bufferedLiveEvents = []
      const subRes = await window.pact.subscribeTerminal({
        terminalId: view.terminalId,
        subscriptionId,
      })
      if (view.syncEpoch !== mySyncEpoch || !view.attached || !views.has(view.terminalId)) {
        if (subRes.ok) {
          void window.pact.unsubscribeTerminal({ subscriptionId }).catch(() => undefined)
        }
        return
      }
      if (!subRes.ok) {
        view.subscriptionId = undefined
        view.callbacks.onInputError?.(subRes.error.message)
        return
      }
      view.summary = subRes.value.terminal
    }

    const runPass = async (retryCount: number): Promise<boolean> => {
      if (view.syncEpoch !== mySyncEpoch || !view.attached || !views.has(view.terminalId)) {
        return false
      }
      const snapRes = await window.pact.readTerminalSnapshot({
        terminalId: view.terminalId,
        fromSeq: view.appliedSeq,
      })
      if (view.syncEpoch !== mySyncEpoch || !view.attached || !views.has(view.terminalId)) {
        return false
      }
      if (!snapRes.ok) {
        view.callbacks.onInputError?.(snapRes.error.message)
        return false
      }

      if (snapRes.value.kind === 'delta') {
        const delta = snapRes.value
        const joined = delta.chunks
          .filter((chunk) => chunk.seq > view.appliedSeq)
          .map((chunk) => chunk.data)
          .join('')
        const ok = await writeToXtermAsync(view, joined, mySyncEpoch)
        if (!ok) return false
        view.appliedSeq = Math.max(view.appliedSeq, delta.toSeq)
        view.summary = delta.terminal
      } else {
        const outcome = await applySnapshotPages(view, snapRes.value, mySyncEpoch, retryCount)
        if (outcome === 'retry') return runPass(retryCount + 1)
        if (outcome === 'aborted') return false
      }

      const buffered = view.bufferedLiveEvents.splice(0, view.bufferedLiveEvents.length)
      if (buffered.length > 0) {
        const sorted = buffered.toSorted((a, b) => a.seq - b.seq)
        const toWrite: TerminalOutputEvent[] = []
        let expectedPrev = view.appliedSeq
        let gapDetected = false

        for (const item of sorted) {
          if (item.seq <= view.appliedSeq) {
            queueAck(view, item.seq, item.utf8Bytes)
            continue
          }
          if (item.previousSeq <= expectedPrev && item.seq > expectedPrev) {
            toWrite.push(item)
            expectedPrev = item.seq
          } else {
            queueAck(view, item.seq, item.utf8Bytes)
            gapDetected = true
          }
        }

        if (toWrite.length > 0) {
          const text = toWrite.map((item) => item.data).join('')
          const ok = await writeToXtermAsync(view, text, mySyncEpoch)
          if (!ok) return false
          for (const item of toWrite) {
            queueAck(view, item.seq, item.utf8Bytes)
          }
          view.appliedSeq = expectedPrev
        }
        if (gapDetected) {
          return runPass(retryCount + 1)
        }
      }

      return true
    }

    const completed = await runPass(0)
    if (
      completed &&
      view.syncEpoch === mySyncEpoch &&
      view.attached &&
      views.has(view.terminalId)
    ) {
      view.inputReady = true
      view.callbacks.onInputReady?.()
    }
  })().finally(() => {
    if (view.syncingPromise === task) {
      view.syncingPromise = undefined
    }
  })

  view.syncingPromise = task
  return task
}

function attachExistingView(
  view: CachedTerminalView,
  desired: DesiredAttachment,
): CachedTerminalView {
  view.summary = desired.summary
  view.callbacks = desired.callbacks
  view.attached = true

  for (const other of views.values()) {
    if (other.terminalId !== view.terminalId && other.attached) {
      detachTerminalView(other.terminalId)
    }
  }

  if (view.hostElement.parentElement !== desired.slot) {
    desired.slot.replaceChildren(view.hostElement)
  }

  if (!view.subscriptionId) {
    void startSubscribedSync(view, true)
  } else if (view.inputReady) {
    view.callbacks.onInputReady?.()
  }

  return view
}

async function createAndAttachView(
  terminalId: string,
  platform?: string,
): Promise<CachedTerminalView | undefined> {
  const existingCreation = inFlightCreations.get(terminalId)
  if (existingCreation) {
    const view = await existingCreation
    const latestDesired = desiredAttachments.get(terminalId)
    if (view && latestDesired && latestDesired.slot.isConnected) {
      return attachExistingView(view, latestDesired)
    }
    return view
  }

  const creationPromise = (async (): Promise<CachedTerminalView | undefined> => {
    const { Terminal: XtermCtor, FitAddon: FitAddonCtor } = await loadXtermRuntime()
    const latestDesired = desiredAttachments.get(terminalId)
    if (!latestDesired || !latestDesired.slot.isConnected) {
      return undefined
    }

    ensureGlobalOutputSubscription()
    ensureThemeWatcher()

    const existing = views.get(terminalId)
    if (existing) {
      return attachExistingView(existing, latestDesired)
    }

    const summary = latestDesired.summary
    const hostElement = document.createElement('div')
    hostElement.className = 'pact-terminal-slot'
    const style = getComputedStyle(document.documentElement)
    const fontFamily =
      style.getPropertyValue('--pact-font-mono').trim() ||
      "'JetBrains Mono Variable', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace"

    const term = new XtermCtor({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'bar',
      fontFamily,
      fontSize: 13,
      lineHeight: 1.42,
      scrollback: 2000,
      cols: summary.cols,
      rows: summary.rows,
      theme: readComputedXtermTheme(),
    })
    const fitAddon = new FitAddonCtor()
    term.loadAddon(fitAddon)

    const da1 = term.parser.registerCsiHandler({ final: 'c' }, () => true)
    const da2 = term.parser.registerCsiHandler({ prefix: '>', final: 'c' }, () => true)
    const dsr = term.parser.registerCsiHandler({ final: 'n' }, () => true)

    const cached: CachedTerminalView = {
      terminalId: summary.id,
      projectId: summary.projectId,
      hostElement,
      term,
      fitAddon,
      summary,
      appliedSeq: 0,
      lastCols: summary.cols,
      lastRows: summary.rows,
      inputReady: false,
      attached: false,
      syncEpoch: 0,
      bufferedLiveEvents: [],
      activeDisposables: [() => da1.dispose(), () => da2.dispose(), () => dsr.dispose()],
      activeInputChain: Promise.resolve(),
      pendingAckSeq: 0,
      pendingAckBytes: 0,
      callbacks: latestDesired.callbacks,
    }

    installKeyHandler(cached, latestDesired.platform ?? platform)
    term.open(hostElement)

    const onDataSub = term.onData((data) => {
      if (data) {
        clearSelectionWithDom(cached)
      }
      sendTerminalInput(cached, data)
    })
    const onNativeCopy = (): void => {
      queueMicrotask(() => {
        if (views.has(summary.id)) {
          clearSelectionWithDom(cached)
        }
      })
    }
    const onNativePaste = (): void => {
      clearSelectionWithDom(cached)
    }
    const onMouseDown = (): void => {
      cancelSelectionCleanupFrame(cached)
    }
    hostElement.addEventListener('copy', onNativeCopy)
    hostElement.addEventListener('paste', onNativePaste)
    hostElement.addEventListener('mousedown', onMouseDown)
    cached.activeDisposables.push(
      () => onDataSub.dispose(),
      () => hostElement.removeEventListener('copy', onNativeCopy),
      () => hostElement.removeEventListener('paste', onNativePaste),
      () => hostElement.removeEventListener('mousedown', onMouseDown),
    )

    views.set(summary.id, cached)
    const currentDesired = desiredAttachments.get(summary.id)
    if (currentDesired && currentDesired.slot.isConnected) {
      return attachExistingView(cached, currentDesired)
    }
    return cached
  })().finally(() => {
    if (inFlightCreations.get(terminalId) === creationPromise) {
      inFlightCreations.delete(terminalId)
    }
  })

  inFlightCreations.set(terminalId, creationPromise)
  return creationPromise
}

export function attachTerminalViewToSlot(
  summary: TerminalSummary,
  slotElement: HTMLDivElement | null,
  platform?: string,
  callbacks: TerminalViewCallbacks = {},
): void {
  if (!slotElement) return
  const desired: DesiredAttachment = {
    slot: slotElement,
    summary,
    platform,
    callbacks,
  }
  desiredAttachments.set(summary.id, desired)

  const existing = views.get(summary.id)
  if (existing) {
    attachExistingView(existing, desired)
    return
  }

  void createAndAttachView(summary.id, platform).catch((error) => {
    callbacks.onInputError?.(
      error instanceof Error ? error.message : 'Failed to initialize terminal display.',
    )
  })
}

export function detachTerminalView(terminalId: string): void {
  desiredAttachments.delete(terminalId)
  const view = views.get(terminalId)
  if (!view) return
  view.attached = false
  view.inputReady = false
  view.syncEpoch += 1
  view.bufferedLiveEvents = []
  flushAckNow(view)
  const subId = view.subscriptionId
  view.subscriptionId = undefined
  if (subId) {
    void window.pact.unsubscribeTerminal({ subscriptionId: subId }).catch(() => undefined)
  }
}

export function updateCachedTerminalSummary(summary: TerminalSummary): void {
  const desired = desiredAttachments.get(summary.id)
  if (desired) {
    desired.summary = summary
  }
  const view = views.get(summary.id)
  if (view) {
    const prevState = view.summary.state
    view.summary = summary
    if (
      view.attached &&
      summary.state === 'running' &&
      (prevState !== 'running' ||
        view.term.cols !== summary.cols ||
        view.term.rows !== summary.rows)
    ) {
      fitAndResizeTerminalView(summary.id)
    }
  }
}

export function fitAndResizeTerminalView(terminalId: string): void {
  const view = views.get(terminalId)
  if (!view || !view.hostElement.isConnected) return
  if (view.hostElement.offsetWidth <= 0 || view.hostElement.offsetHeight <= 0) return
  try {
    view.fitAddon.fit()
  } catch {
    return
  }
  if (
    !view.term.hasSelection() &&
    (view.hostElement.querySelector('.xterm-selection')?.childElementCount ?? 0) > 0
  ) {
    resetXtermSelectionRenderModel(view)
  }
  const cols = view.term.cols
  const rows = view.term.rows
  if (
    cols >= 2 &&
    rows >= 1 &&
    (cols !== view.lastCols ||
      rows !== view.lastRows ||
      cols !== view.summary.cols ||
      rows !== view.summary.rows)
  ) {
    view.lastCols = cols
    view.lastRows = rows
    void window.pact
      .resizeTerminal({ terminalId, cols, rows })
      .then((res) => {
        if (views.get(terminalId) !== view) return undefined
        if (!res.ok) {
          view.lastCols = view.summary.cols
          view.lastRows = view.summary.rows
        } else if (view.summary.cols !== cols || view.summary.rows !== rows) {
          view.summary = { ...view.summary, cols, rows }
        }
        return undefined
      })
      .catch(() => {
        if (views.get(terminalId) === view) {
          view.lastCols = view.summary.cols
          view.lastRows = view.summary.rows
        }
      })
  }
}

export function focusTerminalView(terminalId: string): void {
  const view = views.get(terminalId)
  if (!view || !view.hostElement.isConnected) return
  view.term.focus()
}

export function disposeTerminalView(terminalId: string): void {
  desiredAttachments.delete(terminalId)
  const view = views.get(terminalId)
  if (!view) return
  view.syncEpoch += 1
  flushAckNow(view)
  cancelSelectionCleanupFrame(view)
  const subId = view.subscriptionId
  view.subscriptionId = undefined
  if (subId) {
    void window.pact.unsubscribeTerminal({ subscriptionId: subId }).catch(() => undefined)
  }
  views.delete(terminalId)
  for (const dispose of view.activeDisposables) dispose()
  view.term.dispose()
  view.hostElement.remove()
}

export function disposeProjectTerminalViews(projectId: string): void {
  for (const [id, desired] of desiredAttachments) {
    if (desired.summary.projectId === projectId) {
      desiredAttachments.delete(id)
    }
  }
  for (const [id, view] of views) {
    if (view.projectId === projectId) {
      disposeTerminalView(id)
    }
  }
}
