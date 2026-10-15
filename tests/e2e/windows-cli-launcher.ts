import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const imageByteLimit = 64 * 1024
const imageLifetimeMs = 10 * 60_000
// Hosted cold compilation is setup work. Target startup keeps its separate caller deadline.
const imageCompilationMs = 30_000
const privateImages = new Set<string>()
let seed:
  | {
      directory: string
      parent: string
      executable: string
      key: string
      hash: string
      ino: bigint
      expires: number
    }
  | undefined
let imageTimer: ReturnType<typeof setTimeout> | undefined
let preparingImage = false,
  imageFailure: Error | undefined,
  imageCompilations = 0

function boundedBytes(file: string): Buffer {
  const handle = openSync(file, 'r')
  try {
    if (fstatSync(handle).size > imageByteLimit)
      throw new Error('Windows fixture image/source exceeds 64 KiB')
    const bytes = Buffer.alloc(imageByteLimit + 1)
    let length = 0,
      count: number
    while ((count = readSync(handle, bytes, length, bytes.length - length, null)) > 0) {
      length += count
      if (length > imageByteLimit) throw new Error('Windows fixture image/source exceeds 64 KiB')
    }
    return bytes.subarray(0, length)
  } finally {
    closeSync(handle)
  }
}

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
function fileIdentity(file: string) {
  const info = statSync(file, { bigint: true })
  return {
    file,
    ino: String(info.ino),
    size: String(info.size),
    mtime: String(info.mtimeNs),
    ctime: String(info.ctimeNs),
  }
}
function imageKey(): string {
  const compiler = realpathSync(compilation('unused').compiler)
  const node = realpathSync(process.execPath)
  const value = JSON.stringify({
    sources: [
      resolve(import.meta.dirname, '../../scripts/windows-e2e-job.cs'),
      resolve(import.meta.dirname, 'windows-cli-launcher.cs'),
    ].map((file) => ({ file, hash: digest(boundedBytes(file)) })),
    compiler: fileIdentity(compiler),
    node: fileIdentity(node),
    cwd: realpathSync(process.cwd()),
    arch: process.arch,
  })
  if (Buffer.byteLength(value) > imageByteLimit)
    throw new Error('Windows fixture image key exceeds its bound')
  return digest(value)
}

function removeImageDirectory(directory: string, parent: string): void {
  if (
    dirname(directory) !== parent ||
    !basename(directory).startsWith('pact-test-image-') ||
    lstatSync(directory).isSymbolicLink() ||
    realpathSync(directory) !== directory
  )
    throw new Error('Unsafe Windows fixture image cleanup target')
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}

/** Only the immutable seed is shared. Every fixture owns its link and descriptor. */
export function disposeWindowsLauncherImage(): void {
  clearTimeout(imageTimer)
  imageTimer = undefined
  if (imageFailure) throw imageFailure
  if (!seed) return
  if (
    statSync(seed.executable, { bigint: true }).ino !== seed.ino ||
    digest(boundedBytes(seed.executable)) !== seed.hash
  )
    throw (imageFailure = new Error('Shared Windows fixture image changed; evidence retained'))
  try {
    removeImageDirectory(seed.directory, seed.parent)
  } catch {
    throw (imageFailure = new Error('Windows fixture image cleanup unconfirmed; evidence retained'))
  }
  seed = undefined
}

function prunePrivateImages(): void {
  for (const file of privateImages) {
    try {
      lstatSync(file)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
      privateImages.delete(file)
    }
  }
}

export function windowsLauncherImageDiagnostic(): {
  compilations: number
  privateLinks: number
  imageBytes: number
  compiled: boolean
} {
  prunePrivateImages()
  return {
    compilations: imageCompilations,
    privateLinks: privateImages.size,
    imageBytes: seed ? statSync(seed.executable).size : 0,
    compiled: Boolean(seed),
  }
}

