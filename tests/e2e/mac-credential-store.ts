import type { ElectronApplication } from '@playwright/test'

import { mkdir, open, realpath, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

export interface CredentialCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}
export interface MacCredentialStoreOptions {
  directory: string
  environment: Record<string, string>
  isCurrent: () => boolean
  run: (executable: string, args: string[], deadline: number) => Promise<CredentialCommandResult>
}

const KEYCHAIN_SOURCE = 'mac-credential-keychain.c'
const GUARD_SOURCE = 'mac-credential-guard.c'
const KEYCHAIN_BINARY = 'credential-keychain'
const GUARD_MODULE = 'credential-guard.node'
const PREPARE_DEADLINE_MS = 30_000
const COMMAND_DEADLINE_MS = 15_000
const DISPOSE_DEADLINE_MS = 5_000
const SOURCE_BYTES = 64 * 1024

interface NativeReply {
  ok?: boolean
  created?: boolean
  deleted?: boolean
  alreadyGone?: boolean
  stage?: string
  status?: number
}

function nativeReply(text: string): NativeReply | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  return parsed
}

/**
 * One real private macOS Keychain plus two compiled helpers, owned by a single
 * opted-in synthetic fixture. Construction performs no I/O: the fixture assigns
 * this owner before `prepare()`. `resource` tracks the owned native store:
 * `none` = no unsettled action/store, `needed` = a definite owned store may
 * exist, `unknown` = retain the fixture and never blindly delete or retry.
 */
export class MacCredentialStore {
  private readonly options: MacCredentialStoreOptions
  private preparation: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private closing = false
  private resource: 'none' | 'needed' | 'unknown' | 'released' = 'none'
  private guardPath: string | undefined

  constructor(options: MacCredentialStoreOptions) {
    this.options = options
  }

  private assertCurrent(): void {
    if (this.disposal || this.closing) throw new Error('Native credential store is disposing')
    if (!this.options.isCurrent()) throw new Error('Native credential store owner changed')
  }

  /** One canonical read of an owned repository source: regular file, ≤64 KiB. */
  private async ownedSource(name: string): Promise<Buffer> {
    const source = resolve(import.meta.dirname, name)
    const meta = await stat(source)
    if (!meta.isFile()) throw new Error(`Credential source ${name} is not a regular file`)
    const handle = await open(source, 'r')
    try {
      const chunks: Buffer[] = []
      let total = 0
      for (;;) {
        const chunk = Buffer.alloc(8192)
        // oxlint-disable-next-line no-await-in-loop -- Sequential reads bound the buffer.
        const { bytesRead } = await handle.read(chunk, 0, 8192, null)
        if (bytesRead === 0) break
        total += bytesRead
        if (total > SOURCE_BYTES) throw new Error(`Credential source ${name} exceeds 64 KiB`)
        chunks.push(chunk.subarray(0, bytesRead))
      }
      return Buffer.concat(chunks)
    } finally {
      await handle.close()
    }
  }

  /** Write one owned source copy; never overwrite. */
  private async sourceCopy(name: string, contents: Buffer): Promise<string> {
    const target = join(this.options.directory, 'credential-store', name)
    const handle = await open(target, 'wx', 0o600)
    try {
      await handle.writeFile(contents)
    } finally {
      await handle.close()
    }
    return target
  }

  private async command(
    executable: string,
    args: string[],
    deadline: number,
  ): Promise<CredentialCommandResult> {
    return this.options.run(
      executable,
      args,
      Math.min(deadline, performance.now() + COMMAND_DEADLINE_MS),
    )
  }

