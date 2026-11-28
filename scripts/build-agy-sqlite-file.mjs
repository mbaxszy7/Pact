import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  computeMachoPreSignatureSha256,
  verifyAgySqliteBinaryHeader,
} from '../apps/desktop/build/agy-sqlite-file-resource.mjs'
import { runWindowsCompiler, WindowsCompilerError } from './run-windows-compiler.mjs'
import { prepareWindowsMsvcEnvironment } from './windows-msvc-environment.mjs'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'apps/desktop/native/agy-sqlite-file.c')
const platform = process.platform
const arch = process.arch
const MAX_BINARY_BYTES = 4 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u

const options = process.argv.slice(2)
let autoMsvc = false
let forceRebuild = false
let outputDirectory
for (let i = 0; i < options.length; i += 1) {
  const arg = options[i]
  if (arg === '--auto-msvc') {
    autoMsvc = true
  } else if (arg === '--force') {
    forceRebuild = true
  } else if (arg === '--output-directory' && i + 1 < options.length) {
    outputDirectory = options[++i]
  } else {
    throw new Error(
      'Usage: node scripts/build-agy-sqlite-file.mjs [--auto-msvc] [--force] [--output-directory PATH]',
    )
  }
}

const supported = new Set([
  'darwin-arm64',
  'darwin-x64',
  'win32-x64',
  'win32-arm64',
  'linux-x64',
  'linux-arm64',
])
if (!supported.has(`${platform}-${arch}`)) {
  throw new Error(`Unsupported agy-sqlite-file target: ${platform}-${arch}.`)
}