function installImage(executable: string): void {
  if (executable.length > 4096) throw new Error('Windows fixture image path exceeds its bound')
  if (imageFailure) throw imageFailure
  prunePrivateImages()
  if (privateImages.size >= 256) throw new Error('Windows fixture image link capacity exceeded')
  const key = imageKey()
  if (seed && (seed.key !== key || performance.now() >= seed.expires)) disposeWindowsLauncherImage()
  if (!seed) {
    if (preparingImage) throw new Error('Windows fixture image preparation is already active')
    const parent = realpathSync(tmpdir())
    const directory = mkdtempSync(join(parent, 'pact-test-image-'))
    const image = join(directory, 'image.exe')
    const deadline = performance.now() + imageCompilationMs
    const remaining = (): number => {
      const value = Math.floor(deadline - performance.now())
      if (value < 1) throw new Error('Windows fixture image preparation exceeded 30s')
      return value
    }
    preparingImage = true
    try {
      const { compiler, args } = compilation(image)
      imageCompilations++
      execFileSync(compiler, args, {
        timeout: remaining(),
        maxBuffer: 16 * 1024,
        windowsHide: true,
        shell: false,
      })
      const hash = digest(boundedBytes(image))
      if (key !== imageKey() || performance.now() >= deadline)
        throw new Error('Windows fixture image preparation changed or exceeded 30s')
      seed = {
        directory,
        parent,
        executable: image,
        key,
        hash,
        ino: statSync(image, { bigint: true }).ino,
        expires: performance.now() + imageLifetimeMs,
      }
      imageTimer = setTimeout(() => {
        try {
          disposeWindowsLauncherImage()
        } catch {
          /* Sticky failure retains evidence. */
        }
      }, imageLifetimeMs)
      imageTimer.unref()
    } catch (error) {
      try {
        removeImageDirectory(directory, parent)
      } catch {
        imageFailure = new Error('Windows fixture image cleanup unconfirmed; evidence retained', {
          cause: error,
        })
      }
      throw imageFailure ?? error
    } finally {
      preparingImage = false
    }
  }
  if (
    statSync(seed.executable, { bigint: true }).ino !== seed.ino ||
    digest(boundedBytes(seed.executable)) !== seed.hash
  )
    throw (imageFailure = new Error('Shared Windows fixture image changed; evidence retained'))
  // A byte copy creates a new Windows file instance and does not remove the measured cost.
  linkSync(seed.executable, executable)
  privateImages.add(executable)
  if (
    statSync(executable, { bigint: true }).ino !== seed.ino ||
    digest(boundedBytes(executable)) !== seed.hash
  )
    throw (imageFailure = new Error('Private Windows fixture image changed; evidence retained'))
}

if (process.platform === 'win32')
  process.once('exit', () => {
    try {
      disposeWindowsLauncherImage()
    } catch {
      /* Never delete unconfirmed evidence. */
    }
    privateImages.clear()
  })

export function removeWindowsRpcLauncherSync(directory: string): void {
  if (realpathSync(directory) !== directory) throw new Error('Unsafe Windows RPC cleanup target')
  rmSync(directory, { recursive: true, force: true })
}

export interface WindowsJobMembers {
  members: Array<{
    pid: number
    createdMs: number
    role: 'root' | 'descendant'
    image: 'codex' | 'node' | 'cmd' | 'conhost' | 'git' | 'rg' | 'other'
  }>
  membersIncomplete: boolean
}
export interface WindowsRootExit extends WindowsJobMembers {
  pid: number
  exitCode: number
  elapsedMs: number
  natural: boolean
  active: number
}
export interface WindowsLaunchOwner {
  executablePath: string
  directory: string
  generation: string
  started: Promise<{ generation: string; pid: number }>
  empty: Promise<{ generation: string; active: 0; exitCode: number }>
  rootExit: Promise<WindowsRootExit>
  armStartup(deadline: number): void
  cancel(): void
  disposeControl(): Promise<void>
  diagnostic(): {
    generation: string
    stages: Record<string, number>
    startupDeadlineMs?: number
    firstFailure?: string
    nativeErrorCode?: number
    lastActive?: number
    exitCode?: number
    stoppingReason?: 'control-closed' | 'deadline' | 'descendants-still-running'
    rootExit?: WindowsRootExit
    membersBeforeStop?: WindowsJobMembers
  }
}

function controlRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

const cloneMembers = (value: WindowsJobMembers): WindowsJobMembers => ({
  members: value.members.map((member) => ({ ...member })),
  membersIncomplete: value.membersIncomplete,
})

