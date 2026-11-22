import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import identities from '../app-identities.json' with { type: 'json' }
import { prepareAgySqliteFileResource } from './agy-sqlite-file-resource.mjs'
import { acquireMacDevelopmentLaunchLock } from './mac-development-launch-lock.mjs'
import { prepareWindowsOwnedProcessResource } from './windows-owned-process-resource.mjs'

const require = createRequire(import.meta.url)
const execute = promisify(execFile)
const desktopDirectory = resolve(import.meta.dirname, '..')
const runtimeDirectory = resolve(desktopDirectory, '../../.pact-data/mac-development-runtime')
const identity = identities['development-local']
const electronPackage = require('electron/package.json')
const [electronMajor = '44', electronMinor = '3', electronPatch = '0'] =
  electronPackage.version.split('.')
const bundleVersion = `${electronMajor}.${Number(electronMinor) + 1}.${electronPatch}`
const lsregisterPath =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const command = process.argv[2]
if (command !== 'dev' && command !== 'preview') throw new Error('Expected dev or preview.')

function createMacDevelopmentDefaultApp(allowedDirectory) {
  return `import * as electron from 'electron/main'
import * as fs from 'node:fs'
import { Module } from 'node:module'
import * as path from 'node:path'
import * as url from 'node:url'

const exitOwnerless = () => {
  electron.app.dock?.hide()
  electron.app.exit(0)
}

const argv = process.argv.slice(1)
let target = null
let skipNext = false
for (const argument of argv) {
  if (skipNext) {
    skipNext = false
    continue
  }
  if (argument === '--require' || argument === '-r') {
    skipNext = true
    continue
  }
  if (argument.startsWith('--app=')) {
    target = argument.slice('--app='.length)
    break
  }
  if (argument.startsWith('-')) continue
  target = argument
  break
}

if (!target) {
  exitOwnerless()
} else {
  let allowedRoot
  let resolvedTarget
  try {
    allowedRoot = fs.realpathSync(${JSON.stringify(allowedDirectory)})
    resolvedTarget = fs.realpathSync(path.resolve(target))
  } catch {
    exitOwnerless()
  }
  if (
    !allowedRoot ||
    !resolvedTarget ||
    (resolvedTarget !== allowedRoot && !resolvedTarget.startsWith(\`\${allowedRoot}\${path.sep}\`))
  ) {
    exitOwnerless()
  } else {
    Object.defineProperty(process, 'defaultApp', {
      configurable: false,
      enumerable: true,
      value: true,
    })
    try {
      const metadataPath = path.join(allowedRoot, 'package.json')
      if (fs.existsSync(metadataPath) && fs.statSync(metadataPath).size <= 16 * 1024) {
        const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
        if (typeof metadata?.version === 'string') electron.app.setVersion(metadata.version)
        if (typeof metadata?.productName === 'string') electron.app.name = metadata.productName
        else if (typeof metadata?.name === 'string') electron.app.name = metadata.name
      }
      const entryFile = Module._resolveFilename(resolvedTarget, null, true)
      electron.app.setAppPath(
        resolvedTarget === allowedRoot ? allowedRoot : path.dirname(entryFile),
      )
      await import(url.pathToFileURL(entryFile).href)
    } catch {
      exitOwnerless()
    }
  }
}
`
}

function packFlatAsar(entries) {
  const files = {}
  const payloads = []
  let offset = 0
  for (const [name, source] of entries) {
    const content = Buffer.from(source, 'utf8')
    const hash = createHash('sha256').update(content).digest('hex')
    files[name] = {
      size: content.length,
      offset: String(offset),
      integrity: {
        algorithm: 'SHA256',
        hash,
        blockSize: 4 * 1024 * 1024,
        blocks: [hash],
      },
    }
    payloads.push(content)
    offset += content.length
  }
  const json = Buffer.from(JSON.stringify({ files }), 'utf8')
  const alignedLength = Math.ceil(json.length / 4) * 4
  const prefix = Buffer.alloc(16)
  prefix.writeUInt32LE(4, 0)
  prefix.writeUInt32LE(alignedLength + 8, 4)
  prefix.writeUInt32LE(alignedLength + 4, 8)
  prefix.writeUInt32LE(json.length, 12)
  return Buffer.concat([prefix, json, Buffer.alloc(alignedLength - json.length), ...payloads])
}

