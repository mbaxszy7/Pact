import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimePreparationRepository } from '@pact/persistence'

import { RuntimePreparation } from './runtime-preparation.js'

const temporaryDirectories: string[] = []

async function executable(
  agentId: 'claude' | 'codex',
  versionExit: number,
  authExit: number,
  version = agentId === 'claude' ? '2.1.272 (Claude Code)' : 'codex-cli 0.159.2',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-handler-'))
  temporaryDirectories.push(directory)
  const path = join(directory, agentId)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit ${versionExit}; fi\nif [ "$1" = "${authCommand}" ] && [ "$2" = "status" ]; then echo checked > '${join(directory, 'auth-called')}'; exit ${authExit}; fi\nexit 2\n`,
    { mode: 0o755 },
  )
  await chmod(path, 0o755)
  return path
}

async function windowsExecutable(
  agentId: 'claude' | 'codex',
  versionExit = 0,
  authExit = 0,
  extension = 'cmd',
  version = agentId === 'claude' ? '2.1.272 (Claude Code)' : 'codex-cli 0.159.2',
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact runtime cmd '))
  temporaryDirectories.push(directory)
  const path = join(directory, `${agentId}.${extension}`)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `@echo off\r\nif "%~1"=="--version" (\r\n  echo ${version.replace(/[()]/gu, '^$&')}\r\n  exit /b ${versionExit}\r\n)\r\nif "%~1"=="${authCommand}" if "%~2"=="status" (\r\n  echo checked > "${join(directory, 'auth-called')}"\r\n  exit /b ${authExit}\r\n)\r\nexit /b 2\r\n`,
  )
  return path
}

function repository(
  paths: Partial<Record<'claude' | 'codex', string>>,
): RuntimePreparationRepository {
  return {
    hasCompletedFirstUseSetup: () => false,
    readSelectedExecutablePath: (agentId) => paths[agentId],
    saveSelectedExecutablePath: vi.fn<
      (agentId: 'claude' | 'codex', executablePath: string) => void
    >((agentId, executablePath) => {
      paths[agentId] = executablePath
    }),
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  )
})

describe.skipIf(process.platform === 'win32')('Runtime preparation utility', () => {
  it('reports both independently ready without sending a model prompt', async () => {
    const [claude, codex] = await Promise.all([
      executable('claude', 0, 0),
      executable('codex', 0, 0),
    ])

    const result = await new RuntimePreparation(repository({ claude, codex })).inspectReadiness()

    expect(result).toMatchObject({
      ok: true,
      value: {
        firstUse: true,
        agents: [
          { agentId: 'claude', state: 'ready', version: '2.1.272 (Claude Code)' },
          { agentId: 'codex', state: 'ready', version: 'codex-cli 0.159.2' },
        ],
      },
    })
  })

  it('separates authentication requirement and startup failure', async () => {
    const [claude, codex] = await Promise.all([
      executable('claude', 0, 1),
      executable('codex', 2, 0),
    ])
    const runtimePreparation = new RuntimePreparation(repository({ claude, codex }))
    expect(await runtimePreparation.inspectReadiness()).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'authentication_required' },
          { agentId: 'codex', state: 'startup_failed' },
        ],
      },
    })
  })
})

describe.runIf(process.platform === 'win32')('Windows Runtime Preparation', () => {
  it.each(['cmd', 'CMD'])(
    'starts .%s shims from a directory containing spaces',
    async (extension) => {
      const [claude, codex] = await Promise.all([
        windowsExecutable('claude', 0, 0, extension),
        windowsExecutable('codex', 0, 0, extension),
      ])

      expect(
        await new RuntimePreparation(repository({ claude, codex })).inspectReadiness(),
      ).toMatchObject({
        ok: true,
        value: {
          agents: [
            { agentId: 'claude', state: 'ready', version: '2.1.272 (Claude Code)' },
            { agentId: 'codex', state: 'ready', version: 'codex-cli 0.159.2' },
          ],
        },
      })
    },
  )

  it('retains distinct authentication and startup failures for Windows shims', async () => {
    const [claude, codex] = await Promise.all([
      windowsExecutable('claude', 0, 1),
      windowsExecutable('codex', 2, 0),
    ])

    expect(
      await new RuntimePreparation(repository({ claude, codex })).inspectReadiness(),
    ).toMatchObject({
      ok: true,
      value: {
        agents: [
          { agentId: 'claude', state: 'authentication_required' },
          { agentId: 'codex', state: 'startup_failed' },
        ],
      },
    })
  })
})

async function versionExecutable(agentId: 'claude' | 'codex', version: string): Promise<string> {
  return process.platform === 'win32'
    ? windowsExecutable(agentId, 0, 0, 'cmd', version)
    : executable(agentId, 0, 0, version)
}

describe('Runtime version compatibility through real CLI probes', () => {
  it.each([
    ['minimum releases', '2.1.272 (Claude Code)', 'codex-cli 0.159.2', 'ready'],
    ['older releases', '2.1.271 (Claude Code)', 'codex-cli 0.159.1', 'unsupported_version'],
    ['numeric ordering', '2.10.1 (Claude Code)', 'codex-cli 0.159.10', 'ready'],
    ['major upgrades', '3.0.0 (Claude Code)', 'codex-cli 1.0.0', 'ready'],
    ['older minor versions', '2.0.999 (Claude Code)', 'codex-cli 0.158.999', 'unsupported_version'],
    [
      'minimum prereleases',
      '2.1.272-rc.1 (Claude Code)',
      'codex-cli 0.159.2-alpha.1',
      'unsupported_version',
    ],
    ['newer prereleases', '2.1.273-rc.1 (Claude Code)', 'codex-cli 0.160.0-alpha.1', 'ready'],
    ['build metadata', '2.1.272+build.1 (Claude Code)', 'codex-cli 0.159.2+build.1', 'ready'],
    ['unrecognized output', 'unknown (Claude Code)', 'codex-cli unknown', 'cannot_verify'],
    ['partial version tokens', '2.1 (Claude Code)', 'codex-cli 0.159.2.1', 'cannot_verify'],
  ])('checks %s before authentication', async (_label, claudeVersion, codexVersion, state) => {
    const [claude, codex] = await Promise.all([
      versionExecutable('claude', claudeVersion),
      versionExecutable('codex', codexVersion),
    ])
    const result = await new RuntimePreparation(repository({ claude, codex })).inspectReadiness()
    expect(result).toMatchObject({
      ok: true,
      value: {
        firstUse: true,
        agents: [
          { agentId: 'claude', state, version: claudeVersion },
          { agentId: 'codex', state, version: codexVersion },
        ],
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    const authentication = await Promise.all(
      [claude, codex].map(async (path) => {
        try {
          return (await readFile(join(dirname(path), 'auth-called'), 'utf8')).trim()
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
          throw error
        }
      }),
    )
    expect(authentication).toEqual(state === 'ready' ? ['checked', 'checked'] : [null, null])
    expect(
      result.value.agents.map(
        (agent, index) => agent.detail?.includes(index === 0 ? '2.1.272' : '0.159.2') ?? false,
      ),
    ).toEqual([state !== 'ready', state !== 'ready'])
  })

  it('rechecks a manually selected installation and recovers after an in-place upgrade', async () => {
    const [claude, codex, olderCodex] = await Promise.all([
      versionExecutable('claude', '2.1.272 (Claude Code)'),
      versionExecutable('codex', 'codex-cli 0.159.2'),
      versionExecutable('codex', 'codex-cli 0.159.1'),
    ])
    const paths = repository({ claude, codex })
    const preparation = new RuntimePreparation(paths)
    expect(
      await preparation.selectExecutable({ agentId: 'codex', executablePath: olderCodex }),
    ).toMatchObject({
      ok: true,
      value: {
        agents: [{ state: 'ready' }, { state: 'unsupported_version', executablePath: olderCodex }],
      },
    })
    expect(paths.readSelectedExecutablePath('codex')).toBe(olderCodex)
    await writeFile(olderCodex, (await readFile(olderCodex, 'utf8')).replace('0.159.1', '0.159.2'))
    expect(await preparation.inspectReadiness()).toMatchObject({
      ok: true,
      value: { agents: [{ state: 'ready' }, { state: 'ready', executablePath: olderCodex }] },
    })
  })
})
