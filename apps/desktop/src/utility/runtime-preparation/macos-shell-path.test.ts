import { getEventListeners } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimePreparationRepository } from '@pact/persistence'

import { OwnedProcessGroup } from '../owned-process-group'
import { RuntimePreparation } from './runtime-preparation'

const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'
const directories: string[] = []
const preparations: RuntimePreparation[] = []

afterEach(async () => {
  try {
    await Promise.all(preparations.splice(0).map((preparation) => preparation.dispose?.()))
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
  } finally {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  }
})

async function fixture(startup?: string) {
  const home = await mkdtemp(join(tmpdir(), 'pact-shell-path-'))
  directories.push(home)
  const bin = join(home, 'bin')
  await mkdir(bin)
  await symlink(process.execPath, join(bin, 'node'))
  await Promise.all(
    (
      [
        ['claude', '2.1.272 (Claude Code)'],
        ['codex', 'codex-cli 0.159.2'],
      ] as const
    ).map(([agent, version]) =>
      // Both wrappers need env-node, like the actual npm Codex installation.
      writeFile(
        join(bin, agent),
        `#!/usr/bin/env node\nif(process.argv[2] === '--version')console.log(${JSON.stringify(version)});\n`,
        { mode: 0o700 },
      ),
    ),
  )
  await writeFile(join(home, '.zprofile'), '')
  await writeFile(
    join(home, '.zshrc'),
    startup ??
      `printf 'startup noise\\n'\npwd > '${home}/shell-cwd'\n` +
        `printf 'called\\n' >> '${home}/shell-called'\n` +
        `export PATH='${bin}':"$PATH"\nexport PACT_SHELL_SECRET='synthetic-shell-only'\n`,
  )
  vi.stubEnv('HOME', home)
  vi.stubEnv('PATH', systemPath)
  const repository: RuntimePreparationRepository = {
    readSelectedExecutablePath: () => undefined,
    hasCompletedFirstUseSetup: () => false,
    saveSelectedExecutablePath: vi.fn<RuntimePreparationRepository['saveSelectedExecutablePath']>(),
  }
  const preparation = new RuntimePreparation(repository, { discoverShellPath: true })
  preparations.push(preparation)
  return { home, bin, preparation, repository }
}

