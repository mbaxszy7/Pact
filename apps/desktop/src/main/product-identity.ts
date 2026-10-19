import { app } from 'electron'
import { join } from 'node:path'

import identities from '../../app-identities.json'
import desktopPackage from '../../package.json'
import { resolveApplicationIdentity, type ApplicationIdentity } from './application-identity'

export interface ProductIdentity {
  smokeProtocolVersion: 2
  channel: 'dev' | 'stable'
  productName: string
  appId: string
  version: string
  sourceSha: string | undefined
  buildNumber: string | undefined
}

/** Packaged channel comes from the package, never a launch-time environment override. */
export function readProductIdentity(
  identity: ApplicationIdentity = resolveApplicationIdentity(),
): ProductIdentity {
  if (app.isPackaged && identity.kind.endsWith('-ci') && !identity.distribution)
    throw new Error('Packaged distribution identity is missing.')
  return {
    smokeProtocolVersion: 2,
    channel:
      identity.distribution?.channel ??
      (identity.kind.startsWith('production-') ? 'stable' : 'dev'),
    productName: identity.name,
    appId: identity.appId,
    version:
      identity.distribution?.version ??
      (app.isPackaged ? app.getVersion() : desktopPackage.version),
    sourceSha: identity.distribution?.sourceSha,
    buildNumber: identity.distribution?.buildNumber,
  }
}

export function defaultProductPaths(
  identity: ProductIdentity,
  repositoryIdentity?: string,
): {
  userData: string
  sessionData: string
  logs: string
} {
  const entry = Object.entries(identities).find(
    ([, value]) => value.name === identity.productName && value.appId === identity.appId,
  )
  if (!entry) throw new Error('Unknown product profile.')
  const [kind, profile] = entry
  if (kind === 'development-local' && !repositoryIdentity)
    throw new Error('Local development requires repository identity.')
  const userData = join(
    app.getPath('appData'),
    profile.profileDirectory,
    ...(kind === 'development-local' ? [repositoryIdentity!] : []),
  )
  return {
    userData,
    sessionData: kind.endsWith('-local') ? userData : join(userData, 'electron-session'),
    logs: join(userData, 'logs'),
  }
}
