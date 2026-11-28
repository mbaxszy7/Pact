import { optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { RuntimeStartupFailure } from '@pact/contracts'

import macIcon from '../../build/icon-mac.png?asset'
import { hasLogicalIpcFixtureNonce, LogicalIpcWorkerTraffic } from '../shared/logical-ipc-traffic'
import { registerAppProtocol } from './app-protocol'
import {
  resolveApplicationIdentity,
  resolveNativeApplicationIdentity,
} from './application-identity'
import { registerDesktopModules } from './modules'
import { ApplicationUpdates } from './modules/app-updates'
import {
  createAppearanceController,
  type AppearanceController,
} from './modules/appearance/controller'
import { ApplicationMenu } from './modules/application-menu'
import { DiagnosticLogs } from './modules/diagnostics'
import {
  createNativeLastExitNoticeStore,
  type NativeLastExitNoticeStore,
} from './modules/native-last-exit-notice'
import {
  developmentNativeInvocation,
  NativePresence,
  nativeLaunchData,
} from './modules/native-presence'
import {
  completePackagedSmoke,
  completePackagedProductionPathProbe,
  configurePackageSmokeUserData,
  isPackageSmoke,
  observePackagedPageLoad,
} from './package-smoke'
import { readProductIdentity } from './product-identity'
import { createRendererTrust } from './renderer-trust'
import { createUtilityProcessClient } from './utility-process/client'
import { configureApplicationProfile, resolveRuntimePaths } from './utility-process/runtime-paths'
import { createMainWindow } from './window'

const utilityClient = createUtilityProcessClient()
const rendererTrust = createRendererTrust({
  isPackaged: app.isPackaged,
  ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
})
let removeDesktopModules: (() => void) | undefined
let appearanceSettings: AppearanceController
let diagnostics: DiagnosticLogs | undefined
let lastExitNotice: NativeLastExitNoticeStore | undefined
let applicationMenu: ApplicationMenu | undefined
let applicationUpdates: ApplicationUpdates | undefined
let nativePresence: NativePresence | undefined
let startupFailureShown = false

function createPactWindow(): BrowserWindow {
  let pageLoad: Promise<void> | undefined
  const window = createMainWindow({
    show: !isPackageSmoke(),
    appearance: appearanceSettings.getWindowAppearance(),
    trust: rendererTrust,
    onBeforeLoad: (createdWindow, presentation) => {
      nativePresence?.attachWindow(createdWindow, presentation)
      applicationMenu?.attachWindow(createdWindow)
      appearanceSettings.attachWindow(createdWindow)
      createdWindow.webContents.on('render-process-gone', (_event, details) => {
        diagnostics?.record({
          operation: 'renderer',
          phase: 'failed',
          level: 'error',
          code: 'RENDERER_CRASH',
          exitCode: details.exitCode,
        })
      })
      if (isPackageSmoke()) pageLoad = observePackagedPageLoad(createdWindow)
    },
  })

  if (isPackageSmoke()) {
    if (!pageLoad)
      throw new Error('Package smoke page observer was not installed before navigation.')
    void completePackagedSmoke(window, pageLoad, utilityClient, appearanceSettings).catch(
      (error: unknown) => {
        console.error('PACT_PACKAGE_SMOKE:FAIL', error)
        utilityClient.dispose()
        app.exit(1)
      },
    )
  }

  return window
}

async function bootstrap(): Promise<void> {
  const identity = resolveApplicationIdentity()
  const productIdentity = readProductIdentity(identity)
  app.setName(identity.name)
  configureApplicationProfile(identity)
  configurePackageSmokeUserData()
  const nativeIdentity = resolveNativeApplicationIdentity(identity)
  const developmentLaunch = developmentNativeInvocation(nativeIdentity, process.argv)
  if (developmentLaunch === 'rejected') {
    app.exit(0)
    return
  }
  const launch = nativeLaunchData(nativeIdentity, process.argv)
  if (!app.requestSingleInstanceLock(launch ?? {})) {
    app.exit(0)
    return
  }
  // A taskbar entry can activate a live development server, never cold-start an old build.
  if (developmentLaunch === 'matching') {
    app.releaseSingleInstanceLock()
    app.exit(0)
    return
  }
  nativePresence = new NativePresence(
    nativeIdentity,
    utilityClient,
    rendererTrust,
    createPactWindow,
    launch,
    !isPackageSmoke(),
  )
  await app.whenReady()
  if (quitting) return
  if (process.platform === 'win32') app.setAppUserModelId(nativeIdentity.appId)
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(macIcon)
  if (completePackagedProductionPathProbe()) return
  registerAppProtocol(join(__dirname, '../renderer'))
  const paths = resolveRuntimePaths()
  let traffic: LogicalIpcWorkerTraffic | undefined
  if (
    !app.isPackaged &&
    hasLogicalIpcFixtureNonce(process.env) &&
    process.env.PACT_E2E_ROOT &&
    paths.databaseFile !== ':memory:'
  ) {
    try {
      if (realpathSync(dirname(paths.databaseFile)) === realpathSync(process.env.PACT_E2E_ROOT))
        traffic = new LogicalIpcWorkerTraffic(
          ['main-utility', 'main-directory', 'main-diagnostic-log'],
          randomUUID(),
        )
    } catch {
      /* An unproved fixture stays disabled and cannot satisfy the measurement gate. */
    }
  }
  diagnostics = new DiagnosticLogs(
    join(
      paths.databaseFile === ':memory:'
        ? dirname(paths.workspaceStorageRoot)
        : dirname(paths.databaseFile),
      'logs',
      app.isPackaged ? 'production' : 'development',
    ),
    rendererTrust,
    traffic?.collector('main-utility'),
    traffic?.collector('main-diagnostic-log'),
  )
  lastExitNotice = createNativeLastExitNoticeStore(paths.databaseFile)
  utilityClient.start({
    ...paths,
    diagnostics,
    onExit: () => {
      if (!quitting && lastExitNotice) {
        const openCount = utilityClient.trackedOpenTerminalCount?.() ?? 0
        if (openCount > 0) {
          void lastExitNotice.record('utility_exited_unconfirmed', openCount).catch(() => undefined)
        }
      }
      if (quitting) void finishQuit()
    },
    ...(traffic ? { traffic } : {}),
    onStartupFailed: (failure: RuntimeStartupFailure) => {
      if (startupFailureShown) return
      startupFailureShown = true
      const messages = {
        DATABASE_IN_USE:
          'Another Pact process is using this data. Close that process before opening this copy.',
        DATABASE_INCOMPATIBLE:
          failure.reason === 'newer-migration-history'
            ? 'This version of Pact can’t open your existing data. Try opening it with a newer version of Pact.'
            : 'This version of Pact can’t open your existing data.',
        DATABASE_BACKUP_FAILED:
          'Pact couldn’t create a backup before upgrading your data. Check free disk space and folder permissions.',
        DATABASE_MIGRATION_FAILED:
          'Pact couldn’t upgrade your data. Your existing data and backup are safe.',
        DATABASE_STORAGE_FAILED:
          'Pact couldn’t open its data folder. Check that the folder exists and is accessible.',
      }
      const canReveal =
        isAbsolute(failure.dataFilePath) &&
        paths.databaseFile !== ':memory:' &&
        resolve(failure.dataFilePath) === resolve(paths.databaseFile)
      void dialog
        .showMessageBox({
          type: 'error',
          title: `${productIdentity.productName} couldn’t start`,
          message:
            failure.stage === 'runtime'
              ? 'Pact couldn’t start its background service. Quit and check your data folder before trying again.'
              : messages[failure.code],
          detail: failure.partialBackupFilePath
            ? 'Your original data is safe. An incomplete backup file was kept separately and should not replace it.'
            : failure.backupFilePath
              ? 'Your data and a recovery backup were kept safe. Open the data folder to find them.'
              : 'Your data is safe. Pact will quit without changing or clearing it.',
          buttons: canReveal ? ['Open data folder', 'Quit'] : ['Quit'],
          defaultId: canReveal ? 1 : 0,
          cancelId: canReveal ? 1 : 0,
          noLink: true,
        })
        .then((result) => {
          if (canReveal && result.response === 0)
            shell.showItemInFolder(dirname(failure.dataFilePath))
          app.quit()
          return undefined
        })
        .catch(() => app.quit())
    },
  })
  applicationUpdates = new ApplicationUpdates(utilityClient, identity, rendererTrust, () =>
    nativePresence?.show(),
  )
  applicationMenu = new ApplicationMenu(
    rendererTrust,
    () => diagnostics!.createMenuItem(),
    () => applicationUpdates?.openFromMenu(),
  )
  appearanceSettings = createAppearanceController(utilityClient, nativeTheme)
  if (!nativePresence) throw new Error('Pact native presence was not initialized.')
  removeDesktopModules = registerDesktopModules(
    rendererTrust,
    utilityClient,
    appearanceSettings,
    nativePresence,
    (event) => diagnostics?.record(event),
    lastExitNotice,
  )

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Cold module loading precedes the ordinary RPC deadline. Never commit a
  // native window type until the authoritative Appearance read succeeds.
  /* oxlint-disable no-await-in-loop -- Startup attempts are serial and require an explicit user Retry. */
  for (;;) {
    await quitApproval
    if (quitting) return
    const ready = await utilityClient.waitUntilReady()
    if (startupFailureShown) return
    const appearance = ready.ok ? await appearanceSettings.refresh() : ready
    await quitApproval
    if (quitting) return
    if (appearance.ok) {
      void applicationUpdates.start()
      createPactWindow()
      nativePresence.start()
      return
    }
    diagnostics.record({
      operation: 'app',
      phase: 'failed',
      level: 'error',
      code: appearance.error.code,
    })
    if (isPackageSmoke()) throw new Error('Package smoke could not load startup Appearance.')
    if (!(await nativePresence.recoverStartup())) return
  }
  /* oxlint-enable no-await-in-loop */
}

void bootstrap().catch(() => {
  diagnostics?.record({ operation: 'app', phase: 'failed', level: 'error', code: 'INTERNAL' })
  console.error('Failed to start Pact.')
  app.exit(1)
})

let quitting = false
let quitReady = false
let quitApproval: Promise<void> | undefined
let quitNoticeTask: Promise<void> | undefined
let quitCompletion: Promise<void> | undefined
function finishQuit(): Promise<void> {
  quitCompletion ??= (async () => {
    await utilityClient.settlement()
    if (quitNoticeTask) await quitNoticeTask.catch(() => undefined)
    try {
      await diagnostics?.close()
    } catch {
      console.error('Pact could not close its diagnostics.')
    }
    nativePresence?.dispose()
    quitReady = true
    app.quit()
  })()
  return quitCompletion
}
// will-quit follows Electron's document shutdown. Keep named handlers available
// for late Renderer cleanup instead of treating native window closure as an IPC drain.
app.once('will-quit', () => {
  applicationUpdates?.dispose()
  applicationMenu?.dispose()
  removeDesktopModules?.()
  appearanceSettings?.dispose()
})
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  if (startupFailureShown) {
    quitting = true
    utilityClient.dispose()
    if (!utilityClient.isRunning()) void finishQuit()
    return
  }
  if (quitApproval) {
    nativePresence?.show()
    return
  }
  quitApproval = (async () => {
    const accepted = await (nativePresence?.requestQuit() ?? Promise.resolve(true))
    if (!accepted) return
    quitting = true
    applicationUpdates?.stop()
    const openCount = utilityClient.trackedOpenTerminalCount?.() ?? 0
    const noticeTask = (async () => {
      const result = await utilityClient.shutdown()
      if (!result.ok) console.error('Pact shutdown was not acknowledged:', result.error.code)
      let noticeWriteFailed = false
      if (result.ok && result.value.unconfirmedTerminals && result.value.unconfirmedTerminals > 0) {
        const recorded = await (
          lastExitNotice?.record('worker_cleanup_failed', result.value.unconfirmedTerminals) ??
          Promise.resolve(true)
        ).catch(() => false)
        noticeWriteFailed = !recorded
      } else if (!result.ok && openCount > 0) {
        const reason =
          result.error.code === 'TIMEOUT' ? 'shutdown_timeout' : 'utility_exited_unconfirmed'
        const recorded = await (
          lastExitNotice?.record(reason, openCount) ?? Promise.resolve(true)
        ).catch(() => false)
        noticeWriteFailed = !recorded
      }
      if (noticeWriteFailed && !(nativePresence?.isSystemEnding?.() ?? false)) {
        await dialog
          .showMessageBox({
            type: 'warning',
            title: 'Pact',
            message: 'Background terminal cleanup could not be recorded cleanly.',
            detail: 'Some terminal processes may still need manual inspection after Pact exits.',
            buttons: ['Close'],
          })
          .catch(() => undefined)
      }
    })()
    quitNoticeTask = noticeTask
    await noticeTask
    if (!utilityClient.isRunning()) await finishQuit()
    else nativePresence?.shutdownUnconfirmed()
  })().finally(() => {
    quitApproval = undefined
  })
})
