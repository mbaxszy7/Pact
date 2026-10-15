import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import { run } from './run-e2e.mjs'
import { isScriptEntry } from './script-entry.mjs'

const root = resolve(import.meta.dirname, '..')
const desktop = join(root, 'apps/desktop')
const execFileAsync = promisify(execFile)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const supported = new Set(['darwin-arm64', 'win32-x64', 'win32-arm64'])
const MAX_ENTRIES = 16_384
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

async function nativeMachineMatches(path, arch) {
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(64)
    if (
      (await handle.read(header, 0, 64, 0)).bytesRead !== 64 ||
      header.toString('ascii', 0, 2) !== 'MZ'
    )
      return false
    const offset = header.readUInt32LE(60)
    if (offset < 64 || offset > 1024 * 1024) return false
    const signature = Buffer.alloc(6)
    return (
      (await handle.read(signature, 0, 6, offset)).bytesRead === 6 &&
      signature.readUInt32LE(0) === 0x00004550 &&
      signature.readUInt16LE(4) === (arch === 'x64' ? 0x8664 : 0xaa64)
    )
  } finally {
    await handle.close()
  }
}

/** Check installed bytes without loading a native module or exposing dependency paths. */
export async function inspectWindowsSharpSource(packagePath, arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows Sharp architecture.')
  const facts = {
    sharpVersionMatches: false,
    targetDeclaredOptional: false,
    sharpEntryResolvable: false,
    targetExportResolvableFromSharp: false,
    targetNativeFilePresent: false,
    targetNativeMachineMatches: false,
    targetDllPayloadPresent: false,
  }
  const payload = []
  const target = `@img/sharp-win32-${arch}`
  const deadline = Date.now() + 5 * 60_000
  try {
    if ((await lstat(packagePath)).size > 64 * 1024) return { facts, payload }
    const metadata = JSON.parse(await readFile(packagePath, 'utf8'))
    const version = metadata.dependencies?.sharp
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)) return { facts, payload }
    facts.targetDeclaredOptional = metadata.optionalDependencies?.[target] === version
    const desktopRequire = createRequire(packagePath)
    const sharpEntry = desktopRequire.resolve('sharp')
    facts.sharpEntryResolvable = true
    // Sharp exports its dist entry, but intentionally does not export package.json.
    const sharpPackage = join(dirname(sharpEntry), '..', 'package.json')
    if ((await lstat(sharpPackage)).size > 64 * 1024) return { facts, payload }
    const sharpMetadata = JSON.parse(await readFile(sharpPackage, 'utf8'))
    facts.sharpVersionMatches = sharpMetadata.name === 'sharp' && sharpMetadata.version === version
    const targetEntry = createRequire(sharpEntry).resolve(`${target}/sharp.node`)
    facts.targetExportResolvableFromSharp = true
    const library = join(dirname(targetEntry), 'lib')
    const nativeName = `sharp-win32-${arch}-${version}.node`
    const names = await readdir(library)
    if (names.length > 64) return { facts, payload }
    const nativePath = join(library, nativeName)
    facts.targetNativeFilePresent = names.includes(nativeName) && (await lstat(nativePath)).isFile()
    if (!facts.targetNativeFilePresent) return { facts, payload }
    facts.targetNativeMachineMatches = await nativeMachineMatches(nativePath, arch)
    const selected = names.filter((name) => name === nativeName || name.endsWith('.dll')).toSorted()
    for (const name of selected) {
      if (Date.now() >= deadline) return { facts, payload: [] }
      const path = join(library, name)
      // oxlint-disable-next-line eslint/no-await-in-loop -- One bounded dependency file stream at a time.
      const info = await lstat(path)
      if (!info.isFile()) return { facts, payload: [] }
      payload.push({
        path: `resources/app.asar.unpacked/node_modules/${target}/lib/${name}`,
        bytes: info.size,
        // oxlint-disable-next-line eslint/no-await-in-loop -- Shares the source inspection deadline.
        sha256: await hashFile(path, { deadline }),
      })
    }
    facts.targetDllPayloadPresent = selected.some((name) => name.endsWith('.dll'))
  } catch {
    // Dependency absence and unreadable bytes fail closed using fixed public facts only.
  }
  return { facts, payload }
}

