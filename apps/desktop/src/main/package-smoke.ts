import { app, type BrowserWindow } from 'electron'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Worker } from 'node:worker_threads'

import { collaborationMarkdownPageSchema } from '@pact/contracts'
import { imageCodecResultSchema } from '@pact/contracts/images'

import type { AppearanceController } from './modules/appearance/controller'
import type { UtilityProcessClient } from './utility-process/client'

import {
  defaultProductPaths,
  readConfiguredDefaultPaths,
  readProductIdentity,
} from './product-identity'

const PACKAGE_SMOKE_ENV = 'PACT_PACKAGE_SMOKE'
const PACKAGE_SMOKE_PHASE_ENV = 'PACT_PACKAGE_SMOKE_PHASE'
const PACKAGE_SMOKE_USER_DATA_ENV = 'PACT_PACKAGE_SMOKE_USER_DATA'
const PACKAGE_SMOKE_TIMEOUT_MS = 10_000
export function isPackageSmoke(): boolean {
  return process.env[PACKAGE_SMOKE_ENV] === '1'
}

export function configurePackageSmokeUserData(): void {
  if (!isPackageSmoke() || process.env[PACKAGE_SMOKE_PHASE_ENV] === 'production-paths') return

  const userDataPath = process.env[PACKAGE_SMOKE_USER_DATA_ENV]
  if (!userDataPath || !isAbsolute(userDataPath)) {
    throw new Error(`${PACKAGE_SMOKE_USER_DATA_ENV} must be an absolute path during package smoke.`)
  }

  app.setPath('userData', userDataPath)
}

export function observePackagedPageLoad(window: BrowserWindow): Promise<void> {
  const expectedUrl = 'app://bundle/index.html'

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      complete(new Error(`Timed out loading ${expectedUrl}.`))
    }, PACKAGE_SMOKE_TIMEOUT_MS)

    const complete = (error?: Error): void => {
      clearTimeout(timeout)
      window.webContents.removeListener('did-finish-load', handleFinishLoad)
      window.webContents.removeListener('did-fail-load', handleFailLoad)

      if (error) {
        reject(error)
        return
      }

      resolve()
    }

    const handleFinishLoad = (): void => {
      if (window.webContents.getURL() !== expectedUrl) {
        complete(
          new Error(
            `Expected packaged page ${expectedUrl}, received ${window.webContents.getURL()}.`,
          ),
        )
        return
      }

      complete()
    }

    const handleFailLoad = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedUrl: string,
      isMainFrame: boolean,
    ): void => {
      if (!isMainFrame) return
      complete(new Error(`Failed to load ${validatedUrl}: ${errorCode} ${errorDescription}.`))
    }

    window.webContents.once('did-finish-load', handleFinishLoad)
    window.webContents.once('did-fail-load', handleFailLoad)
  })
}

