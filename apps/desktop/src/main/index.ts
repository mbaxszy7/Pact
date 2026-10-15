import { optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { dirname, join } from 'node:path'

import icon from '../../build/icon.png?asset'
import { registerAppProtocol } from './app-protocol'
import {
  resolveApplicationIdentity,
  resolveNativeApplicationIdentity,
} from './application-identity'
import { registerDesktopModules } from './modules'
import {
  createAppearanceController,
  type AppearanceController,
} from './modules/appearance/controller'
import { ApplicationMenu } from './modules/application-menu'
import { DiagnosticLogs } from './modules/diagnostics'
import {
  developmentNativeInvocation,
  NativePresence,
  nativeLaunchData,
} from './modules/native-presence'
import {
  completePackagedSmoke,
  configurePackageSmokeUserData,
  isPackageSmoke,
  observePackagedPageLoad,
} from './package-smoke'
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
let applicationMenu: ApplicationMenu | undefined
let nativePresence: NativePresence | undefined

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
  app.setName(identity.name)
  configurePackageSmokeUserData()
  configureApplicationProfile(identity)
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
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
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
  utilityClient.start({
    ...paths,
    diagnostics,
    onExit: () => {
      if (quitting) void finishQuit()
    },
  })
  applicationMenu = new ApplicationMenu(rendererTrust, () => diagnostics!.createMenuItem())
  appearanceSettings = createAppearanceController(utilityClient, nativeTheme)
  removeDesktopModules = registerDesktopModules(rendererTrust, utilityClient, appearanceSettings)

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
    const appearance = ready.ok ? await appearanceSettings.refresh() : ready
    await quitApproval
    if (quitting) return
    if (appearance.ok) {
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
let quitCompletion: Promise<void> | undefined
function finishQuit(): Promise<void> {
  quitCompletion ??= (async () => {
    await diagnostics?.close()
    nativePresence?.dispose()
    quitReady = true
    app.quit()
  })()
  return quitCompletion
}
app.on('before-quit', (event) => {
  if (quitReady) return
  event.preventDefault()
  if (quitting) return
  if (quitApproval) {
    nativePresence?.show()
    return
  }
  quitApproval = (async () => {
    const accepted = await (nativePresence?.requestQuit() ?? Promise.resolve(true))
    if (!accepted) return
    quitting = true
    applicationMenu?.dispose()
    removeDesktopModules?.()
    appearanceSettings?.dispose()
    const result = await utilityClient.shutdown()
    if (!result.ok) console.error('Pact shutdown was not acknowledged:', result.error.code)
    if (!utilityClient.isRunning()) await finishQuit()
    else nativePresence?.shutdownUnconfirmed()
  })().finally(() => {
    quitApproval = undefined
  })
})