describe.skipIf(process.platform !== 'darwin')('macOS GUI runtime PATH', () => {
  it('discovers both CLIs and starts env-node wrappers from a system-only GUI PATH', async () => {
    const f = await fixture()
    vi.stubEnv('PACT_SHELL_SECRET', 'unchanged-parent-value')
    // A launch directory must not become a source of shell startup code.
    vi.stubEnv('ZDOTDIR', join(f.home, 'untrusted-project'))
    const before = f.preparation.catalogIdentity()
    const readiness = await f.preparation.inspectReadiness()
    expect(readiness).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'ready', executablePath: join(f.bin, 'claude') },
          { agentId: 'codex', state: 'ready', executablePath: join(f.bin, 'codex') },
        ],
      },
    })
    expect(process.env.PACT_SHELL_SECRET).toBe('unchanged-parent-value')
    expect((await readFile(join(f.home, 'shell-cwd'), 'utf8')).trim()).toBe(await realpath(f.home))
    expect(f.preparation.catalogIdentity()).not.toBe(before)
    expect(await f.preparation.findRecoveryExecutable('codex', new AbortController().signal)).toBe(
      join(f.bin, 'codex'),
    )
    // Readiness is rechecked, while the environment snapshot is resolved once per Utility.
    await f.preparation.inspectReadiness()
    expect((await readFile(join(f.home, 'shell-called'), 'utf8')).trim()).toBe('called')
  })

  it('shares one shell resolution without allowing an aborted waiter to cancel other callers', async () => {
    const f = await fixture()
    const canceled = new AbortController()
    const wait = f.preparation.prepareEnvironment(canceled.signal).catch((error: unknown) => error)
    const other = f.preparation.prepareEnvironment()
    canceled.abort(new Error('Canceled caller'))
    expect(await wait).toMatchObject({ message: 'Canceled caller' })
    await other
    expect(getEventListeners(canceled.signal, 'abort')).toHaveLength(0)
    expect((await readFile(join(f.home, 'shell-called'), 'utf8')).trim()).toBe('called')
  })

  it('preserves inherited PATH priority and a saved manual CLI choice', async () => {
    const f = await fixture()
    const inherited = join(f.home, 'inherited')
    await mkdir(inherited)
    const selected = join(inherited, 'codex')
    await writeFile(selected, '#!/bin/sh\necho "codex-cli 9.9.9"\n', { mode: 0o700 })
    vi.stubEnv('PATH', `${inherited}:${systemPath}`)
    vi.spyOn(f.repository, 'readSelectedExecutablePath').mockImplementation((agent) =>
      agent === 'codex' ? selected : undefined,
    )
    expect(await f.preparation.inspectReadiness()).toMatchObject({
      ok: true,
      value: { agents: [{ state: 'ready' }, { state: 'ready', executablePath: selected }] },
    })
    expect(process.env.PATH?.split(':')[0]).toBe(inherited)
  })

  it.each([
    ['missing PATH frame', 'exit 0\n'],
    ['nonzero shell exit', 'exit 9\n'],
    ['excessive output', 'repeat 70000 builtin printf x\n'],
    ['relative PATH', 'export PATH=.:/usr/bin:/bin\n'],
    ['too many PATH entries', 'export PATH="$(repeat 130 builtin printf /bin:)"/usr/bin\n'],
  ])('retains the inherited environment after %s without retrying', async (_label, startup) => {
    const f = await fixture(startup)
    await f.preparation.prepareEnvironment()
    expect(process.env.PATH).toBe(systemPath)
    await writeFile(join(f.home, '.zshrc'), `export PATH='${f.bin}':"$PATH"\n`)
    await f.preparation.prepareEnvironment()
    expect(process.env.PATH).toBe(systemPath)
  })

  it('reclaims shell-startup descendants when the execution deadline expires', async () => {
    const f = await fixture()
    await writeFile(
      join(f.home, '.zshrc'),
      `/bin/sleep 30 &\nprintf '%s' "$!" > '${f.home}/child-pid'\nwait\n`,
    )
    const started = Date.now()
    await f.preparation.prepareEnvironment()
    expect(Date.now() - started).toBeLessThan(3000)
    expect(process.env.PATH).toBe(systemPath)
    const pid = Number(await readFile(join(f.home, 'child-pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }))
  })

  it('blocks all CLI preparation if shell cleanup cannot be confirmed', async () => {
    const f = await fixture()
    const close = Reflect.get(OwnedProcessGroup.prototype, 'close')
    const cleanup = vi
      .spyOn(OwnedProcessGroup.prototype, 'close')
      .mockImplementation(async function (this: OwnedProcessGroup, deadline) {
        await close.call(this, deadline)
        throw new Error('Synthetic failure after genuine physical cleanup')
      })
    await expect(f.preparation.prepareEnvironment()).rejects.toThrow('Synthetic failure')
    expect(process.env.PATH).toBe(systemPath)
    expect(await f.preparation.inspectReadiness()).toMatchObject({ ok: false })
    expect(
      await f.preparation.selectExecutable({
        agentId: 'codex',
        executablePath: join(f.bin, 'codex'),
      }),
    ).toMatchObject({ ok: false })
    await expect(f.preparation.dispose()).rejects.toThrow('Synthetic failure')
    expect(cleanup).toHaveBeenCalledTimes(1)
    // The real group was released above; disposal intentionally retains the failed gate.
    preparations.splice(preparations.indexOf(f.preparation), 1)
  })

  it('bounds a hanging shell and joins disposal without publishing its partial PATH', async () => {
    const f = await fixture('export PATH=/partial-path\n/bin/sleep 30\n')
    const started = Date.now()
    const pending = f.preparation.prepareEnvironment().catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await f.preparation.dispose()
    expect(await pending).toMatchObject({ message: 'Runtime preparation is shutting down.' })
    expect(process.env.PATH).toBe(systemPath)
    expect(Date.now() - started).toBeLessThan(3000)
    await expect(f.preparation.prepareEnvironment()).rejects.toThrow('shutting down')
  })
})
