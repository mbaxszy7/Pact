import { app, ipcMain, Menu, MenuItem, shell, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

import {
  diagnosticPacketSchema,
  diagnosticStatusSchema,
  rendererFaultSchema,
  IPC_CHANNELS,
  LOG_CLOSE_MS,
  LOG_DEBUG_MS,
  LOG_IO_MS,
  LOG_WORKER_ITEMS,
  type DiagnosticEvent,
  type DiagnosticIdentity,
  type DiagnosticPacket,
  type DiagnosticStatus,
} from '@pact/contracts'

import type { RendererTrust } from '../renderer-trust'

import { DiagnosticProducer } from '../../diagnostics/producer'

/** One owner for admission, filesystem isolation, status, Debug and native menu cleanup. */
export class DiagnosticLogs {
  readonly identity: DiagnosticIdentity
  private readonly producer: DiagnosticProducer
  private readonly worker: Worker | undefined
  private readonly pending = new Map<
    string,
    { settle: (written: boolean) => void; startedAt: number }
  >()
  private state: DiagnosticStatus['state'] = 'starting'
  private lost = 0
  private reportedLost = 0
  private busySince = 0
  private debugUntil = 0
  private debugTimer: ReturnType<typeof setTimeout> | undefined
  private readonly watchdog: ReturnType<typeof setInterval>
  private closed: (() => void) | undefined
  private closing = false
  private dead = false
  private readonly debugItems = new Set<MenuItem>()
  private lastFaultAt = 0
  private readonly utilityTargets = new Set<UtilityProcess>()
  private readonly monitor = (_error: unknown, origin: string): void =>
    this.record({
      operation: 'process',
      phase: 'failed',
      level: 'error',
      code: origin === 'unhandledRejection' ? 'UNHANDLED_REJECTION' : 'UNHANDLED_ERROR',
    })

  constructor(
    readonly directory: string,
    private readonly trust: RendererTrust,
  ) {
    const version = app.getVersion().match(/^\d+\.\d+\.\d+/u)?.[0] ?? '0.0.0'
    this.identity = {
      launchId: randomUUID(),
      appVersion: version,
      process: 'main',
      pid: process.pid,
    }
    try {
      this.worker = new Worker(join(__dirname, 'diagnostics/log-worker.js'), {
        workerData: { directory, pid: process.pid },
        resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 },
      })
    } catch {
      this.dead = true
      this.state = 'unavailable'
    }
    this.producer = new DiagnosticProducer(this.identity, (packet) => {
      if (packet.type === 'diagnostic.record')
        this.submit(packet, (written) => this.producer.settle(packet.id, written))
    })
    this.worker?.on('message', (input: unknown) => this.receive(input))
    this.worker?.on('error', () => this.fail())
    this.worker?.on('exit', () => {
      if (!this.closing) this.fail()
    })
    this.watchdog = setInterval(() => {
      const oldest = this.pending.values().next().value
      if (
        (oldest && Date.now() - oldest.startedAt > LOG_IO_MS) ||
        (this.busySince && Date.now() - this.busySince > LOG_IO_MS)
      )
        this.fail()
    }, 1000)
    this.watchdog.unref()
    process.on('uncaughtExceptionMonitor', this.monitor)
    ipcMain.handle(IPC_CHANNELS.diagnosticStatus, (event) => {
      trust.assertTrustedMainFrame(event)
      return this.status()
    })
    ipcMain.on(IPC_CHANNELS.rendererFault, this.rendererFault)
    this.record({ operation: 'app', phase: 'started' })
  }

  createMenuItem(): MenuItem {
    if (this.debugItems.size >= 2) throw new Error('Diagnostics menu capacity exceeded.')
    const debugItem = new MenuItem({
      label: 'Debug logging (30 minutes)',
      type: 'checkbox',
      click: (item) => this.setDebug(item.checked),
    })
    const submenu = new Menu()
    submenu.append(
      new MenuItem({
        label: 'Open log folder',
        click: () => {
          void shell
            .openPath(this.directory)
            .then((error) => {
              if (error) this.unavailable()
              return undefined
            })
            .catch(() => this.unavailable())
        },
      }),
    )
    submenu.append(debugItem)
    this.debugItems.add(debugItem)
    return new MenuItem({ label: 'Diagnostics', submenu })
  }

  record(event: DiagnosticEvent): void {
    this.producer.record(event)
  }

  attachUtility(child: UtilityProcess): void {
    // Existing UtilityClient owns one child; no supervision or business lifecycle here.
    if (this.utilityTargets.size >= 1) return
    this.utilityTargets.add(child)
    child.once('exit', () => this.utilityTargets.delete(child))
    if (this.debugUntil)
      child.postMessage({
        type: 'diagnostic.debug',
        until: this.debugUntil,
      } satisfies DiagnosticPacket)
  }

  acceptUtility(child: UtilityProcess, input: unknown): boolean {
    const parsed = diagnosticPacketSchema.safeParse(input)
    if (!parsed.success) return false
    const packet = parsed.data
    if (packet.type !== 'diagnostic.record') return true
    if (
      !this.utilityTargets.has(child) ||
      packet.record.identity.launchId !== this.identity.launchId ||
      packet.record.identity.process !== 'utility' ||
      packet.record.identity.pid !== child.pid
    )
      return true
    this.submit(packet, (written) => {
      try {
        child.postMessage({
          type: 'diagnostic.ack',
          id: packet.id,
          written,
        } satisfies DiagnosticPacket)
      } catch {
        /* Departed producer. */
      }
    })
    return true
  }

  status(): DiagnosticStatus {
    return diagnosticStatusSchema.parse({
      state: this.state,
      dropped: Math.min(Number.MAX_SAFE_INTEGER, this.lost + this.producer.diagnostics().dropped),
      debugUntil: this.debugUntil,
    })
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.record({ operation: 'shutdown', phase: 'closed' })
    this.closing = true
    clearInterval(this.watchdog)
    clearTimeout(this.debugTimer)
    process.removeListener('uncaughtExceptionMonitor', this.monitor)
    ipcMain.removeHandler(IPC_CHANNELS.diagnosticStatus)
    ipcMain.removeListener(IPC_CHANNELS.rendererFault, this.rendererFault)
    this.debugItems.clear()
    this.utilityTargets.clear()
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      (async () => {
        await this.producer.close()
        if (this.dead) return
        await new Promise<void>((resolve) => {
          this.closed = resolve
          this.worker?.postMessage({ type: 'diagnostic.close' } satisfies DiagnosticPacket)
        })
      })(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, LOG_CLOSE_MS)
      }),
    ])
    clearTimeout(timeout)
    this.producer.dispose()
    for (const item of this.pending.values()) item.settle(false)
    this.pending.clear()
    this.closed?.()
    void this.worker?.terminate()
    this.state = 'closed'
  }

  private submit(
    packet: Extract<DiagnosticPacket, { type: 'diagnostic.record' }>,
    settle: (written: boolean) => void,
  ): void {
    if (this.dead || this.pending.size >= LOG_WORKER_ITEMS || this.pending.has(packet.id)) {
      this.lost = Math.min(Number.MAX_SAFE_INTEGER, this.lost + 1)
      settle(false)
      return
    }
    this.pending.set(packet.id, { settle, startedAt: Date.now() })
    try {
      this.worker?.postMessage(packet)
    } catch {
      this.fail()
    }
  }

  private receive(input: unknown): void {
    const parsed = diagnosticPacketSchema.safeParse(input)
    if (!parsed.success) return
    const packet = parsed.data
    if (packet.type === 'diagnostic.ack') {
      const item = this.pending.get(packet.id)
      if (!item) return
      this.pending.delete(packet.id)
      if (!packet.written) this.lost = Math.min(Number.MAX_SAFE_INTEGER, this.lost + 1)
      item.settle(packet.written)
    } else if (packet.type === 'diagnostic.state') {
      this.state = packet.state
      if (packet.state === 'ready' && this.lost > this.reportedLost) {
        this.record({
          operation: 'queue',
          phase: 'dropped',
          level: 'warn',
          count: this.lost - this.reportedLost,
        })
        this.reportedLost = this.lost
      }
      this.publish()
    } else if (packet.type === 'diagnostic.busy') {
      this.busySince = packet.busy ? Date.now() : 0
    } else if (packet.type === 'diagnostic.closed') this.closed?.()
  }

  private fail(): void {
    if (this.dead) return
    this.dead = true
    for (const item of this.pending.values()) item.settle(false)
    this.lost = Math.min(Number.MAX_SAFE_INTEGER, this.lost + this.pending.size)
    this.pending.clear()
    this.closed?.()
    void this.worker?.terminate()
    this.unavailable()
  }

  private unavailable(): void {
    this.state = 'unavailable'
    this.publish()
  }

  private publish(): void {
    for (const window of this.trust.trustedWindows())
      window.webContents.send(IPC_CHANNELS.diagnosticChanged, this.status())
  }

  private setDebug(enabled: boolean): void {
    clearTimeout(this.debugTimer)
    this.debugUntil = enabled ? Date.now() + LOG_DEBUG_MS : 0
    for (const item of this.debugItems) item.checked = enabled
    this.producer.setDebug(this.debugUntil)
    for (const child of this.utilityTargets) {
      try {
        child.postMessage({
          type: 'diagnostic.debug',
          until: this.debugUntil,
        } satisfies DiagnosticPacket)
      } catch {
        /* Child exit owns cleanup. */
      }
    }
    this.record({ operation: 'debug', phase: enabled ? 'started' : 'closed' })
    this.publish()
    if (enabled) this.debugTimer = setTimeout(() => this.setDebug(false), LOG_DEBUG_MS)
  }

  private readonly rendererFault = (event: Electron.IpcMainEvent, input: unknown): void => {
    try {
      this.trust.assertTrustedMainFrame(event)
    } catch {
      return
    }
    const fault = rendererFaultSchema.safeParse(input)
    if (!fault.success || Date.now() - this.lastFaultAt < 1000) return
    this.lastFaultAt = Date.now()
    const renderer = {
      ...this.identity,
      process: 'renderer' as const,
      pid: event.sender.getOSProcessId(),
    }
    const producer = new DiagnosticProducer(renderer, (packet) => {
      if (packet.type === 'diagnostic.record') this.submit(packet, () => producer.dispose())
    })
    producer.record({
      operation: 'renderer',
      phase: 'failed',
      level: 'error',
      code:
        fault.data === 'view'
          ? 'RENDERER_VIEW'
          : fault.data === 'rejection'
            ? 'UNHANDLED_REJECTION'
            : 'UNHANDLED_ERROR',
    })
  }
}
