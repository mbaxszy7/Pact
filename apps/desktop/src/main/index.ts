import { electronApp, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { dirname, join } from 'node:path'

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
  configurePackageSmokeUserData,
  isPackageSmoke,
  observePackagedPageLoad,
} from './package-smoke'
import { createRendererTrust } from './renderer-trust'
import { createUtilityProcessClient } from './utility-process/client'
import { configureIsolatedProfile, resolveRuntimePaths } from './utility-process/runtime-paths'
import { createMainWindow } from './window'

app.setName('Pact')

const utilityClient = createUtilityProcessClient()
const rendererTrust = createRendererTrust({
  isPackaged: app.isPackaged,
  ...(process.env.ELECTRON_RENDERER_URL ? { rendererUrl: process.env.ELECTRON_RENDERER_URL } : {}),
})
let removeDesktopModules: (() => void) | undefined
let appearanceSettings: AppearanceController
let diagnostics: DiagnosticLogs | undefined
let applicationMenu: ApplicationMenu | undefined

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
  configurePackageSmokeUserData()
  configureIsolatedProfile()
  await app.whenReady()
  electronApp.setAppUserModelId('com.pact.desktop')
  registerAppProtocol(join(__dirname, '../renderer'))
  const paths = resolveRuntimePaths()
  diagnostics = new DiagnosticLogs(
    join(
      paths.databaseFile === ':memory:'
        ? dirname(paths.workspaceStorageRoot)
        : dirname(paths.databaseFile),
      'logs',
      app.isPackaged ? 'production' : 'development',
    ),
    rendererTrust,
  )
  utilityClient.start({ ...paths, diagnostics })
  applicationMenu = new ApplicationMenu(rendererTrust, () => diagnostics!.createMenuItem())
  appearanceSettings = createAppearanceController(utilityClient, nativeTheme)
  removeDesktopModules = registerDesktopModules(rendererTrust, utilityClient, appearanceSettings)

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Restore saved Appearance before the first window; Renderer handles any load failure and retry.
  await appearanceSettings.refresh()
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
      await diagnostics?.close()
      quitReady = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
