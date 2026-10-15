import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import identities from '../../app-identities.json'
import {
  resolveApplicationIdentity,
  resolveNativeApplicationIdentity,
} from './application-identity.js'

const native = vi.hoisted(() => ({ packaged: false, path: '', profile: 'C:/Pact/profile-a' }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return native.packaged
    },
    getAppPath: () => native.path,
    getPath: () => native.profile,
  },
}))
const directories: string[] = []
beforeEach(() => {
  native.packaged = false
  native.profile = 'C:/Pact/profile-a'
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

async function metadata(value: unknown) {
  native.path = await mkdtemp(join(tmpdir(), 'pact-identity-'))
  directories.push(native.path)
  await writeFile(join(native.path, 'package.json'), JSON.stringify(value))
  native.packaged = true
}

describe('Application identity isolation', () => {
  it('keeps local development distinct and selects packaged identities only from validated metadata', async () => {
    vi.stubEnv('PACT_BUILD_PROFILE', 'production-ci')
    expect(resolveApplicationIdentity()).toMatchObject({
      kind: 'development-local',
      name: 'Pact - Development - Local',
    })
    await metadata({
      name: identities['production-local'].packageName,
      productName: identities['production-local'].name,
      pactBuildProfile: 'production-local',
    })
    const identity = resolveApplicationIdentity()
    expect(identity).toMatchObject({ kind: 'production-local', name: 'Pact - Production - Local' })
    expect(Object.isFrozen(identity)).toBe(true)
  })

  it('preserves the official CI identity and reserves four unique application/profile identities', async () => {
    await metadata({ name: '@pact/desktop' })
    expect(resolveApplicationIdentity()).toMatchObject({
      kind: 'production-ci',
      name: 'Pact',
      appId: 'com.pact.desktop',
    })
    const kinds = [
      'development-local',
      'production-local',
      'development-ci',
      'production-ci',
    ] as const
    for (const field of ['appId', 'packageName', 'profileDirectory'] as const)
      expect(new Set(kinds.map((kind) => identities[kind][field])).size).toBe(4)
  })

  it.each([
    { name: '@pact/desktop', pactBuildProfile: '../other' },
    { name: '@pact/desktop', pactBuildProfile: 'production-local' },
    { name: 'pact-production-local', pactBuildProfile: 'production-local', productName: 'Pact' },
  ])('rejects mismatched package metadata: %j', async (input) => {
    await metadata(input)
    expect(() => resolveApplicationIdentity()).toThrow(/identity/)
  })

  it('scopes Windows development shell identity to the repository profile while keeping packaged/macOS IDs stable', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const identity = resolveApplicationIdentity(),
      first = resolveNativeApplicationIdentity(identity)
    native.profile = 'C:/Pact/profile-b'
    expect(resolveNativeApplicationIdentity(identity).appId).not.toBe(first.appId)
    expect(first.profileDirectory).toBe(identity.profileDirectory)
    native.packaged = true
    expect(resolveNativeApplicationIdentity(identity)).toBe(identity)
    native.packaged = false
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(resolveNativeApplicationIdentity(identity)).toBe(identity)
  })
})
