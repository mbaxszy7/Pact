import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimePreparationRepository } from '@pact/persistence'

import { RuntimePreparation } from './runtime-preparation.js'

const temporaryDirectories: string[] = []

async function executable(
  agentId: 'claude' | 'codex',
  versionExit: number,
  authExit: number,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact-runtime-handler-'))
  temporaryDirectories.push(directory)
  const path = join(directory, agentId)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${agentId} 1.0.0'; exit ${versionExit}; fi\nif [ "$1" = "${authCommand}" ] && [ "$2" = "status" ]; then exit ${authExit}; fi\nexit 2\n`,
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
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pact runtime cmd '))
  temporaryDirectories.push(directory)
  const path = join(directory, `${agentId}.${extension}`)
  const authCommand = agentId === 'claude' ? 'auth' : 'login'
  await writeFile(
    path,
    `@echo off\r\nif "%~1"=="--version" (\r\n  echo ${agentId} 1.0.0\r\n  exit /b ${versionExit}\r\n)\r\nif "%~1"=="${authCommand}" if "%~2"=="status" exit /b ${authExit}\r\nexit /b 2\r\n`,
  )
  return path
}

function repository(
  paths: Partial<Record<'claude' | 'codex', string>>,
): RuntimePreparationRepository {
  return {
    hasCompletedFirstUseSetup: () => false,
    readSelectedExecutablePath: (agentId) => paths[agentId],
    saveSelectedExecutablePath:
      vi.fn<(agentId: 'claude' | 'codex', executablePath: string) => void>(),
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
          { agentId: 'claude', state: 'ready', version: 'claude 1.0.0' },
          { agentId: 'codex', state: 'ready', version: 'codex 1.0.0' },
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
            { agentId: 'claude', state: 'ready', version: 'claude 1.0.0' },
            { agentId: 'codex', state: 'ready', version: 'codex 1.0.0' },
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
