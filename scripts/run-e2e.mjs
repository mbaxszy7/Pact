import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadProviderConfiguration } from '../tests/e2e/provider-environment.ts'

const outputLimit = 256 * 1024
const terminationGrace = 5000
const confirmationDeadline = 5000
const groupCheckInterval = 25
const ownershipSampleInterval = 1000
const maxOwnedProcesses = 256
const maxOwnedGroups = 16
const totalDeadline = 2 * 60 * 60_000
const buildDeadline = 5 * 60_000
const repositoryRoot = resolve(import.meta.dirname, '..')
const safeErrors = new WeakSet()

function failure(message) {
  const error = new Error(message)
  safeErrors.add(error)
  return error
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/u.test(error.code)
    ? error.code
    : 'unknown'
}

function scrubHeaders(text) {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, '$1 [REDACTED]')
    .replace(
      /(\b(?:authorization|proxy-authorization|x-api-key|api-key|[a-z_]*api_key|[a-z_]*auth_token|password|secret|cookie|set-cookie)["']?\s*[:=]\s*["']?)[^\r\n]+/giu,
      '$1[REDACTED]',
    )
}

function readProcessTable(timeout = 1000) {
  return new Promise((resolveTable, reject) => {
    execFile(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,lstart='],
      {
        env: { PATH: process.env.PATH, LC_ALL: 'C' },
        encoding: 'utf8',
        timeout,
        maxBuffer: 256 * 1024,
        shell: false,
      },
      (error, output) => {
        if (error) {
          const signal = ['SIGTERM', 'SIGKILL'].includes(error.signal) ? error.signal : 'none'
          reject(
            failure(
              `E2E process ownership query failed (${safeCode(error)}; timeout=${timeout}ms; killed=${Boolean(error.killed)}; signal=${signal}; stdoutBytes=${Buffer.byteLength(output ?? '')}).`,
            ),
          )
          return
        }
        const lines = output.trim().split('\n')
        if (lines.length > 4096) {
          reject(failure('E2E process ownership query exceeded 4096 rows.'))
          return
        }
        const rows = new Map()
        for (const line of lines) {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line)
          if (!match) {
            reject(failure('E2E process ownership query returned an invalid row.'))
            return
          }
          const [, pidText, parentText, groupText, started] = match
          const pid = Number(pidText)
          const ppid = Number(parentText)
          const pgid = Number(groupText)
          if (![pid, ppid, pgid].every(Number.isSafeInteger) || started.length > 64) {
            reject(failure('E2E process ownership query returned an invalid identity.'))
            return
          }
          rows.set(pid, { pid, ppid, pgid, started })
        }
        resolveTable(rows)
      },
    )
  })
}

function sameProcess(known, row) {
  return row && known.pid === row.pid && known.pgid === row.pgid && known.started === row.started
}