  private async prepareOnce(deadline: number): Promise<void> {
    const { directory, environment } = this.options
    const canonical = await realpath(directory)
    const home = environment['HOME']
    if (!home || home !== join(canonical, 'home'))
      throw new Error('Credential store requires the fixture HOME scope')
    this.assertCurrent()
    const root = join(directory, 'credential-store')
    await mkdir(root, { recursive: true, mode: 0o700 })
    this.assertCurrent()
    for (const sub of ['Library', 'Library/Keychains', 'Library/Preferences']) {
      // oxlint-disable-next-line no-await-in-loop -- Each directory check precedes its private child.
      await mkdir(join(home, sub), { recursive: true, mode: 0o700 })
      this.assertCurrent()
    }
    const keychainSource = await this.ownedSource(KEYCHAIN_SOURCE)
    this.assertCurrent()
    const guardSource = await this.ownedSource(GUARD_SOURCE)
    this.assertCurrent()
    const keychainCopy = await this.sourceCopy('keychain.c', keychainSource)
    this.assertCurrent()
    const guardCopy = await this.sourceCopy('guard.c', guardSource)
    this.assertCurrent()
    const binary = join(root, KEYCHAIN_BINARY)
    const guard = join(root, GUARD_MODULE)
    const headers = resolve(dirname(process.execPath), '../include/node')
    const compileFlags = [
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-deprecated-declarations',
      '-framework',
      'Security',
      '-framework',
      'CoreFoundation',
    ]
    this.resource = 'unknown'
    const keychainCompile = await this.command(
      'clang',
      [...compileFlags, keychainCopy, '-o', binary],
      deadline,
    )
    if (keychainCompile.exitCode !== 0) {
      this.resource = 'unknown'
      throw new Error(
        `Native credential keychain helper did not compile: ${keychainCompile.stderr.slice(0, 512)}`,
      )
    }
    this.resource = 'none'
    this.assertCurrent()
    this.resource = 'unknown'
    const guardCompile = await this.command(
      'clang',
      [
        ...compileFlags,
        '-bundle',
        '-undefined',
        'dynamic_lookup',
        '-I',
        headers,
        guardCopy,
        '-o',
        guard,
      ],
      deadline,
    )
    if (guardCompile.exitCode !== 0) {
      this.resource = 'unknown'
      throw new Error(
        `Native credential guard did not compile: ${guardCompile.stderr.slice(0, 512)}`,
      )
    }
    this.resource = 'none'
    this.assertCurrent()
    this.guardPath = guard
    this.resource = 'unknown'
    const created = await this.command(binary, ['create'], deadline)
    // Record the terminal receipt BEFORE asserting currency, so cancellation
    // while create runs cannot lose ownership of a possibly-created store.
    if (created.exitCode === 0) {
      const reply = nativeReply(created.stdout)
      if (reply?.ok === true && reply.created === true) {
        this.resource = 'needed'
        this.assertCurrent()
        return
      }
      this.resource = 'unknown'
      throw new Error('Native credential store returned an unrecognised create receipt')
    }
    if (created.exitCode === 2) {
      const reply = nativeReply(created.stdout)
      if (
        reply?.ok === false &&
        reply.created === true &&
        typeof reply.stage === 'string' &&
        Number.isInteger(reply.status)
      ) {
        // Definite partial owned store: setup fails, disposal may clean it.
        this.resource = 'needed'
        throw new Error(`Native credential store setup rejected: ${reply.stage}`)
      }
      this.resource = 'unknown'
      throw new Error('Native credential store returned an unrecognised create receipt')
    }
    this.resource = 'unknown'
    throw new Error(
      `Native credential store create did not settle: ${created.stderr.slice(0, 256)}`,
    )
  }

  prepare(): Promise<void> {
    this.assertCurrent()
    this.preparation ??= this.prepareOnce(performance.now() + PREPARE_DEADLINE_MS)
    return this.preparation
  }

  async install(app: ElectronApplication): Promise<void> {
    this.assertCurrent()
    if (!this.preparation) throw new Error('Native credential guard requires its prepared store')
    await this.preparation
    this.assertCurrent()
    if (this.resource !== 'needed') throw new Error('Native credential store is not prepared')
    const guardPath = this.guardPath
    if (!guardPath) throw new Error('Native credential guard was never compiled')
    await app.evaluate((_electron, modulePath) => {
      const load = process.getBuiltinModule('module').createRequire(process.execPath)
      const value: unknown = load(modulePath)
      if (!value || typeof value !== 'object' || Reflect.get(value, 'guarded') !== true)
        throw new Error('Owned native credential guard unavailable')
    }, guardPath)
    this.assertCurrent()
  }

  dispose(): Promise<void> {
    this.closing = true
    this.disposal ??= (async () => {
      if (this.preparation) await this.preparation.catch(() => undefined)
      if (this.resource === 'none' || this.resource === 'released') return
      if (this.resource === 'unknown')
        throw new Error('Native credential store release is unconfirmed; fixture retained')
      this.resource = 'unknown'
      const deleted = await this.options.run(
        join(this.options.directory, 'credential-store', KEYCHAIN_BINARY),
        ['delete'],
        performance.now() + DISPOSE_DEADLINE_MS,
      )
      const reply = nativeReply(deleted.stdout)
      if (deleted.exitCode !== 0 || !reply || reply.ok !== true || reply.deleted !== true)
        throw new Error('Native credential store release is unconfirmed; fixture retained')
      this.resource = 'released'
    })()
    return this.disposal
  }
}