/** Match the final builder snapshot to the exact source native payload. */
export async function inspectPackagedWindowsSharp(appPath, content, arch, source) {
  const target = `@img/sharp-win32-${arch}`
  const prefix = `resources/app.asar.unpacked/node_modules/${target}/lib/`
  const selected = content.entries.filter(
    (entry) => entry.path.startsWith(prefix) && /\.(?:node|dll)$/u.test(entry.path),
  )
  const native = source.payload.find((entry) => entry.path.endsWith('.node'))
  const facts = {
    packagedTargetNativePresent: Boolean(
      native &&
      content.entries.some(
        (entry) => entry.type === 'file' && entry.path.endsWith(native.path.slice(prefix.length)),
      ),
    ),
    packagedTargetNativeUnpacked: Boolean(
      native && selected.some((entry) => entry.type === 'file' && entry.path === native.path),
    ),
    packagedTargetPayloadMatchesSource: false,
  }
  try {
    facts.packagedTargetPayloadMatchesSource = Boolean(
      Object.values(source.facts).every((value) => value === true) &&
      native &&
      source.payload.length >= 2 &&
      selected.length === source.payload.length &&
      source.payload.every((expected) =>
        selected.some(
          (entry) =>
            entry.type === 'file' &&
            entry.path === expected.path &&
            entry.bytes === expected.bytes &&
            entry.sha256 === expected.sha256,
        ),
      ) &&
      (await nativeMachineMatches(join(appPath, native.path), arch)),
    )
  } catch {
    // The build cannot succeed with missing or unreadable final native bytes.
  }
  return facts
}

function requireSharpInspection(stage, arch, facts) {
  console.log(JSON.stringify({ stage, target: `win32-${arch}`, ...facts }))
  if (!Object.values(facts).every((value) => value === true))
    throw new Error(
      `Windows Sharp ${stage} inspection failed; see the fixed dependency facts above.`,
    )
}

export async function hashFile(path, { signal, deadline = Date.now() + 5 * 60_000 } = {}) {
  if (Date.now() >= deadline)
    throw new Error('Application or artifact hashing exceeded its five-minute inspection deadline.')
  const controller = new AbortController()
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error('Application or artifact hashing exceeded its inspection deadline.'),
      ),
    deadline - Date.now(),
  )
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path, {
      highWaterMark: 64 * 1024,
      signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    }))
      hash.update(chunk)
    return hash.digest('hex')
  } finally {
    clearTimeout(timeout)
  }
}

/** Stream file bytes; retain bounded metadata, never the complete application in memory. */
export async function applicationContent(path, platform, { allowedExtraFiles = [] } = {}) {
  const entries = []
  const deadline = Date.now() + 5 * 60_000
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true })
    if (children.length > MAX_ENTRIES)
      throw new Error('Application content directory exceeds its entry bound.')
    for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = join(directory, child.name)
      if (Date.now() >= deadline)
        throw new Error('Application content inspection exceeded its five-minute deadline.')
      const entryPath = relative(path, file).split('\\').join('/')
      if (allowedExtraFiles.includes(entryPath)) continue
      if (entries.length >= MAX_ENTRIES)
        throw new Error('Application content exceeds its entry bound.')
      // oxlint-disable-next-line eslint/no-await-in-loop -- Inspect one entry at a time without an unbounded filesystem task fanout.
      const info = await lstat(file)
      const mode = platform === 'win32' ? 0 : info.mode & 0o777
      if (info.isDirectory()) {
        entries.push({ path: entryPath, type: 'directory', mode })
        // oxlint-disable-next-line eslint/no-await-in-loop -- Depth-first traversal owns only one active file stream.
        await walk(file)
      } else if (info.isSymbolicLink()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Symbolic-link metadata participates in the ordered snapshot.
        const target = await readlink(file)
        const destination = relative(path, resolve(dirname(file), target))
        if (isAbsolute(target) || destination.startsWith('..') || isAbsolute(destination)) {
          throw new Error('Application contains a symbolic link outside its contents.')
        }
        entries.push({ path: entryPath, type: 'symlink', mode, target })
      } else if (info.isFile()) {
        entries.push({
          path: entryPath,
          type: 'file',
          mode,
          bytes: info.size,
          // oxlint-disable-next-line eslint/no-await-in-loop -- Retain one 64 KiB stream instead of all application files.
          sha256: await hashFile(file, { deadline }),
        })
      } else throw new Error('Application contains an unsupported filesystem entry.')
    }
  }
  await walk(path)
  const bytes = Buffer.from(JSON.stringify(entries))
  if (bytes.length > MAX_MANIFEST_BYTES)
    throw new Error('Application content metadata exceeds its byte bound.')
  return {
    sha256: sha256(bytes),
    entries,
    bytes: entries.reduce((total, entry) => total + (entry.bytes ?? 0), 0),
  }
}

