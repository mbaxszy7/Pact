import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  agySqliteFileResourcePrefix,
  computeMachoPreSignatureSha256,
} from './agy-sqlite-file-resource.mjs'

const BUILD_DIR = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(BUILD_DIR, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')

export const TERMINAL_HELPER_PROTOCOL_VERSION = 1

export function terminalHelperFilename(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `terminal-darwin-${arch}`
  if (platform === 'win32') return `terminal-win32-${arch}.exe`
  return null
}

export function terminalHelperResourcePrefix(platform = process.platform) {
  return agySqliteFileResourcePrefix(platform)
}

export async function terminalHelperSourceHash(platform = process.platform) {
  const sourceFile =
    platform === 'win32'
      ? join(DESKTOP_ROOT, 'native', 'terminal-win32.cpp')
      : join(DESKTOP_ROOT, 'native', 'terminal-darwin.c')
  const sourceBytes = await readFile(sourceFile)
  return createHash('sha256').update(sourceBytes).digest('hex')
}

function verifyPe32PlusExecutableHeader(bytes, arch) {
  if (bytes.length < 0x100 || bytes.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Windows terminal helper binary is missing the MZ header.')
  }
  const peOffset = bytes.readUInt32LE(0x3c)
  if (peOffset + 24 + 96 >= bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('Windows terminal helper binary is missing the PE signature.')
  }
  const machine = bytes.readUInt16LE(peOffset + 4)
  const expectedMachine = arch === 'x64' ? 0x8664 : arch === 'arm64' ? 0xaa64 : null
  if (!expectedMachine || machine !== expectedMachine) {
    throw new Error(
      `Windows terminal helper binary machine 0x${machine.toString(16)} does not match ${arch}.`,
    )
  }
  const characteristics = bytes.readUInt16LE(peOffset + 22)
  if ((characteristics & 0x0002) === 0 || (characteristics & 0x2000) !== 0) {
    throw new Error('Windows terminal helper binary must be an executable image (not a DLL).')
  }
  const optionalMagic = bytes.readUInt16LE(peOffset + 24)
  if (optionalMagic !== 0x20b) {
    throw new Error('Windows terminal helper binary is not PE32+.')
  }
  const dllCharacteristics = bytes.readUInt16LE(peOffset + 24 + 70)
  if ((dllCharacteristics & 0x4000) === 0) {
    throw new Error('Windows terminal helper binary is missing Control Flow Guard (/guard:cf).')
  }
}

export async function verifyTerminalHelperBinaryHeader(bytes, platform, arch) {
  if (platform === 'win32') {
    verifyPe32PlusExecutableHeader(bytes, arch)
    return { machoPreSignatureSha256: undefined }
  }
  if (platform === 'darwin') {
    if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
      throw new Error('macOS terminal helper binary is not a valid 64-bit Mach-O file.')
    }
    const filetype = bytes.readUInt32LE(12)
    if (filetype !== 0x2) {
      throw new Error(
        `macOS terminal helper must be MH_EXECUTE (0x2), got 0x${filetype.toString(16)}.`,
      )
    }
    return { machoPreSignatureSha256: computeMachoPreSignatureSha256(bytes, arch) }
  }
  throw new Error(`Unsupported terminal helper platform: ${platform}`)
}

async function runCheckLoad(executablePath, signal) {
  const result = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executablePath, ['--check-load'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      signal,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`Terminal helper load check timed out: ${executablePath}`))
    }, 5_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.once('close', (code, termSignal) => {
      clearTimeout(timer)
      if (code !== 0) {
        rejectPromise(
          new Error(
            `Terminal helper load check failed (${code ?? termSignal}): ${stderr.trim() || executablePath}`,
          ),
        )
        return
      }
      resolvePromise(stdout)
    })
  })
  let parsed
  try {
    parsed = JSON.parse(result.trim())
  } catch {
    throw new Error(`Terminal helper load check returned invalid JSON: ${executablePath}`)
  }
  if (
    !parsed ||
    parsed.ok !== true ||
    parsed.protocolVersion !== TERMINAL_HELPER_PROTOCOL_VERSION
  ) {
    throw new Error(`Terminal helper load check rejected payload: ${executablePath}`)
  }
}

