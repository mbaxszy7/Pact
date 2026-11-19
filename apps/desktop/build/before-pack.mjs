import { prepareWindowsOwnedProcessResource } from './windows-owned-process-resource.mjs'

/** All package entry points share the same native build preparation. */
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'win32') return
  const arch = context.arch === 3 ? 'arm64' : context.arch === 1 ? 'x64' : undefined
  await prepareWindowsOwnedProcessResource(arch)
}