/** One checkout-local runtime; the lock covers preparation and the Vite launch lifetime. */
async function prepareMacRuntime(signal) {
  const sourceExecutable = await realpath(require('electron'))
  const sourceBundle = resolve(dirname(sourceExecutable), '../..')
  const sourceInfo = await readFile(join(sourceBundle, 'Contents/Info.plist'))
  const icon = join(import.meta.dirname, 'icon.icns')
  const sourceIdentity = await stat(sourceExecutable)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([sourceExecutable, sourceIdentity.size, sourceIdentity.mtimeMs]))
    .update(JSON.stringify([identity, desktopDirectory, bundleVersion]))
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
    await execute('/usr/bin/plutil', ['-remove', 'CFBundleNumericVersion', info], {
      signal: operationSignal,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    }).catch(() => undefined)
    for (const [key, value] of [
      ['CFBundleName', identity.name],
      ['CFBundleDisplayName', identity.name],
      ['CFBundleIdentifier', identity.appId],
      ['CFBundleShortVersionString', bundleVersion],
      ['CFBundleVersion', bundleVersion],
    ]) {
      // All values come from the finite registry, and no command processor is involved.
      // oxlint-disable-next-line no-await-in-loop -- Five ordered edits to the same plist.
      await execute('/usr/bin/plutil', ['-replace', key, '-string', value, info], {
        signal: operationSignal,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      })
    }
    await writeFile(
      join(staging, 'Contents/Resources/default_app.asar'),
      packFlatAsar([
        [
          'package.json',
          JSON.stringify({
            name: 'pact-development-default-app',
            private: true,
            type: 'module',
            main: 'main.js',
          }),
        ],
        ['main.js', createMacDevelopmentDefaultApp(desktopDirectory)],
      ]),
    )
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

/** Register this checkout's development bundle in LaunchServices and drop inactive duplicates. */
async function registerMacDevelopmentBundle(bundle, signal) {
  await execute(lsregisterPath, ['-f', bundle], {
    signal,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  try {
    const canonicalBundle = await realpath(bundle)
    const queryScript =
      'function run(argv) { ObjC.import("AppKit"); const urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsWithBundleIdentifier(argv[0]); const out = []; for (let i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path)); return JSON.stringify(out); }'
    const { stdout: registeredStdout } = await execute(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', queryScript, '--', identity.appId],
      { signal, timeout: 5_000, maxBuffer: 64 * 1024 },
    )
    const registered = JSON.parse(registeredStdout.trim() || '[]')
    if (!Array.isArray(registered)) return
    const { stdout: processStdout } = await execute('/bin/ps', ['-axo', 'comm='], {
      signal,
      timeout: 3_000,
      maxBuffer: 128 * 1024,
    })
    const commands = processStdout.split('\n').map((line) => line.trimStart())
    const resolved = await Promise.all(
      registered
        .filter((candidate) => typeof candidate === 'string')
        .slice(0, 16)
        .map(async (candidate) => ({
          candidate,
          canonical: await realpath(candidate).catch(() => candidate),
        })),
    )
    const stale = resolved
      .filter(
        ({ candidate, canonical }) =>
          candidate !== bundle &&
          canonical !== canonicalBundle &&
          !commands.some(
            (item) =>
              item.startsWith(`${candidate}${sep}`) || item.startsWith(`${canonical}${sep}`),
          ),
      )
      .map(({ candidate }) => candidate)
    await Promise.all(
      stale.map((candidate) =>
        execute(lsregisterPath, ['-u', candidate], {
          signal,
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        }).catch(() => undefined),
      ),
    )
  } catch {
    /* Non-fatal if LaunchServices scripting is unavailable. */
  }
}

const cancellation = new AbortController()
let release = () => {}
const onSignal = (signal) => {
  cancellation.abort()
  process.exitCode = signal === 'SIGINT' ? 130 : 143
}
const interrupt = () => onSignal('SIGINT')
const terminate = () => onSignal('SIGTERM')
process.on('SIGINT', interrupt)
process.on('SIGTERM', terminate)
try {
  if (process.platform === 'darwin') {
    const bundle = join(runtimeDirectory, `${identity.name}.app`)
    release = await acquireMacDevelopmentLaunchLock(runtimeDirectory, bundle, cancellation.signal)
    process.env.ELECTRON_EXEC_PATH = await prepareMacRuntime(cancellation.signal)
    await registerMacDevelopmentBundle(bundle, cancellation.signal)
  }
  if (process.platform === 'win32')
    await prepareWindowsOwnedProcessResource(process.arch, {
      signal: cancellation.signal,
      autoMsvc: true,
    })
  await prepareAgySqliteFileResource(process.arch, process.platform, {
    signal: cancellation.signal,
    autoMsvc: process.platform === 'win32',
  })
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
