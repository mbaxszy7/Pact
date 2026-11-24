import { prepareAgySqliteFileResource } from './agy-sqlite-file-resource.mjs'
import { prepareTerminalHelperResource } from './terminal-helper-resource.mjs'
import { prepareWindowsOwnedProcessResource } from './windows-owned-process-resource.mjs'

/** All package entry points share the same native build preparation. */
export default async function beforePack(context) {
  const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : undefined
  if (context.electronPlatformName === 'win32') {
    await prepareWindowsOwnedProcessResource(arch)
    await prepareAgySqliteFileResource(arch, 'win32')
    await prepareTerminalHelperResource(arch, 'win32')
    return
  }
  if (
    context.electronPlatformName === process.platform &&
    arch !== undefined &&
    arch === process.arch
  ) {
    await prepareAgySqliteFileResource(arch, context.electronPlatformName)
    await prepareTerminalHelperResource(arch, context.electronPlatformName)
  }
}