function jobMembers(value: Record<string, unknown>): WindowsJobMembers {
  if (
    !Array.isArray(value.members) ||
    value.members.length > 16 ||
    typeof value.membersIncomplete !== 'boolean'
  )
    throw new Error('Invalid Job member snapshot')
  const identities = new Set<number>()
  const members = value.members.map<WindowsJobMembers['members'][number]>((member: unknown) => {
    if (
      !controlRecord(member) ||
      Object.keys(member).length !== 4 ||
      typeof member.pid !== 'number' ||
      !Number.isSafeInteger(member.pid) ||
      member.pid < 2 ||
      member.pid > 0xffffffff ||
      identities.has(member.pid) ||
      typeof member.createdMs !== 'number' ||
      !Number.isSafeInteger(member.createdMs) ||
      member.createdMs < 0 ||
      (member.role !== 'root' && member.role !== 'descendant') ||
      (member.image !== 'codex' &&
        member.image !== 'node' &&
        member.image !== 'cmd' &&
        member.image !== 'conhost' &&
        member.image !== 'git' &&
        member.image !== 'rg' &&
        member.image !== 'other')
    )
      throw new Error('Invalid Job member identity')
    identities.add(member.pid)
    // The closed enum above prevents native paths or raw image names crossing this seam.
    return { pid: member.pid, createdMs: member.createdMs, role: member.role, image: member.image }
  })
  return { members, membersIncomplete: value.membersIncomplete }
}

