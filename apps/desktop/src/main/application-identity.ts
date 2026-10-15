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
  const kind = profile === undefined ? 'production-ci' : profile
  if (!isIdentityKind(kind)) throw new Error('Unknown package identity.')
  const identity = identities[kind]
  if (
    packageName !== identity.packageName ||
    (productName !== undefined && productName !== identity.name)
  )
    throw new Error('Package identity metadata does not match the application.')
  return Object.freeze({ kind, ...identity })
}
