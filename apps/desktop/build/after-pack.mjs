import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'

// electron-builder's Arch enum uses 3 for arm64. Keep this local so the packaging hook does not
// depend on electron-builder's internal utility package resolution.
const ELECTRON_BUILDER_ARM64 = 3
import { join } from 'node:path'

export default async function afterPack(context) {
  const productFilename = context.packager.appInfo.productFilename
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
}
