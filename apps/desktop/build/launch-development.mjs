import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, openSync, unlinkSync } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  lstat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import identities from '../app-identities.json' with { type: 'json' }

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const desktopDirectory = resolve(import.meta.dirname, '..')
const runtimeDirectory = resolve(desktopDirectory, '../../.pact-data/mac-development-runtime')
const identity = identities['development-local']
const command = process.argv[2]
if (command !== 'dev' && command !== 'preview') throw new Error('Expected dev or preview.')

/** One checkout-local runtime; the lock covers preparation and the Vite launch lifetime. */
async function prepareMacRuntime(signal) {
  const sourceExecutable = await realpath(require('electron'))
  const sourceBundle = resolve(dirname(sourceExecutable), '../..')
  const sourceInfo = await readFile(join(sourceBundle, 'Contents/Info.plist'))
  const icon = join(import.meta.dirname, 'icon.icns')
  const sourceIdentity = await stat(sourceExecutable)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([sourceExecutable, sourceIdentity.size, sourceIdentity.mtimeMs]))
    .update(JSON.stringify(identity))
    .update(sourceInfo)
    .update(await readFile(icon))
    .update(await readFile(import.meta.filename))
    .digest('hex')
  const bundle = join(runtimeDirectory, `${identity.name}.app`)
  const executable = join(bundle, 'Contents/MacOS/Electron')
  const receipt = join(runtimeDirectory, 'runtime.sha256')
  try {
    if (
      (await stat(receipt)).size <= 128 &&
      (await readFile(receipt, 'utf8')) === fingerprint &&
      (await stat(executable)).isFile()
    )
      return executable
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const staging = join(runtimeDirectory, 'preparing.app')
  let entries = 0
  let bytes = 0
  const preparation = new AbortController()
  const deadline = setTimeout(() => preparation.abort(), 45_000)
  const operationSignal = AbortSignal.any([signal, preparation.signal])
  try {
    // This directory contains generated build artifacts only. Never modify pnpm's Electron copy.
    await rm(staging, { recursive: true, force: true })
    await cp(sourceBundle, staging, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
      filter: async (source) => {
        operationSignal.throwIfAborted()
        entries += 1
        bytes += (await lstat(source)).size
        if (entries > 8192 || bytes > 1024 ** 3)
          throw new Error('The development Electron bundle exceeds its preparation bound.')
        return true
      },
    })
    const info = join(staging, 'Contents/Info.plist')
    for (const [key, value] of [
      ['CFBundleName', identity.name],
      ['CFBundleDisplayName', identity.name],
      ['CFBundleIdentifier', identity.appId],
    ]) {
      // All values come from the finite registry, and no command processor is involved.
      // oxlint-disable-next-line no-await-in-loop -- Three ordered edits to the same plist.
      await execute('/usr/bin/plutil', ['-replace', key, '-string', value, info], {
        signal: operationSignal,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
    }
    await copyFile(icon, join(staging, 'Contents/Resources/electron.icns'))
    await execute(
      '/usr/bin/codesign',
      [
        '--force',
        '--deep',
        '--sign',
        '-',
        '--preserve-metadata=entitlements,flags,runtime',
        staging,
      ],
      { signal: operationSignal, timeout: 30_000, maxBuffer: 64 * 1024 },
    )
    operationSignal.throwIfAborted()
    await rm(bundle, { recursive: true, force: true })
    await rename(staging, bundle)
    await writeFile(receipt, fingerprint)
    return executable
  } finally {
    clearTimeout(deadline)
    await rm(staging, { recursive: true, force: true })
  }
}

const cancellation = new AbortController()
let lock
const lockPath = join(runtimeDirectory, 'launch.lock')
const onSignal = (signal) => {
  cancellation.abort()
  process.exitCode = signal === 'SIGINT' ? 130 : 143
}
const interrupt = () => onSignal('SIGINT')
const terminate = () => onSignal('SIGTERM')
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
const release = () => {
  if (lock === undefined) return
  closeSync(lock)
  lock = undefined
  unlinkSync(lockPath)
}

try {
  if (process.platform === 'darwin') {
    await mkdir(runtimeDirectory, { recursive: true })
    try {
      lock = openSync(lockPath, 'wx', 0o600)
      process.once('exit', release)
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          'This checkout already has a development launch. Close it before starting again. If a previous launch was forcibly terminated, remove .pact-data/mac-development-runtime/launch.lock after confirming it has exited.',
          { cause: error },
        )
      throw error
    }
    process.env.ELECTRON_EXEC_PATH = await prepareMacRuntime(cancellation.signal)
  }
  cancellation.signal.throwIfAborted()
  const vite = join(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
  // Run the existing CLI in this process, preserving its hot reload, arguments and exit behavior.
  process.argv[1] = vite
  await import(pathToFileURL(vite).href)
} catch (error) {
  if (!cancellation.signal.aborted) console.error(error.message)
  process.exitCode ||= 1
  release()
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
}
