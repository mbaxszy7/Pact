import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import type { ProjectCatalogRepository } from '@pact/persistence'

import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_OUTPUT_CHUNK_BYTES,
  MAX_TERMINAL_ROWS,
  MAX_TERMINALS_PER_PROJECT,
  MAX_TOTAL_TERMINALS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
  TERMINAL_FLOW_HIGH_WATERMARK_BYTES,
  TERMINAL_FLOW_LOW_WATERMARK_BYTES,
  TERMINAL_STARTUP_DEADLINE_MS,
  type RpcResult,
  type TerminalCloseInput,
  type TerminalCloseResult,
  type TerminalCreateInput,
  type TerminalInputModes,
  type TerminalListInput,
  type TerminalListResult,
  type TerminalOutputEvent,
  type TerminalQuitSummaryRow,
  type TerminalResizeInput,
  type TerminalSnapshotInput,
  type TerminalSnapshotResult,
  type TerminalStateEvent,
  type TerminalSummary,
  type TerminalVisibilityInput,
  type TerminalWriteInput,
} from '@pact/contracts'

import type { TerminalWorkerMessage, TerminalWorkerRequest } from './terminal-worker'

import { recordDiagnostic } from '../../diagnostics/utility-log'
import {
  observeWorkerTraffic,
  type LogicalIpcTrafficCollector,
} from '../../shared/logical-ipc-traffic'
import {
  resolveTerminalHelperExecutable,
  resolveUserShell,
  TerminalHelperClient,
} from './terminal-helper-client'

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const WORKER_REQUEST_TIMEOUT_MS = 4_000
const CREATE_DEDUPE_TTL_MS = 30_000
const MAX_RECENT_CREATES = 32
const MAX_IN_FLIGHT_FEEDS_PER_TERMINAL = 2
const MAX_INPUT_STREAMS_PER_TERMINAL = 32

interface QueuedOutputSlice {
  data: string
  utf8Bytes: number
}

interface ManagedTerminalEntry {
  summary: TerminalSummary
  helper: TerminalHelperClient
  startupPromise?: Promise<void> | undefined
  startupAbort?: AbortController | undefined
  closingPromise?: Promise<boolean> | undefined
  visible: boolean
  rendererRetained: boolean
  rendererBackpressurePaused: boolean
  pendingOutputQueue: QueuedOutputSlice[]
  queuedOutputBytes: number
  inFlightFeedCount: number
  inFlightFeedBytes: number
  inputStreams: Map<string, number>
  workerCreated: boolean
  workerFaulted: boolean
  memoryExceeded: boolean
  suppressOutputPump?: boolean | undefined
}

export interface TerminalManagerOptions {
  projectCatalog: ProjectCatalogRepository
  helperExecutablePath?: string | undefined
  traffic?: LogicalIpcTrafficCollector | undefined
  onOutputEvent: (event: TerminalOutputEvent) => void
  onStateEvent: (event: TerminalStateEvent) => void
  isQuitSealed: () => boolean
}

export interface TerminalDisposeSummary {
  unconfirmedCount: number
}

function isBlockingState(summary: TerminalSummary): boolean {
  if (
    summary.state === 'starting' ||
    summary.state === 'running' ||
    summary.state === 'closing' ||
    summary.state === 'unconfirmed'
  ) {
    return true
  }
  return summary.state === 'exited' && summary.hasActiveChild
}

function toQuitSummaryRow(summary: TerminalSummary): TerminalQuitSummaryRow {
  return {
    terminalId: summary.id,
    projectId: summary.projectId,
    title: summary.title,
    state: summary.state,
    hasActiveChild: summary.hasActiveChild,
    foregroundCommand: summary.foregroundCommand ?? null,
  }
}

function chunkUtf16ByUtf8Limit(text: string, maxUtf8Bytes: number): QueuedOutputSlice[] {
  if (!text) return []
  const totalBytes = Buffer.byteLength(text, 'utf8')
  if (totalBytes <= maxUtf8Bytes) {
    return [{ data: text, utf8Bytes: totalBytes }]
  }
  const result: QueuedOutputSlice[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(text.length, start + Math.max(1, maxUtf8Bytes))
    if (end < text.length) {
      const prev = text.charCodeAt(end - 1)
      const curr = text.charCodeAt(end)
      if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff && end > start + 1) {
        end -= 1
      }
    }
    let slice = text.slice(start, end)
    let bytes = Buffer.byteLength(slice, 'utf8')
    while (bytes > maxUtf8Bytes && end > start + 1) {
      end = Math.max(start + 1, start + Math.floor(((end - start) * maxUtf8Bytes) / bytes))
      const prev = text.charCodeAt(end - 1)
      const curr = text.charCodeAt(end)
      if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff && end > start + 1) {
        end -= 1
      }
      slice = text.slice(start, end)
      bytes = Buffer.byteLength(slice, 'utf8')
    }
    result.push({ data: slice, utf8Bytes: bytes })
    start = end
  }
  return result
}

/**
 * Utility-process owner for integrated project PTY terminals and their single shared
 * `@xterm/headless` worker thread.
 */
