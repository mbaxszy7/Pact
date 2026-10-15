/* oxlint-disable no-await-in-loop -- One coalesced metadata read and native publication at a time. */

import {
  app,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  Tray,
  type BrowserWindow,
  type JumpListCategory,
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import {
  IPC_CHANNELS,
  NATIVE_METADATA_TIMEOUT_MS,
  nativeAttentionReadInputSchema,
  nativeNavigationAckInputSchema,
  nativeNavigationIntentSchema,
  nativeQuitDecisionInputSchema,
  nativeQuitStateSchema,
  nativeSessionOpenInputSchema,
  nativeSessionResolveInputSchema,
  type NativeNavigationIntent,
  type NativePresenceSnapshot,
  type NativePresenceVersion,
  type NativeQuitState,
  type NativeSessionRow,
  type RpcResult,
} from '@pact/contracts'

import type { ApplicationIdentity } from '../application-identity'
import type { RendererTrust } from '../renderer-trust'
import type { UtilityProcessClient } from '../utility-process/client'
import type { WindowPresentation } from '../window'

import applicationIcon from '../../../build/icon.ico?asset'
import trayIcon from '../../../build/tray.ico?asset'
import trayTemplate from '../../../build/trayTemplate.png?asset'
import trayTemplateRetina from '../../../build/trayTemplate@2x.png?asset'

interface NativeLaunchData {
  kind: 'pact-session'
  appId: string
  sessionId: string
}

const DEVELOPMENT_NATIVE_ARGUMENT = '--pact-dev-native'
const NATIVE_LAUNCH_ARGUMENT_UNITS = 8192
const WINDOWS_RELAUNCH_COMMAND_UNITS = 255

function developmentNativeArgument(identity: ApplicationIdentity): string {
  const fingerprint = createHash('sha256').update(identity.appId).digest('hex').slice(0, 32)
  return `${DEVELOPMENT_NATIVE_ARGUMENT}=${fingerprint}`
}

/** Validate the originating profile before acquiring or forwarding through any profile's lock. */
export function developmentNativeInvocation(
  identity: ApplicationIdentity,
  args: readonly string[],
): 'none' | 'matching' | 'rejected' {
  if (process.platform !== 'win32' || app.isPackaged) return 'none'
  const markers = args.filter(
    (value) =>
      value === DEVELOPMENT_NATIVE_ARGUMENT || value.startsWith(`${DEVELOPMENT_NATIVE_ARGUMENT}=`),
  )
  if (!markers.length) return 'none'
  return args.length <= 64 &&
    args.reduce((size, value) => size + value.length, 0) <= NATIVE_LAUNCH_ARGUMENT_UNITS &&
    markers.length === 1 &&
    markers[0] === developmentNativeArgument(identity)
    ? 'matching'
    : 'rejected'
}

interface WindowsTaskbarTarget {
  readonly program: string
  readonly argumentPrefix: string
  readonly iconPath: string
  readonly relaunchCommand: string
  readonly development: boolean
}

/** Windows CreateProcess argument quoting; no command processor is involved. */
function quoteWindowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1')}"`
}

