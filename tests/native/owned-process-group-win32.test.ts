import type { PathLike } from 'node:fs'

/* oxlint-disable no-await-in-loop -- Bounded native lifecycles and handle observations are sequential by ownership. */
import assert from 'node:assert/strict'
import {
  ChildProcess,
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { getEventListeners, once } from 'node:events'
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline'
import { Duplex } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  DecisionMemoryLease,
  NativeWorkingMemory,
  NATIVE_OWNER_WORKING_BYTES,
} from '../../apps/desktop/src/utility/conversation/native-working-memory.js'
import { OwnedProcessGroup } from '../../apps/desktop/src/utility/owned-process-group.js'
import {
  cleanupWindowsPhysicalReceipt,
  proveWindowsPhysicalRelease,
  WINDOWS_OWNER_WORKSPACE_BYTES,
} from '../../apps/desktop/src/utility/win32-owned-process-group.js'
import {
  decisionPhysicalWitnessSchema,
  type DecisionWindowsPhysicalWitness,
} from '../../packages/contracts/src/decision-physical-witness.js'

const execute = promisify(execFile)
const seam = vi.hoisted(() => ({
  spawn: undefined as (() => ChildProcess) | undefined,
  afterLstat: undefined as ((path: PathLike) => Promise<void>) | undefined,
  afterOpen: undefined as ((path: PathLike, file: FileHandle) => Promise<void>) | undefined,
}))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (command: string, args: readonly string[] = [], options: SpawnOptions = {}) =>
      seam.spawn ? seam.spawn() : actual.spawn(command, args, options),
  }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const value = await actual.lstat(...args)
      await seam.afterLstat?.(args[0])
      return value
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const value = await actual.open(...args)
      await seam.afterOpen?.(args[0], value)
      return value
    },
  }
})
let directory = '',
  observerExecutable = '',
  bridgeExecutable = ''

// Independent test observer: it retains actual kernel process handles. No PID
// lookup after admission, no product receipt interpretation, no process scan.
// Its kill command is failure cleanup, used only after product assertions.
const observerSource = String.raw`
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <stdio.h>
#include <string.h>
int main(int argc, char** argv) {
  if (argc == 2 && !strcmp(argv[1], "handles")) {
    STARTUPINFOW startup{}; GetStartupInfoW(&startup);
    printf("%u\n", static_cast<unsigned>(startup.cbReserved2)); fflush(stdout); return 0;
  }
  HANDLE held[4]{}; DWORD pids[4]{}; unsigned long long births[4]{}; unsigned count = 0;
  char line[256]; puts("ready"); fflush(stdout);
  while (fgets(line, sizeof(line), stdin)) {
    if (!strncmp(line, "hold ", 5)) {
      if (count) return 2;
      char* cursor = line + 5;
      while (*cursor && *cursor != '\n') {
        unsigned long pid = 0; int consumed = 0;
        if (count == 4 || sscanf_s(cursor, "%lu%n", &pid, &consumed) != 1 || consumed <= 0) return 3;
        HANDLE handle = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE, FALSE, pid);
        if (!handle) return 4;
        FILETIME birth{}, end{}, kernel{}, user{};
        if (!GetProcessTimes(handle, &birth, &end, &kernel, &user)) return 5;
        held[count] = handle; pids[count] = pid;
        births[count] = (static_cast<unsigned long long>(birth.dwHighDateTime) << 32) | birth.dwLowDateTime;
        ++count; cursor += consumed; while (*cursor == ' ') ++cursor;
      }
    } else if (!strncmp(line, "kill", 4)) {
      for (unsigned index = 0; index < count; ++index) {
        if (WaitForSingleObject(held[index], 0) == WAIT_TIMEOUT && !TerminateProcess(held[index], 7)) return 6;
        if (WaitForSingleObject(held[index], 1000) != WAIT_OBJECT_0) return 7;
      }
    } else if (!strncmp(line, "first", 5)) {
      if (!count || !TerminateProcess(held[0], 7)) return 8;
    } else if (strncmp(line, "state", 5)) return 9;
    for (unsigned index = 0; index < count; ++index)
      printf("%s%lu:%llu:%u", index ? ";" : "", pids[index], births[index],
        WaitForSingleObject(held[index], 0) == WAIT_OBJECT_0 ? 1u : 0u);
    puts(""); fflush(stdout);
  }
  for (unsigned index = 0; index < count; ++index) CloseHandle(held[index]);
  return 0;
}
`