export async function inspectTerminalHelperResource(
  nativeDirectory,
  platform,
  arch,
  expectedSourceSha256,
  { verifyLoad = false, allowSignedBinary = false, signal } = {},
) {
  const filename = terminalHelperFilename(platform, arch)
  if (!filename) return null

  const executablePath = join(nativeDirectory, filename)
  const metadataPath = `${executablePath}.json`

  const [execStat, metaStat] = await Promise.all([
    lstat(executablePath).catch(() => null),
    lstat(metadataPath).catch(() => null),
  ])
  if (!execStat || !execStat.isFile() || execStat.isSymbolicLink()) {
    throw new Error(`Missing or invalid terminal helper binary: ${executablePath}`)
  }
  if (!metaStat || !metaStat.isFile() || metaStat.isSymbolicLink()) {
    throw new Error(`Missing or invalid terminal helper metadata: ${metadataPath}`)
  }

  const [bytes, metaRaw] = await Promise.all([
    readFile(executablePath),
    readFile(metadataPath, 'utf8'),
  ])
  const meta = JSON.parse(metaRaw)
  if (
    !meta ||
    meta.protocolVersion !== TERMINAL_HELPER_PROTOCOL_VERSION ||
    meta.platform !== platform ||
    meta.arch !== arch ||
    meta.filename !== filename ||
    meta.sourceSha256 !== expectedSourceSha256
  ) {
    throw new Error(`Stale terminal helper metadata at ${metadataPath}. Run build:terminal-helper.`)
  }

  const binarySha256 = createHash('sha256').update(bytes).digest('hex')
  const { machoPreSignatureSha256 } = await verifyTerminalHelperBinaryHeader(bytes, platform, arch)

  if (
    typeof meta.binaryBytes === 'number' &&
    meta.binaryBytes !== bytes.byteLength &&
    !allowSignedBinary
  ) {
    throw new Error(`Terminal helper binary size mismatch at ${executablePath}.`)
  }
  if (platform === 'darwin') {
    if (
      typeof meta.machoPreSignatureSha256 !== 'string' ||
      meta.machoPreSignatureSha256 !== machoPreSignatureSha256
    ) {
      throw new Error(`macOS terminal helper Mach-O signature mismatch at ${executablePath}.`)
    }
    if (!allowSignedBinary && meta.binarySha256 !== binarySha256) {
      throw new Error(`macOS terminal helper binary hash mismatch at ${executablePath}.`)
    }
  } else if (meta.binarySha256 !== binarySha256) {
    throw new Error(`Terminal helper binary hash mismatch at ${executablePath}.`)
  }

  if (verifyLoad) {
    await runCheckLoad(executablePath, signal)
  }

  return {
    protocolVersion: TERMINAL_HELPER_PROTOCOL_VERSION,
    platform,
    arch,
    filename,
    sourceSha256: expectedSourceSha256,
    binarySha256,
    binaryBytes: bytes.byteLength,
    ...(machoPreSignatureSha256 ? { machoPreSignatureSha256 } : {}),
  }
}

export async function prepareTerminalHelperResource(
  arch = process.arch,
  platform = process.platform,
  { signal, autoMsvc = false } = {},
) {
  const filename = terminalHelperFilename(platform, arch)
  if (!filename) return null

  const outDir = join(DESKTOP_ROOT, 'out', 'native')
  const expectedSource = await terminalHelperSourceHash(platform)
  try {
    return await inspectTerminalHelperResource(outDir, platform, arch, expectedSource, {
      verifyLoad: platform === process.platform && arch === process.arch,
      signal,
    })
  } catch {
    // Compile or refresh helper cleanly when missing or stale.
  }

  const scriptPath = join(REPO_ROOT, 'scripts', 'build-terminal-helper.mjs')
  await new Promise((resolvePromise, rejectPromise) => {
    const args = [scriptPath, '--platform', platform, '--arch', arch]
    if (autoMsvc) args.push('--auto-msvc')
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: false,
      signal,
    })
    child.once('error', rejectPromise)
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`build-terminal-helper exited with code ${code}`))
    })
  })

  return inspectTerminalHelperResource(outDir, platform, arch, expectedSource, {
    verifyLoad: platform === process.platform && arch === process.arch,
    signal,
  })
}

export function readEmbeddedTerminalHelperMeta(requireBuild) {
  const filename = terminalHelperFilename(process.platform, process.arch)
  if (!filename) return null
  const metaPath = join(DESKTOP_ROOT, 'out', 'native', `${filename}.json`)
  try {
    const raw = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (
      raw &&
      raw.protocolVersion === TERMINAL_HELPER_PROTOCOL_VERSION &&
      raw.platform === process.platform &&
      raw.arch === process.arch
    ) {
      return raw
    }
  } catch {
    if (requireBuild) {
      throw new Error(`Missing terminal helper build metadata at ${metaPath}`)
    }
  }
  return null
}

export function validateTerminalHelperManifest(manifest, { optional = false } = {}) {
  const record = manifest?.terminalHelper
  if (record === undefined) {
    if (optional) return null
    throw new Error('Distribution manifest is missing terminalHelper record.')
  }
  if (!record || typeof record !== 'object') {
    throw new Error('Distribution manifest terminalHelper record must be an object.')
  }
  const filename = terminalHelperFilename(manifest.platform, manifest.arch)
  if (
    record.protocolVersion !== TERMINAL_HELPER_PROTOCOL_VERSION ||
    record.platform !== manifest.platform ||
    record.arch !== manifest.arch ||
    record.filename !== filename ||
    !/^[a-f0-9]{64}$/.test(record.sourceSha256 ?? '') ||
    !/^[a-f0-9]{64}$/.test(record.binarySha256 ?? '') ||
    !Number.isSafeInteger(record.binaryBytes) ||
    record.binaryBytes < 64
  ) {
    throw new Error('Distribution manifest terminalHelper record is invalid.')
  }
  if (
    manifest.platform === 'darwin' &&
    !/^[a-f0-9]{64}$/.test(record.machoPreSignatureSha256 ?? '')
  ) {
    throw new Error(
      'Distribution manifest terminalHelper record is missing machoPreSignatureSha256.',
    )
  }
  return record
}
