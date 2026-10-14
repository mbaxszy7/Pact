import { electronApp, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import type { RuntimeStartupFailure } from '@pact/contracts'

import { hasLogicalIpcFixtureNonce, LogicalIpcWorkerTraffic } from '../shared/logical-ipc-traffic'
import { registerAppProtocol } from './app-protocol'
import { registerDesktopModules } from './modules'
import {
  createAppearanceController,
  type AppearanceController,
} from './modules/appearance/controller'
import { ApplicationMenu } from './modules/application-menu'
import { DiagnosticLogs } from './modules/diagnostics'
import {
  completePackagedSmoke,
  completePackagedProductionPathProbe,
  configurePackagedSoakInspection,
  disposePackagedSoakInspection,
  configurePackageSmokeUserData,
  isPackageSmoke,
  isPackagedSoakInspection,
  observePackagedPageLoad,
  writePackagedSoakReceipt,
} from './package-smoke'
import { configureProductIdentity, readProductIdentity } from './product-identity'
import { createRendererTrust } from './renderer-trust'
import { createUtilityProcessClient } from './utility-process/client'
import { configureIsolatedProfile, resolveRuntimePaths } from './utility-process/runtime-paths'
import { createMainWindow } from './window'

const productIdentity = readProductIdentity()
configureProductIdentity(productIdentity)

const utilityClient = createUtilityProcessClient()
const rendererTrust = createRendererTrust({
  isPackaged: app.isPackaged,
  ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
})
let removeDesktopModules: (() => void) | undefined
let appearanceSettings: AppearanceController
let diagnostics: DiagnosticLogs | undefined
let applicationMenu: ApplicationMenu | undefined
let startupFailureShown = false

function createPactWindow(): BrowserWindow {
  let pageLoad: Promise<void> | undefined
  const window = createMainWindow({
    show: !isPackageSmoke(),
    trust: rendererTrust,
    onBeforeLoad: (createdWindow) => {
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
      if (isPackageSmoke() || isPackagedSoakInspection())
        pageLoad = observePackagedPageLoad(createdWindow)
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

  if (isPackagedSoakInspection()) {
    if (!pageLoad)
      throw new Error('Packaged soak page observer was not installed before navigation.')
    void writePackagedSoakReceipt(window, pageLoad).catch(() => {
      diagnostics?.record({ operation: 'app', phase: 'failed', level: 'error', code: 'INTERNAL' })
      utilityClient.dispose()
      app.exit(1)
    })
  }

  return window
}

async function bootstrap(): Promise<void> {
  configurePackageSmokeUserData()
  configureIsolatedProfile()
  configurePackagedSoakInspection()
  if (!app.requestSingleInstanceLock()) {
    app.exit(0)
    return
  }
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  await app.whenReady()
  electronApp.setAppUserModelId(productIdentity.appId)
  if (completePackagedProductionPathProbe()) return
  registerAppProtocol(join(__dirname, '../renderer'))
  const paths = resolveRuntimePaths()
  let traffic: LogicalIpcWorkerTraffic | undefined
  if (
    (Boolean(process.env.PACT_SOAK_NONCE) || !app.isPackaged) &&
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
  utilityClient.start({
    ...paths,
    diagnostics,
    ...(traffic ? { traffic } : {}),
    onStartupFailed: (failure: RuntimeStartupFailure) => {
      if (startupFailureShown) return
      startupFailureShown = true
      const messages = {
        DATABASE_IN_USE:
          'Another Pact process is using this data. Close that process before opening this copy.',
        DATABASE_INCOMPATIBLE:
          'This Pact version cannot safely open the existing data. Use a build with compatible migration history.',
        DATABASE_BACKUP_FAILED:
          'Pact could not create the required upgrade backup. Check storage space and folder permissions.',
        DATABASE_MIGRATION_FAILED:
          'Pact could not complete the data upgrade. Existing data and recovery files have been preserved.',
        DATABASE_STORAGE_FAILED:
          'Pact could not open its data. Check that the data folder is available and accessible.',
      }
      const canReveal =
        isAbsolute(failure.dataFilePath) &&
        paths.databaseFile !== ':memory:' &&
        resolve(failure.dataFilePath) === resolve(paths.databaseFile)
      void dialog
        .showMessageBox({
          type: 'error',
          title: `${productIdentity.productName} could not start`,
          message:
            failure.stage === 'runtime'
              ? 'Pact could not start its local runtime. Quit and check the data folder before trying again.'
              : messages[failure.code],
          detail: failure.partialBackupFilePath
            ? 'Your data was preserved. An incomplete backup was kept separately and must not replace the original data.'
            : failure.backupFilePath
              ? 'Your data and recovery backup were preserved. Open the data folder to locate them.'
              : 'Your data was preserved. Pact will quit without recreating or clearing it.',
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
  applicationMenu = new ApplicationMenu(rendererTrust, () => diagnostics!.createMenuItem())
  appearanceSettings = createAppearanceController(utilityClient, nativeTheme)
  removeDesktopModules = registerDesktopModules(rendererTrust, utilityClient, appearanceSettings)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Restore saved Appearance before the first window; Renderer handles any load failure and retry.
  await appearanceSettings.refresh()
  if (startupFailureShown) return
  createPactWindow()

  app.on('activate', () => {
    if (!quitting && BrowserWindow.getAllWindows().length === 0) createPactWindow()
  })
}

void bootstrap().catch(() => {
  diagnostics?.record({ operation: 'app', phase: 'failed', level: 'error', code: 'INTERNAL' })
  console.error('Failed to start Pact.')
  app.exit(1)
})

let quitting = false
let quitReady = false
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  const inspectionClosed = disposePackagedSoakInspection()
  applicationMenu?.dispose()
  removeDesktopModules?.()
  appearanceSettings?.dispose()
  void utilityClient
    .shutdown()
    .then((result) => {
      if (!result.ok) console.error('Pact shutdown was not acknowledged:', result.error.code)
      return undefined
    })
    // oxlint-disable-next-line typescript/no-misused-promises -- Promise.finally awaits the bounded diagnostic flush before quitting.
    .finally(async () => {
      await inspectionClosed
      await diagnostics?.close()
      quitReady = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