async function deadline<T>(work: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Windows ownership fixture deadline')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

class Observer {
  private readonly lines
  private readonly closed: Promise<void>
  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.lines = createInterface({ input: child.stdout })
    this.closed = new Promise((done) => child.once('close', () => done()))
    child.stderr.resume()
  }
  static async create(): Promise<Observer> {
    const child = spawn(observerExecutable, [], { stdio: 'pipe', shell: false, windowsHide: true })
    const observer = new Observer(child)
    assert.equal((await deadline(once(observer.lines, 'line')))[0], 'ready')
    return observer
  }
  async command(command: string): Promise<Array<{ pid: number; birth: string; exited: boolean }>> {
    const response = deadline(once(this.lines, 'line'))
    this.child.stdin.write(`${command}\n`)
    const [text] = await response
    if (typeof text !== 'string' || text.length > 1024) throw Error('Observer frame bound')
    return text.split(';').map((entry) => {
      const match = /^(\d+):(\d+):([01])$/u.exec(entry)
      if (!match) throw Error('Observer identity frame')
      return { pid: Number(match[1]), birth: match[2]!, exited: match[3] === '1' }
    })
  }
  async close(): Promise<void> {
    this.child.stdin.end()
    await deadline(this.closed)
    this.lines.close()
  }
}

function windows(receipts: string) {
  return { windowsBridgeExecutable: bridgeExecutable, receiptDirectory: receipts }
}
async function scratch(): Promise<string> {
  return mkdtemp(join(directory, 'case-'))
}
async function line(child: ChildProcessWithoutNullStreams): Promise<string> {
  const reader = createInterface({ input: child.stdout })
  try {
    const [text] = await deadline(once(reader, 'line'), 15_000)
    if (typeof text !== 'string' || text.length > 4096) throw Error('Fixture output bound')
    return text
  } finally {
    reader.close()
  }
}
async function emptyHandles(observer: Observer): Promise<void> {
  const until = Date.now() + 4000
  while (Date.now() < until) {
    if ((await observer.command('state')).every((entry) => entry.exited)) return
    await new Promise((done) => setTimeout(done, 10))
  }
  throw Error('Original Windows handles remain live')
}
const grandchild = 'setInterval(()=>{},1000)'
const descendant = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',shell:false});console.log(child.pid);process.stdout.end();setInterval(()=>{},1000)`
const orphanRoot = `const{spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore'],shell:false});child.stdout.once('data',chunk=>{console.log(child.pid+' '+String(chunk).trim());process.stdin.once('data',()=>process.exit(0))});setInterval(()=>{},1000)`

function latch() {
  let release!: () => void
  const settled = new Promise<void>((done) => {
    release = done
  })
  return { settled, release }
}
function heldHelper(kind: 15 | 17) {
  let closed = false,
    ended = false
  const control = new Duplex({
    read() {},
    write(_bytes, _encoding, done) {
      done()
      queueMicrotask(() => control.push(Buffer.from([2, 0, 0, 0, kind, 1])))
    },
    final(done) {
      ended = true
      done()
    },
  })
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdio: { value: [null, null, null, control, null] },
    exitCode: { get: () => (closed ? 0 : null) },
  })
  return {
    child,
    control,
    get ended() {
      return ended
    },
    close() {
      if (closed) return
      closed = true
      control.push(null)
      control.destroy()
      child.emit('close', 0, null)
    },
  }
}
async function operationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pact-proof-join-'))
  const receiptDirectory = join(root, 'receipts')
  await mkdir(receiptDirectory)
  const witness: DecisionWindowsPhysicalWitness = {
    version: 2,
    platform: 'win32',
    protocolVersion: 1,
    phase: 'allocated',
    ownerId: randomUUID(),
    generation: randomUUID(),
    owner: { pid: 123, creationFileTime: '1' },
    receipt: { id: randomUUID(), volumeSerial: '0'.repeat(16), fileId: '1'.repeat(32) },
  }
  const path = join(receiptDirectory, `${witness.receipt.id}.receipt`)
  await writeFile(path, Buffer.alloc(256))
  return {
    root,
    path,
    witness,
    config: { windowsBridgeExecutable: process.execPath, receiptDirectory },
  }
}

