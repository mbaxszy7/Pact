import { ChildProcess, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, unlink, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'

import {
  decisionPhysicalWitnessSchema,
  type DecisionPhysicalWitness,
  type DecisionWindowsPhysicalWitness,
} from '@pact/contracts/decision-physical-witness'

import {
  NativeWorkingMemory,
  type NativeMemoryAllocator,
  type NativeMemoryReservation,
} from './conversation/native-working-memory'

/** Incremental bridge workspace: native arena <300 KiB, one reused request
 * 128 KiB, control kernel/Node buffers <=256 KiB, facade buffers <=192 KiB,
 * fixed replies/receipts <4 KiB. The three existing native protocol pipes retain
 * their caller's transport accounting. This is not a native RSS/stack claim. */
export const WINDOWS_OWNER_WORKSPACE_BYTES = 1024 * 1024
const FRAME_BYTES = 128 * 1024
const RESPONSE_BYTES = 1024
const RECEIPT_BYTES = 256
const PREPARE_MS = 15_000
const CLEANUP_MS = 4_000
const MAX_RECEIPTS = 32
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
type Birth = { pid: number; creationFileTime: string }
type SpawnOptions = {
  cwd?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  signal?: AbortSignal | undefined
  windowsHide?: boolean | undefined
  windowsVerbatimArguments?: boolean | undefined
}
export interface WindowsOwnedProcessConfiguration {
  windowsBridgeExecutable: string
  receiptDirectory: string
}
export interface WindowsOwnedProcessOptions {
  windows?: WindowsOwnedProcessConfiguration | undefined
  ownerId?: string | undefined
  physicalPrepared?: ((witness: DecisionPhysicalWitness) => void | Promise<void>) | undefined
  deadlineAt?: number | undefined
  memory?: NativeMemoryAllocator | undefined
}
export interface PhysicalReceiptOperation {
  /** The same absolute cleanup deadline is reused across a serial retirement batch. */
  deadlineAt: number
  signal?: AbortSignal | undefined
}
export type PhysicalReceiptRetirementResult = 'removed' | 'already_absent' | 'unconfirmed'
type ReceiptOperationResult = PhysicalReceiptRetirementResult | 'verified'
let configuration: Readonly<WindowsOwnedProcessConfiguration> | undefined
let pendingAllocations = 0

/** Bootstrap path configuration only. Admission and persistence retain their existing owners. */
export function configureOwnedProcessGroups(value: WindowsOwnedProcessConfiguration): void {
  const next = validateConfiguration(value)
  if (
    configuration &&
    (configuration.windowsBridgeExecutable !== next.windowsBridgeExecutable ||
      configuration.receiptDirectory !== next.receiptDirectory)
  )
    throw Error('Windows process ownership configuration is already fixed.')
  configuration ??= Object.freeze(next)
}
function validateConfiguration(value: WindowsOwnedProcessConfiguration) {
  if (
    !isAbsolute(value.windowsBridgeExecutable) ||
    !isAbsolute(value.receiptDirectory) ||
    [value.windowsBridgeExecutable, value.receiptDirectory].some(
      (entry) => entry.includes('\0') || entry.length > 32_000,
    )
  )
    throw Error('Windows process ownership resources are invalid.')
  return {
    windowsBridgeExecutable: resolvePath(value.windowsBridgeExecutable),
    receiptDirectory: resolvePath(value.receiptDirectory),
  }
}
function configured(value?: WindowsOwnedProcessConfiguration) {
  const selected = value ? validateConfiguration(value) : configuration
  if (!selected) throw Error('Windows process ownership resources are unavailable.')
  return selected
}
const failure = () => Error('Windows process ownership could not be confirmed.')
const ignoreHelperInputError = () => undefined
const remaining = (deadline: number) => Math.max(0, Math.floor(deadline - Date.now()))
async function within<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), Math.max(1, remaining(deadline)))
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Exactly one frame is constructed under a prior 1 MiB workspace reservation. */
class RequestWriter {
  private offset = 4
  constructor(private readonly bytes: Buffer = Buffer.alloc(FRAME_BYTES)) {}
  private admit(count: number): number {
    if (count < 0 || count > this.bytes.length - this.offset) throw failure()
    const offset = this.offset
    this.offset += count
    return offset
  }
  byte(value: number): void {
    this.bytes.writeUInt8(value, this.admit(1))
  }
  u32(value: number): void {
    this.bytes.writeUInt32LE(value, this.admit(4))
  }
  u64(value: string | bigint): void {
    this.bytes.writeBigUInt64LE(BigInt(value), this.admit(8))
  }
  hex(value: string, size: number): void {
    if (value.length !== size * 2 || !/^[a-f0-9]+$/u.test(value)) throw failure()
    this.bytes.write(value, this.admit(size), size, 'hex')
  }
  uuid(value: string): void {
    if (!UUID.test(value)) throw failure()
    this.hex(value.replaceAll('-', ''), 16)
  }
  text(value: string): void {
    if (value.length > 32767 || value.includes('\0')) throw failure()
    this.u32(value.length)
    // Alignment is relative to the payload; its first byte follows the 4-byte header.
    if (this.offset % 2) this.byte(0)
    this.bytes.write(value, this.admit(value.length * 2), value.length * 2, 'utf16le')
  }
  birth(value: Birth): void {
    this.u32(value.pid)
    this.u64(value.creationFileTime)
  }
  finish(): Buffer {
    this.bytes.writeUInt32LE(this.offset - 4, 0)
    return this.bytes.subarray(0, this.offset)
  }
}
function baseRequest(
  ownerId: string,
  generation: string,
  receiptId: string,
  path: string,
  ownerPid: number,
  buffer?: Buffer,
): RequestWriter {
  const writer = new RequestWriter(buffer)
  writer.byte(1)
  writer.u32(ownerPid)
  writer.uuid(ownerId)
  writer.uuid(generation)
  writer.uuid(receiptId)
  writer.text(path)
  return writer
}
function boundRequest(
  witness: DecisionWindowsPhysicalWitness,
  path: string,
  buffer?: Buffer,
): RequestWriter {
  const writer = baseRequest(
    witness.ownerId,
    witness.generation,
    witness.receipt.id,
    path,
    witness.owner.pid,
    buffer,
  )
  writer.u64(witness.owner.creationFileTime)
  writer.u64(BigInt(`0x${witness.receipt.volumeSerial}`))
  writer.hex(witness.receipt.fileId, 16)
  return writer
}
function readBirth(bytes: Buffer, offset: number): Birth {
  const pid = bytes.readUInt32LE(offset)
  const creationFileTime = bytes.readBigUInt64LE(offset + 4).toString()
  if (!pid || pid > 0x7fffffff || creationFileTime === '0') throw failure()
  return { pid, creationFileTime }
}
function receiptPath(config: WindowsOwnedProcessConfiguration, id: string): string {
  if (!UUID.test(id)) throw failure()
  return join(config.receiptDirectory, `${id}.receipt`)
}

