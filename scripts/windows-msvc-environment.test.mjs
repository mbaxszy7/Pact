import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, promisify } from 'node:util'

import { ciEnvironment } from './ci.mjs'
import { runWindowsCompiler } from './run-windows-compiler.mjs'
import { prepareWindowsMsvcEnvironment } from './windows-msvc-environment.mjs'

const execute = promisify(execFile)

await test('MSVC setup preserves an existing matching developer environment', async () => {
  const env = { VSCMD_ARG_TGT_ARCH: 'x64', INCLUDE: 'existing-include', LIB: 'existing-lib' }
  assert.equal(await prepareWindowsMsvcEnvironment('x64', { env }), env)
})

await test('MSVC setup refuses a different active architecture', async () => {
  await assert.rejects(
    prepareWindowsMsvcEnvironment('arm64', { env: { VSCMD_ARG_TGT_ARCH: 'x64' } }),
    /active MSVC target does not match/,
  )
  await assert.rejects(prepareWindowsMsvcEnvironment('ia32'), /Unsupported MSVC target/)
})

await test('MSVC setup honors cancellation and the original deadline before discovery', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(prepareWindowsMsvcEnvironment('x64', { signal: controller.signal }), {
    name: 'AbortError',
  })
  await assert.rejects(
    prepareWindowsMsvcEnvironment('x64', { deadlineAt: performance.now() - 1 }),
    /exceeded the build deadline/,
  )
})

await test(
  'ordinary Windows shell loads a private MSVC environment that compiles real C++',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-msvc-environment-'))
    const before = { ...process.env }
    const compilerKeys = new Set(['INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH'])
    const env = Object.fromEntries(
      Object.entries(before).filter(([key]) => !compilerKeys.has(key.toUpperCase())),
    )
    env.PACT_MSVC_UNRELATED_VALUE = 'retained-without-exporting'
    // Exercise Windows' case-insensitive PATH merge even in a preconfigured CI shell.
    const unicodePath = join(directory, '编译环境')
    env.Path = `${env.PATH ?? env.Path};${unicodePath}`
    delete env.PATH
    const original = { ...env }
    const deadlineAt = performance.now() + 60_000
    try {
      const loaded = await prepareWindowsMsvcEnvironment(process.arch, { env, deadlineAt })
      assert(isDeepStrictEqual(env, original), 'setup changed the caller environment')
      assert(isDeepStrictEqual({ ...process.env }, before), 'setup changed process.env')
      assert.equal(loaded.PACT_MSVC_UNRELATED_VALUE, env.PACT_MSVC_UNRELATED_VALUE)
      assert.equal(loaded.VSCMD_ARG_TGT_ARCH.toLowerCase(), process.arch)
      assert.deepEqual(
        Object.keys(loaded).filter((key) => key.toUpperCase() === 'PATH'),
        ['PATH'],
      )
      assert.equal(loaded.PACT_MSVC_TARGET_ARCH, undefined)
      assert(loaded.PATH.includes(unicodePath), 'setup corrupted a Unicode path')
      const source = join(directory, 'probe.cpp')
      const object = join(directory, 'probe.obj')
      await writeFile(
        source,
        '#include <windows.h>\nstatic_assert(sizeof(DWORD) == 4);\nint pact_msvc_probe() { return 42; }\n',
      )
      await runWindowsCompiler(['/nologo', '/c', '/WX', `/Fo${object}`, source], {
        cwd: directory,
        env: loaded,
        timeout: Math.floor(deadlineAt - performance.now()),
        maxBuffer: 64 * 1024,
      })
      const bytes = await readFile(object)
      assert.equal(bytes.readUInt16LE(0), process.arch === 'arm64' ? 0xaa64 : 0x8664)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

await test(
  'missing Visual Studio installation gives an actionable error and releases setup capacity',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-msvc-unavailable-'))
    const env = {
      ...process.env,
      'ProgramFiles(x86)': directory,
      VSCMD_ARG_TGT_ARCH: '',
      INCLUDE: '',
      LIB: '',
    }
    try {
      await assert.rejects(prepareWindowsMsvcEnvironment(process.arch, { env }), (error) => {
        assert.match(error.message, /Install Visual Studio Build Tools/)
        assert.equal(error.cause.physicalReleased, true)
        assert.equal(error.cause.preserveWorkspace, false)
        return true
      })
      // A failed setup must not leave the compiler owner's sole admission slot occupied.
      const loaded = await prepareWindowsMsvcEnvironment(process.arch)
      assert.equal(loaded.VSCMD_ARG_TGT_ARCH.toLowerCase(), process.arch)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)

await test(
  'helper CLI preserves the configured CI build and enables automatic setup only by explicit flag',
  { skip: process.platform !== 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pact-msvc-cli-'))
    const script = fileURLToPath(new URL('./build-owned-process-group-win32.mjs', import.meta.url))
    const options = {
      cwd: directory,
      shell: false,
      windowsHide: true,
      timeout: 70_000,
      maxBuffer: 64 * 1024,
    }
    try {
      const configured = ciEnvironment(await prepareWindowsMsvcEnvironment(process.arch))
      assert.equal(configured['ProgramFiles(x86)'], undefined)
      const ciOutput = join(directory, 'ci')
      const ciBuild = await execute(process.execPath, [script, '--output-directory', ciOutput], {
        ...options,
        env: configured,
      })
      assert.match(ciBuild.stdout, /Built Windows .* process ownership bridge/)

      // Missing CI setup must retain its original failure, without attempting local VS discovery.
      await assert.rejects(
        execute(process.execPath, [script, '--output-directory', join(directory, 'unconfigured')], {
          ...options,
          env: {
            ...configured,
            PATH: join(configured.SystemRoot ?? configured.SYSTEMROOT, 'System32'),
            INCLUDE: '',
            LIB: '',
            VSCMD_ARG_TGT_ARCH: '',
          },
        }),
        (error) => {
          assert.match(error.stderr, /Windows compiler failed \(preparation/)
          assert.doesNotMatch(error.stderr, /Could not load the MSVC environment/)
          return true
        },
      )

      const compilerKeys = new Set(['INCLUDE', 'LIB', 'LIBPATH', 'VSCMD_ARG_TGT_ARCH'])
      const ordinary = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !compilerKeys.has(key.toUpperCase())),
      )
      const localOutput = join(directory, 'local')
      const localBuild = await execute(
        process.execPath,
        [script, '--auto-msvc', '--output-directory', localOutput],
        { ...options, env: ordinary },
      )
      assert.match(localBuild.stdout, /Built Windows .* process ownership bridge/)
      const { inspectWindowsOwnedProcessResource, windowsOwnedProcessSourceHash } =
        await import('../apps/desktop/build/windows-owned-process-resource.mjs')
      const source = await windowsOwnedProcessSourceHash()
      const ciResource = await inspectWindowsOwnedProcessResource(ciOutput, process.arch, source, {
        runIdentity: true,
      })
      const localResource = await inspectWindowsOwnedProcessResource(
        localOutput,
        process.arch,
        source,
        {
          runIdentity: true,
        },
      )
      assert.equal(ciResource.sourceSha256, localResource.sourceSha256)
      assert.equal(ciResource.protocolVersion, localResource.protocolVersion)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