function windowsTaskbarTarget(identity: ApplicationIdentity): WindowsTaskbarTarget {
  const program = process.execPath
  if (app.isPackaged)
    return {
      program,
      argumentPrefix: '',
      iconPath: program,
      relaunchCommand: quoteWindowsArgument(program),
      development: false,
    }
  const directory = realpathSync(app.getAppPath())
  if (!isAbsolute(directory) || !statSync(directory).isDirectory())
    throw new Error('The development application directory is unavailable.')
  const metadataPath = join(directory, 'package.json')
  if (statSync(metadataPath).size > 16 * 1024)
    throw new Error('Development application metadata is too large.')
  const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const entry = metadata && typeof metadata === 'object' ? Reflect.get(metadata, 'main') : undefined
  if (typeof entry !== 'string') throw new Error('The development entry is unavailable.')
  const mainFile = realpathSync(resolve(directory, entry))
  if (
    !statSync(mainFile).isFile() ||
    mainFile.toLowerCase() !== realpathSync(__filename).toLowerCase()
  )
    throw new Error('The development entry does not match this running application.')
  const argumentPrefix = `${quoteWindowsArgument(directory)} ${developmentNativeArgument(identity)} `
  const relaunchCommand = `${quoteWindowsArgument(program)} ${argumentPrefix.trimEnd()}`
  if (relaunchCommand.length > WINDOWS_RELAUNCH_COMMAND_UNITS)
    throw new RangeError(
      `The development relaunch command is ${relaunchCommand.length} UTF-16 units; Windows allows ${WINDOWS_RELAUNCH_COMMAND_UNITS}.`,
    )
  if (
    /\p{Cc}/u.test(program + directory) ||
    `${relaunchCommand} --pact-session=00000000-0000-4000-8000-000000000000`.length >
      NATIVE_LAUNCH_ARGUMENT_UNITS
  )
    throw new Error('The development taskbar command exceeds its launch envelope.')
  return {
    program,
    argumentPrefix,
    iconPath: applicationIcon,
    relaunchCommand,
    development: true,
  }
}

/** Only the Session UUID varies. CWD, URLs, paths and identity switches are never consumed. */
export function nativeLaunchData(
  identity: ApplicationIdentity,
  args: readonly string[],
): NativeLaunchData | undefined {
  if (
    args.length > 64 ||
    args.reduce((size, value) => size + value.length, 0) > NATIVE_LAUNCH_ARGUMENT_UNITS
  )
    return undefined
  const options = args.filter((value) => value.startsWith('--pact-session='))
  if (options.length !== 1) return undefined
  const parsed = nativeSessionResolveInputSchema.safeParse({
    sessionId: options[0]!.slice('--pact-session='.length),
  })
  return parsed.success
    ? { kind: 'pact-session', appId: identity.appId, sessionId: parsed.data.sessionId }
    : undefined
}

function secondInstanceSession(value: unknown, identity: ApplicationIdentity): string | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.get(value, 'kind') !== 'pact-session' ||
    Reflect.get(value, 'appId') !== identity.appId
  )
    return undefined
  const parsed = nativeSessionResolveInputSchema.safeParse({
    sessionId: Reflect.get(value, 'sessionId'),
  })
  return parsed.success ? parsed.data.sessionId : undefined
}

const nativeChannels = [
  IPC_CHANNELS.nativeSessionResolve,
  IPC_CHANNELS.nativeSessionOpened,
  IPC_CHANNELS.nativeAttentionRead,
  IPC_CHANNELS.nativeNavigationGet,
  IPC_CHANNELS.nativeNavigationAck,
  IPC_CHANNELS.nativeQuitGet,
  IPC_CHANNELS.nativeQuitRespond,
]

function unavailable(message: string): RpcResult<never> {
  return { ok: false, error: { code: 'CONFLICT', message } }
}

/** Owns native entry points and their transient projections; Utility owns all work and storage. */
export class NativePresence {
  private window: BrowserWindow | undefined
  private presentation: WindowPresentation | undefined
  private tray: Tray | undefined
  private menu: Menu | undefined
  private snapshot: NativePresenceSnapshot | undefined
  private latestVersion: NativePresenceVersion | undefined
  private navigation: NativeNavigationIntent | undefined
  private quitState: NativeQuitState | undefined
  private quitOwner:
    | {
        operationId: string
        preparationSent: boolean
        promise: Promise<boolean>
        resolve: (value: boolean) => void
      }
    | undefined
  private readTask: Promise<void> | undefined
  private fallbackTask: Promise<void> | undefined
  private dirty = false
  private started = false
  private disposed = false
  private showRequested = false
  private systemEnding = false
  private jumpListAvailable = true
  private readonly taskbarTarget: WindowsTaskbarTarget | undefined
  private readError = false
  private readonly removePresenceSubscription: () => void