/** One binary control socket, one outstanding operation, no task queue. */
class BridgeControl {
  private readonly buffer = Buffer.alloc(RESPONSE_BYTES + 4)
  private used = 0
  private waiter:
    | { kind: number; resolve: (value: Buffer) => void; reject: (error: Error) => void }
    | undefined
  private failed: Error | undefined
  private writing = false
  private stopDeadline: number | undefined
  private stopSent = false
  private readonly data = (value: Buffer) => {
    try {
      let offset = 0
      while (offset < value.length) {
        const length = Math.min(value.length - offset, this.buffer.length - this.used)
        value.copy(this.buffer, this.used, offset, offset + length)
        this.used += length
        offset += length
        while (this.used >= 4) {
          const bytes = this.buffer.readUInt32LE(0)
          if (!bytes || bytes > RESPONSE_BYTES) throw failure()
          if (this.used < bytes + 4) break
          const frame = Buffer.from(this.buffer.subarray(4, 4 + bytes))
          this.buffer.copyWithin(0, bytes + 4, this.used)
          this.used -= bytes + 4
          if (frame[0] === 16) {
            if (frame.length !== 5) throw failure()
            this.reject(failure()) // A following genuine empty receipt still matters.
            continue
          }
          if (!this.onFact(frame)) {
            const waiter = this.waiter
            if (!waiter || waiter.kind !== frame[0]) throw failure()
            this.waiter = undefined
            waiter.resolve(frame)
          }
        }
        if (this.used === this.buffer.length) throw failure()
      }
    } catch {
      this.reject(failure())
    }
  }
  private readonly ended = () => this.reject(failure())
  constructor(
    readonly stream: Duplex,
    private readonly onFact: (frame: Buffer) => boolean,
    private readonly onFailure: () => void,
  ) {
    stream.on('data', this.data)
    stream.once('end', this.ended)
    stream.once('error', this.ended)
  }
  expect(kind: number): Promise<Buffer> {
    if (this.failed) return Promise.reject(this.failed)
    if (this.waiter) return Promise.reject(failure())
    const pending = new Promise<Buffer>((resolve, reject) => {
      this.waiter = { kind, resolve, reject }
    })
    void pending.catch(() => undefined)
    return pending
  }
  write(bytes: Buffer): Promise<void> {
    if (this.failed || this.writing || this.stream.destroyed || this.stream.writableEnded)
      return Promise.reject(failure())
    this.writing = true
    return new Promise((resolve, reject) => {
      this.stream.write(bytes, (error) => {
        this.writing = false
        if (error) reject(failure())
        else resolve()
        this.flushStop()
      })
    })
  }
  stop(deadline: number): void {
    this.stopDeadline = Math.min(this.stopDeadline ?? deadline, deadline)
    this.flushStop()
  }
  private flushStop(): void {
    if (this.writing || this.stopSent || this.stopDeadline === undefined) return
    this.stopSent = true
    const message = Buffer.alloc(9)
    message.writeUInt32LE(5, 0)
    message[4] = 3
    message.writeUInt32LE(Math.min(CLEANUP_MS, remaining(this.stopDeadline)), 5)
    void this.write(message).catch(() => this.end())
  }
  end(): void {
    if (!this.stream.destroyed && !this.stream.writableEnded) this.stream.end()
  }
  dispose(): void {
    this.stream.off('data', this.data)
    this.stream.off('end', this.ended)
    this.stream.off('error', this.ended)
    this.reject(failure(), false)
  }
  private reject(error: Error, notify = true): void {
    if (this.failed) return
    this.failed = error
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.reject(error)
    if (notify) this.onFailure()
  }
}

