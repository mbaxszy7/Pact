import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const desktop = resolve(import.meta.dirname, '..')
const root = resolve(desktop, '../..')
const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')

export function windowsOwnedProcessFilename(arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows helper architecture.')
  return `owned-process-group-win32-${arch}.exe`
}

async function boundedFile(path, maximum) {
  if (!(await lstat(path)).isFile())
    throw new Error('Native helper metadata must be a regular file.')
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size < 1 || info.size > maximum)
      throw new Error('Native helper metadata exceeds its byte bound.')
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      // oxlint-disable-next-line no-await-in-loop -- One bounded source/identity read, including an overflow byte.
      const result = await file.read(bytes, size, bytes.length - size, size)
      if (!result.bytesRead) break
      size += result.bytesRead
    }
    if (size !== info.size || size > maximum)
      throw new Error('Native helper metadata changed during inspection.')
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}

export async function windowsOwnedProcessSourceHash() {
  return hash(await boundedFile(join(desktop, 'native/owned-process-group-win32.cpp'), 1024 * 1024))
}

/** Native packaging executes identity; installed smoke binds those exact verified bytes and metadata. */
export async function inspectWindowsOwnedProcessResource(
  directory,
  arch,
  expectedSourceSha256,
  { runIdentity = false } = {},
) {
  const filename = windowsOwnedProcessFilename(arch)
  if (!SHA256.test(expectedSourceSha256)) throw new Error('Invalid Windows helper source identity.')
  const executable = join(directory, filename)
  const identityBytes = await boundedFile(`${executable}.json`, 4096)
  const identity = JSON.parse(identityBytes.toString('utf8'))
  if (
    identity.version !== 1 ||
    identity.platform !== 'win32' ||
    identity.architecture !== arch ||
    identity.protocolVersion !== 1 ||
    identity.sourceSha256 !== expectedSourceSha256 ||
    !SHA256.test(identity.executableSha256) ||
    !Number.isSafeInteger(identity.executableBytes) ||
    identity.executableBytes < 88 ||
    identity.executableBytes > MAX_EXECUTABLE_BYTES
  )
    throw new Error('Windows helper identity metadata does not match its target/source/protocol.')
  const info = await lstat(executable)
  if (!info.isFile() || info.size !== identity.executableBytes)
    throw new Error('Windows helper executable is missing, redirected or has changed size.')
  const file = await open(executable, 'r')
  try {
    const header = Buffer.alloc(64)
    if (
      (await file.read(header, 0, header.length, 0)).bytesRead !== header.length ||
      header.toString('ascii', 0, 2) !== 'MZ'
    )
      throw new Error('Windows helper has no valid PE header.')
    const offset = header.readUInt32LE(60)
    const pe = Buffer.alloc(24)
    if (
      offset < 64 ||
      offset > identity.executableBytes - pe.length ||
      (await file.read(pe, 0, pe.length, offset)).bytesRead !== pe.length ||
      pe.readUInt32LE(0) !== 0x4550 ||
      pe.readUInt16LE(4) !== (arch === 'arm64' ? 0xaa64 : 0x8664)
    )
      throw new Error('Windows helper PE architecture does not match its target.')
  } finally {
    await file.close()
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5_000)
  const digest = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of createReadStream(executable, {
      highWaterMark: 64 * 1024,
      signal: controller.signal,
    })) {
      bytes += chunk.length
      if (bytes > MAX_EXECUTABLE_BYTES) throw new Error('Windows helper exceeded its byte bound.')
      digest.update(chunk)
    }
  } finally {
    clearTimeout(timer)
  }
  if (bytes !== identity.executableBytes || digest.digest('hex') !== identity.executableSha256)
    throw new Error('Windows helper executable does not match its recorded digest.')
  if (runIdentity) {
    if (process.platform !== 'win32' || process.arch !== arch)
      throw new Error('Windows helper execution requires its native Windows architecture.')
    const response = await execute(executable, ['identity'], {
      cwd: directory,
      shell: false,
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 1024,
      encoding: 'utf8',
    })
    const observed = JSON.parse(response.stdout)
    if (
      observed.protocolVersion !== identity.protocolVersion ||
      observed.sourceSha256 !== identity.sourceSha256 ||
      observed.architecture !== arch
    )
      throw new Error('Windows helper executable rejected its recorded protocol/source identity.')
  }
  return {
    architecture: arch,
    protocolVersion: 1,
    sourceSha256: identity.sourceSha256,
    executable: {
      path: `resources/native/${filename}`,
      sha256: identity.executableSha256,
      bytes: identity.executableBytes,
    },
    identity: {
      path: `resources/native/${filename}.json`,
      sha256: hash(identityBytes),
      bytes: identityBytes.length,
    },
  }
}