export function distributionArguments(args) {
  const options = {
    channel: 'dev',
    platform: process.platform,
    arch: process.arch,
    buildNumber: process.env.GITHUB_RUN_NUMBER ?? '0',
    directoryOnly: false,
  }
  const names = {
    '--channel': 'channel',
    '--platform': 'platform',
    '--arch': 'arch',
    '--sha': 'sourceSha',
    '--build-number': 'buildNumber',
    '--output': 'output',
  }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (seen.has(flag)) throw new Error(`Duplicate distribution argument: ${flag}`)
    seen.add(flag)
    if (flag === '--dir') {
      options.directoryOnly = true
      continue
    }
    const name = names[flag]
    if (!name || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error(`Invalid distribution argument: ${flag}`)
    options[name] = args[++index]
  }
  if (!['dev', 'stable'].includes(options.channel))
    throw new Error('Distribution channel must be dev or stable.')
  if (!supported.has(`${options.platform}-${options.arch}`))
    throw new Error('Distribution target must be darwin-arm64, win32-x64, or win32-arm64.')
  if (options.platform !== process.platform || options.arch !== process.arch)
    throw new Error(
      'Distribution and validation require the corresponding native OS and architecture runner.',
    )
  if (!/^\d{1,16}$/u.test(options.buildNumber))
    throw new Error('Build number must contain 1–16 decimal digits.')
  if (options.sourceSha !== undefined && !/^[a-f0-9]{40}$/u.test(options.sourceSha))
    throw new Error('Source SHA must be a full lowercase Git commit SHA.')
  return options
}

/** Explicit target names prevent inherited target arrays from adding another architecture. */
export function distributionBuilderArguments(options, builderCli, configPath) {
  if (!supported.has(`${options.platform}-${options.arch}`))
    throw new Error('Unsupported native distribution target')
  const targets = options.directoryOnly
    ? ['dir']
    : options.platform === 'darwin'
      ? ['dmg', 'zip']
      : ['nsis']
  return [
    builderCli,
    '--config',
    configPath,
    options.platform === 'darwin' ? '--mac' : '--win',
    ...targets,
    `--${options.arch}`,
    '--publish',
    'never',
    ...(options.directoryOnly ? ['--dir'] : []),
  ]
}