type Helper = {
  process: ChildProcess
  control: BridgeControl | undefined
  closed: Promise<void>
  spawned: boolean
  closedFact: boolean
}
function controlOf(helper: Helper): BridgeControl {
  if (!helper.control) throw failure()
  return helper.control
}
function requirePipedChild(child: ChildProcess): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) throw failure()
}
function startHelper(
  config: WindowsOwnedProcessConfiguration,
  mode: 'prepare' | 'run' | 'prove' | 'retire' | 'verify',
  file: FileHandle | undefined,
  options: SpawnOptions,
  facts: (frame: Buffer) => boolean,
  onFailure: () => void,
): Helper {
  const child = spawn(config.windowsBridgeExecutable, [mode], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    shell: false,
    // The run bridge must survive its owner to seal physical cleanup.
    detached: mode === 'run',
    // The Node signal is deliberately not forwarded: killing the bridge loses proof.
    stdio:
      mode === 'run'
        ? ['pipe', 'pipe', 'pipe', 'pipe', file?.fd ?? 'ignore']
        : ['ignore', 'ignore', 'ignore', 'pipe', file?.fd ?? 'ignore'],
  })
  const stream = child.stdio[3]
  // Retain the actual child even if an unsupported host cannot supply control.
  // Its physical close still has to be joined before capacity can be returned.
  const result: Helper = {
    process: child,
    control: stream instanceof Duplex ? new BridgeControl(stream, facts, onFailure) : undefined,
    closed: new Promise((resolve) => child.once('close', () => resolve())),
    spawned: false,
    closedFact: false,
  }
  const spawned = () => {
    result.spawned = true
  }
  child.once('spawn', spawned)
  child.once('error', onFailure)
  child.once('close', () => {
    result.closedFact = true
    child.off('spawn', spawned)
    child.off('error', onFailure)
    child.stdin?.off('error', ignoreHelperInputError)
    result.control?.dispose()
  })
  child.stdin?.on('error', ignoreHelperInputError)
  return result
}
async function allocateReceipt(
  config: WindowsOwnedProcessConfiguration,
  id: string,
): Promise<FileHandle> {
  pendingAllocations++
  try {
    if (pendingAllocations > MAX_RECEIPTS) throw failure()
    await mkdir(config.receiptDirectory, { recursive: true, mode: 0o700 })
    const directory = await lstat(config.receiptDirectory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure()
    const entries = await opendir(config.receiptDirectory)
    let count = 0
    for await (const entry of entries) {
      if (
        !entry.isFile() ||
        !/^[a-f0-9-]{36}\.receipt$/u.test(entry.name) ||
        ++count + pendingAllocations > MAX_RECEIPTS
      )
        throw failure()
      const info = await lstat(join(config.receiptDirectory, entry.name))
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 2048)
        throw failure()
    }
    return await open(
      receiptPath(config, id),
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
      0o600,
    )
  } finally {
    pendingAllocations--
  }
}