function waitForRendererMount(window: BrowserWindow): Promise<boolean> {
  return window.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const deadline = Date.now() + 5000
      const check = () => {
        const mounted = document.querySelector(
          '#runtime-preparation-title, #project-empty-title, #foundation-title'
        ) !== null
        if (mounted || Date.now() >= deadline) {
          resolve(mounted)
          return
        }
        requestAnimationFrame(check)
      }
      check()
    })
  `)
}

/** Exercise the packaged native codec and its Worker entry, without an Agent task. */
async function verifyPackagedImageCodec(): Promise<void> {
  const directory = await mkdtemp(join(app.getPath('userData'), 'image-codec-smoke-'))
  let worker: Worker | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const source = join(directory, 'source.png'),
      thumbnail = join(directory, 'thumbnail.webp')
    await writeFile(
      source,
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGOonf31PwgzwBgAagIMMRGcghwAAAAASUVORK5CYII=',
        'base64',
      ),
      { mode: 0o600 },
    )
    worker = new Worker(join(__dirname, 'utility/image-codec-worker.js'), {
      workerData: { source, thumbnail },
    })
    const decoded = await new Promise<unknown>((accept, reject) => {
      timer = setTimeout(
        () => reject(new Error('Packaged image codec timed out.')),
        PACKAGE_SMOKE_TIMEOUT_MS,
      )
      worker!.once('message', accept)
      worker!.once('error', reject)
      worker!.once('exit', () =>
        reject(new Error('Packaged image codec exited before its receipt.')),
      )
    })
    const result = imageCodecResultSchema.parse(decoded)
    const preview = await readFile(thumbnail)
    if (
      result.mediaType !== 'image/png' ||
      result.width !== 2 ||
      result.height !== 2 ||
      result.thumbnailBytes !== preview.length ||
      preview.subarray(8, 12).toString('ascii') !== 'WEBP'
    )
      throw new Error('Packaged image codec returned an invalid thumbnail.')
  } finally {
    clearTimeout(timer)
    await worker?.terminate()
    await rm(directory, { recursive: true, force: true })
  }
}

/** Verify the shipped projection entry, its dependencies and complete credited pages. */
async function verifyPackagedMarkdownProjection(): Promise<void> {
  const worker = new Worker(join(__dirname, 'utility/markdown-projection-worker.js'), {
    resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16, stackSizeMb: 8 },
  })
  const deadline = Date.now() + PACKAGE_SMOKE_TIMEOUT_MS
  const request = (input: {
    type: 'append' | 'compile' | 'next'
    text?: string
  }): Promise<unknown> =>
    new Promise((accept, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        worker.removeListener('message', onMessage)
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
      }
      const onMessage = (value: unknown): void => {
        cleanup()
        accept(value)
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onExit = (): void => {
        cleanup()
        reject(new Error('Packaged projection exited before its receipt.'))
      }
      const timer = setTimeout(
        () => onError(new Error('Packaged projection timed out.')),
        Math.max(1, deadline - Date.now()),
      )
      worker.once('message', onMessage)
      worker.once('error', onError)
      worker.once('exit', onExit)
      worker.postMessage(input)
    })
  try {
    const text = `## Packaged plan\n\n${'Complete content. '.repeat(550)}\n\n[Reference][late]\n\n[late]: https://example.com\n`
    for (let offset = 0; offset < text.length; offset += 8192) {
      // oxlint-disable-next-line no-await-in-loop -- The next segment needs its physical credit.
      const ack = await request({ type: 'append', text: text.slice(offset, offset + 8192) })
      if (!ack || typeof ack !== 'object' || Reflect.get(ack, 'type') !== 'appended')
        throw new Error('Packaged projection rejected its source.')
    }
    let visible = ''
    for (let index = 0; index < 4; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Consume one credited page before asking for its successor.
      const reply = await request({ type: index === 0 ? 'compile' : 'next' })
      if (!reply || typeof reply !== 'object')
        throw new Error('Packaged projection returned no page.')
      if (Reflect.get(reply, 'type') === 'complete') {
        if (!visible.startsWith('Packaged plan') || !visible.endsWith('Reference'))
          throw new Error('Packaged projection lost complete source semantics.')
        return
      }
      if (Reflect.get(reply, 'type') !== 'page') throw new Error('Packaged projection failed.')
      visible += collaborationMarkdownPageSchema.parse(Reflect.get(reply, 'page')).visibleText
    }
    throw new Error('Packaged projection did not finish its bounded fixture.')
  } finally {
    await worker.terminate()
  }
}

function readPackagedSmokeIdentity() {
  if (!app.isPackaged) throw new Error('Package smoke must run from an Electron package.')
  const identity = readProductIdentity()
  const expectedBytes = process.env.PACT_PACKAGE_EXPECTED_IDENTITY
  if (!expectedBytes || expectedBytes.length > 4096)
    throw new Error('Package smoke requires bounded expected distribution identity.')
  const expected: unknown = JSON.parse(expectedBytes)
  if (!expected || typeof expected !== 'object')
    throw new Error('Package smoke distribution identity is invalid.')
  for (const [field, value] of Object.entries(identity)) {
    if (Reflect.get(expected, field) !== value)
      throw new Error(`Package smoke identity mismatch: ${field}.`)
  }
  if (
    Reflect.get(expected, 'platform') !== process.platform ||
    Reflect.get(expected, 'arch') !== process.arch ||
    app.getName() !== identity.productName
  ) {
    throw new Error('Package smoke runtime platform or application name is invalid.')
  }
  const configuredPaths = readConfiguredDefaultPaths()
  const defaultPaths = defaultProductPaths(identity)
  if (
    Object.entries(defaultPaths).some(
      ([field, value]) => Reflect.get(configuredPaths, field) !== value,
    )
  ) {
    throw new Error(
      'Packaged default profile/session/log paths do not match their channel identity.',
    )
  }
  const otherIdentity =
    identity.channel === 'dev'
      ? {
          ...identity,
          channel: 'stable' as const,
          productName: 'Pact' as const,
          appId: 'com.pact.desktop' as const,
        }
      : {
          ...identity,
          channel: 'dev' as const,
          productName: 'Pact Dev' as const,
          appId: 'com.pact.desktop.dev' as const,
        }
  const otherPaths = defaultProductPaths(otherIdentity)
  if (Object.values(defaultPaths).some((path) => Object.values(otherPaths).includes(path))) {
    throw new Error('Packaged Dev and Stable profile/session/log paths overlap.')
  }
  return {
    ...identity,
    platform: process.platform,
    arch: process.arch,
    defaultPaths,
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    logs: app.getPath('logs'),
  }
}

