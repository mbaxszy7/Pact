import { app, type BrowserWindow } from 'electron'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { Worker } from 'node:worker_threads'

import {
  collaborationMarkdownPageSchema,
  sqliteFinalSchema,
  type SqliteFinal,
} from '@pact/contracts'
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
let soakInspection:
  | {
      receipt: string
      nonce: string
      port: number
      root: string
      rootDevice: bigint
      rootInode: bigint
      parentDevice: bigint
      parentInode: bigint
      finalWork?: Promise<void>
      startupReceipt?: string
    }
  | undefined
let soakStopTimer: NodeJS.Timeout | undefined
let soakStopTask: Promise<void> | undefined
let soakDisposed = false

export async function disposePackagedSoakInspection(): Promise<void> {
  const finalAtDisposal = soakInspection?.finalWork
  soakDisposed = true
  if (soakStopTimer) clearInterval(soakStopTimer)
  soakStopTimer = undefined
  await soakStopTask
  await finalAtDisposal?.catch(() => undefined)
}

async function readPackagedSoakStop(): Promise<void> {
  if (!soakInspection || soakDisposed) return
  const file = `${soakInspection.receipt}.stop`
  try {
    const stat = await lstat(file)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 256 ||
      (await realpath(file)) !== resolvePath(file)
    )
      throw new Error('Invalid packaged soak stop control.')
    const handle = await open(
      file,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    )
    let bytes: Buffer
    try {
      const contents = Buffer.alloc(257)
      const { bytesRead } = await handle.read(contents, 0, 257, 0)
      if (bytesRead > 256) throw new Error('Packaged soak stop control exceeds its byte bound.')
      bytes = contents.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    const stop: unknown = JSON.parse(bytes.toString('utf8'))
    if (
      !stop ||
      typeof stop !== 'object' ||
      Array.isArray(stop) ||
      Object.keys(stop).length !== 3 ||
      Reflect.get(stop, 'schemaVersion') !== 1 ||
      Reflect.get(stop, 'nonce') !== soakInspection.nonce ||
      Reflect.get(stop, 'mainPid') !== process.pid
    )
      throw new Error('Packaged soak stop identity does not match this process.')
    if (soakDisposed) return
    soakDisposed = true
    if (soakStopTimer) clearInterval(soakStopTimer)
    soakStopTimer = undefined
    app.quit()
  } catch (error) {
    if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'ENOENT') return
    soakDisposed = true
    if (soakStopTimer) clearInterval(soakStopTimer)
    soakStopTimer = undefined
    app.exit(1)
  }
}

/** The packaged harness can expose only an owned Renderer inspection surface on loopback. */
export function configurePackagedSoakInspection(): void {
  const receipt = process.env.PACT_SOAK_RECEIPT_FILE
  const nonce = process.env.PACT_SOAK_NONCE
  const rawPort = process.env.PACT_SOAK_CDP_PORT
  if (receipt === undefined && nonce === undefined && rawPort === undefined) return
  const root = process.env.PACT_E2E_ROOT
  if (
    !app.isPackaged ||
    !root ||
    Buffer.byteLength(root) > 4096 ||
    !isAbsolute(root) ||
    !receipt ||
    Buffer.byteLength(receipt) > 4096 ||
    !isAbsolute(receipt) ||
    !nonce ||
    !/^[a-f0-9]{64}$/u.test(nonce) ||
    !rawPort ||
    !/^\d{1,5}$/u.test(rawPort)
  )
    throw new Error(
      'Packaged soak requires an owned root and complete, bounded inspection identity.',
    )
  const canonicalRoot = realpathSync(root)
  const rootStat = lstatSync(canonicalRoot, { bigint: true })
  if (
    !rootStat.isDirectory() ||
    (process.platform !== 'win32' &&
      ((rootStat.mode & 0o077n) !== 0n ||
        (process.getuid && rootStat.uid !== BigInt(process.getuid()))))
  )
    throw new Error('Packaged soak root must be a private directory owned by this process user.')
  const parent = dirname(receipt)
  const remainder = relative(canonicalRoot, resolvePath(receipt))
  if (
    resolvePath(root) !== canonicalRoot ||
    resolvePath(receipt) !== receipt ||
    realpathSync(parent) !== resolvePath(parent) ||
    remainder === '..' ||
    !remainder ||
    remainder.startsWith('../') ||
    remainder.startsWith('..\\') ||
    isAbsolute(remainder) ||
    !lstatSync(parent).isDirectory()
  )
    throw new Error(
      'Packaged soak receipt must stay inside its canonical owned root without symbolic links.',
    )
  const port = Number(rawPort)
  if (port < 1 || port > 65_535)
    throw new Error('Packaged soak requires a valid loopback inspection port.')
  if (app.isReady())
    throw new Error('Packaged soak inspection must be configured before Electron readiness.')
  const parentStat = lstatSync(parent, { bigint: true })
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error('Packaged soak parent identity is invalid.')
  soakInspection = {
    receipt,
    nonce,
    port,
    root: canonicalRoot,
    rootDevice: rootStat.dev,
    rootInode: rootStat.ino,
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
  }
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1')
  app.commandLine.appendSwitch('remote-debugging-port', String(port))
}