/** One authenticated Job receipt, independent of Electron and every provider/relay it launches. */
export async function writeWindowsObservedLauncher(
  root: string,
  executable: string,
  lifetimeMs: number,
): Promise<WindowsLaunchOwner> {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(executable) ||
    executable.length > 4096 ||
    !Number.isSafeInteger(lifetimeMs) ||
    lifetimeMs < 1 ||
    lifetimeMs > 15 * 60_000
  )
    throw new Error('Invalid observed Windows launch')
  const directory = await mkdtemp(join(await realpath(root), 'pact-owned-launch-'))
  const generation = randomUUID(),
    token = randomUUID()
  const began = performance.now()
  const stages: Partial<
    Record<
      'prepared' | 'armed' | 'connected' | 'authenticated' | 'go' | 'started' | 'empty' | 'failed',
      number
    >
  > = {}
  let firstFailure: string | undefined, nativeErrorCode: number | undefined
  let lastActive: number | undefined, exitCode: number | undefined
  let rootPid: number | undefined, rootExitFact: WindowsRootExit | undefined
  let membersBeforeStop: WindowsJobMembers | undefined
  let stoppingReason: ReturnType<WindowsLaunchOwner['diagnostic']>['stoppingReason']
  const mark = (stage: keyof typeof stages): void => {
    stages[stage] = Math.round(performance.now() - began)
  }
  const diagnostic = () => ({
    generation,
    stages: { ...stages },
    ...(startupDeadline === undefined
      ? {}
      : { startupDeadlineMs: Math.round(startupDeadline - began) }),
    ...(firstFailure ? { firstFailure } : {}),
    ...(nativeErrorCode !== undefined ? { nativeErrorCode } : {}),
    ...(lastActive !== undefined ? { lastActive } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(stoppingReason ? { stoppingReason } : {}),
    ...(rootExitFact ? { rootExit: { ...rootExitFact, ...cloneMembers(rootExitFact) } } : {}),
    ...(membersBeforeStop ? { membersBeforeStop: cloneMembers(membersBeforeStop) } : {}),
  })
  const pipeName = `pact-fixture-${process.pid}-${generation}`
  const server = createServer()
  server.maxConnections = 1
  let socket: Socket | undefined
  let buffer = Buffer.alloc(0)
  let authenticated = false,
    didStart = false,
    didEmpty = false,
    cancelled = false,
    disposed = false
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  let startupDeadline: number | undefined
  let lifetimeTimer: ReturnType<typeof setTimeout> | undefined
  let resolveStarted!: (value: { generation: string; pid: number }) => void
  let rejectStarted!: (error: Error) => void
  let resolveEmpty!: (value: { generation: string; active: 0; exitCode: number }) => void
  let rejectEmpty!: (error: Error) => void
  let resolveRootExit!: (value: WindowsRootExit) => void
  let rejectRootExit!: (error: Error) => void
  const started = new Promise<{ generation: string; pid: number }>((done, reject) => {
    resolveStarted = done
    rejectStarted = reject
  })
  const empty = new Promise<{ generation: string; active: 0; exitCode: number }>((done, reject) => {
    resolveEmpty = done
    rejectEmpty = reject
  })
  const rootExit = new Promise<WindowsRootExit>((done, reject) => {
    resolveRootExit = done
    rejectRootExit = reject
  })
  void started.catch(() => undefined)
  void empty.catch(() => undefined)
  void rootExit.catch(() => undefined)
  const fail = (message: string): void => {
    if (firstFailure) return
    firstFailure = message
    mark('failed')
    const error = new Error(`${message}; control=${JSON.stringify(diagnostic())}`)
    clearTimeout(startupTimer)
    clearTimeout(lifetimeTimer)
    rejectStarted(error)
    rejectEmpty(error)
    rejectRootExit(error)
    socket?.destroy()
    if (server.listening) server.close()
  }
  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    if (authenticated && !didEmpty && socket && !socket.destroyed && !socket.writableEnded)
      socket.end('cancel\n')
  }
  const armStartup = (deadline: number): void => {
    const remaining = deadline - performance.now()
    if (
      startupDeadline !== undefined ||
      disposed ||
      cancelled ||
      firstFailure ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > 30_000
    )
      throw new Error('Windows Job startup requires one live bounded caller deadline')
    startupDeadline = deadline
    mark('armed')
    startupTimer = setTimeout(() => {
      cancel()
      fail('Windows Job start receipt exceeded its caller deadline')
    }, remaining)
  }
  const receive = (value: unknown): void => {
    if (!controlRecord(value)) throw new Error('Invalid Job control packet')
    const message = value
    if (message.generation !== generation) throw new Error('Unexpected Job generation')
    const keys = Object.keys(message)
    const exact = (expected: string[]): boolean =>
      keys.length === expected.length && keys.every((key) => expected.includes(key))
    if (!authenticated) {
      if (
        message.kind !== 'hello' ||
        message.token !== token ||
        !exact(['kind', 'token', 'generation'])
      )
        throw new Error('Job control authentication failed')
      authenticated = true
      mark('authenticated')
      if (cancelled) {
        socket!.end('cancel\n')
        return
      }
      if (startupDeadline === undefined || performance.now() >= startupDeadline)
        throw new Error('Windows Job admission is outside its caller deadline')
      socket!.write('go\n')
      mark('go')
      return
    }
    if (didEmpty) throw new Error('Job emitted data after its final receipt')
    if (message.kind === 'started') {
      if (
        startupDeadline === undefined ||
        performance.now() >= startupDeadline ||
        didStart ||
        !exact(['kind', 'generation', 'pid', 'active']) ||
        typeof message.pid !== 'number' ||
        !Number.isSafeInteger(message.pid) ||
        message.pid < 2 ||
        message.pid > 0xffffffff ||
        message.active !== 1
      )
        throw new Error('Invalid Job start receipt')
      didStart = true
      rootPid = message.pid
      lastActive = 1
      mark('started')
      clearTimeout(startupTimer)
      resolveStarted({ generation, pid: message.pid })
    } else if (message.kind === 'root-exit') {
      if (
        !didStart ||
        rootExitFact ||
        message.pid !== rootPid ||
        !exact([
          'kind',
          'generation',
          'pid',
          'exitCode',
          'elapsedMs',
          'natural',
          'active',
          'members',
          'membersIncomplete',
        ]) ||
        typeof message.exitCode !== 'number' ||
        !Number.isSafeInteger(message.exitCode) ||
        typeof message.elapsedMs !== 'number' ||
        !Number.isSafeInteger(message.elapsedMs) ||
        message.elapsedMs < 0 ||
        message.elapsedMs > lifetimeMs + 5000 ||
        typeof message.natural !== 'boolean' ||
        typeof message.active !== 'number' ||
        !Number.isSafeInteger(message.active) ||
        message.active < 0 ||
        message.active > 256
      )
        throw new Error('Invalid Job root exit receipt')
      rootExitFact = {
        pid: rootPid!,
        exitCode: message.exitCode,
        elapsedMs: message.elapsedMs,
        natural: message.natural,
        active: message.active,
        ...jobMembers(message),
      }
      resolveRootExit({ ...rootExitFact, ...cloneMembers(rootExitFact) })
    } else if (message.kind === 'members') {
      if (
        !didStart ||
        membersBeforeStop ||
        message.phase !== 'before-stop' ||
        !exact(['kind', 'generation', 'phase', 'members', 'membersIncomplete'])
      )
        throw new Error('Invalid Job member receipt')
      membersBeforeStop = jobMembers(message)
    } else if (message.kind === 'empty') {
      if (
        !exact(['kind', 'generation', 'exitCode', 'active']) ||
        message.active !== 0 ||
        typeof message.exitCode !== 'number' ||
        !Number.isSafeInteger(message.exitCode)
      )
        throw new Error('Invalid Job empty receipt')
      didEmpty = true
      lastActive = 0
      exitCode = message.exitCode
      mark('empty')
      clearTimeout(startupTimer)
      clearTimeout(lifetimeTimer)
      if (!didStart) rejectStarted(new Error('Windows Job released without starting its target'))
      if (!didStart) rejectRootExit(new Error('Windows Job released without starting its target'))
      else if (!rootExitFact)
        rejectRootExit(new Error('Windows Job root exit is unavailable after release'))
      // Authenticated empty proves physical release independently of a missing
      // root observation on an error path. It cannot prove natural exit/takeover.
      resolveEmpty({ generation, active: 0, exitCode: message.exitCode })
    } else if (message.kind === 'counts') {
      if (
        !didStart ||
        !exact(['kind', 'generation', 'active']) ||
        typeof message.active !== 'number' ||
        !Number.isSafeInteger(message.active) ||
        message.active < 0 ||
        message.active > 256
      )
        throw new Error('Invalid Job process count')
      lastActive = message.active
    } else if (message.kind === 'stopping') {
      if (
        !exact(['kind', 'generation', 'reason']) ||
        !['control-closed', 'deadline', 'descendants-still-running'].includes(
          String(message.reason),
        )
      )
        throw new Error('Invalid Job stop receipt')
      stoppingReason =
        message.reason === 'control-closed' || message.reason === 'deadline'
          ? message.reason
          : 'descendants-still-running'
    } else if (message.kind === 'error') {
      if (
        !exact(['kind', 'generation', 'code']) ||
        typeof message.code !== 'number' ||
        !Number.isSafeInteger(message.code)
      )
        throw new Error('Invalid Job error receipt')
      if (!didStart) rejectStarted(new Error('Windows Job could not start its target'))
      nativeErrorCode = message.code
    } else throw new Error('Unknown Job control packet')
  }
  server.on('connection', (connection) => {
    if (socket || disposed) {
      connection.destroy()
      return
    }
    socket = connection
    mark('connected')
    connection.on('data', (chunk: Buffer) => {
      try {
        if (buffer.length + chunk.length > 4096)
          throw new Error('Job control frame exceeds 4096 bytes')
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const end = buffer.indexOf(10)
          if (end < 0) break
          const line = buffer.subarray(0, end).toString('utf8')
          buffer = buffer.subarray(end + 1)
          receive(JSON.parse(line))
        }
      } catch {
        fail('Windows Job control validation failed')
      }
    })
    connection.on('error', () => {
      if (!didEmpty) fail('Windows Job control failed before release')
    })
    connection.on('close', () => {
      if (!didEmpty) fail('Windows Job closed without an authenticated empty receipt')
    })
  })
  server.on('error', () => fail('Windows Job control server failed'))
  const disposeControl = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    cancel()
    clearTimeout(startupTimer)
    clearTimeout(lifetimeTimer)
    if (!didEmpty) fail('Windows Job control disposed before release was confirmed')
    socket?.removeAllListeners()
    socket?.destroy()
    buffer = Buffer.alloc(0)
    if (server.listening) await new Promise<void>((done) => server.close(() => done()))
    server.removeAllListeners()
  }
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows Job pipe admission deadline')), 5000)
      const failed = (error: Error): void => {
        clearTimeout(timer)
        reject(error)
      }
      server.once('error', failed)
      server.listen(`\\\\.\\pipe\\${pipeName}`, () => {
        clearTimeout(timer)
        server.off('error', failed)
        done()
      })
    })
    const executablePath = join(directory, 'owned-launch.exe')
    let target = executable
    const prefix: string[] = []
    if (/\.cmd$/iu.test(executable)) {
      const entry = join(directory, 'native-command.mjs')
      await writeFile(entry, windowsRpcEntry(executable), { flag: 'wx', mode: 0o600 })
      target = process.execPath
      prefix.push(entry)
    }
    await writeFile(
      join(directory, 'owned-launch.json'),
      JSON.stringify({
        executable: target,
        prefix,
        pipe: pipeName,
        token,
        generation,
        timeout: lifetimeMs,
      }),
      { flag: 'wx', mode: 0o600 },
    )
    installImage(executablePath)
    lifetimeTimer = setTimeout(() => {
      cancel()
      fail('Windows Job lifetime ended without release confirmation')
    }, lifetimeMs + 5000)
    mark('prepared')
    return {
      executablePath,
      directory,
      generation,
      started,
      empty,
      rootExit,
      armStartup,
      cancel,
      disposeControl,
      diagnostic,
    }
  } catch (error) {
    await disposeControl()
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 })
    throw error
  }
}