if (
  platform === 'win32' &&
  process.env.VSCMD_ARG_TGT_ARCH &&
  process.env.VSCMD_ARG_TGT_ARCH.toLowerCase() !== (arch === 'arm64' ? 'arm64' : 'x64')
) {
  throw new Error('The active MSVC target does not match this native runner.')
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function verifyModuleLoadIdentity(binaryPath, expectedSourceSha256) {
  const probeScript = [
    'const mod = { exports: {} };',
    'process.dlopen(mod, process.argv[1]);',
    'if (typeof mod.exports.openAnchoredLockedView !== "function" || typeof mod.exports.verifyCandidateEmptyUnlocked !== "function" || typeof mod.exports.publishCandidateAtomically !== "function" || typeof mod.exports.checkSameVolume !== "function") { throw new Error("Missing required N-API exports."); }',
    'process.stdout.write(JSON.stringify(mod.exports.moduleIdentity()));',
  ].join(' ')
  const result = await execute(process.execPath, ['-e', probeScript, binaryPath], {
    cwd: dirname(binaryPath),
    shell: false,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 4096,
    encoding: 'utf8',
  })
  const observed = JSON.parse(result.stdout)
  if (
    observed.version !== 1 ||
    observed.platform !== platform ||
    observed.architecture !== arch ||
    observed.sourceSha256 !== expectedSourceSha256
  ) {
    throw new Error('Built agy-sqlite-file module rejected its recorded source identity.')
  }
}

const output = resolve(outputDirectory ?? join(root, 'apps/desktop/out/native'))
await mkdir(output, { recursive: true })
const sourceBytes = await readFile(source)
const sourceSha256 = sha256Hex(sourceBytes)
const filename = `agy-sqlite-file-${platform}-${arch}.node`
const destination = join(output, filename)
const metadataPath = `${destination}.json`

// Incremental check: skip recompilation when source + binary SHA-256 already match.
if (!forceRebuild) {
  try {
    const metaStat = await lstat(metadataPath)
    const binStat = await lstat(destination)
    if (
      metaStat.isFile() &&
      !metaStat.isSymbolicLink() &&
      metaStat.size <= 4096 &&
      binStat.isFile() &&
      !binStat.isSymbolicLink() &&
      binStat.size > 0 &&
      binStat.size <= MAX_BINARY_BYTES
    ) {
      const existingMeta = JSON.parse(await readFile(metadataPath, 'utf8'))
      if (
        existingMeta.version === 1 &&
        existingMeta.platform === platform &&
        existingMeta.architecture === arch &&
        existingMeta.sourceSha256 === sourceSha256 &&
        SHA256.test(existingMeta.binarySha256) &&
        existingMeta.binaryBytes === binStat.size &&
        (platform !== 'darwin' || SHA256.test(existingMeta.machoPreSigSha256))
      ) {
        const existingBytes = await readFile(destination)
        if (
          existingBytes.length === existingMeta.binaryBytes &&
          sha256Hex(existingBytes) === existingMeta.binarySha256 &&
          (platform !== 'darwin' ||
            computeMachoPreSignatureSha256(existingBytes, arch) === existingMeta.machoPreSigSha256)
        ) {
          verifyAgySqliteBinaryHeader(existingBytes, platform, arch)
          process.stdout.write(
            `agy-sqlite-file (${platform}-${arch}) is up to date (${existingBytes.length} bytes).\n`,
          )
          process.exit(0)
        }
      }
    }
  } catch {
    // Missing or stale artifact: proceed to clean rebuild.
  }
}

const temporary = await mkdtemp(join(output, '.agy-sqlite-file-build-'))
const compiled = join(temporary, filename)
let preserveTemporary = false
try {
  if (platform === 'darwin') {
    await execute(
      '/usr/bin/clang',
      [
        '-std=c11',
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-fPIC',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        `-DPACT_AGY_SQLITE_FILE_SOURCE_SHA256="${sourceSha256}"`,
        '-o',
        compiled,
        source,
      ],
      { cwd: temporary, shell: false, timeout: 30_000, maxBuffer: 256 * 1024 },
    )
  } else if (platform === 'win32') {
    const compilerOptions = { cwd: temporary, timeout: 60_000, maxBuffer: 256 * 1024 }
    if (autoMsvc) {
      const deadlineAt = performance.now() + compilerOptions.timeout
      compilerOptions.env = await prepareWindowsMsvcEnvironment(arch, { deadlineAt })
      compilerOptions.timeout = Math.floor(deadlineAt - performance.now())
    }
    await runWindowsCompiler(
      [
        '/nologo',
        '/std:c11',
        '/LD',
        '/O2',
        '/MT',
        '/W4',
        '/WX',
        '/utf-8',
        '/guard:cf',
        `/DPACT_AGY_SQLITE_FILE_SOURCE_SHA256="${sourceSha256}"`,
        `/Fo${join(temporary, 'agy-sqlite-file.obj')}`,
        `/Fe${compiled}`,
        source,
        '/link',
        '/INCREMENTAL:NO',
        '/DYNAMICBASE',
        '/NXCOMPAT',
        '/GUARD:CF',
        `/MACHINE:${arch === 'arm64' ? 'ARM64' : 'X64'}`,
      ],
      compilerOptions,
    )
  } else {
    await execute(
      'cc',
      [
        '-std=c11',
        '-shared',
        '-fPIC',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        `-DPACT_AGY_SQLITE_FILE_SOURCE_SHA256="${sourceSha256}"`,
        '-o',
        compiled,
        source,
      ],
      { cwd: temporary, shell: false, timeout: 30_000, maxBuffer: 256 * 1024 },
    )
  }

  const builtStat = await stat(compiled)
  if (builtStat.size < 64 || builtStat.size > MAX_BINARY_BYTES) {
    throw new Error('Built agy-sqlite-file artifact size is out of bounds.')
  }
  let bytes = await readFile(compiled)
  let machoPreSigSha256
  if (platform === 'darwin') {
    machoPreSigSha256 = computeMachoPreSignatureSha256(bytes, arch)
    if (!machoPreSigSha256) {
      await execute('/usr/bin/codesign', ['--force', '--sign', '-', compiled], {
        cwd: temporary,
        shell: false,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
      bytes = await readFile(compiled)
      machoPreSigSha256 = computeMachoPreSignatureSha256(bytes, arch)
    }
    if (!machoPreSigSha256) {
      throw new Error('Built macOS agy-sqlite-file binary lacks a canonical Mach-O code signature.')
    }
  }
  verifyAgySqliteBinaryHeader(bytes, platform, arch)
  await verifyModuleLoadIdentity(compiled, sourceSha256)

  if (sha256Hex(await readFile(source)) !== sourceSha256) {
    throw new Error('agy-sqlite-file source changed during compilation.')
  }

  const metadata = {
    version: 1,
    platform,
    architecture: arch,
    sourceSha256,
    binarySha256: sha256Hex(bytes),
    binaryBytes: bytes.length,
    ...(machoPreSigSha256 ? { machoPreSigSha256 } : {}),
  }
  const stagedMetadata = join(temporary, `${filename}.json`)
  await writeFile(stagedMetadata, `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o644,
  })
  await rename(compiled, destination)
  await rename(stagedMetadata, metadataPath)
  process.stdout.write(`Built agy-sqlite-file ${platform}-${arch} (${bytes.length} bytes).\n`)
} catch (error) {
  preserveTemporary = error instanceof WindowsCompilerError && error.preserveWorkspace
  throw error
} finally {
  if (!preserveTemporary) await rm(temporary, { recursive: true, force: true })
}