export async function main(args = process.argv.slice(2)) {
  const options = distributionArguments(args)
  const sourceSha = (
    await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      shell: false,
      timeout: 5000,
      maxBuffer: 64 * 1024,
    })
  ).stdout.trim()
  if (!/^[a-f0-9]{40}$/u.test(sourceSha) || (options.sourceSha && options.sourceSha !== sourceSha))
    throw new Error('Requested source SHA does not match the checked-out commit.')
  const sourceDirty = Boolean(
    (
      await execFileAsync('git', ['status', '--porcelain', '--untracked-files=normal'], {
        cwd: root,
        shell: false,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      })
    ).stdout,
  )
  const productVersion = JSON.parse(await readFile(join(root, 'version.json'), 'utf8')).version
  if (
    typeof productVersion !== 'string' ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(productVersion) ||
    productVersion === '0.0.0'
  )
    throw new Error('Product authority must define a nonzero stable SemVer.')
  const version =
    options.channel === 'stable'
      ? productVersion
      : `${productVersion}-dev.${options.buildNumber.replace(/^0+(?=\d)/u, '')}.sha${sourceSha.slice(0, 12)}`
  const productName = options.channel === 'dev' ? 'Pact Dev' : 'Pact'
  const appId = options.channel === 'dev' ? 'com.pact.desktop.dev' : 'com.pact.desktop'
  const identity = {
    smokeProtocolVersion: 2,
    channel: options.channel,
    platform: options.platform,
    arch: options.arch,
    version,
    productVersion,
    sourceSha,
    sourceDirty,
    buildNumber: options.buildNumber,
    productName,
    appId,
  }
  const output = resolve(
    options.output ??
      join(
        desktop,
        'release',
        `${options.channel}-${options.platform}-${options.arch}-${options.buildNumber}-${sourceSha.slice(0, 12)}`,
      ),
  )
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length)
    throw new Error(
      'Distribution output must be empty; preserve previous artifacts and select another directory.',
    )
  const packagePath = join(desktop, 'package.json')
  if ((await lstat(packagePath)).size > 64 * 1024)
    throw new Error('Desktop package metadata exceeds its byte bound.')
  const original = await readFile(packagePath)
  const metadata = JSON.parse(original.toString('utf8'))
  const packageManager = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ).packageManager
  if (typeof packageManager !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/u.test(packageManager))
    throw new Error('Distribution requires the exact workspace pnpm version.')
  if (metadata.version !== productVersion)
    throw new Error('Desktop package version differs from the product authority.')
  const windowsSharp =
    options.platform === 'win32'
      ? await inspectWindowsSharpSource(packagePath, options.arch)
      : undefined
  if (windowsSharp) requireSharpInspection('source', options.arch, windowsSharp.facts)
  const injected = Buffer.from(
    `${JSON.stringify({ ...metadata, version, packageManager, pactDistribution: identity }, null, 2)}\n`,
  )
  if (injected.length > 64 * 1024)
    throw new Error('Injected product metadata exceeds the runtime byte bound.')
  const lockPath = join(desktop, '.pact-distribution.lock')
  const temporary = await mkdtemp(join(tmpdir(), 'pact-distribution-'))
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  const recordPath = join(temporary, 'application.json')
  let metadataWritten = false
  let preserveRecovery = false
  let buildFailure
  const restoreMetadata = async () => {
    if (!metadataWritten) return
    try {
      if (sha256(await readFile(packagePath)) !== sha256(injected)) {
        throw new Error(
          'Desktop package changed during distribution; refusing to overwrite concurrent changes.',
        )
      }
      await writeFile(packagePath, original)
    } catch (error) {
      preserveRecovery = true
      throw new AggregateError(
        [...(buildFailure ? [buildFailure] : []), error],
        `Package recovery is required; original preserved at ${join(temporary, 'package.original.json')}.`,
        { cause: error },
      )
    }
  }
  try {
    await writeFile(join(temporary, 'package.original.json'), original, { mode: 0o600 })
    const configPath = join(temporary, 'electron-builder.cjs')
    const config = {
      extends: join(desktop, 'electron-builder.yml'),
      appId,
      productName,
      artifactName: `${productName.replaceAll(' ', '-')}-\${version}-\${os}-\${arch}.\${ext}`,
      directories: { output },
      mac: {
        target: options.directoryOnly
          ? ['dir']
          : [
              { target: 'dmg', arch: ['arm64'] },
              { target: 'zip', arch: ['arm64'] },
            ],
        identity: '-',
        notarize: false,
      },
      win: {
        executableName: productName,
        signExecutable: false,
        target: options.directoryOnly ? ['dir'] : [{ target: 'nsis', arch: [options.arch] }],
      },
      nsis: { shortcutName: productName, uninstallDisplayName: productName },
    }
    await writeFile(configPath, `module.exports = ${JSON.stringify(config)}\n`, { mode: 0o600 })
    const environment = {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      PACT_DISTRIBUTION_APPLICATION_RECORD: recordPath,
    }
    for (const name of Object.keys(environment))
      if (
        /^(?:CSC_|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$)/u.test(name) &&
        name !== 'CSC_IDENTITY_AUTO_DISCOVERY'
      )
        delete environment[name]
    const buildExit = await run(['--filter', '@pact/desktop', 'build'], 5 * 60_000, {
      cwd: root,
      env: environment,
    })
    if (buildExit !== 0) throw new Error(`Desktop build failed with exit code ${buildExit}.`)
    if (sha256(await readFile(packagePath)) !== sha256(original))
      throw new Error('Desktop package changed before distribution injection.')
    await writeFile(packagePath, injected)
    metadataWritten = true
    const builderCli = createRequire(packagePath).resolve('electron-builder/cli.js')
    const packageExit = await run(
      distributionBuilderArguments(options, builderCli, configPath),
      15 * 60_000,
      { executable: process.execPath, cwd: desktop, env: environment },
    )
    if (packageExit !== 0)
      throw new Error(`Electron packaging failed with exit code ${packageExit}.`)
    if ((await lstat(recordPath)).size > 16 * 1024)
      throw new Error('Builder application record exceeds its byte bound.')
    const application = JSON.parse(await readFile(recordPath, 'utf8'))
    if (application.platform !== options.platform || application.arch !== options.arch)
      throw new Error('Builder produced an unexpected application architecture.')
    const content = await applicationContent(application.appPath, options.platform)
    if (windowsSharp)
      requireSharpInspection(
        'packaged',
        options.arch,
        await inspectPackagedWindowsSharp(application.appPath, content, options.arch, windowsSharp),
      )
    const expectedKinds = options.directoryOnly
      ? []
      : options.platform === 'darwin'
        ? ['dmg', 'zip']
        : ['exe']
    const artifactPaths = (await readdir(output)).filter((path) =>
      expectedKinds.some((kind) => path.endsWith(`.${kind}`)),
    )
    const artifacts = await Promise.all(
      expectedKinds.map(async (kind) => {
        const matches = artifactPaths.filter((path) => path.endsWith(`.${kind}`))
        if (matches.length !== 1)
          throw new Error(`Expected exactly one ${kind} artifact for this distribution identity.`)
        const path = matches[0]
        return {
          path,
          kind: kind === 'exe' ? 'nsis' : kind,
          sha256: await hashFile(join(output, path)),
          bytes: (await lstat(join(output, path))).size,
        }
      }),
    )
    const manifest = {
      schemaVersion: 1,
      ...identity,
      application: {
        path: relative(output, application.appPath).split('\\').join('/'),
        bundleName: basename(application.appPath),
        executable: relative(application.appPath, application.executablePath).split('\\').join('/'),
        contentSha256: content.sha256,
        bytes: content.bytes,
        entries: content.entries,
      },
      artifacts,
      signing: { mac: 'ad-hoc', windows: 'none', notarized: false },
      verification: {
        packagedSmoke: 'pending',
        productionInstallation:
          'TODO: native installation, coexistence, upgrade and uninstall debugging remain required',
      },
    }
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`
    if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES)
      throw new Error('Distribution manifest exceeds its metadata bound.')
    await writeFile(join(output, 'distribution-manifest.json'), bytes, { flag: 'wx' })
    await writeFile(
      join(output, 'SHA256SUMS'),
      artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}\n`).join(''),
      { flag: 'wx' },
    )
    console.log(`Distribution manifest: ${join(output, 'distribution-manifest.json')}`)
    return manifest
  } catch (error) {
    buildFailure = error
    throw error
  } finally {
    try {
      await restoreMetadata()
    } finally {
      await lock.close()
      await rm(lockPath)
      if (!preserveRecovery) await rm(temporary, { recursive: true, force: true })
    }
  }
}

if (isScriptEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`Distribution failed: ${error.message}`)
    process.exitCode = 1
  })
}