/** Platform implementation of OwnedProcessGroup. It owns no business admission or DB state. */
export class WindowsOwnedProcess {
  readonly child: ChildProcessWithoutNullStreams
  private readonly input = new PassThrough({ highWaterMark: 16 * 1024 })
  private readonly output = new PassThrough({ highWaterMark: 16 * 1024 })
  private readonly error = new PassThrough({ highWaterMark: 16 * 1024 })
  private readonly config: Readonly<WindowsOwnedProcessConfiguration>
  private readonly reservation: NativeMemoryReservation
  private readonly requestBuffer: Buffer
  private readonly ownerId: string
  private readonly generation = randomUUID()
  private readonly receiptId = randomUUID()
  private readonly preparationDeadline: number
  private readonly durable: boolean
  private receipt: FileHandle | undefined
  private witness: DecisionWindowsPhysicalWitness | undefined
  private helper: Helper | undefined
  private initialization: Promise<void>
  private closing: Promise<void> | undefined
  private stopRequested = false
  private cleanupDeadline: number | undefined
  private empty = false
  private rootExited = false
  private startupError: Error | undefined
  private nativeWasStarted = false
  private didRelease = false
  private facadeClosed = false
  private rootExitCode: number | null = null
  private killed = false
  private readonly abort = () => this.requestStop()

  constructor(
    command: string,
    args: string[],
    private readonly spawnOptions: SpawnOptions,
    private readonly options: WindowsOwnedProcessOptions,
  ) {
    this.config = configured(options.windows)
    this.ownerId = options.ownerId ?? randomUUID()
    if (!UUID.test(this.ownerId) || (options.physicalPrepared && !options.ownerId)) throw failure()
    if (
      options.deadlineAt !== undefined &&
      (!Number.isFinite(options.deadlineAt) ||
        remaining(options.deadlineAt) <= 0 ||
        remaining(options.deadlineAt) > PREPARE_MS)
    )
      throw failure()
    if (options.physicalPrepared && (!options.memory || options.deadlineAt === undefined))
      throw failure()
    this.preparationDeadline = Math.min(Date.now() + PREPARE_MS, options.deadlineAt ?? Infinity)
    this.durable = Boolean(options.physicalPrepared)
    this.reservation = (options.memory ?? new NativeWorkingMemory('business')).reserve(
      WINDOWS_OWNER_WORKSPACE_BYTES,
    )
    this.requestBuffer = Buffer.alloc(FRAME_BYTES)
    const child = new ChildProcess()
    child.stdin = this.input
    child.stdout = this.output
    child.stderr = this.error
    requirePipedChild(child)
    this.child = child
    Object.defineProperties(this.child, {
      stdio: { value: [this.input, this.output, this.error, null, null] },
      exitCode: { get: () => this.rootExitCode },
      killed: { get: () => this.killed },
    })
    this.child.kill = () => {
      this.killed = true
      this.requestStop()
      return true
    }
    this.child.ref = () => {
      this.helper?.process.ref()
    }
    this.child.unref = () => {
      this.helper?.process.unref()
    }
    this.input.on('error', () => undefined)
    this.child.on('error', () => undefined)
    spawnOptions.signal?.addEventListener('abort', this.abort, { once: true })
    this.initialization = Promise.resolve().then(() => this.initialize(command, args))
    void within(this.initialization, this.preparationDeadline).catch(() => {
      this.reportFailure()
      this.requestStop()
      if (!this.helper || this.helper.closedFact) this.closeFacade()
    })
  }

  get released(): boolean {
    return this.didRelease
  }

  async physicalWitness(ownerId: string): Promise<DecisionWindowsPhysicalWitness> {
    await within(this.initialization, this.preparationDeadline)
    if (
      this.stopRequested ||
      !this.witness ||
      this.witness.phase !== 'contained' ||
      ownerId !== this.ownerId
    )
      throw failure()
    return structuredClone(this.witness)
  }