function compilation(executable: string): { compiler: string; args: string[] } {
  return {
    compiler: join(
      process.env['SystemRoot'] ?? 'C:\\Windows',
      'Microsoft.NET',
      process.arch === 'ia32' ? 'Framework' : 'Framework64',
      'v4.0.30319/csc.exe',
    ),
    args: [
      '/nologo',
      '/target:exe',
      `/out:${executable}`,
      '/reference:System.Web.Extensions.dll',
      resolve(import.meta.dirname, '../../scripts/windows-e2e-job.cs'),
      resolve(import.meta.dirname, 'windows-cli-launcher.cs'),
    ],
  }
}

function windowsRpcEntry(actualExecutable: string): string {
  return String.raw`import {spawn} from 'node:child_process';
const executable=${JSON.stringify(actualExecutable)};
const args=process.argv.slice(2);
const command=/\.cmd$/iu.test(executable);
if(command&&[executable,...args].some(value=>/[&|<>^%!"\r\n]/u.test(value)))process.exit(1);
const child=spawn(command?(process.env.ComSpec??'cmd.exe'):executable,command?['/d','/s','/c','""'+executable+'" '+args.map(value=>'"'+value+'"').join(' ')+'"']:args,{shell:false,windowsHide:true,windowsVerbatimArguments:command,stdio:'inherit'});
child.once('error',()=>process.exit(1));child.once('exit',code=>{process.exitCode=code??1});
`
}