/** No Utility, database, provider, Renderer, or diagnostic Worker starts in this phase. */
export function completePackagedProductionPathProbe(): boolean {
  if (!isPackageSmoke() || process.env[PACKAGE_SMOKE_PHASE_ENV] !== 'production-paths') return false
  if (
    process.env.PACT_E2E_ROOT !== undefined ||
    process.env[PACKAGE_SMOKE_USER_DATA_ENV] !== undefined
  )
    throw new Error('Production path inspection cannot use an isolated profile override.')
  const identity = readPackagedSmokeIdentity()
  if (
    identity.userData !== identity.defaultPaths.userData ||
    identity.sessionData !== identity.defaultPaths.sessionData ||
    identity.logs !== identity.defaultPaths.logs
  )
    throw new Error('The actual production paths differ from their native channel defaults.')
  process.stdout.write(
    `PACT_PACKAGE_IDENTITY:${JSON.stringify({ ...identity, productionDataRootVerified: true })}\n`,
  )
  process.stdout.write('PACT_PACKAGE_SMOKE:PASS\n')
  app.exit(0)
  return true
}

export async function completePackagedSmoke(
  window: BrowserWindow,
  pageLoad: Promise<void>,
  utilityClient: UtilityProcessClient,
  appearanceSettings: AppearanceController,
): Promise<void> {
  process.stdout.write(`PACT_PACKAGE_IDENTITY:${JSON.stringify(readPackagedSmokeIdentity())}\n`)

  await pageLoad

  const rendererMounted = await waitForRendererMount(window)
  if (!rendererMounted) throw new Error('The packaged app did not mount its Renderer.')

  const health = await utilityClient.getHealth()
  if (!health.ok || health.value.status !== 'ready' || health.value.database !== 'ready') {
    throw new Error('The packaged utility runtime or database is unavailable.')
  }
  await verifyPackagedImageCodec()
  await verifyPackagedMarkdownProjection()

  const phase = process.env[PACKAGE_SMOKE_PHASE_ENV]
  const appearance = await appearanceSettings.refresh()
  if (!appearance.ok) throw new Error('Packaged appearance settings could not be read.')

  if (phase === 'seed') {
    if (
      appearance.value.requested.theme !== 'system' ||
      appearance.value.requested.windowMaterial !== 'system' ||
      appearance.value.requested.materialOpacity !== 85
    ) {
      throw new Error('Packaged appearance defaults are invalid.')
    }

    const seeded = await appearanceSettings.update({
      expectedRevision: appearance.value.requested.revision,
      theme: 'dark',
      windowMaterial: 'translucent',
      materialOpacity: 92,
    })
    if (!seeded.ok) throw new Error('Packaged appearance update failed.')
  } else if (phase === 'verify') {
    if (
      appearance.value.requested.theme !== 'dark' ||
      appearance.value.requested.windowMaterial !== 'translucent' ||
      appearance.value.requested.materialOpacity !== 92 ||
      !['solid', 'translucent'].includes(appearance.value.effective.windowMaterial)
    ) {
      throw new Error('Packaged appearance settings did not survive restart.')
    }
  } else {
    throw new Error('Packaged smoke phase is missing or invalid.')
  }

  process.stdout.write('PACT_PACKAGE_SMOKE:PASS\n')
  app.quit()
}
