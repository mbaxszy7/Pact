import type {
  AppearanceEffectiveSettings,
  AppearanceSettings,
  AppearanceSettingsReset,
  AppearanceSettingsUpdate,
  AppearanceSnapshot,
  AppError,
  RpcResult,
  UtilityResponse,
} from '@pact/contracts'

import type {
  UtilityProcessClient,
  UtilityRequestPayload,
  UtilityTransportResult,
} from '../../utility-process/client'
import type {
  MaterialResult,
  MaterialWindow,
  NativeThemeSource,
  WindowAppearance,
} from './material'

import {
  applyMaterial,
  currentMaterialRuntime,
  resolveMaterial,
  solidBackgroundColor,
} from './material'

export type { NativeThemeSource } from './material'

type AppearanceRequestPayload = Exclude<UtilityRequestPayload, { type: 'runtime.health.request' }>

export interface AppearanceWindow extends MaterialWindow {
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

export interface AppearanceController {
  /** Pin the loaded Windows background mode before constructing the first workspace. Requires a successful refresh. */
  getWindowAppearance(): WindowAppearance
  /** Reload persisted settings, reconcile uncertain writes, and apply the result to attached windows. */
  refresh(): Promise<RpcResult<AppearanceSnapshot>>
  update(input: AppearanceSettingsUpdate): Promise<RpcResult<AppearanceSnapshot>>
  reset(input: AppearanceSettingsReset): Promise<RpcResult<AppearanceSnapshot>>
  attachWindow(window: AppearanceWindow): void
  subscribe(listener: (snapshot: AppearanceSnapshot) => void): () => void
  dispose(): void
}

function transportFailure(
  result: Exclude<UtilityTransportResult, { kind: 'response' }>,
  isMutation: boolean,
): RpcResult<AppearanceSettings> {
  if (result.kind === 'unknown-delivery' && isMutation) {
    return {
      ok: false,
      error: {
        code: 'UNCERTAIN',
        message: 'Appearance update outcome is unknown; read settings again before retrying.',
      },
    }
  }

  return { ok: false, error: result.error }
}

function effectiveSettings(
  requested: AppearanceSettings,
  material: MaterialResult,
): AppearanceEffectiveSettings {
  return {
    theme: material.theme,
    windowMaterial: material.windowMaterial,
    revision: requested.revision,
    ...(material.fallbackReason ? { fallbackReason: material.fallbackReason } : {}),
    ...(material.restartRequired ? { restartRequired: true } : {}),
  }
}

function blockedMutation(): RpcResult<AppearanceSnapshot> {
  return {
    ok: false,
    error: {
      code: 'UNCERTAIN',
      message: 'Appearance update outcome is unknown; read settings again before retrying.',
    },
  }
}

export function createAppearanceController(
  utilityClient: Pick<UtilityProcessClient, 'request'>,
  nativeTheme: NativeThemeSource,
): AppearanceController {
  const listeners = new Set<(snapshot: AppearanceSnapshot) => void>()
  const windows = new Set<AppearanceWindow>()
  const windowClosedHandlers = new Map<AppearanceWindow, () => void>()
  const runtime = currentMaterialRuntime()
  let highestRevision = -1
  let projectionVersion = 0
  let latestSnapshot: AppearanceSnapshot | undefined
  let currentSettings: AppearanceSettings | undefined
  let reconciliationRequired = false
  let reconciliationGeneration = 0
  let applyingMaterial = false
  let disposed = false
  let launchMaterial:
    | { preference: AppearanceSettings['windowMaterial']; native: MaterialResult['windowMaterial'] }
    | undefined

  const request = async (
    payload: AppearanceRequestPayload,
  ): Promise<RpcResult<AppearanceSettings>> => {
    const isMutation = payload.type !== 'appearance.get.request'
    const outcome = await utilityClient.request(payload, 'appearance.response')
    if (outcome.kind !== 'response') return transportFailure(outcome, isMutation)

    const response: UtilityResponse = outcome.response
    if (response.type !== 'appearance.response') {
      const error: AppError = {
        code: 'INTERNAL',
        message: 'Utility runtime returned an unexpected appearance response.',
      }
      return { ok: false, error }
    }
    return response.result
  }

  const snapshotFor = (
    requested: AppearanceSettings,
    result: MaterialResult,
  ): AppearanceSnapshot => ({
    requested,
    effective: effectiveSettings(requested, result),
    projectionVersion: ++projectionVersion,
  })

  const publish = (snapshot: AppearanceSnapshot): void => {
    if (disposed) return
    const current = latestSnapshot
    if (
      current !== snapshot &&
      current &&
      (snapshot.requested.revision < current.requested.revision ||
        (snapshot.requested.revision === current.requested.revision &&
          snapshot.projectionVersion <= current.projectionVersion))
    ) {
      return
    }
    latestSnapshot = snapshot
    for (const listener of listeners) listener(snapshot)
  }

  const applyCurrent = (settings: AppearanceSettings): MaterialResult => {
    applyingMaterial = true
    try {
      if (nativeTheme.themeSource !== settings.theme) nativeTheme.themeSource = settings.theme
      const active = launchMaterial
        ? { ...settings, windowMaterial: launchMaterial.preference }
        : settings
      const desired = resolveMaterial(active, nativeTheme, runtime)
      // An opaque native window cannot become transparent. System accessibility
      // can still paint a transparent-backed workspace Solid immediately.
      const keepSolid = launchMaterial?.native === 'solid'
      const result = applyMaterial(
        keepSolid ? { ...active, windowMaterial: 'solid' } : active,
        nativeTheme,
        windows,
        runtime,
      )
      const restartRequired =
        launchMaterial &&
        (settings.windowMaterial !== launchMaterial.preference ||
          (keepSolid && desired.windowMaterial === 'translucent'))
      return {
        ...result,
        ...(keepSolid && desired.fallbackReason ? { fallbackReason: desired.fallbackReason } : {}),
        ...(restartRequired ? { restartRequired: true } : {}),
      }
    } finally {
      applyingMaterial = false
    }
  }

  const project = (result: RpcResult<AppearanceSettings>): RpcResult<AppearanceSnapshot> => {
    if (!result.ok) return result
    if (result.value.revision < highestRevision && latestSnapshot) {
      return {
        ok: true,
        value: {
          requested: result.value,
          effective: {
            ...latestSnapshot.effective,
            revision: result.value.revision,
          },
          projectionVersion: latestSnapshot.projectionVersion,
        },
      }
    }

    highestRevision = result.value.revision
    currentSettings = result.value
    const snapshot = snapshotFor(result.value, applyCurrent(result.value))
    latestSnapshot = snapshot
    return { ok: true, value: snapshot }
  }

  const publishMaterialChange = (): void => {
    if (disposed || !currentSettings) return
    const result = applyCurrent(currentSettings)
    const previous = latestSnapshot?.effective
    if (
      previous?.theme === result.theme &&
      previous.windowMaterial === result.windowMaterial &&
      previous.fallbackReason === result.fallbackReason &&
      previous.restartRequired === result.restartRequired
    ) {
      return
    }
    publish(snapshotFor(currentSettings, result))
  }

  const handleNativeThemeUpdate = (): void => {
    if (!applyingMaterial) publishMaterialChange()
  }

  nativeTheme.on('updated', handleNativeThemeUpdate)

  return {
    getWindowAppearance(): WindowAppearance {
      if (disposed) throw new Error('Appearance controller is disposed.')
      if (!currentSettings)
        throw new Error('Appearance settings must be loaded before creating a window.')
      const settings = currentSettings
      const result = applyCurrent(settings)
      if (runtime.platform === 'win32' && !launchMaterial) {
        launchMaterial = { preference: settings.windowMaterial, native: result.windowMaterial }
      }
      return {
        windowMaterial: launchMaterial?.native ?? result.windowMaterial,
        backgroundColor:
          result.windowMaterial === 'solid' ? solidBackgroundColor(result.theme) : '#00000000',
      }
    },

    async refresh(): Promise<RpcResult<AppearanceSnapshot>> {
      const reconciliationAttempt = reconciliationRequired ? reconciliationGeneration : undefined
      const result = project(await request({ type: 'appearance.get.request' }))
      if (
        result.ok &&
        reconciliationRequired &&
        reconciliationAttempt === reconciliationGeneration &&
        result.value.requested.revision >= highestRevision
      ) {
        reconciliationRequired = false
        publish(result.value)
      }
      return result
    },

    async update(input): Promise<RpcResult<AppearanceSnapshot>> {
      if (reconciliationRequired) return blockedMutation()
      const result = project(await request({ type: 'appearance.update.request', input }))
      if (result.ok) publish(result.value)
      else if (result.error.code === 'UNCERTAIN') {
        reconciliationRequired = true
        reconciliationGeneration += 1
      }
      return result
    },

    async reset(input): Promise<RpcResult<AppearanceSnapshot>> {
      if (reconciliationRequired) return blockedMutation()
      const result = project(await request({ type: 'appearance.reset.request', input }))
      if (result.ok) publish(result.value)
      else if (result.error.code === 'UNCERTAIN') {
        reconciliationRequired = true
        reconciliationGeneration += 1
      }
      return result
    },

    attachWindow(window): void {
      if (disposed || windows.has(window)) return
      const handleClosed = (): void => {
        windows.delete(window)
        windowClosedHandlers.delete(window)
      }
      windows.add(window)
      windowClosedHandlers.set(window, handleClosed)
      window.once('closed', handleClosed)
      publishMaterialChange()
    },

    subscribe(listener): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      nativeTheme.removeListener('updated', handleNativeThemeUpdate)
      for (const [window, handleClosed] of windowClosedHandlers) {
        window.removeListener('closed', handleClosed)
      }
      windowClosedHandlers.clear()
      windows.clear()
      listeners.clear()
      launchMaterial = undefined
    },
  }
}
