import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { runWindowsCompiler, WindowsCompilerError } from './run-windows-compiler.mjs'

const execute = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'apps/desktop/native/owned-process-group-win32.cpp')
const arch = process.arch
const options = process.argv.slice(2)
if (options.length !== 0 && (options.length !== 2 || options[0] !== '--output-directory'))
  throw Error('Usage: node scripts/build-owned-process-group-win32.mjs [--output-directory PATH]')
if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch))
  throw Error('The owned-process bridge requires a native Windows x64 or arm64 SDK/MSVC host.')
if (
  process.env.VSCMD_ARG_TGT_ARCH &&
  process.env.VSCMD_ARG_TGT_ARCH.toLowerCase() !== (arch === 'arm64' ? 'arm64' : 'x64')
)
  throw Error('The active MSVC target does not match this native runner.')

const output = resolve(options[1] ?? join(root, 'apps/desktop/out/native'))
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(join(output, '.owned-process-build-'))
const sourceSha256 = createHash('sha256')
  .update(await readFile(source))
  .digest('hex')
const filename = `owned-process-group-win32-${arch}.exe`
const compiled = join(temporary, filename)
const destination = join(output, filename)
let preserveTemporary = false
try {
  // Build preparation owns MSVC's complete subtree. The shipped native helper
  // remains self-contained and never compiles, downloads or requires .NET at runtime.
  await runWindowsCompiler(
    [
      '/nologo',
      '/std:c++20',
      '/EHsc',
      '/W4',
      '/WX',
      '/O2',
      '/MT',
      '/utf-8',
      '/guard:cf',
      `/DPACT_OWNER_SOURCE_SHA256="${sourceSha256}"`,
      `/Fo${join(temporary, 'owned-process-group-win32.obj')}`,
      `/Fe${compiled}`,
      source,
      '/link',
      '/INCREMENTAL:NO',
      '/DYNAMICBASE',
      '/NXCOMPAT',
      `/MACHINE:${arch === 'arm64' ? 'ARM64' : 'X64'}`,
    ],
    { cwd: temporary, timeout: 60_000, maxBuffer: 256 * 1024 },
  )
  if ((await stat(compiled)).size > 16 * 1024 * 1024)
    throw Error('Native bridge artifact is oversized.')
  const bytes = await readFile(compiled)
  const peOffset = bytes.length >= 64 ? bytes.readUInt32LE(60) : bytes.length
  if (
    bytes.subarray(0, 2).toString('ascii') !== 'MZ' ||
    peOffset + 24 > bytes.length ||
    bytes.readUInt32LE(peOffset) !== 0x4550 ||
    bytes.readUInt16LE(peOffset + 4) !== (arch === 'arm64' ? 0xaa64 : 0x8664)
  )
    throw Error('Native bridge PE architecture did not match the runner.')
  const result = await execute(compiled, ['identity'], {
    cwd: temporary,
    shell: false,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1024,
    encoding: 'utf8',
  })
  const identity = JSON.parse(result.stdout)
  if (
    identity.protocolVersion !== 1 ||
    identity.sourceSha256 !== sourceSha256 ||
    identity.architecture !== arch
  )
    throw Error('Native bridge protocol/source identity did not match its build.')
  if (
    createHash('sha256')
      .update(await readFile(source))
      .digest('hex') !== sourceSha256
  )
    throw Error('Native bridge source changed during compilation.')
  const metadata = {
    version: 1,
    platform: 'win32',
    architecture: arch,
    protocolVersion: 1,
    sourceSha256,
    executableSha256: createHash('sha256').update(bytes).digest('hex'),
    executableBytes: bytes.length,
  }
  await rename(compiled, destination)
  await writeFile(`${destination}.json`, `${JSON.stringify(metadata, null, 2)}\n`)
  process.stdout.write(`Built Windows ${arch} process ownership bridge (${bytes.length} bytes).\n`)
} catch (error) {
  preserveTemporary = error instanceof WindowsCompilerError && error.preserveWorkspace
  throw error
} finally {
  if (!preserveTemporary) await rm(temporary, { recursive: true, force: true })
}
