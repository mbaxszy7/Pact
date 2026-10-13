import { constants } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { writeWindowsNodeLauncher, writeWindowsRpcLauncher } from './windows-cli-launcher.js'
import { windowsFixtureRenameSource } from './windows-fixture-rename.js'

export type NativeTransportFault =
  | 'drop-turn-ack'
  | 'block-inspection'
  | 'pause-turn'
  | 'pause-resume'
  | 'hold-initialization'
  | 'drop-ack-and-block-inspection'

export interface NativeTransportFaultFiles {
  executablePath: string
  /** Directory: each invocation is the sole writer of <relay PID>.json. */
  factsPath: string
  /** Parent-owned JSON: { armed, action: hold|release|cancel, generation }. */
  controlPath: string
}

/**
 * Transparent fault launcher with a Windows native entry and POSIX shebang.
 * Actual executable arguments, inherited isolated environment and all genuine
 * packets remain unchanged. It never creates a success response or model text.
 *
 * pause-turn / pause-resume retain one request BEFORE native dispatch. Dropped ACKs and held
 * replies occur AFTER actual dispatch and cannot establish non-delivery.
 * hold-initialization forwards the actual candidate ACK before holding its
 * next actual initialization reply, retaining a real recoverable candidate.
 */
export async function writeNativeTransportFault(
  root: string,
  actualExecutable: string,
  fault: NativeTransportFault,
): Promise<NativeTransportFaultFiles> {
  if (!isAbsolute(root) || !isAbsolute(actualExecutable))
    throw new Error('Transport owner and actual executable must be absolute paths')
  if (
    ![
      'drop-turn-ack',
      'block-inspection',
      'pause-turn',
      'pause-resume',
      'hold-initialization',
      'drop-ack-and-block-inspection',
    ].includes(fault)
  )
    throw new Error('Unknown native transport fault')
  const owner = await lstat(root)
  if (!owner.isDirectory() || owner.isSymbolicLink())
    throw new Error('Transport owner must be an existing nonsymlink directory')
  const actual = await realpath(actualExecutable)
  await access(actual, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
  if (actual.length > 2048 || /[\r\n]/u.test(actual) || /[\r\n]/u.test(process.execPath))
    throw new Error('Actual executable path exceeds its launcher bound')
  const directory = await mkdtemp(join(root, 'codex-transport-'))
  await chmod(directory, 0o700)
  const files = {
    executablePath: join(directory, 'codex'),
    factsPath: join(directory, 'facts'),
    controlPath: join(directory, 'control.json'),
  }
  await mkdir(files.factsPath, { mode: 0o700 })
  await writeFile(
    files.controlPath,
    JSON.stringify({ armed: true, action: 'hold', generation: 0 }),
    { flag: 'wx', mode: 0o600 },
  )
  // The relay must outlive its complete actual CLI subtree to record child.close.
  // The fixture owns this inner Job entry and removes it with the transport directory.
  const launchExecutable =
    process.platform === 'win32' ? writeWindowsRpcLauncher(actual, directory).executable : undefined
  const configuration = JSON.stringify({
    actualExecutable: actual,
    ...(launchExecutable ? { launchExecutable } : {}),
    fault,
    factsPath: files.factsPath,
    controlPath: files.controlPath,
  })
  if (process.platform === 'win32') {
    const entry = files.executablePath + '.mjs'
    const windowsRelaySource = relaySource.replaceAll(
      'renameSync(factsTemporary, factsFile)',
      'windowsFixtureRename(factsTemporary, factsFile, 50)',
    )
    await writeFile(
      entry,
      `const configuration = ${configuration}\n${windowsFixtureRenameSource}\n${windowsRelaySource}`,
      {
        flag: 'wx',
        mode: 0o600,
      },
    )
    files.executablePath = await writeWindowsNodeLauncher(directory, 'codex-transport', [entry])
  } else {
    await writeFile(
      files.executablePath,
      `#!${process.execPath}\nconst configuration = ${configuration}\n${relaySource}`,
      { flag: 'wx', mode: 0o700 },
    )
  }
  return files
}

// Standalone JS is deliberate: the installed CLI receives an executable path,
// and the relay must not depend on a bundled test runtime or repository loader.
const relaySource = String.raw`
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const frameLimit = 1024 * 1024
const streamLimit = 16 * 1024 * 1024
const requestLimit = 128
const entryLimit = 512
const factsLimit = 64 * 1024
const invocationLimit = 64
const ownerDeadline = 10 * 60_000
const replyHoldDeadline = 15_000
const args = process.argv.slice(2)
const nativeInterruptionEnabled = args[0] === '--enable' && args[1] === 'code_mode_interrupt'
const appServer = args[nativeInterruptionEnabled ? 2 : 0] === 'app-server'
const versionCommand = args[0] === '--version' || args[0] === '-V'
const factsFile = join(configuration.factsPath, process.pid + '.json')
const factsTemporary = factsFile + '.tmp'
const requests = new Map()
const transferAbort = new AbortController()
const facts = {
  relayPid: process.pid,
  actualExecutable: configuration.actualExecutable,
  fault: configuration.fault,
  appServer,
  nativeInterruptionEnabled,
  startedAt: new Date().toISOString(),
  actualChildPid: null,
  closed: false,
  exitCode: null,
  exitSignal: null,
  streamBytes: 0,
  pendingRequests: 0,
  faultPhase: 'none',
  forwardedTurns: 0,
  droppedAcks: 0,
  evictedEntries: 0,
  entryBytes: 0,
  entries: [],
}
let stopping = false
let closed = false
let triggered = false
let candidateAcknowledged = false
let inspectionHeld = false
let held
let heldTimer
let controlTimer
let flushTimer
let killTimer
let closeTimer
let failure
let child

function flushFacts() {
  clearTimeout(flushTimer)
  flushTimer = undefined
  facts.pendingRequests = requests.size
  let encoded = JSON.stringify(facts)
  while (Buffer.byteLength(encoded) > factsLimit && facts.entries.length) {
    const oldest = facts.entries.shift()
    facts.entryBytes -= Buffer.byteLength(JSON.stringify(oldest))
    facts.evictedEntries++
    encoded = JSON.stringify(facts)
  }
  if (Buffer.byteLength(encoded) > factsLimit) throw new Error('facts-budget')
  writeFileSync(factsTemporary, encoded, { mode: 0o600 })
  renameSync(factsTemporary, factsFile)
}
function record(kind, metadata = {}) {
  const entry = { at: Date.now(), kind, ...metadata }
  const bytes = Buffer.byteLength(JSON.stringify(entry))
  while (facts.entries.length >= entryLimit || facts.entryBytes + bytes > factsLimit - 8192) {
    const oldest = facts.entries.shift()
    if (!oldest) throw new Error('entry-budget')
    facts.entryBytes -= Buffer.byteLength(JSON.stringify(oldest))
    facts.evictedEntries++
  }
  facts.entries.push(entry)
  facts.entryBytes += bytes
  if (!flushTimer) flushTimer = setTimeout(() => {
    try { flushFacts() } catch { stop('facts-write-failed') }
  }, 20)
}
function safeId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  if (typeof value === 'string' && /^[a-zA-Z0-9_:./-]{1,128}$/u.test(value)) return value
}
function safeMethod(value) {
  return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_/.-]{0,119}$/u.test(value) ? value : undefined
}
function packet(frame) {
  try {
    const parsed = JSON.parse(frame.toString('utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined
  } catch { return undefined }
}
function key(id) { return typeof id + ':' + id }
function control() {
  const fd = openSync(configuration.controlPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > 4096) throw new Error('control-budget')
    const bytes = Buffer.alloc(4097)
    const length = readSync(fd, bytes, 0, bytes.length, 0)
    if (length > 4096) throw new Error('control-budget')
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!value || typeof value !== 'object' || typeof value.armed !== 'boolean' ||
        !['hold', 'release', 'cancel'].includes(value.action) ||
        !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error('invalid-control')
    return value
  } finally { closeSync(fd) }
}
function armed(afterDrop = false) {
  if (!appServer || (triggered && !afterDrop) || stopping) return false
  const value = control()
  if (value.action === 'cancel') { stop('control-cancelled'); return false }
  return value.armed && value.action === 'hold'
}
async function writeFrame(destination, frame) {
  if (stopping || (closed && destination === child.stdin)) return false
  if (destination.destroyed || destination.writableEnded) throw new Error('destination-closed')
  const accepted = destination.write(frame)
  if (!accepted) await once(destination, 'drain', { signal: transferAbort.signal })
  return true
}
async function forwardInput(frame, metadata) {
  if (stopping || closed) return false
  if (metadata?.method === 'turn/start') facts.forwardedTurns++
  if (metadata) record('stdin-forwarded', metadata)
  return writeFrame(child.stdin, frame)
}
async function forwardOutput(frame, metadata) {
  const sent = await writeFrame(process.stdout, frame)
  if (metadata?.id !== undefined) requests.delete(key(metadata.id))
  return sent
}
function cancelHeld() {
  clearInterval(controlTimer)
  clearTimeout(heldTimer)
  controlTimer = undefined
  heldTimer = undefined
  if (!held) return
  facts.faultPhase = held.direction === 'stdin' ? 'cancelled-before-native' : 'cancelled-after-native'
  record('held-cancelled', held.metadata)
  held = undefined
}
function releaseHeld(reason) {
  if (!held || stopping || closed) return
  const item = held
  held = undefined
  clearInterval(controlTimer)
  clearTimeout(heldTimer)
  controlTimer = undefined
  heldTimer = undefined
  facts.faultPhase = item.direction === 'stdin' ? 'released-before-native' : 'released-after-native'
  record(reason, item.metadata)
  const forwarded = item.direction === 'stdin' ? forwardInput(item.frame, item.metadata) : forwardOutput(item.frame, item.metadata)
  void forwarded.catch(() => stop('held-forward-failed'))
}
function holdFrame(direction, frame, metadata) {
  if (held) throw new Error('held-frame-capacity')
  triggered = true
  held = { direction, frame, metadata }
  facts.faultPhase = direction === 'stdin' ? 'held-before-native' : 'held-after-native'
  record(direction === 'stdin' ? 'stdin-held' : 'stdout-held', metadata)
  flushFacts()
  controlTimer = setInterval(() => {
    try {
      const value = control()
      if (value.action === 'cancel') stop('control-cancelled')
      else if (!value.armed || value.action === 'release') releaseHeld('control-released')
    } catch { stop('control-read-failed') }
  }, 50)
  if (direction === 'stdout') heldTimer = setTimeout(() => releaseHeld('reply-deadline-released'), replyHoldDeadline)
}
async function inputLine(frame) {
  const value = appServer ? packet(frame) : undefined
  const method = safeMethod(value?.method)
  const id = safeId(value?.id)
  let metadata
  if (method && id !== undefined) {
    if (requests.size >= requestLimit || requests.has(key(id))) throw new Error('request-capacity')
    metadata = { method, id }
    const nativeSessionId = safeId(value.params?.threadId)
    if (nativeSessionId !== undefined) metadata.nativeSessionId = nativeSessionId
    requests.set(key(id), metadata)
    record('stdin-request', metadata)
    if (((configuration.fault === 'pause-turn' && method === 'turn/start') ||
      (configuration.fault === 'pause-resume' && method === 'thread/resume')) && armed()) {
      holdFrame('stdin', frame, metadata)
      return
    }
  }
  await forwardInput(frame, metadata)
}
async function outputLine(frame) {
  if (versionCommand) {
    const match = frame.toString('utf8').match(/^codex(?:-cli)? ([0-9]+\.[0-9]+\.[0-9]+[a-zA-Z0-9.+-]{0,64})\s*$/u)
    if (match) facts.actualVersion = match[1]
  }
  const value = appServer ? packet(frame) : undefined
  const event = safeMethod(value?.method)
  if (event) {
    const id = safeId(value.id)
    record('stdout-event', { event, ...(id !== undefined ? { id } : {}) })
    await writeFrame(process.stdout, frame)
    return
  }
  const id = safeId(value?.id)
  const metadata = id === undefined ? undefined : requests.get(key(id))
  if (metadata) {
    const successful = Object.hasOwn(value, 'result') && !Object.hasOwn(value, 'error')
    record('stdout-reply', { ...metadata, successful })
    if (successful && ['drop-turn-ack', 'drop-ack-and-block-inspection'].includes(configuration.fault) && metadata.method === 'turn/start' && armed()) {
      triggered = true
      facts.droppedAcks++
      facts.faultPhase = 'dropped-after-native'
      record('stdout-dropped', metadata)
      requests.delete(key(id))
      flushFacts()
      return
    }
    if (successful && configuration.fault === 'hold-initialization' && ['thread/start', 'thread/fork'].includes(metadata.method)) {
      const nativeSessionId = safeId(value.result?.thread?.id)
      if (nativeSessionId !== undefined) {
        facts.candidateNativeSessionId = nativeSessionId
        const sent = await forwardOutput(frame, metadata)
        if (sent) {
          candidateAcknowledged = true
          record('candidate-ack-forwarded', { ...metadata, nativeSessionId })
          flushFacts()
        }
        return
      }
    } else if (successful && (
      (configuration.fault === 'block-inspection' && metadata.method === 'thread/read' && armed()) ||
      (configuration.fault === 'drop-ack-and-block-inspection' && facts.droppedAcks === 1 && !inspectionHeld && metadata.method === 'thread/read' && armed(true)) ||
      (configuration.fault === 'hold-initialization' && candidateAcknowledged && ['thread/inject_items', 'thread/read', 'thread/settings/update', 'thread/resume'].includes(metadata.method) && armed())
    )) {
      if (configuration.fault === 'drop-ack-and-block-inspection') inspectionHeld = true
      holdFrame('stdout', frame, metadata)
      return
    }
  }
  await forwardOutput(frame, metadata)
}
function account(length) {
  facts.streamBytes += length
  if (facts.streamBytes > streamLimit) throw new Error('stream-budget')
}
async function lines(source, consume) {
  let partial = Buffer.alloc(0)
  for await (const chunk of source) {
    if (stopping || (closed && source === process.stdin)) return
    account(chunk.length)
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline + 1
      const piece = chunk.subarray(offset, end)
      if (partial.length + piece.length > frameLimit) throw new Error('frame-budget')
      partial = partial.length ? Buffer.concat([partial, piece]) : piece
      offset = end
      if (newline !== -1) {
        await consume(partial)
        partial = Buffer.alloc(0)
      }
    }
  }
  if (partial.length && !stopping && (!closed || source !== process.stdin)) await consume(partial)
}
async function stderr() {
  for await (const chunk of child.stderr) {
    if (stopping) return
    account(chunk.length)
    if (chunk.length > frameLimit) throw new Error('frame-budget')
    await writeFrame(process.stderr, chunk)
  }
}
function stop(reason) {
  if (stopping || closed) return
  stopping = true
  failure = reason
  transferAbort.abort()
  facts.stopReason = reason
  cancelHeld()
  record('stop')
  process.stdin.destroy()
  child.stdin.end()
  child.kill('SIGTERM')
  killTimer = setTimeout(() => {
    if (!closed) { record('owned-child-force-kill'); child.kill('SIGKILL') }
  }, 2000)
  closeTimer = setTimeout(() => {
    if (!closed) {
      facts.stopReason = 'owned-child-close-unconfirmed'
      try { flushFacts() } catch {}
      process.exit(1)
    }
  }, 4000)
}
function boundedReason(error, fallback) {
  const allowed = ['frame-budget', 'stream-budget', 'request-capacity', 'held-frame-capacity', 'control-budget', 'invalid-control', 'destination-closed']
  return error instanceof Error && allowed.includes(error.message) ? error.message : fallback
}

try {
  let claimed = false
  for (let slot = 0; slot < invocationLimit; slot++) {
    try {
      mkdirSync(join(configuration.factsPath, '.slot-' + slot), { mode: 0o700 })
      claimed = true
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('invocation-admission-failed')
    }
  }
  if (!claimed) {
    process.stderr.write('Native transport relay invocation capacity exceeded.\n')
    process.exit(1)
  }
  // Readers may discover this invocation immediately. Publish the first complete
  // record atomically, just like later updates; never expose a placeholder.
  writeFileSync(factsTemporary, JSON.stringify(facts), { flag: 'wx', mode: 0o600 })
  renameSync(factsTemporary, factsFile)
  child = spawn(configuration.launchExecutable ?? configuration.actualExecutable, args, { env: process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  facts.actualChildPid = child.pid ?? null
  record('actual-child-started')
  flushFacts()
} catch {
  facts.stopReason = 'actual-child-start-failed'
  try { flushFacts() } catch {}
  process.exit(1)
}
const deadline = setTimeout(() => stop('owner-deadline'), ownerDeadline)
const ended = new Promise((resolve) => child.once('close', (code, signal) => {
  closed = true
  transferAbort.abort()
  cancelHeld()
  clearTimeout(deadline)
  clearTimeout(killTimer)
  clearTimeout(closeTimer)
  facts.closed = true
  facts.exitCode = code
  facts.exitSignal = signal
  requests.clear()
  record('actual-child-closed')
  process.stdin.destroy()
  resolve(code)
}))
child.once('error', () => stop('actual-child-error'))
child.stdin.on('error', () => { if (!closed && !stopping) stop('actual-stdin-error') })
process.stdout.on('error', () => { if (!closed && !stopping) stop('relay-stdout-error') })
process.stderr.on('error', () => { if (!closed && !stopping) stop('relay-stderr-error') })
process.once('SIGTERM', () => stop('relay-sigterm'))
process.once('SIGINT', () => stop('relay-sigint'))
const output = lines(child.stdout, outputLine).catch((error) => { if (!closed && !stopping) stop(boundedReason(error, 'stdout-transfer-failed')) })
const errors = stderr().catch((error) => { if (!closed && !stopping) stop(boundedReason(error, 'stderr-transfer-failed')) })
const input = lines(process.stdin, inputLine).then(() => {
  if (!closed && !stopping) {
    if (appServer) stop('stdin-eof')
    else child.stdin.end()
  }
}).catch((error) => { if (!closed && !stopping) stop(boundedReason(error, 'stdin-transfer-failed')) })
const code = await ended
await Promise.allSettled([output, errors, input])
try { flushFacts() } catch { process.exitCode = 1 }
if (failure) process.exitCode = 1
else if (typeof code === 'number') process.exitCode = code
else process.exitCode = 1
`