  close(deadline: number): Promise<void> {
    this.cleanupDeadline = Math.min(this.cleanupDeadline ?? deadline, deadline)
    this.requestStop()
    this.closing ??= this.release(this.cleanupDeadline)
    return this.closing
  }

  private requestStop(): void {
    if (this.stopRequested) return
    this.stopRequested = true
    this.cleanupDeadline ??= Date.now() + CLEANUP_MS
    this.input.end()
    const helper = this.helper
    if (helper && !helper.closedFact) {
      if (this.nativeWasStarted) {
        helper.control?.stop(this.cleanupDeadline)
      } else helper.control?.end()
    }
  }

  private checkStarting(): void {
    if (
      this.stopRequested ||
      this.spawnOptions.signal?.aborted ||
      remaining(this.preparationDeadline) <= 0
    )
      throw failure()
  }

  private async prepared(witness: DecisionWindowsPhysicalWitness): Promise<void> {
    this.checkStarting()
    const parsed = decisionPhysicalWitnessSchema.parse(witness)
    if (parsed.platform !== 'win32') throw failure()
    this.witness = parsed
    await within(
      Promise.resolve(this.options.physicalPrepared?.(structuredClone(this.witness))),
      this.preparationDeadline,
    )
    this.checkStarting()
  }

  private async initialize(command: string, args: string[]): Promise<void> {
    this.checkStarting()
    if (!command || command.length > 32767 || command.includes('\0') || args.length > 4096)
      throw failure()
    const bridge = await lstat(this.config.windowsBridgeExecutable)
    if (!bridge.isFile() || bridge.isSymbolicLink()) throw failure()
    if (
      (await realpath(this.config.windowsBridgeExecutable)).toLowerCase() !==
      this.config.windowsBridgeExecutable.toLowerCase()
    )
      throw failure()
    this.receipt = await allocateReceipt(this.config, this.receiptId)
    this.checkStarting()
    const prepare = startHelper(
      this.config,
      'prepare',
      this.receipt,
      this.spawnOptions,
      () => false,
      () => undefined,
    )
    this.helper = prepare
    const prepareControl = controlOf(prepare)
    const answer = prepareControl.expect(11)
    const request = baseRequest(
      this.ownerId,
      this.generation,
      this.receiptId,
      receiptPath(this.config, this.receiptId),
      process.pid,
      this.requestBuffer,
    )
    await within(prepareControl.write(request.finish()), this.preparationDeadline)
    const facts = await within(answer, this.preparationDeadline)
    await within(prepare.closed, this.preparationDeadline)
    if (facts.length !== 37 || prepare.process.exitCode !== 0) throw failure()
    const owner = readBirth(facts, 1)
    if (owner.pid !== process.pid) throw failure()
    await this.prepared({
      version: 2,
      platform: 'win32',
      ownerId: this.ownerId,
      generation: this.generation,
      protocolVersion: 1,
      phase: 'allocated',
      receipt: {
        id: this.receiptId,
        volumeSerial: facts.readBigUInt64LE(13).toString(16).padStart(16, '0'),
        fileId: facts.subarray(21, 37).toString('hex'),
      },
      owner,
    })
    this.checkStarting()
    const helper = startHelper(
      this.config,
      'run',
      this.receipt,
      this.spawnOptions,
      (frame) => this.fact(frame),
      () => this.requestStop(),
    )
    this.helper = helper
    this.nativeWasStarted = true
    const control = controlOf(helper)
    requirePipedChild(helper.process)
    this.input.pipe(helper.process.stdin)
    helper.process.stdout.pipe(this.output)
    helper.process.stderr.pipe(this.error)
    void helper.closed.then(() => this.closeFacade())
    const contained = control.expect(12)
    const start = boundRequest(
      this.witness!,
      receiptPath(this.config, this.receiptId),
      this.requestBuffer,
    )
    start.u64(BigInt(this.options.deadlineAt ?? 0))
    start.u64(BigInt(this.preparationDeadline))
    start.byte(this.spawnOptions.windowsVerbatimArguments ? 1 : 0)
    start.text(command)
    start.u32(args.length)
    for (const argument of args) start.text(argument)
    await within(control.write(start.finish()), this.preparationDeadline)
    const actual = await within(contained, this.preparationDeadline)
    if (actual.length !== 25) throw failure()
    const bridgeBirth = readBirth(actual, 1),
      root = readBirth(actual, 13)
    if (bridgeBirth.pid !== helper.process.pid) throw failure()
    await this.prepared({
      ...this.witness!,
      phase: 'contained',
      bridge: bridgeBirth,
      root,
      atomicJob: true,
      noBreakaway: true,
    })
    Object.defineProperty(this.child, 'pid', { value: root.pid })
    this.checkStarting()
    await within(control.write(Buffer.from([1, 0, 0, 0, 2])), this.preparationDeadline)
    this.child.emit('spawn')
  }