// These tests exercise the host's physical-completion contract at a controlled
// OS seam. They do not manufacture or certify a Windows Job/file-identity proof.
describe('Windows receipt helper physical completion contract', () => {
  it('keeps one recovery flight and its lease until a timed-out helper and the already-started file close both finish', async () => {
    const fixture = await operationFixture(),
      helper = heldHelper(15)
    const started = latch(),
      fileClosing = latch(),
      closeFile = latch()
    const memory = new NativeWorkingMemory('decision')
    let starts = 0,
      nextStage = 0,
      finished = false
    let recovery: Promise<boolean> | undefined
    let physical: Promise<boolean> | undefined
    seam.spawn = () => {
      starts++
      started.release()
      return helper.child
    }
    seam.afterOpen = async (path, file) => {
      if (path !== fixture.path) return
      const close = file.close.bind(file)
      vi.spyOn(file, 'close').mockImplementation(async () => {
        fileClosing.release()
        await closeFile.settled
        await close()
      })
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const until = Date.now() + 1000
      const recover = () =>
        (recovery ??= proveWindowsPhysicalRelease(fixture.witness, fixture.config, memory, {
          deadlineAt: until,
        }).finally(() => {
          recovery = undefined
        }))
      physical = recover()
      void physical.then(() => {
        finished = true
        nextStage++
        return undefined
      })
      await started.settled
      await vi.advanceTimersByTimeAsync(1001)
      expect(helper.ended).toBe(true)
      expect(finished).toBe(false)
      expect(recover()).toBe(physical)
      expect(starts).toBe(1)
      expect(nextStage).toBe(0)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
      helper.close()
      await fileClosing.settled
      expect(finished).toBe(false)
      expect(recover()).toBe(physical)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
      expect(getEventListeners(helper.control, 'data')).toHaveLength(0)
      closeFile.release()
      expect(await physical).toBe(false)
      expect(memory.bytes).toBe(0)
      expect(nextStage).toBe(1)
      expect(starts).toBe(1)
    } finally {
      helper.close()
      closeFile.release()
      await physical
      seam.spawn = undefined
      seam.afterOpen = undefined
      vi.restoreAllMocks()
      vi.useRealTimers()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it.each(['lstat-deadline', 'open-deadline', 'open-cancel'] as const)(
    'joins delayed %s I/O and never starts a helper after that operation becomes obsolete',
    async (mode) => {
      const fixture = await operationFixture(),
        entered = latch(),
        releaseIO = latch()
      const memory = new NativeWorkingMemory('decision'),
        controller = new AbortController()
      let starts = 0,
        finished = false,
        opened: FileHandle | undefined,
        physical: Promise<boolean> | undefined
      seam.spawn = () => {
        starts++
        return heldHelper(15).child
      }
      if (mode === 'lstat-deadline')
        seam.afterLstat = async (path) => {
          if (path === fixture.path) {
            entered.release()
            await releaseIO.settled
          }
        }
      else
        seam.afterOpen = async (path, file) => {
          if (path === fixture.path) {
            opened = file
            entered.release()
            await releaseIO.settled
          }
        }
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      try {
        physical = proveWindowsPhysicalRelease(fixture.witness, fixture.config, memory, {
          deadlineAt: Date.now() + 1000,
          signal: controller.signal,
        })
        void physical.then(() => {
          finished = true
          return undefined
        })
        await entered.settled
        if (mode === 'open-cancel') controller.abort()
        else await vi.advanceTimersByTimeAsync(1001)
        expect(finished).toBe(false)
        expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
        releaseIO.release()
        expect(await physical).toBe(false)
        expect(starts).toBe(0)
        expect(memory.bytes).toBe(0)
        expect(opened?.fd ?? -1).toBe(-1)
      } finally {
        releaseIO.release()
        await physical
        seam.spawn = undefined
        seam.afterLstat = undefined
        seam.afterOpen = undefined
        vi.restoreAllMocks()
        vi.useRealTimers()
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
  )

  it('withholds an unconfirmed retirement result until delayed physical close and consumes the same absolute batch deadline', async () => {
    const fixture = await operationFixture(),
      helper = heldHelper(17),
      started = latch()
    const memory = new NativeWorkingMemory('decision')
    let starts = 0,
      finished = false
    let physical: ReturnType<typeof cleanupWindowsPhysicalReceipt> | undefined
    seam.spawn = () => {
      starts++
      started.release()
      return helper.child
    }
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      const operation = { deadlineAt: Date.now() + 1000 }
      physical = cleanupWindowsPhysicalReceipt(fixture.witness, fixture.config, memory, operation)
      void physical.then(() => {
        finished = true
        return undefined
      })
      await started.settled
      await vi.advanceTimersByTimeAsync(1001)
      expect(finished).toBe(false)
      expect(memory.bytes).toBe(WINDOWS_OWNER_WORKSPACE_BYTES)
      helper.close()
      expect(await physical).toBe('unconfirmed')
      expect(memory.bytes).toBe(0)
      expect(
        await cleanupWindowsPhysicalReceipt(fixture.witness, fixture.config, memory, operation),
      ).toBe('unconfirmed')
      expect(starts).toBe(1)
    } finally {
      helper.close()
      await physical
      seam.spawn = undefined
      vi.restoreAllMocks()
      vi.useRealTimers()
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'win32')('Windows product OwnedProcessGroup', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pact-product-job-'))
    bridgeExecutable = resolvePath(
      `apps/desktop/out/native/owned-process-group-win32-${process.arch}.exe`,
    )
    // Missing target build is a hard failure on Windows, never a passing skip.
    assert((await stat(bridgeExecutable)).isFile(), 'The product Windows bridge must be built.')
    const source = join(directory, 'observer.cpp')
    observerExecutable = join(directory, 'observer.exe')
    await writeFile(source, observerSource)
    await execute(
      'cl.exe',
      [
        '/nologo',
        '/std:c++20',
        '/O2',
        '/MT',
        '/W4',
        '/WX',
        `/Fo${join(directory, 'observer.obj')}`,
        `/Fe${observerExecutable}`,
        source,
      ],
      { cwd: directory, shell: false, windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 },
    )
  })
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('persists allocated and contained phases before the first native instruction and forwards the real root identity', async () => {
    const root = await scratch(),
      ownerId = randomUUID(),
      marker = join(root, 'executed')
    const saved: DecisionWindowsPhysicalWitness[] = []
    let resume!: () => void, contained!: () => void
    const gate = new Promise<void>((done) => {
      resume = done
    })
    const ready = new Promise<void>((done) => {
      contained = done
    })
    const owner = new OwnedProcessGroup({
      windows: windows(join(root, 'receipts')),
      ownerId,
      deadlineAt: Date.now() + 15_000,
      memory: new NativeWorkingMemory('decision'),
      physicalPrepared: async (witness) => {
        if (witness.platform !== 'win32') throw Error('Wrong platform witness')
        saved.push(witness)
        await writeFile(join(root, 'witness.json'), JSON.stringify(witness))
        if (witness.phase === 'contained') {
          contained()
          await gate
        }
      },
    })
    const child = owner.spawn(process.execPath, [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');console.log(process.pid);process.stdin.resume();process.stdin.once('end',()=>process.exit(23))`,
    ])
    const output = line(child)
    child.stderr.resume()
    try {
      await deadline(ready, 15_000)
      expect(saved.map((entry) => entry.phase)).toEqual(['allocated', 'contained'])
      expect(await stat(marker).catch(() => undefined)).toBeUndefined()
      expect(child.pid).toBeUndefined()
      expect(owner.released).toBe(false)
      resume()
      const nativePid = Number(await output)
      expect(child.pid).toBe(nativePid)
      const witness = await owner.physicalWitness(ownerId)
      if (witness.platform !== 'win32' || witness.phase !== 'contained')
        throw Error('Missing containment')
      expect(witness.root.pid).toBe(nativePid)
      expect(witness.bridge.pid).not.toBe(nativePid)
      await owner.close()
      expect(owner.released).toBe(true)
      expect(child.exitCode).toBe(23)
      expect(
        await OwnedProcessGroup.provePhysicalRelease(witness, windows(join(root, 'receipts'))),
      ).toBe(false)
      // Test equivalent of committing release; the old Utility is intentionally still live.
      expect(
        await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(join(root, 'receipts'))),
      ).toBe('removed')
      expect(await readdir(join(root, 'receipts'))).toEqual([])
    } finally {
      resume()
      await owner.close()
    }
  })

  it('retains release while the root has exited and a grandchild is live, then proves both retained descendant handles exited before fixture cleanup', async () => {
    const root = await scratch(),
      observer = await Observer.create()
    const owner = new OwnedProcessGroup({ windows: windows(join(root, 'receipts')) })
    const child = owner.spawn(process.execPath, ['-e', orphanRoot])
    child.stderr.resume()
    const outside = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      stdio: 'ignore',
      shell: false,
    })
    const outsideClosed = new Promise<void>((done) => outside.once('close', () => done()))
    try {
      const [descendantPid, grandchildPid] = (await line(child)).split(' ').map(Number)
      const held = await observer.command(`hold ${child.pid} ${descendantPid} ${grandchildPid}`)
      expect(held).toHaveLength(3)
      expect(held.every((entry) => !entry.exited)).toBe(true)
      const rootExit = once(child, 'exit')
      child.stdin.write('root-exit\n')
      await deadline(rootExit)
      expect(owner.released).toBe(false)
      const closing = owner.close()
      const afterRoot = await observer.command('state')
      expect(afterRoot[0]?.exited).toBe(true)
      if (afterRoot.slice(1).some((entry) => !entry.exited)) assert.equal(owner.released, false)
      await closing
      expect(owner.released).toBe(true)
      expect((await observer.command('state')).every((entry) => entry.exited)).toBe(true)
      expect(() => process.kill(outside.pid!, 0)).not.toThrow()
    } finally {
      // These retained-handle cleanup calls happen strictly after the assertions.
      await observer.command('kill')
      await owner.close().catch(() => undefined)
      await observer.close()
      outside.kill()
      await deadline(outsideClosed)
    }
  })

  it('retires a cancelled pre-launch allocation only after confirmed release and refuses a mismatched file identity or outside path', async () => {
    const root = await scratch(),
      receipts = join(root, 'receipts'),
      outside = join(root, 'outside.receipt')
    await writeFile(outside, 'unrelated fixture')
    let resume!: () => void, allocated!: (value: DecisionWindowsPhysicalWitness) => void
    const gate = new Promise<void>((done) => {
      resume = done
    })
    const ready = new Promise<DecisionWindowsPhysicalWitness>((done) => {
      allocated = done
    })
    const owner = new OwnedProcessGroup({
      windows: windows(receipts),
      ownerId: randomUUID(),
      deadlineAt: Date.now() + 15_000,
      memory: new NativeWorkingMemory('decision'),
      physicalPrepared: async (witness) => {
        if (witness.platform !== 'win32' || witness.phase !== 'allocated')
          throw Error('A cancelled allocation must not launch')
        await writeFile(join(root, 'witness.json'), JSON.stringify(witness))
        allocated(witness)
        await gate
      },
    })
    const child = owner.spawn(process.execPath, ['-e', 'throw Error("must not run")'])
    child.stdout.resume()
    child.stderr.resume()
    try {
      const witness = await deadline(ready, 15_000)
      const receipt = join(receipts, `${witness.receipt.id}.receipt`)
      expect((await stat(receipt)).size).toBe(0)
      const closing = owner.close()
      resume()
      await closing
      expect(owner.released).toBe(true)
      expect(child.pid).toBeUndefined()
      expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
      const changedId =
        (witness.receipt.fileId[0] === '0' ? '1' : '0') + witness.receipt.fileId.slice(1)
      expect(
        await OwnedProcessGroup.cleanupPhysicalReceipt(
          { ...witness, receipt: { ...witness.receipt, fileId: changedId } },
          windows(receipts),
        ),
      ).toBe('unconfirmed')
      expect(
        await OwnedProcessGroup.cleanupPhysicalReceipt(
          { ...witness, receipt: { ...witness.receipt, id: '../outside' } },
          windows(receipts),
        ),
      ).toBe('unconfirmed')
      expect((await stat(receipt)).size).toBe(0)
      expect(await readFile(outside, 'utf8')).toBe('unrelated fixture')
      // Equivalent of the Repository's committed release; this is retirement,
      // not conversion of the zero-byte receipt into cold physical proof.
      expect(await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(receipts))).toBe(
        'removed',
      )
      expect(await readdir(receipts)).toEqual([])
      // The prior removal succeeded, but its Repository ACK was lost. A retry
      // acknowledges only absence below the still-validated private directory.
      expect(await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(receipts))).toBe(
        'already_absent',
      )
      expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
      await writeFile(receipt, 'replacement file')
      expect(await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(receipts))).toBe(
        'unconfirmed',
      )
      expect(await readFile(receipt, 'utf8')).toBe('replacement file')
      const saved = join(root, 'saved-receipts'),
        other = join(root, 'other')
      await mkdir(other)
      await rename(receipts, saved)
      await symlink(other, receipts, 'junction')
      try {
        expect(await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(receipts))).toBe(
          'unconfirmed',
        )
      } finally {
        await rm(receipts, { recursive: true, force: true })
        await rename(saved, receipts)
      }
    } finally {
      resume()
      await owner.close()
    }
  })

  it.each(['sdk-kill', 'owner-abort', 'spawn-abort'] as const)(
    'routes %s through product control and joins the bridge',
    async (mode) => {
      const root = await scratch(),
        ownerAbort = new AbortController(),
        childAbort = new AbortController()
      const owner = new OwnedProcessGroup({
        windows: windows(join(root, 'receipts')),
        signal: ownerAbort.signal,
      })
      const child = owner.spawn(
        process.execPath,
        ['-e', 'console.log("ready");setInterval(()=>{},1000)'],
        { signal: childAbort.signal },
      )
      child.stderr.resume()
      try {
        expect(await line(child)).toBe('ready')
        if (mode === 'sdk-kill') assert.equal(child.kill('SIGKILL'), true)
        else if (mode === 'owner-abort') ownerAbort.abort()
        else childAbort.abort()
        await owner.close()
        expect(owner.released).toBe(true)
        expect(await readdir(join(root, 'receipts'))).toEqual([])
      } finally {
        await owner.close()
      }
    },
  )

  it('uses the original fifteen-second deadline and one cleanup window for a silent native root', async () => {
    const root = await scratch(),
      startedAt = Date.now()
    const owner = new OwnedProcessGroup({
      windows: windows(join(root, 'receipts')),
      deadlineAt: startedAt + 15_000,
    })
    const child = owner.spawn(process.execPath, [
      '-e',
      'console.log("ready");setInterval(()=>{},1000)',
    ])
    child.stderr.resume()
    const closed = once(child, 'close')
    try {
      expect(await line(child)).toBe('ready')
      await deadline(closed, 19_000)
      await owner.close()
      expect(owner.released).toBe(true)
      expect(Date.now() - startedAt).toBeLessThanOrEqual(19_000)
    } finally {
      await owner.close()
    }
  }, 25_000)

  it('preserves stdout backpressure and complete bytes before physical closure', async () => {
    const root = await scratch(),
      bytes = 256 * 1024
    const owner = new OwnedProcessGroup({ windows: windows(join(root, 'receipts')) })
    const child = owner.spawn(process.execPath, [
      '-e',
      `console.log('ready');process.stdin.once('data',()=>process.stdout.write(Buffer.alloc(${bytes},120)));process.stdin.once('end',()=>process.exit(0))`,
    ])
    child.stderr.resume()
    try {
      expect(await line(child)).toBe('ready')
      let received = 0,
        finish!: () => void
      const complete = new Promise<void>((done) => {
        finish = done
      })
      child.stdout.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (received > bytes || chunk.some((byte) => byte !== 120))
          throw Error('Fixture bytes changed')
        if (received === bytes) finish()
      })
      child.stdout.pause()
      child.stdin.write('output\n')
      await new Promise((done) => setTimeout(done, 100))
      expect(received).toBe(0)
      expect(owner.released).toBe(false)
      child.stdout.resume()
      await deadline(complete)
      await owner.close()
      expect(received).toBe(bytes)
      expect(owner.released).toBe(true)
    } finally {
      child.stdout.resume()
      await owner.close()
    }
  })

  it('keeps decision bridge and receipt verification independent from the fully reserved business pool', async () => {
    const root = await scratch()
    const held = Array.from({ length: 4 }, () =>
      new NativeWorkingMemory('business').reserve(NATIVE_OWNER_WORKING_BYTES),
    )
    const memory = new DecisionMemoryLease()
    let witness: DecisionWindowsPhysicalWitness | undefined
    const owner = new OwnedProcessGroup({
      windows: windows(join(root, 'receipts')),
      ownerId: randomUUID(),
      deadlineAt: Date.now() + 15_000,
      memory,
      physicalPrepared: (value) => {
        if (value.platform === 'win32') witness = value
      },
    })
    const child = owner.spawn(process.execPath, [
      '-e',
      'console.log("ready");process.stdin.resume();process.stdin.once("end",()=>process.exit(0))',
    ])
    child.stderr.resume()
    try {
      expect(await line(child)).toBe('ready')
      await owner.close()
      expect(owner.released).toBe(true)
      expect(witness?.phase).toBe('contained')
      expect(
        await OwnedProcessGroup.cleanupPhysicalReceipt(
          witness,
          windows(join(root, 'receipts')),
          memory,
        ),
      ).toBe('removed')
    } finally {
      await owner.close()
      memory.release()
      for (const entry of held) entry.release()
    }
  })

  it('inherits only standard target handles, and completes 100 bounded physical lifecycles without retained receipts or working reservations', async () => {
    const root = await scratch(),
      memory = new NativeWorkingMemory('business')
    for (let index = 0; index < 100; index++) {
      const owner = new OwnedProcessGroup({ windows: windows(join(root, 'receipts')), memory })
      const child = owner.spawn(observerExecutable, ['handles'])
      child.stderr.resume()
      expect(await line(child)).toBe('0')
      await owner.close()
      expect(owner.released).toBe(true)
      expect(memory.bytes).toBe(0)
      expect(await readdir(join(root, 'receipts'))).toEqual([])
    }
  }, 120_000)

  it.each(['suspended', 'resumed'] as const)(
    'recovers an exact flushed receipt after the Utility exits while %s, rejects altered births and hardlinks, and retires only after commit',
    async (phase) => {
      const root = await scratch(),
        observer = await Observer.create()
      const loader = createRequire(resolvePath('packages/persistence/package.json')).resolve(
        'tsx/esm',
      )
      const module = pathToFileURL(
        resolvePath('apps/desktop/src/utility/owned-process-group.ts'),
      ).href
      const memoryModule = pathToFileURL(
        resolvePath('apps/desktop/src/utility/conversation/native-working-memory.ts'),
      ).href
      const script = join(root, 'utility.mts'),
        receipts = join(root, 'receipts')
      await writeFile(
        script,
        `import{OwnedProcessGroup}from ${JSON.stringify(module)};import{NativeWorkingMemory}from ${JSON.stringify(memoryModule)};import{randomUUID}from'node:crypto';let resume;const gate=new Promise(done=>resume=done);process.on('message',m=>{if(m==='resume')resume();if(m==='exit')process.exit(0)});const group=new OwnedProcessGroup({windows:${JSON.stringify(windows(receipts))},ownerId:randomUUID(),deadlineAt:Date.now()+15000,memory:new NativeWorkingMemory('decision'),physicalPrepared:async witness=>{if(witness.phase==='contained'){process.send({witness});await gate}}});const child=group.spawn(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)']);child.stderr.resume();child.stdout.once('data',()=>process.send({ready:true}));`,
      )
      const utility = spawn(process.execPath, ['--import', loader, script], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        shell: false,
      })
      utility.stderr?.resume()
      const closed = new Promise<void>((done) => utility.once('close', () => done()))
      try {
        const [message] = await deadline(once(utility, 'message'), 15_000)
        if (!message || typeof message !== 'object' || !('witness' in message))
          throw Error('Missing fixture witness')
        const witness = decisionPhysicalWitnessSchema.parse(message.witness)
        if (witness.platform !== 'win32' || witness.phase !== 'contained')
          throw Error('Wrong fixture witness')
        const held = await observer.command(`hold ${witness.bridge.pid} ${witness.root.pid}`)
        expect(held.map((entry) => entry.birth)).toEqual([
          witness.bridge.creationFileTime,
          witness.root.creationFileTime,
        ])
        expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
        if (phase === 'resumed') {
          const ready = once(utility, 'message')
          utility.send('resume')
          assert.deepEqual((await deadline(ready))[0], { ready: true })
        }
        utility.send('exit')
        await deadline(closed)
        await emptyHandles(observer)
        expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(true)
        expect(
          await OwnedProcessGroup.provePhysicalRelease(
            { ...witness, generation: randomUUID() },
            windows(receipts),
          ),
        ).toBe(false)
        expect(
          await OwnedProcessGroup.provePhysicalRelease(
            {
              ...witness,
              root: {
                ...witness.root,
                creationFileTime: (BigInt(witness.root.creationFileTime) + 1n).toString(),
              },
            },
            windows(receipts),
          ),
        ).toBe(false)
        const receipt = join(receipts, `${witness.receipt.id}.receipt`),
          alias = join(root, 'hardlink.receipt')
        await link(receipt, alias)
        expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
        await unlink(alias)
        const bytes = await readFile(receipt)
        expect(bytes.length).toBe(256)
        const corrupt = Buffer.from(bytes)
        corrupt[0] = corrupt[0]! ^ 1
        await writeFile(receipt, corrupt)
        expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
        await writeFile(receipt, bytes)
        expect(await OwnedProcessGroup.cleanupPhysicalReceipt(witness, windows(receipts))).toBe(
          'removed',
        )
        expect(await readdir(receipts)).toEqual([])
      } finally {
        utility.kill()
        await deadline(closed)
        await observer.command('kill')
        await observer.close()
      }
    },
  )

  it('keeps cleanup unconfirmed when the bridge crashes before its empty receipt even after independent handles show kernel cleanup', async () => {
    const root = await scratch(),
      observer = await Observer.create(),
      receipts = join(root, 'receipts')
    const loader = createRequire(resolvePath('packages/persistence/package.json')).resolve(
      'tsx/esm',
    )
    const module = pathToFileURL(
      resolvePath('apps/desktop/src/utility/owned-process-group.ts'),
    ).href
    const memoryModule = pathToFileURL(
      resolvePath('apps/desktop/src/utility/conversation/native-working-memory.ts'),
    ).href
    const script = join(root, 'unconfirmed-utility.mts')
    // This fault intentionally quarantines its lease and handle until the host
    // exits. Keep that host outside the test process's normal zero-leak gate.
    await writeFile(
      script,
      `
import { OwnedProcessGroup } from ${JSON.stringify(module)};
import { NativeWorkingMemory, nativeWorkingMemoryCapacities } from ${JSON.stringify(memoryModule)};
import { randomUUID } from 'node:crypto';
const windows = ${JSON.stringify(windows(receipts))};
const memory = new NativeWorkingMemory('decision');
let witness;
const owner = new OwnedProcessGroup({
  windows, ownerId: randomUUID(), deadlineAt: Date.now() + 15000, memory,
  physicalPrepared: async value => {
    if (value.platform === 'win32' && value.phase === 'contained') {
      witness = value;
      process.send({ witness });
      await new Promise(() => undefined);
    }
  },
});
process.on('message', async message => {
  if (message === 'exit') process.exit(0);
  if (message !== 'check' || !witness) return;
  let closeRejected = false;
  let rejectionMatched = false;
  try { await owner.close(); }
  catch (error) {
    closeRejected = true;
    rejectionMatched = error instanceof Error && error.message === 'Windows process ownership could not be confirmed.';
  }
  const proof = await OwnedProcessGroup.provePhysicalRelease(witness, windows);
  process.send({ facts: {
    closeRejected, rejectionMatched, released: owner.released, proof,
    heldBytes: memory.bytes,
    chargedBytes: nativeWorkingMemoryCapacities().decision.chargedBytes,
  }});
});
const child = owner.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
child.stdout.resume();
child.stderr.resume();
`,
    )
    const utility = spawn(process.execPath, ['--import', loader, script], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      shell: false,
    })
    utility.stderr?.resume()
    const closed = new Promise<number | null>((done) => utility.once('close', (code) => done(code)))
    try {
      const [message] = await deadline(once(utility, 'message'), 15_000)
      if (!message || typeof message !== 'object' || !('witness' in message))
        throw Error('Missing fixture witness')
      const witness = decisionPhysicalWitnessSchema.parse(message.witness)
      if (witness.platform !== 'win32' || witness.phase !== 'contained')
        throw Error('Missing containment')
      const held = await observer.command(`hold ${witness.bridge.pid} ${witness.root.pid}`)
      expect(held.map((entry) => entry.birth)).toEqual([
        witness.bridge.creationFileTime,
        witness.root.creationFileTime,
      ])
      await observer.command('first')
      await emptyHandles(observer)
      const reported = once(utility, 'message')
      utility.send('check')
      const [result] = await deadline(reported, 10_000)
      expect(result).toEqual({
        facts: {
          closeRejected: true,
          rejectionMatched: true,
          released: false,
          proof: false,
          heldBytes: WINDOWS_OWNER_WORKSPACE_BYTES,
          chargedBytes: WINDOWS_OWNER_WORKSPACE_BYTES,
        },
      })
      expect(utility.exitCode).toBeNull()
      utility.send('exit')
      expect(await deadline(closed)).toBe(0)
      await emptyHandles(observer)
      expect(await OwnedProcessGroup.provePhysicalRelease(witness, windows(receipts))).toBe(false)
    } finally {
      if (utility.exitCode === null && utility.signalCode === null) utility.kill()
      await deadline(closed)
      await observer.command('kill')
      await observer.close()
    }
  })
})