export async function writePackagedSoakReceipt(
  window: BrowserWindow,
  pageLoad: Promise<void>,
): Promise<void> {
  if (!soakInspection) return
  await pageLoad
  const url = window.webContents.getURL()
  if (url !== 'app://bundle/index.html')
    throw new Error('Packaged soak Renderer is not the exact trusted application URL.')
  let timeout: NodeJS.Timeout | undefined
  let info: unknown
  try {
    window.webContents.debugger.attach('1.3')
    info = await Promise.race([
      window.webContents.debugger.sendCommand('Target.getTargetInfo'),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Packaged soak target identity deadline exceeded.')),
          5000,
        )
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
  }
  const targetInfo: unknown =
    info && typeof info === 'object' ? Reflect.get(info, 'targetInfo') : undefined
  if (!targetInfo || typeof targetInfo !== 'object')
    throw new Error('Packaged soak target information is missing.')
  const targetId: unknown =
    targetInfo && typeof targetInfo === 'object' ? Reflect.get(targetInfo, 'targetId') : undefined
  if (
    typeof targetId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(targetId) ||
    Reflect.get(targetInfo, 'url') !== url ||
    Reflect.get(targetInfo, 'type') !== 'page'
  )
    throw new Error('Packaged soak target identity is invalid.')
  const identity = readProductIdentity()
  const receipt = {
    schemaVersion: 1,
    nonce: soakInspection.nonce,
    mainPid: process.pid,
    windowId: window.id,
    webContentsId: window.webContents.id,
    targetId,
    port: soakInspection.port,
    sourceSha: identity.sourceSha,
    version: identity.version,
    channel: identity.channel,
    platform: process.platform,
    arch: process.arch,
    url,
  }
  const bytes = JSON.stringify(receipt)
  if (Buffer.byteLength(`${bytes}\n`) > 4096)
    throw new Error('Packaged soak receipt exceeds its byte bound.')
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), 5000)
  try {
    await writeFile(soakInspection.receipt, `${bytes}\n`, {
      flag: 'wx',
      mode: 0o600,
      signal: controller.signal,
    })
    soakInspection.startupReceipt = `${bytes}\n`
  } finally {
    clearTimeout(deadline)
  }
  soakStopTimer = setInterval(() => {
    if (soakStopTask || soakDisposed) return
    soakStopTask = readPackagedSoakStop().finally(() => {
      soakStopTask = undefined
    })
  }, 250)
}