  private fact(frame: Buffer): boolean {
    if (frame[0] === 14) {
      if (frame.length !== 5 || this.rootExited) throw failure()
      this.rootExited = true
      this.rootExitCode = frame.readUInt32LE(1)
      this.child.emit('exit', this.child.exitCode, null)
      return true
    }
    if (frame[0] === 13) {
      if (frame.length !== 5 || this.empty) throw failure()
      if (this.rootExited && this.rootExitCode !== frame.readUInt32LE(1)) throw failure()
      this.empty = true
      return true
    }
    return false
  }

  private closeFacade(): void {
    if (this.facadeClosed) return
    this.facadeClosed = true
    // A lost bridge is an error, never an invented native exit code or signal.
    if (!this.rootExited) this.reportFailure()
    this.input.destroy()
    this.output.end()
    this.error.end()
    this.spawnOptions.signal?.removeEventListener('abort', this.abort)
    this.child.emit('close', this.child.exitCode, null)
  }

  private reportFailure(): void {
    if (this.startupError) return
    this.startupError = failure()
    this.child.emit('error', this.startupError)
  }

  private async release(deadline: number): Promise<void> {
    // Late persistence completion can never reopen the start gate.
    await within(
      this.initialization.catch(() => undefined),
      deadline,
    )
    const helper = this.helper
    if (helper) await within(helper.closed, deadline)
    if (
      this.nativeWasStarted &&
      !this.empty &&
      (helper?.spawned || helper?.process.pid !== undefined)
    ) {
      // A bridge can finish its flushed receipt just before losing control. Verify
      // that actual record only after bridge close; missing/partial records fail.
      if (
        !this.witness ||
        (await runReceiptOperation(
          this.witness,
          this.config,
          'verify',
          deadline,
          undefined,
          true,
        )) !== 'verified'
      )
        throw failure()
      this.empty = true
    }
    if (this.receipt) {
      await within(this.receipt.close(), deadline)
      this.receipt = undefined
    }
    if (!this.durable && this.witness) {
      const result = await runReceiptOperation(
        this.witness,
        this.config,
        'retire',
        deadline,
        undefined,
        true,
      )
      if (result !== 'removed' && result !== 'already_absent') throw failure()
    } else if (!this.witness && !this.nativeWasStarted) {
      await within(
        unlink(receiptPath(this.config, this.receiptId)).catch((error: unknown) => {
          if (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'ENOENT')
            throw error
        }),
        deadline,
      )
    }
    this.closeFacade()
    this.didRelease = true
    this.reservation.release()
  }
}

function receiptDeadline(operation?: PhysicalReceiptOperation): number {
  const deadline = operation?.deadlineAt ?? Date.now() + CLEANUP_MS
  if (!Number.isSafeInteger(deadline)) throw failure()
  return Math.min(deadline, Date.now() + CLEANUP_MS)
}

/** Read-only recovery. Logical timeout fixes false, but this promise remains
 * pending until the helper, every started I/O and its handles physically join. */
export async function proveWindowsPhysicalRelease(
  witness: DecisionWindowsPhysicalWitness,
  selected?: WindowsOwnedProcessConfiguration,
  memory?: NativeMemoryAllocator,
  operation?: PhysicalReceiptOperation,
): Promise<boolean> {
  const result = await runReceiptOperation(
    witness,
    configured(selected),
    'prove',
    receiptDeadline(operation),
    memory,
    false,
    operation?.signal,
  )
  return result === 'verified'
}