  constructor(
    private readonly identity: ApplicationIdentity,
    private readonly utility: UtilityProcessClient,
    private readonly trust: RendererTrust,
    private readonly createWindow: () => BrowserWindow,
    launch: NativeLaunchData | undefined,
    private readonly publishShell = true,
  ) {
    if (process.platform === 'win32' && publishShell) {
      try {
        this.taskbarTarget = windowsTaskbarTarget(identity)
      } catch (error) {
        this.disableJumpList(
          error instanceof RangeError
            ? error.message
            : 'The application launch target is unavailable or invalid.',
        )
      }
    }
    if (launch) this.navigate(launch.sessionId)
    const removeChanged = utility.subscribeNativePresence((version) => {
      if (this.disposed) return
      this.latestVersion = version
      this.send(IPC_CHANNELS.nativePresenceChanged, version)
      void this.refresh()
    })
    const removeRecent = utility.subscribeNativeQuitRecent((version, sessions) => {
      if (this.disposed) return
      this.snapshot = {
        version,
        running: this.snapshot?.running ?? [],
        attention: this.snapshot?.attention ?? [],
        attentionTotal: this.snapshot?.attentionTotal ?? 0,
        recent: sessions,
      }
    })
    this.removePresenceSubscription = () => {
      removeChanged()
      removeRecent()
    }
    app.on('activate', this.activate)
    app.on('second-instance', this.secondInstance)
    this.registerIpc()
  }

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    powerMonitor.on('shutdown', this.systemShutdown)
    if (this.publishShell) {
      const image =
        process.platform === 'darwin'
          ? nativeImage.createFromPath(trayTemplate)
          : nativeImage.createFromPath(trayIcon)
      if (process.platform === 'darwin') {
        image.addRepresentation({ scaleFactor: 2, buffer: readFileSync(trayTemplateRetina) })
        image.setTemplateImage(true)
      }
      const hash = createHash('sha256')
        .update(`${this.identity.appId}\0${app.getPath('userData')}`)
        .digest('hex')
      const guid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      this.tray = process.platform === 'win32' ? new Tray(image, guid) : new Tray(image)
      this.tray.setToolTip(this.identity.name)
      this.tray.on('click', () => this.show())
      this.tray.on('right-click', () => {
        void this.refresh()
        if (this.menu) this.tray?.popUpContextMenu(this.menu)
      })
    }
    this.updateMenu()
    void this.refresh()
    if (this.showRequested || this.navigation || this.quitState) this.show()
  }

  attachWindow(window: BrowserWindow, presentation: WindowPresentation): void {
    this.window = window
    this.presentation = presentation
    const target = this.taskbarTarget
    if (target?.development) {
      window.setAppDetails({
        appId: this.identity.appId,
        appIconPath: target.iconPath,
        appIconIndex: 0,
        relaunchCommand: target.relaunchCommand,
        relaunchDisplayName: this.identity.name,
      })
    }
    window.on('close', (event) => {
      if (this.disposed || this.systemEnding) return
      event.preventDefault()
      presentation.hide()
    })
    window.once('closed', () => {
      if (this.window === window) {
        this.window = undefined
        this.presentation = undefined
      }
    })
    window.on('session-end', this.systemShutdown)
    window.webContents.on('did-finish-load', () => {
      if (this.navigation) this.send(IPC_CHANNELS.nativeNavigationChanged, this.navigation)
      if (this.quitState) this.send(IPC_CHANNELS.nativeQuitChanged, this.quitState)
    })
    window.webContents.on('render-process-gone', () => {
      if (this.quitState?.phase === 'confirming') void this.fallbackQuit()
    })
  }

  show(): void {
    if (this.disposed || this.systemEnding) return
    if (!this.started) {
      this.showRequested = true
      return
    }
    if (!this.window || this.window.isDestroyed()) this.createWindow()
    this.presentation?.show()
  }

  navigate(sessionId: string): void {
    if (this.disposed || this.isClosing()) {
      this.show()
      return
    }
    this.navigation = nativeNavigationIntentSchema.parse({
      navigationId: randomUUID(),
      kind: 'session',
      sessionId,
    })
    this.show()
    this.send(IPC_CHANNELS.nativeNavigationChanged, this.navigation)
  }

  private showAttention(): void {
    if (this.isClosing()) {
      this.show()
      return
    }
    this.navigation = { navigationId: randomUUID(), kind: 'attention' }
    this.show()
    this.send(IPC_CHANNELS.nativeNavigationChanged, this.navigation)
  }

  /** Startup has no Renderer yet; retain the same runtime and the existing quit owner. */
  async recoverStartup(): Promise<boolean> {
    while (!this.disposed && !this.systemEnding) {
      const running = this.utility.isRunning()
      const choice = await dialog.showMessageBox({
        type: 'error',
        title: 'Pact could not start',
        message: 'Pact could not load your window settings.',
        detail: running
          ? 'Your saved settings have not been changed. Choose Retry to wait for the local runtime and read them again.'
          : 'The local runtime has stopped. Exit Pact, then open it again. Your saved settings have not been changed.',
        buttons: running ? ['Retry', 'Exit Pact'] : ['Exit Pact'],
        defaultId: 0,
        cancelId: running ? 1 : 0,
        noLink: true,
      })
      if (this.disposed || this.systemEnding) return false
      if (running && choice.response === 0) return true
      if (await this.requestQuit()) {
        app.quit()
        return false
      }
    }
    return false
  }

  requestQuit(): Promise<boolean> {
    if (this.systemEnding || this.disposed || !this.publishShell) return Promise.resolve(true)
    if (this.quitOwner) {
      this.show()
      if (
        this.quitState?.phase === 'confirming' &&
        (!this.started || this.window?.webContents.isCrashed())
      )
        void this.fallbackQuit()
      return this.quitOwner.promise
    }
    const operationId = randomUUID(),
      completion = Promise.withResolvers<boolean>()
    this.quitOwner = {
      operationId,
      preparationSent: true,
      promise: completion.promise,
      resolve: completion.resolve,
    }
    const deadline = performance.now() + NATIVE_METADATA_TIMEOUT_MS
    void this.utility.prepareNativeQuit({ operationId }).then((attempt) => {
      if (this.quitOwner?.operationId !== operationId || this.systemEnding) return undefined
      this.quitOwner.preparationSent = attempt.kind !== 'not-sent'
      const result =
        attempt.kind === 'not-sent' ? { ok: false as const, error: attempt.error } : attempt.result
      const known =
        result.ok && result.value.operationId === operationId && performance.now() <= deadline
      if (known && result.value.state === 'idle_prepared') {
        this.setQuitState({
          operationId,
          phase: 'closing',
          unknown: false,
          activeCount: 0,
          sessions: [],
        })
        this.quitOwner.resolve(true)
        return undefined
      }
      this.setQuitState({
        operationId,
        phase: 'confirming',
        unknown: !known,
        activeCount: known ? result.value.activeCount : 0,
        sessions: known ? result.value.sessions : [],
        ...(!known
          ? {
              message:
                'Pact could not confirm whether work is still active. Exiting may interrupt tasks.',
            }
          : {}),
      })
      this.show()
      if (!this.started || this.window?.webContents.isCrashed()) void this.fallbackQuit()
      return undefined
    })
    return completion.promise
  }

  shutdownUnconfirmed(): void {
    const state = this.quitState
    if (!state) return
    this.setQuitState({
      ...state,
      phase: 'unconfirmed',
      unknown: true,
      message:
        'Runtime exit has not been confirmed. Pact is keeping its workspace open while cleanup finishes.',
    })
    this.updateMenu()
    if (!this.started) {
      this.fallbackTask ??= dialog
        .showMessageBox({
          type: 'warning',
          title: 'Pact is still closing',
          message: 'Pact is waiting for its local runtime to exit.',
          detail:
            'Cleanup has not been confirmed. Pact will remain running until the runtime exits.',
          buttons: ['OK'],
          noLink: true,
        })
        .then(() => undefined)
        .finally(() => {
          this.fallbackTask = undefined
        })
    }
  }

  private async decideQuit(
    operationId: string,
    decision: 'cancel' | 'exit',
  ): Promise<RpcResult<{ accepted: true }>> {
    const owner = this.quitOwner
    if (!owner || owner.operationId !== operationId || this.quitState?.phase !== 'confirming')
      return unavailable('This exit confirmation is no longer current.')
    if (decision === 'exit') {
      this.setQuitState({ ...this.quitState, phase: 'closing' })
      owner.resolve(true)
      this.updateMenu()
      return { ok: true, value: { accepted: true } }
    }
    this.setQuitState({ ...this.quitState, phase: 'cancelling' })
    // A definitely unsent prepare has no remote seal and can never be replayed
    // when startup becomes ready. Attempted delivery still needs a remote ACK.
    if (owner.preparationSent) {
      const cancelled = await this.utility.cancelNativeQuit({ operationId })
      if (this.quitOwner !== owner || this.systemEnding || this.isClosing())
        return unavailable('The exit state changed.')
      if (!cancelled.ok || cancelled.value.operationId !== operationId) {
        this.setQuitState({
          ...this.quitState,
          phase: 'confirming',
          unknown: true,
          message: 'Pact could not confirm cancellation. Try Cancel again to keep working.',
        })
        return unavailable('Exit cancellation could not be confirmed.')
      }
    }
    this.quitOwner = undefined
    this.quitState = undefined
    this.send(IPC_CHANNELS.nativeQuitChanged, null)
    owner.resolve(false)
    return { ok: true, value: { accepted: true } }
  }

  private fallbackQuit(): Promise<void> {
    this.fallbackTask ??= this.showFallbackQuit().finally(() => {
      this.fallbackTask = undefined
    })
    return this.fallbackTask
  }

  private async showFallbackQuit(): Promise<void> {
    while (!this.disposed && !this.systemEnding && this.quitState?.phase === 'confirming') {
      const state = this.quitState
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: 'Exit Pact?',
        message: 'Exiting Pact may interrupt active tasks.',
        detail:
          state.message ??
          'The Pact interface is unavailable. Saved conversations and files remain on your device.',
        buttons: ['Cancel', 'Exit Pact'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      if (this.quitState?.operationId !== state.operationId || this.disposed || this.systemEnding)
        return
      await this.decideQuit(state.operationId, result.response === 1 ? 'exit' : 'cancel')
    }
  }

  private setQuitState(state: NativeQuitState): void {
    this.quitState = nativeQuitStateSchema.parse(state)
    this.send(IPC_CHANNELS.nativeQuitChanged, this.quitState)
  }

  private isClosing(): boolean {
    return this.quitState?.phase === 'closing' || this.quitState?.phase === 'unconfirmed'
  }
  private readonly activate = (): void => this.show()
  private readonly secondInstance = (
    _event: Electron.Event,
    _argv: string[],
    _cwd: string,
    extra: unknown,
  ): void => {
    const sessionId = secondInstanceSession(extra, this.identity)
    if (sessionId) this.navigate(sessionId)
    else this.show()
  }
  private readonly systemShutdown = (): void => {
    if (this.systemEnding) return
    this.systemEnding = true
    this.quitOwner?.resolve(true)
    app.quit()
  }

  private refresh(): Promise<void> {
    if (this.disposed || !this.started || this.isClosing()) return Promise.resolve()
    this.dirty = true
    this.readTask ??= this.readSnapshots().finally(() => {
      this.readTask = undefined
    })
    return this.readTask
  }

  private async readSnapshots(): Promise<void> {
    while (this.dirty && !this.disposed && !this.isClosing()) {
      this.dirty = false
      const result = await this.utility.getNativePresence()
      if (this.disposed || this.isClosing()) return
      if (result.ok) {
        const latest = this.latestVersion
        if (
          latest &&
          latest.incarnation === result.value.version.incarnation &&
          latest.revision > result.value.version.revision
        ) {
          this.dirty = true
          continue
        }
        this.snapshot = result.value
        this.readError = false
      } else this.readError = true
      this.updateMenu()
      if (this.snapshot && !this.readError) await this.updateJumpList(this.snapshot)
    }
  }

  private label(row: NativeSessionRow): string {
    const text = `${row.title} — ${row.projectName}`
    return process.platform === 'win32' ? text.replaceAll('&', '&&') : text
  }

  private groups(snapshot: NativePresenceSnapshot): { name: string; rows: NativeSessionRow[] }[] {
    const seen = new Set<string>()
    return [
      { name: 'Needs attention', rows: snapshot.attention },
      { name: 'Running', rows: snapshot.running },
      { name: 'Recent sessions', rows: snapshot.recent },
    ].map((group) => ({
      name: group.name,
      rows: group.rows.filter((row) => {
        if (seen.has(row.sessionId)) return false
        seen.add(row.sessionId)
        return true
      }),
    }))
  }

  private updateMenu(): void {
    const items: Electron.MenuItemConstructorOptions[] = []
    const snapshot = this.snapshot
    if (this.isClosing()) items.push({ label: 'Pact is exiting…', enabled: false })
    else if (this.readError) items.push({ label: 'Session status is unavailable', enabled: false })
    else if (!snapshot) items.push({ label: 'Loading sessions…', enabled: false })
    else {
      for (const group of this.groups(snapshot)) {
        if (!group.rows.length) continue
        if (items.length) items.push({ type: 'separator' })
        items.push({
          label:
            group.name === 'Needs attention'
              ? `${group.name} (${snapshot.attentionTotal})`
              : group.name,
          enabled: false,
        })
        for (const row of group.rows) {
          const sessionId = row.sessionId
          const prefix =
            row.state === 'preparing'
              ? 'Starting · '
              : row.state === 'approval'
                ? 'Approval needed · '
                : row.state === 'input'
                  ? 'Input needed · '
                  : row.state === 'recovering'
                    ? 'Recovery · '
                    : ''
          items.push({
            label: `${prefix}${this.label(row)}`,
            click: () => this.navigate(sessionId),
          })
        }
        if (group.name === 'Needs attention' && snapshot.attentionTotal > group.rows.length)
          items.push({ label: 'View all in Pact…', click: () => this.showAttention() })
      }
      if (!items.length) items.push({ label: 'No recently opened sessions', enabled: false })
    }
    items.push(
      { type: 'separator' },
      { label: `Show ${this.identity.name}`, click: () => this.show() },
      { label: 'Exit', enabled: !this.isClosing(), click: () => app.quit() },
    )
    this.menu = Menu.buildFromTemplate(items)
    if (this.publishShell && process.platform === 'darwin') app.dock?.setMenu(this.menu)
    if (this.tray && this.isClosing()) this.tray.setToolTip(`${this.identity.name}\nExiting…`)
    else if (this.tray && snapshot)
      this.tray.setToolTip(
        `${this.identity.name}\n${snapshot.running.length} running · ${snapshot.attentionTotal} need attention`,
      )
  }

  private async updateJumpList(snapshot: NativePresenceSnapshot): Promise<void> {
    if (
      !this.publishShell ||
      process.platform !== 'win32' ||
      !this.taskbarTarget ||
      !this.jumpListAvailable ||
      this.isClosing()
    )
      return
    const removal = this.readJumpListRemovals()
    if (!removal) {
      this.disableJumpList('Windows removed-task metadata is unavailable or exceeds its bound.')
      return
    }
    const removed = removal.ids
    const rows = this.groups(snapshot).flatMap((group) => group.rows)
    const observed = new Set(
      rows.filter((row) => row.jumpListRemovalObserved).map((row) => row.sessionId),
    )
    const firstRemoved = [...removed].filter((sessionId) => !observed.has(sessionId))
    if (firstRemoved.length > 64) {
      this.disableJumpList('Windows removed-task preferences exceed the persistence batch bound.')
      return
    }
    const cleared = rows
      .filter((row) => !removed.has(row.sessionId) && row.jumpListRemovalObserved)
      .map((row) => row.sessionId)
    if (firstRemoved.length || cleared.length) {
      const saved = await this.utility.updateNativeJumpListSuppression({
        removedSessionIds: firstRemoved,
        clearedSessionIds: cleared,
      })
      if (!saved.ok || this.disposed || this.isClosing()) return
      if (cleared.length || rows.some((row) => firstRemoved.includes(row.sessionId))) {
        this.dirty = true
        return
      }
    }
    const categories: JumpListCategory[] = this.groups(snapshot)
      .map<JumpListCategory>((group) => ({
        type: 'custom',
        name: group.name,
        items: group.rows
          .filter((row) => !row.jumpListSuppressed && !removed.has(row.sessionId))
          .map((row) => this.jumpListTask(row)),
      }))
      .filter((group) => (group.items?.length ?? 0) > 0)
    try {
      const result = app.setJumpList(categories)
      if (result !== 'ok') this.disableJumpList(`Windows rejected the Session menu: ${result}.`)
    } catch {
      this.disableJumpList('Windows could not publish the Session menu.')
    }
  }

  private disableJumpList(reason: string): void {
    if (!this.jumpListAvailable) return
    this.jumpListAvailable = false
    console.warn(`Pact taskbar navigation is unavailable. ${reason}`)
  }

  private taskArguments(sessionId: string): string {
    return `${this.taskbarTarget!.argumentPrefix}--pact-session=${sessionId}`
  }

  private jumpListTask(row: NativeSessionRow): NonNullable<JumpListCategory['items']>[number] {
    const target = this.taskbarTarget!
    return {
      type: 'task',
      title: `${row.title} — ${row.projectName}`,
      description: `Open ${row.title}`.slice(0, 260),
      program: target.program,
      args: this.taskArguments(row.sessionId),
      iconPath: target.iconPath,
      iconIndex: 0,
    }
  }

  private readJumpListRemovals(): { ids: Set<string>; hasRecords: boolean } | undefined {
    const target = this.taskbarTarget
    if (!target) return undefined
    let settings: ReturnType<typeof app.getJumpListSettings>
    try {
      settings = app.getJumpListSettings()
    } catch {
      return undefined
    }
    if (settings.removedItems.length > 1024) {
      return undefined
    }
    const removed = new Set<string>()
    for (const item of settings.removedItems) {
      if (
        item.type !== 'task' ||
        item.program?.toLowerCase() !== target.program.toLowerCase() ||
        !item.args ||
        item.args.length > target.argumentPrefix.length + 128 ||
        !item.args.startsWith(target.argumentPrefix)
      )
        continue
      const data = nativeLaunchData(this.identity, [item.args.slice(target.argumentPrefix.length)])
      if (data && item.args === this.taskArguments(data.sessionId)) removed.add(data.sessionId)
    }
    return { ids: removed, hasRecords: settings.removedItems.length > 0 }
  }

  private send(channel: string, value: unknown): void {
    for (const window of this.trust.trustedWindows()) window.webContents.send(channel, value)
  }

  private registerIpc(): void {
    ipcMain.handle(IPC_CHANNELS.nativeSessionResolve, (event, raw: unknown) => {
      this.trust.assertTrustedMainFrame(event)
      const parsed = nativeSessionResolveInputSchema.safeParse(raw)
      return parsed.success && !this.isClosing()
        ? this.utility.resolveNativeSession(parsed.data)
        : unavailable('This session cannot be opened right now.')
    })
    ipcMain.handle(IPC_CHANNELS.nativeSessionOpened, (event, raw: unknown) => {
      this.trust.assertTrustedMainFrame(event)
      const parsed = nativeSessionOpenInputSchema.safeParse(raw)
      return parsed.success && !this.isClosing()
        ? this.utility.recordNativeSessionOpened(parsed.data)
        : unavailable('The recent session could not be recorded.')
    })
    ipcMain.handle(IPC_CHANNELS.nativeAttentionRead, (event, raw: unknown) => {
      this.trust.assertTrustedMainFrame(event)
      const parsed = nativeAttentionReadInputSchema.safeParse(raw)
      return parsed.success && !this.isClosing()
        ? this.utility.readNativeAttention(parsed.data)
        : unavailable('Session status could not be read.')
    })
    ipcMain.handle(IPC_CHANNELS.nativeNavigationGet, (event) => {
      this.trust.assertTrustedMainFrame(event)
      return { ok: true, value: this.navigation ?? null }
    })
    ipcMain.handle(IPC_CHANNELS.nativeNavigationAck, (event, raw: unknown) => {
      this.trust.assertTrustedMainFrame(event)
      const parsed = nativeNavigationAckInputSchema.safeParse(raw)
      if (!parsed.success || parsed.data.navigationId !== this.navigation?.navigationId)
        return unavailable('A newer navigation request is already active.')
      this.navigation = undefined
      return { ok: true, value: { acknowledged: true } }
    })
    ipcMain.handle(IPC_CHANNELS.nativeQuitGet, (event) => {
      this.trust.assertTrustedMainFrame(event)
      return { ok: true, value: this.quitState ?? null }
    })
    ipcMain.handle(IPC_CHANNELS.nativeQuitRespond, (event, raw: unknown) => {
      this.trust.assertTrustedMainFrame(event)
      if (this.window?.webContents !== event.sender)
        return unavailable('Only the Pact window can confirm exit.')
      const parsed = nativeQuitDecisionInputSchema.safeParse(raw)
      return parsed.success
        ? this.decideQuit(parsed.data.operationId, parsed.data.decision)
        : unavailable('Choose a valid exit action.')
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.removePresenceSubscription()
    app.removeListener('activate', this.activate)
    app.removeListener('second-instance', this.secondInstance)
    if (this.started) powerMonitor.removeListener('shutdown', this.systemShutdown)
    this.window?.removeListener('session-end', this.systemShutdown)
    for (const channel of nativeChannels) ipcMain.removeHandler(channel)
    this.tray?.destroy()
    this.tray = undefined
    if (this.publishShell && process.platform === 'darwin')
      app.dock?.setMenu(Menu.buildFromTemplate([]))
    if (
      this.publishShell &&
      process.platform === 'win32' &&
      this.taskbarTarget &&
      this.jumpListAvailable &&
      this.snapshot
    ) {
      const removal = this.readJumpListRemovals()
      try {
        if (this.taskbarTarget.development) {
          // Commit clears Windows removal records. Utility is already closed, so
          // leave pending removals for the next live owner's suppression flow.
          if (removal && !removal.hasRecords) app.setJumpList([])
        } else if (removal) {
          app.setJumpList([
            {
              type: 'custom',
              name: 'Recent sessions',
              items: this.snapshot.recent
                .filter((row) => !row.jumpListSuppressed && !removal.ids.has(row.sessionId))
                .map((row) => this.jumpListTask(row)),
            },
          ])
        }
      } catch {
        /* Best-effort Shell publication cannot keep an exited runtime's Main alive. */
      }
    }
    this.snapshot = undefined
    this.navigation = undefined
    this.menu = undefined
    this.presentation = undefined
    this.quitOwner?.resolve(false)
    this.quitOwner = undefined
  }
}