export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminalEntry>()
  private readonly activeByProject = new Map<string, string>()
  private readonly projectArchiveLockCounts = new Map<string, number>()
  private readonly recentCreates = new Map<
    string,
    { projectId: string; promise: Promise<RpcResult<TerminalSummary>>; expiresAt: number }
  >()
  private worker: Worker | undefined
  private workerClosingPromise: Promise<void> | undefined
  private workerRecoveryPromise: Promise<void> | undefined
  private workerRequestSeq = 0
  private readonly pendingWorkerRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (reason: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private disposed = false

  constructor(private readonly options: TerminalManagerOptions) {}

  list(input: TerminalListInput): RpcResult<TerminalListResult> {
    if (this.disposed) {
      return {
        ok: false,
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'Pact is shutting down.' },
      }
    }
    const projectTerminals = [...this.terminals.values()]
      .filter((entry) => entry.summary.projectId === input.projectId)
      .toSorted((a, b) => a.summary.index - b.summary.index)
      .map((entry) => entry.summary)

    const recordedActive = this.activeByProject.get(input.projectId)
    const activeTerminalId =
      recordedActive && projectTerminals.some((item) => item.id === recordedActive)
        ? recordedActive
        : (projectTerminals[0]?.id ?? null)

    return {
      ok: true,
      value: {
        projectId: input.projectId,
        terminals: projectTerminals,
        activeTerminalId,
      },
    }
  }

  create(input: TerminalCreateInput): Promise<RpcResult<TerminalSummary>> {
    this.pruneRecentCreates()
    const dedupeKey = `${input.projectId}:${input.requestId}`
    const existingRequest = this.recentCreates.get(dedupeKey)
    if (existingRequest) {
      return existingRequest.promise
    }

    const work = this.createInternal(input)
    if (this.recentCreates.size >= MAX_RECENT_CREATES) {
      const oldestKey = this.recentCreates.keys().next().value
      if (oldestKey !== undefined) this.recentCreates.delete(oldestKey)
    }
    this.recentCreates.set(dedupeKey, {
      projectId: input.projectId,
      promise: work,
      expiresAt: Date.now() + CREATE_DEDUPE_TTL_MS,
    })
    return work
  }

  private createInternal(input: TerminalCreateInput): Promise<RpcResult<TerminalSummary>> {
    if (this.disposed || this.options.isQuitSealed()) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Pact is preparing to exit. Cancel Exit before opening Terminal.',
        },
      })
    }
    if (this.isProjectArchiveLocked(input.projectId)) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'WORKSPACE_BUSY',
          message: 'This Project is being archived. Wait until archiving settles.',
        },
      })
    }

    const project = this.options.projectCatalog.find(input.projectId)
    if (!project || project.archivedAt) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'CONTEXT_UNAVAILABLE',
          message: 'Select an active Project before opening Terminal.',
        },
      })
    }

    if (this.terminals.size >= MAX_TOTAL_TERMINALS) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'AGENT_CAPACITY',
          message: `You can keep up to ${MAX_TOTAL_TERMINALS} terminals open across Pact.`,
        },
      })
    }
    const existingForProject = [...this.terminals.values()].filter(
      (entry) => entry.summary.projectId === input.projectId,
    )
    if (existingForProject.length >= MAX_TERMINALS_PER_PROJECT) {
      return Promise.resolve({
        ok: false,
        error: {
          code: 'VALIDATION',
          message: `You can keep up to ${MAX_TERMINALS_PER_PROJECT} terminals open per Project.`,
        },
      })
    }

    const usedIndices = new Set(existingForProject.map((item) => item.summary.index))
    let index = 1
    while (usedIndices.has(index) && index <= MAX_TOTAL_TERMINALS) index += 1

    const terminalId = randomUUID()
    const cols = clampInt(input.cols ?? DEFAULT_COLS, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    const rows = clampInt(input.rows ?? DEFAULT_ROWS, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    const defaultTitle = input.title?.trim() || `Terminal ${index}`

    const summary: TerminalSummary = {
      id: terminalId,
      projectId: input.projectId,
      index,
      title: defaultTitle,
      shell: process.platform === 'win32' ? 'powershell.exe' : 'zsh',
      cwd: project.directoryPath,
      state: 'starting',
      hasActiveChild: false,
      childCount: 0,
      foregroundCommand: null,
      exitCode: null,
      exitSignal: null,
      cols,
      rows,
      seq: 0,
      inputEpoch: 1,
      inputModes: { bracketedPaste: false, applicationCursor: false },
    }

    const helper = new TerminalHelperClient({
      onReady: (info) => {
        const entry = this.terminals.get(terminalId)
        if (!entry || entry.closingPromise || entry.summary.state === 'closing') return
        entry.summary = {
          ...entry.summary,
          shell: basename(info.shell) || entry.summary.shell,
          state: 'running',
        }
        this.emitStateUpsert(entry.summary)
      },
      onOutput: (chunk) => {
        const entry = this.terminals.get(terminalId)
        if (!entry || entry.memoryExceeded || entry.suppressOutputPump) return
        for (const piece of chunkUtf16ByUtf8Limit(chunk, MAX_TERMINAL_OUTPUT_CHUNK_BYTES)) {
          entry.pendingOutputQueue.push(piece)
          entry.queuedOutputBytes += piece.utf8Bytes
        }
        this.updateHelperBackpressure(entry)
        this.pumpWorkerFeed(entry)
      },
      onActivity: (activity) => {
        const entry = this.terminals.get(terminalId)
        if (!entry) return
        entry.summary = {
          ...entry.summary,
          hasActiveChild: activity.hasActiveChild,
          childCount: activity.childCount,
          foregroundCommand: activity.foregroundCommand,
        }
        this.emitStateUpsert(entry.summary)
      },
      onShellExited: (shellExit) => {
        const entry = this.terminals.get(terminalId)
        if (!entry || entry.summary.state === 'closing') return
        entry.summary = {
          ...entry.summary,
          state: 'exited',
          exitCode: shellExit.exitCode,
          exitSignal: shellExit.signal,
        }
        this.emitStateUpsert(entry.summary)
        entry.helper.requestActivityPing()
      },
      onExit: (exit) => {
        const entry = this.terminals.get(terminalId)
        if (!entry) return
        if (entry.closingPromise || entry.summary.state === 'closing') {
          return
        }
        if (exit.cleanupConfirmed) {
          entry.summary = {
            ...entry.summary,
            state: 'exited',
            hasActiveChild: false,
            childCount: 0,
            foregroundCommand: null,
            ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
            ...(exit.signal !== null ? { exitSignal: exit.signal } : {}),
          }
          this.emitStateUpsert(entry.summary)
          recordDiagnostic({
            operation: 'process',
            phase: 'closed',
            ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
          })
        } else {
          entry.summary = {
            ...entry.summary,
            state: 'unconfirmed',
            errorMessage: 'Terminal process cleanup could not be confirmed.',
            ...(exit.exitCode !== null ? { exitCode: exit.exitCode } : {}),
            ...(exit.signal !== null ? { exitSignal: exit.signal } : {}),
          }
          this.emitStateUpsert(entry.summary)
        }
      },
      onError: (message) => {
        const entry = this.terminals.get(terminalId)
        if (!entry) return
        entry.summary = {
          ...entry.summary,
          state: entry.summary.state === 'closing' ? 'unconfirmed' : 'error',
          errorMessage: message.slice(0, 500),
        }
        this.emitStateUpsert(entry.summary)
      },
    })

    const startupAbort = new AbortController()
    const entry: ManagedTerminalEntry = {
      summary,
      helper,
      startupAbort,
      visible: false,
      rendererRetained: true,
      rendererBackpressurePaused: false,
      pendingOutputQueue: [],
      queuedOutputBytes: 0,
      inFlightFeedCount: 0,
      inFlightFeedBytes: 0,
      inputStreams: new Map(),
      workerCreated: false,
      workerFaulted: false,
      memoryExceeded: false,
    }

    // Reserve instance & capacity synchronously BEFORE any await.
    this.terminals.set(terminalId, entry)
    this.activeByProject.set(input.projectId, terminalId)
    this.emitStateUpsert(entry.summary)

    let creationOutcomeError: AppErrorPayload | undefined
    const startupWork = (async () => {
      const deadlineAt = Date.now() + TERMINAL_STARTUP_DEADLINE_MS
      const checkStillAdmitted = (): void => {
        if (
          startupAbort.signal.aborted ||
          entry.closingPromise ||
          entry.summary.state === 'closing'
        ) {
          throw new Error('Terminal creation was cancelled.')
        }
        if (this.disposed || this.options.isQuitSealed()) {
          throw new Error('Pact is shutting down.')
        }
        if (this.isProjectArchiveLocked(input.projectId)) {
          throw new Error('This Project is being archived.')
        }
        const liveProject = this.options.projectCatalog.find(input.projectId)
        if (!liveProject || liveProject.archivedAt) {
          throw new Error('This Project is no longer active.')
        }
        if (Date.now() >= deadlineAt) {
          throw new Error('Terminal startup exceeded its 5 second deadline.')
        }
      }

      const canonicalDir = await realpath(project.directoryPath)
      const dirStat = await stat(canonicalDir)
      if (!dirStat.isDirectory() || canonicalDir !== project.directoryPath) {
        throw new Error('Project directory is invalid or changed.')
      }
      checkStillAdmitted()

      const [helperExecutable, shellSpec] = await Promise.all([
        resolveTerminalHelperExecutable(this.options.helperExecutablePath),
        resolveUserShell(),
      ])
      checkStillAdmitted()

      entry.summary = {
        ...entry.summary,
        shell: basename(shellSpec.executable) || entry.summary.shell,
        cwd: canonicalDir,
      }

      const workerCols = entry.summary.cols
      const workerRows = entry.summary.rows
      await this.requestWorker('create', {
        type: 'create',
        terminalId,
        projectId: input.projectId,
        cols: workerCols,
        rows: workerRows,
        visible: entry.visible,
        rendererRetained: entry.rendererRetained,
      })
      entry.workerCreated = true
      checkStillAdmitted()

      if (entry.summary.cols !== workerCols || entry.summary.rows !== workerRows) {
        await this.requestWorker('resize', {
          type: 'resize',
          terminalId,
          cols: entry.summary.cols,
          rows: entry.summary.rows,
        })
        checkStillAdmitted()
      }

      const helperCols = entry.summary.cols
      const helperRows = entry.summary.rows
      await helper.start({
        helperExecutable,
        shellExecutable: shellSpec.executable,
        login: shellSpec.login,
        cwd: canonicalDir,
        cols: helperCols,
        rows: helperRows,
      })
      if (entry.summary.cols !== helperCols || entry.summary.rows !== helperRows) {
        entry.helper.resize(entry.summary.cols, entry.summary.rows)
      }
      recordDiagnostic({ operation: 'process', phase: 'started' })
    })().catch((error: unknown) => {
      creationOutcomeError = {
        code: this.isProjectArchiveLocked(input.projectId)
          ? 'WORKSPACE_BUSY'
          : 'RUNTIME_UNAVAILABLE',
        message: error instanceof Error ? error.message : 'Failed to start terminal session.',
      }
      throw error
    })

    entry.startupPromise = startupWork.catch(() => undefined)

    return startupWork.then(
      () => ({ ok: true, value: entry.summary }),
      async () => {
        // Only release reservation on self-failure when close/shutdown didn't already claim it.
        if (!entry.closingPromise && entry.summary.state !== 'closing') {
          await helper.shutdown({ force: true, deadlineMs: 500 }).catch(() => undefined)
          if (this.terminals.get(terminalId) === entry) {
            this.removeEntryFromRegistry(entry, 'closed')
            await this.requestWorker('destroy', { type: 'destroy', terminalId }).catch(
              () => undefined,
            )
            await this.terminateWorkerIfIdle()
          }
        }
        return {
          ok: false,
          error: creationOutcomeError ?? {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'Failed to start terminal session.',
          },
        }
      },
    )
  }

  async setVisibility(input: TerminalVisibilityInput): Promise<RpcResult<{ updated: true }>> {
    const entry = this.terminals.get(input.terminalId)
    if (!entry) {
      return { ok: true, value: { updated: true } }
    }
    entry.visible = input.visible
    if (input.rendererRetained !== undefined) {
      entry.rendererRetained = input.rendererRetained
    }
    if (!input.visible) {
      entry.rendererBackpressurePaused = false
    } else if (input.backpressurePaused !== undefined) {
      entry.rendererBackpressurePaused = input.backpressurePaused
    }
    this.updateHelperBackpressure(entry)
    await this.requestWorker('set-visibility', {
      type: 'set-visibility',
      terminalId: input.terminalId,
      visible: entry.visible,
      rendererRetained: entry.rendererRetained,
    }).catch(() => undefined)
    return { ok: true, value: { updated: true } }
  }

  async releaseProjectRendererViews(projectId: string): Promise<void> {
    const projectEntries = [...this.terminals.values()].filter(
      (entry) => entry.summary.projectId === projectId,
    )
    await Promise.all(
      projectEntries.map(async (entry) => {
        entry.visible = false
        entry.rendererRetained = false
        entry.rendererBackpressurePaused = false
        this.updateHelperBackpressure(entry)
        await this.requestWorker('set-visibility', {
          type: 'set-visibility',
          terminalId: entry.summary.id,
          visible: false,
          rendererRetained: false,
        }).catch(() => undefined)
      }),
    )
  }

  write(input: TerminalWriteInput): RpcResult<{ written: true; acceptedSeq: number }> {
    const entry = this.terminals.get(input.terminalId)
    if (!entry) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Terminal session was not found.' },
      }
    }
    if (this.disposed || this.options.isQuitSealed()) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Pact is exiting; terminal input is closed.' },
      }
    }
    if (entry.summary.state !== 'running') {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Terminal session is not accepting input.' },
      }
    }
    if (entry.workerFaulted || entry.memoryExceeded) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Terminal session is unavailable after an error.' },
      }
    }
    if (input.expectedEpoch !== entry.summary.inputEpoch) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Terminal state changed; resync before typing.',
        },
      }
    }
    const expectedSeq = entry.inputStreams.get(input.streamId) ?? 0
    if (input.chunkSeq !== expectedSeq) {
      return {
        ok: false,
        error: {
          code: 'CONFLICT',
          message: 'Out-of-order terminal input chunk rejected to preserve order.',
        },
      }
    }
    const written = entry.helper.writeInput(input.data)
    if (!written) {
      return {
        ok: false,
        error: {
          code: 'RUNTIME_UNAVAILABLE',
          message: 'Terminal process pipe is unavailable; input was not written.',
        },
      }
    }
    if (
      !entry.inputStreams.has(input.streamId) &&
      entry.inputStreams.size >= MAX_INPUT_STREAMS_PER_TERMINAL
    ) {
      const oldest = entry.inputStreams.keys().next().value
      if (oldest !== undefined) entry.inputStreams.delete(oldest)
    }
    entry.inputStreams.set(input.streamId, input.chunkSeq + 1)
    this.activeByProject.set(entry.summary.projectId, entry.summary.id)
    return { ok: true, value: { written: true, acceptedSeq: input.chunkSeq } }
  }

  async resize(input: TerminalResizeInput): Promise<RpcResult<{ resized: true }>> {
    const entry = this.terminals.get(input.terminalId)
    if (!entry) {
      return {
        ok: false,
        error: { code: 'CONFLICT', message: 'Terminal session was not found.' },
      }
    }
    const cols = clampInt(input.cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS)
    const rows = clampInt(input.rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS)
    entry.summary = { ...entry.summary, cols, rows }
    entry.helper.resize(cols, rows)
    if (!entry.workerCreated) {
      return { ok: true, value: { resized: true } }
    }
    try {
      await this.requestWorker('resize', {
        type: 'resize',
        terminalId: input.terminalId,
        cols,
        rows,
      })
      return { ok: true, value: { resized: true } }
    } catch {
      return {
        ok: false,
        error: { code: 'INTERNAL', message: 'Failed to resize terminal buffer.' },
      }
    }
  }

  async close(input: TerminalCloseInput): Promise<RpcResult<TerminalCloseResult>> {
    const entry = this.terminals.get(input.terminalId)
    if (!entry) {
      return { ok: true, value: { terminalId: input.terminalId, closed: true } }
    }

    const needsConfirm =
      entry.summary.state === 'starting' ||
      entry.summary.state === 'unconfirmed' ||
      ((entry.summary.state === 'running' || entry.summary.state === 'exited') &&
        entry.summary.hasActiveChild)
    if (!input.force && needsConfirm) {
      return {
        ok: true,
        value: {
          terminalId: input.terminalId,
          closed: false,
          confirmationRequired: true,
          hasActiveChild: entry.summary.hasActiveChild,
          foregroundCommand: entry.summary.foregroundCommand ?? null,
        },
      }
    }

    const confirmed = await this.shutdownEntry(entry, {
      force: false,
      graceMs: 2_000,
      deadlineMs: 3_800,
      reason: 'closed',
    })
    if (!confirmed) {
      return {
        ok: false,
        error: {
          code: 'UNCERTAIN',
          message: 'Terminal subprocess cleanup could not be confirmed yet.',
        },
      }
    }
    return { ok: true, value: { terminalId: input.terminalId, closed: true } }
  }

  async readSnapshot(input: TerminalSnapshotInput): Promise<RpcResult<TerminalSnapshotResult>> {
    const entry = this.terminals.get(input.terminalId)
    if (!entry) {
      return {
        ok: false,
        error: { code: 'CONTEXT_UNAVAILABLE', message: 'Terminal session was not found.' },
      }
    }
    try {
      const rawReply = await this.requestWorker('snapshot', {
        type: 'snapshot',
        terminalId: input.terminalId,
        ...(input.fromSeq !== undefined ? { fromSeq: input.fromSeq } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.pinnedVersion !== undefined ? { pinnedVersion: input.pinnedVersion } : {}),
      })
      const result = parseWorkerSnapshotReply(rawReply, entry.summary)
      if (!result) {
        return {
          ok: false,
          error: { code: 'INTERNAL', message: 'Invalid terminal worker snapshot response.' },
        }
      }
      entry.summary = result.terminal
      return { ok: true, value: result }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : 'Could not read terminal scrollback.',
        },
      }
    }
  }

  listBlockingProjectSummaries(projectId: string): TerminalQuitSummaryRow[] {
    return [...this.terminals.values()]
      .filter((entry) => entry.summary.projectId === projectId && isBlockingState(entry.summary))
      .slice(0, MAX_TOTAL_TERMINALS)
      .map((entry) => toQuitSummaryRow(entry.summary))
  }

  acquireProjectArchiveLock(projectId: string): () => void {
    const current = this.projectArchiveLockCounts.get(projectId) ?? 0
    this.projectArchiveLockCounts.set(projectId, current + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const nowCount = this.projectArchiveLockCounts.get(projectId) ?? 0
      if (nowCount <= 1) this.projectArchiveLockCounts.delete(projectId)
      else this.projectArchiveLockCounts.set(projectId, nowCount - 1)
    }
  }

  async releaseIdleProjectTerminals(projectId: string): Promise<void> {
    const idleExited = [...this.terminals.values()].filter(
      (entry) =>
        entry.summary.projectId === projectId &&
        entry.summary.state === 'exited' &&
        !entry.summary.hasActiveChild,
    )
    await Promise.all(
      idleExited.map((entry) =>
        this.shutdownEntry(entry, {
          force: true,
          deadlineMs: 500,
          reason: 'exited_cleaned',
        }).catch(() => undefined),
      ),
    )
  }

  async dispose(flushDeadlineAt?: number): Promise<TerminalDisposeSummary> {
    if (this.disposed) {
      return { unconfirmedCount: 0 }
    }
    this.disposed = true
    const deadlineAt = flushDeadlineAt ?? Date.now() + 4_000
    const entries = [...this.terminals.values()]

    const outcomes = await Promise.all(
      entries.map(async (entry) => {
        const remainingMs = Math.max(400, deadlineAt - Date.now())
        const graceMs = Math.min(2_000, Math.max(0, remainingMs - 800))
        const confirmed = await this.shutdownEntry(entry, {
          force: false,
          graceMs,
          deadlineMs: remainingMs,
          reason: 'exited_cleaned',
        })
        return { entry, confirmed }
      }),
    )

    const unconfirmedCount = outcomes.filter((item) => !item.confirmed).length

    await this.terminateWorkerNow()
    return { unconfirmedCount }
  }

  private isProjectArchiveLocked(projectId: string): boolean {
    return (this.projectArchiveLockCounts.get(projectId) ?? 0) > 0
  }

  private pruneRecentCreates(): void {
    const now = Date.now()
    for (const [key, item] of this.recentCreates) {
      if (item.expiresAt <= now) this.recentCreates.delete(key)
    }
  }

  private removeEntryFromRegistry(
    entry: ManagedTerminalEntry,
    reason: 'closed' | 'exited_cleaned',
  ): void {
    this.terminals.delete(entry.summary.id)
    if (this.activeByProject.get(entry.summary.projectId) === entry.summary.id) {
      const next = [...this.terminals.values()].find(
        (item) => item.summary.projectId === entry.summary.projectId,
      )
      if (next) this.activeByProject.set(entry.summary.projectId, next.summary.id)
      else this.activeByProject.delete(entry.summary.projectId)
    }
    this.options.onStateEvent({
      kind: 'removed',
      terminalId: entry.summary.id,
      projectId: entry.summary.projectId,
      reason,
    })
  }

  private async shutdownEntry(
    entry: ManagedTerminalEntry,
    options: {
      force?: boolean
      graceMs?: number
      deadlineMs?: number
      reason?: 'closed' | 'exited_cleaned'
    },
  ): Promise<boolean> {
    if (entry.closingPromise) return entry.closingPromise
    const promise = (async () => {
      entry.summary = {
        ...entry.summary,
        state: 'closing',
      }
      this.emitStateUpsert(entry.summary)
      entry.startupAbort?.abort()
      if (entry.startupPromise) {
        await Promise.race([
          entry.startupPromise,
          new Promise<void>((resolveWait) => setTimeout(resolveWait, 300)),
        ])
      }
      const exit = await entry.helper.shutdown({
        ...(options.force !== undefined ? { force: options.force } : {}),
        ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
        ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
      })
      if (!exit.cleanupConfirmed) {
        entry.summary = {
          ...entry.summary,
          state: 'unconfirmed',
          errorMessage: 'Terminal process cleanup could not be confirmed yet.',
        }
        this.emitStateUpsert(entry.summary)
        return false
      }
      this.removeEntryFromRegistry(entry, options.reason ?? 'closed')
      await this.requestWorker('destroy', {
        type: 'destroy',
        terminalId: entry.summary.id,
      }).catch(() => undefined)
      await this.terminateWorkerIfIdle()
      return true
    })().finally(() => {
      entry.closingPromise = undefined
    })
    entry.closingPromise = promise
    return promise
  }

  private updateHelperBackpressure(entry: ManagedTerminalEntry): void {
    if (entry.memoryExceeded || entry.workerFaulted) {
      entry.helper.pauseOutput()
      return
    }
    const pendingWorkerBytes = entry.queuedOutputBytes + entry.inFlightFeedBytes
    const rendererPressurePaused = entry.visible && entry.rendererBackpressurePaused
    if (pendingWorkerBytes >= TERMINAL_FLOW_HIGH_WATERMARK_BYTES || rendererPressurePaused) {
      entry.helper.pauseOutput()
      return
    }
    if (pendingWorkerBytes <= TERMINAL_FLOW_LOW_WATERMARK_BYTES && !rendererPressurePaused) {
      entry.helper.resumeOutput()
    }
  }

  private pumpWorkerFeed(entry: ManagedTerminalEntry): void {
    while (
      entry.pendingOutputQueue.length > 0 &&
      entry.inFlightFeedCount < MAX_IN_FLIGHT_FEEDS_PER_TERMINAL &&
      !entry.workerFaulted &&
      !entry.memoryExceeded &&
      !this.disposed
    ) {
      let batchText = ''
      let batchBytes = 0
      while (entry.pendingOutputQueue.length > 0) {
        const next = entry.pendingOutputQueue[0]!
        if (batchBytes > 0 && batchBytes + next.utf8Bytes > MAX_TERMINAL_OUTPUT_CHUNK_BYTES) {
          break
        }
        entry.pendingOutputQueue.shift()
        entry.queuedOutputBytes = Math.max(0, entry.queuedOutputBytes - next.utf8Bytes)
        batchText += next.data
        batchBytes += next.utf8Bytes
        if (batchBytes >= MAX_TERMINAL_OUTPUT_CHUNK_BYTES) break
      }
      if (!batchText) break

      entry.inFlightFeedCount += 1
      entry.inFlightFeedBytes += batchBytes
      this.updateHelperBackpressure(entry)

      void this.requestWorker('feed', {
        type: 'feed',
        terminalId: entry.summary.id,
        data: batchText,
      })
        .then((reply) => {
          const parsed = parseWorkerFeedReply(reply)
          if (parsed) {
            entry.summary = {
              ...entry.summary,
              seq: Math.max(entry.summary.seq, parsed.seq),
              inputModes: parsed.inputModes,
            }
            if (parsed.resourceError) {
              entry.memoryExceeded = true
              entry.summary = {
                ...entry.summary,
                state: 'error',
                errorMessage: parsed.resourceError,
              }
              this.emitStateUpsert(entry.summary)
            }
          }
          return undefined
        })
        .catch(() => {
          // Worker exit recovery is coordinated in handleUnexpectedWorkerExit.
        })
        .finally(() => {
          entry.inFlightFeedCount = Math.max(0, entry.inFlightFeedCount - 1)
          entry.inFlightFeedBytes = Math.max(0, entry.inFlightFeedBytes - batchBytes)
          this.updateHelperBackpressure(entry)
          this.pumpWorkerFeed(entry)
        })
    }
  }

  private emitStateUpsert(summary: TerminalSummary): void {
    this.options.onStateEvent({ kind: 'upsert', terminal: summary })
  }

  private async ensureWorker(): Promise<Worker> {
    if (this.workerClosingPromise) {
      await this.workerClosingPromise
    }
    if (this.worker) return this.worker
    const worker = new Worker(join(__dirname, 'terminal-worker.js'))
    observeWorkerTraffic(
      worker,
      this.options.traffic,
      'utility-terminal.request',
      'terminal-utility.reply',
    )
    worker.on('message', (message: TerminalWorkerMessage) => {
      if (message.type === 'output') {
        for (const chunk of message.chunks) {
          const entry = this.terminals.get(chunk.terminalId)
          if (!entry) continue
          entry.summary = {
            ...entry.summary,
            seq: Math.max(entry.summary.seq, chunk.seq),
            inputModes: chunk.inputModes,
          }
          if (!entry.visible) continue
          this.options.onOutputEvent({
            terminalId: chunk.terminalId,
            projectId: chunk.projectId,
            seq: chunk.seq,
            previousSeq: chunk.previousSeq,
            utf8Bytes: chunk.utf8Bytes,
            data: chunk.data,
          })
        }
        return
      }
      if (message.type === 'query-reply') {
        const entry = this.terminals.get(message.terminalId)
        entry?.helper.writeInput(message.data)
        return
      }
      if (message.type === 'reply') {
        const pending = this.pendingWorkerRequests.get(message.id)
        if (!pending) return
        this.pendingWorkerRequests.delete(message.id)
        clearTimeout(pending.timer)
        if (message.ok) pending.resolve(message.value)
        else pending.reject(new Error(message.error))
      }
    })
    worker.once('exit', () => {
      const wasCurrent = this.worker === worker
      if (wasCurrent) this.worker = undefined
      for (const [id, pending] of this.pendingWorkerRequests) {
        this.pendingWorkerRequests.delete(id)
        clearTimeout(pending.timer)
        pending.reject(new Error('Terminal worker exited unexpectedly.'))
      }
      if (wasCurrent && !this.disposed && this.terminals.size > 0 && !this.workerClosingPromise) {
        this.handleUnexpectedWorkerExit()
      }
    })
    this.worker = worker
    return worker
  }

  private handleUnexpectedWorkerExit(): void {
    const affected = [...this.terminals.values()]
    for (const entry of affected) {
      entry.workerFaulted = true
      entry.helper.pauseOutput()
      entry.summary = {
        ...entry.summary,
        inputEpoch: entry.summary.inputEpoch + 1,
        seq: 0,
      }
      this.emitStateUpsert(entry.summary)
    }

    if (this.workerRecoveryPromise) return
    this.workerRecoveryPromise = (async () => {
      await Promise.all(
        affected.map(async (entry) => {
          if (this.disposed || entry.summary.state === 'closing') return
          try {
            await this.requestWorker('create', {
              type: 'create',
              terminalId: entry.summary.id,
              projectId: entry.summary.projectId,
              cols: entry.summary.cols,
              rows: entry.summary.rows,
              visible: entry.visible,
              rendererRetained: entry.rendererRetained,
            })
            entry.workerFaulted = false
            this.updateHelperBackpressure(entry)
            this.pumpWorkerFeed(entry)
          } catch {
            entry.summary = {
              ...entry.summary,
              state: 'error',
              errorMessage: 'Terminal buffer worker crashed; reopen or close this tab.',
            }
          }
          this.emitStateUpsert(entry.summary)
        }),
      )
    })().finally(() => {
      this.workerRecoveryPromise = undefined
    })
  }

  private async terminateWorkerIfIdle(): Promise<void> {
    if (this.terminals.size === 0 && this.worker) {
      await this.terminateWorkerNow()
    }
  }

  private async terminateWorkerNow(): Promise<void> {
    if (this.workerClosingPromise) {
      await this.workerClosingPromise
      return
    }
    const target = this.worker
    if (!target) return
    this.workerClosingPromise = (async () => {
      this.worker = undefined
      for (const [, pending] of this.pendingWorkerRequests) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Terminal worker shutting down.'))
      }
      this.pendingWorkerRequests.clear()
      await target.terminate().catch(() => undefined)
    })().finally(() => {
      this.workerClosingPromise = undefined
    })
    await this.workerClosingPromise
  }

  private async requestWorker(
    _op: string,
    payload:
      | Omit<Extract<TerminalWorkerRequest, { type: 'create' }>, 'id'>
      | Omit<Extract<TerminalWorkerRequest, { type: 'set-visibility' }>, 'id'>
      | Omit<Extract<TerminalWorkerRequest, { type: 'feed' }>, 'id'>
      | Omit<Extract<TerminalWorkerRequest, { type: 'resize' }>, 'id'>
      | Omit<Extract<TerminalWorkerRequest, { type: 'snapshot' }>, 'id'>
      | Omit<Extract<TerminalWorkerRequest, { type: 'destroy' }>, 'id'>,
  ): Promise<unknown> {
    const worker = await this.ensureWorker()
    const id = ++this.workerRequestSeq
    const packet: TerminalWorkerRequest = { ...payload, id }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingWorkerRequests.delete(id)
        reject(new Error('Terminal worker timed out.'))
      }, WORKER_REQUEST_TIMEOUT_MS)
      this.pendingWorkerRequests.set(id, { resolve, reject, timer })
      try {
        worker.postMessage(packet)
      } catch (error) {
        clearTimeout(timer)
        this.pendingWorkerRequests.delete(id)
        reject(
          error instanceof Error ? error : new Error('Failed to post message to terminal worker.'),
        )
      }
    })
  }
}

