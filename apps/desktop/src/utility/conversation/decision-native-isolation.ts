/* oxlint-disable no-await-in-loop -- Bounded file reads preserve exact file identities. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, realpath, stat, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'

const identity = (path: string, value: Awaited<ReturnType<typeof stat>>) => [
  path,
  value.dev,
  value.ino,
  value.mode,
  value.size,
  value.mtimeMs,
  value.ctimeMs,
]
async function bounded(path: string, maximum: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > maximum) throw Error('unsupported_protocol')
    const data = Buffer.allocUnsafe(maximum + 1)
    let held = 0
    while (held <= maximum) {
      const result = await file.read(data, held, data.length - held, held)
      if (!result.bytesRead) return data.subarray(0, held)
      held += result.bytesRead
    }
    throw Error('unsupported_protocol')
  } finally {
    await file.close()
  }
}
const macho = (data: Buffer) =>
  data.length >= 4 &&
  [
    0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
  ].includes(data.readUInt32BE(0))
async function prefix(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const data = Buffer.alloc(4)
    await file.read(data, 0, 4, 0)
    return data
  } finally {
    await file.close()
  }
}
export async function resolveDecisionNativeExecutable(
  selected: string,
  provider: 'codex' | 'claude',
) {
  if (!isAbsolute(selected) || selected.length > 32768) throw Error('executable_unavailable')
  const original = await realpath(selected)
  const paths = [selected, original]
  let native = original
  if (!macho(await prefix(native))) {
    if (provider !== 'codex') throw Error('unsupported_protocol')
    let launcher = original
    if (!launcher.endsWith('/bin/codex.js')) {
      const shim = new TextDecoder('utf-8', { fatal: true }).decode(await bounded(original, 16384))
      const targets = [...shim.matchAll(/^# cmd-shim-target=(.+)$/gmu)]
      if (targets.length !== 1 || !isAbsolute(targets[0]![1]!)) throw Error('unsupported_protocol')
      launcher = await realpath(targets[0]![1]!)
    }
    if (!launcher.endsWith('/bin/codex.js')) throw Error('unsupported_protocol')
    const root = dirname(dirname(launcher)),
      packagePath = join(root, 'package.json')
    const metadata = JSON.parse((await bounded(packagePath, 16384)).toString('utf8'))
    if (metadata.name !== '@openai/codex' || metadata.version !== '0.163.0')
      throw Error('unsupported_protocol')
    const target =
      process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : process.arch === 'x64'
          ? 'x86_64-apple-darwin'
          : null
    if (!target) throw Error('unsupported_platform')
    const platform =
      process.arch === 'arm64' ? '@openai/codex-darwin-arm64' : '@openai/codex-darwin-x64'
    let vendor = join(root, 'vendor')
    try {
      vendor = join(dirname(createRequire(launcher).resolve(`${platform}/package.json`)), 'vendor')
    } catch {
      /* Native package includes its vendor fallback. */
    }
    native = await realpath(join(vendor, target, 'bin', 'codex'))
    paths.push(launcher, packagePath, native)
    if (!macho(await prefix(native))) throw Error('unsupported_protocol')
  }
  const observe = async () =>
    JSON.stringify(await Promise.all(paths.map(async (path) => identity(path, await stat(path)))))
  const frozen = await observe(),
    fingerprint = createHash('sha256').update(frozen).digest('hex')
  return { path: native, fingerprint, current: async () => frozen === (await observe()) }
}
export function decisionDarwinSandbox(
  executable: string,
  ownedDirectory: string,
  port?: number,
  installationId?: string,
) {
  if (
    !isAbsolute(executable) ||
    !isAbsolute(ownedDirectory) ||
    [executable, ownedDirectory].some((x) => x.includes('\0') || x.length > 32768)
  )
    throw Error('unsupported_protocol')
  if (port !== undefined && (!Number.isSafeInteger(port) || port < 1 || port > 65535))
    throw Error('unsupported_network')
  const profile = `(version 1)(allow default)(deny process-fork)(deny process-exec)(allow process-exec (literal ${JSON.stringify(executable)}))(deny file-write*)(allow file-write* (subpath ${JSON.stringify(ownedDirectory)}))${installationId ? `(allow file-write-data (literal ${JSON.stringify(installationId)}))` : ''}(deny network*)${port === undefined ? '' : `(allow network-outbound (remote ip "localhost:${port}"))`}`
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, executable] }
}

/** An auxiliary root never inherits native code injection or a proxy bypass. */
export function assertDecisionEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(environment))
    if (value && /^(?:DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|BUN_OPTIONS$)/u.test(key))
      throw Error('unsupported_protocol')
}

/** This exact native bookkeeping file is the sole non-owned write-data exception.
 * Pinned Codex opens it O_RDWR, but valid existing state takes its read-only branch.
 * OS permission is not a claim of a completely read-only native home. */
export async function retainCodexInstallationId(home: string) {
  const canonical = await realpath(home)
  const path = join(canonical, 'installation_id')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let closed = false
  const observe = async () => {
    const before = await file.stat(),
      named = await lstat(path)
    if (
      !before.isFile() ||
      !named.isFile() ||
      named.isSymbolicLink() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o644 ||
      before.size < 36 ||
      before.size > 64 ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    )
      throw Error('unsupported_protocol')
    const data = Buffer.alloc(65),
      read = await file.read(data, 0, 65, 0)
    if (
      read.bytesRead !== before.size ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/iu.test(
        data.subarray(0, read.bytesRead).toString('utf8'),
      )
    )
      throw Error('unsupported_protocol')
    const after = await file.stat()
    if (
      after.nlink !== 1 ||
      after.uid !== before.uid ||
      (after.mode & 0o7777) !== 0o644 ||
      JSON.stringify(identity(path, before)) !== JSON.stringify(identity(path, after))
    )
      throw Error('stale')
    // Access time changes on legitimate reads and is not a modification witness.
    return JSON.stringify([
      identity(path, after),
      after.uid,
      after.nlink,
      after.birthtimeMs,
      createHash('sha256').update(data.subarray(0, read.bytesRead)).digest('hex'),
    ])
  }
  try {
    const frozen = await observe()
    return {
      path,
      home: canonical,
      current: async () => {
        if (closed) return false
        try {
          return frozen === (await observe())
        } catch {
          return false
        }
      },
      close: async () => {
        if (!closed) {
          await file.close()
          closed = true
        }
      },
    }
  } catch (error) {
    await file.close()
    throw error
  }
}