/** One job owns its verified descendant groups, bounded buffers and termination timers. */
export function run(
  args,
  timeout,
  {
    executable = 'pnpm',
    cwd = repositoryRoot,
    redact = (text) => text,
    write,
    onState = () => {},
    inspectProcesses = readProcessTable,
  } = {},
) {
  if (process.platform === 'win32') {
    return import('./run-e2e-windows.mjs').then(({ runWindows }) =>
      runWindows(
        args,
        timeout,
        { executable, cwd, redact, write, onState },
        { failure, scrubHeaders },
      ),
    )
  }
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return Promise.reject(failure('E2E job deadline must be positive and finite.'))
  }
  return new Promise((done, reject) => {
    let child
    try {
      child = spawn(executable, args, {
        cwd,
        detached: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(failure(`E2E job could not start (${safeCode(error)}).`))
      return
    }
    const buffers = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
    const abort = new AbortController()
    let bufferedBytes = 0
    let maxBufferedBytes = 0
    let stopping = false
    let settled = false
    let directClosed = false
    let pumpsClosed = false
    let groupGone = !child.pid
    let exitCode = 1
    let startupError
    let killTimer
    let confirmTimer
    let groupTimer
    let observerFailed = false
    const ownedProcesses = new Map()
    const ownedGroups = new Set(child.pid ? [child.pid] : [])
    const groupLeaderStarts = new Map()
    let ownershipSample
    let ownershipTimer
    let cleanupRefreshing = false
    const uncertainGroups = new Map()
    const invalidGroups = new Set()
    const sentSignals = new Map()
    let requestedSignal
    let drainTimer

    const state = (kind, reason) => {
      if (observerFailed) return
      try {
        onState({
          kind,
          reason,
          pid: child.pid ?? null,
          bufferedBytes,
          maxBufferedBytes,
          groupGone,
          ownedProcessCount: identityCount(),
          ownedGroupCount: ownedGroups.size,
          ...(startupError && safeErrors.has(startupError)
            ? { failure: startupError.message }
            : {}),
        })
      } catch {
        observerFailed = true
        stop('observer-failed')
      }
    }
    const groupExists = (pgid) => {
      try {
        process.kill(-pgid, 0)
        return true
      } catch (error) {
        if (error.code === 'ESRCH') return false
        if (error.code === 'EPERM') return true
        throw failure(`E2E process-group check failed (${safeCode(error)}).`)
      }
    }
    const groupAlive = () => [...ownedGroups].some(groupExists)
    const identityCount = () =>
      ownedProcesses.size +
      [...uncertainGroups.values()].reduce((count, pending) => count + pending.identities.length, 0)
    const retireGroup = (pgid) => {
      ownedGroups.delete(pgid)
      groupLeaderStarts.delete(pgid)
      uncertainGroups.delete(pgid)
      invalidGroups.delete(pgid)
      sentSignals.delete(pgid)
      for (const [pid, known] of ownedProcesses) {
        if (known.pgid === pgid) ownedProcesses.delete(pid)
      }
    }
    const refreshOwnership = () => {
      if (ownershipSample) return ownershipSample
      ownershipSample = (async () => {
        let rows
        const retired = new Set()
        let problem
        do {
          for (const [pgid, pending] of uncertainGroups) {
            if (pending.deadline > performance.now()) continue
            uncertainGroups.delete(pgid)
            if (groupExists(pgid)) {
              invalidGroups.add(pgid)
              problem ??= failure(
                'E2E owned group has no previously verified live process anchor after confirmation deadline.',
              )
            } else {
              retireGroup(pgid)
              retired.add(pgid)
            }
          }
          const available = Math.min(
            1000,
            ...[...uncertainGroups.values()].map((pending) => pending.deadline - performance.now()),
          )
          // oxlint-disable-next-line no-await-in-loop -- One OS query owns the single-flight; unknown groups retain a fixed five-second deadline.
          rows = await inspectProcesses(Math.max(1, Math.floor(available)))
          const previous = [...ownedProcesses.values()]
          const root = rows.get(child.pid)
          if (!ownedProcesses.size && root?.ppid === process.pid && root.pgid === child.pid) {
            ownedProcesses.set(root.pid, root)
            groupLeaderStarts.set(root.pgid, root.started)
          }
          for (const [pid, known] of ownedProcesses) {
            if (!sameProcess(known, rows.get(pid))) ownedProcesses.delete(pid)
          }
          const verifiedGroups = new Set()
          for (const pgid of ownedGroups) {
            if (!groupExists(pgid)) {
              retireGroup(pgid)
              retired.add(pgid)
              continue
            }
            if (invalidGroups.has(pgid)) {
              problem ??= failure('E2E owned group identity remains unconfirmed.')
              continue
            }
            const leader = rows.get(pgid)
            const started = groupLeaderStarts.get(pgid)
            if (!started || (leader && leader.started !== started)) {
              invalidGroups.add(pgid)
              problem ??= failure('E2E owned group lost its verifiable process identity.')
              continue
            }
            const pending = uncertainGroups.get(pgid)
            if (pending) {
              for (const known of pending.identities) {
                const row = rows.get(known.pid)
                if (sameProcess(known, row)) ownedProcesses.set(row.pid, row)
              }
            }
            if ([...ownedProcesses.values()].some((known) => known.pgid === pgid)) {
              verifiedGroups.add(pgid)
              uncertainGroups.delete(pgid)
              continue
            }
            if (!pending) {
              uncertainGroups.set(pgid, {
                identities: previous.filter((known) => known.pgid === pgid),
                deadline: performance.now() + confirmationDeadline,
              })
            }
            if (performance.now() >= uncertainGroups.get(pgid).deadline) {
              uncertainGroups.delete(pgid)
              invalidGroups.add(pgid)
              problem ??= failure(
                'E2E owned group has no previously verified live process anchor after confirmation deadline.',
              )
            }
          }
          let changed = true
          while (changed) {
            changed = false
            for (const row of rows.values()) {
              if (
                ownedProcesses.has(row.pid) ||
                retired.has(row.pgid) ||
                uncertainGroups.has(row.pgid) ||
                invalidGroups.has(row.pgid)
              )
                continue
              if (!verifiedGroups.has(row.pgid) && !ownedProcesses.has(row.ppid)) continue
              if (identityCount() >= maxOwnedProcesses)
                throw failure('E2E job exceeded 256 owned process identities.')
              ownedProcesses.set(row.pid, row)
              changed = true
            }
          }
          for (const known of ownedProcesses.values()) {
            if (ownedGroups.has(known.pgid)) continue
            const leader = rows.get(known.pgid)
            if (!leader || !sameProcess(ownedProcesses.get(leader.pid) ?? {}, leader))
              throw failure('E2E descendant group has no verified owned leader.')
            if (ownedGroups.size >= maxOwnedGroups)
              throw failure('E2E job exceeded 16 active owned process groups.')
            ownedGroups.add(known.pgid)
            groupLeaderStarts.set(known.pgid, leader.started)
          }
          // Pending confirmation never blocks cancellation of independently
          // verified groups. An unknown group is neither adopted nor signalled.
          if (requestedSignal) signalGroups(requestedSignal, rows)
          if (problem) throw problem
          if (uncertainGroups.size) {
            // oxlint-disable-next-line no-await-in-loop -- Only this single-flight owns the bounded confirmation cadence.
            await new Promise((resume) =>
              setTimeout(
                resume,
                Math.max(
                  0,
                  Math.min(
                    groupCheckInterval,
                    ...[...uncertainGroups.values()].map(
                      (pending) => pending.deadline - performance.now(),
                    ),
                  ),
                ),
              ),
            )
          }
        } while (uncertainGroups.size)
        return rows
      })().finally(() => {
        ownershipSample = undefined
      })
      return ownershipSample
    }
    const signalGroups = (signal, rows) => {
      for (const pgid of ownedGroups) {
        if (!groupExists(pgid)) continue
        const anchor = [...ownedProcesses.values()].find(
          (known) => known.pgid === pgid && sameProcess(known, rows.get(known.pid)),
        )
        if (
          !anchor ||
          uncertainGroups.has(pgid) ||
          invalidGroups.has(pgid) ||
          sentSignals.get(pgid) === signal ||
          sentSignals.get(pgid) === 'SIGKILL' ||
          (requestedSignal === 'SIGKILL' && signal !== 'SIGKILL')
        )
          continue
        try {
          process.kill(-pgid, signal)
          sentSignals.set(pgid, signal)
        } catch (error) {
          if (error.code !== 'ESRCH') {
            startupError = failure(`E2E owned group could not be signalled (${safeCode(error)}).`)
          }
        }
      }
    }
    const finish = () => {
      if (
        settled ||
        !directClosed ||
        !pumpsClosed ||
        !groupGone ||
        cleanupRefreshing ||
        ownershipSample
      )
        return
      settled = true
      clearTimeout(deadline)
      clearTimeout(killTimer)
      clearTimeout(confirmTimer)
      clearTimeout(drainTimer)
      clearInterval(groupTimer)
      clearInterval(ownershipTimer)
      process.removeListener('SIGINT', onInterrupt)
      process.removeListener('SIGTERM', onTerminate)
      ownedProcesses.clear()
      ownedGroups.clear()
      groupLeaderStarts.clear()
      uncertainGroups.clear()
      invalidGroups.clear()
      sentSignals.clear()
      state('settled')
      if (startupError) reject(startupError)
      else done(stopping ? 1 : exitCode)
    }
    const checkGroup = () => {
      try {
        groupGone = !groupAlive()
        if (groupGone && !cleanupRefreshing && !ownershipSample) {
          clearTimeout(killTimer)
          clearTimeout(confirmTimer)
          clearInterval(groupTimer)
          finish()
        }
      } catch (error) {
        startupError = error
        stop('group-check-failed')
      }
    }
    const monitorGroup = () => {
      if (settled) return
      if (!groupTimer) groupTimer = setInterval(checkGroup, groupCheckInterval)
      checkGroup()
    }
    const discard = () => {
      buffers.stdout = Buffer.alloc(0)
      buffers.stderr = Buffer.alloc(0)
      bufferedBytes = 0
    }
    const stop = (reason) => {
      if (stopping || settled) return
      stopping = true
      discard()
      abort.abort()
      state('stopping', reason)
      clearTimeout(drainTimer)
      cleanupRefreshing = true
      const refreshAndSignal = async (signal) => {
        requestedSignal = signal
        try {
          const rows = await refreshOwnership()
          signalGroups(requestedSignal, rows)
        } catch (error) {
          startupError = error
        } finally {
          cleanupRefreshing = false
          monitorGroup()
          finish()
        }
      }
      void refreshAndSignal('SIGTERM')
      // The worker's JS exit hooks may not run after KILL. This independent
      // owner signals every previously verified Electron/descendant group too.
      killTimer = setTimeout(() => {
        if (settled) return
        cleanupRefreshing = true
        void refreshAndSignal('SIGKILL')
        confirmTimer = setTimeout(() => {
          checkGroup()
          if (groupGone || settled) return
          settled = true
          clearTimeout(deadline)
          clearInterval(groupTimer)
          clearInterval(ownershipTimer)
          process.removeListener('SIGINT', onInterrupt)
          process.removeListener('SIGTERM', onTerminate)
          child.stdout?.destroy()
          child.stderr?.destroy()
          reject(
            failure(
              'E2E owned process groups could not be confirmed closed after SIGKILL.' +
                (startupError && safeErrors.has(startupError) ? ` ${startupError.message}` : ''),
            ),
          )
        }, confirmationDeadline)
      }, terminationGrace)
      monitorGroup()
    }
    const onInterrupt = () => stop('interrupted-SIGINT')
    const onTerminate = () => stop('interrupted-SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    const deadline = setTimeout(() => stop('deadline'), timeout)
    const sample = () => {
      if (settled || stopping) return
      void refreshOwnership().then(
        () => {
          checkGroup()
          finish()
          return undefined
        },
        (error) => {
          startupError = error
          stop('ownership-query-failed')
          return undefined
        },
      )
    }
    sample()
    ownershipTimer = setInterval(sample, ownershipSampleInterval)

    const emitLine = async (channel, bytes) => {
      const line = scrubHeaders(redact(bytes.toString('utf8'))) + '\n'
      if (Buffer.byteLength(line) > outputLimit) {
        stop('redacted-output-budget')
        return
      }
      if (write) await write(channel, line)
      else if (!process[channel].write(line)) {
        await once(process[channel], 'drain', { signal: abort.signal })
      }
    }
    const emit = async (channel, chunk) => {
      if (stopping) return
      let offset = 0
      while (offset < chunk.length) {
        if (stopping) return
        const newline = chunk.indexOf(10, offset)
        const end = newline === -1 ? chunk.length : newline
        const piece = chunk.subarray(offset, end)
        if (bufferedBytes + piece.length > outputLimit) {
          stop('output-budget')
          return
        }
        buffers[channel] = Buffer.concat([buffers[channel], piece])
        bufferedBytes += piece.length
        maxBufferedBytes = Math.max(maxBufferedBytes, bufferedBytes)
        state('buffered')
        if (newline === -1) return
        const line = buffers[channel]
        bufferedBytes -= line.length
        buffers[channel] = Buffer.alloc(0)
        // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve complete-line order and output backpressure within one bounded chunk.
        await emitLine(channel, line)
        offset = newline + 1
      }
    }
    const pump = async (channel, stream) => {
      if (!stream) return
      try {
        for await (const chunk of stream) {
          // Continue draining stopped producers while retaining no more bytes.
          if (!stopping) await emit(channel, chunk)
        }
        if (!stopping && buffers[channel].length) {
          const tail = buffers[channel]
          bufferedBytes -= tail.length
          buffers[channel] = Buffer.alloc(0)
          await emitLine(channel, tail)
        }
      } catch {
        if (!stopping) stop('output-transfer-failed')
      }
    }
    child.once('error', (error) => {
      startupError = failure(`E2E job could not start (${safeCode(error)}).`)
      stop('spawn-failed')
    })
    child.once('exit', (code) => {
      exitCode = code ?? 1
      // Workers and Electron helpers may close just after their parent. Preserve
      // the parent's result during this bounded natural drain; cleanup remains
      // mandatory if any group or pipe persists beyond the grace period.
      drainTimer = setTimeout(() => {
        if (settled || stopping) return
        if (groupAlive()) stop('descendants-still-running')
        else if (!pumpsClosed || !directClosed) stop('pipes-still-open')
        else {
          groupGone = true
          finish()
        }
      }, terminationGrace)
      monitorGroup()
    })
    child.once('close', (code) => {
      directClosed = true
      exitCode = code ?? 1
      monitorGroup()
      finish()
    })
    state('started')
    void Promise.allSettled([pump('stdout', child.stdout), pump('stderr', child.stderr)]).then(
      () => {
        pumpsClosed = true
        finish()
        return undefined
      },
    )
  })
}

/** Configuration admission precedes the sole build; all jobs share one two-hour deadline. */
export async function main({
  lane = 'all',
  forwarded = [],
  loadConfiguration = loadProviderConfiguration,
  runJob = run,
} = {}) {
  if (!['all', 'ui', 'real', 'deterministic'].includes(lane)) {
    throw failure('Choose E2E lane: all, ui, real or deterministic')
  }
  const argumentsForTests = forwarded.filter((value) => value !== '--')
  if (argumentsForTests.some((value) => value.startsWith('--project'))) {
    throw failure('Select the E2E lane through this command, not a second --project override')
  }
  let configuration
  let result
  let problem
  const deadline = Date.now() + totalDeadline
  try {
    configuration = ['all', 'real'].includes(lane) ? await loadConfiguration() : null
    const redact = (text) => configuration?.redact(text) ?? text
    const built = await runJob(
      ['build'],
      Math.min(buildDeadline, Math.max(1, deadline - Date.now())),
      { redact },
    )
    result = built
    if (built === 0) {
      const projects = lane === 'all' ? ['ui', 'real', 'deterministic'] : [lane]
      result = await runJob(
        [
          'exec',
          'playwright',
          'test',
          ...projects.map((project) => `--project=${project}`),
          ...argumentsForTests,
        ],
        Math.max(1, deadline - Date.now()),
        { redact },
      )
    }
  } catch (error) {
    problem = safeErrors.has(error)
      ? error
      : failure('E2E preparation or execution failed; unsafe exception details were withheld.')
  }
  try {
    await configuration?.assertSourceIntegrity()
  } catch {
    problem = failure(
      problem
        ? `${problem.message}; E2E provider source-integrity verification failed.`
        : 'E2E provider source-integrity verification failed.',
    )
  }
  if (problem) throw problem
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main({ lane: process.argv[2] ?? 'all', forwarded: process.argv.slice(3) }).then(
    (code) => {
      process.exitCode = code
      return undefined
    },
    (error) => {
      console.error(error.message)
      process.exitCode = 1
      return undefined
    },
  )
}
