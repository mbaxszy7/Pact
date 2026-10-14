import { app } from 'electron'
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface ProductIdentity {
  smokeProtocolVersion: 2
  channel: 'dev' | 'stable'
  productName: 'Pact Dev' | 'Pact'
  appId: 'com.pact.desktop.dev' | 'com.pact.desktop'
  version: string
  sourceSha: string | undefined
  buildNumber: string | undefined
}

const identities = {
  dev: { productName: 'Pact Dev', appId: 'com.pact.desktop.dev' },
  stable: { productName: 'Pact', appId: 'com.pact.desktop' },
} as const

let configuredDefaultPaths: ReturnType<typeof defaultProductPaths> | undefined

/** Packaged channel comes from the package, never a launch-time environment override. */
export function readProductIdentity(): ProductIdentity {
  if (!app.isPackaged) {
    return {
      smokeProtocolVersion: 2,
      channel: 'dev',
      ...identities.dev,
      version: app.getVersion(),
      sourceSha: undefined,
      buildNumber: undefined,
    }
  }
  const packagePath = join(app.getAppPath(), 'package.json')
  if (statSync(packagePath).size > 64 * 1024)
    throw new Error('Packaged product metadata exceeds its bound.')
  const bytes = readFileSync(packagePath)
  const metadata: unknown = JSON.parse(bytes.toString('utf8'))
  if (!metadata || typeof metadata !== 'object')
    throw new Error('Packaged product metadata is missing.')
  const distribution: unknown = Reflect.get(metadata, 'pactDistribution')
  if (!distribution || typeof distribution !== 'object')
    throw new Error('Packaged distribution identity is missing.')
  const channel: unknown = Reflect.get(distribution, 'channel')
  if (channel !== 'dev' && channel !== 'stable')
    throw new Error('Packaged distribution channel is invalid.')
  const expected = identities[channel]
  const sourceSha: unknown = Reflect.get(distribution, 'sourceSha')
  const buildNumber: unknown = Reflect.get(distribution, 'buildNumber')
  if (
    Reflect.get(distribution, 'appId') !== expected.appId ||
    Reflect.get(distribution, 'productName') !== expected.productName ||
    Reflect.get(distribution, 'smokeProtocolVersion') !== 2 ||
    Reflect.get(distribution, 'platform') !== process.platform ||
    Reflect.get(distribution, 'arch') !== process.arch ||
    typeof sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    typeof buildNumber !== 'string' ||
    !/^\d{1,16}$/u.test(buildNumber) ||
    Reflect.get(metadata, 'version') !== app.getVersion()
  )
    throw new Error('Packaged distribution identity does not match this runtime.')
  return {
    smokeProtocolVersion: 2,
    channel,
    ...expected,
    version: app.getVersion(),
    sourceSha,
    buildNumber,
  }
}

export function defaultProductPaths(identity: ProductIdentity): {
  userData: string
  sessionData: string
  logs: string
} {
  const userData = join(app.getPath('appData'), identity.productName)
  return { userData, sessionData: join(userData, 'electron-session'), logs: join(userData, 'logs') }
}

/** Main configures these before readiness, any Chromium session, or its single-instance lock. */
export function configureProductIdentity(identity: ProductIdentity): void {
  app.setName(identity.productName)
  const isolatedRoot = process.env.PACT_E2E_ROOT
  if (isolatedRoot !== undefined) {
    if (!isolatedRoot || !isAbsolute(isolatedRoot))
      throw new Error('An isolated product profile requires an existing absolute private root.')
    const appData = join(realpathSync(isolatedRoot), 'channel-app-data')
    mkdirSync(appData, { recursive: true, mode: 0o700 })
    app.setPath('appData', appData)
  }
  const paths = defaultProductPaths(identity)
  mkdirSync(paths.sessionData, { recursive: true, mode: 0o700 })
  app.setPath('userData', paths.userData)
  app.setPath('sessionData', paths.sessionData)
  app.setAppLogsPath(paths.logs)
  configuredDefaultPaths = {
    userData: app.getPath('userData'),
    sessionData: app.getPath('sessionData'),
    logs: app.getPath('logs'),
  }
}

export function readConfiguredDefaultPaths(): ReturnType<typeof defaultProductPaths> {
  if (!configuredDefaultPaths) throw new Error('Product paths have not been configured.')
  return configuredDefaultPaths
}