async function runReceiptOperation(
  witness: DecisionWindowsPhysicalWitness,
  config: WindowsOwnedProcessConfiguration,
  mode: 'prove' | 'retire' | 'verify',
  deadline: number,
  memory?: NativeMemoryAllocator,
  workspaceAlreadyReserved = false,
  signal?: AbortSignal,
): Promise<ReceiptOperationResult> {
  if (remaining(deadline) <= 0 || signal?.aborted) return 'unconfirmed'
  const reservation = workspaceAlreadyReserved
    ? undefined
    : (memory ?? new NativeWorkingMemory('decision')).reserve(WINDOWS_OWNER_WORKSPACE_BYTES)
  let file: FileHandle | undefined, helper: Helper | undefined
  let expired = false
  let result: ReceiptOperationResult = 'unconfirmed'
  let write: Promise<void> | undefined, answer: Promise<Buffer> | undefined
  const expire = () => {
    expired = true
    helper?.control?.end()
  }
  const timer = setTimeout(expire, remaining(deadline))
  signal?.addEventListener('abort', expire, { once: true })
  const checkCurrent = () => {
    if (signal?.aborted || remaining(deadline) <= 0) expire()
    if (expired) throw failure()
  }
  try {
    checkCurrent()
    const executable = await lstat(config.windowsBridgeExecutable)
    checkCurrent()
    if (!executable.isFile() || executable.isSymbolicLink()) throw failure()
    const canonical = await realpath(config.windowsBridgeExecutable)
    checkCurrent()
    if (canonical.toLowerCase() !== config.windowsBridgeExecutable.toLowerCase()) throw failure()
    const path = receiptPath(config, witness.receipt.id)
    if (mode !== 'retire') {
      const info = await lstat(path)
      checkCurrent()
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size !== RECEIPT_BYTES
      )
        throw failure()
      file = await open(path, constants.O_RDONLY)
      checkCurrent()
    }
    // Retirement opens/pins the private directory and exact leaf in the native
    // helper, including the absent-leaf case. Node ENOENT alone never authorizes
    // an already_absent result. No helper starts after delayed I/O expires.
    checkCurrent()
    helper = startHelper(
      config,
      mode,
      file,
      {},
      () => false,
      () => undefined,
    )
    checkCurrent()
    const control = controlOf(helper)
    answer = control.expect(mode === 'retire' ? 17 : 15)
    const request = boundRequest(witness, path)
    request.byte(witness.phase === 'contained' ? 1 : 0)
    if (witness.phase === 'contained') {
      request.birth(witness.bridge)
      request.birth(witness.root)
    }
    write = control.write(request.finish())
    await write
    const response = await answer
    await helper.closed
    if (response.length === 2 && helper.process.exitCode === 0) {
      if (mode === 'retire') {
        if (response[1] === 1) result = 'removed'
        else if (response[1] === 2) result = 'already_absent'
      } else if (response[1] === 1) result = 'verified'
    }
  } catch {
    result = 'unconfirmed'
  } finally {
    helper?.control?.end()
    // Physical settlement deliberately has no replacement timeout. The caller's
    // UI/reporting timer may expire, while its recovery/stage latch keeps this
    // promise and the borrowed workspace until every resource really closes.
    await helper?.closed
    helper?.control?.dispose()
    await Promise.allSettled([write, answer].filter((entry) => entry !== undefined))
    if (file) {
      try {
        await file.close()
      } catch {
        // FileHandle's close event/fd=-1 occur before its OS close promise settles.
        // A failed close has no further physical proof: retain this gate/lease
        // until process teardown instead of acknowledging unknown closure.
        result = 'unconfirmed'
        expire()
        await new Promise<never>(() => undefined)
      }
    }
    if (signal?.aborted || remaining(deadline) <= 0) expired = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', expire)
    reservation?.release()
  }
  return expired ? 'unconfirmed' : result
}

/** Post-commit cleanup, never physical proof: the Repository must have committed
 * a retiring intent for this physically closed generation. Unknown owners are
 * ineligible. Every result is withheld until helper/handle/I/O settlement. */
export async function cleanupWindowsPhysicalReceipt(
  witness: DecisionWindowsPhysicalWitness,
  selected?: WindowsOwnedProcessConfiguration,
  memory?: NativeMemoryAllocator,
  operation?: PhysicalReceiptOperation,
): Promise<PhysicalReceiptRetirementResult> {
  const result = await runReceiptOperation(
    witness,
    configured(selected),
    'retire',
    receiptDeadline(operation),
    memory,
    false,
    operation?.signal,
  )
  return result === 'removed' || result === 'already_absent' ? result : 'unconfirmed'
}