/** Cold synchronous construction preserves NativeRpc's existing constructor interface. */
export function writeWindowsRpcLauncher(
  actualExecutable: string,
  temporaryDirectory: string,
): { executable: string; directory: string } {
  if (
    !isAbsolute(actualExecutable) ||
    actualExecutable.length > 4096 ||
    actualExecutable.includes('\0')
  )
    throw new Error('Windows Native RPC needs one bounded absolute executable path')
  const directory = mkdtempSync(join(realpathSync(temporaryDirectory), 'pact-native-rpc-'))
  try {
    const entry = join(directory, 'native-entry.mjs')
    writeFileSync(entry, windowsRpcEntry(actualExecutable), { flag: 'wx', mode: 0o600 })
    const executable = join(directory, 'native-rpc.exe')
    writeFileSync(
      join(directory, 'native-rpc.json'),
      JSON.stringify({ executable: process.execPath, prefix: [entry] }),
      { flag: 'wx', mode: 0o600 },
    )
    installImage(executable)
    return { executable, directory }
  } catch {
    removeWindowsRpcLauncherSync(directory)
    throw new Error('Owned Windows Native RPC launcher could not compile')
  }
}

/** A Windows native entry for an owned JS fixture/relay, with kernel cleanup on launcher death. */
export async function writeWindowsNodeLauncher(
  directory: string,
  name: string,
  prefix: string[],
): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Windows launcher requires Windows')
  if (
    !/^[a-z-]{1,64}$/u.test(name) ||
    prefix.length > 4 ||
    prefix.some((value) => value.length > 4096)
  )
    throw new Error('Windows fixture launcher arguments exceed their bound')
  const executable = join(directory, `${name}.exe`)
  await writeFile(
    join(directory, `${name}.json`),
    JSON.stringify({ executable: process.execPath, prefix }),
    { flag: 'wx', mode: 0o600 },
  )
  installImage(executable)
  return executable
}
