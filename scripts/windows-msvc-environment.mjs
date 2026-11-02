import { join } from 'node:path'

import { runWindowsCompilerSetup, WindowsCompilerError } from './run-windows-compiler.mjs'

const environmentKeys = ['PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH']
const setupScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { exit 2 }
$target = $env:PACT_MSVC_TARGET_ARCH
$component = if ($target -eq 'arm64') { 'ARM64' } else { 'x86.x64' }
$installation = & $vswhere -utf8 -latest -products '*' -requires "Microsoft.VisualStudio.Component.VC.Tools.$component" -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $installation) { exit 3 }
$module = Join-Path $installation 'Common7\Tools\Microsoft.VisualStudio.DevShell.dll'
Import-Module $module
# VsDevShell captures cmd.exe output; keep inherited Unicode paths out of that round trip.
$inheritedPath = $env:PATH
$env:PATH = @(
  (Join-Path $env:SystemRoot 'System32'),
  $env:SystemRoot,
  (Join-Path $env:SystemRoot 'System32\Wbem'),
  (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0')
) -join ';'
Enter-VsDevShell -VsInstallPath $installation -SkipAutomaticLocation -DevCmdArguments "-no_logo -arch=$target -host_arch=$target" 6>$null | Out-Null
$env:PATH = $env:PATH + ';' + $inheritedPath
$values = [ordered]@{}
foreach ($key in @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH')) {
  $values[$key] = [string][Environment]::GetEnvironmentVariable($key, 'Process')
}
[Console]::Out.Write((ConvertTo-Json -InputObject $values -Compress))
`

/** Build-only environment discovery; never changes the calling shell or process.env. */
export async function prepareWindowsMsvcEnvironment(
  arch,
  { env = process.env, deadlineAt = performance.now() + 60_000, signal } = {},
) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported MSVC target architecture.')
  const target = env.VSCMD_ARG_TGT_ARCH?.toLowerCase()
  if (target && target !== arch)
    throw new Error('The active MSVC target does not match this native runner.')
  signal?.throwIfAborted()
  const timeout = Math.floor(deadlineAt - performance.now())
  if (!Number.isFinite(timeout) || timeout < 1)
    throw new Error('MSVC environment preparation exceeded the build deadline.')
  if (target && env.INCLUDE && env.LIB) return env

  const powershell = join(
    env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe',
  )
  let loaded
  try {
    // Reuse the compiler's Job owner for setup, including VsDevShell's descendants.
    const result = await runWindowsCompilerSetup(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(setupScript, 'utf16le').toString('base64'),
      ],
      {
        cwd: import.meta.dirname,
        env: { ...env, PACT_MSVC_TARGET_ARCH: arch },
        timeout: Math.min(timeout, 60_000),
        maxBuffer: 64 * 1024,
        signal,
      },
    )
    loaded = JSON.parse(result.stdout)
    if (
      !loaded ||
      typeof loaded !== 'object' ||
      Object.keys(loaded).length !== environmentKeys.length ||
      environmentKeys.some(
        (key) => typeof loaded[key] !== 'string' || loaded[key].includes('\0'),
      ) ||
      !loaded.PATH ||
      !loaded.INCLUDE ||
      !loaded.LIB ||
      loaded.VSCMD_ARG_TGT_ARCH.toLowerCase() !== arch
    )
      throw new Error('Invalid MSVC environment receipt.')
  } catch (error) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- Parser errors may include environment values; retain only bounded compiler facts.
    throw new Error(
      'Could not load the MSVC environment. Install Visual Studio Build Tools with Desktop development with C++ and the Windows SDK for this architecture, or use a matching Developer PowerShell.',
      { cause: error instanceof WindowsCompilerError ? error : undefined },
    )
  }
  // Windows environment names are case-insensitive; never retain a stale Path beside PATH.
  const inherited = Object.entries(env).filter(
    ([key]) => !environmentKeys.includes(key.toUpperCase()),
  )
  return { ...Object.fromEntries(inherited), ...loaded }
}
