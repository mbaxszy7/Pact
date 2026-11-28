import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, constants, fstatSync, openSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const busy = () =>
  new Error('This checkout already has a development launch. Close it before starting again.')

export async function acquireMacDevelopmentLaunchLock(runtimeDirectory, bundleDirectory, signal) {
  signal?.throwIfAborted()
  await mkdir(runtimeDirectory, { recursive: true })
  const directory = await lstat(runtimeDirectory)
  if (!directory.isDirectory() || directory.uid !== process.getuid())
    throw new Error('The development runtime must be an owned directory.')
  const lockPath = join(runtimeDirectory, 'launch.lock')
  let previous
  try {
    previous = await lstat(lockPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (previous) {
    if (!previous.isFile() || previous.nlink !== 1 || previous.uid !== process.getuid())
      throw new Error('The development launch lock must be an owned regular file.')
    let holders
    try {
      holders = (
        await execute('/usr/sbin/lsof', ['-t', '--', lockPath], {
          signal,
          timeout: 2000,
          maxBuffer: 16 * 1024,
        })
      ).stdout
    } catch (error) {
      if (error.code !== 1 || error.stdout || error.stderr)
        throw new Error('Could not verify the previous development launch. No lock was removed.', {
          cause: error,
        })
    }
    if (holders?.trim()) throw busy()
  }
  let descriptor
  const release = () => {
    if (descriptor === undefined) return
    closeSync(descriptor)
    descriptor = undefined
    process.removeListener('exit', release)
  }
  try {
    descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    )
    const file = fstatSync(descriptor)
    if (
      !file.isFile() ||
      file.nlink !== 1 ||
      file.uid !== process.getuid() ||
      (file.mode & 0o077) !== 0
    )
      throw new Error('The development launch lock must be a private owned regular file.')
    const locker = spawn('/usr/bin/lockf', ['-s', '-t', '0', '3'], {
      signal,
      timeout: 2000,
      killSignal: 'SIGKILL',
      shell: false,
      stdio: ['ignore', 'ignore', 'ignore', descriptor],
    })
    const [code] = await once(locker, 'exit')
    if (code === 75) throw busy()
    if (code !== 0) throw new Error('Could not acquire the development launch lock.')
    signal?.throwIfAborted()
    let commands
    try {
      commands = (
        await execute('/bin/ps', ['-axo', 'comm='], {
          signal,
          timeout: 2000,
          maxBuffer: 128 * 1024,
        })
      ).stdout
    } catch (error) {
      throw new Error('Could not verify development application exit. No runtime was replaced.', {
        cause: error,
      })
    }
    if (
      commands
        .split('\n')
        .some((command) => command.trimStart().startsWith(`${bundleDirectory}${sep}`))
    )
      throw new Error(
        'A development application from this checkout is still running. Quit it before starting again.',
      )
    signal?.throwIfAborted()
    process.once('exit', release)
    return release
  } catch (error) {
    release()
    throw error
  }
}