/** The existing fixture owner seals a separate private receipt after the Utility closes storage. */
export async function writePackagedSoakSqliteFinal(final: SqliteFinal | undefined): Promise<void> {
  const inspection = soakInspection
  if (!inspection) return
  const parsed = sqliteFinalSchema.safeParse(final)
  if (!parsed.success || !inspection.startupReceipt || inspection.finalWork)
    throw new Error('Packaged soak final SQLite receipt could not be written.')
  const controller = new AbortController()
  let deadline: NodeJS.Timeout | undefined
  const parent = dirname(inspection.receipt)
  const checkParent = async (): Promise<void> => {
    controller.signal.throwIfAborted()
    const root = await lstat(inspection.root, { bigint: true })
    controller.signal.throwIfAborted()
    const parentInfo = await lstat(parent, { bigint: true })
    controller.signal.throwIfAborted()
    const canonicalRoot = await realpath(inspection.root)
    controller.signal.throwIfAborted()
    const canonicalParent = await realpath(parent)
    controller.signal.throwIfAborted()
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.dev !== inspection.rootDevice ||
      root.ino !== inspection.rootInode ||
      !parentInfo.isDirectory() ||
      parentInfo.isSymbolicLink() ||
      parentInfo.dev !== inspection.parentDevice ||
      parentInfo.ino !== inspection.parentInode ||
      canonicalRoot !== inspection.root ||
      canonicalParent !== resolvePath(parent) ||
      (process.platform !== 'win32' &&
        ((root.mode & 0o077n) !== 0n || (process.getuid && root.uid !== BigInt(process.getuid()))))
    )
      throw new Error('Private receipt directory identity changed')
  }
  const work = (async () => {
    await checkParent()
    const startupInfo = await lstat(inspection.receipt, { bigint: true })
    controller.signal.throwIfAborted()
    if (
      !startupInfo.isFile() ||
      startupInfo.isSymbolicLink() ||
      startupInfo.nlink !== 1n ||
      startupInfo.size > 4096n
    )
      throw new Error('Startup receipt identity invalid')
    const startup = await open(
      inspection.receipt,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    )
    try {
      controller.signal.throwIfAborted()
      const info = await startup.stat({ bigint: true })
      controller.signal.throwIfAborted()
      if (
        info.dev !== startupInfo.dev ||
        info.ino !== startupInfo.ino ||
        info.nlink !== 1n ||
        !info.isFile()
      )
        throw new Error('Startup receipt descriptor identity invalid')
      const contents = Buffer.alloc(4097)
      const { bytesRead } = await startup.read(contents, 0, contents.length, 0)
      controller.signal.throwIfAborted()
      if (
        bytesRead > 4096 ||
        contents.subarray(0, bytesRead).toString('utf8') !== inspection.startupReceipt
      )
        throw new Error('Startup receipt contents changed')
    } finally {
      await startup.close()
    }
    controller.signal.throwIfAborted()
    const identity = readProductIdentity()
    const startupIdentity: unknown = JSON.parse(inspection.startupReceipt)
    if (
      !startupIdentity ||
      typeof startupIdentity !== 'object' ||
      Reflect.get(startupIdentity, 'nonce') !== inspection.nonce ||
      Reflect.get(startupIdentity, 'mainPid') !== process.pid ||
      Reflect.get(startupIdentity, 'sourceSha') !== identity.sourceSha ||
      Reflect.get(startupIdentity, 'version') !== identity.version ||
      Reflect.get(startupIdentity, 'channel') !== identity.channel ||
      Reflect.get(startupIdentity, 'platform') !== process.platform ||
      Reflect.get(startupIdentity, 'arch') !== process.arch
    )
      throw new Error('Final application identity changed')
    const bytes =
      JSON.stringify({
        schemaVersion: 1,
        nonce: inspection.nonce,
        mainPid: process.pid,
        utilityPid: parsed.data.observerPid,
        sourceSha: identity.sourceSha,
        version: identity.version,
        channel: identity.channel,
        platform: process.platform,
        arch: process.arch,
        sqliteFinal: parsed.data,
      }) + '\n'
    if (Buffer.byteLength(bytes) > 32 * 1024) throw new Error('Final receipt byte limit')
    await checkParent()
    const file = inspection.receipt + '.sqlite-final'
    const handle = await open(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
      0o600,
    )
    try {
      controller.signal.throwIfAborted()
      const descriptor = await handle.stat({ bigint: true })
      await checkParent()
      const current = await lstat(file, { bigint: true })
      controller.signal.throwIfAborted()
      if (
        !descriptor.isFile() ||
        descriptor.nlink !== 1n ||
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.dev !== descriptor.dev ||
        current.ino !== descriptor.ino ||
        current.nlink !== 1n
      )
        throw new Error('Final receipt descriptor identity invalid')
      // A late path replacement cannot redirect this already verified descriptor.
      await handle.writeFile(bytes, { signal: controller.signal })
      controller.signal.throwIfAborted()
      const written = await handle.stat({ bigint: true })
      await checkParent()
      const published = await lstat(file, { bigint: true })
      controller.signal.throwIfAborted()
      if (
        written.size !== BigInt(Buffer.byteLength(bytes)) ||
        published.dev !== written.dev ||
        published.ino !== written.ino ||
        published.nlink !== 1n
      )
        throw new Error('Final receipt publication identity changed')
    } finally {
      await handle.close()
    }
  })()
  // Timeout is a bounded failure wait, not a claim of physical file-operation
  // release. The one operation stays owned until its finally closes the handles.
  inspection.finalWork = work
  void work.catch(() => undefined)
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          controller.abort()
          reject(new Error('Final receipt deadline'))
        }, 5000)
      }),
    ])
  } catch {
    throw new Error('Packaged soak final SQLite receipt could not be written.')
  } finally {
    clearTimeout(deadline)
  }
}

export function isPackagedSoakInspection(): boolean {
  return soakInspection !== undefined
}

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
