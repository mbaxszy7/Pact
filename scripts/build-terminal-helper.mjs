import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeMachoPreSignatureSha256 } from '../apps/desktop/build/agy-sqlite-file-resource.mjs'
import {
  TERMINAL_HELPER_PROTOCOL_VERSION,
  terminalHelperFilename,
  terminalHelperSourceHash,
} from '../apps/desktop/build/terminal-helper-resource.mjs'
import { runWindowsCompiler } from './run-windows-compiler.mjs'
import { prepareWindowsMsvcEnvironment } from './windows-msvc-environment.mjs'

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPTS_DIR, '..')
const DESKTOP_ROOT = join(REPO_ROOT, 'apps', 'desktop')
const OUT_DIR = join(DESKTOP_ROOT, 'out', 'native')

function parseArgs(argv) {
  let platform = process.platform
  let arch = process.arch
  let autoMsvc = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--platform' && argv[i + 1]) platform = argv[++i]
    else if (arg === '--arch' && argv[i + 1]) arch = argv[++i]
    else if (arg === '--auto-msvc') autoMsvc = true
  }
  return { platform, arch, autoMsvc }
}

function execBinary(executable, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
    })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${executable} exited with code ${code}`))
    })
  })
}

async function buildDarwin(arch) {
  const filename = terminalHelperFilename('darwin', arch)
  if (!filename) throw new Error(`Unsupported darwin arch: ${arch}`)
  const outPath = join(OUT_DIR, filename)
  const tmpOutPath = `${outPath}.tmp`
  const srcPath = join(DESKTOP_ROOT, 'native', 'terminal-darwin.c')
  const darwinArch = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : null
  if (!darwinArch) throw new Error(`Unsupported macOS architecture: ${arch}`)

  await mkdir(OUT_DIR, { recursive: true })
  await rm(tmpOutPath, { force: true })
  await execBinary('/usr/bin/cc', [
    '-arch',
    darwinArch,
    '-mmacosx-version-min=12.0',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-o',
    tmpOutPath,
    srcPath,
  ])
  await execBinary('/usr/bin/codesign', ['--force', '--sign', '-', tmpOutPath])

  const bytes = await readFile(tmpOutPath)
  const machoPreSignatureSha256 = computeMachoPreSignatureSha256(bytes, arch)
  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceSha256 = await terminalHelperSourceHash('darwin')

  const { rename } = await import('node:fs/promises')
  await rename(tmpOutPath, outPath)
  await writeFile(
    `${outPath}.json`,
    `${JSON.stringify(
      {
        protocolVersion: TERMINAL_HELPER_PROTOCOL_VERSION,
        platform: 'darwin',
        arch,
        filename,
        sourceSha256,
        binarySha256,
        binaryBytes: bytes.byteLength,
        machoPreSignatureSha256,
      },
      null,
      2,
    )}\n`,
  )
}

async function buildWin32(arch, autoMsvc) {
  const filename = terminalHelperFilename('win32', arch)
  if (!filename) throw new Error(`Unsupported win32 arch: ${arch}`)
  const outPath = join(OUT_DIR, filename)
  const srcPath = join(DESKTOP_ROOT, 'native', 'terminal-win32.cpp')
  const objPath = join(OUT_DIR, `terminal-win32-${arch}.obj`)
  const pdbPath = join(OUT_DIR, `terminal-win32-${arch}.pdb`)

  await mkdir(OUT_DIR, { recursive: true })
  const msvcEnv = autoMsvc ? await prepareWindowsMsvcEnvironment(arch) : process.env

  const clArgs = [
    '/nologo',
    '/std:c++20',
    '/O2',
    '/EHsc',
    '/W4',
    '/WX',
    '/guard:cf',
    '/DUNICODE',
    '/D_UNICODE',
    `/Fo:${objPath}`,
    srcPath,
    '/link',
    '/NOLOGO',
    '/DYNAMICBASE',
    '/NXCOMPAT',
    '/GUARD:CF',
    `/OUT:${outPath}`,
    'kernel32.lib',
    'user32.lib',
    'advapi32.lib',
  ]
  await runWindowsCompiler(clArgs, {
    cwd: OUT_DIR,
    env: msvcEnv,
    timeout: 60_000,
    maxBuffer: 256 * 1024,
  })

  await rm(objPath, { force: true })
  await rm(pdbPath, { force: true })

  const bytes = await readFile(outPath)
  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const sourceSha256 = await terminalHelperSourceHash('win32')
  await writeFile(
    `${outPath}.json`,
    `${JSON.stringify(
      {
        protocolVersion: TERMINAL_HELPER_PROTOCOL_VERSION,
        platform: 'win32',
        arch,
        filename,
        sourceSha256,
        binarySha256,
        binaryBytes: bytes.byteLength,
      },
      null,
      2,
    )}\n`,
  )
}

async function main() {
  const { platform, arch, autoMsvc } = parseArgs(process.argv.slice(2))
  if (platform === 'darwin') {
    await buildDarwin(arch)
    return
  }
  if (platform === 'win32') {
    await buildWin32(arch, autoMsvc)
    return
  }
  console.log(`Skipping terminal helper build on unsupported platform ${platform}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
