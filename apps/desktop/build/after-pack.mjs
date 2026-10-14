import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

// electron-builder's Arch enum uses 3 for arm64. Keep this local so the packaging hook does not
// depend on electron-builder's internal utility package resolution.
const ELECTRON_BUILDER_ARM64 = 3
const ELECTRON_BUILDER_X64 = 1
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function afterPack(context) {
  const distribution = context.packager.info.metadata.pactDistribution
  if (!distribution || !['dev', 'stable'].includes(distribution.channel)) {
    throw new Error('Packaging requires the build-distribution entry point and a channel identity.')
  }
  const productFilename = context.packager.appInfo.productFilename
  const arch =
    context.arch === ELECTRON_BUILDER_ARM64
      ? 'arm64'
      : context.arch === ELECTRON_BUILDER_X64
        ? 'x64'
        : undefined
  if (
    !arch ||
    distribution.arch !== arch ||
    distribution.platform !== context.electronPlatformName ||
    distribution.appId !== context.packager.appInfo.id ||
    distribution.productName !== productFilename
  )
    throw new Error('Builder application identity differs from the requested distribution.')
  const isMac = context.electronPlatformName === 'darwin'
  const executablePath = isMac
    ? join(context.appOutDir, `${productFilename}.app`, 'Contents', 'MacOS', productFilename)
    : join(context.appOutDir, `${productFilename}.exe`)

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: isMac && context.arch === ELECTRON_BUILDER_ARM64,
    strictlyRequireAllFuses: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Pact does not generate browser_v8_context_snapshot.bin; use Electron's default snapshot.
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.WasmTrapHandlers]: true,
  })
  if (process.env.PACT_DISTRIBUTION_APPLICATION_RECORD) {
    const record = JSON.stringify({
      appPath: isMac ? join(context.appOutDir, `${productFilename}.app`) : context.appOutDir,
      executablePath,
      platform: context.electronPlatformName,
      arch,
    })
    if (Buffer.byteLength(record) > 16 * 1024)
      throw new Error('Distribution application record exceeds its byte bound.')
    await writeFile(process.env.PACT_DISTRIBUTION_APPLICATION_RECORD, record, {
      flag: 'wx',
      mode: 0o600,
    })
  }
}