interface AppErrorPayload {
  code: 'RUNTIME_UNAVAILABLE' | 'WORKSPACE_BUSY'
  message: string
}

function parseInputModes(raw: unknown): TerminalInputModes | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const bracketedPaste = Reflect.get(raw, 'bracketedPaste')
  const applicationCursor = Reflect.get(raw, 'applicationCursor')
  if (typeof bracketedPaste !== 'boolean' || typeof applicationCursor !== 'boolean') {
    return undefined
  }
  return { bracketedPaste, applicationCursor }
}

function parseWorkerFeedReply(
  raw: unknown,
): { seq: number; inputModes: TerminalInputModes; resourceError?: string | undefined } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const seq = Reflect.get(raw, 'seq')
  const inputModes = parseInputModes(Reflect.get(raw, 'inputModes'))
  const resourceError = Reflect.get(raw, 'resourceError')
  if (typeof seq !== 'number' || !inputModes) return undefined
  return {
    seq,
    inputModes,
    ...(typeof resourceError === 'string' ? { resourceError } : {}),
  }
}

function parseWorkerSnapshotReply(
  raw: unknown,
  currentSummary: TerminalSummary,
): TerminalSnapshotResult | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const kind = Reflect.get(raw, 'kind')
  const inputModes = parseInputModes(Reflect.get(raw, 'inputModes'))
  if (!inputModes) return undefined
  const terminal: TerminalSummary = { ...currentSummary, inputModes }

  if (kind === 'delta') {
    const fromSeq = Reflect.get(raw, 'fromSeq')
    const toSeq = Reflect.get(raw, 'toSeq')
    const rawChunks = Reflect.get(raw, 'chunks')
    if (typeof fromSeq !== 'number' || typeof toSeq !== 'number' || !Array.isArray(rawChunks)) {
      return undefined
    }
    const chunks = rawChunks.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const seq = Reflect.get(item, 'seq')
      const previousSeq = Reflect.get(item, 'previousSeq')
      const data = Reflect.get(item, 'data')
      return typeof seq === 'number' && typeof previousSeq === 'number' && typeof data === 'string'
        ? [{ seq, previousSeq, data }]
        : []
    })
    return { kind: 'delta', terminal, fromSeq, toSeq, chunks }
  }

  if (kind === 'snapshot') {
    const snapshotVersion = Reflect.get(raw, 'snapshotVersion')
    const cols = Reflect.get(raw, 'cols')
    const rows = Reflect.get(raw, 'rows')
    const offset = Reflect.get(raw, 'offset')
    const totalBytes = Reflect.get(raw, 'totalBytes')
    const text = Reflect.get(raw, 'text')
    const nextOffset = Reflect.get(raw, 'nextOffset')
    if (
      typeof snapshotVersion !== 'number' ||
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      typeof offset !== 'number' ||
      typeof totalBytes !== 'number' ||
      typeof text !== 'string' ||
      (nextOffset !== null && typeof nextOffset !== 'number')
    ) {
      return undefined
    }
    return {
      kind: 'snapshot',
      terminal,
      snapshotVersion,
      cols,
      rows,
      offset,
      totalBytes,
      text,
      nextOffset,
      inputModes,
    }
  }

  return undefined
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}