/** One preparation entry for development and every electron-builder target. Never called at runtime. */
export async function prepareWindowsOwnedProcessResource(arch, { signal } = {}) {
  if (process.platform !== 'win32' || process.arch !== arch)
    throw new Error('Build the Windows helper on a matching native Windows SDK/MSVC host.')
  windowsOwnedProcessFilename(arch)
  await execute(process.execPath, [join(root, 'scripts/build-owned-process-group-win32.mjs')], {
    cwd: root,
    shell: false,
    windowsHide: true,
    signal,
    timeout: 70_000,
    maxBuffer: 256 * 1024,
  })
  return inspectWindowsOwnedProcessResource(
    join(desktop, 'out/native'),
    arch,
    await windowsOwnedProcessSourceHash(),
    { runIdentity: true },
  )
}

export async function assertNoWindowsOwnedProcessResource(resources) {
  let names
  try {
    names = await readdir(join(resources, 'native'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (names.length > 16_384 || names.some((name) => name.startsWith('owned-process-group-win32-')))
    throw new Error('A non-Windows application cannot contain a Windows ownership helper.')
}

/** Bind the helper and identity to the same final content inventory used by installed smoke. */
export function validateWindowsOwnedProcessManifest(manifest) {
  const record = manifest.windowsOwnedProcess
  const entries = manifest.application?.entries
  if (!Array.isArray(entries) || entries.length > 16_384)
    throw new Error('Windows helper requires a bounded application inventory.')
  const helpers = entries.filter(
    (entry) =>
      typeof entry.path === 'string' &&
      entry.path.startsWith('resources/native/owned-process-group-win32-'),
  )
  if (manifest.platform !== 'win32') {
    if (record != null || helpers.length)
      throw new Error('A non-Windows manifest cannot admit a Windows ownership helper.')
    return null
  }
  const filename = windowsOwnedProcessFilename(manifest.arch)
  if (
    !record ||
    record.architecture !== manifest.arch ||
    record.protocolVersion !== 1 ||
    !SHA256.test(record.sourceSha256) ||
    helpers.length !== 2
  )
    throw new Error('Windows helper manifest identity or inventory is invalid.')
  for (const [key, path, maximum] of [
    ['executable', `resources/native/${filename}`, MAX_EXECUTABLE_BYTES],
    ['identity', `resources/native/${filename}.json`, 4096],
  ]) {
    const value = record[key]
    if (
      !value ||
      value.path !== path ||
      !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 1 ||
      value.bytes > maximum ||
      helpers.filter(
        (entry) =>
          entry.type === 'file' &&
          entry.path === path &&
          entry.sha256 === value.sha256 &&
          entry.bytes === value.bytes,
      ).length !== 1
    )
      throw new Error('Windows helper manifest does not match the packaged bytes.')
  }
  return {
    architecture: manifest.arch,
    protocolVersion: 1,
    sourceSha256: record.sourceSha256,
    executable: {
      path: record.executable.path,
      sha256: record.executable.sha256,
      bytes: record.executable.bytes,
    },
    identity: {
      path: record.identity.path,
      sha256: record.identity.sha256,
      bytes: record.identity.bytes,
    },
  }
}
