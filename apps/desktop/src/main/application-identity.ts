import { app } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import identities from '../../app-identities.json'

export interface ApplicationIdentity {
  readonly kind: keyof typeof identities
  readonly name: string
  readonly appId: string
  readonly packageName: string
  readonly profileDirectory: string
  readonly distribution?: {
    readonly channel: 'dev' | 'stable'
    readonly version: string
    readonly sourceSha: string
    readonly buildNumber: string
  }
}

/** Profiles select storage first; only development's Windows Shell ID is repository scoped. */
export function resolveNativeApplicationIdentity(
  identity: ApplicationIdentity,
): ApplicationIdentity {
  if (process.platform !== 'win32' || app.isPackaged) return identity
  const profile = resolve(app.getPath('userData')).toLowerCase()
  const suffix = createHash('sha256').update(profile).digest('hex')
  return Object.freeze({ ...identity, appId: `${identity.appId}.${suffix}` })
}

function isIdentityKind(value: unknown): value is keyof typeof identities {
  return typeof value === 'string' && Object.hasOwn(identities, value)
}

/** Packaged identity belongs to the immutable package, never the launch environment. */
export function resolveApplicationIdentity(): ApplicationIdentity {
  if (!app.isPackaged)
    return Object.freeze({ kind: 'development-local' as const, ...identities['development-local'] })

  const metadataPath = join(app.getAppPath(), 'package.json')
  if (statSync(metadataPath).size > 16 * 1024) throw new Error('Package metadata is too large.')
  const metadata: unknown = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Invalid package identity metadata.')
  const profile: unknown = Reflect.get(metadata, 'pactBuildProfile')
  const packageName: unknown = Reflect.get(metadata, 'name')
  const productName: unknown = Reflect.get(metadata, 'productName')
  const distribution: unknown = Reflect.get(metadata, 'pactDistribution')
  let distributedKind: 'development-ci' | 'production-ci' | undefined
  if (distribution !== undefined) {
    if (!distribution || typeof distribution !== 'object' || Array.isArray(distribution))
      throw new Error('Invalid distribution identity metadata.')
    const channel: unknown = Reflect.get(distribution, 'channel')
    if (channel !== 'dev' && channel !== 'stable') throw new Error('Unknown distribution channel.')
    distributedKind = channel === 'dev' ? 'development-ci' : 'production-ci'
  }
  const kind = profile ?? distributedKind ?? 'production-ci'
  if (!isIdentityKind(kind)) throw new Error('Unknown package identity.')
  const identity = identities[kind]
  if (
    distribution !== undefined &&
    (kind.startsWith('production-') !== (distributedKind === 'production-ci') ||
      Reflect.get(distribution, 'appId') !== identity.appId ||
      Reflect.get(distribution, 'productName') !== identity.name)
  )
    throw new Error('Distribution and application profile identities differ.')
  if (
    packageName !== identity.packageName ||
    (productName !== undefined && productName !== identity.name)
  )
    throw new Error('Package identity metadata does not match the application.')
  if (distribution === undefined) return Object.freeze({ kind, ...identity })
  const sourceSha: unknown = Reflect.get(distribution, 'sourceSha')
  const buildNumber: unknown = Reflect.get(distribution, 'buildNumber')
  const version: unknown = Reflect.get(metadata, 'version')
  const channel = distributedKind === 'development-ci' ? 'dev' : 'stable'
  if (
    Reflect.get(distribution, 'smokeProtocolVersion') !== 2 ||
    Reflect.get(distribution, 'platform') !== process.platform ||
    Reflect.get(distribution, 'arch') !== process.arch ||
    typeof sourceSha !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(sourceSha) ||
    typeof buildNumber !== 'string' ||
    !/^\d{1,16}$/u.test(buildNumber) ||
    typeof version !== 'string' ||
    version !== app.getVersion()
  )
    throw new Error('Packaged distribution identity does not match this runtime.')
  return Object.freeze({
    kind,
    ...identity,
    distribution: Object.freeze({ channel, version, sourceSha, buildNumber }),
  })
}
