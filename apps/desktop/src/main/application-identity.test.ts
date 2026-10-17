import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import identities from '../../app-identities.json'
import { resolveApplicationIdentity } from './application-identity'
import { readProductIdentity } from './product-identity'
import {
  configureApplicationProfile,
  resolveRuntimePaths,
  readConfiguredDefaultPaths,
} from './utility-process/runtime-paths'

const native = vi.hoisted(() => ({ packaged: true, root: '', paths: {} as Record<string, string> }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return native.packaged
    },
    getAppPath: () => native.root,
    getVersion: () => '0.1.0',
    getPath: (name: string) => native.paths[name]!,
    setPath: (name: string, path: string) => {
      native.paths[name] = path
    },
    setAppLogsPath: (path: string) => {
      native.paths.logs = path
    },
  },
}))

beforeEach(() => {
  native.root = mkdtempSync(join(tmpdir(), 'pact-identity-integration-'))
  native.packaged = true
  native.paths = { appData: join(native.root, 'app-data'), temp: join(native.root, 'temp') }
  vi.stubEnv('PACT_E2E_ROOT', undefined)
  vi.stubEnv('PACT_PACKAGE_SMOKE', undefined)
  vi.stubEnv('NODE_ENV', 'development')
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(native.root, { recursive: true, force: true })
})

function metadata(profile: keyof typeof identities) {
  const identity = identities[profile]
  const value = {
    name: identity.packageName,
    productName: identity.name,
    version: '0.1.0',
    pactBuildProfile: profile,
  }
  writeFileSync(join(native.root, 'package.json'), JSON.stringify(value))
  return value
}

for (const profile of ['development-ci', 'production-ci'] as const) {
  it(`resolves ${profile} consistently from the CI producer metadata`, () => {
    const value = metadata(profile)
    const identity = identities[profile]
    const pactDistribution = {
      channel: profile === 'development-ci' ? 'dev' : 'stable',
      appId: identity.appId,
      productName: identity.name,
      smokeProtocolVersion: 2,
      platform: process.platform,
      arch: process.arch,
      sourceSha: 'a'.repeat(40),
      buildNumber: '12',
    }
    // Channel mapping also works without the legacy profile field.
    const { pactBuildProfile: _profile, ...unprofiled } = value
    writeFileSync(
      join(native.root, 'package.json'),
      JSON.stringify({ ...unprofiled, pactDistribution }),
    )
    expect(resolveApplicationIdentity()).toMatchObject({ kind: profile, ...identity })
    expect(readProductIdentity()).toMatchObject({
      productName: identity.name,
      appId: identity.appId,
      channel: pactDistribution.channel,
      sourceSha: pactDistribution.sourceSha,
    })
    configureApplicationProfile(resolveApplicationIdentity())
    const expectedRoot = join(
      native.root,
      'app-data',
      profile === 'development-ci' ? 'Pact Dev' : 'Pact',
    )
    expect(native.paths.userData).toBe(expectedRoot)
    expect(native.paths.sessionData).toBe(join(expectedRoot, 'electron-session'))
    expect(native.paths.logs).toBe(join(expectedRoot, 'logs'))
    expect(readConfiguredDefaultPaths().userData).toBe(expectedRoot)
    writeFileSync(
      join(native.root, 'package.json'),
      JSON.stringify({
        ...value,
        pactBuildProfile: profile === 'development-ci' ? 'production-ci' : 'development-ci',
        pactDistribution,
      }),
    )
    expect(() => resolveApplicationIdentity()).toThrow(/identity|identities/iu)
  })
}

it('retains local Production metadata and its existing default paths', () => {
  metadata('production-local')
  const identity = resolveApplicationIdentity()
  expect(readProductIdentity(identity)).toMatchObject({
    channel: 'stable',
    productName: 'Pact - Production - Local',
    sourceSha: undefined,
  })
  configureApplicationProfile(identity)
  const expected = join(native.root, 'app-data', 'Pact - Production - Local')
  expect(native.paths.userData).toBe(expected)
  expect(native.paths.sessionData).toBe(expected)
  expect(readConfiguredDefaultPaths().userData).toBe(expected)
  expect(existsSync(join(expected, 'pact.sqlite'))).toBe(false)
})

it('preserves local development SQLite and historical object roots', () => {
  native.packaged = false
  const identity = resolveApplicationIdentity()
  configureApplicationProfile(identity)
  expect(native.paths.userData).toMatch(/Pact - Development - Local[/\\][a-f0-9]{64}$/u)
  const paths = resolveRuntimePaths()
  expect(paths.databaseFile).toMatch(/[/\\]\.pact-data[/\\]dev[/\\]pact.sqlite$/u)
  expect(paths.workspaceStorageRoot).toMatch(
    /[/\\]Pact[/\\]workspace-versions-development[/\\][a-f0-9]{64}$/u,
  )
})

it('keeps fixture profiles private before creating normal channel paths', () => {
  native.packaged = false
  const rootPath = join(native.root, 'fixture')
  for (const name of ['electron-profile', 'electron-session', 'tmp'])
    mkdirSync(join(rootPath, name), { recursive: true })
  const root = realpathSync(rootPath)
  vi.stubEnv('PACT_E2E_ROOT', root)
  configureApplicationProfile(resolveApplicationIdentity())
  expect(native.paths.userData).toBe(join(root, 'electron-profile'))
  expect(native.paths.sessionData).toBe(join(root, 'electron-session'))
  expect(existsSync(join(native.root, 'app-data'))).toBe(false)
  expect(resolveRuntimePaths().databaseFile).toBe(join(root, 'pact.sqlite'))
})
